// POST /api/session  { credential }       Google sign-in -> app session cookie
// POST /api/session  { action: 'logout' } ends the session
import { login } from '../lib/crm.js';
import { startSession, clearCookie } from '../lib/session.js';
import { parseBody, sameOrigin, sendError } from '../lib/http.js';
import { AppError } from '../lib/errors.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method', message: 'Use POST.' });
  try {
    if (!sameOrigin(req)) throw new AppError('forbidden', 'That request came from another site.', 403);
    const body = parseBody(req);
    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', clearCookie());
      return res.status(200).json({ ok: true });
    }
    const { email, name } = await login(body);
    res.setHeader('Set-Cookie', startSession(email).cookie);
    return res.status(200).json({ ok: true, data: { name } });
  } catch (e) {
    return sendError(res, e);
  }
}
