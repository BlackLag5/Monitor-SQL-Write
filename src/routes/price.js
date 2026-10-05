/**
 * Price update routes.
 *
 * Workflow (Mr. Wong): load price list -> Verify (dry-run) -> Update (execute).
 *
 *   POST /api/price/parse   — upload .xlsx (field 'file') or { text }; returns
 *                             normalised items [{partNumber, price, uom, units}].
 *   POST /api/price/verify  — resolve parts, Simulate changes.
 *   POST /api/price/update  — execute Inventory/Parts/SetProperties.
 */
import { Router } from 'express';
import multer from 'multer';
import { resolveCompany } from '../config.js';
import { parsePriceText, parsePriceExcel } from '../services/priceParser.js';
import { fetchPartsByNumber, setStandardPrice } from '../services/writeback.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const EPSILON = 0.0001;

/** Normalise the request body into an array of { partNumber, price }. */
function extractItems(body) {
  if (Array.isArray(body.items)) {
    return body.items
      .map((it) => ({ partNumber: String(it.partNumber ?? it.code ?? '').trim(), price: Number(it.price), uom: it.uom }))
      .filter((it) => it.partNumber && Number.isFinite(it.price));
  }
  if (typeof body.text === 'string') return parsePriceText(body.text).items;
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

router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    let parsed;
    if (req.file) {
      const { buffer, originalname, mimetype } = req.file;
      const isXlsx = (mimetype || '').includes('spreadsheet') || (mimetype || '').includes('excel') || /\.xlsx?$/i.test(originalname || '');
      if (isXlsx) {
        parsed = await parsePriceExcel(buffer);
      } else {
        parsed = parsePriceText(buffer.toString('utf8'));
      }
    } else if (typeof req.body?.text === 'string') {
      parsed = parsePriceText(req.body.text);
    } else {
      return res.status(400).json({ error: 'Upload an .xlsx file or send { text }.' });
    }

    if (!parsed.items.length) {
      return res.status(422).json({ error: 'No prices found in that input. Expected SQL statements or "PartNumber Price" lines.', ...parsed });
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const companyNumber = resolveCompany(req.body?.companyNumber);
    const items = extractItems(req.body || {});
    if (!items.length) {
      return res.status(400).json({ error: 'No prices to verify. Upload/parse a price list first, or send { items: [{partNumber, price}] }.' });
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
