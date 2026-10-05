// Toronto-time helpers. Vercel servers run in UTC, so every date the CRM
// reasons about (opening hours, due times, what staff type) goes through here.
import { TZ } from './config.js';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const z = n => String(n).padStart(2, '0');

export function parts(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return {
    ymd: `${o.year}-${o.month}-${o.day}`,
    y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mi: +o.minute, ss: +o.second,
    dow: DOW[o.weekday]
  };
}

// A Toronto wall-clock time as a real Date. Handles daylight saving.
export function localToDate(y, m, d, hh = 0, mi = 0, ss = 0) {
  const target = Date.UTC(y, m - 1, d, hh, mi, ss);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(t));
    t += target - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
  }
  return new Date(t);
}

export function atLocal(ymd, minutes) {
  const [y, m, d] = ymd.split('-').map(Number);
  return localToDate(y, m, d, Math.floor(minutes / 60), minutes % 60);
}

export function shiftDays(date, n) {
  const p = parts(date);
  return new Date(localToDate(p.y, p.m, p.d, 12).getTime() + n * 864e5);
}

export function fmtLocal(date) {
  const p = parts(date);
  return `${p.ymd} ${z(p.hh)}:${z(p.mi)}`;
}

// Google Sheets date serial (days since 1899-12-30, in the spreadsheet's
// time zone, which setup requires to be America/Toronto).
export function serialToDate(serial) {
  const w = new Date(Math.round((serial - 25569) * 864e5));
  return localToDate(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());
}

export function parseTs(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToDate(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return localToDate(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] || 0)); // dd/mm/yyyy, as the landing pages write it
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return localToDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); // ISO with offset, as Meta writes it
  return isNaN(d) ? null : d;
}

// Values from <input type="datetime-local"> or <input type="date">, read as Toronto time.
export function parseLocalInput(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (m) return localToDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return localToDate(+m[1], +m[2], +m[3], 10, 0);
  return undefined;
}
