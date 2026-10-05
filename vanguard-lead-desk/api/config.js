// GET /api/config  Public settings the sign-in page needs. Nothing secret here.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '', idleMinutes: Number(process.env.IDLE_MINUTES) || 30 });
}
