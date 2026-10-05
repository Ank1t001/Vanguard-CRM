// POST /api/crm  { action, token, location, ...payload }
import { handle } from '../lib/crm.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method', message: 'Use POST.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const data = await handle(body);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    if (e && e.code && e.status) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server', message: 'Something went wrong on the server. Try again in a moment.' });
  }
}
