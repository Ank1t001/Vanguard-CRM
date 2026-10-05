// npm test  Runs without Google: uses an in-memory store and a fake sign-in.
import assert from 'node:assert/strict';
import { parseTs, fmtLocal, localToDate } from '../lib/tz.js';
import { call1Due, call2Due, call3Due } from '../lib/hours.js';
import { defaultSettingsMap } from '../lib/config.js';
import { handle, dailyJob } from '../lib/crm.js';

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
  updatedAt: null, updatedBy: '', ...extra
});
const db = {
  leads: [lead('GT-0001', 'Georgetown'), lead('GT-0002', 'Georgetown'), lead('HN-0001', 'Hanover'),
    lead('GT-0003', 'Georgetown', { phone: '+12895550001', created: L('2026-10-06 09:00') })], // duplicate of GT-0001 by phone
  logs: [], writes: 0
};
const store = {
  context: async () => ({ settings: S, staff: [
    { email: 'priya@x.ca', name: 'Priya', location: 'Georgetown', role: 'Staff', active: true },
    { email: 'old@x.ca', name: 'Old', location: 'Georgetown', role: 'Staff', active: false },
    { email: 'boss@x.ca', name: 'Boss', location: 'Both', role: 'Admin', active: true }
  ] }),
  listLeads: async loc => db.leads.filter(l => l.location === loc),
  updateMany: async items => { db.writes += items.length; },
  update: async () => { db.writes++; },
  addLead: async (loc, input) => { const id = 'GT-NEW1'; db.leads.push(lead(id, loc, { firstName: input.firstName, created: new Date() })); return id; },
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

console.log(`\n${pass} checks passed`);
