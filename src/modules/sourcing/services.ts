/**
 * Stage 1 — Sourcing & vendor onboarding (checklist steps 1–4).
 * Each function is one transaction; each records its checklist step for the right subject.
 */
import type {
  AuditResult,
  AuditStandard,
  BgType,
  FxSide,
  Incoterm,
  LcType,
} from '@prisma/client';
import { DomainError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { D, round2 } from '@/lib/money';
import { runTx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';

const PASSING: AuditResult[] = ['PASSED', 'PASSED_WITH_MINOR_NC'];

// ── Step 1 — vendor compliance verification ─────────────────────────────────
export interface VendorAuditInput {
  standard: AuditStandard;
  auditBody?: string;
  certificateNo?: string;
  auditDate: Date;
  validTill?: Date;
  score?: number;
  result: AuditResult;
  reportUrl?: string;
}

export async function verifyVendor(input: { vendorId: number; audits: VendorAuditInput[]; actorId?: number; now?: Date }) {
  const now = input.now ?? new Date();
  return runTx(async (tx) => {
    const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId } });
    if (!vendor) throw new DomainError('VENDOR_NOT_FOUND', `Vendor ${input.vendorId} does not exist.`, 404);
    if (vendor.status === 'BLACKLISTED') throw new DomainError('VENDOR_BLACKLISTED', 'A blacklisted vendor cannot be verified.', 409);

    for (const a of input.audits) {
      await tx.vendorAudit.create({
        data: {
          vendorId: vendor.id,
          standard: a.standard,
          auditBody: a.auditBody ?? null,
          certificateNo: a.certificateNo ?? null,
          auditDate: a.auditDate,
          validTill: a.validTill ?? null,
          score: a.score ?? null,
          result: a.result,
          reportUrl: a.reportUrl ?? null,
        },
      });
    }

    // Earlier audits that are still valid also count toward verification.
    const earlier = await tx.vendorAudit.findMany({ where: { vendorId: vendor.id, result: { in: PASSING } } });
    const stillValid = earlier.filter((a) => !a.validTill || a.validTill > now).length;

    const failed = input.audits.some((a) => a.result === 'FAILED');
    const pending = input.audits.some((a) => a.result === 'PENDING');
    const verified = !failed && !pending && stillValid > 0;

    const status = verified ? 'VERIFIED' : failed && vendor.status === 'VERIFIED' ? 'SUSPENDED' : 'ONBOARDING';
    await tx.vendor.update({
      where: { id: vendor.id },
      data: { status, ...(verified && !vendor.onboardedAt ? { onboardedAt: now } : {}) },
    });

    const stepStatus = verified ? 'DONE' : failed ? 'BLOCKED' : 'IN_PROGRESS';
    await recordStep(tx, { vendorId: vendor.id }, 'VENDOR_COMPLIANCE_VERIFICATION', stepStatus, {
      actorId: input.actorId,
      reopen: true,
      evidenceUrl: input.audits.find((a) => a.reportUrl)?.reportUrl,
    });
    await writeAudit(tx, {
      entity: 'Vendor', entityId: vendor.id, action: 'STATUS_CHANGE', actorId: input.actorId,
      before: { status: vendor.status }, after: { status },
    });
    return { vendorId: vendor.id, status, step: stepStatus };
  });
}

// ── Step 2 — Incoterm & proforma-invoice execution ──────────────────────────
export async function executeIncotermPi(input: {
  purchaseOrderId: number;
  incoterm: Incoterm;
  incotermPlace: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId } });
    if (!po) throw new DomainError('PO_NOT_FOUND', `Purchase order ${input.purchaseOrderId} does not exist.`, 404);

    const same = po.status === 'AWAITING_PRODUCTION' && po.incoterm === input.incoterm && po.incotermPlace === input.incotermPlace;
    if (same) return { purchaseOrderId: po.id, status: po.status, incoterm: po.incoterm, alreadyExecuted: true };
    if (po.status !== 'DRAFT' && po.status !== 'ISSUED') {
      throw new DomainError('INVALID_PO_STATUS', `PO is ${po.status}; the PI can only be executed from DRAFT or ISSUED.`, 409);
    }
    const vendor = await tx.vendor.findUnique({ where: { id: po.vendorId } });
    if (!vendor || vendor.status !== 'VERIFIED') {
      throw new DomainError('VENDOR_NOT_VERIFIED', 'The vendor must pass compliance verification first.', 409);
    }

    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { incoterm: input.incoterm, incotermPlace: input.incotermPlace, status: 'AWAITING_PRODUCTION' },
    });
    await recordStep(tx, { purchaseOrderId: po.id }, 'INCOTERM_PI_EXECUTION', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, {
      entity: 'PurchaseOrder', entityId: po.id, action: 'STATUS_CHANGE', actorId: input.actorId,
      before: { status: po.status, incoterm: po.incoterm }, after: { status: 'AWAITING_PRODUCTION', incoterm: input.incoterm },
    });
    return { purchaseOrderId: po.id, status: 'AWAITING_PRODUCTION' as const, incoterm: input.incoterm, alreadyExecuted: false };
  });
}

// ── Step 3 — forex risk mitigation ──────────────────────────────────────────
export interface ForwardContractInput {
  purchaseOrderId: number;
  bankId: number;
  contractNo: string;
  side: FxSide;
  currencyCode: string;
  notionalAmount: string;
  contractRate: string;
  spotAtBooking?: string;
  bookingDate: Date;
  windowStart: Date;
  maturityDate: Date;
  actorId?: number;
}

export async function bookForwardContract(input: ForwardContractInput) {
  return runTx(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId } });
    if (!po) throw new DomainError('PO_NOT_FOUND', `Purchase order ${input.purchaseOrderId} does not exist.`, 404);
    if (po.forwardContractId) throw new DomainError('ALREADY_COVERED', 'This PO already has a forward contract.', 409);
    if (po.currencyCode === 'INR') throw new DomainError('NO_FX_EXPOSURE', 'An INR purchase order has no currency exposure to hedge.', 422);
    if (po.currencyCode !== input.currencyCode) {
      throw new DomainError('CURRENCY_MISMATCH', `PO is in ${po.currencyCode}; the contract is in ${input.currencyCode}.`, 422);
    }
    if (input.windowStart > input.maturityDate) throw new DomainError('BAD_WINDOW', 'Delivery window starts after maturity.', 422);
    const notional = D(input.notionalAmount);
    const rate = D(input.contractRate);
    if (notional.lte(0) || rate.lte(0)) throw new DomainError('BAD_AMOUNT', 'Notional and rate must be positive.', 422);

    const fc = await tx.forwardContract.create({
      data: {
        companyId: po.companyId,
        bankId: input.bankId,
        contractNo: input.contractNo,
        side: input.side,
        currencyCode: input.currencyCode,
        notionalAmount: notional.toFixed(2),
        contractRate: rate.toFixed(6),
        spotAtBooking: input.spotAtBooking ? D(input.spotAtBooking).toFixed(6) : null,
        bookingDate: input.bookingDate,
        windowStart: input.windowStart,
        maturityDate: input.maturityDate,
      },
    });
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { forwardContractId: fc.id } });
    await tx.financeLedgerEntry.create({
      data: {
        companyId: po.companyId,
        forwardContractId: fc.id,
        entryType: 'FORWARD_CONTRACT_BOOKED',
        reference: input.contractNo,
        currencyCode: input.currencyCode,
        amount: notional.toFixed(2),
        fixedRate: rate.toFixed(6),
        amountInr: round2(notional.mul(rate)).toFixed(2),
      },
    });
    await recordStep(tx, { purchaseOrderId: po.id }, 'FOREX_RISK_MITIGATION', 'DONE', { actorId: input.actorId, evidenceUrl: undefined });
    await writeAudit(tx, { entity: 'ForwardContract', entityId: fc.id, action: 'CREATE', actorId: input.actorId, after: { contractNo: input.contractNo, notional: notional.toFixed(2), rate: rate.toFixed(6) } });

    const poTotal = D(po.totalAmount);
    return {
      forwardContractId: fc.id,
      coveragePct: poTotal.gt(0) ? notional.div(poTotal).mul(100).toFixed(2) : null,
    };
  });
}

// ── Step 4 — trade finance activation (LC, optional bank guarantee) ─────────
export interface TradeFinanceInput {
  purchaseOrderId: number;
  actorId?: number;
  /** INR per 1 unit of the LC currency at issue (1 when the LC is in INR). */
  fxRateToInr: string;
  lc: {
    lcNo: string;
    applicantId: number;
    issuingBankId: number;
    advisingBankId?: number;
    type: LcType;
    currencyCode: string;
    amount: string;
    tolerancePct?: string;
    usanceDays?: number;
    presentationDays?: number;
    issueDate: Date;
    expiryDate: Date;
    latestShipmentDate?: Date;
    documentUrl: string;
  };
  bankGuarantee?: {
    bgNo: string;
    bankId: number;
    type: BgType;
    beneficiary: string;
    amount: string;
    marginPct?: string;
    issueDate: Date;
    expiryDate: Date;
    claimExpiryDate?: Date;
  };
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export async function activateTradeFinance(input: TradeFinanceInput) {
  return runTx(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId } });
    if (!po) throw new DomainError('PO_NOT_FOUND', `Purchase order ${input.purchaseOrderId} does not exist.`, 404);
    const lc = input.lc;
    if (lc.expiryDate <= lc.issueDate) throw new DomainError('BAD_DATES', 'LC expiry must be after issue.', 422);
    if (lc.latestShipmentDate && lc.latestShipmentDate > lc.expiryDate) {
      throw new DomainError('BAD_DATES', 'Latest shipment date is after LC expiry.', 422);
    }
    const amount = D(lc.amount);
    const tol = D(lc.tolerancePct ?? 0);
    const poTotal = D(po.totalAmount);
    if (lc.currencyCode === po.currencyCode && poTotal.gt(0) && amount.mul(D(100).plus(tol)).div(100).lt(poTotal)) {
      throw new DomainError('LC_BELOW_PO_VALUE', 'LC amount (with tolerance) does not cover the PO value.', 422, { lc: amount.toFixed(2), po: poTotal.toFixed(2) });
    }
    const rate = D(input.fxRateToInr);
    if (lc.currencyCode === 'INR' ? !rate.eq(1) : rate.lte(0)) {
      throw new DomainError('BAD_FX', 'Provide a positive INR rate (exactly 1 for an INR LC).', 422);
    }

    const created = await tx.letterOfCredit.create({
      data: {
        lcNo: lc.lcNo,
        companyId: po.companyId,
        applicantId: lc.applicantId,
        issuingBankId: lc.issuingBankId,
        advisingBankId: lc.advisingBankId ?? null,
        type: lc.type,
        status: 'OPENED',
        currencyCode: lc.currencyCode,
        amount: amount.toFixed(2),
        tolerancePct: tol.toFixed(2),
        usanceDays: lc.usanceDays ?? null,
        presentationDays: lc.presentationDays ?? 21,
        issueDate: lc.issueDate,
        expiryDate: lc.expiryDate,
        latestShipmentDate: lc.latestShipmentDate ?? null,
        documentUrl: lc.documentUrl,
      },
    });
    if (lc.latestShipmentDate) {
      await tx.lcMilestone.create({ data: { lcId: created.id, type: 'LATEST_SHIPMENT_DATE', dueDate: lc.latestShipmentDate } });
      await tx.lcMilestone.create({
        data: { lcId: created.id, type: 'DOCS_PRESENTATION_DUE', dueDate: addDays(lc.latestShipmentDate, lc.presentationDays ?? 21) },
      });
    }
    await tx.lcMilestone.create({ data: { lcId: created.id, type: 'LC_EXPIRY', dueDate: lc.expiryDate } });
    await tx.financeLedgerEntry.create({
      data: {
        companyId: po.companyId,
        letterOfCreditId: created.id,
        entryType: 'LC_OPENED',
        reference: lc.lcNo,
        currencyCode: lc.currencyCode,
        amount: amount.toFixed(2),
        fixedRate: rate.toFixed(6),
        amountInr: round2(amount.mul(rate)).toFixed(2),
      },
    });

    let bankGuaranteeId: number | null = null;
    if (input.bankGuarantee) {
      const bg = input.bankGuarantee;
      const bgAmount = D(bg.amount);
      const row = await tx.bankGuarantee.create({
        data: {
          bgNo: bg.bgNo,
          companyId: po.companyId,
          bankId: bg.bankId,
          type: bg.type,
          beneficiary: bg.beneficiary,
          currencyCode: lc.currencyCode,
          amount: bgAmount.toFixed(2),
          marginPct: D(bg.marginPct ?? 0).toFixed(2),
          issueDate: bg.issueDate,
          expiryDate: bg.expiryDate,
          claimExpiryDate: bg.claimExpiryDate ?? null,
        },
      });
      bankGuaranteeId = row.id;
      await tx.financeLedgerEntry.create({
        data: {
          companyId: po.companyId,
          entryType: 'BANK_GUARANTEE_ISSUED',
          reference: bg.bgNo,
          currencyCode: lc.currencyCode,
          amount: bgAmount.toFixed(2),
          fixedRate: rate.toFixed(6),
          amountInr: round2(bgAmount.mul(rate)).toFixed(2),
        },
      });
    }

    await recordStep(tx, { purchaseOrderId: po.id }, 'TRADE_FINANCE_ACTIVATION', 'DONE', { actorId: input.actorId, evidenceUrl: lc.documentUrl });
    await writeAudit(tx, { entity: 'LetterOfCredit', entityId: created.id, action: 'CREATE', actorId: input.actorId, after: { lcNo: lc.lcNo, amount: amount.toFixed(2) } });
    return { letterOfCreditId: created.id, bankGuaranteeId };
  });
}
