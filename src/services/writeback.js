/**
 * High-level write-back operations against Monitor ERP.
 *
 * Verified payload facts (from dry-runs against the live ERP + api.monitor.se):
 * - Inventory/Parts/SetProperties:  StandardPrice is a Decimal Input -> { "Value": v }
 * - Sales/CustomerOrders/Create:    { CustomerId, Rows?: AddRow[] } — rows can be
 *                                   embedded so the whole order is one command.
 * - AddRow row:                     Price is a plain Decimal (NOT wrapped),
 *                                   OrderedQuantity plain Decimal, OrderRowType 1 = Part,
 *                                   DeliveryDate is a DateTimeOffset (ISO +offset).
 */
import config from '../config.js';
import { query, executeCommand, normalizeList, fetchAll } from './monitorApi.js';

/** Escape a value for use inside an OData $filter single-quoted literal. */
export function odataLiteral(value) {
  return String(value).replace(/'/g, "''");
}

/** Resolve a part number to its Monitor part (Id, PartNumber, StandardPrice, ...). */
export async function findPart(partNumber, companyNumber) {
  const data = await query('Inventory', 'Parts', {
    options: `$filter=PartNumber eq '${odataLiteral(partNumber)}'`,
    companyNumber,
  });
  const list = normalizeList(data);
  return list.find((p) => String(p.PartNumber) === String(partNumber)) || list[0] || null;
}

/** Resolve many part numbers at once (single paged read of all parts). */
export async function fetchPartsByNumber(partNumbers, companyNumber) {
  const wanted = new Set(partNumbers.map((n) => String(n).trim()));
  const parts = await fetchAll('Inventory', 'Parts', { companyNumber });
  const byNumber = new Map();
  const byNumberCI = new Map();
  const byId = new Map();
  for (const p of parts) {
    const n = String(p.PartNumber ?? '');
    byNumber.set(n, p);
    byId.set(String(p.Id), p);
    const ci = n.toLowerCase();
    if (!byNumberCI.has(ci)) byNumberCI.set(ci, p);
  }
  const resolve = (code) => byNumber.get(code) || byNumberCI.get(String(code).toLowerCase()) || null;
  return { parts, byNumber, byNumberCI, byId, resolve, wanted };
}

/**
 * Fetch the unit catalogue (Common/Units) and index it both by Code and Id.
 * Used to map a part's StandardUnitId to its base unit code (PCS, KG, CTN, ...).
 */
export async function fetchUnits(companyNumber) {
  const units = await fetchAll('Common', 'Units', { companyNumber });
  const byCode = new Map();
  const byId = new Map();
  for (const u of units) {
    const code = String(u.Code ?? '').toUpperCase();
    if (code && !byCode.has(code)) byCode.set(code, u);
    byId.set(String(u.Id), u);
  }
  return { units, byCode, byId };
}

/** Normalise a Helipro UOM token (e.g. "ROLL") to a Monitor unit code (e.g. "ROL"). */
export function normalizeUom(uom) {
  const u = String(uom ?? '').toUpperCase().trim();
  const aliases = { ROLL: 'ROL', CTNS: 'CTN', CARTONS: 'CTN', BAGS: 'BAG', PKTS: 'PKT', PCS: 'PCS' };
  return aliases[u] || u;
}

/**
 * Extract how many base units one order unit contains from the packaging line.
 * E.g. packInfo "500pcs (100pcs x 5pkt)" with base unit "PCS" -> 500.
 *      packInfo "20roll (20roll x 1kg)"  with base unit "KG"  -> 1.
 * Returns null when the base unit is not mentioned.
 */
export function unitsPerOrderUnit(packInfo, baseUnitCode) {
  const s = String(packInfo ?? '');
  const code = String(baseUnitCode ?? '').toUpperCase();
  if (!s || !code) return null;
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${code}\\b`, 'i');
  const m = s.match(re);
  return m ? Number(m[1]) : null;
}

/**
 * Compute the quantity expressed in the part's base unit.
 * If the PO orders in a different unit (e.g. CTN) but the part's base unit is PCS,
 * multiply by the per-order-unit factor from the packaging line when available.
 */
export function toBaseQuantity(quantity, uom, packInfo, part, unitById) {
  const baseUnit = part ? unitById.get(String(part.StandardUnitId)) : null;
  const baseCode = baseUnit ? String(baseUnit.Code ?? '').toUpperCase() : '';
  const orderCode = normalizeUom(uom);
  const qty = Number(quantity);
  if (!baseCode || orderCode === baseCode || !Number.isFinite(qty)) {
    return { quantity: qty, uom: orderCode, baseUnit: baseCode, converted: false };
  }
  const factor = unitsPerOrderUnit(packInfo, baseCode);
  if (factor && factor > 0) {
    return { quantity: qty * factor, uom: orderCode, baseUnit: baseCode, converted: true, factor };
  }
  return { quantity: qty, uom: orderCode, baseUnit: baseCode, converted: false, warning: true };
}

/** Set a part's StandardPrice. mode = 'Simulate' | 'execute'. */
export async function setStandardPrice(partId, price, companyNumber, mode) {
  return executeCommand(
    'Inventory/Parts/SetProperties',
    { PartId: String(partId), StandardPrice: { Value: Number(price) } },
    { companyNumber, mode },
  );
}

/** Resolve a customer by its ERP code (e.g. '300001'). */
export async function findCustomerByCode(code, companyNumber) {
  const data = await query('Sales', 'Customers', {
    options: `$filter=Code eq '${odataLiteral(code)}'`,
    companyNumber,
  });
  const list = normalizeList(data);
  return list.find((c) => String(c.Code) === String(code)) || list[0] || null;
}

/**
 * Duplicate check: find existing customer orders whose customer PO number
 * (BusinessContactOrderNumber) matches. Returns the order or null.
 * Note: one PO can legitimately map to several orders (split by item/delivery),
 * so prefer findCustomerOrdersByPoNumber when you need the full list.
 */
export async function findCustomerOrderByPoNumber(poNumber, companyNumber) {
  const list = await findCustomerOrdersByPoNumber(poNumber, companyNumber);
  return list[0] || null;
}

/** Return ALL customer orders matching a customer PO number (BusinessContactOrderNumber). */
export async function findCustomerOrdersByPoNumber(poNumber, companyNumber) {
  const data = await query('Sales', 'CustomerOrders', {
    options: `$filter=BusinessContactOrderNumber eq '${odataLiteral(poNumber)}'`,
    companyNumber,
  });
  const list = normalizeList(data);
  return list.filter((o) => String(o.BusinessContactOrderNumber) === String(poNumber));
}

/** Stable signature of an order's line items: sorted "partNumber:quantity" list. */
export function orderLinesSignature(entries) {
  return entries
    .filter((e) => e && e.partNumber)
    .map((e) => `${e.partNumber}:${Number(e.quantity)}`)
    .sort()
    .join('|');
}

/** Fetch the rows of several customer orders, keyed by order id. */
export async function fetchCustomerOrderRowsByOrders(orders, companyNumber) {
  const rowsByOrder = new Map();
  await Promise.all(orders.map(async (o) => {
    const data = await query('Sales', 'CustomerOrderRows', {
      options: `$filter=ParentOrderId eq '${odataLiteral(String(o.Id))}'`,
      companyNumber,
    });
    rowsByOrder.set(String(o.Id), normalizeList(data));
  }));
  return rowsByOrder;
}

/**
 * Content-aware duplicate check for a customer PO number.
 *
 * One PO can legitimately map to several orders (split by item / delivery date),
 * so we only treat it as a duplicate when an existing order under the same PO
 * contains the EXACT same line items (same part numbers AND base quantities).
 *
 * @param {string} poNumber       the customer PO number
 * @param {Array<{partNumber:string, quantity:number}>} entries incoming lines (base units)
 * @param {Map<string, object>} partById part id -> part (to resolve existing rows)
 * @returns {{existingOrders: Array, duplicateOrder: object|null, overlappingParts: string[]}}
 */
export async function checkCustomerOrderDuplicate(poNumber, entries, partById, companyNumber) {
  const existingOrders = await findCustomerOrdersByPoNumber(poNumber, companyNumber);
  if (!existingOrders.length) {
    return { existingOrders: [], duplicateOrder: null, overlappingParts: [] };
  }

  const incomingSig = orderLinesSignature(entries);
  const incomingParts = new Set(entries.map((e) => e.partNumber).filter(Boolean));
  const rowsByOrder = await fetchCustomerOrderRowsByOrders(existingOrders, companyNumber);

  let duplicateOrder = null;
  const overlappingParts = new Set();
  for (const o of existingOrders) {
    const rows = rowsByOrder.get(String(o.Id)) || [];
    const sigEntries = rows
      .filter((r) => r.PartId)
      .map((r) => ({
        partNumber: partById.get(String(r.PartId))?.PartNumber || String(r.PartId),
        quantity: Number(r.OrderedQuantity),
      }));
    if (!duplicateOrder && orderLinesSignature(sigEntries) === incomingSig) {
      duplicateOrder = o;
    }
    for (const s of sigEntries) {
      if (incomingParts.has(s.partNumber)) overlappingParts.add(s.partNumber);
    }
  }

  return { existingOrders, duplicateOrder, overlappingParts: [...overlappingParts] };
}

/** Convert a date-only or full date string to a Monitor DateTimeOffset. */
export function toDateTimeOffset(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/T|Z|\+\d{2}:\d{2}$|-\d{2}:\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`;
  return s;
}

/** Build a customer-order row payload for the AddRow command / Create.Rows. */
export function buildCustomerOrderRow({ partId, orderedQuantity, price, deliveryDate, position, poNumber, accountId }) {
  const row = {
    PartId: partId != null ? String(partId) : null,
    OrderedQuantity: Number(orderedQuantity),
    Price: price == null || price === '' ? null : Number(price),
    OrderRowType: 1, // Part
    CustomerOrderRowPosition: position != null ? String(position) : null,
  };
  const dd = toDateTimeOffset(deliveryDate);
  if (dd) row.DeliveryDate = dd;
  // Optional: inject the standard revenue account when Monitor cannot default it.
  const acct = accountId || config.monitor.salesAccountId;
  if (acct) row.CodingRows = [{ ProductGroupCodingType: 1, AccountId: String(acct) }];
  return row;
}

/**
 * Create a customer order (with optional embedded rows) in one command.
 *
 * ⚠️ Verified against live ERP: Sales/CustomerOrders/Create does NOT persist
 * BusinessContactOrderNumber (it is silently ignored, whatever shape we send).
 * The customer PO number must be written afterwards via SetProperties — so on
 * real writes we run Create, then a follow-up SetProperties for the PO number.
 *
 * mode = 'Simulate' | 'execute'.
 */
export async function createCustomerOrder({ customerId, poNumber, rows = [], accountId }, companyNumber, mode) {
  const body = { CustomerId: String(customerId) };
  if (rows.length) body.Rows = rows;
  const result = await executeCommand('Sales/CustomerOrders/Create', body, { companyNumber, mode });

  // Follow-up: persist the customer PO number (Create ignores it).
  let poResult = null;
  if (poNumber && mode === 'execute') {
    const orderId = result && (result.RootEntityId ?? result.EntityId);
    if (orderId) {
      try {
        poResult = await executeCommand('Sales/CustomerOrders/SetProperties', {
          CustomerOrderId: String(orderId),
          BusinessContactOrderNumber: { Value: poNumber },
        }, { companyNumber, mode: 'execute' });
      } catch (err) {
        poResult = { error: err.message };
      }
    }
  }

  return { ...(result || {}), poResult };
}

/**
 * Add a row to an existing customer order. mode = 'Simulate' | 'execute'.
 * (Used only if creating rows in a separate step from the header.)
 */
export async function addCustomerOrderRow(row, companyNumber, mode) {
  const { customerOrderId } = row;
  const body = buildCustomerOrderRow(row);
  body.CustomerOrderId = String(customerOrderId);
  return executeCommand('Sales/CustomerOrders/AddRow', body, { companyNumber, mode });
}
