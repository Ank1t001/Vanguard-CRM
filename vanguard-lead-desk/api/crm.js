// POST /api/crm  { action, location, ...payload }
// Identity comes from the session cookie, never from the request body.
import { handle } from '../lib/crm.js';
import { readSession, touchSession } from '../lib/session.js';
import { parseBody, sameOrigin, sendError } from '../lib/http.js';
import { AppError } from '../lib/errors.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method', message: 'Use POST.' });
  try {
    if (!sameOrigin(req)) throw new AppError('forbidden', 'That request came from another site.', 403);
    const body = parseBody(req);
    const now = new Date();
    const session = readSession(req.headers.cookie, now);
    const data = await handle(body, { verify: async () => session.e, now: () => now });
    // Background refreshes check the session but do not count as activity, so
    // an idle screen still signs out after IDLE_MINUTES.
    if (!body.background) res.setHeader('Set-Cookie', touchSession(session, now));
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return sendError(res, e, { clear: true });
  }
}
