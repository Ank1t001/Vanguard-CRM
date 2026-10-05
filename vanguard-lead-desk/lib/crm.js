// The lead desk's rules. Knows nothing about Google Sheets: all data goes
// through the store (lib/store/sheets.js today, Supabase later).
import { LOCATIONS, STAGES, OUTCOMES, LOST_REASONS, QUALITY } from './config.js';
import { AppError } from './errors.js';
import { verifyGoogleToken } from './auth.js';
import * as sheetsStore from './store/sheets.js';
import { call2Due, call3Due, computeDue, hoursTable, closedDates } from './hours.js';
import { fmtLocal, parseLocalInput } from './tz.js';

const iso = d => (d ? new Date(d).toISOString() : null);

export async function handle(body, deps = {}) {
  const store = deps.store || sheetsStore;
  const verify = deps.verify || verifyGoogleToken;
  const email = await verify(body.token);
  const { settings, staff } = await store.context();
  const person = staff.find(s => s.email === email && s.active);
  if (!person) throw new AppError('not-approved', `${email} is not on the approved staff list. Ask your manager to add you.`, 403);
  const loc = person.location === 'Both'
    ? (LOCATIONS.includes(body.location) ? body.location : LOCATIONS[0])
    : person.location;
  const ctx = { store, settings, person, loc, now: deps.now || (() => new Date()) };

  switch (body.action) {
    case 'me': return me(ctx);
    case 'list': return { leads: (await leadsFor(ctx)).map(l => pub(ctx, l)) };
    case 'open': return openLead(ctx, body.id);
    case 'dial': return dial(ctx, body.id);
    case 'logCall': return logCall(ctx, body.id, Number(body.call), body.outcome);
    case 'update': return updateLead(ctx, body.id, body.fields || {});
    case 'addLead': return addLead(ctx, body.lead || {});
    default: throw new AppError('bad-request', 'Unknown action.');
  }
}

function me(ctx) {
  const p = ctx.person;
  return {
    name: p.name, email: p.email, role: p.role, location: ctx.loc,
    canSwitch: p.location === 'Both',
    locations: p.location === 'Both' ? LOCATIONS : [p.location],
    hours: hoursTable(ctx.settings),
    closedDates: closedDates(ctx.settings),
    stages: STAGES, outcomes: OUTCOMES, lostReasons: LOST_REASONS, quality: QUALITY
  };
}

/* ---------------- Reading ---------------- */

// Leads for the location, with duplicates folded into the original.
async function leadsFor(ctx) {
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
    if (from && l.stageStored === '' && l.created && l.created < from) return false;
    return true;
  }).map(l => { l.submissions = counts[l.id] || 1; return l; });
}

function pub(ctx, l) {
  return {
    id: l.id, firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone,
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
    else if (k !== 'nextDue') lead[k] = v;
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
  return { lead: pub(ctx, lead), activity };
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
