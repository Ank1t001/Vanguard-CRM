// The lead desk's rules. Knows nothing about Google Sheets: all data goes
// through the store (lib/store/sheets.js today, Supabase later).
import { LOCATIONS, STAGES, OUTCOMES, LOST_REASONS, QUALITY, CLEARED } from './config.js';
import { AppError } from './errors.js';
import { verifyGoogleToken } from './auth.js';
import * as sheetsStore from './store/sheets.js';
import { call2Due, call3Due, computeDue, hoursTable, closedDates, leadStart } from './hours.js';
import { fmtLocal, parseLocalInput } from './tz.js';
import { normPhone, phoneDigits, searchDigits } from './phone.js';
import { weekRange, locationReport } from './report.js';

const iso = d => (d ? new Date(d).toISOString() : null);

// Staff access is read from CRM Staff on every request (the store caches it for
// about 30 seconds), so unticking Active locks someone out almost at once.
async function authorize(store, email) {
  const { settings, staff } = await store.context();
  const person = staff.find(s => s.email === email && s.active);
  if (!person) throw new AppError('not-approved', `${email} is not on the approved staff list. Ask your manager to add you.`, 403);
  return { settings, staff, person };
}

// Sign-in: Google's token is checked once here. The caller then starts the
// app's own session for the returned email.
export async function login(body, deps = {}) {
  const store = deps.store || sheetsStore;
  const verify = deps.verify || verifyGoogleToken;
  const email = await verify(body.credential);
  const { person } = await authorize(store, email);
  return { email, name: person.name };
}

const roleOf = person => String(person.role || 'Staff').trim().toLowerCase();
function requireRole(ctx, ...roles) {
  if (!roles.includes(roleOf(ctx.person))) throw new AppError('forbidden', 'Your role does not allow that.', 403);
}

export async function handle(body, deps = {}) {
  const store = deps.store || sheetsStore;
  const verify = deps.verify || verifyGoogleToken;
  const email = await verify(body.token);
  const { settings, staff, person } = await authorize(store, email);
  const loc = person.location === 'Both'
    ? (LOCATIONS.includes(body.location) ? body.location : LOCATIONS[0])
    : person.location;
  const ctx = { store, settings, staff, person, loc, now: deps.now || (() => new Date()) };

  switch (body.action) {
    case 'me': return me(ctx);
    case 'list': return { leads: (await leadsFor(ctx)).map(l => pub(ctx, l)) };
    case 'open': return openLead(ctx, body.id);
    case 'dial': return dial(ctx, body.id);
    case 'logCall': return logCall(ctx, body.id, Number(body.call), body.outcome);
    case 'update': return updateLead(ctx, body.id, body.fields || {});
    case 'addLead': return addLead(ctx, body.lead || {});
    case 'search': return search(ctx, body.q);
    case 'editDetails': return editDetails(ctx, body.id, body.details || {});
    case 'reassign': return reassign(ctx, body.id, body.to);
    case 'unassigned': return unassignedList(ctx);
    case 'assign': return assignLead(ctx, body.id, body.to);
    case 'report': return report(ctx, body.weekStart);
    default: throw new AppError('bad-request', 'Unknown action.');
  }
}

function me(ctx) {
  const p = ctx.person;
  return {
    name: p.name, email: p.email, location: ctx.loc,
    role: roleOf(p) === 'admin' ? 'Admin' : roleOf(p) === 'lead' ? 'Lead' : 'Staff',
    canReassign: ['lead', 'admin'].includes(roleOf(p)), isAdmin: roleOf(p) === 'admin',
    canSwitch: p.location === 'Both',
    locations: p.location === 'Both' ? LOCATIONS : [p.location],
    hours: hoursTable(ctx.settings),
    closedDates: closedDates(ctx.settings),
    stages: STAGES, outcomes: OUTCOMES, lostReasons: LOST_REASONS, quality: QUALITY
  };
}

/* ---------------- Reading ---------------- */

// Leads for the location, with duplicates folded into the original.
async function leadsFor(ctx, { includeHidden = false } = {}) {
  const s = ctx.settings;
  const all = await ctx.store.listLeads(ctx.loc, s);
  const windowMs = (Number(s.DUPLICATE_WINDOW_DAYS) || 30) * 864e5;
  const from = s.SHOW_LEADS_FROM ? parseLocalInput(String(s.SHOW_LEADS_FROM).slice(0, 10)) : null;

  const seen = new Map();
  const dupWrites = [];
  [...all].sort((a, b) => (a.created || 0) - (b.created || 0)).forEach(lead => {
    const keys = [lead.phone, lead.email.toLowerCase()].filter(Boolean);
    let original = null;
    for (const k of keys) {
      const prev = seen.get(k);
      if (!original && prev && lead.created && prev.created && lead.created - prev.created <= windowMs) original = prev;
    }
    if (original && !lead.duplicateOf && lead.stageStored === '') {
      lead.duplicateOf = original.id;
      dupWrites.push({ lead, fields: { duplicateOf: original.id } });
    }
    if (!original) keys.forEach(k => seen.set(k, lead));
  });
  if (dupWrites.length) await ctx.store.updateMany(dupWrites, null);

  const counts = {};
  for (const l of all) if (l.duplicateOf) counts[l.duplicateOf] = (counts[l.duplicateOf] || 1) + 1;

  return all.filter(l => {
    if (l.duplicateOf) return false;
    if (!includeHidden && from && l.stageStored === '' && leadStart(l) && leadStart(l) < from) return false;
    return true;
  }).map(l => { l.submissions = counts[l.id] || 1; return l; });
}

function pub(ctx, l) {
  return {
    id: l.id, firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone,
    detailsEdited: !!l.detailsEdited, original: l.detailsEdited ? l.original : null,
    reason: l.reason, source: l.source, channel: l.channel, created: iso(l.created),
    stage: l.stage, lostReason: l.lostReason, quality: l.quality, owner: l.owner,
    firstOpenedAt: iso(l.firstOpenedAt), firstOpenedBy: l.firstOpenedBy,
    calls: l.calls.map(c => ({ n: c.n, at: iso(c.at), outcome: c.outcome, by: c.by })),
    nextDue: iso(computeDue(ctx.settings, l)),
    contactedAt: iso(l.contactedAt), followUp: iso(l.followUp), appointment: iso(l.appointment),
    notes: l.notes, welcomeAt: iso(l.welcomeAt), mkt1At: iso(l.mkt1At), mkt2At: iso(l.mkt2At),
    submissions: l.submissions || 1, updatedAt: iso(l.updatedAt), updatedBy: l.updatedBy
  };
}

async function findLead(ctx, id) {
  if (!id) throw new AppError('bad-request', 'Missing lead.');
  const lead = (await leadsFor(ctx)).find(l => l.id === id);
  if (!lead) throw new AppError('not-found', 'That lead is not in your location, or it was removed.', 404);
  return lead;
}

// Mirror a write onto the in-memory lead so we can answer without re-reading the sheet.
function apply(lead, fields, who) {
  for (const [k, v] of Object.entries(fields)) {
    const m = /^call(\d)(At|Outcome|By)$/.exec(k);
    if (m) lead.calls[+m[1] - 1][{ At: 'at', Outcome: 'outcome', By: 'by' }[m[2]]] = v;
    else if (k !== 'nextDue' && !/^edited[A-Z]/.test(k)) lead[k] = v;
  }
  if (fields.stage) lead.stageStored = fields.stage;
  if (who) { lead.updatedAt = new Date(); lead.updatedBy = who; }
}

const entry = (ctx, lead, action, from, to, detail) =>
  ({ id: lead.id, location: lead.location, staff: ctx.person.name, action, from, to, detail });

/* ---------------- Actions ---------------- */

async function openLead(ctx, id) {
  const lead = await findLead(ctx, id);
  if (!lead.firstOpenedAt) {
    const f = { firstOpenedAt: ctx.now(), firstOpenedBy: ctx.person.name };
    if (!lead.stageStored) f.stage = 'New';
    await ctx.store.update(lead, f, ctx.person.name);
    apply(lead, f, ctx.person.name);
    await ctx.store.log([entry(ctx, lead, 'Opened')]);
  }
  const activity = (await ctx.store.activity(id)).map(a => ({ ...a, at: iso(a.at) }));
  return { lead: pub(ctx, lead), activity, team: ctx.person && roleOf(ctx.person) !== 'staff' ? teamFor(ctx, lead.location) : [] };
}

const nextCallNumber = lead => lead.calls.filter(c => c.outcome).length + 1;

async function dial(ctx, id) {
  const lead = await findLead(ctx, id);
  const n = nextCallNumber(lead);
  if (['New', 'Calling'].includes(lead.stage) && n <= 3 && !lead.calls[n - 1].at) {
    const f = { [`call${n}At`]: ctx.now() };
    await ctx.store.update(lead, f, ctx.person.name);
    apply(lead, f, ctx.person.name);
    await ctx.store.log([entry(ctx, lead, `Call ${n} started`, '', '', lead.phone)]);
  } else {
    await ctx.store.log([entry(ctx, lead, 'Dialled', '', '', lead.phone)]);
  }
  return { lead: pub(ctx, lead) };
}

async function logCall(ctx, id, n, outcome) {
  const lead = await findLead(ctx, id);
  if (!OUTCOMES.includes(outcome)) throw new AppError('bad-request', 'Pick a call outcome.');
  if (!['New', 'Calling'].includes(lead.stage)) throw new AppError('bad-request', 'This lead is past the calling stage.');
  const expected = nextCallNumber(lead);
  if (n !== expected || n > 3) throw new AppError('conflict', `Call ${expected} is the next call for this lead. Refresh and try again.`, 409);

  const now = ctx.now();
  const at = lead.calls[n - 1].at || now;
  const f = { [`call${n}At`]: at, [`call${n}Outcome`]: outcome, [`call${n}By`]: ctx.person.name };
  if (!lead.owner) f.owner = ctx.person.name;

  let event = null;
  if (outcome === 'Spoke to them') {
    f.stage = 'Contacted'; f.contactedAt = now; f.nextDue = '';
  } else if (outcome === 'Wrong number') {
    f.stage = 'Lost'; f.lostReason = 'Wrong number'; f.nextDue = '';
  } else if (n < 3) {
    f.stage = 'Calling';
    f.nextDue = n === 1 ? call2Due(ctx.settings, ctx.loc, at) : call3Due(ctx.settings, ctx.loc, lead.calls[1].at || at);
  } else {
    f.stage = 'Marketing only'; f.nextDue = ''; event = 'marketing_tried';
  }

  const from = lead.stage;
  await ctx.store.update(lead, f, ctx.person.name);
  apply(lead, f, ctx.person.name);
  const logs = [entry(ctx, lead, `Call ${n}: ${outcome}`, from, f.stage)];

  if (event && await fireEvent(ctx.settings, event, lead)) {
    const g = { mkt1At: ctx.now() };
    await ctx.store.update(lead, g, null);
    apply(lead, g, null);
    logs.push(entry(ctx, lead, 'Email: we tried to reach you'));
  }
  await ctx.store.log(logs);
  return { lead: pub(ctx, lead) };
}

function dateInput(v, message) {
  const d = parseLocalInput(v);
  if (d === undefined) throw new AppError('bad-request', 'That date is not valid.');
  if (!d) throw new AppError('bad-request', message);
  return d;
}

async function updateLead(ctx, id, fields) {
  const lead = await findLead(ctx, id);
  const f = {};
  const logs = [];
  let event = null;
  const from = lead.stage;
  let to = from;

  if (fields.quality !== undefined) {
    if (fields.quality && !QUALITY.includes(fields.quality)) throw new AppError('bad-request', 'Pick Good, OK or Poor.');
    f.quality = fields.quality;
    logs.push(entry(ctx, lead, 'Lead quality', lead.quality, fields.quality));
  }

  if (fields.stage && fields.stage !== from) {
    to = fields.stage;
    if (!STAGES.includes(to)) throw new AppError('bad-request', 'Unknown stage.');
    if (['New', 'Calling', 'Marketing only'].includes(to)) throw new AppError('bad-request', 'Use the call buttons to move a lead through calling.');
    if (from === 'Marketing only' && !['Contacted', 'Lost'].includes(to)) {
      throw new AppError('bad-request', 'A Marketing only lead goes back to Contacted when they reply or call back.');
    }
    if (to === 'Lost') {
      if (!LOST_REASONS.includes(fields.lostReason)) throw new AppError('bad-request', 'Pick a reason for closing this lead.');
      f.lostReason = fields.lostReason;
    }
    if (to === 'Booked') { f.appointment = dateInput(fields.appointment, 'Set the intake date and time.'); event = 'booked'; }
    if (to === 'Follow-up later') {
      f.followUp = dateInput(fields.followUp, 'Set the follow-up date.');
      f.nextDue = f.followUp; event = 'follow_up_info';
    } else {
      f.nextDue = '';
    }
    if (to === 'Contacted' && !lead.contactedAt) f.contactedAt = ctx.now();
    if (to === 'No-show') event = 'no_show';
    if (to === 'Registered') event = 'registered';
    if (!lead.owner) f.owner = ctx.person.name;
    f.stage = to;
    logs.push(entry(ctx, lead, 'Stage changed', from, to, fields.lostReason || fields.appointment || fields.followUp || ''));
  } else {
    if (from === 'Booked' && fields.appointment) {
      f.appointment = dateInput(fields.appointment, 'Set the intake date and time.');
      event = 'booked';
      logs.push(entry(ctx, lead, 'Intake moved', '', '', fields.appointment));
    }
    if (from === 'Follow-up later' && fields.followUp) {
      f.followUp = dateInput(fields.followUp, 'Set the follow-up date.');
      f.nextDue = f.followUp;
      logs.push(entry(ctx, lead, 'Follow-up moved', '', '', fields.followUp));
    }
  }

  const note = String(fields.note || '').trim().slice(0, 2000);
  if (note) {
    const line = `${fmtLocal(ctx.now())} ${ctx.person.name}: ${note}`;
    f.notes = lead.notes ? `${lead.notes}\n${line}` : line;
    logs.push(entry(ctx, lead, 'Note', '', '', note.slice(0, 500)));
  }

  if (!Object.keys(f).length) return { lead: pub(ctx, lead) };
  await ctx.store.update(lead, f, ctx.person.name);
  apply(lead, f, ctx.person.name);

  if (event && await fireEvent(ctx.settings, event, lead)) logs.push(entry(ctx, lead, `Email event sent: ${event}`));
  await ctx.store.log(logs);
  return { lead: pub(ctx, lead) };
}

async function addLead(ctx, input) {
  const firstName = String(input.firstName || '').trim();
  if (!firstName) throw new AppError('bad-request', 'First name is required.');
  if (!String(input.phone || '').trim() && !String(input.email || '').trim()) throw new AppError('bad-request', 'Add a phone number or an email.');
  const clean = {
    firstName, lastName: String(input.lastName || '').trim(), phone: String(input.phone || '').trim(),
    email: String(input.email || '').trim(), reason: String(input.reason || '').trim(), source: String(input.source || 'Other').trim()
  };
  const id = await ctx.store.addLead(ctx.loc, clean, ctx.person.name);
  await ctx.store.log([{ id, location: ctx.loc, staff: ctx.person.name, action: 'Lead added by hand', from: '', to: 'New', detail: clean.source }]);
  const lead = await findLead(ctx, id);
  return { lead: pub(ctx, lead) };
}


/* ---------------- Search ---------------- */

// Name, phone or email, across every stage, for the signed-in person's location
// only. Leads hidden from the queue by SHOW_LEADS_FROM are still found.
async function search(ctx, q) {
  const query = String(q || '').trim().slice(0, 100);
  const digits = searchDigits(query);
  if (digits !== null ? digits.length < 3 : query.length < 2) {
    throw new AppError('bad-request', digits !== null ? 'Type at least 3 digits of the phone number.' : 'Type at least 2 letters.');
  }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const leads = (await leadsFor(ctx, { includeHidden: true })).filter(l => {
    if (digits !== null) return phoneDigits(l.phone).includes(digits) || phoneDigits(l.original.phone).includes(digits);
    const hay = [l.firstName, l.lastName, l.email, l.original.firstName, l.original.lastName, l.original.email].join(' ').toLowerCase();
    return tokens.every(t => hay.includes(t));
  }).sort((a, b) => (b.created || 0) - (a.created || 0));
  return { leads: leads.slice(0, 50).map(l => pub(ctx, l)), total: leads.length };
}

/* ---------------- Editing a lead's details ---------------- */

const DETAIL_LABEL = { firstName: 'first name', lastName: 'last name', phone: 'phone', email: 'email' };
const DETAIL_COLUMN = { firstName: 'editedFirstName', lastName: 'editedLastName', phone: 'editedPhone', email: 'editedEmail' };

// The intake columns are never touched. A correction goes in its own column,
// the CRM shows it instead of the original, and both old and new values are
// written to CRM Activity.
async function editDetails(ctx, id, input) {
  const lead = await findLead(ctx, id);
  const next = {};
  for (const k of Object.keys(DETAIL_LABEL)) {
    if (input[k] === undefined) { next[k] = lead[k]; continue; }
    const v = String(input[k] ?? '').trim().slice(0, 200);
    if (k === 'phone') {
      const p = normPhone(v);
      if (v && (p.replace(/\D/g, '').length < 10 || p.replace(/\D/g, '').length > 15)) throw new AppError('bad-request', 'That phone number does not look right.');
      next[k] = p;
    } else if (k === 'email') {
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new AppError('bad-request', 'That email address does not look right.');
      next[k] = v;
    } else next[k] = v;
  }
  if (!next.firstName) throw new AppError('bad-request', 'First name is required.');
  if (!next.phone && !next.email) throw new AppError('bad-request', 'Keep a phone number or an email.');

  const f = {}, logs = [];
  for (const k of Object.keys(DETAIL_LABEL)) {
    if (next[k] === lead[k]) continue;
    const original = lead.original[k];
    f[DETAIL_COLUMN[k]] = next[k] === original ? '' : (next[k] === '' ? CLEARED : next[k]);
    logs.push(entry(ctx, lead, `Edited ${DETAIL_LABEL[k]}`, lead[k], next[k], next[k] === original ? 'Back to the intake value' : `Intake value kept: ${original || 'blank'}`));
  }
  if (!logs.length) return { lead: pub(ctx, lead) };

  await ctx.store.update(lead, f, ctx.person.name);
  Object.assign(lead, next);
  lead.detailsEdited = Object.keys(DETAIL_LABEL).some(k => lead.original[k] !== lead[k]);
  lead.updatedAt = ctx.now(); lead.updatedBy = ctx.person.name;
  await ctx.store.log(logs);
  return { lead: pub(ctx, lead) };
}

/* ---------------- Reassigning a lead to another person ---------------- */

// Active staff who can work this location.
function teamFor(ctx, loc) {
  return ctx.staff.filter(s => s.active && (s.location === 'Both' || s.location === loc)).map(s => ({ email: s.email, name: s.name }));
}

async function reassign(ctx, id, toEmail) {
  requireRole(ctx, 'lead', 'admin');
  const lead = await findLead(ctx, id);
  const target = ctx.staff.find(s => s.email === String(toEmail || '').trim().toLowerCase());
  if (!target || !target.active) throw new AppError('bad-request', 'Pick an active staff member.');
  if (target.location !== 'Both' && target.location !== lead.location) {
    throw new AppError('bad-request', `${target.name} does not work at ${lead.location}.`);
  }
  if (lead.owner === target.name) throw new AppError('bad-request', `${target.name} already owns this lead.`);
  const from = lead.owner;
  await ctx.store.update(lead, { owner: target.name }, ctx.person.name);
  apply(lead, { owner: target.name }, ctx.person.name);
  await ctx.store.log([entry(ctx, lead, 'Reassigned', from || 'Unassigned', target.name)]);
  return { lead: pub(ctx, lead) };
}

/* ---------------- Unassigned queue (Admin) ---------------- */

async function unassignedList(ctx) {
  requireRole(ctx, 'admin');
  const leads = await ctx.store.listUnassigned(ctx.settings);
  return {
    leads: leads.sort((a, b) => (a.created || 0) - (b.created || 0)).map(l => ({
      id: l.id, firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone,
      reason: l.reason, source: l.source, channel: l.channel, created: iso(l.created)
    }))
  };
}

// Writes the Location column and starts the call 1 clock from this moment.
async function assignLead(ctx, id, to) {
  requireRole(ctx, 'admin');
  if (!LOCATIONS.includes(to)) throw new AppError('bad-request', 'Pick Georgetown or Hanover.');
  const lead = (await ctx.store.listUnassigned(ctx.settings)).find(l => l.id === id);
  if (!lead) throw new AppError('not-found', 'That lead already has a location, or it was removed.', 404);
  const at = ctx.now();
  await ctx.store.update(lead, { location: to, assignedAt: at }, ctx.person.name);
  await ctx.store.log([{ id: lead.id, location: to, staff: ctx.person.name, action: 'Assigned to location', from: 'Unassigned', to, detail: 'Call 1 clock starts now' }]);
  return { id: lead.id, location: to, assignedAt: iso(at) };
}

/* ---------------- Owner's report (Admin) ---------------- */

async function report(ctx, weekStart) {
  requireRole(ctx, 'admin');
  const now = ctx.now();
  const range = weekRange(weekStart, now);
  const locations = ctx.person.location === 'Both' ? LOCATIONS : [ctx.person.location];
  const out = [];
  for (const loc of locations) {
    const leads = await leadsFor({ ...ctx, loc }, { includeHidden: true });
    out.push(locationReport(leads, ctx.settings, loc, range, now));
  }
  return { weekStart: range.weekStart, weekEnd: range.weekEnd, currentWeekStart: weekRange(undefined, now).weekStart, locations: out };
}

/* ---------------- Email events and the daily job ---------------- */

// Only logistics leave the CRM: never the reason, notes or lead quality.
export async function fireEvent(settings, event, lead) {
  const url = String(settings.MAKE_WEBHOOK_URL || '').trim();
  if (!url || !lead.email) return false;
  const payload = {
    event, crmId: lead.id, location: lead.location, firstName: lead.firstName, email: lead.email,
    appointment: lead.appointment ? fmtLocal(lead.appointment).replace(' ', 'T') : '',
    followUp: lead.followUp ? fmtLocal(lead.followUp).slice(0, 10) : ''
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok;
  } catch (e) {
    console.error(`Event failed: ${event} ${lead.id}`, e);
    return false;
  }
}

// Sends the single Marketing only check-in, MARKETING_CHECKIN_DAYS after the first email.
export async function dailyJob(deps = {}) {
  const store = deps.store || sheetsStore;
  const now = deps.now ? deps.now() : new Date();
  const { settings } = await store.context();
  const days = Number(settings.MARKETING_CHECKIN_DAYS) || 7;
  let sent = 0;
  for (const loc of LOCATIONS) {
    const ctx = { store, settings, person: { name: 'CRM' }, loc, now: () => now };
    for (const lead of await leadsFor(ctx)) {
      if (lead.stage !== 'Marketing only' || !lead.mkt1At || lead.mkt2At) continue;
      if (now - lead.mkt1At < days * 864e5) continue;
      if (await fireEvent(settings, 'marketing_checkin', lead)) {
        await store.update(lead, { mkt2At: now }, 'CRM');
        await store.log([{ id: lead.id, location: loc, staff: 'CRM', action: 'Email: check-in', from: '', to: '', detail: '' }]);
        sent++;
      }
    }
  }
  return { sent };
}
