// Phone handling shared by the sheet reader, editing and search.

// Canonical form kept in the CRM: +1XXXXXXXXXX for North American numbers.
export function normPhone(v) {
  const digits = String(v ?? '').replace(/^p:/i, '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return digits ? '+' + digits : '';
}

// Digits only, with the North American country code removed. Used for matching.
export function phoneDigits(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
}

// What someone typed into the search box: spaces, dashes, brackets, dots and a
// leading +1 are ignored. Returns null if the text is not a phone number.
export function searchDigits(text) {
  const t = String(text ?? '').trim();
  if (!t || !/^[\d\s()+.\-]+$/.test(t)) return null;
  let d = t.replace(/\D/g, '');
  if (/^\+\s*1/.test(t) || (d.length === 11 && d[0] === '1')) d = d.slice(1);
  return d;
}
