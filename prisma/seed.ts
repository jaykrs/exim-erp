/**
 * Dummy data so the port-arrival endpoint can be exercised end to end.
 *   npm run db:seed        (idempotent: safe to run repeatedly)
 *
 * Everything here is FICTIONAL sample data: IEC/GSTIN/PAN values are placeholders and the duty
 * rates are illustrative, NOT current CBIC notifications. Replace with real masters before use.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password';

const prisma = new PrismaClient();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function main() {
  // ── Company & users ────────────────────────────────────────────────────────
  const company = await prisma.company.upsert({
    where: { iec: '0123456789' },
    update: {},
    create: {
      legalName: 'Demo Agro Exports Pvt Ltd',
      iec: '0123456789',
      iecIssuedOn: day('2018-04-01'),
      gstin: '27AAAAA0000A1Z5',
      pan: 'AAAAA0000A',
      adCode: '0510001-1234567',
      aeoTier: 'T1',
      aeoCertificateNo: 'AEO-T1-DEMO-001',
      aeoValidTill: day('2028-03-31'),
    },
  });
  // One demo user per role, all with SEED_PASSWORD (development only — change before any shared use).
  const seedPassword = process.env.SEED_PASSWORD ?? 'ChangeMe-Dev-1';
  const passwordHash = hashPassword(seedPassword);
  const demoUsers = [
    ['admin', 'Demo Admin', 'ADMIN'],
    ['sourcing', 'Demo Sourcing', 'SOURCING_MANAGER'],
    ['warehouse', 'Demo Warehouse', 'WAREHOUSE_MANAGER'],
    ['logistics', 'Demo Logistics', 'LOGISTICS_MANAGER'],
    ['compliance', 'Demo Compliance', 'COMPLIANCE_OFFICER'],
    ['finance', 'Demo Finance', 'FINANCE_CONTROLLER'],
    ['viewer', 'Demo Viewer', 'VIEWER'],
  ] as const;
  let admin = { id: 0 };
  for (const [handle, name, role] of demoUsers) {
    const email = `${handle}@demo-exim.test`;
    const u = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { companyId: company.id, email, name, role, passwordHash },
    });
    if (role === 'ADMIN') admin = u;
  }

  // ── Currencies & FX ────────────────────────────────────────────────────────
  for (const c of [
    { code: 'INR', name: 'Indian Rupee' },
    { code: 'USD', name: 'US Dollar' },
    { code: 'EUR', name: 'Euro' },
    { code: 'AED', name: 'UAE Dirham' },
  ]) {
    await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  }
  // CUSTOMS_NOTIFIED = what duty is assessed on; RBI_REFERENCE = market view (illustrative values).
  const fx = [
    ['USD', 'INR', 'CUSTOMS_NOTIFIED', '84.500000'],
    ['USD', 'INR', 'RBI_REFERENCE', '83.900000'],
    ['EUR', 'INR', 'CUSTOMS_NOTIFIED', '91.300000'],
    ['EUR', 'INR', 'RBI_REFERENCE', '90.800000'],
    ['AED', 'INR', 'CUSTOMS_NOTIFIED', '23.000000'],
  ] as const;
  const rateDate = day('2026-10-30');
  for (const [from, to, source, rate] of fx) {
    await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency_source_effectiveDate: { fromCurrency: from, toCurrency: to, source, effectiveDate: rateDate } },
      update: {},
      create: { fromCurrency: from, toCurrency: to, source, rate, effectiveDate: rateDate },
    });
  }

  // ── Locations ──────────────────────────────────────────────────────────────
  const loc = async (unlocode: string, customsCode: string, name: string, countryCode: string, type: 'SEA_PORT' | 'AIRPORT') =>
    prisma.location.upsert({ where: { unlocode }, update: {}, create: { unlocode, customsCode, name, countryCode, type } });
  const nhava = await loc('INNSA', 'INNSA1', 'Nhava Sheva (JNPT)', 'IN', 'SEA_PORT');
  const jebel = await loc('AEJEA', 'AEJEA1', 'Jebel Ali', 'AE', 'SEA_PORT');
  const rotterdam = await loc('NLRTM', 'NLRTM1', 'Rotterdam', 'NL', 'SEA_PORT');
  await loc('INBOM', 'INBOM4', 'Mumbai (CSMIA) Air Cargo', 'IN', 'AIRPORT');

  // ── HS codes, duty rates (illustrative), regulatory rules ──────────────────
  const hs = async (code: string, description: string, uqc: string) =>
    prisma.hsCode.upsert({
      where: { code },
      update: {},
      create: { code, digits: code.length, chapter: code.slice(0, 2), description, uqc },
    });
  const hsMango = await hs('08045020', 'Fresh mangoes', 'KGS');
  const hsOlive = await hs('15099000', 'Olive oil, other', 'KGS');
  const hsPharma = await hs('30049099', 'Medicaments, other, retail packs', 'NOS');

  const rate = async (hsCodeId: number, countryCode: string, bcd: string, sws: string, add: string, igst: string, ref: string) =>
    prisma.hsDutyRate.upsert({
      where: { hsCodeId_countryCode_effectiveFrom: { hsCodeId, countryCode, effectiveFrom: day('2026-04-01') } },
      update: {},
      create: {
        hsCodeId,
        countryCode,
        bcdRate: bcd,
        swsRate: sws,
        additionalDutyRate: add,
        igstRate: igst,
        effectiveFrom: day('2026-04-01'),
        notificationRef: ref,
      },
    });
  // India as importer (jurisdiction 'IN') and UAE/NL as destination markets for exports.
  await rate(hsOlive.id, 'IN', '45.0000', '10.0000', '0.0000', '5.0000', 'DEMO-SAMPLE (not a real notification)');
  await rate(hsPharma.id, 'IN', '10.0000', '10.0000', '0.0000', '12.0000', 'DEMO-SAMPLE (not a real notification)');
  await rate(hsMango.id, 'AE', '0.0000', '0.0000', '0.0000', '5.0000', 'DEMO-SAMPLE (not a real notification)');
  await rate(hsMango.id, 'NL', '0.0000', '0.0000', '0.0000', '9.0000', 'DEMO-SAMPLE (not a real notification)');

  const rule = async (hsPrefix: string, board: 'FSSAI' | 'PLANT_QUARANTINE' | 'CDSCO' | 'APEDA', scope: 'EXPORT' | 'IMPORT' | 'BOTH', leadTimeDays: number, description: string) =>
    prisma.hsRegulatoryRule.upsert({
      where: { hsPrefix_board_scope: { hsPrefix, board, scope } },
      update: {},
      create: { hsPrefix, board, scope, isMandatory: true, leadTimeDays, description },
    });
  await rule('0804', 'PLANT_QUARANTINE', 'EXPORT', 3, 'Phytosanitary certificate for fresh fruit');
  await rule('0804', 'APEDA', 'EXPORT', 2, 'APEDA registration / residue monitoring');
  await rule('1509', 'FSSAI', 'IMPORT', 5, 'FSSAI import clearance for edible oils');
  await rule('3004', 'CDSCO', 'IMPORT', 10, 'CDSCO import licence check for medicaments');

  // ── Parties ────────────────────────────────────────────────────────────────
  const party = async (code: string, name: string, type: 'BUYER' | 'CONSIGNEE' | 'FREIGHT_FORWARDER' | 'CUSTOMS_HOUSE_AGENT' | 'SHIPPING_LINE', countryCode: string) =>
    prisma.party.upsert({ where: { code }, update: {}, create: { code, name, type, countryCode } });
  const buyer = await party('BUY-AE-001', 'Gulf Fresh Trading LLC', 'BUYER', 'AE');
  const cha = await party('CHA-IN-001', 'Demo CHA Services', 'CUSTOMS_HOUSE_AGENT', 'IN');
  const forwarder = await party('FF-IN-001', 'Demo Freight Forwarders', 'FREIGHT_FORWARDER', 'IN');
  const line = await party('SL-001', 'Demo Shipping Line', 'SHIPPING_LINE', 'DK');
  const importerSelf = await party('BUY-IN-001', 'Demo Agro Exports Pvt Ltd (importer)', 'BUYER', 'IN');

  // ── Sourcing: vendor, product, PO ──────────────────────────────────────────
  const vendor = await prisma.vendor.upsert({
    where: { code: 'VEN-001' },
    update: {},
    create: {
      companyId: company.id,
      code: 'VEN-001',
      name: 'Ratnagiri Mango Growers Co-op',
      gstin: '27BBBBB1111B1Z5',
      pan: 'BBBBB1111B',
      status: 'VERIFIED',
      onboardedAt: new Date('2026-06-01T00:00:00Z'),
    },
  });
  const mango = await prisma.product.upsert({
    where: { sku: 'MANGO-ALPHONSO-4KG' },
    update: {},
    create: {
      sku: 'MANGO-ALPHONSO-4KG', name: 'Alphonso mango, 4 kg box', hsCodeId: hsMango.id, uom: 'BOX',
      isPerishable: true, defaultTempZone: 'COLD', shelfLifeDays: 21,
    },
  });
  const olive = await prisma.product.upsert({
    where: { sku: 'OLIVE-OIL-1L-EVOO' },
    update: {},
    create: { sku: 'OLIVE-OIL-1L-EVOO', name: 'Extra virgin olive oil, 1 L', hsCodeId: hsOlive.id, uom: 'LTR', defaultTempZone: 'AMBIENT' },
  });

  const po = await prisma.purchaseOrder.upsert({
    where: { poNo: 'PO-2026-0001' },
    update: {},
    create: {
      poNo: 'PO-2026-0001', companyId: company.id, vendorId: vendor.id, incoterm: 'FCA', incotermPlace: 'Ratnagiri',
      currencyCode: 'INR', status: 'AWAITING_PRODUCTION', orderDate: day('2026-10-01'),
      expectedDeliveryDate: day('2026-10-20'), totalAmount: '600000.00',
    },
  });
  await prisma.purchaseOrderLine.upsert({
    where: { purchaseOrderId_lineNo: { purchaseOrderId: po.id, lineNo: 1 } },
    update: {},
    create: { purchaseOrderId: po.id, lineNo: 1, productId: mango.id, quantity: '2000.000', uom: 'BOX', unitPrice: '300.0000', lineTotal: '600000.00' },
  });

  // ── Warehouse & batches (with a graded child lot each) ─────────────────────
  const wh = await prisma.warehouse.upsert({
    where: { code: 'WH-MUM-COLD' },
    update: {},
    create: { companyId: company.id, code: 'WH-MUM-COLD', name: 'Mumbai Cold Store', type: 'COLD_STORAGE', address: 'Taloja, Navi Mumbai' },
  });
  const mkBatch = async (batchNo: string, productId: number, qty: string, unitCostInr: string, trace: string) => {
    const b = await prisma.batch.upsert({
      where: { batchNo },
      update: {},
      create: {
        batchNo, traceabilityCode: trace, productId, vendorId: vendor.id, warehouseId: wh.id, status: 'AVAILABLE',
        complianceStatus: 'PASSED', quantity: qty, availableQty: qty, unitCostInr,
        manufacturedOn: day('2026-10-22'), expiresOn: day('2026-11-12'),
      },
    });
    const g = await prisma.batchGrade.upsert({
      where: { batchId_gradeTier: { batchId: b.id, gradeTier: 'A' } },
      update: {},
      create: { batchId: b.id, gradeTier: 'A', weightKg: '8000.000', quantity: qty, availableQty: qty },
    });
    return { batch: b, grade: g };
  };
  const exportLot = await mkBatch('BATCH-MANGO-001', mango.id, '2000.000', '300.0000', 'LOT-2026-0001');
  const importLot = await mkBatch('BATCH-OLIVE-001', olive.id, '5000.000', '620.0000', 'LOT-2026-0002');

  // ── Shipment 1: EXPORT, sea, reefer, gated in (ready for POST …/port-arrival) ──
  const exp = await prisma.shipment.upsert({
    where: { shipmentNo: 'SHP-EXP-0001' },
    update: {},
    create: {
      shipmentNo: 'SHP-EXP-0001', companyId: company.id, direction: 'EXPORT', mode: 'SEA', incoterm: 'FOB',
      status: 'GATED_IN', buyerId: buyer.id, forwarderId: forwarder.id, chaId: cha.id, carrierId: line.id,
      polId: nhava.id, podId: jebel.id, invoiceCurrencyCode: 'USD', etd: new Date('2026-11-05T00:00:00Z'),
      eta: new Date('2026-11-12T00:00:00Z'), packageCount: 2000, grossWeightKg: '8600.000', netWeightKg: '8000.000',
      declaredValue: '7100.00', requiresColdChain: true,
    },
  });
  await prisma.seaShipmentDetail.upsert({
    where: { shipmentId: exp.id },
    update: {},
    create: { shipmentId: exp.id, loadType: 'FCL', bookingNo: 'BKG-DEMO-001', vesselName: 'MV DEMO STAR', voyageNo: '2611E', terminalName: 'JNPT Terminal' },
  });
  let expContainer = await prisma.container.findFirst({ where: { shipmentId: exp.id, containerNo: 'MSKU1234565' } });
  if (!expContainer) {
    expContainer = await prisma.container.create({
      data: {
        shipmentId: exp.id, containerNo: 'MSKU1234565', containerType: 'REEFER_40', loadType: 'FCL', sealNo: 'SEAL-001',
        reeferSetPointC: '8.00', dataLoggerId: 'DL-0001', freeDays: 3, demurrageRatePerDay: '4500.00',
      },
    });
  }
  await prisma.shipmentItem.upsert({
    where: { shipmentId_batchGradeId: { shipmentId: exp.id, batchGradeId: exportLot.grade.id } },
    update: {},
    create: {
      shipmentId: exp.id, batchId: exportLot.batch.id, batchGradeId: exportLot.grade.id, productId: mango.id, hsCodeId: hsMango.id,
      containerId: expContainer.id, quantity: '2000.000', unitPrice: '3.5500', unitCostInr: '300.0000',
      netWeightKg: '8000.000', grossWeightKg: '8600.000',
    },
  });

  // ── Shipment 2: IMPORT, sea, in transit to Nhava Sheva (FSSAI rule will trigger) ──
  const imp = await prisma.shipment.upsert({
    where: { shipmentNo: 'SHP-IMP-0001' },
    update: {},
    create: {
      shipmentNo: 'SHP-IMP-0001', companyId: company.id, direction: 'IMPORT', mode: 'SEA', incoterm: 'CIF',
      status: 'IN_TRANSIT', buyerId: importerSelf.id, chaId: cha.id, forwarderId: forwarder.id, carrierId: line.id,
      polId: rotterdam.id, podId: nhava.id, invoiceCurrencyCode: 'EUR', etd: new Date('2026-10-15T00:00:00Z'),
      eta: new Date('2026-11-04T00:00:00Z'), packageCount: 5000, grossWeightKg: '5400.000', netWeightKg: '4600.000',
      declaredValue: '31000.00', requiresColdChain: false,
    },
  });
  await prisma.seaShipmentDetail.upsert({
    where: { shipmentId: imp.id },
    update: {},
    create: { shipmentId: imp.id, loadType: 'FCL', bookingNo: 'BKG-DEMO-002', vesselName: 'MV DEMO HORIZON', voyageNo: '2610W', terminalName: 'JNPT Terminal' },
  });
  let impContainer = await prisma.container.findFirst({ where: { shipmentId: imp.id, containerNo: 'TGHU7654320' } });
  if (!impContainer) {
    impContainer = await prisma.container.create({
      data: {
        shipmentId: imp.id, containerNo: 'TGHU7654320', containerType: 'GP_20', loadType: 'FCL', sealNo: 'SEAL-002',
        freeDays: 5, demurrageRatePerDay: '2200.00',
      },
    });
  }
  await prisma.shipmentItem.upsert({
    where: { shipmentId_batchGradeId: { shipmentId: imp.id, batchGradeId: importLot.grade.id } },
    update: {},
    create: {
      shipmentId: imp.id, batchId: importLot.batch.id, batchGradeId: importLot.grade.id, productId: olive.id, hsCodeId: hsOlive.id,
      containerId: impContainer.id, quantity: '5000.000', unitPrice: '6.2000', unitCostInr: '620.0000',
      netWeightKg: '4600.000', grossWeightKg: '5400.000',
    },
  });

  console.log(`Seeded. Try: POST /api/shipments/${exp.id}/port-arrival (export, signed in as admin@demo-exim.test, id ${admin.id}) and /${imp.id}/port-arrival (import).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
