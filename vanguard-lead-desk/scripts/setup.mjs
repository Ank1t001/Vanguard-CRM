// One-time setup: npm run setup
// Adds the CRM columns to the three lead tabs, creates the CRM Activity,
// CRM Staff and CRM Settings tabs, and checks the sheet's time zone.
// Safe to run again: it only adds what is missing.
import { sheetsApi, quote, colLetter } from '../lib/store/sheets.js';
import {
  SOURCE_TABS, CRM_COLUMNS, ACTIVITY_TAB, STAFF_TAB, SETTINGS_TAB,
  ACTIVITY_HEADERS, STAFF_HEADERS, DEFAULT_SETTINGS, HOURS_SEED, DAYS, TZ
} from '../lib/config.js';

const meta = await sheetsApi('?fields=properties(title,timeZone),sheets(properties(sheetId,title,gridProperties))');
console.log(`Sheet: ${meta.properties.title}`);
if (meta.properties.timeZone !== TZ) {
  console.warn(`! Sheet time zone is ${meta.properties.timeZone}. Set it to ${TZ}: File > Settings > Time zone. Fixing now.`);
  await sheetsApi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ updateSpreadsheetProperties: { properties: { timeZone: TZ }, fields: 'timeZone' } }] }) });
}
const byTitle = Object.fromEntries(meta.sheets.map(s => [s.properties.title, s.properties]));

async function getRow1(tab) {
  const out = await sheetsApi(`/values/${encodeURIComponent(quote(tab) + '!1:1')}`);
  return (out.values && out.values[0]) || [];
}

// Leftover columns from an earlier attempt. "Lead Quality" would be matched
// to the CRM's "Lead quality" and carries old dropdown rules, so stop here.
const LEFTOVERS = ['call status', 'lead quality'];
for (const tab of SOURCE_TABS) {
  const lower = (await getRow1(tab)).map(h => String(h).trim().toLowerCase());
  const found = LEFTOVERS.filter(h => lower.includes(h));
  if (found.length && !lower.includes('crm id')) {
    console.error(`\n✗ ${tab} still has the old ${found.map(h => '"' + h.replace(/\b\w/g, c => c.toUpperCase()) + '"').join(' and ')} column(s).`);
    console.error('  Delete the Call Status and Lead Quality columns from all three lead tabs, then run setup again.');
    process.exit(1);
  }
}

for (const tab of SOURCE_TABS) {
  const props = byTitle[tab];
  if (!props) throw new Error(`Missing tab: ${tab}`);
  const headers = (await getRow1(tab)).map(h => String(h).trim());
  const have = new Set(headers.map(h => h.toLowerCase()));
  const missing = CRM_COLUMNS.filter(c => !have.has(c.toLowerCase()));
  if (!missing.length) { console.log(`✓ ${tab}: CRM columns present`); continue; }
  // Start after the widest row of real data, so columns with blank headers
  // but existing values are never overwritten or mislabelled.
  const all = await sheetsApi(`/values/${encodeURIComponent(quote(tab))}`);
  const widest = Math.max(headers.length, ...((all.values || []).map(r => r.length)));
  if (widest > headers.length) console.warn(`! ${tab}: columns ${colLetter(headers.length)} to ${colLetter(widest - 1)} have data but no header. CRM columns go after them.`);
  const start = widest;
  const needCols = start + missing.length - props.gridProperties.columnCount;
  if (needCols > 0) {
    await sheetsApi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ appendDimension: { sheetId: props.sheetId, dimension: 'COLUMNS', length: needCols } }] }) });
  }
  const range = `${quote(tab)}!${colLetter(start)}1:${colLetter(start + missing.length - 1)}1`;
  await sheetsApi(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [missing] }) });
  console.log(`+ ${tab}: added ${missing.length} columns (${colLetter(start)} to ${colLetter(start + missing.length - 1)})`);
}

async function ensureTab(title, rows) {
  if (byTitle[title]) { console.log(`✓ ${title} exists`); return; }
  await sheetsApi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] }) });
  await sheetsApi(`/values/${encodeURIComponent(quote(title) + '!A1')}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: rows }) });
  console.log(`+ created ${title}`);
}

await ensureTab(ACTIVITY_TAB, [ACTIVITY_HEADERS]);
await ensureTab(STAFF_TAB, [
  [...STAFF_HEADERS, '', 'Location: Georgetown, Hanover or Both. Role: Staff, Lead or Admin. Active: TRUE or FALSE. Set Active to FALSE to remove access.']
]);
const settingsRows = [['Setting', 'Value', 'What it does'], ...DEFAULT_SETTINGS.map(r => r.map(String))];
for (const key of Object.keys(HOURS_SEED)) HOURS_SEED[key].forEach((v, i) => settingsRows.push([`${key} ${DAYS[i]}`, v, 'HH:MM-HH:MM in 24h time, or Closed']));
await ensureTab(SETTINGS_TAB, settingsRows);

console.log('\nSetup complete. Next: add staff to the CRM Staff tab.');
