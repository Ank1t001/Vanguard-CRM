// Runs once a day (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
import { dailyJob } from '../../lib/crm.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false });
  }
  try {
    const out = await dailyJob();
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false });
  }
}
