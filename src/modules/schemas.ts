/** Request schemas for every action endpoint, grouped by domain. URL params are merged over the body by defineAction. */
import { z } from 'zod';
import { date, dec, id, text, url } from '@/lib/zod-helpers';

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// ── Sourcing ────────────────────────────────────────────────────────────────
export const VerifyVendor = strict({
  vendorId: id,
  audits: z
    .array(
      strict({
        standard: z.enum(['SEDEX_SMETA', 'BSCI', 'WRAP', 'ISO_9001', 'OTHER']),
        auditBody: text(120).optional(),
        certificateNo: text(80).optional(),
        auditDate: date,
        validTill: date.optional(),
        score: z.number().min(0).max(100).optional(),
        result: z.enum(['PASSED', 'PASSED_WITH_MINOR_NC', 'FAILED', 'PENDING']),
        reportUrl: url.optional(),
      }),
    )
    .min(1),
});

export const ExecutePi = strict({ purchaseOrderId: id, incoterm: z.enum(INCOTERMS), incotermPlace: text(120) });

export const ForwardContract = strict({
  purchaseOrderId: id,
  bankId: id,
  contractNo: text(60),
  side: z.enum(['BUY_FOREIGN', 'SELL_FOREIGN']),
  currencyCode: z.string().length(3),
  notionalAmount: dec,
  contractRate: dec,
  spotAtBooking: dec.optional(),
  bookingDate: date,
  windowStart: date,
  maturityDate: date,
});

export const TradeFinance = strict({
  purchaseOrderId: id,
  fxRateToInr: dec,
  lc: strict({
    lcNo: text(40),
    applicantId: id,
    issuingBankId: id,
    advisingBankId: id.optional(),
    type: z.enum(['SIGHT', 'USANCE', 'REVOLVING', 'STANDBY', 'TRANSFERABLE']),
    currencyCode: z.string().length(3),
    amount: dec,
    tolerancePct: dec.optional(),
    usanceDays: z.number().int().min(0).max(365).optional(),
    presentationDays: z.number().int().min(1).max(90).optional(),
    issueDate: date,
    expiryDate: date,
    latestShipmentDate: date.optional(),
    documentUrl: url,
  }),
  bankGuarantee: strict({
    bgNo: text(40),
    bankId: id,
    type: z.enum(['PERFORMANCE', 'ADVANCE_PAYMENT', 'BID_BOND', 'CUSTOMS_BOND', 'FINANCIAL']),
    beneficiary: text(160),
    amount: dec,
    marginPct: dec.optional(),
    issueDate: date,
    expiryDate: date,
    claimExpiryDate: date.optional(),
  }).optional(),
});

// ── Warehouse ───────────────────────────────────────────────────────────────
export const InwardReceipt = strict({
  grnNo: text(40),
  warehouseId: id,
  vendorId: id,
  purchaseOrderId: id.optional(),
  receivedAt: date,
  vehicleNo: text(30).optional(),
  locationId: id.optional(),
  inspectorId: id.optional(),
  lines: z
    .array(
      strict({
        purchaseOrderLineId: id.optional(),
        productId: id,
        receivedQty: dec,
        acceptedQty: dec,
        rejectedQty: dec.optional(),
        unitCostInr: dec.optional(),
        manufacturedOn: date.optional(),
        expiresOn: date.optional(),
        inspection: strict({
          result: z.enum(['PASSED', 'PASSED_WITH_DEVIATION', 'FAILED', 'PENDING']),
          sampleSize: dec.optional(),
          defectPct: dec.optional(),
          notes: text(500).optional(),
        }),
      }),
    )
    .min(1),
});

export const GradeBatch = strict({
  batchId: id,
  grades: z.array(strict({ gradeTier: z.enum(['PREMIUM', 'A', 'B', 'C', 'REJECT', 'UNGRADED']), weightKg: dec, quantity: dec })).min(1),
});

export const TraceTags = strict({
  batchId: id,
  packageCount: z.number().int().min(1).max(5000).optional(),
  tagType: z.enum(['BARCODE_CODE128', 'GS1_128', 'QR', 'RFID_EPC']).optional(),
});

// ── Compliance ──────────────────────────────────────────────────────────────
export const Ispm15 = strict({
  batchId: id,
  shipmentId: id.optional(),
  packagingType: z.enum(['CARTON', 'WOODEN_PALLET', 'WOODEN_CRATE', 'DRUM', 'BAG', 'BULK']),
  treatment: z.enum(['NOT_APPLICABLE', 'HT', 'MB', 'DH', 'SF']),
  markNo: text(60).optional(),
  treatmentCertNo: text(60).optional(),
  treatmentProvider: text(120).optional(),
  treatedOn: date.optional(),
  packageCount: z.number().int().min(1).optional(),
  verifierId: id.optional(),
});

export const LabTest = strict({
  batchId: id,
  provider: z.enum(['SGS', 'BUREAU_VERITAS', 'INTERTEK', 'TUV', 'NABL_OTHER']),
  testType: text(80),
  referenceNo: text(60).optional(),
  status: z.enum(['SAMPLE_DISPATCHED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'RETEST_REQUIRED']),
  sampleSentAt: date.optional(),
  reportReceivedAt: date.optional(),
  validTill: date.optional(),
  reportUrl: url.optional(),
});

export const LabelValidation = strict({
  batchId: id,
  targetMarket: text(60),
  ruleSet: text(80),
  issues: z.array(text(300)).max(50).optional(),
});

export const BOARDS = ['FSSAI', 'BIS', 'CDSCO', 'PLANT_QUARANTINE', 'ANIMAL_QUARANTINE', 'APEDA', 'MPEDA', 'EIC', 'WILDLIFE', 'OTHER'] as const;
export const ResolveClearance = strict({
  id,
  board: z.enum(BOARDS),
  action: z.enum(['SUBMIT', 'QUERY', 'SAMPLE', 'APPROVE', 'REJECT', 'WAIVE']),
  applicationNo: text(60).optional(),
  referenceNo: text(60).optional(),
  validTill: date.optional(),
  documentUrl: url.optional(),
  note: text(500).optional(),
});

// ── Customs & logistics (shipment id arrives as `id` from the URL) ──────────
export const ShippingBill = strict({
  id,
  portId: id,
  sbNo: text(20),
  sbDate: date,
  igstMode: z.enum(['LUT_ZERO_RATED', 'PAID_WITH_REFUND_CLAIM', 'NOT_APPLICABLE']),
  exchangeRate: dec,
  icegateRefNo: text(40).optional(),
  items: z.array(strict({ shipmentItemId: id, rodtepRatePct: dec.optional(), drawbackRatePct: dec.optional(), igstRatePct: dec.optional() })).min(1),
});

export const Incentives = strict({
  id,
  invoiceNo: text(40),
  invoiceDate: date,
  dueDate: date.optional(),
  paymentTerms: text(120).optional(),
  freight: dec.optional(),
  insurance: dec.optional(),
});

export const Leo = strict({ id, leoNo: text(30), leoDate: date });
export const Loading = strict({ id, loadedAt: date });
export const Departure = strict({ id, departedAt: date, transportDocNo: text(40).optional() });
export const Manifest = strict({ id, type: z.enum(['IGM', 'EGM', 'ISF', 'ENS']), referenceNo: text(40), ackNo: text(40).optional() });
export const BillOfEntry = strict({
  id,
  portId: id,
  boeNo: text(20),
  boeDate: date,
  exchangeRate: dec,
  items: z.array(strict({ shipmentItemId: id, assessableValueInr: dec })).min(1),
});
export const Ooc = strict({ id, oocNo: text(30), oocAt: date, dutyPaidAt: date });
export const LastMile = strict({ id, startedAt: date, vehicleNo: text(30).optional(), locationText: text(200).optional() });
export const Delivery = strict({ id, deliveredAt: date, receivedBy: text(120), qualityOk: z.boolean(), podUrl: url, note: text(500).optional() });

// ── Finance ─────────────────────────────────────────────────────────────────
export const Charge = strict({
  id,
  component: z.enum(['FREIGHT', 'INSURANCE', 'PORT_HANDLING', 'TERMINAL_HANDLING', 'CFS_CHARGES', 'CUSTOMS_BROKERAGE', 'INLAND_TRANSPORT', 'BANK_CHARGES', 'DEMURRAGE', 'DETENTION', 'OTHER']),
  amount: dec,
  currencyCode: z.string().length(3),
  allocationBasis: z.enum(['VALUE', 'WEIGHT', 'QUANTITY']).optional(),
  isEstimated: z.boolean().optional(),
  invoiceRef: text(60).optional(),
  incurredOn: date,
  containerId: id.optional(),
  payeeId: id.optional(),
  description: text(200).optional(),
});
export const Recost = strict({ id, igstRecoverable: z.boolean().optional() });
export const FinalizeCost = strict({ id, acceptEstimates: z.boolean().optional() });
export const Reconcile = strict({
  id,
  receipts: z.array(strict({ currencyCode: z.string().length(3), amount: dec, rateToInr: dec, receivedAt: date, reference: text(60).optional() })).min(1),
  letterOfCreditId: id.optional(),
  forwardContractId: id.optional(),
});

// ── Auth ────────────────────────────────────────────────────────────────────
export const Login = strict({ email: z.string().email().max(190), password: z.string().min(1).max(200) });
