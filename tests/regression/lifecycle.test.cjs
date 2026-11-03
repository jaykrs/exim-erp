// End-to-end lifecycle through the REAL services on the schema-aware in-memory database:
// vendor → PO → forward cover → LC → inward → grading → tags → ISPM 15 → lab → label → shipping bill → incentives
// → LEO → port arrival → loading → departure → delivery → reconciliation (export), and manifest → port arrival →
// BoE → PGA → OOC → landed cost → delivery (import). Not a SQL test: see ARCHITECTURE.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

const skip = H ? false : 'install @prisma/prisma-schema-wasm to run lifecycle tests';
const AS_OF = new Date('2026-11-01T12:00:00Z'); // seeded FX is dated 2026-10-30; keeps the 45-day rule deterministic
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const rejects = (p, code, status) =>
  assert.rejects(p, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (status) assert.equal(e.httpStatus, status);
    return true;
  });

async function setup() {
  H.db.reset();
  await H.seed();
  const c = H.db.client;
  const company = (await c.company.findFirst({}));
  const product = await c.product.findUnique({ where: { sku: 'MANGO-ALPHONSO-4KG' } });
  const warehouse = await c.warehouse.findUnique({ where: { code: 'WH-MUM-COLD' } });
  const buyer = await c.party.findUnique({ where: { code: 'BUY-AE-001' } });
  const nhava = await c.location.findUnique({ where: { unlocode: 'INNSA' } });
  const jebel = await c.location.findUnique({ where: { unlocode: 'AEJEA' } });
  const bank = await c.bank.create({ data: { name: 'Demo Bank', swiftCode: 'DEMOINBB' } });
  await c.lutRegistration.create({
    data: { companyId: company.id, lutNumber: 'LUT-DEMO-1', financialYear: '2026-27', validFrom: day('2026-04-01'), validTill: day('2027-03-31') },
  });
  return { c, company, product, warehouse, buyer, nhava, jebel, bank };
}

test('EXPORT: sourcing → warehouse → compliance → customs → delivery → reconciliation closes every applicable step', { skip }, async () => {
  const x = await setup();
  const { c } = x;
  const S = {
    sourcing: H.load('src/modules/sourcing/services.ts'),
    wh: H.load('src/modules/warehouse/services.ts'),
    comp: H.load('src/modules/compliance/services.ts'),
    cust: H.load('src/modules/customs/services.ts'),
    fin: H.load('src/modules/finance/services.ts'),
    del: H.load('src/modules/logistics/services/delivery.service.ts'),
    arr: H.load('src/modules/logistics/services/port-arrival.service.ts'),
    track: H.load('src/modules/consignment/step-tracker.ts'),
  };

  // ── Stage 1 ──
  const vendor = await c.vendor.create({ data: { companyId: x.company.id, code: 'VEN-LIFE', name: 'Lifecycle Growers' } });
  const v = await S.sourcing.verifyVendor({ vendorId: vendor.id, audits: [{ standard: 'ISO_9001', auditDate: day('2026-09-01'), validTill: day('2027-09-01'), result: 'PASSED' }] });
  assert.equal(v.status, 'VERIFIED');

  const po = await c.purchaseOrder.create({
    data: { poNo: 'PO-LIFE-1', companyId: x.company.id, vendorId: vendor.id, incoterm: 'FCA', currencyCode: 'USD', orderDate: day('2026-10-01'), totalAmount: '10000.00' },
  });
  const line = await c.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, lineNo: 1, productId: x.product.id, quantity: '2000.000', uom: 'BOX', unitPrice: '5.0000', lineTotal: '10000.00' } });

  await rejects(S.sourcing.bookForwardContract({ purchaseOrderId: po.id, bankId: x.bank.id, contractNo: 'FC-1', side: 'SELL_FOREIGN', currencyCode: 'USD', notionalAmount: '10000', contractRate: '84.1', bookingDate: day('2026-10-02'), windowStart: day('2026-11-01'), maturityDate: day('2026-12-01') }), 'STEP_PREREQUISITE_PENDING', 409);
  assert.equal(H.db.count('ForwardContract'), 0, 'failed call must roll back');

  await S.sourcing.executeIncotermPi({ purchaseOrderId: po.id, incoterm: 'FOB', incotermPlace: 'Nhava Sheva' });
  const fc = await S.sourcing.bookForwardContract({ purchaseOrderId: po.id, bankId: x.bank.id, contractNo: 'FC-1', side: 'SELL_FOREIGN', currencyCode: 'USD', notionalAmount: '10000', contractRate: '84.1', bookingDate: day('2026-10-02'), windowStart: day('2026-11-01'), maturityDate: day('2026-12-01') });
  assert.equal(fc.coveragePct, '100.00');
  const tf = await S.sourcing.activateTradeFinance({
    purchaseOrderId: po.id, fxRateToInr: '84.0',
    lc: { lcNo: 'LC-1', applicantId: x.buyer.id, issuingBankId: x.bank.id, type: 'SIGHT', currencyCode: 'USD', amount: '10000', issueDate: day('2026-10-05'), expiryDate: day('2027-01-05'), latestShipmentDate: day('2026-12-01'), documentUrl: 'https://files.test/lc-1.pdf' },
  });
  assert.ok(tf.letterOfCreditId);
  assert.equal(H.db.count('LcMilestone'), 3);

  // ── Stage 2 ──
  const grn = await S.wh.recordInwardInspection({
    grnNo: 'GRN-LIFE-1', warehouseId: x.warehouse.id, vendorId: vendor.id, purchaseOrderId: po.id, receivedAt: day('2026-10-20'),
    lines: [{ purchaseOrderLineId: line.id, productId: x.product.id, receivedQty: '2000', acceptedQty: '2000', unitCostInr: '300', expiresOn: day('2026-11-20'), inspection: { result: 'PASSED' } }],
  });
  assert.equal(grn.purchaseOrderStatus, 'RECEIVED');
  const batchId = grn.batches[0].id;

  await rejects(S.wh.generateTraceTags({ batchId }), 'NOT_GRADED', 409);
  await rejects(S.wh.gradeBatch({ batchId, grades: [{ gradeTier: 'A', weightKg: '7000', quantity: '1500' }] }), 'GRADE_SUM_MISMATCH', 422);
  const g = await S.wh.gradeBatch({ batchId, grades: [{ gradeTier: 'A', weightKg: '7000', quantity: '1800' }, { gradeTier: 'REJECT', weightKg: '800', quantity: '200' }] });
  assert.equal(g.sellableQty, '1800.000');
  await rejects(S.wh.gradeBatch({ batchId, grades: [{ gradeTier: 'A', weightKg: '1', quantity: '2000' }] }), 'ALREADY_GRADED', 409);
  const tags = await S.wh.generateTraceTags({ batchId, packageCount: 3, year: 2026 });
  assert.match(tags.traceabilityCode, /^LOT-2026-\d{4}$/);
  assert.equal((await S.wh.generateTraceTags({ batchId })).alreadyGenerated, true);

  // ── Stage 3 (and atomicity: ISPM 15 evidence missing → nothing written) ──
  await rejects(S.comp.verifyIspm15({ batchId, packagingType: 'WOODEN_PALLET', treatment: 'HT' }), 'ISPM15_EVIDENCE_REQUIRED', 422);
  assert.equal(H.db.count('PackagingRecord'), 0);
  await S.comp.verifyIspm15({ batchId, packagingType: 'WOODEN_PALLET', treatment: 'HT', markNo: 'IN-0001-HT', treatmentCertNo: 'CERT-1', treatedOn: day('2026-10-25'), packageCount: 3 });
  await rejects(S.comp.recordLabTest({ batchId, provider: 'SGS', testType: 'residue', status: 'PASSED' }), 'REPORT_REQUIRED', 422);
  const failed = await S.comp.recordLabTest({ batchId, provider: 'SGS', testType: 'residue', status: 'FAILED' });
  assert.equal(failed.complianceStatus, 'FAILED');
  assert.equal((await c.batch.findUnique({ where: { id: batchId } })).status, 'ON_HOLD');
  const lab = await S.comp.recordLabTest({ batchId, provider: 'SGS', testType: 'residue', status: 'PASSED', reportUrl: 'https://files.test/lab.pdf' });
  assert.equal(lab.complianceStatus, 'PASSED');
  assert.equal((await c.batch.findUnique({ where: { id: batchId } })).status, 'AVAILABLE', 'a later pass releases the hold');
  const label = await S.comp.validateLabel({ batchId, targetMarket: 'AE', ruleSet: 'GSO-9' });
  assert.equal(label.readyForDispatch, true);

  // ── Shipment (direct insert: booking is outside the checklist) ──
  const gradeA = (await c.batchGrade.findMany({ where: { batchId } })).find((r) => r.gradeTier === 'A');
  const shipment = await c.shipment.create({
    data: { shipmentNo: 'SHP-LIFE-1', companyId: x.company.id, direction: 'EXPORT', mode: 'SEA', incoterm: 'FOB', status: 'BOOKED', buyerId: x.buyer.id, polId: x.nhava.id, podId: x.jebel.id, invoiceCurrencyCode: 'USD', letterOfCreditId: tf.letterOfCreditId, declaredValue: '9000.00', requiresColdChain: true },
  });
  await c.seaShipmentDetail.create({ data: { shipmentId: shipment.id, loadType: 'FCL' } });
  const cont = await c.container.create({ data: { shipmentId: shipment.id, containerNo: 'MSKU1234565', containerType: 'REEFER_40', reeferSetPointC: '8.00' } });
  const item = await c.shipmentItem.create({ data: { shipmentId: shipment.id, batchId, batchGradeId: gradeA.id, productId: x.product.id, hsCodeId: x.product.hsCodeId, containerId: cont.id, quantity: '1800.000', unitPrice: '5.0000', unitCostInr: '300.0000' } });
  const sid = shipment.id;

  // ── Stage 4 ──
  await rejects(S.cust.fileShippingBill({ shipmentId: sid, portId: x.nhava.id, sbNo: 'SB1000001', sbDate: day('2026-10-28'), igstMode: 'LUT_ZERO_RATED', exchangeRate: '84.5', items: [] }), 'ITEMS_MISMATCH', 422);
  const sb = await S.cust.fileShippingBill({ shipmentId: sid, portId: x.nhava.id, sbNo: 'SB1000001', sbDate: day('2026-10-28'), igstMode: 'LUT_ZERO_RATED', exchangeRate: '84.5', items: [{ shipmentItemId: item.id, rodtepRatePct: '1.5', drawbackRatePct: '0.5' }] });
  assert.equal(sb.fobValueInr, '760500.00'); // 1800 × 5.00 × 84.5
  assert.equal((await S.cust.fileShippingBill({ shipmentId: sid, portId: x.nhava.id, sbNo: 'SB1000001', sbDate: day('2026-10-28'), igstMode: 'LUT_ZERO_RATED', exchangeRate: '84.5', items: [{ shipmentItemId: item.id }] })).alreadyFiled, true);
  const inc = await S.cust.logZeroRatedAndIncentives({ shipmentId: sid, invoiceNo: 'INV-LIFE-1', invoiceDate: day('2026-10-29') });
  assert.equal(inc.rodtepInr, '11407.50');
  assert.equal(inc.drawbackInr, '3802.50');
  assert.equal(H.db.count('IncentiveClaim'), 2);
  await rejects(S.cust.confirmLoading({ shipmentId: sid, loadedAt: day('2026-11-02') }), 'INVALID_STATUS', 409);
  await S.cust.grantLeo({ shipmentId: sid, leoNo: 'LEO-1', leoDate: day('2026-10-30') });

  const arrival = await S.arr.processPortArrival({ shipmentId: sid, arrivedAt: new Date('2026-11-01T08:00:00Z'), asOf: AS_OF, temperatureC: 8.5, actorId: 1 });
  assert.equal(arrival.status, 'CUSTOMS_HOLD');
  assert.ok(['PGA_CLEARANCE_PENDING', 'CUSTOMS_HOLD_PLACED'].includes(arrival.milestone), arrival.milestone);
  assert.deepEqual(arrival.compliance.map((r) => r.board).sort(), ['APEDA', 'PLANT_QUARANTINE']);

  for (const board of ['PLANT_QUARANTINE', 'APEDA']) {
    await S.comp.resolveClearance({ shipmentId: sid, board, action: 'SUBMIT', applicationNo: `APP-${board}` });
    await rejects(S.comp.resolveClearance({ shipmentId: sid, board, action: 'APPROVE' }), 'REFERENCE_REQUIRED', 422);
    await S.comp.resolveClearance({ shipmentId: sid, board, action: 'APPROVE', referenceNo: `REF-${board}` });
  }
  assert.equal((await c.shipment.findUnique({ where: { id: sid } })).pgaClearance, 'APPROVED');

  const loaded = await S.cust.confirmLoading({ shipmentId: sid, loadedAt: new Date('2026-11-02T06:00:00Z') });
  assert.equal(loaded.releasedHolds, 1, 'export hold is released at loading once LEO exists');
  await S.cust.confirmDeparture({ shipmentId: sid, departedAt: new Date('2026-11-03T00:00:00Z'), transportDocNo: 'MBL-1' });
  assert.equal((await c.shipment.findUnique({ where: { id: sid } })).status, 'IN_TRANSIT');

  // ── Stage 6 ──
  await rejects(S.del.confirmDelivery({ shipmentId: sid, deliveredAt: day('2026-11-20'), receivedBy: '  ', qualityOk: true, podUrl: 'https://files.test/pod.pdf' }), 'RECEIVER_REQUIRED', 422);
  const bad = await S.del.confirmDelivery({ shipmentId: sid, deliveredAt: day('2026-11-20'), receivedBy: 'Gulf Fresh QA', qualityOk: false, podUrl: 'https://files.test/pod.pdf', note: 'temperature log gap' });
  assert.equal(bad.exception, true);
  assert.equal((await c.shipment.findUnique({ where: { id: sid } })).status, 'IN_TRANSIT', 'quality failure does not deliver');
  const ok = await S.del.confirmDelivery({ shipmentId: sid, deliveredAt: day('2026-11-21'), receivedBy: 'Gulf Fresh QA', qualityOk: true, podUrl: 'https://files.test/pod.pdf' });
  assert.equal(ok.ownershipTransferredBatches, 1);
  assert.equal((await c.batch.findUnique({ where: { id: batchId } })).currentOwner, 'IMPORT_PARTY');

  const rec = await S.fin.reconcileShipment({
    shipmentId: sid, forwardContractId: fc.forwardContractId,
    receipts: [{ currencyCode: 'USD', amount: '9000', rateToInr: '83.9', receivedAt: day('2026-11-25'), reference: 'SWIFT-1' }],
  });
  assert.equal(rec.settled, true, '9,000 received against a 9,000 invoice');
  assert.equal((await c.shipment.findUnique({ where: { id: sid } })).status, 'CLOSED');
  assert.equal((await c.letterOfCredit.findUnique({ where: { id: tf.letterOfCreditId } })).status, 'PAID');
  const tl = await S.track.getConsignmentTimeline(sid);
  assert.equal(tl.overall.total, 18, 'export skips steps 16-20');
  assert.equal(tl.overall.done, tl.overall.total);
  assert.deepEqual(H.db.problems, [], 'no VARCHAR/DECIMAL violations');
});

test('IMPORT: manifest → arrival → BoE → PGA → OOC → landed cost → delivery', { skip }, async () => {
  const x = await setup();
  const { c } = x;
  const A = {
    cust: H.load('src/modules/customs/services.ts'),
    comp: H.load('src/modules/compliance/services.ts'),
    fin: H.load('src/modules/finance/services.ts'),
    del: H.load('src/modules/logistics/services/delivery.service.ts'),
    arr: H.load('src/modules/logistics/services/port-arrival.service.ts'),
    track: H.load('src/modules/consignment/step-tracker.ts'),
  };
  const shp = await c.shipment.findUnique({ where: { shipmentNo: 'SHP-IMP-0001' }, include: { items: true } });
  assert.ok(shp, 'seed provides an import shipment');
  const sid = shp.id;

  await A.cust.fileManifest({ shipmentId: sid, type: 'IGM', referenceNo: 'IGM-1' });
  const arrival = await A.arr.processPortArrival({ shipmentId: sid, arrivedAt: new Date('2026-11-01T08:00:00Z'), asOf: AS_OF, actorId: 1 });
  assert.equal(arrival.status, 'CUSTOMS_IMPORT_HOLD');
  assert.ok(arrival.landedCost, 'landed cost sheet created on arrival');

  const portId = (await c.location.findUnique({ where: { unlocode: 'INNSA' } })).id;
  await A.cust.submitBillOfEntry({ shipmentId: sid, portId, boeNo: 'BOE1000001', boeDate: day('2026-11-02'), exchangeRate: '84.5', items: shp.items.map((i) => ({ shipmentItemId: i.id, assessableValueInr: '100000' })) });

  const pending = await c.regulatoryClearance.findMany({ where: { shipmentId: sid } });
  await rejects(A.cust.grantOoc({ shipmentId: sid, oocNo: 'OOC-1', oocAt: day('2026-11-03'), dutyPaidAt: day('2026-11-03') }), 'PGA_PENDING', 409);
  for (const cl of pending) {
    await A.comp.resolveClearance({ shipmentId: sid, board: cl.board, action: 'SUBMIT', applicationNo: `A-${cl.board}` });
    await A.comp.resolveClearance({ shipmentId: sid, board: cl.board, action: 'APPROVE', referenceNo: `R-${cl.board}` });
  }
  await A.cust.grantOoc({ shipmentId: sid, oocNo: 'OOC-1', oocAt: day('2026-11-03'), dutyPaidAt: day('2026-11-03') });

  await A.fin.postShipmentCharge({ shipmentId: sid, component: 'CFS_CHARGES', amount: '5000', currencyCode: 'INR', isEstimated: true, incurredOn: day('2026-11-03') });
  await A.fin.recostLandedCost({ shipmentId: sid, asOf: AS_OF });
  await rejects(A.fin.finalizeLandedCost({ shipmentId: sid }), 'ESTIMATES_PENDING', 409);
  const fin = await A.fin.finalizeLandedCost({ shipmentId: sid, acceptEstimates: true });
  assert.equal(fin.status, 'FINAL');

  await A.del.startLastMile({ shipmentId: sid, startedAt: day('2026-11-04') });
  await A.del.confirmDelivery({ shipmentId: sid, deliveredAt: day('2026-11-05'), receivedBy: 'WH Ops', qualityOk: true, podUrl: 'https://files.test/pod2.pdf' });
  assert.equal((await c.shipment.findUnique({ where: { id: sid } })).status, 'DELIVERED');
  assert.deepEqual(H.db.problems, []);
});
