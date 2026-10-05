// Opening hours and the call cadence: call 1 within 30 minutes, call 2 within
// 3 hours (next morning if past closing), call 3 the next business day.
// The clock runs on pharmacy hours; doctor hours matter only for booking.
import { LOCATIONS, DAYS } from './config.js';
import { parts, atLocal, shiftDays } from './tz.js';

export function hoursTable(settings) {
  const out = {};
  for (const loc of LOCATIONS) {
    out[loc] = {};
    for (const kind of ['pharmacy', 'doctor']) {
      out[loc][kind] = DAYS.map(d => String(settings[`${loc} ${kind} ${d}`] || 'Closed'));
    }
  }
  return out;
}

export function closedDates(settings) {
  return String(settings.CLOSED_DATES || '').split(',').map(s => s.trim()).filter(Boolean);
}

function hoursFor(settings, loc, kind, date) {
  const p = parts(date);
  if (closedDates(settings).includes(p.ymd)) return null;
  const raw = settings[`${loc} ${kind} ${DAYS[p.dow]}`];
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  return { ymd: p.ymd, open: +m[1] * 60 + +m[2], close: +m[3] * 60 + +m[4] };
}

const addMin = (d, m) => new Date(d.getTime() + m * 6e4);

// Next moment the pharmacy is open, at or after d.
export function nextOpen(settings, loc, d) {
  for (let i = 0; i < 9; i++) {
    const day = shiftDays(d, i);
    const h = hoursFor(settings, loc, 'pharmacy', day);
    if (!h) continue;
    const openAt = atLocal(h.ymd, h.open), closeAt = atLocal(h.ymd, h.close);
    if (i === 0) {
      if (d < openAt) return openAt;
      if (d < closeAt) return new Date(d.getTime());
      continue;
    }
    return openAt;
  }
  return null;
}

// Closing time of the opening period d falls in, or null if closed at d.
export function closeOf(settings, loc, d) {
  const h = hoursFor(settings, loc, 'pharmacy', d);
  if (!h) return null;
  const openAt = atLocal(h.ymd, h.open), closeAt = atLocal(h.ymd, h.close);
  return d >= openAt && d < closeAt ? closeAt : null;
}

export function call1Due(settings, loc, created) {
  const mins = Number(settings.CALL1_MINUTES) || 30;
  const o = nextOpen(settings, loc, created);
  if (!o) return null;
  if (o.getTime() === created.getTime()) {
    const cl = closeOf(settings, loc, created);
    let due = addMin(created, mins);
    if (due > cl) due = (cl - created >= 10 * 6e4) ? cl : addMin(nextOpen(settings, loc, cl), mins);
    return due;
  }
  return addMin(o, mins);
}

export function call2Due(settings, loc, call1At) {
  const hrs = Number(settings.CALL2_HOURS) || 3;
  const due = addMin(call1At, hrs * 60);
  const cl = closeOf(settings, loc, call1At);
  if (cl && due <= cl) return due;
  const o = nextOpen(settings, loc, cl || call1At);
  return o ? addMin(o, 60) : null;
}

export function call3Due(settings, loc, call2At) {
  const nextDay = atLocal(parts(shiftDays(call2At, 1)).ymd, 0);
  const o = nextOpen(settings, loc, nextDay);
  return o ? closeOf(settings, loc, o) : null;
}

export function computeDue(settings, lead) {
  const done = lead.calls.filter(c => c.outcome).length;
  if (lead.stage === 'New' || (lead.stage === 'Calling' && done === 0)) {
    return lead.created ? call1Due(settings, lead.location, lead.created) : null;
  }
  if (lead.stage === 'Calling') {
    if (done === 1 && lead.calls[0].at) return call2Due(settings, lead.location, lead.calls[0].at);
    if (done === 2 && lead.calls[1].at) return call3Due(settings, lead.location, lead.calls[1].at);
  }
  if (lead.stage === 'Follow-up later') return lead.followUp || null;
  return null;
}
