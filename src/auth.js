/**
 * Authentication — mirrors the Webapp (C:\Users\User\Webapp\src\auth.js) style:
 * file-based user store, scrypt password hashing, HttpOnly session cookie.
 *
 * Simplified for this small admin tool: no roles/permissions, just users with
 * an isAdmin flag. On first start, if the store is empty, an administrator is
 * seeded from AUTH_ADMIN_USER / AUTH_ADMIN_PASSWORD.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const storePath = path.join(dataDir, 'auth.json');
const SESSION_DAYS = 7;

const scryptAsync = (password, salt, keylen) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))));

let store = null;
let writeQueue = Promise.resolve();

const emptyStore = () => ({ counters: { user: 0 }, users: [], sessions: [] });

async function persist() {
  const tmp = `${storePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmp, storePath);
}

async function mutate(fn) {
  let result;
  writeQueue = writeQueue.then(async () => {
    result = await fn(store);
    await persist();
  });
  await writeQueue;
  return result;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const cookieValue = (req) => {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)wb_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `wb_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'wb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName || null, isAdmin: !!user.isAdmin };
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  await mutate((s) => {
    s.sessions = s.sessions.filter((x) => new Date(x.expiresAt) > new Date());
    const user = s.users.find((u) => u.id === userId);
    if (user) user.lastLoginAt = new Date().toISOString();
    s.sessions.push({ tokenHash: tokenHash(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
  });
  setCookie(res, token);
}

async function loadUser(req, _res, next) {
  try {
    const token = cookieValue(req);
    if (token) {
      const session = store?.sessions?.find((x) => x.tokenHash === tokenHash(token) && new Date(x.expiresAt) > new Date());
      const user = session && store?.users?.find((u) => u.id === session.userId && u.active);
      if (user) {
        req.user = publicUser(user);
        req.sessionToken = token;
      }
    }
  } catch {
    /* ignore malformed cookies */
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Load the store and seed a first admin when empty. */
export async function initAuth() {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    store = JSON.parse(await fs.promises.readFile(storePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    store = emptyStore();
    await persist();
  }

  if (!store.users.length) {
    const username = process.env.AUTH_ADMIN_USER || 'admin';
    const password = process.env.AUTH_ADMIN_PASSWORD || 'Workbench@2026';
    const displayName = process.env.AUTH_ADMIN_DISPLAY || 'Administrator';
    await mutate(async (s) => {
      if (!s.users.length) {
        s.users.push({
          id: ++s.counters.user,
          username,
          displayName,
          passwordHash: await hashPassword(password),
          isAdmin: true,
          active: true,
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
        });
      }
    });
    console.log(`[auth] seeded admin user "${username}" (change the password via .env AUTH_ADMIN_PASSWORD)`);
  }
}

export function registerAuthRoutes(app) {
  app.get('/api/auth/status', (req, res) =>
    res.json({ setupRequired: store.users.length === 0, authenticated: !!req.user, user: req.user || null }),
  );

  app.post('/api/auth/setup', asyncRoute(async (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (store.users.length) return res.status(409).json({ error: 'Initial setup is already complete' });
    if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(String(username || ''))) return res.status(400).json({ error: 'Invalid username format' });
    if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });

    const user = await mutate(async (s) => {
      if (s.users.length) throw Object.assign(new Error('Initial setup is already complete'), { status: 409 });
      const u = {
        id: ++s.counters.user,
        username,
        displayName: displayName || null,
        passwordHash: await hashPassword(password),
        isAdmin: true,
        active: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      };
      s.users.push(u);
      return u;
    });
    await createSession(user.id, res);
    res.status(201).json({ user: publicUser(user) });
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    const user = store.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
    if (!user || !user.active || !(await verifyPassword(String(password || ''), user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await createSession(user.id, res);
    res.json({ ok: true, user: publicUser(user) });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    if (req.sessionToken) {
      await mutate((s) => {
        s.sessions = s.sessions.filter((x) => x.tokenHash !== tokenHash(req.sessionToken));
      });
    }
    clearCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));
}

export { loadUser, requireAuth, asyncRoute };
