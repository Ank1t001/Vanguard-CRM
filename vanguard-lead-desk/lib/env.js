// Reads GOOGLE_PRIVATE_KEY the way it actually arrives. A paste into Vercel or
// .env often carries surrounding quotes, literal \n sequences instead of line
// breaks, or Windows line endings, and any of those makes Node fail with
// "DECODER routines::unsupported".
export function normalizePrivateKey(raw) {
  let s = String(raw ?? '').trim();
  // Strip one or more layers of matching surrounding quotes.
  while (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1).trim();
  // Literal backslash-n (and backslash-r-n) become real newlines.
  s = s.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n');
  return s.trim() ? s.trim() + '\n' : '';
}

export const privateKey = () => normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
