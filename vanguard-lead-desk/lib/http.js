// Small helpers shared by the API routes.
import { clearCookie } from './session.js';

export function parseBody(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

// The session cookie is SameSite=Strict, and on top of that a browser-sent
// Origin from another site is refused.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function sendError(res, e, { clear = false } = {}) {
  if (e && e.code && e.status) {
    if (clear && ['signin', 'not-approved'].includes(e.code)) res.setHeader('Set-Cookie', clearCookie());
    return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
  }
  console.error(e);
  return res.status(500).json({ ok: false, error: 'server', message: 'Something went wrong on the server. Try again in a moment.' });
}
