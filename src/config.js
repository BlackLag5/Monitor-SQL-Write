/** Central config loaded from environment variables. */
import 'dotenv/config';

const DEFAULT_COMPANIES = [
  { number: '001.1', label: '001.1 — Metropoly Packaging (Production)' },
  { number: '001_1.1', label: '001_1.1 — Daily refresh (live copy)' },
  { number: '001_2.1', label: '001_2.1 — Training' },
  { number: '001_3.1', label: '001_3.1 — Import jobs' },
];

function parseCompanies(raw) {
  if (!raw) return DEFAULT_COMPANIES;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [number, label] = entry.split('|').map((p) => p.trim());
      return { number, label: label || number };
    });
}

const config = {
  app: {
    port: Number(process.env.PORT || 3002),
  },
  monitor: {
    host: process.env.MONITOR_HOST || '',
    port: process.env.MONITOR_PORT || '8001',
    languageCode: (process.env.MONITOR_LANGUAGE_CODE || 'en').toLowerCase(),
    companyNumber: process.env.MONITOR_COMPANY_NUMBER || '',
    companies: parseCompanies(process.env.MONITOR_COMPANIES),
    username: process.env.MONITOR_API_USER || '',
    password: process.env.MONITOR_API_PASSWORD || '',
    insecureTls: (process.env.MONITOR_INSECURE_TLS || 'true').toLowerCase() !== 'false',
    // Optional: revenue account id to inject into customer-order row coding when
    // Monitor cannot default the account ("Account required" validation error).
    salesAccountId: process.env.MONITOR_SALES_ACCOUNT_ID || '',
  },
};

export function apiBaseFor(companyNumber) {
  return `https://${config.monitor.host}:${config.monitor.port}/${config.monitor.languageCode}/${companyNumber}/api/v1`;
}

export function loginUrlFor(companyNumber) {
  return `https://${config.monitor.host}:${config.monitor.port}/${config.monitor.languageCode}/${companyNumber}/login`;
}

export function isValidCompany(number) {
  return config.monitor.companies.some((c) => c.number === number);
}

/** Resolve a company number, falling back to the configured default. */
export function resolveCompany(number) {
  const n = String(number || config.monitor.companyNumber || '').trim();
  return isValidCompany(n) ? n : config.monitor.companyNumber;
}

export default config;
