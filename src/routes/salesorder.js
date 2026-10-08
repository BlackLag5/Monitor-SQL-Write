/**
 * Helipro PO -> Sales Order routes.
 *
 * Workflow: upload/parse PDF(s) -> preview (map + dry-run) -> create (execute).
 * Supports multiple PO PDFs at once: one PO -> one sales order.
 *
 *   POST /api/salesorder/parse         — multipart (field 'files' or 'file') or { text }
 *   POST /api/salesorder/preview       — resolve one PO (customer/parts/duplicate/Simulate)
 *   POST /api/salesorder/preview-batch — preview many POs at once
 *   POST /api/salesorder/create        — execute one PO
 *   POST /api/salesorder/create-batch  — execute many POs (one SO per PO)
 */
import { Router } from 'express';
import multer from 'multer';
import config, { resolveCompany } from '../config.js';
import { extractPdfText, parsePoDocuments } from '../services/poParser.js';
import { mapHeliproCode } from '../services/heliproMapping.js';
import {
  findCustomerByCode,
  findCustomerOrdersByPoNumber,
  checkCustomerOrderDuplicate,
  fetchPartsByNumber,
  fetchUnits,
  toBaseQuantity,
  buildCustomerOrderRow,
  createCustomerOrder,
} from '../services/writeback.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const DEFAULT_CUSTOMER_CODE = '300001'; // HELIPRO ENTERPRISE SDN BHD

/** Normalise the line objects coming from the UI. */
function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((l, i) => ({
      position: l.position != null ? String(l.position) : String(i + 1),
      code: String(l.code ?? l.partNumber ?? '').trim(),
      quantity: Number(l.quantity),
      price: l.price == null || l.price === '' ? null : Number(l.price),
      uom: l.uom || null,
      packInfo: l.packInfo || null,
      deliveryDate: l.deliveryDate || null,
    }))
    .filter((l) => l.code && Number.isFinite(l.quantity))
    .map((l) => ({ ...l, mappedCode: mapHeliproCode(l.code) }));
}

/** Extract plain text from one uploaded file buffer. */
async function fileToText(file) {
  const { buffer, mimetype, originalname } = file;
  const isPdf = (mimetype || '').includes('pdf') || (originalname || '').toLowerCase().endsWith('.pdf');
  if (isPdf) return extractPdfText(buffer);
  if ((mimetype || '').startsWith('text/')) return buffer.toString('utf8');
  throw new Error(`Unsupported file type "${originalname}". Upload PDFs, or paste PO text instead.`);
}

router.post('/parse', upload.any(), async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const files = Array.isArray(req.files) ? req.files : [];
    const pos = [];

    // 1. Uploaded files (multiple supported).
    for (const f of files) {
      const text = await fileToText(f);
      if (!String(text || '').trim()) {
        pos.push({
          fileName: f.originalname,
          poNumber: null,
          deliveryDate: null,
          lines: [],
          rawText: '',
          warnings: ['No extractable text found (scanned image PDF?). Paste the PO lines manually.'],
          duplicate: false,
          existingOrders: [],
        });
        continue;
      }
      const docs = parsePoDocuments(text);
      for (const d of docs) {
        pos.push({ fileName: f.originalname, ...d, duplicate: false, existingOrders: [] });
      }
    }

    // 2. Pasted text fallback (single text).
    if (!pos.length && typeof req.body?.text === 'string' && req.body.text.trim()) {
      for (const d of parsePoDocuments(req.body.text)) {
        pos.push({ fileName: null, ...d, duplicate: false, existingOrders: [] });
      }
    }

    if (!pos.length) {
      return res.status(400).json({ error: 'No files uploaded and no text provided.' });
    }

    // 3. Advisory duplicate check per PO (preview/create re-check content-aware).
    for (const p of pos) {
      if (p.poNumber && companyNumber) {
        try {
          const existingOrders = await findCustomerOrdersByPoNumber(p.poNumber, companyNumber);
          p.duplicate = existingOrders.length > 0;
          p.existingOrders = existingOrders.map((o) => ({
            id: String(o.Id),
            orderNumber: o.OrderNumber || null,
            poNumber: o.BusinessContactOrderNumber || null,
          }));
        } catch {
          // advisory only
        }
      }
    }

    res.json({ companyNumber, pos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Resolve one PO: customer, parts, conversion, duplicate check, dry-run. */
async function resolvePreview({ companyNumber, customerCode, poNumber, deliveryDate, lines }) {
  if (!poNumber) return { ok: false, status: 400, error: 'PO number is required.' };
  if (!lines.length) return { ok: false, status: 400, error: 'No order lines provided.' };

  const customer = await findCustomerByCode(customerCode, companyNumber);
  const codes = [...new Set(lines.map((l) => l.mappedCode))];
  const { resolve, byId: partById } = await fetchPartsByNumber(codes, companyNumber);
  const { byId: unitById } = await fetchUnits(companyNumber);

  const mappedLines = lines.map((l) => {
    const part = resolve(l.mappedCode);
    const conversion = toBaseQuantity(l.quantity, l.uom, l.packInfo, part, unitById);
    const payload = buildCustomerOrderRow({
      partId: part ? part.Id : null,
      orderedQuantity: conversion.quantity,
      price: l.price,
      deliveryDate: l.deliveryDate || deliveryDate,
      position: l.position,
      poNumber,
      accountId: config.monitor.salesAccountId,
    });
    return {
      position: l.position,
      code: l.code,
      mappedCode: l.mappedCode !== l.code ? l.mappedCode : null,
      partId: part ? String(part.Id) : null,
      partNumber: part ? part.PartNumber : null,
      description: part ? part.PartDescription || part.Description || null : null,
      quantity: l.quantity,
      baseQuantity: conversion.converted ? conversion.quantity : l.quantity,
      uom: conversion.uom,
      baseUnit: conversion.baseUnit,
      converted: conversion.converted,
      factor: conversion.factor ?? null,
      conversionWarning: Boolean(conversion.warning),
      price: l.price,
      deliveryDate: l.deliveryDate || deliveryDate,
      status: part ? 'ok' : 'not_found',
      payload,
    };
  });

  const summary = {
    total: mappedLines.length,
    resolved: mappedLines.filter((l) => l.status === 'ok').length,
    notFound: mappedLines.filter((l) => l.status === 'not_found').length,
  };

  // Content-aware duplicate check: same PO + exact same lines = duplicate (block).
  const duplicateEntries = mappedLines
    .filter((l) => l.status === 'ok')
    .map((l) => ({ partNumber: l.partNumber, quantity: l.baseQuantity }));
  const dup = await checkCustomerOrderDuplicate(poNumber, duplicateEntries, partById, companyNumber);
  const existingOrdersView = dup.existingOrders.map((o) => ({
    id: String(o.Id),
    orderNumber: o.OrderNumber || null,
    poNumber: o.BusinessContactOrderNumber || null,
  }));
  const duplicateOrderView = dup.duplicateOrder
    ? {
        id: String(dup.duplicateOrder.Id),
        orderNumber: dup.duplicateOrder.OrderNumber || null,
        poNumber: dup.duplicateOrder.BusinessContactOrderNumber || null,
      }
    : null;

  const headerPayload = customer
    ? {
        CustomerId: String(customer.Id),
        BusinessContactOrderNumber: poNumber ? { Value: poNumber } : null,
        Rows: mappedLines.filter((l) => l.status === 'ok').map((l) => l.payload),
      }
    : null;

  // Dry-run the full create (header + rows) in one Simulate command.
  // Skip when it's a blocking duplicate (nothing to dry-run).
  let simulation = null;
  if (!dup.duplicateOrder && customer && headerPayload && headerPayload.Rows.length) {
    try {
      const response = await createCustomerOrder(
        { customerId: customer.Id, poNumber, rows: headerPayload.Rows },
        companyNumber,
        'Simulate',
      );
      simulation = { ok: true, response };
    } catch (err) {
      simulation = { ok: false, error: err.message, code: err.code, details: err.details || null };
    }
  }

  return {
    ok: true,
    body: {
      companyNumber,
      customerCode,
      poNumber,
      deliveryDate,
      customer: customer ? { id: String(customer.Id), code: customer.Code, name: customer.Name } : null,
      duplicate: Boolean(dup.duplicateOrder),
      duplicateOrder: duplicateOrderView,
      existingOrders: existingOrdersView,
      overlappingParts: dup.overlappingParts,
      lines: mappedLines,
      headerPayload,
      simulation,
      summary,
    },
  };
}

router.post('/preview', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const poNumber = String(req.body?.poNumber || '').trim();
    const deliveryDate = req.body?.deliveryDate || null;
    const lines = normalizeLines(req.body?.lines);

    const r = await resolvePreview({ companyNumber, customerCode, poNumber, deliveryDate, lines });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r.body);
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.post('/preview-batch', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const pos = Array.isArray(req.body?.pos) ? req.body.pos : [];
    if (!pos.length) return res.status(400).json({ error: 'No POs provided.' });

    const results = [];
    for (const p of pos) {
      const poNumber = String(p.poNumber || '').trim();
      const lines = normalizeLines(p.lines);
      try {
        const r = await resolvePreview({ companyNumber, customerCode, poNumber, deliveryDate: p.deliveryDate || null, lines });
        if (!r.ok) {
          results.push({ poNumber, ok: false, status: r.status, error: r.error, lines: [], summary: { total: 0, resolved: 0, notFound: 0 }, simulation: null, customer: null, duplicate: false, duplicateOrder: null, existingOrders: [] });
        } else {
          results.push({ poNumber, ok: true, status: 200, ...r.body });
        }
      } catch (err) {
        results.push({ poNumber, ok: false, status: 500, error: err.message, lines: [], summary: { total: 0, resolved: 0, notFound: 0 }, simulation: null, customer: null, duplicate: false, duplicateOrder: null, existingOrders: [] });
      }
    }

    res.json({
      companyNumber,
      results,
      summary: { total: results.length, ready: results.filter((r) => r.ok && !r.duplicate && r.summary.notFound === 0 && r.simulation && r.simulation.ok).length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/** Execute one PO: resolve, duplicate-check, create, read back the order number. */
async function performCreate({ companyNumber, customerCode, poNumber, deliveryDate, lines }) {
  if (!poNumber) return { ok: false, status: 400, error: 'PO number is required.' };
  if (!lines.length) return { ok: false, status: 400, error: 'No order lines provided.' };

  const customer = await findCustomerByCode(customerCode, companyNumber);
  if (!customer) return { ok: false, status: 404, error: `Customer code ${customerCode} not found in company ${companyNumber}.` };

  const codes = [...new Set(lines.map((l) => l.mappedCode))];
  const { resolve, byId: partById } = await fetchPartsByNumber(codes, companyNumber);
  const { byId: unitById } = await fetchUnits(companyNumber);

  const notFound = lines.filter((l) => !resolve(l.mappedCode)).map((l) => l.code);
  if (notFound.length) {
    return { ok: false, status: 404, error: `Part numbers not found: ${notFound.join(', ')}`, notFound };
  }

  const rows = lines.map((l) => {
    const part = resolve(l.mappedCode);
    const conversion = toBaseQuantity(l.quantity, l.uom, l.packInfo, part, unitById);
    return buildCustomerOrderRow({
      partId: part.Id,
      orderedQuantity: conversion.quantity,
      price: l.price,
      deliveryDate: l.deliveryDate || deliveryDate,
      position: l.position,
      poNumber,
      accountId: config.monitor.salesAccountId,
    });
  });

  // Content-aware duplicate check: block only if an existing order under the
  // same PO has the exact same lines (same parts AND base quantities).
  const duplicateEntries = lines.map((l) => {
    const part = resolve(l.mappedCode);
    const conversion = toBaseQuantity(l.quantity, l.uom, l.packInfo, part, unitById);
    return { partNumber: part.PartNumber, quantity: conversion.quantity };
  });
  const dup = await checkCustomerOrderDuplicate(poNumber, duplicateEntries, partById, companyNumber);
  if (dup.duplicateOrder) {
    return {
      ok: false,
      status: 409,
      duplicate: true,
      duplicateOrder: { id: String(dup.duplicateOrder.Id), orderNumber: dup.duplicateOrder.OrderNumber || null },
      existingOrders: dup.existingOrders.map((o) => ({ id: String(o.Id), orderNumber: o.OrderNumber || null })),
      error: `PO ${poNumber} has already been imported with the same items as order ${dup.duplicateOrder.OrderNumber || dup.duplicateOrder.Id}.`,
    };
  }

  const result = await createCustomerOrder({ customerId: customer.Id, poNumber, rows }, companyNumber, 'execute');

  // Fetch the just-created order so we can show its order number (e.g. RSP…).
  let orderNumber = null;
  let orderId = result ? String(result.RootEntityId ?? result.EntityId ?? result.Id ?? '') : null;
  try {
    const all = await findCustomerOrdersByPoNumber(poNumber, companyNumber);
    const created = all.slice().sort((a, b) => (BigInt(a.Id) > BigInt(b.Id) ? -1 : 1))[0];
    if (created) {
      orderId = String(created.Id);
      orderNumber = created.OrderNumber || null;
    }
  } catch {
    // The command succeeded; keep whatever id we had.
  }

  return {
    ok: true,
    status: 200,
    customer: { id: String(customer.Id), code: customer.Code, name: customer.Name },
    orderId,
    orderNumber,
    duplicate: false,
    duplicateOrder: null,
    existingOrders: dup.existingOrders.map((o) => ({ id: String(o.Id), orderNumber: o.OrderNumber || null })),
    result,
    summary: { total: rows.length },
  };
}

router.post('/create', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const poNumber = String(req.body?.poNumber || '').trim();
    const deliveryDate = req.body?.deliveryDate || null;
    const lines = normalizeLines(req.body?.lines);

    const r = await performCreate({ companyNumber, customerCode, poNumber, deliveryDate, lines });
    if (!r.ok) {
      return res.status(r.status).json({
        error: r.error,
        duplicate: Boolean(r.duplicate),
        duplicateOrder: r.duplicateOrder || null,
        notFound: r.notFound || null,
      });
    }

    res.json({
      companyNumber,
      poNumber,
      customer: r.customer,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      duplicate: r.duplicate,
      existingOrders: r.existingOrders,
      result: r.result,
      summary: r.summary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.post('/create-batch', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const pos = Array.isArray(req.body?.pos) ? req.body.pos : [];
    if (!pos.length) return res.status(400).json({ error: 'No POs provided.' });

    const results = [];
    for (const p of pos) {
      const poNumber = String(p.poNumber || '').trim();
      const lines = normalizeLines(p.lines);
      try {
        const r = await performCreate({ companyNumber, customerCode, poNumber, deliveryDate: p.deliveryDate || null, lines });
        results.push({
          poNumber,
          ok: r.ok,
          status: r.status,
          orderId: r.orderId ?? null,
          orderNumber: r.orderNumber ?? null,
          duplicate: Boolean(r.duplicate),
          duplicateOrder: r.duplicateOrder || null,
          existingOrders: r.existingOrders || [],
          error: r.error || null,
        });
      } catch (err) {
        results.push({ poNumber, ok: false, status: 500, orderId: null, orderNumber: null, duplicate: false, duplicateOrder: null, existingOrders: [], error: err.message });
      }
    }

    res.json({
      companyNumber,
      results,
      summary: { total: results.length, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

export default router;
