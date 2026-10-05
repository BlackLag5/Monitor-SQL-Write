/**
 * Helipro PO item code → Monitor PartNumber lookup.
 *
 * Most Helipro POs already use our PartNumbers directly (PE…, PP…, HM…, L0175…),
 * so no mapping is needed. A few use Helipro-specific codes that must be
 * translated. Add new entries here as new codes appear.
 *
 * Sources: C:\Users\User\Documents\Metropoly\PO (sample POs, Oct 2026).
 */
const HELIPRO_CODE_MAP = {
  // Helipro code → Monitor PartNumber
  PPHOLE8120: 'PPHOLE81203', // "PP - 8"x12" 0.03mm (9 Holes)" (0.03, not 0.04)
  COURIERLA: 'COURIERLA3', // Courier Bag L (A3)
  GARMENT24: 'GARMENT2436', // Garment Cover - 24" x 36" x 0.03mm
  // LUNCHBOX3 / LRBR: "3LR Brown 3 Compartment Paper Lunch Box" — special order,
  // no matching PartNumber in Monitor yet (map manually when created).
};

/**
 * Resolve a Helipro PO item code to a Monitor PartNumber.
 * Returns the mapped PartNumber if present, otherwise the code unchanged
 * (assumed to be a direct PartNumber match).
 */
export function mapHeliproCode(code) {
  const c = String(code ?? '').trim();
  if (!c) return c;
  return HELIPRO_CODE_MAP[c] || HELIPRO_CODE_MAP[c.toUpperCase()] || c;
}

export { HELIPRO_CODE_MAP };
