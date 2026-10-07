/**
 * Helipro PO -> Sales Order routes.
 *
 * Workflow: upload/parse PDF -> preview (map + dry-run) -> create (execute).
 *
 *   POST /api/salesorder/parse    — multipart PDF upload (field 'file') or { text }
 *   POST /api/salesorder/preview  — resolve customer/parts, duplicate check, Simulate
 *   POST /api/salesorder/create   — execute Sales/CustomerOrders/Create (with rows)
 */
import { Router } from 'express';
import multer from 'multer';
import config, { resolveCompany } from '../config.js';
import { extractPdfText, parsePoText } from '../services/poParser.js';
import { mapHeliproCode } from '../services/heliproMapping.js';
import {
  findCustomerByCode,
  findCustomerOrdersByPoNumber,
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

router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    let text = '';
    if (req.file) {
      const { buffer, mimetype, originalname } = req.file;
      const isPdf = (mimetype || '').includes('pdf') || (originalname || '').toLowerCase().endsWith('.pdf');
      if (isPdf) {
        text = await extractPdfText(buffer);
      } else if ((mimetype || '').startsWith('text/')) {
        text = buffer.toString('utf8');
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Upload a PDF, or paste PO text/JSON instead.' });
      }
    } else if (typeof req.body?.text === 'string') {
      text = req.body.text;
    } else {
      return res.status(400).json({ error: 'No file uploaded and no text provided.' });
    }

    if (!text.trim()) {
      return res.status(422).json({ error: 'No extractable text found in the document (it may be a scanned image PDF). Paste the PO lines manually.' });
    }

    const parsed = parsePoText(text);

    // Early duplicate check so the user knows immediately after parsing.
    let duplicate = false;
    let existingOrders = [];
    if (parsed.poNumber && companyNumber) {
      try {
        existingOrders = await findCustomerOrdersByPoNumber(parsed.poNumber, companyNumber);
        duplicate = existingOrders.length > 0;
      } catch {
        // Duplicate check is advisory at parse time; preview/create re-check.
      }
    }
    const existingOrdersView = existingOrders.map((o) => ({
      id: String(o.Id),
      orderNumber: o.OrderNumber || null,
      poNumber: o.BusinessContactOrderNumber || null,
    }));

    res.json({ ...parsed, companyNumber, duplicate, existingOrders: existingOrdersView });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const poNumber = String(req.body?.poNumber || '').trim();
    const deliveryDate = req.body?.deliveryDate || null;
    const lines = normalizeLines(req.body?.lines);

    if (!poNumber) {
      return res.status(400).json({ error: 'PO number is required.' });
    }
    if (!lines.length) {
      return res.status(400).json({ error: 'No order lines provided.' });
    }

    // Duplicate check (advisory only — one PO may legitimately map to several orders).
    const existingOrders = await findCustomerOrdersByPoNumber(poNumber, companyNumber);

    // Resolve customer + parts. Codes are mapped (Helipro code -> PartNumber)
    // before lookup; the original code is kept for display.
    const customer = await findCustomerByCode(customerCode, companyNumber);
    const codes = [...new Set(lines.map((l) => l.mappedCode))];
    const { resolve } = await fetchPartsByNumber(codes, companyNumber);
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

    const headerPayload = customer
      ? {
          CustomerId: String(customer.Id),
          BusinessContactOrderNumber: poNumber ? { Value: poNumber } : null,
          Rows: mappedLines.filter((l) => l.status === 'ok').map((l) => l.payload),
        }
      : null;

    // Dry-run the full create (header + rows) in one Simulate command.
    let simulation = null;
    if (customer && headerPayload && headerPayload.Rows.length) {
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

    const existingOrdersView = existingOrders.map((o) => ({
      id: String(o.Id),
      orderNumber: o.OrderNumber || null,
      poNumber: o.BusinessContactOrderNumber || null,
    }));

    res.json({
      companyNumber,
      customerCode,
      poNumber,
      deliveryDate,
      customer: customer ? { id: String(customer.Id), code: customer.Code, name: customer.Name } : null,
      duplicate: existingOrders.length > 0,
      existingOrders: existingOrdersView,
      lines: mappedLines,
      headerPayload,
      simulation,
      summary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.post('/create', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const customerCode = String(req.body?.customerCode || DEFAULT_CUSTOMER_CODE).trim();
    const poNumber = String(req.body?.poNumber || '').trim();
    const deliveryDate = req.body?.deliveryDate || null;
    const lines = normalizeLines(req.body?.lines);

    if (!poNumber) return res.status(400).json({ error: 'PO number is required.' });
    if (!lines.length) return res.status(400).json({ error: 'No order lines provided.' });

    // Advisory duplicate check — one PO may legitimately map to several orders,
    // so we do NOT hard-block here. We just report which orders already exist.
    const existingOrders = await findCustomerOrdersByPoNumber(poNumber, companyNumber);

    const customer = await findCustomerByCode(customerCode, companyNumber);
    if (!customer) return res.status(404).json({ error: `Customer code ${customerCode} not found in company ${companyNumber}.` });

    const codes = [...new Set(lines.map((l) => l.mappedCode))];
    const { resolve } = await fetchPartsByNumber(codes, companyNumber);
    const { byId: unitById } = await fetchUnits(companyNumber);

    const notFound = lines.filter((l) => !resolve(l.mappedCode)).map((l) => l.code);
    if (notFound.length) {
      return res.status(404).json({ error: `Part numbers not found: ${notFound.join(', ')}`, notFound });
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

    res.json({
      companyNumber,
      poNumber,
      customer: { id: String(customer.Id), code: customer.Code, name: customer.Name },
      orderId,
      orderNumber,
      duplicate: existingOrders.length > 0,
      existingOrders: existingOrders.map((o) => ({
        id: String(o.Id),
        orderNumber: o.OrderNumber || null,
      })),
      result,
      summary: { total: rows.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

export default router;
