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
  for (const p of parts) {
    const n = String(p.PartNumber ?? '');
    byNumber.set(n, p);
    const ci = n.toLowerCase();
    if (!byNumberCI.has(ci)) byNumberCI.set(ci, p);
  }
  const resolve = (code) => byNumber.get(code) || byNumberCI.get(String(code).toLowerCase()) || null;
  return { parts, byNumber, byNumberCI, resolve, wanted };
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
 * Duplicate check: find an existing customer order whose customer PO number
 * (BusinessContactOrderNumber) matches. Returns the order or null.
 */
export async function findCustomerOrderByPoNumber(poNumber, companyNumber) {
  const data = await query('Sales', 'CustomerOrders', {
    options: `$filter=BusinessContactOrderNumber eq '${odataLiteral(poNumber)}'`,
    companyNumber,
  });
  const list = normalizeList(data);
  return list.find((o) => String(o.BusinessContactOrderNumber) === String(poNumber)) || list[0] || null;
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
    CustomerOrderNumber: poNumber || null,
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
 * The customer PO number is stored on the header as BusinessContactOrderNumber
 * (the same field the duplicate check reads). mode = 'Simulate' | 'execute'.
 */
export async function createCustomerOrder({ customerId, poNumber, rows = [], accountId }, companyNumber, mode) {
  const body = { CustomerId: String(customerId) };
  if (poNumber) body.BusinessContactOrderNumber = poNumber;
  if (rows.length) body.Rows = rows;
  return executeCommand('Sales/CustomerOrders/Create', body, { companyNumber, mode });
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
