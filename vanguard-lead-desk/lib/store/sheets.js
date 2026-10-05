// Google Sheets data layer.
//
// This is the ONLY file that knows the data lives in a Google Sheet. The rest
// of the app talks to it through these functions:
//   context, listLeads, update, updateMany, addLead, log, activity
// Moving to Supabase later means writing lib/store/supabase.js with the same
// functions and changing one import in lib/crm.js.

import { JWT } from 'google-auth-library';
import {
  SOURCE_TABS, TAB_LOCATION, ADD_LEAD_TAB, LOCATIONS, STAGES,
  ACTIVITY_TAB, STAFF_TAB, SETTINGS_TAB, FIELD_HEADERS, defaultSettingsMap
} from '../config.js';
import { parseTs, fmtLocal } from '../tz.js';
import { AppError } from '../errors.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
let jwt;

function auth() {
  if (!jwt) {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !key || !process.env.SHEET_ID) throw new AppError('setup', 'The sheet connection is not configured on the server.', 500);
    jwt = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  }
  return jwt;
}

export async function sheetsApi(path, opts = {}) {
  const { token } = await auth().getAccessToken();
  const res = await fetch(`${SHEETS}/${process.env.SHEET_ID}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && /Unable to parse range/.test(text)) {
      throw new AppError('setup', 'A CRM tab is missing from the sheet. Run npm run setup.', 500);
    }
    throw new Error(`Sheets API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

export const quote = name => `'${String(name).replace(/'/g, "''")}'`;

export function colLetter(i) {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const READ = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';

async function batchGet(ranges) {
  const qs = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const out = await sheetsApi(`/values:batchGet?${qs}&${READ}`);
  return (out.valueRanges || []).map(v => v.values || []);
}

function headerIndex(row) {
  const idx = {};
  (row || []).forEach((h, i) => { const k = String(h).trim().toLowerCase(); if (k && !(k in idx)) idx[k] = i; });
  return idx;
}

// Stops staff text that starts with = + - @ being run as a spreadsheet formula.
function safeText(v) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtLocal(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return safeText(v);
}

/* ---------------- Settings and staff (cached briefly) ---------------- */

let ctxCache = null;
export async function context() {
  if (ctxCache && Date.now() - ctxCache.at < 30000) return ctxCache.value;
  const [settingsRows, staffRows] = await batchGet([`${quote(SETTINGS_TAB)}!A:B`, `${quote(STAFF_TAB)}!A:E`]);
  const settings = defaultSettingsMap();
  for (const r of settingsRows.slice(1)) if (r[0]) settings[String(r[0]).trim()] = r[1] === undefined ? '' : r[1];
  if (process.env.MAKE_WEBHOOK_URL) settings.MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
  const staff = staffRows.slice(1).filter(r => r[0]).map(r => {
    const loc = String(r[2] || '').trim();
    return {
      email: String(r[0]).trim().toLowerCase(),
      name: String(r[1] || '').trim() || String(r[0]).trim(),
      location: loc === 'Both' ? 'Both' : (LOCATIONS.includes(loc) ? loc : ''),
      role: String(r[3] || '').trim() || 'Staff',
      active: r[4] === true || String(r[4]).toUpperCase() === 'TRUE'
    };
  }).filter(s => s.location);
  ctxCache = { at: Date.now(), value: { settings, staff } };
  return ctxCache.value;
}

/* ---------------- Leads ---------------- */

function normPhone(v) {
  const digits = String(v ?? '').replace(/^p:/i, '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return digits ? '+' + digits : '';
}

function normLocation(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('georgetown')) return 'Georgetown';
  if (s.includes('hanover')) return 'Hanover';
  return '';
}

function prettyReason(v) {
  const s = String(v || '').trim().replace(/_/g, ' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function leadFromRow(tab, idx, row, rowNumber) {
  const g = h => { const i = idx[h.toLowerCase()]; return i === undefined ? '' : (row[i] ?? ''); };
  const f = key => g(FIELD_HEADERS[key]);
  const reasonKey = Object.keys(idx).find(k => k.startsWith('what_would_you_like'));
  const stageRaw = String(f('stage') || '');
  return {
    ref: { tab, row: rowNumber, idx },
    id: String(f('id') || ''),
    duplicateOf: String(f('duplicateOf') || ''),
    firstName: String(g('First Name') || g('first_name') || '').trim(),
    lastName: String(g('Last Name') || g('last_name') || '').trim(),
    email: String(g('Email') || g('email') || '').trim(),
    phone: normPhone(g('Phone') || g('phone_number')),
    reason: prettyReason(g('Reason') || (reasonKey ? row[idx[reasonKey]] : '')),
    source: String(g('Source') || g('source') || '').trim(),
    channel: String(g('Lead Channel') || '').trim(),
    created: parseTs(g('Timestamp')) || parseTs(g('created_time')),
    location: TAB_LOCATION[tab] || normLocation(g('Location')),
    stage: STAGES.includes(stageRaw) ? stageRaw : 'New',
    stageStored: stageRaw,
    lostReason: String(f('lostReason') || ''),
    quality: String(f('quality') || ''),
    owner: String(f('owner') || ''),
    firstOpenedAt: parseTs(f('firstOpenedAt')),
    firstOpenedBy: String(f('firstOpenedBy') || ''),
    calls: [1, 2, 3].map(n => ({
      n, at: parseTs(f(`call${n}At`)), outcome: String(f(`call${n}Outcome`) || ''), by: String(f(`call${n}By`) || '')
    })),
    contactedAt: parseTs(f('contactedAt')),
    followUp: parseTs(f('followUp')),
    appointment: parseTs(f('appointment')),
    notes: String(f('notes') || ''),
    welcomeAt: parseTs(f('welcomeAt')),
    mkt1At: parseTs(f('mkt1At')),
    mkt2At: parseTs(f('mkt2At')),
    updatedAt: parseTs(f('updatedAt')),
    updatedBy: String(f('updatedBy') || '')
  };
}

function isTest(lead, excluded) {
  if (excluded.includes(lead.email.toLowerCase())) return true;
  if (/test lead/i.test(`${lead.firstName} ${lead.lastName} ${lead.email}`)) return true;
  return !lead.firstName && !lead.lastName && !lead.phone && !lead.email;
}

export function newId(loc) {
  const rand = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return (loc === 'Hanover' ? 'HN-' : 'GT-') + rand;
}

// Every lead for one location, including untouched duplicates (crm.js decides
// what a duplicate is). Leads seen for the first time get a CRM ID written back.
export async function listLeads(loc, settings) {
  const excluded = String(settings.EXCLUDE_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const tabs = await batchGet(SOURCE_TABS.map(t => quote(t)));
  const leads = [];
  const newIds = [];
  tabs.forEach((rows, ti) => {
    const tab = SOURCE_TABS[ti];
    const idx = headerIndex(rows[0]);
    for (let r = 1; r < rows.length; r++) {
      const lead = leadFromRow(tab, idx, rows[r], r + 1);
      if (lead.location !== loc || isTest(lead, excluded)) continue;
      if (!lead.id) { lead.id = newId(loc); newIds.push({ lead, fields: { id: lead.id } }); }
      leads.push(lead);
    }
  });
  if (newIds.length) await updateMany(newIds, null);
  return leads;
}

// fields use semantic names from FIELD_HEADERS. staffName null = no audit stamp.
export async function updateMany(items, staffName) {
  const data = [];
  for (const { lead, fields } of items) {
    const all = staffName ? { ...fields, updatedAt: new Date(), updatedBy: staffName } : fields;
    for (const [key, value] of Object.entries(all)) {
      const header = FIELD_HEADERS[key];
      const col = header === undefined ? undefined : lead.ref.idx[header.toLowerCase()];
      if (col === undefined) throw new AppError('setup', `Column "${header || key}" is missing in ${lead.ref.tab}. Run npm run setup.`, 500);
      data.push({ range: `${quote(lead.ref.tab)}!${colLetter(col)}${lead.ref.row}`, values: [[cellValue(value)]] });
    }
  }
  if (!data.length) return;
  await sheetsApi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
}

export async function update(lead, fields, staffName) {
  return updateMany([{ lead, fields }], staffName);
}

export async function addLead(loc, input, staffName) {
  const tab = ADD_LEAD_TAB[loc];
  const [rows] = await batchGet([`${quote(tab)}!1:1`]);
  const headers = rows[0] || [];
  const idx = headerIndex(headers);
  const row = new Array(headers.length).fill('');
  const put = (h, v) => { const i = idx[h.toLowerCase()]; if (i !== undefined) row[i] = cellValue(v); };
  const id = newId(loc);
  const now = new Date();
  put('Timestamp', now);
  put('First Name', input.firstName);
  put('Last Name', input.lastName || '');
  put('Email', input.email || '');
  put('Phone', normPhone(input.phone));
  put('Reason', input.reason || '');
  put('Source', 'Manual: ' + (input.source || 'Other'));
  put('Location', loc);
  put('Lead Channel', 'Manual');
  put(FIELD_HEADERS.id, id);
  put(FIELD_HEADERS.stage, 'New');
  put(FIELD_HEADERS.owner, staffName);
  put(FIELD_HEADERS.updatedAt, now);
  put(FIELD_HEADERS.updatedBy, staffName);
  await sheetsApi(`/values/${encodeURIComponent(quote(tab))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: [row] })
  });
  return id;
}

/* ---------------- Activity log ---------------- */

export async function log(entries) {
  if (!entries.length) return;
  const values = entries.map(e => [fmtLocal(new Date()), e.id, e.location, e.staff, e.action, e.from || '', e.to || '', cellValue(e.detail || '')]);
  await sheetsApi(`/values/${encodeURIComponent(quote(ACTIVITY_TAB) + '!A:H')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values })
  });
}

export async function activity(id) {
  const [rows] = await batchGet([`${quote(ACTIVITY_TAB)}!A:H`]);
  return rows.slice(1).filter(r => r[1] === id).slice(-50).reverse().map(r => ({
    at: parseTs(r[0]), staff: r[3] || '', action: r[4] || '', from: r[5] || '', to: r[6] || '', detail: r[7] || ''
  }));
}
