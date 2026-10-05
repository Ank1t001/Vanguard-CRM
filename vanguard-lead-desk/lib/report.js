// Owner's weekly report. Pure functions: leads in, numbers out.
// A "week" runs Monday 00:00 to the next Monday 00:00, Toronto time, and a
// lead belongs to the week it arrived in (or was assigned to a site in).
import { parts, atLocal, shiftDays } from './tz.js';
import { call1Due, leadStart } from './hours.js';

// Monday of the week containing `date`, as YYYY-MM-DD.
export function mondayOf(date) {
  const p = parts(date);
  return parts(shiftDays(date, -((p.dow + 6) % 7))).ymd;
}

export function weekRange(weekStart, now) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || '')) ? weekStart : mondayOf(now);
  const start = atLocal(ymd, 0);
  const end = atLocal(parts(shiftDays(start, 7)).ymd, 0);
  return { weekStart: parts(start).ymd, weekEnd: parts(shiftDays(start, 6)).ymd, start, end };
}

const median = nums => {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const rate = (n, d) => (d ? n / d : null);
const BOOKED_STAGES = ['Booked', 'No-show', 'Registered'];

export function locationReport(leads, settings, loc, range, now) {
  const week = leads.filter(l => {
    const s = leadStart(l);
    return s && s >= range.start && s < range.end;
  });

  const waits = [];
  let dueCount = 0, onTime = 0;
  for (const l of week) {
    const start = leadStart(l), first = l.calls[0].at;
    if (first) waits.push(Math.max(0, Math.round((first - start) / 6e4)));
    const due = call1Due(settings, loc, start);
    if (first || (due && due <= now)) { dueCount++; if (first && due && first <= due) onTime++; }
  }

  const contacted = week.filter(l => l.contactedAt || l.calls.some(c => c.outcome === 'Spoke to them'));
  const marketing = week.filter(l => l.stage === 'Marketing only' || l.mkt1At);
  const booked = week.filter(l => l.appointment || BOOKED_STAGES.includes(l.stage));
  const noShow = week.filter(l => l.stage === 'No-show');
  const registered = week.filter(l => l.stage === 'Registered');

  const lostReasons = {};
  for (const l of week) if (l.stage === 'Lost') lostReasons[l.lostReason || 'No reason given'] = (lostReasons[l.lostReason || 'No reason given'] || 0) + 1;

  const byCampaign = new Map();
  for (const l of week) {
    const name = l.campaign || '(no campaign)';
    const row = byCampaign.get(name) || { campaign: name, total: 0, Good: 0, OK: 0, Poor: 0, unrated: 0 };
    row.total++;
    row[['Good', 'OK', 'Poor'].includes(l.quality) ? l.quality : 'unrated']++;
    byCampaign.set(name, row);
  }

  return {
    location: loc,
    leads: week.length,
    medianMinutesToFirstCall: median(waits),
    call1: { onTime, of: dueCount, rate: rate(onTime, dueCount) },
    contact: { count: contacted.length, rate: rate(contacted.length, week.length) },
    marketingOnly: { count: marketing.length, rate: rate(marketing.length, week.length) },
    booked: { count: booked.length, rate: rate(booked.length, week.length) },
    noShow: { count: noShow.length, rate: rate(noShow.length, booked.length) },
    registered: { count: registered.length, rate: rate(registered.length, booked.length) },
    lostReasons: Object.entries(lostReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    qualityByCampaign: [...byCampaign.values()].sort((a, b) => b.total - a.total)
  };
}
