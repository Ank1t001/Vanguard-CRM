// The app's own session. Google's ID token (valid about an hour) is used once,
// at sign-in. After that the browser holds this signed cookie, which lasts the
// working day (SESSION_HOURS, default 12) and ends sooner after IDLE_MINUTES
// without use. It carries only an email and timestamps, nothing about leads,
// and staff access is re-checked against CRM Staff on every request.
import crypto from 'node:crypto';
import { AppError } from './errors.js';

export const COOKIE = '__Host-vg_session';

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
export const maxMs = () => Math.min(num(process.env.SESSION_HOURS, 12), 24) * 36e5;
export const idleMs = () => num(process.env.IDLE_MINUTES, 30) * 6e4;

export function secretConfigured() {
  return !!(process.env.SESSION_SECRET || process.env.CRON_SECRET);
}

function key() {
  const root = process.env.SESSION_SECRET || process.env.CRON_SECRET;
  if (!root) throw new AppError('setup', 'Sessions are not configured on the server (set SESSION_SECRET).', 500);
  return crypto.createHmac('sha256', root).update('vanguard-lead-desk/session/v1').digest();
}

const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = body => b64(crypto.createHmac('sha256', key()).update(body).digest());

function encode(p) {
  const body = b64(JSON.stringify(p));
  return `${body}.${sign(body)}`;
}

function cookieHeader(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

// Cookie for a brand new session.
export function startSession(email, now = new Date()) {
  const t = now.getTime();
  const p = { e: String(email).toLowerCase(), iat: t, la: t, exp: t + maxMs() };
  return { session: p, cookie: cookieHeader(encode(p), (p.exp - t) / 1000) };
}

// Same session with the idle clock moved to now. The hard expiry never moves.
export function touchSession(session, now = new Date()) {
  const t = now.getTime();
  const p = { ...session, la: t };
  return cookieHeader(encode(p), (p.exp - t) / 1000);
}

export const clearCookie = () => cookieHeader('', 0);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Returns the session or throws a 401 that tells the person to sign in again.
export function readSession(cookieHeaderValue, now = new Date()) {
  const raw = parseCookies(cookieHeaderValue)[COOKIE];
  if (!raw) throw new AppError('signin', 'Please sign in.', 401);
  const [body, sig] = raw.split('.');
  let p;
  try {
    const good = Buffer.from(sign(body || ''));
    const got = Buffer.from(sig || '');
    if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) throw new Error('bad signature');
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('signin', 'Please sign in.', 401);
  }
  const t = now.getTime();
  if (!p || typeof p.e !== 'string' || !p.e || !(p.exp > t) || !(p.iat <= t + 60000)) {
    throw new AppError('signin', 'Your session has ended. Please sign in again.', 401);
  }
  if (t - p.la > idleMs()) {
    throw new AppError('signin', `Signed out after ${Math.round(idleMs() / 6e4)} minutes without activity.`, 401);
  }
  return p;
}
