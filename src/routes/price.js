/**
 * Price update routes.
 *
 * Workflow (Mr. Wong): bulk input -> Verify (dry-run) -> Update (execute).
 *
 *   POST /api/price/verify  — parse bulk input, resolve parts, Simulate changes.
 *   POST /api/price/update  — execute Inventory/Parts/SetProperties.
 */
import { Router } from 'express';
import config, { resolveCompany } from '../config.js';
import { fetchPartsByNumber, setStandardPrice } from '../services/writeback.js';

const router = Router();

const EPSILON = 0.0001;

/** Parse a pasted block of "PartNumber [UOM] Price" lines into items. */
function parseBulkText(text) {
  const items = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip a header row.
    if (/^(code|part|item|part\s*number|partnumber|uom|unit|price)$/i.test(line.replace(/[\t,;]+/g, ' ').trim())) continue;

    // Prefer tab/comma/semicolon, then runs of spaces (Excel paste), then single spaces.
    let tokens;
    if (/[\t,;]/.test(line)) {
      tokens = line.split(/[\t,;]+/);
    } else {
      tokens = line.split(/\s{2,}/);
      if (tokens.length === 1) tokens = line.split(/\s+/);
    }
    tokens = tokens.map((t) => t.trim()).filter(Boolean);

    if (tokens.length < 2) continue;

    // Last numeric token = price; first token = part number; middle tokens = optional UOM.
    let priceTokenIndex = -1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (/^-?\d+(\.\d+)?$/.test(tokens[i])) {
        priceTokenIndex = i;
        break;
      }
    }
    if (priceTokenIndex <= 0) continue;

    const partNumber = tokens[0];
    const price = Number(tokens[priceTokenIndex]);
    const uom = priceTokenIndex > 1 ? tokens.slice(1, priceTokenIndex).join(' ') : undefined;
    if (!partNumber || !Number.isFinite(price)) continue;

    items.push({ partNumber, price, uom });
  }
  return items;
}

/** Normalise the request body into an array of { partNumber, price }. */
function extractItems(body) {
  if (Array.isArray(body.items)) {
    return body.items
      .map((it) => ({ partNumber: String(it.partNumber ?? it.code ?? '').trim(), price: Number(it.price) }))
      .filter((it) => it.partNumber && Number.isFinite(it.price));
  }
  if (typeof body.text === 'string') return parseBulkText(body.text);
  return [];
}

async function run(items, companyNumber, mode) {
  const codes = [...new Set(items.map((it) => it.partNumber))];
  const { resolve } = await fetchPartsByNumber(codes, companyNumber);

  const rows = [];
  let ok = 0;
  let notFound = 0;
  let unchanged = 0;
  let failed = 0;

  for (const item of items) {
    const part = resolve(item.partNumber);
    if (!part) {
      notFound += 1;
      rows.push({
        partNumber: item.partNumber,
        status: 'not_found',
        oldPrice: null,
        newPrice: item.price,
        message: 'Part number not found in Monitor',
      });
      continue;
    }

    const oldPrice = part.StandardPrice == null ? null : Number(part.StandardPrice);
    const newPrice = Number(item.price);

    if (oldPrice != null && Math.abs(oldPrice - newPrice) < EPSILON) {
      unchanged += 1;
      rows.push({
        partNumber: item.partNumber,
        partId: String(part.Id),
        description: part.PartDescription || part.Description || null,
        status: 'unchanged',
        oldPrice,
        newPrice,
        message: 'Price already correct',
      });
      continue;
    }

    try {
      await setStandardPrice(part.Id, newPrice, companyNumber, mode);
      ok += 1;
      rows.push({
        partNumber: item.partNumber,
        partId: String(part.Id),
        description: part.PartDescription || part.Description || null,
        status: 'ok',
        oldPrice,
        newPrice,
        message: mode === 'execute' ? 'Updated' : 'Dry-run OK (will update)',
      });
    } catch (err) {
      failed += 1;
      rows.push({
        partNumber: item.partNumber,
        partId: String(part.Id),
        description: part.PartDescription || part.Description || null,
        status: 'error',
        oldPrice,
        newPrice,
        message: err.message,
      });
    }
  }

  return {
    mode,
    companyNumber,
    summary: { total: items.length, ok, unchanged, notFound, failed },
    rows,
  };
}

router.post('/verify', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const items = extractItems(req.body || {});
    if (!items.length) {
      return res.status(400).json({ error: 'No valid rows. Paste "PartNumber Price" lines or send { items: [{partNumber, price}] }.' });
    }
    const result = await run(items, companyNumber, 'Simulate');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.post('/update', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const items = extractItems(req.body || {});
    if (!items.length) {
      return res.status(400).json({ error: 'No valid rows to update.' });
    }
    const result = await run(items, companyNumber, 'execute');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

export default router;
