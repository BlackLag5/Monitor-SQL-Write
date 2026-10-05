/**
 * Helipro PO parsing (best-effort).
 *
 * The PO arrives as a PDF whose exact layout is not yet fixed, so this is a
 * conservative text extractor + line heuristic. The UI always shows the raw
 * extracted text and the parsed lines for manual correction before preview.
 */
import pdfParse from 'pdf-parse';

/** Extract plain text from a PDF buffer. */
export async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

const PO_NUMBER_PATTERNS = [
  /(?:purchase\s+order|p\.?\s?o\.?|po)\s*(?:no|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i,
  /(?:order|quotation|ref)\s*(?:no|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i,
];

const DATE_PATTERN = /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b|\b(\d{4}-\d{2}-\d{2})\b/g;

function looksLikePoNumber(token) {
  return /^[A-Za-z0-9][A-Za-z0-9\-\/]{2,30}$/.test(token) && /\d/.test(token);
}

/**
 * Parse raw PO text into { poNumber, deliveryDate, lines, rawText }.
 * lines: [{ position, code, quantity, price, uom }].
 */
export function parsePoText(text) {
  const rawText = String(text || '');
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1. PO number — first pattern match, else a standalone "POxxxx" token.
  let poNumber = null;
  for (const re of PO_NUMBER_PATTERNS) {
    const m = rawText.match(re);
    if (m) {
      poNumber = m[1];
      break;
    }
  }
  if (!poNumber) {
    for (const line of lines) {
      for (const token of line.split(/\s+/)) {
        if (looksLikePoNumber(token) && /^(po|sp|so|do)/i.test(token)) {
          poNumber = token;
          break;
        }
      }
      if (poNumber) break;
    }
  }

  // 2. Delivery date — pick the last date-looking token that is plausibly a future date.
  const dates = [];
  for (const m of rawText.matchAll(DATE_PATTERN)) {
    const raw = m[1] || m[2];
    const norm = normalizeDate(raw);
    if (norm) dates.push({ raw, norm });
  }
  const deliveryDate = dates.length ? dates[dates.length - 1].norm : null;

  // 3. Item lines — a code-like token followed by at least two numeric tokens
  //    (quantity and unit price). Quantity = first integer-ish number,
  //    price = first number with decimals, else the last number.
  const parsed = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const codeIdx = tokens.findIndex((t) => /^[A-Za-z][A-Za-z0-9\-\/\.]{2,}$/.test(t));
    if (codeIdx === -1) continue;

    const afterCode = tokens.slice(codeIdx + 1);
    const numbers = afterCode
      .map((t, i) => ({ value: Number(t), i }))
      .filter((n) => Number.isFinite(n.value));

    if (numbers.length < 2) continue;

    const quantity = numbers[0].value;
    const priceIdx = numbers.findIndex((n) => Number.isInteger(n.value) === false && String(afterCode[n.i]).includes('.'));
    const price = priceIdx >= 0 ? numbers[priceIdx].value : numbers[numbers.length - 1].value;

    const uom = afterCode.slice(numbers[numbers.length - 1].i + 1).find((t) => /^[A-Za-z]+$/.test(t)) || null;

    parsed.push({
      position: parsed.length + 1,
      code: tokens[codeIdx],
      quantity,
      price,
      uom,
    });
  }

  return {
    poNumber,
    deliveryDate,
    lines: parsed,
    rawText,
    warnings: parsed.length ? [] : ['No item lines could be auto-detected. Please paste or correct the lines manually.'],
  };
}

function normalizeDate(raw) {
  const s = String(raw);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let [, a, b, y] = m;
  if (y.length === 2) y = `20${y}`;
  const n1 = Number(a);
  const n2 = Number(b);
  // Disambiguate DD/MM (Malaysia default) vs MM/DD.
  let day;
  let month;
  if (n1 > 12) {
    day = n1;
    month = n2;
  } else if (n2 > 12) {
    day = n2;
    month = n1;
  } else {
    day = n1; // DD/MM/YYYY
    month = n2;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
