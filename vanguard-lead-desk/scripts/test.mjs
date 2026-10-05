// npm test  Runs without Google: uses an in-memory store and a fake sign-in.
import assert from 'node:assert/strict';
import { parseTs, fmtLocal, localToDate } from '../lib/tz.js';
import { call1Due, call2Due, call3Due } from '../lib/hours.js';
import { defaultSettingsMap } from '../lib/config.js';
import { handle, dailyJob, login } from '../lib/crm.js';
import { normalizePrivateKey } from '../lib/env.js';
import { normPhone, phoneDigits, searchDigits } from '../lib/phone.js';
import { startSession, touchSession, readSession, clearCookie, COOKIE } from '../lib/session.js';
import { weekRange, mondayOf, locationReport } from '../lib/report.js';
import { leadFromRow, headerIndex } from '../lib/store/sheets.js';
import { FIELD_HEADERS, CLEARED } from '../lib/config.js';
import crmApi from '../api/crm.js';
import sessionApi from '../api/session.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓', name); };
const L = s => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [hh, mi] = t.split(':').map(Number); return localToDate(y, m, dd, hh, mi); };
const S = defaultSettingsMap();

console.log('Date parsing');
ok('Meta ISO with +0000', () => assert.equal(fmtLocal(parseTs('2026-08-31T00:09:17+0000')), '2026-08-30 20:09'));
ok('Landing page dd/mm/yyyy', () => assert.equal(fmtLocal(parseTs('22/05/2026 15:27:07')), '2026-05-22 15:27'));
ok('Sheets serial number', () => assert.equal(fmtLocal(parseTs(46300.5)), '2026-10-05 12:00'));
ok('CRM written yyyy-mm-dd HH:mm', () => assert.equal(fmtLocal(parseTs('2026-10-05 10:32')), '2026-10-05 10:32'));
ok('Empty stays null', () => assert.equal(parseTs(''), null));

console.log('Call timing (Thanksgiving Oct 12 closed)');
const cases = [
  ['GT Mon 10:00 lead', call1Due, 'Georgetown', '2026-10-05 10:00', '2026-10-05 10:30'],
  ['GT Mon 17:45, 15 min to close', call1Due, 'Georgetown', '2026-10-05 17:45', '2026-10-05 18:00'],
  ['GT Mon 17:55, 5 min to close', call1Due, 'Georgetown', '2026-10-05 17:55', '2026-10-06 09:30'],
  ['GT Mon 20:00 lead', call1Due, 'Georgetown', '2026-10-05 20:00', '2026-10-06 09:30'],
  ['GT Sat 16:00, skips Sun and Thanksgiving', call1Due, 'Georgetown', '2026-10-10 16:00', '2026-10-13 09:30'],
  ['HN Sat 16:00, Hanover opens Sunday', call1Due, 'Hanover', '2026-10-10 16:00', '2026-10-11 10:30'],
  ['GT call 2 after call 1 at 11:00', call2Due, 'Georgetown', '2026-10-05 11:00', '2026-10-05 14:00'],
  ['GT call 2 after call 1 at 16:00', call2Due, 'Georgetown', '2026-10-05 16:00', '2026-10-06 10:00'],
  ['HN call 2 after Sat 13:00', call2Due, 'Hanover', '2026-10-10 13:00', '2026-10-11 11:00'],
  ['GT call 3 after Fri call 2', call3Due, 'Georgetown', '2026-10-09 15:00', '2026-10-10 15:00']
];
for (const [name, fn, loc, input, expected] of cases) ok(name, () => assert.equal(fmtLocal(fn(S, loc, L(input))), expected));

console.log('Funnel flow');
const blankCalls = () => [1, 2, 3].map(n => ({ n, at: null, outcome: '', by: '' }));
const lead = (id, loc, extra = {}) => ({
  ref: {}, id, duplicateOf: '', firstName: 'Test', lastName: id, email: `${id}@example.com`, phone: '+1289555' + id.slice(-4),
  reason: 'Register as a new patient', source: 'Meta', channel: '', created: L('2026-10-05 10:00'), location: loc,
  stage: 'New', stageStored: '', lostReason: '', quality: '', owner: '', firstOpenedAt: null, firstOpenedBy: '',
  calls: blankCalls(), contactedAt: null, followUp: null, appointment: null, notes: '', welcomeAt: null, mkt1At: null, mkt2At: null,
  updatedAt: null, updatedBy: '', assignedAt: null, campaign: '', detailsEdited: false, ...extra
});
const withOriginal = l => { l.original = { firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone }; return l; };
const db = {
  leads: [lead('GT-0001', 'Georgetown'), lead('GT-0002', 'Georgetown'), lead('HN-0001', 'Hanover'),
    lead('GT-0003', 'Georgetown', { phone: '+12895550001', created: L('2026-10-06 09:00') })].map(withOriginal), // GT-0003 duplicates GT-0001 by phone
  unassigned: [], updates: [], logs: [], writes: 0
};
const staffList = [
  { email: 'priya@x.ca', name: 'Priya', location: 'Georgetown', role: 'Staff', active: true },
  { email: 'old@x.ca', name: 'Old', location: 'Georgetown', role: 'Staff', active: false },
  { email: 'boss@x.ca', name: 'Boss', location: 'Both', role: 'Admin', active: true },
  { email: 'lead@x.ca', name: 'Lena', location: 'Georgetown', role: 'Lead', active: true },
  { email: 'hn@x.ca', name: 'Hana', location: 'Hanover', role: 'Staff', active: true },
  { email: 'gone@x.ca', name: 'Gone', location: 'Georgetown', role: 'Staff', active: false }
];
const store = {
  context: async () => ({ settings: S, staff: staffList }),
  listLeads: async loc => db.leads.filter(l => l.location === loc),
  updateMany: async items => { db.writes += items.length; },
  listUnassigned: async () => db.unassigned.filter(l => !l.location),
  update: async (l, fields) => {
    db.writes++; db.updates.push({ id: l.id, fields });
    if (fields.location) { l.location = fields.location; l.assignedAt = fields.assignedAt; db.leads.push(l); } // what the sheet row would now say
  },
  addLead: async (loc, input) => { const id = 'GT-NEW1'; db.leads.push(withOriginal(lead(id, loc, { firstName: input.firstName, created: new Date() }))); return id; },
  log: async e => { db.logs.push(...e); },
  activity: async id => db.logs.filter(e => e.id === id).map(e => ({ at: new Date(), ...e }))
};
let clock = L('2026-10-05 10:10');
const deps = { store, verify: async t => t, now: () => clock };
const call = (token, action, extra) => handle({ token, action, ...extra }, deps);

const rejects = async (p, code) => { try { await p; assert.fail('expected rejection'); } catch (e) { assert.equal(e.code, code, e.message); } };
await rejects(call('nobody@x.ca', 'list'), 'not-approved'); ok('Unknown email refused', () => {});
await rejects(call('old@x.ca', 'list'), 'not-approved'); ok('Inactive staff refused', () => {});

let r = await call('priya@x.ca', 'list');
ok('Georgetown staff see only Georgetown', () => assert.ok(r.leads.every(l => l.id.startsWith('GT-'))));
ok('Duplicate folded into original', () => {
  assert.ok(!r.leads.find(l => l.id === 'GT-0003'));
  assert.equal(r.leads.find(l => l.id === 'GT-0001').submissions, 2);
});
await rejects(call('priya@x.ca', 'open', { id: 'HN-0001' }), 'not-found'); ok('Cannot open the other site\'s lead', () => {});
r = await call('boss@x.ca', 'list', { location: 'Hanover' });
ok('Both-location admin can switch', () => assert.ok(r.leads.every(l => l.id.startsWith('HN-'))));

r = await call('priya@x.ca', 'open', { id: 'GT-0001' });
ok('Opening stamps first opened', () => { assert.equal(r.lead.firstOpenedBy, 'Priya'); assert.ok(r.lead.firstOpenedAt); });

r = await call('priya@x.ca', 'dial', { id: 'GT-0001' });
ok('Tapping the number stamps call 1 time', () => assert.ok(r.lead.calls[0].at));

r = await call('priya@x.ca', 'logCall', { id: 'GT-0001', call: 1, outcome: 'No answer' });
ok('Call 1 no answer -> Calling, call 2 due 3h later', () => {
  assert.equal(r.lead.stage, 'Calling');
  assert.equal(fmtLocal(new Date(r.lead.nextDue)), '2026-10-05 13:10');
});
await rejects(call('priya@x.ca', 'logCall', { id: 'GT-0001', call: 1, outcome: 'No answer' }), 'conflict');
ok('Logging the same call twice is blocked', () => {});

clock = L('2026-10-05 13:00');
r = await call('priya@x.ca', 'logCall', { id: 'GT-0001', call: 2, outcome: 'Voicemail left' });
ok('Call 2 -> call 3 due next business day', () => assert.equal(fmtLocal(new Date(r.lead.nextDue)), '2026-10-06 18:00'));
clock = L('2026-10-06 11:00');
r = await call('priya@x.ca', 'logCall', { id: 'GT-0001', call: 3, outcome: 'No answer' });
ok('Call 3 no answer -> Marketing only', () => { assert.equal(r.lead.stage, 'Marketing only'); assert.equal(r.lead.nextDue, null); });

await rejects(call('priya@x.ca', 'update', { id: 'GT-0001', fields: { stage: 'Booked', appointment: '2026-10-07T10:00' } }), 'bad-request');
ok('Marketing only cannot jump to Booked', () => {});
r = await call('priya@x.ca', 'update', { id: 'GT-0001', fields: { stage: 'Contacted' } });
ok('They replied -> back to Contacted', () => assert.equal(r.lead.stage, 'Contacted'));

r = await call('priya@x.ca', 'logCall', { id: 'GT-0002', call: 1, outcome: 'Spoke to them' });
ok('Spoke to them -> Contacted', () => assert.equal(r.lead.stage, 'Contacted'));
await rejects(call('priya@x.ca', 'update', { id: 'GT-0002', fields: { stage: 'Lost' } }), 'bad-request');
ok('Lost requires a reason', () => {});
await rejects(call('priya@x.ca', 'update', { id: 'GT-0002', fields: { stage: 'Booked' } }), 'bad-request');
ok('Booked requires a date', () => {});
r = await call('priya@x.ca', 'update', { id: 'GT-0002', fields: { stage: 'Booked', appointment: '2026-10-07T10:00', quality: 'Good', note: '=SUM(A1) family of four' } });
ok('Booked with date, quality and note', () => {
  assert.equal(r.lead.stage, 'Booked');
  assert.equal(fmtLocal(new Date(r.lead.appointment)), '2026-10-07 10:00');
  assert.equal(r.lead.quality, 'Good');
  assert.match(r.lead.notes, /Priya: =SUM\(A1\) family of four$/);
});
r = await call('priya@x.ca', 'update', { id: 'GT-0002', fields: { appointment: '2026-10-08T11:00' } });
ok('Intake moved without changing stage', () => assert.equal(fmtLocal(new Date(r.lead.appointment)), '2026-10-08 11:00'));
r = await call('priya@x.ca', 'update', { id: 'GT-0002', fields: { stage: 'Registered' } });
ok('Booked -> Registered', () => assert.equal(r.lead.stage, 'Registered'));

r = await call('priya@x.ca', 'addLead', { lead: { firstName: 'Walk', phone: '289 555 0199', source: 'Walk-in' } });
ok('Manual lead added as New', () => assert.equal(r.lead.stage, 'New'));
await rejects(call('priya@x.ca', 'addLead', { lead: { firstName: 'NoContact' } }), 'bad-request');
ok('Manual lead needs phone or email', () => {});

ok('Every action wrote to the activity log', () => assert.ok(db.logs.length >= 10));
const out = await dailyJob({ store, now: () => L('2026-10-20 10:00') });
ok('Daily job runs (no webhook set, so nothing sent)', () => assert.equal(out.sent, 0));


/* ================= Hardening, sessions and the six features ================= */
const throws = (fn, code) => { try { fn(); assert.fail('expected throw'); } catch (e) { assert.equal(e.code, code, e.message); } };

console.log('GOOGLE_PRIVATE_KEY hardening');
const PEM = '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n';
ok('Real newlines pass through', () => assert.equal(normalizePrivateKey(PEM), PEM));
ok('Literal \\n becomes newlines', () => assert.equal(normalizePrivateKey(PEM.replace(/\n/g, '\\n')), PEM));
ok('Surrounding double quotes stripped', () => assert.equal(normalizePrivateKey('"' + PEM.replace(/\n/g, '\\n') + '"'), PEM));
ok('Surrounding single quotes and spaces stripped', () => assert.equal(normalizePrivateKey("  '" + PEM.replace(/\n/g, '\\n') + "'  "), PEM));
ok('Doubly quoted, with CRLF and escaped CRLF', () => {
  assert.equal(normalizePrivateKey('"\'' + PEM.replace(/\n/g, '\r\n') + '\'"'), PEM);
  assert.equal(normalizePrivateKey(PEM.replace(/\n/g, '\\r\\n')), PEM);
});
ok('Empty or missing key stays empty', () => { assert.equal(normalizePrivateKey(''), ''); assert.equal(normalizePrivateKey(undefined), ''); assert.equal(normalizePrivateKey('""'), ''); });

console.log('Sessions');
process.env.SESSION_SECRET = 'test-secret-for-sessions';
process.env.IDLE_MINUTES = '30';
delete process.env.SESSION_HOURS;
const T0 = L('2026-10-05 08:00');
const cookieValue = c => c.split(';')[0].slice(COOKIE.length + 1);
const asCookie = c => `${COOKIE}=${cookieValue(c)}`;
const started = startSession('Priya@X.ca', T0);
ok('Cookie is HttpOnly, Secure, SameSite=Strict, host-only, 12 hours', () => {
  const c = started.cookie;
  assert.ok(c.startsWith('__Host-vg_session='));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(c.includes(a), a);
  assert.ok(!/Domain=/i.test(c));
});
ok('Cookie carries only an email and timestamps', () => {
  const payload = JSON.parse(Buffer.from(cookieValue(started.cookie).split('.')[0], 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['e', 'exp', 'iat', 'la']);
  assert.equal(payload.e, 'priya@x.ca');
});
const at = min => new Date(T0.getTime() + min * 6e4);
ok('Session valid straight away and at 29 minutes', () => {
  assert.equal(readSession(asCookie(started.cookie), at(0)).e, 'priya@x.ca');
  assert.equal(readSession(asCookie(started.cookie), at(29)).e, 'priya@x.ca');
});
ok('Idle for 31 minutes signs out', () => throws(() => readSession(asCookie(started.cookie), at(31)), 'signin'));
ok('Activity keeps a session alive past the idle limit', () => {
  let c = started.cookie;
  for (let m = 20; m <= 600; m += 20) { const sess = readSession(asCookie(c), at(m)); c = touchSession(sess, at(m)); }
  assert.equal(readSession(asCookie(c), at(610)).e, 'priya@x.ca'); // 10 hours in, still the same session
});
ok('Hard expiry at 12 hours even when active', () => {
  let c = started.cookie;
  for (let m = 20; m <= 700; m += 20) { const sess = readSession(asCookie(c), at(m)); c = touchSession(sess, at(m)); }
  throws(() => readSession(asCookie(c), at(721)), 'signin');
});
ok('A refreshed cookie never extends the 12 hour limit', () => {
  const mid = touchSession(started.session, at(590)); // last activity at 9h50
  const sess = readSession(asCookie(mid), at(600));
  assert.equal(sess.exp, started.session.exp);
  assert.ok(touchSession(sess, at(600)).includes('Max-Age=7200'));
});
ok('Tampered, truncated, unsigned and missing cookies are refused', () => {
  const [body, sig] = cookieValue(started.cookie).split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'boss@x.ca', iat: T0.getTime(), la: T0.getTime(), exp: T0.getTime() + 36e5 })).toString('base64url');
  throws(() => readSession(`${COOKIE}=${forged}.${sig}`, at(1)), 'signin');
  throws(() => readSession(`${COOKIE}=${body}`, at(1)), 'signin');
  throws(() => readSession(`${COOKIE}=${body}.${sig.slice(0, -2)}xx`, at(1)), 'signin');
  throws(() => readSession(`${COOKIE}=garbage`, at(1)), 'signin');
  throws(() => readSession('', at(1)), 'signin');
});
ok('A session signed with another secret is refused', () => {
  const c = asCookie(started.cookie);
  process.env.SESSION_SECRET = 'a-different-secret';
  throws(() => readSession(c, at(1)), 'signin');
  process.env.SESSION_SECRET = 'test-secret-for-sessions';
});
ok('SESSION_HOURS and IDLE_MINUTES are honoured', () => {
  process.env.SESSION_HOURS = '8'; process.env.IDLE_MINUTES = '10';
  const s2 = startSession('a@x.ca', T0);
  assert.ok(s2.cookie.includes('Max-Age=28800'));
  throws(() => readSession(asCookie(s2.cookie), at(11)), 'signin');
  delete process.env.SESSION_HOURS; process.env.IDLE_MINUTES = '30';
});
ok('No secret configured -> clear server error, no session', () => {
  const keep = [process.env.SESSION_SECRET, process.env.CRON_SECRET];
  delete process.env.SESSION_SECRET; delete process.env.CRON_SECRET;
  throws(() => startSession('a@x.ca', T0), 'setup');
  [process.env.SESSION_SECRET] = keep; if (keep[1]) process.env.CRON_SECRET = keep[1];
});
ok('CRON_SECRET is used when SESSION_SECRET is not set', () => {
  const a = process.env.SESSION_SECRET; delete process.env.SESSION_SECRET; process.env.CRON_SECRET = 'cron-secret';
  const c = startSession('a@x.ca', T0).cookie;
  assert.equal(readSession(asCookie(c), at(1)).e, 'a@x.ca');
  delete process.env.CRON_SECRET; process.env.SESSION_SECRET = a;
});
ok('Logout cookie expires immediately', () => assert.ok(clearCookie().includes('Max-Age=0')));

// A minimal request/response pair for the API routes.
const fakeRes = () => { const r = { headers: {}, code: 200, json(b) { r.body = b; return r; }, status(c) { r.code = c; return r; }, setHeader(k, v) { r.headers[k] = v; } }; return r; };
const hit = async (fn, req) => { const res = fakeRes(); await fn({ method: 'POST', headers: {}, body: {}, ...req }, res); return res; };
let res = await hit(crmApi, { body: { action: 'me' } });
ok('API: no cookie -> 401', () => { assert.equal(res.code, 401); assert.equal(res.body.error, 'signin'); });
res = await hit(crmApi, { body: { action: 'me', token: 'priya@x.ca' } });
ok('API: a token in the body is not an identity', () => assert.equal(res.code, 401));
res = await hit(crmApi, { headers: { cookie: asCookie(started.cookie), origin: 'https://evil.example', host: 'vanguard-lead-desk.vercel.app' }, body: { action: 'me' } });
ok('API: request from another origin refused', () => assert.equal(res.code, 403));
res = await hit(crmApi, { headers: { cookie: `${COOKIE}=bad.bad` }, body: { action: 'me' } });
ok('API: bad cookie is cleared', () => { assert.equal(res.code, 401); assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0')); });
res = await hit(crmApi, { method: 'GET' });
ok('API: GET refused', () => assert.equal(res.code, 405));
res = await hit(sessionApi, { body: { action: 'logout' } });
ok('API: logout clears the cookie', () => { assert.equal(res.code, 200); assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0')); });
res = await hit(sessionApi, { headers: { origin: 'https://evil.example', host: 'vanguard-lead-desk.vercel.app' }, body: { credential: 'x' } });
ok('API: sign-in from another origin refused', () => assert.equal(res.code, 403));

const loginDeps = { store, verify: async c => c };
let who = await login({ credential: 'priya@x.ca' }, loginDeps);
ok('Sign-in for approved staff returns their name', () => assert.equal(who.name, 'Priya'));
await rejects(login({ credential: 'nobody@x.ca' }, loginDeps), 'not-approved'); ok('Sign-in for someone not on CRM Staff is refused', () => {});
await rejects(login({ credential: 'old@x.ca' }, loginDeps), 'not-approved'); ok('Sign-in for inactive staff is refused', () => {});

console.log('Staff are re-checked on every request');
r = await call('gone@x.ca', 'me').catch(e => e);
ok('Inactive from the start: refused', () => assert.equal(r.code, 'not-approved'));
staffList.push({ email: 'temp@x.ca', name: 'Temp', location: 'Georgetown', role: 'Staff', active: true });
r = await call('temp@x.ca', 'list');
ok('Active staff member works with a valid session', () => assert.ok(r.leads.length > 0));
staffList.find(s => s.email === 'temp@x.ca').active = false; // unticking Active in the sheet
await rejects(call('temp@x.ca', 'list'), 'not-approved');
ok('Unticking Active locks the person out on the very next request', () => {});
ok('Sessions hold no role or location, only an email', () => assert.ok(!('role' in started.session) && !('location' in started.session)));

console.log('Search');
ok('searchDigits ignores spaces, dashes, brackets and +1', () => {
  for (const q of ['289 555 0199', '289-555-0199', '(289) 555-0199', '+1 289 555 0199', '+1 (289) 555-0199', '1-289-555-0199', '2895550199', '289.555.0199'])
    assert.equal(searchDigits(q), '2895550199', q);
  assert.equal(searchDigits('555-0199'), '5550199');
  assert.equal(searchDigits('priya'), null);
  assert.equal(searchDigits('a@b.ca'), null);
});
ok('phoneDigits and normPhone agree', () => { assert.equal(phoneDigits('+12895550199'), '2895550199'); assert.equal(normPhone('(289) 555-0199'), '+12895550199'); });

db.leads.push(withOriginal(lead('GT-0050', 'Georgetown', { firstName: 'Zoë', lastName: "O'Brien", email: 'zoe.obrien@example.com', phone: '+12895550199', stage: 'Lost', stageStored: 'Lost', lostReason: 'Not interested', created: L('2026-07-01 09:00') })));
db.leads.push(withOriginal(lead('HN-0050', 'Hanover', { firstName: 'Zoë', lastName: 'Hanover', email: 'zoe.h@example.com', phone: '+12895550199' })));
for (const q of ['289 555 0199', '(289) 555-0199', '+1 289-555-0199', '1 289 555 0199', '555-0199', '5550199']) {
  r = await call('priya@x.ca', 'search', { q });
  ok(`Phone search "${q}"`, () => assert.deepEqual(r.leads.map(l => l.id), ['GT-0050']));
}
r = await call('priya@x.ca', 'search', { q: 'brien' });
ok('Name search finds a Lost lead (all stages)', () => assert.deepEqual(r.leads.map(l => l.id), ['GT-0050']));
r = await call('priya@x.ca', 'search', { q: 'zoë o\'brien' });
ok('Multi-word name search, any order of case', () => assert.equal(r.leads[0].id, 'GT-0050'));
r = await call('priya@x.ca', 'search', { q: 'ZOE.OBRIEN@example' });
ok('Email search, case-insensitive', () => assert.deepEqual(r.leads.map(l => l.id), ['GT-0050']));
r = await call('priya@x.ca', 'search', { q: 'Zoë' });
ok('Search never returns the other site\'s leads', () => assert.ok(r.leads.every(l => l.id.startsWith('GT-')) && !r.leads.some(l => l.id === 'HN-0050')));
r = await call('boss@x.ca', 'search', { q: 'Zoë', location: 'Hanover' });
ok('Admin on Hanover searches Hanover only', () => assert.deepEqual(r.leads.map(l => l.id), ['HN-0050']));
await rejects(call('priya@x.ca', 'search', { q: 'a' }), 'bad-request'); ok('One letter is too short', () => {});
await rejects(call('priya@x.ca', 'search', { q: '28' }), 'bad-request'); ok('Two digits is too short for a phone search', () => {});
r = await call('priya@x.ca', 'search', { q: 'nobody-by-this-name' });
ok('No match returns an empty list', () => { assert.equal(r.leads.length, 0); assert.equal(r.total, 0); });
const hiddenSettings = { ...S, SHOW_LEADS_FROM: '2026-10-01' };
const hiddenStore = { ...store, context: async () => ({ settings: hiddenSettings, staff: staffList }) };
r = await handle({ token: 'priya@x.ca', action: 'list' }, { ...deps, store: hiddenStore });
const hiddenList = r.leads.map(l => l.id);
db.leads.push(withOriginal(lead('GT-0051', 'Georgetown', { firstName: 'Oldtimer', created: L('2026-07-02 09:00') })));
r = await handle({ token: 'priya@x.ca', action: 'list' }, { ...deps, store: hiddenStore });
const hiddenList2 = r.leads.map(l => l.id);
r = await handle({ token: 'priya@x.ca', action: 'search', q: 'oldtimer' }, { ...deps, store: hiddenStore });
ok('Search still finds untouched old leads hidden from the queue by SHOW_LEADS_FROM', () => { assert.ok(!hiddenList2.includes('GT-0051')); assert.deepEqual(r.leads.map(l => l.id), ['GT-0051']); });

console.log('Unassigned queue (Admin)');
const web = (id, extra = {}) => withOriginal(lead(id, '', { firstName: 'Web', lastName: id, ...extra }));
db.unassigned = [web('WB-0001', { created: L('2026-10-05 07:00') }), web('WB-0002', { created: L('2026-10-05 08:30') })];
await rejects(call('priya@x.ca', 'unassigned'), 'forbidden'); ok('Staff cannot see the unassigned queue', () => {});
await rejects(call('lead@x.ca', 'unassigned'), 'forbidden'); ok('Lead role cannot see the unassigned queue', () => {});
await rejects(call('priya@x.ca', 'assign', { id: 'WB-0001', to: 'Hanover' }), 'forbidden'); ok('Staff cannot assign', () => {});
r = await call('boss@x.ca', 'unassigned');
ok('Admin sees Website Leads rows with no location, oldest first', () => assert.deepEqual(r.leads.map(l => l.id), ['WB-0001', 'WB-0002']));
const gtBefore = (await call('priya@x.ca', 'list')).leads.map(l => l.id);
ok('Not in Georgetown before assigning', () => assert.ok(!gtBefore.includes('WB-0001')));
await rejects(call('boss@x.ca', 'assign', { id: 'WB-0001', to: 'Toronto' }), 'bad-request'); ok('Only Georgetown or Hanover accepted', () => {});
clock = L('2026-10-05 14:00');
r = await call('boss@x.ca', 'assign', { id: 'WB-0001', to: 'Georgetown' });
const w = db.updates.at(-1);
ok('Assigning writes the Location column and an assigned-at time', () => { assert.equal(w.id, 'WB-0001'); assert.equal(w.fields.location, 'Georgetown'); assert.equal(fmtLocal(w.fields.assignedAt), '2026-10-05 14:00'); });
ok('Assignment is logged in CRM Activity', () => {
  const e = db.logs.filter(x => x.id === 'WB-0001').at(-1);
  assert.equal(e.action, 'Assigned to location'); assert.equal(e.to, 'Georgetown'); assert.equal(e.staff, 'Boss');
});
r = await call('priya@x.ca', 'list');
const assigned = r.leads.find(l => l.id === 'WB-0001');
ok('Assigned lead now shows in Georgetown', () => assert.ok(assigned));
ok('Call 1 clock starts at assignment (14:00 + 30 min), not at the 07:00 arrival', () => assert.equal(fmtLocal(new Date(assigned.nextDue)), '2026-10-05 14:30'));
r = await call('boss@x.ca', 'unassigned');
ok('Assigned lead leaves the unassigned queue', () => assert.deepEqual(r.leads.map(l => l.id), ['WB-0002']));
await rejects(call('boss@x.ca', 'assign', { id: 'WB-0001', to: 'Hanover' }), 'not-found'); ok('A lead cannot be assigned twice', () => {});
clock = L('2026-10-05 20:00');
await call('boss@x.ca', 'assign', { id: 'WB-0002', to: 'Hanover' });
r = await call('boss@x.ca', 'list', { location: 'Hanover' });
ok('Assigned after hours: clock starts next time Hanover opens', () => assert.equal(fmtLocal(new Date(r.leads.find(l => l.id === 'WB-0002').nextDue)), '2026-10-06 09:30'));
clock = L('2026-10-05 10:10');

console.log('Reassign');
const gt1 = (await call('priya@x.ca', 'open', { id: 'GT-0050' }));
ok('Staff do not get a reassign list', () => assert.deepEqual(gt1.team, []));
r = await call('lead@x.ca', 'open', { id: 'GT-0050' });
ok('Lead gets active staff for this location only (no Hanover-only, no inactive)', () => {
  const emails = r.team.map(t => t.email).sort();
  assert.deepEqual(emails, ['boss@x.ca', 'lead@x.ca', 'priya@x.ca']);
});
await rejects(call('priya@x.ca', 'reassign', { id: 'GT-0050', to: 'lena@x.ca' }), 'forbidden'); ok('Staff cannot reassign', () => {});
await rejects(call('lead@x.ca', 'reassign', { id: 'GT-0050', to: 'hn@x.ca' }), 'bad-request'); ok('Cannot reassign to someone at the other site', () => {});
await rejects(call('lead@x.ca', 'reassign', { id: 'GT-0050', to: 'gone@x.ca' }), 'bad-request'); ok('Cannot reassign to inactive staff', () => {});
await rejects(call('lead@x.ca', 'reassign', { id: 'GT-0050', to: 'nobody@x.ca' }), 'bad-request'); ok('Cannot reassign to someone not on CRM Staff', () => {});
await rejects(call('lead@x.ca', 'reassign', { id: 'HN-0050', to: 'priya@x.ca' }), 'not-found'); ok('Cannot reassign the other site\'s lead', () => {});
r = await call('lead@x.ca', 'reassign', { id: 'GT-0050', to: 'priya@x.ca' });
ok('Lead can reassign to an active Georgetown staff member', () => assert.equal(r.lead.owner, 'Priya'));
ok('Reassignment writes the Owner and is logged with from and to', () => {
  assert.deepEqual(db.updates.at(-1), { id: 'GT-0050', fields: { owner: 'Priya' } });
  const e = db.logs.filter(x => x.id === 'GT-0050').at(-1);
  assert.equal(e.action, 'Reassigned'); assert.equal(e.from, 'Unassigned'); assert.equal(e.to, 'Priya'); assert.equal(e.staff, 'Lena');
});
await rejects(call('lead@x.ca', 'reassign', { id: 'GT-0050', to: 'priya@x.ca' }), 'bad-request'); ok('Reassigning to the current owner is refused', () => {});
r = await call('boss@x.ca', 'reassign', { id: 'GT-0050', to: 'lead@x.ca' });
ok('Admin can reassign, and Both-location staff are eligible anywhere', () => assert.equal(r.lead.owner, 'Lena'));
r = await call('boss@x.ca', 'reassign', { id: 'HN-0050', to: 'boss@x.ca', location: 'Hanover' });
ok('Both-location admin eligible at Hanover too', () => assert.equal(r.lead.owner, 'Boss'));

console.log('Editing details');
r = await call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { firstName: 'Zoe', phone: '(289) 555-0123' } });
ok('Edit shows the corrected values straight away', () => { assert.equal(r.lead.firstName, 'Zoe'); assert.equal(r.lead.phone, '+12895550123'); assert.equal(r.lead.detailsEdited, true); });
ok('Original intake values are returned alongside, and never written to', () => {
  assert.equal(r.lead.original.firstName, 'Zoë'); assert.equal(r.lead.original.phone, '+12895550199');
  const f = db.updates.at(-1).fields;
  assert.deepEqual(Object.keys(f).sort(), ['editedFirstName', 'editedPhone']);
  assert.equal(f.editedFirstName, 'Zoe'); assert.equal(f.editedPhone, '+12895550123');
});
ok('Old and new values are logged for each changed field', () => {
  const e = db.logs.filter(x => x.id === 'GT-0050' && x.action.startsWith('Edited'));
  assert.deepEqual(e.map(x => [x.action, x.from, x.to]), [['Edited first name', 'Zoë', 'Zoe'], ['Edited phone', '+12895550199', '+12895550123']]);
  assert.match(e[0].detail, /Intake value kept: Zoë/);
});
r = await call('priya@x.ca', 'search', { q: '555 0123' });
ok('Search finds the corrected phone', () => assert.equal(r.leads[0].id, 'GT-0050'));
r = await call('priya@x.ca', 'search', { q: '555 0199' });
ok('Search still finds the original intake phone', () => assert.equal(r.leads[0].id, 'GT-0050'));
const nWrites = db.updates.length;
await call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { firstName: 'Zoe', phone: '289 555 0123' } });
ok('Saving unchanged details writes and logs nothing', () => assert.equal(db.updates.length, nWrites));
r = await call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { firstName: 'Zoë', phone: '+1 289 555 0199' } });
ok('Setting a value back to the intake value clears the override', () => {
  assert.deepEqual(db.updates.at(-1).fields, { editedFirstName: '', editedPhone: '' });
  assert.equal(r.lead.detailsEdited, false);
  assert.match(db.logs.at(-1).detail, /Back to the intake value/);
});
r = await call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { email: '' } });
ok('Clearing an email stores the cleared marker, not a blank', () => { assert.equal(db.updates.at(-1).fields.editedEmail, CLEARED); assert.equal(r.lead.email, ''); });
await rejects(call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { phone: '' } }), 'bad-request'); ok('Cannot remove both phone and email', () => {});
await rejects(call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { firstName: '  ' } }), 'bad-request'); ok('First name is required', () => {});
await rejects(call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { phone: '12' } }), 'bad-request'); ok('Bad phone refused', () => {});
await rejects(call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { email: 'not-an-email' } }), 'bad-request'); ok('Bad email refused', () => {});
await rejects(call('priya@x.ca', 'editDetails', { id: 'HN-0050', details: { firstName: 'X' } }), 'not-found'); ok('Cannot edit the other site\'s lead', () => {});
r = await call('priya@x.ca', 'editDetails', { id: 'GT-0050', details: { email: '=cmd|x' } }).catch(e => e);
ok('Formula-looking text is not accepted as an email', () => assert.equal(r.code, 'bad-request'));

console.log('Reading edited details from the sheet row');
const hdr = ['Timestamp', 'First Name', 'Last Name', 'Email', 'Phone', 'Reason', 'Source', 'Location', 'UTM Campaign', 'CRM ID', 'Assigned at', 'Edited first name', 'Edited last name', 'Edited phone', 'Edited email'];
const idx = headerIndex(hdr);
const rowOf = o => hdr.map(h => o[h] ?? '');
let lr = leadFromRow('Website Leads', idx, rowOf({ Timestamp: '2026-10-05 09:00', 'First Name': 'Zoë', Email: 'z@x.ca', Phone: '289 555 0199', Location: 'Georgetown', 'UTM Campaign': 'Spring', 'CRM ID': 'GT-1' }), 2);
ok('No edits: intake values used, campaign read', () => { assert.equal(lr.firstName, 'Zoë'); assert.equal(lr.phone, '+12895550199'); assert.equal(lr.detailsEdited, false); assert.equal(lr.campaign, 'Spring'); });
lr = leadFromRow('Website Leads', idx, rowOf({ Timestamp: '2026-10-05 09:00', 'First Name': 'Zoë', Email: 'z@x.ca', Phone: '289 555 0199', 'Edited first name': 'Zoe', 'Edited phone': '(416) 555-0100', 'Edited email': CLEARED, 'Assigned at': '2026-10-05 14:00' }), 2);
ok('Edited values win; original kept; cleared marker means blank', () => {
  assert.equal(lr.firstName, 'Zoe'); assert.equal(lr.phone, '+14165550100'); assert.equal(lr.email, '');
  assert.equal(lr.original.firstName, 'Zoë'); assert.equal(lr.original.email, 'z@x.ca'); assert.equal(lr.detailsEdited, true);
  assert.equal(fmtLocal(lr.assignedAt), '2026-10-05 14:00');
  assert.equal(lr.location, '');
});
ok('Meta lead campaign comes from campaign_name', () => {
  const h2 = ['Timestamp', 'First Name', 'campaign_name']; const l2 = leadFromRow('Georgetown Leads', headerIndex(h2), ['2026-10-05 09:00', 'A', 'Meta Spring'], 2);
  assert.equal(l2.campaign, 'Meta Spring'); assert.equal(l2.location, 'Georgetown');
});
ok('The CRM adds 5 new sheet columns beyond the original 27', () => {
  const names = Object.values(FIELD_HEADERS);
  assert.equal(names.length, 32);
  for (const n of ['Assigned at', 'Edited first name', 'Edited last name', 'Edited phone', 'Edited email']) assert.ok(names.includes(n), n);
});

console.log("Owner's report");
ok('Weeks run Monday to Sunday, Toronto time', () => {
  assert.equal(mondayOf(L('2026-10-05 10:00')), '2026-10-05');
  assert.equal(mondayOf(L('2026-10-11 23:30')), '2026-10-05');
  assert.equal(mondayOf(L('2026-10-12 00:10')), '2026-10-12');
  const wr = weekRange(undefined, L('2026-10-08 09:00'));
  assert.equal(wr.weekStart, '2026-10-05'); assert.equal(wr.weekEnd, '2026-10-11');
  assert.equal(fmtLocal(wr.end), '2026-10-12 00:00');
});
const rl = (id, extra) => withOriginal(lead(id, 'Georgetown', extra));
const calls = (c1, o1, c2, o2, c3, o3) => [{ n: 1, at: c1, outcome: o1 || '', by: '' }, { n: 2, at: c2 || null, outcome: o2 || '', by: '' }, { n: 3, at: c3 || null, outcome: o3 || '', by: '' }];
const wk = weekRange('2026-10-05', L('2026-10-12 09:00'));
const repLeads = [
  rl('R1', { created: L('2026-10-05 10:00'), calls: calls(L('2026-10-05 10:20'), 'Spoke to them'), stage: 'Booked', stageStored: 'Booked', contactedAt: L('2026-10-05 10:20'), appointment: L('2026-10-08 11:00'), quality: 'Good', campaign: 'Spring' }),
  rl('R2', { created: L('2026-10-05 11:00'), calls: calls(L('2026-10-05 12:10'), 'Spoke to them'), stage: 'Registered', stageStored: 'Registered', contactedAt: L('2026-10-05 12:10'), appointment: L('2026-10-07 10:00'), quality: 'OK', campaign: 'Spring' }),
  rl('R3', { created: L('2026-10-06 09:00'), calls: calls(L('2026-10-06 09:10'), 'No answer', L('2026-10-06 12:10'), 'No answer', L('2026-10-07 15:00'), 'No answer'), stage: 'Marketing only', stageStored: 'Marketing only', mkt1At: L('2026-10-07 15:05'), campaign: 'Brand' }),
  rl('R4', { created: L('2026-10-07 09:00'), calls: calls(L('2026-10-07 09:20'), 'Spoke to them'), stage: 'Lost', stageStored: 'Lost', lostReason: 'Not interested', contactedAt: L('2026-10-07 09:20'), quality: 'Poor', campaign: 'Brand' }),
  rl('R5', { created: L('2026-10-08 10:00'), calls: calls(L('2026-10-08 10:25'), 'Spoke to them'), stage: 'No-show', stageStored: 'No-show', contactedAt: L('2026-10-08 10:25'), appointment: L('2026-10-09 10:00') }),
  rl('R6', { created: L('2026-10-09 10:00') }),                                   // never called, long overdue
  rl('R7', { created: L('2026-09-28 10:00') }),                                   // previous week
  rl('R8', { created: L('2026-10-05 07:00'), assignedAt: L('2026-10-09 09:00'), calls: calls(L('2026-10-09 09:20'), 'No answer') }) // arrived last week-end, assigned in this week
];
const lrp = locationReport(repLeads, S, 'Georgetown', wk, L('2026-10-12 09:00'));
ok('Counts only leads that arrived (or were assigned) in the week', () => assert.equal(lrp.leads, 7));
ok('Median time to first call (minutes)', () => assert.equal(lrp.medianMinutesToFirstCall, 20)); // waits: 20, 70, 10, 20, 25, 20 -> sorted 10,20,20,20,25,70
ok('Call 1 on time: due-by-now leads only, late and missing calls count against', () => {
  assert.equal(lrp.call1.of, 7); assert.equal(lrp.call1.onTime, 5);
  assert.ok(Math.abs(lrp.call1.rate - 5 / 7) < 1e-9);
});
ok('Contact rate', () => { assert.equal(lrp.contact.count, 4); assert.ok(Math.abs(lrp.contact.rate - 4 / 7) < 1e-9); });
ok('Marketing only rate', () => { assert.equal(lrp.marketingOnly.count, 1); assert.ok(Math.abs(lrp.marketingOnly.rate - 1 / 7) < 1e-9); });
ok('Booked rate of leads; no-show and registered rates of booked', () => {
  assert.equal(lrp.booked.count, 3); assert.ok(Math.abs(lrp.booked.rate - 3 / 7) < 1e-9);
  assert.equal(lrp.noShow.count, 1); assert.ok(Math.abs(lrp.noShow.rate - 1 / 3) < 1e-9);
  assert.equal(lrp.registered.count, 1); assert.ok(Math.abs(lrp.registered.rate - 1 / 3) < 1e-9);
});
ok('Lost reasons counted', () => assert.deepEqual(lrp.lostReasons, [{ reason: 'Not interested', count: 1 }]));
ok('Lead quality by campaign', () => {
  const by = Object.fromEntries(lrp.qualityByCampaign.map(c => [c.campaign, c]));
  assert.deepEqual([by.Spring.total, by.Spring.Good, by.Spring.OK, by.Spring.Poor, by.Spring.unrated], [2, 1, 1, 0, 0]);
  assert.deepEqual([by.Brand.total, by.Brand.Poor, by.Brand.unrated], [2, 1, 1]);
  assert.equal(by['(no campaign)'].total, 3);
});
ok('An empty week reports zeros and null rates, not NaN', () => {
  const e = locationReport([], S, 'Georgetown', wk, L('2026-10-12 09:00'));
  assert.equal(e.leads, 0); assert.equal(e.medianMinutesToFirstCall, null); assert.equal(e.contact.rate, null); assert.deepEqual(e.qualityByCampaign, []);
});
await rejects(call('priya@x.ca', 'report'), 'forbidden'); ok('Staff cannot open the report', () => {});
await rejects(call('lead@x.ca', 'report'), 'forbidden'); ok('Lead role cannot open the report', () => {});
r = await call('boss@x.ca', 'report', { weekStart: '2026-10-05' });
ok('Admin with both sites gets one block per location', () => { assert.deepEqual(r.locations.map(x => x.location), ['Georgetown', 'Hanover']); assert.equal(r.weekStart, '2026-10-05'); assert.equal(r.weekEnd, '2026-10-11'); });
staffList.push({ email: 'gtadmin@x.ca', name: 'GA', location: 'Georgetown', role: 'Admin', active: true });
r = await call('gtadmin@x.ca', 'report');
ok('Single-site Admin sees only their site', () => assert.deepEqual(r.locations.map(x => x.location), ['Georgetown']));
r = await call('boss@x.ca', 'me');
ok('me reports role flags', () => { assert.equal(r.isAdmin, true); assert.equal(r.canReassign, true); assert.equal(r.role, 'Admin'); });
r = await call('priya@x.ca', 'me');
ok('Staff role flags', () => { assert.equal(r.isAdmin, false); assert.equal(r.canReassign, false); assert.equal(r.role, 'Staff'); });

console.log(`\n${pass} checks passed`);
