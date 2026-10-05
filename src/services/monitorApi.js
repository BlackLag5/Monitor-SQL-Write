/**
 * Monitor ERP API client.
 *
 * Behaviour ported from the verified middleware implementation
 * (C:\Users\User\Monitor ERP Integration\src\services\monitorApi.js) and the
 * standalone write helper (scripts\lib\monitorWrite.mjs).
 *
 * Key difference from the middleware: executeCommand() here ALLOWS mode
 * 'execute' — real writes are the whole point of this write-back app. The
 * Verify/Preview buttons use Simulate first; Update/Create use execute.
 *
 * Docs: https://api.monitor.se
 * - Login:  POST /{lang}/{company}/login  -> session id in X-Monitor-SessionId
 * - Reads:  GET  /{lang}/{company}/api/v1/{Module}/{Entity}?$filter=...
 * - Writes: POST /{lang}/{company}/api/v1/{Module}/{Entity}/{Command}[/{mode}]
 *   mode = Simulate (dry-run) | Validate (dry-run + validation) | execute (real)
 */
import https from 'node:https';
import { URL } from 'node:url';
import config, { loginUrlFor, apiBaseFor } from '../config.js';

const DEFAULT_TIMEOUT_MS = 20000;

export class MonitorApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'MonitorApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Sessions are kept per-company: the API is authenticated per-company and only
// allows one active session per user per company at a time.
const sessions = new Map();

/**
 * Raw HTTPS request helper. Uses a custom agent so we can honour the
 * self-signed certificate exception required by the Monitor ERP API.
 */
function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const agent = new https.Agent({ rejectUnauthorized: !config.monitor.insecureTls });

    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new MonitorApiError(`Monitor ERP request timed out after ${timeoutMs} ms.`, { code: 'TIMEOUT' }));
    });

    req.on('error', (err) => {
      if (err instanceof MonitorApiError) {
        reject(err);
      } else {
        reject(new MonitorApiError(`Monitor ERP request failed: ${err.message}`, { code: err.code || 'NETWORK_ERROR' }));
      }
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Authenticate against the Monitor ERP API.
 * Docs: POST /login with {"Username","Password","ForceRelogin"}; on success the
 * session id is returned in the X-Monitor-SessionId response header.
 * Returns the session id string.
 */
export async function authenticate(companyNumber = config.monitor.companyNumber, { force = true } = {}) {
  if (!config.monitor.host || !companyNumber) {
    throw new MonitorApiError('Monitor ERP is not configured (MONITOR_HOST / MONITOR_COMPANY_NUMBER missing).', {
      code: 'NOT_CONFIGURED',
    });
  }
  if (!config.monitor.username || !config.monitor.password) {
    throw new MonitorApiError('Monitor ERP credentials are missing (MONITOR_API_USER / MONITOR_API_PASSWORD).', {
      code: 'NOT_CONFIGURED',
    });
  }

  const res = await httpRequest({
    url: loginUrlFor(companyNumber),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify({
      Username: config.monitor.username,
      Password: config.monitor.password,
      ForceRelogin: force,
    }),
  });

  if (res.status === 200) {
    const json = safeJsonParse(res.body);
    // Docs: a non-null MfaToken in the body means multi-factor auth is required.
    if (json && json.MfaToken) {
      throw new MonitorApiError('This API user requires multi-factor authentication (not implemented).', {
        code: 'MFA_REQUIRED',
        status: 200,
      });
    }
    const sessionId = res.headers['x-monitor-sessionid'];
    if (!sessionId) {
      throw new MonitorApiError('Login succeeded but the X-Monitor-SessionId header was missing.', {
        code: 'NO_SESSION',
        status: 200,
      });
    }
    sessions.set(companyNumber, sessionId);
    return sessionId;
  }

  if (res.status === 403) {
    const parsed = safeJsonParse(res.body);
    const message = typeof parsed === 'string' ? parsed : res.body || 'unknown reason';
    throw new MonitorApiError(`Monitor ERP login failed (403): ${message}`, { code: 'AUTH_FAILED', status: 403 });
  }

  throw new MonitorApiError(`Monitor ERP login failed with HTTP status ${res.status}.`, {
    code: 'LOGIN_FAILED',
    status: res.status,
  });
}

async function ensureSession(companyNumber = config.monitor.companyNumber) {
  if (!sessions.has(companyNumber)) {
    await authenticate(companyNumber);
  }
  return sessions.get(companyNumber);
}

/**
 * Query the Monitor ERP API.
 * Docs: GET /{languageCode}/{companyNumber}/api/v1/{module}/{entity}/{id?}
 * with the X-Monitor-SessionId header. Supports query options ($top, $skip, ...).
 */
export async function query(module, entity, { id, options, companyNumber = config.monitor.companyNumber } = {}) {
  let path = `${apiBaseFor(companyNumber)}/${module}/${entity}`;
  if (id !== undefined && id !== null) path += `/${encodeURIComponent(id)}`;
  if (options) path += `?${options}`;

  const requestHeaders = (sid) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    'X-Monitor-SessionId': sid,
  });

  const session = await ensureSession(companyNumber);

  let res = await httpRequest({ url: path, method: 'GET', headers: requestHeaders(session) });

  // Session may have expired / been superseded; retry once after re-login.
  if (res.status === 401 || res.status === 403) {
    sessions.delete(companyNumber);
    await authenticate(companyNumber);
    res = await httpRequest({ url: path, method: 'GET', headers: requestHeaders(sessions.get(companyNumber)) });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new MonitorApiError(`Monitor ERP query failed with HTTP status ${res.status}.`, {
      code: 'QUERY_FAILED',
      status: res.status,
      details: safeJsonParse(res.body),
    });
  }

  if (res.body && res.body.trim() !== '' && safeJsonParse(res.body) === null) {
    throw new MonitorApiError('Monitor ERP returned a non-JSON response.', { code: 'INVALID_RESPONSE', status: res.status });
  }

  return safeJsonParse(res.body);
}

/**
 * Normalises whatever collection envelope the API returns into a plain array.
 * Handles the common OData-ish shapes defensively.
 */
export function normalizeList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const key of ['value', 'Values', 'items', 'Items', 'data', 'Data', 'results', 'Results', 'rows', 'Rows']) {
      if (Array.isArray(body[key])) return body[key];
    }
    // A single object (e.g. a query by id) is treated as a one-record list.
    return [body];
  }
  return [];
}

/**
 * Fetch all records of a queryable entity by paging with $top/$skip.
 */
export async function fetchAll(module, entity, { companyNumber = config.monitor.companyNumber, pageSize = 200 } = {}) {
  const items = [];
  let skip = 0;
  for (;;) {
    const data = await query(module, entity, { options: `$top=${pageSize}&$skip=${skip}`, companyNumber });
    const page = normalizeList(data);
    if (!page.length) break;
    items.push(...page);
    if (page.length < pageSize) break;
    skip += pageSize;
  }
  return items;
}

/** Parse "Module/Entity" or "Module/Entity/Command" into segments. */
export function parseEndpoint(endpoint) {
  const parts = String(endpoint || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    throw new MonitorApiError('Endpoint must look like "Module/Entity" (or "Module/Entity/Command" for writes).', {
      code: 'INVALID_ENDPOINT',
    });
  }
  return { module: parts[0], entity: parts[1], command: parts[2] };
}

/**
 * Execute a command (write) against the Monitor ERP business domain.
 * Docs: POST /{lang}/{company}/api/v1/{Module}/{Entity}/{Command} with a JSON body.
 * `mode` is 'execute' (real write), 'Simulate' (dry-run rollback) or
 * 'Validate' (dry-run + validation result).
 *
 * NOTE: unlike the middleware, this app ALLOWS 'execute'.
 */
export async function executeCommand(endpoint, body, { companyNumber = config.monitor.companyNumber, mode = 'Simulate' } = {}) {
  if (!['Simulate', 'Validate', 'execute'].includes(mode)) {
    throw new MonitorApiError(`Unknown mode "${mode}" (use Simulate, Validate or execute).`, { code: 'INVALID_MODE' });
  }

  const { module, entity, command } = parseEndpoint(endpoint);
  if (!command) {
    throw new MonitorApiError('Command endpoint must include the command name, e.g. "Sales/CustomerOrders/Create".', {
      code: 'INVALID_ENDPOINT',
    });
  }

  const suffix = mode === 'execute' ? '' : mode;
  let path = `${apiBaseFor(companyNumber)}/${module}/${entity}/${command}`;
  if (suffix) path += `/${suffix}`;

  const postHeaders = (sid) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    'X-Monitor-SessionId': sid,
  });

  const session = await ensureSession(companyNumber);

  let res = await httpRequest({ url: path, method: 'POST', headers: postHeaders(session), body: JSON.stringify(body ?? {}) });

  if (res.status === 401 || res.status === 403) {
    sessions.delete(companyNumber);
    await authenticate(companyNumber);
    res = await httpRequest({
      url: path,
      method: 'POST',
      headers: postHeaders(sessions.get(companyNumber)),
      body: JSON.stringify(body ?? {}),
    });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new MonitorApiError(`Monitor ERP command failed with HTTP status ${res.status}.`, {
      code: 'COMMAND_FAILED',
      status: res.status,
      details: safeJsonParse(res.body),
    });
  }

  return safeJsonParse(res.body);
}

/** Expose whether a session exists for the given company. */
export function hasSession(companyNumber = config.monitor.companyNumber) {
  return sessions.has(companyNumber);
}

export default {
  authenticate,
  query,
  fetchAll,
  normalizeList,
  executeCommand,
  parseEndpoint,
  hasSession,
};
