// Verifies the Google sign-in token sent with every request.
// Google's signing keys are cached by the library, so this is fast after the first call.
import { OAuth2Client } from 'google-auth-library';
import { AppError } from './errors.js';

const client = new OAuth2Client();

export async function verifyGoogleToken(token) {
  if (!token) throw new AppError('signin', 'Please sign in.', 401);
  const audience = process.env.GOOGLE_CLIENT_ID;
  if (!audience) throw new AppError('setup', 'GOOGLE_CLIENT_ID is not set on the server.', 500);
  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const p = ticket.getPayload();
    if (!p || !p.email || !p.email_verified) throw new Error('unverified');
    return String(p.email).toLowerCase();
  } catch {
    throw new AppError('signin', 'Your sign-in has expired. Please sign in again.', 401);
  }
}
