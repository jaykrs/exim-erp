# EXIM ERP — Architecture & Consignment Tracking

Monolithic **Next.js (App Router) + Prisma + MySQL 8** ERP for Indian export-import (sea + air).
The **End-to-End EXIM Operational Checklist** (6 stages, 23 steps) is the consignment-tracking
workflow: every step maps to a concrete ERP data state in the schema, and progress is tracked per
vendor / purchase order / batch / shipment.

## 1. Directory layout

`✅` = exists in this repo · `▫` = planned (same conventions)

```
exim-erp/
├─ prisma/
│  ├─ schema.prisma                      ✅ 60 models · 67 enums
│  ├─ seed.ts                            ✅ dummy masters + 2 shipments (idempotent)
│  └─ migrations/                        ▫ commit `prisma migrate dev` output
├─ src/
│  ├─ app/                               # routing + thin HTTP/RSC glue ONLY
│  │  ├─ (dashboard)/                    ▫ pages, one folder per domain:
│  │  │   sourcing/ warehouse/ logistics/ compliance/ customs/ finance/ consignments/[id]/
│  │  └─ api/
│  │     └─ shipments/[id]/port-arrival/route.ts   ✅ zod-validated POST → service
│  ├─ modules/                           # domain layer — no Next.js imports
│  │  ├─ consignment/                    ✅ the checklist
│  │  │   workflow.ts                    ✅ 23-step registry (pure) + aggregateStatus
│  │  │   step-tracker.ts                ✅ recordStep() · getConsignmentTimeline()
│  │  ├─ finance/
│  │  │   landed-cost.calculator.ts      ✅ pure engine (duty cascade, allocation, recoverable IGST)
│  │  ├─ logistics/
│  │  │   services/port-arrival.service.ts   ✅ the multi-table transaction
│  │  │   queries/batch-position.ts          ✅ "where is batch X now?"
│  │  └─ sourcing/ warehouse/ compliance/ customs/   ▫ same shape: services/ queries/ schemas/ actions.ts components/
│  ├─ components/ui/                     ▫ design-system primitives
│  └─ lib/  prisma.ts money.ts errors.ts auth.ts   ✅
├─ tests/regression/                     ✅ service scenarios · schema contract · seed validation
├─ ARCHITECTURE.md · package.json · tsconfig.json · .env.example
```

**Layering rules:** `app → modules → lib`. Modules never import from `app`; one module reaches
another only through its exported service/query functions. Route handlers and server actions stay
thin (auth → validate → call a service → map `DomainError` to HTTP).

## 2. The checklist → schema

Each step's "ERP Data State" from the specification, and where it lives:

| # | Step (scope) | ERP data state → column / table | Service |
|---|---|---|---|
| 1 | Vendor compliance verification (vendor) | `Vendor.status = VERIFIED`; `VendorAudit` (Sedex/BSCI/ISO) | ▫ |
| 2 | Incoterm & PI execution (PO) | `PurchaseOrder.incoterm`, `status = AWAITING_PRODUCTION` | ▫ |
| 3 | Forex risk mitigation (PO) | `ForwardContract` + `FinanceLedgerEntry(FORWARD_CONTRACT_BOOKED, reference = token, fixedRate)` | ▫ |
| 4 | Trade finance activation (PO) | `LetterOfCredit.status = OPENED`, `documentUrl` (LC PDF); `BankGuarantee` | ▫ |
| 5 | Inward dock inspection (batch) | `Batch.status = RECEIVED_UNSORTED`; `InwardReceipt` → `Inspection` | ▫ |
| 6 | Sorting & grading (batch) | one transaction splits bulk weight into `BatchGrade` children; `ShipmentItem.batchGradeId` ships a specific grade | ▫ |
| 7 | Traceability tokens (batch) | `TraceTag` rows; `Batch.traceabilityCode = LOT-YYYY-XXXX` | ▫ |
| 8 | ISPM 15 packaging (batch) | `PackagingRecord.ispm15Certified`, `ispm15VerifiedBy/At` | ▫ |
| 9 | PSI & lab testing (batch) | `LabTest.reportUrl`; `Batch.complianceStatus = PASSED` | ▫ |
| 10 | Target-market label validation (batch) | `PackagingRecord.labelApproved`; `LabelValidation` | ▫ |
| 11 | Shipping bill filing (shipment) | `Shipment.shippingBillNo`, `status = CUSTOMS_EXPORT_PROCESSING`; `ShippingBill` | ▫ |
| 12 | Zero-rated / incentive logging (shipment) | `Invoice.lutId`; `FinanceLedgerEntry(EXPECTED_DRAWBACK / EXPECTED_RODTEP)`; `IncentiveClaim` | ▫ |
| 13 | Examination & LEO (shipment) | `Shipment.status = EXPORT_LEO_GRANTED`; `ShippingBill.leoNo` | ▫ |
| 14 | Port terminal handling & loading (shipment) | `Shipment.currentMilestone = PORT_YARD_STACKED / IN_TRANSIT_TARMAC`; `Container.dataLogger*`, `AirShipmentDetail.dataLogger*` | ◐ sets `IN_PROGRESS` |
| 15 | Departure confirmation (shipment) | `Shipment.status = IN_TRANSIT`, `transportDocCollectedAt` | ▫ |
| 16 | Pre-arrival manifest (shipment) | `Shipment.manifestFiled`; `ManifestFiling` (IGM/ISF) | ▫ |
| 17 | Bill of Entry submission (shipment) | `Shipment.status = CUSTOMS_IMPORT_HOLD`; `BillOfEntry` | ◐ hold status set on arrival |
| 18 | PGA clearances (shipment) | `Shipment.pgaClearance`; `RegulatoryClearance` + `ComplianceEvent` | ◐ triggers rules, sets `PENDING`, step `IN_PROGRESS` |
| 19 | Duty assessment & OOC (shipment) | `Shipment.status = CUSTOMS_RELEASED`; `BillOfEntry.oocNo/oocAt` | ▫ |
| 20 | Landed-cost consolidation (shipment) | `LandedCostSheet` (FINAL) + `Product.unitLandedCostInr` | ◐ provisional sheet on arrival; FINAL + product update ▫ |
| 21 | Last-mile transportation (shipment) | `currentMilestone = LAST_MILE_DELIVERY` | ▫ |
| 22 | Delivery proof & sign-off (shipment) | `Shipment.status = DELIVERED`, `Batch.currentOwner = IMPORT_PARTY` | ▫ |
| 23 | Financial reconciliation (shipment) | `Invoice.status = SETTLED`; LC funds + forward-contract differences in `FinanceLedgerEntry` | ▫ |

`ConsignmentStep` holds one row per (step, subject) with exactly one of `vendorId / purchaseOrderId /
batchId / shipmentId` set (strict FKs, no polymorphic ids — add the CHECK shown in the schema comment
to the first migration). `getConsignmentTimeline(shipmentId)` rolls batch/PO/vendor steps up across
everything inside the consignment (e.g. *Sorting & grading — IN_PROGRESS, 31/40 batches*).
Completing a step to `DONE` enforces same-scope prerequisites (409 otherwise); automated callers can
never regress a `DONE` step.

## 3. Real-time position ("where is this batch right now?")

* `ShipmentTrackingEvent` — append-only; `(batchId, occurredAt)`, `(shipmentId, occurredAt)`,
  `(containerId, occurredAt)`, `(milestone, occurredAt)` indexes. Milestones include
  `IN_TRANSIT_TARMAC`, `PORT_STOCKED_REEFER`, `DISCHARGED_SEA_YARD`, `PORT_YARD_STACKED`, `COLD_CHAIN_GATE_IN`, …
* `Batch` and `Shipment` carry `currentMilestone / currentMilestoneAt / currentLocationText`, updated
  **in the same transaction** that appends the event → O(1) "now" reads, full history from the log.
* `getBatchPosition(batchNo)` returns both.

## 4. Data-integrity conventions

* Money `Decimal(18,2)`, unit prices/costs `Decimal(18,4)`, FX `Decimal(18,6)`, rates `Decimal(7,4)`; all math via `lib/money.ts` (no JS floats).
* Currency columns `CHAR(3)` → FK `Currency.code`.
* Append-only: `ShipmentTrackingEvent`, `ShipmentStatusHistory`, `ComplianceEvent`, `IcegateMessage`, `FinanceLedgerEntry`, `AuditLog`. Landed-cost sheets are versioned and `SUPERSEDED`, never edited.
* `Shipment.version` optimistic lock: `updateMany({ where: { id, version, status } })`, 0 rows → 409.
* Multi-table operations run in one interactive transaction (`ReadCommitted`, retry on `P2034`).

## 5. Port-arrival operation (implemented)

`POST /api/shipments/:id/port-arrival` → `processPortArrival()`, atomically:
optimistic status change → container/yard/cold-chain gate-in → landed-cost sheet (itemised,
versioned, FX-resolved, recoverable IGST separated) → HS-prefix regulatory rules open a
`RegulatoryClearance` per board (FSSAI / BIS / CDSCO / quarantine …) with a `ComplianceEvent` →
`CustomsHold` → tracking events (shipment + each batch) and refreshed batch positions →
`pgaClearance` roll-up and checklist step → `ShipmentStatusHistory` + `AuditLog`.

Hold status follows the checklist: **exports → `CUSTOMS_HOLD`**, **imports → `CUSTOMS_IMPORT_HOLD`**.
Idempotent: replaying for a shipment already on hold returns the stored result and writes nothing.

## 6. Verification status — read before relying on this

| Check | Result |
|---|---|
| `schema.prisma` validates with Prisma's schema validator | ✅ 60 models, 67 enums |
| Landed-cost calculator unit tests (duty cascade, allocation, demurrage) | ✅ 7/7, values hand-checked |
| Workflow-registry tests (23 steps, acyclic, scopes) | ✅ 6/6 |
| `port-arrival.service` run against a **recording fake** Prisma client | ✅ export, import, idempotency, guards, optimistic lock |
| Regression suite (`npm test`): 13 unit + 7 service scenarios + 15 contract/seed tests | ✅ 35 checks pass |
| `prisma/seed.ts` validated against the schema (fields, enums, FKs, uniques, idempotent re-run) via a fake client | ✅ |
| `next build` | ⚠️ compiles, then stops at type-check: 39 errors, all from the missing generated Prisma client |
| `npm run build` here | ❌ `prisma generate` blocked (403 from binaries.prisma.sh) |
| `tsc` on `lib/`, calculator, workflow | ✅ clean |
| `tsc` on service / route / step-tracker / batch-position | ⚠️ **not verifiable here** — needs the generated client |
| Real MySQL run, migrations, SQL behaviour | ❌ not run |

Run once on your machine: `npm i && npx prisma generate && npm run typecheck && npm test`, then
`npx prisma migrate dev && npm run db:seed` (dummy data: 2 shipments — export `SHP-EXP-0001`, import `SHP-IMP-0001` — ready for the port-arrival endpoint).
The fake-client test checks orchestration logic, not SQL — add an integration test against a real
MySQL (testcontainers) before shipping.

## 7. Assumptions & next steps

* **Prisma is pinned to 6.x** (`url` inside `datasource`). Prisma 7+ moves the URL to `prisma.config.ts` and requires a driver adapter (`@prisma/adapter-mariadb` for MySQL).
* Customs valuation add-ons (`landing 1%`, `default insurance 1.125%`) live in `VALUATION_POLICY` in the arrival service — confirm with your CHA / current CBIC notifications; non-India jurisdictions default to plain CIF (US values on FOB, so add a policy before shipping there).
* `auth.ts` fails closed (401) outside development until wired to your session layer.
* Next services, in checklist order: vendor verification · grading split (one Prisma transaction → `BatchGrade`) · token generation · shipping-bill/LEO · OOC release + **landed-cost finalisation** (writes `Product.unitLandedCostInr`) · POD sign-off + ownership transfer · settlement. Add a seed (currencies, HS codes + duty rates, `HsRegulatoryRule` rows) so the arrival endpoint can be exercised end to end.

---

## Full build: checklist → service → endpoint

All 23 checklist steps now have a service, an RBAC-guarded endpoint and a dashboard view.

| Steps | Domain | Service module | Endpoints (POST unless noted) |
|---|---|---|---|
| 1–4 | Sourcing | `src/modules/sourcing/services.ts` | `vendors/:id/verify`, `purchase-orders/:id/{execute-pi,forward-contract,trade-finance}` |
| 5–7 | Warehouse | `src/modules/warehouse/services.ts` | `inward-receipts`, `batches/:id/{grade,trace-tags}` |
| 8–10, 18 | Compliance | `src/modules/compliance/services.ts` | `batches/:id/{ispm15,lab-tests,label-validation}`, `shipments/:id/clearances/:board` |
| 11–17, 19 | Customs | `src/modules/customs/services.ts` | `shipments/:id/{shipping-bill,incentives,leo,loading,departure,manifest,bill-of-entry,ooc}` |
| 20, 23 | Finance | `src/modules/finance/services.ts` | `shipments/:id/{charges,recost,landed-cost/finalize,reconcile}` |
| 21–22 | Logistics | `src/modules/logistics/services/delivery.service.ts` | `shipments/:id/{last-mile,delivery}` |
| 15 (arrival) | Logistics | `port-arrival.service.ts` | `shipments/:id/port-arrival` |
| read | — | `consignment/step-tracker.ts` | `GET shipments/:id/timeline`, `GET batch-positions/:batchNo` |

Every action runs in one interactive transaction (`runTx`), records its checklist step, appends tracking events and an audit row, and is idempotent where the natural key allows (same SB no., LEO no., GRN, etc.).

## Authentication and roles

- `POST /api/auth/login` verifies a scrypt hash and sets an HttpOnly HMAC-signed cookie (`exim_session`, 8 h). `AUTH_SECRET` (≥ 32 chars) is required.
- `src/middleware.ts` redirects page requests without a valid cookie to `/login`; **API routes authenticate themselves** via `requireActor(req, permission)` (401 / 403).
- Permission matrix lives in `src/lib/rbac.ts` (`read`, `sourcing:write`, `trade-finance:write`, `warehouse:write`, `compliance:write`, `logistics:write`, `customs:write`, `finance:write`).
- Dev-only `x-user-id`/`x-user-role` headers work only when `NODE_ENV=development`.
- Seed creates 7 demo users (`admin@`, `sourcing@`, `warehouse@`, `logistics@`, `finance@`, `compliance@`, `viewer@demo-exim.test`) with the password in `SEED_PASSWORD`. **Change it outside development.**

## Dashboards

Read-only server components (`src/app/(dashboard)`): Overview, Shipments, Shipment detail (checklist timeline, tracking events, holds, clearances, landed cost), Sourcing, Warehouse, Compliance, Customs, Finance. Writes go through the API.

## Verification status (this workspace)

| Check | Result |
|---|---|
| `npm test` | 13 unit + 7 arrival scenarios + 23 regression tests pass |
| Export lifecycle (18 steps, 16–20 skipped), import lifecycle | pass on the schema-aware in-memory DB |
| Route 401/403/422/404, login, tampered/expired cookie, password hashing, RBAC | pass |
| `npm run build` / full `tsc` | **not completed here**: `prisma generate` cannot download its engine (403). Without the generated client `tsc` reports implicit-`any` errors in every file that touches Prisma results; those are expected to clear after `npx prisma generate`. |
| Real MySQL | **not run.** The in-memory DB models Prisma semantics (defaults, unique, FK, VARCHAR/DECIMAL limits, rollback) but not MySQL locking or SQL behaviour. |

First steps on your machine: `npm i && npx prisma generate && npx prisma migrate dev && npx prisma db seed && npm run build && npm test`. Fix any type errors that appear once the client exists.
