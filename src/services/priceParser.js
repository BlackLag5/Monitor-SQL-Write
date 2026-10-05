/**
 * Price-list input parsing.
 *
 * Accepts the two real-world formats the client will throw at us:
 *  1. The Metropoly Excel dump — 2500+ lines of SQL `UPDATE st_item_uom ...`
 *     statements (one per code × UOM × rate). We extract code + refcost, pick
 *     the rate=1 (base-unit) cost as the new StandardPrice, and sanity-check
 *     that every other UOM cost = base × rate.
 *  2. Clean tab/comma/space separated text:  "PartNumber [UOM] Price".
 */
import readXlsxFile from 'read-excel-file/node';

// Matches e.g.
// update st_item_uom set refcost='80.9' where rate='10' and UOM='BDL' and code ='PE101604';
const SQL_ROW_RE =
  /refcost='([^']+)'\s*where\s+rate='([^']+)'\s+and\s+uom='([^']+)'\s+and\s+code\s*=\s*'([^']+)'/i;

const EPSILON = 0.0001;

/** Extract { code, rate, uom, cost } rows from SQL statement text. */
function extractSqlRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = SQL_ROW_RE.exec(line.trim());
    if (m) {
      rows.push({
        code: m[4].trim(),
        rate: Number.parseInt(m[2], 10),
        uom: m[3].trim(),
        cost: Number(m[1]),
      });
    }
  }
  return rows;
}

/** Collapse per-UOM rows into one item per part (base = rate 1). */
function groupByCode(rows) {
  const byCode = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.cost) || !Number.isFinite(r.rate)) continue;
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  const items = [];
  const mismatches = [];
  for (const [code, entries] of byCode) {
    const base = entries.find((e) => e.rate === 1) || entries[0];
    const units = {};
    for (const e of entries) units[`${e.uom}@${e.rate}`] = String(e.cost);

    let mismatch = false;
    for (const e of entries) {
      if (e.rate !== 1 && Math.abs(e.cost - base.cost * e.rate) > EPSILON) mismatch = true;
    }
    if (mismatch) mismatches.push(code);

    items.push({
      partNumber: code,
      price: Number(base.cost),
      uom: base.uom,
      units,
    });
  }

  return { items, mismatches };
}

/** Parse clean "PartNumber [UOM] Price" lines. */
function parseCleanLines(lines) {
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(code|part|item|part\s*number|partnumber|uom|unit|price)$/i.test(line.replace(/[\t,;]+/g, ' ').trim())) continue;

    let tokens;
    if (/[\t,;]/.test(line)) {
      tokens = line.split(/[\t,;]+/);
    } else {
      tokens = line.split(/\s{2,}/);
      if (tokens.length === 1) tokens = line.split(/\s+/);
    }
    tokens = tokens.map((t) => t.trim()).filter(Boolean);
    if (tokens.length < 2) continue;

    let priceIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (/^-?\d+(\.\d+)?$/.test(tokens[i])) {
        priceIdx = i;
        break;
      }
    }
    if (priceIdx <= 0) continue;

    const partNumber = tokens[0];
    const price = Number(tokens[priceIdx]);
    const uom = priceIdx > 1 ? tokens.slice(1, priceIdx).join(' ') : undefined;
    if (!partNumber || !Number.isFinite(price)) continue;
    items.push({ partNumber, price, uom });
  }
  return items;
}

/** Parse pasted/uploaded text (auto-detects SQL vs clean lines). */
export function parsePriceText(text) {
  const sqlRows = extractSqlRows(text);
  if (sqlRows.length) {
    const { items, mismatches } = groupByCode(sqlRows);
    return {
      format: 'sql',
      items,
      validation: { checked: sqlRows.length, parts: items.length, mismatches },
    };
  }

  const items = parseCleanLines(String(text || '').split(/\r?\n/));
  return { format: 'text', items, validation: { checked: items.length, parts: items.length, mismatches: [] } };
}

/** Parse an uploaded .xlsx buffer (cell values joined into lines). */
export async function parsePriceExcel(buffer) {
  const rows = await readXlsxFile(buffer);
  const text = rows.map((row) => row.map((c) => (c == null ? '' : String(c))).join('\t')).join('\n');
  return parsePriceText(text);
}
