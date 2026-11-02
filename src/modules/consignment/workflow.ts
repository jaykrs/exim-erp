/**
 * End-to-End EXIM Operational Checklist, as typed data.
 *
 * This registry is the SINGLE SOURCE OF TRUTH for the consignment-tracking workflow: 6 stages,
 * 23 steps. Each step declares who it is tracked against (scope), the ERP data state that marks it
 * done (taken from the functional specification), and its same-scope prerequisites.
 *
 * Scopes (a step is tracked once per subject):
 *   VENDOR          one row per supplier
 *   PURCHASE_ORDER  one row per PO
 *   BATCH           one row per lot (goods traceability)
 *   SHIPMENT        one row per consignment
 * A consignment's timeline rolls batch/PO/vendor steps up across everything inside the shipment.
 *
 * Pure module (no DB) so it can be unit-tested and shared with the UI.
 */

export type WorkflowStage =
  | 'SOURCING'
  | 'WAREHOUSE'
  | 'PACKAGING_COMPLIANCE'
  | 'EXPORT_CUSTOMS'
  | 'IMPORT_CUSTOMS'
  | 'LAST_MILE';

export type StepScope = 'VENDOR' | 'PURCHASE_ORDER' | 'BATCH' | 'SHIPMENT';

export type StepStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | 'SKIPPED';

export type WorkflowStepCode =
  | 'VENDOR_COMPLIANCE_VERIFICATION'
  | 'INCOTERM_PI_EXECUTION'
  | 'FOREX_RISK_MITIGATION'
  | 'TRADE_FINANCE_ACTIVATION'
  | 'INWARD_DOCK_INSPECTION'
  | 'SORTING_QUALITY_GRADING'
  | 'TRACEABILITY_TOKEN_GENERATION'
  | 'ISPM15_PACKAGING'
  | 'PSI_LAB_TESTING'
  | 'TARGET_MARKET_LABEL_VALIDATION'
  | 'SHIPPING_BILL_FILING'
  | 'ZERO_RATED_INCENTIVE_LOGGING'
  | 'CUSTOMS_EXAMINATION_LEO'
  | 'PORT_TERMINAL_HANDLING_LOADING'
  | 'DEPARTURE_CONFIRMATION'
  | 'PRE_ARRIVAL_MANIFEST_FILING'
  | 'BILL_OF_ENTRY_SUBMISSION'
  | 'PGA_CLEARANCES'
  | 'DUTY_ASSESSMENT_OOC'
  | 'LANDED_COST_CONSOLIDATION'
  | 'LAST_MILE_TRANSPORTATION'
  | 'DELIVERY_PROOF_QUALITY_SIGNOFF'
  | 'FINANCIAL_RECONCILIATION';

export interface StageDef {
  stage: WorkflowStage;
  title: string;
  objective: string;
}

export interface StepDef {
  code: WorkflowStepCode;
  stage: WorkflowStage;
  scope: StepScope;
  title: string;
  /** The ERP data state that marks this step complete (per the functional specification). */
  erpDataState: string;
  /** Same-scope steps that must be DONE (or SKIPPED) before this one may be marked DONE. */
  dependsOn: WorkflowStepCode[];
}

/** Column on ConsignmentStep that holds the subject for each scope. */
export const SCOPE_KEY = {
  VENDOR: 'vendorId',
  PURCHASE_ORDER: 'purchaseOrderId',
  BATCH: 'batchId',
  SHIPMENT: 'shipmentId',
} as const satisfies Record<StepScope, string>;

export const STAGES: readonly StageDef[] = [
  {
    stage: 'SOURCING',
    title: 'Stage 1: Sourcing & Vendor Onboarding',
    objective: 'Qualify suppliers, secure inventory under the correct legal frameworks, and insulate the business from FX volatility.',
  },
  {
    stage: 'WAREHOUSE',
    title: 'Stage 2: Warehouse Processing (Sorting & Grading)',
    objective: 'Track ingestion of bulk material, assign value tiers, and guarantee downstream batch traceability.',
  },
  {
    stage: 'PACKAGING_COMPLIANCE',
    title: 'Stage 3: Packaging & Compliance Testing',
    objective: 'Protect cargo in transit while satisfying the import mandates of the target market.',
  },
  {
    stage: 'EXPORT_CUSTOMS',
    title: 'Stage 4: Export Customs & Origin Port Operations (India)',
    objective: 'Clear Indian customs via ICEGATE and secure vessel / flight space.',
  },
  {
    stage: 'IMPORT_CUSTOMS',
    title: 'Stage 5: Destination Port & Import Customs Operations',
    objective: 'Avoid demurrage by coordinating health-board and customs clearance immediately.',
  },
  {
    stage: 'LAST_MILE',
    title: 'Stage 6: Last-Mile Delivery & Import Party Handoff',
    objective: 'Transfer title to the buyer and reconcile the financial loop.',
  },
];

export const STEPS: readonly StepDef[] = [
  // ── Stage 1 ────────────────────────────────────────────────────────────────
  {
    code: 'VENDOR_COMPLIANCE_VERIFICATION',
    stage: 'SOURCING',
    scope: 'VENDOR',
    title: 'Vendor Compliance Verification',
    erpDataState: 'Vendor.status = VERIFIED (registrations, tax IDs, Sedex/BSCI/ISO certificates collected)',
    dependsOn: [],
  },
  {
    code: 'INCOTERM_PI_EXECUTION',
    stage: 'SOURCING',
    scope: 'PURCHASE_ORDER',
    title: 'Incoterm & Proforma Invoice (PI) Execution',
    erpDataState: 'PurchaseOrder.incoterm = FOB | EXW | FCA; PurchaseOrder.status = AWAITING_PRODUCTION',
    dependsOn: [],
  },
  {
    code: 'FOREX_RISK_MITIGATION',
    stage: 'SOURCING',
    scope: 'PURCHASE_ORDER',
    title: 'Forex Risk Mitigation',
    erpDataState: 'Forward-contract token + fixed rate logged to FinanceLedgerEntry (FORWARD_CONTRACT_BOOKED)',
    dependsOn: ['INCOTERM_PI_EXECUTION'],
  },
  {
    code: 'TRADE_FINANCE_ACTIVATION',
    stage: 'SOURCING',
    scope: 'PURCHASE_ORDER',
    title: 'Trade Finance Activation',
    erpDataState: 'LC PDF attached; LetterOfCredit.status = OPENED (or BankGuarantee issued)',
    dependsOn: ['INCOTERM_PI_EXECUTION'],
  },
  // ── Stage 2 ────────────────────────────────────────────────────────────────
  {
    code: 'INWARD_DOCK_INSPECTION',
    stage: 'WAREHOUSE',
    scope: 'BATCH',
    title: 'Inward Dock Inspection',
    erpDataState: 'Batch.status = RECEIVED_UNSORTED (case counts verified against supplier packing list)',
    dependsOn: [],
  },
  {
    code: 'SORTING_QUALITY_GRADING',
    stage: 'WAREHOUSE',
    scope: 'BATCH',
    title: 'Sorting & Quality Grading Tiers',
    erpDataState: 'Bulk weight split into BatchGrade child lots in ONE transaction',
    dependsOn: ['INWARD_DOCK_INSPECTION'],
  },
  {
    code: 'TRACEABILITY_TOKEN_GENERATION',
    stage: 'WAREHOUSE',
    scope: 'BATCH',
    title: 'Traceability Token Generation',
    erpDataState: 'TraceTag hashes generated; Batch.traceabilityCode = LOT-YYYY-XXXX',
    dependsOn: ['SORTING_QUALITY_GRADING'],
  },
  // ── Stage 3 ────────────────────────────────────────────────────────────────
  {
    code: 'ISPM15_PACKAGING',
    stage: 'PACKAGING_COMPLIANCE',
    scope: 'BATCH',
    title: 'ISPM 15 Phytosanitary Packaging',
    erpDataState: 'PackagingRecord.ispm15Certified = true, verified by warehouse manager',
    dependsOn: ['TRACEABILITY_TOKEN_GENERATION'],
  },
  {
    code: 'PSI_LAB_TESTING',
    stage: 'PACKAGING_COMPLIANCE',
    scope: 'BATCH',
    title: 'Pre-Shipment Inspection (PSI) & Lab Testing',
    erpDataState: 'Lab report uploaded; Batch.complianceStatus = PASSED',
    dependsOn: ['TRACEABILITY_TOKEN_GENERATION'],
  },
  {
    code: 'TARGET_MARKET_LABEL_VALIDATION',
    stage: 'PACKAGING_COMPLIANCE',
    scope: 'BATCH',
    title: 'Target Market Label Validation',
    erpDataState: 'PackagingRecord.labelApproved = true',
    dependsOn: ['TRACEABILITY_TOKEN_GENERATION'],
  },
  // ── Stage 4 ────────────────────────────────────────────────────────────────
  {
    code: 'SHIPPING_BILL_FILING',
    stage: 'EXPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Shipping Bill Electronic Filing',
    erpDataState: 'Shipment.shippingBillNo = SB-XXXXXXXX; Shipment.status = CUSTOMS_EXPORT_PROCESSING',
    dependsOn: [],
  },
  {
    code: 'ZERO_RATED_INCENTIVE_LOGGING',
    stage: 'EXPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Zero-Rated Tax / Incentive Claim Logging',
    erpDataState: 'LUT attached; expected RoDTEP / Duty Drawback tracked in FinanceLedgerEntry',
    dependsOn: ['SHIPPING_BILL_FILING'],
  },
  {
    code: 'CUSTOMS_EXAMINATION_LEO',
    stage: 'EXPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Customs Examination & Let Export Order (LEO)',
    erpDataState: 'Shipment.status = EXPORT_LEO_GRANTED',
    dependsOn: ['SHIPPING_BILL_FILING'],
  },
  {
    code: 'PORT_TERMINAL_HANDLING_LOADING',
    stage: 'EXPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Port Terminal Handling & Loading',
    erpDataState: 'Shipment.currentMilestone = PORT_YARD_STACKED (sea) | IN_TRANSIT_TARMAC (air); data-loggers activated',
    dependsOn: ['CUSTOMS_EXAMINATION_LEO'],
  },
  {
    code: 'DEPARTURE_CONFIRMATION',
    stage: 'EXPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Vessel / Flight Departure Confirmation',
    erpDataState: 'Shipment.status = IN_TRANSIT; BL / AWB collected',
    dependsOn: ['PORT_TERMINAL_HANDLING_LOADING'],
  },
  // ── Stage 5 ────────────────────────────────────────────────────────────────
  {
    code: 'PRE_ARRIVAL_MANIFEST_FILING',
    stage: 'IMPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Pre-Arrival Manifest Filing',
    erpDataState: 'Shipment.manifestFiled = true (IGM / ISF transmitted by carrier)',
    dependsOn: ['DEPARTURE_CONFIRMATION'],
  },
  {
    code: 'BILL_OF_ENTRY_SUBMISSION',
    stage: 'IMPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Bill of Entry Submission',
    erpDataState: 'Shipment.status = CUSTOMS_IMPORT_HOLD',
    dependsOn: ['PRE_ARRIVAL_MANIFEST_FILING'],
  },
  {
    code: 'PGA_CLEARANCES',
    stage: 'IMPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Partner Government Agency (PGA) Clearances',
    erpDataState: 'Shipment.pgaClearance = APPROVED (all RegulatoryClearance rows APPROVED / NOT_REQUIRED)',
    dependsOn: ['BILL_OF_ENTRY_SUBMISSION'],
  },
  {
    code: 'DUTY_ASSESSMENT_OOC',
    stage: 'IMPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Duty Assessment & Out of Charge (OOC)',
    erpDataState: 'Shipment.status = CUSTOMS_RELEASED',
    dependsOn: ['PGA_CLEARANCES'],
  },
  {
    code: 'LANDED_COST_CONSOLIDATION',
    stage: 'IMPORT_CUSTOMS',
    scope: 'SHIPMENT',
    title: 'Landed Cost Consolidation',
    erpDataState: 'LandedCostSheet FINAL; Product.unitLandedCostInr refreshed',
    dependsOn: ['DUTY_ASSESSMENT_OOC'],
  },
  // ── Stage 6 ────────────────────────────────────────────────────────────────
  {
    code: 'LAST_MILE_TRANSPORTATION',
    stage: 'LAST_MILE',
    scope: 'SHIPMENT',
    title: 'Last-Mile Transportation',
    erpDataState: 'Shipment.currentMilestone = LAST_MILE_DELIVERY',
    dependsOn: ['DUTY_ASSESSMENT_OOC'],
  },
  {
    code: 'DELIVERY_PROOF_QUALITY_SIGNOFF',
    stage: 'LAST_MILE',
    scope: 'SHIPMENT',
    title: 'Delivery Proof & Quality Sign-off',
    erpDataState: 'Shipment.status = DELIVERED; Batch.currentOwner = IMPORT_PARTY',
    dependsOn: ['LAST_MILE_TRANSPORTATION'],
  },
  {
    code: 'FINANCIAL_RECONCILIATION',
    stage: 'LAST_MILE',
    scope: 'SHIPMENT',
    title: 'Financial Reconciliation',
    erpDataState: 'Invoice.status = SETTLED; LC funds released; forward-contract differences closed',
    dependsOn: ['DELIVERY_PROOF_QUALITY_SIGNOFF'],
  },
];

export const STEPS_BY_CODE: Readonly<Record<WorkflowStepCode, StepDef>> = Object.fromEntries(
  STEPS.map((s) => [s.code, s]),
) as Record<WorkflowStepCode, StepDef>;

export const stepsInStage = (stage: WorkflowStage): StepDef[] => STEPS.filter((s) => s.stage === stage);
export const stepsForScope = (scope: StepScope): StepDef[] => STEPS.filter((s) => s.scope === scope);

/**
 * Roll the per-subject statuses of one step up into a single status
 * (e.g. 40 batches in a consignment → "IN_PROGRESS, 31/40").
 * SKIPPED subjects are ignored; no applicable subjects → PENDING.
 */
export function aggregateStatus(statuses: StepStatus[]): StepStatus {
  if (statuses.length === 0) return 'PENDING';
  const live = statuses.filter((s) => s !== 'SKIPPED');
  if (live.length === 0) return 'SKIPPED';
  if (live.every((s) => s === 'DONE')) return 'DONE';
  if (live.some((s) => s === 'BLOCKED')) return 'BLOCKED';
  if (live.some((s) => s === 'IN_PROGRESS' || s === 'DONE')) return 'IN_PROGRESS';
  return 'PENDING';
}

/** Prerequisites of `code` that are not yet DONE/SKIPPED, given the subject's current step statuses. */
export function unmetPrerequisites(
  code: WorkflowStepCode,
  statuses: Partial<Record<WorkflowStepCode, StepStatus>>,
): WorkflowStepCode[] {
  return STEPS_BY_CODE[code].dependsOn.filter((p) => {
    const s = statuses[p];
    return s !== 'DONE' && s !== 'SKIPPED';
  });
}

/** Structural self-check, used by the unit test and safe to run at boot. Returns a list of problems. */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of STEPS) {
    if (seen.has(s.code)) problems.push(`duplicate step code ${s.code}`);
    seen.add(s.code);
    if (!s.erpDataState.trim()) problems.push(`${s.code}: missing erpDataState`);
    for (const d of s.dependsOn) {
      const dep = STEPS_BY_CODE[d];
      if (!dep) problems.push(`${s.code}: unknown prerequisite ${d}`);
      else if (dep.scope !== s.scope) problems.push(`${s.code}: prerequisite ${d} has a different scope`);
    }
  }
  // acyclic: repeatedly peel off steps whose prerequisites are all peeled
  const peeled = new Set<WorkflowStepCode>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const s of STEPS) {
      if (!peeled.has(s.code) && s.dependsOn.every((d) => peeled.has(d))) {
        peeled.add(s.code);
        progress = true;
      }
    }
  }
  if (peeled.size !== STEPS.length) problems.push('dependency cycle detected');
  for (const st of STAGES) if (stepsInStage(st.stage).length === 0) problems.push(`stage ${st.stage} has no steps`);
  return problems;
}
