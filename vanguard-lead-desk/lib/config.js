// Shared constants for the Vanguard lead desk.

export const TZ = 'America/Toronto';

export const SOURCE_TABS = ['Hanover', 'Georgetown Leads', 'Website Leads'];
export const TAB_LOCATION = { 'Hanover': 'Hanover', 'Georgetown Leads': 'Georgetown' };
export const ADD_LEAD_TAB = { 'Hanover': 'Hanover', 'Georgetown': 'Georgetown Leads' };
export const LOCATIONS = ['Georgetown', 'Hanover'];

export const ACTIVITY_TAB = 'CRM Activity';
export const STAFF_TAB = 'CRM Staff';
export const SETTINGS_TAB = 'CRM Settings';

export const ACTIVITY_HEADERS = ['Timestamp', 'CRM ID', 'Location', 'Staff', 'Action', 'From', 'To', 'Detail'];
export const STAFF_HEADERS = ['Email', 'Name', 'Location', 'Role', 'Active'];

export const STAGES = ['New', 'Calling', 'Contacted', 'Follow-up later', 'Booked', 'No-show', 'Registered', 'Marketing only', 'Lost'];
export const OUTCOMES = ['No answer', 'Voicemail left', 'Busy, call back', 'Wrong number', 'Spoke to them'];
export const LOST_REASONS = ['Not interested', 'Found another doctor', 'Outside catchment', 'Wrong location', 'Wrong number', 'Duplicate', 'Spam, fake or test'];
export const QUALITY = ['Good', 'OK', 'Poor'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Semantic field name -> column header in the sheet. The store is the only
// code that knows about headers; swapping to Supabase means mapping these
// same field names to table columns.
export const FIELD_HEADERS = {
  id: 'CRM ID',
  duplicateOf: 'Duplicate of',
  stage: 'Stage',
  lostReason: 'Lost reason',
  quality: 'Lead quality',
  owner: 'Owner',
  firstOpenedAt: 'First opened at',
  firstOpenedBy: 'First opened by',
  call1At: 'Call 1 at', call1Outcome: 'Call 1 outcome', call1By: 'Call 1 by',
  call2At: 'Call 2 at', call2Outcome: 'Call 2 outcome', call2By: 'Call 2 by',
  call3At: 'Call 3 at', call3Outcome: 'Call 3 outcome', call3By: 'Call 3 by',
  nextDue: 'Next call due',
  contactedAt: 'Contacted at',
  followUp: 'Follow-up date',
  appointment: 'Appointment date',
  notes: 'Notes',
  welcomeAt: 'Welcome sent at',
  mkt1At: 'Marketing email 1 sent at',
  mkt2At: 'Marketing email 2 sent at',
  updatedAt: 'Updated at',
  updatedBy: 'Updated by',
  assignedAt: 'Assigned at',
  editedFirstName: 'Edited first name',
  editedLastName: 'Edited last name',
  editedPhone: 'Edited phone',
  editedEmail: 'Edited email'
};
export const CRM_COLUMNS = Object.values(FIELD_HEADERS);

// Columns the website intake owns. The CRM writes only Location, and only when
// an Admin assigns a lead that arrived without one.
export const INTAKE_HEADERS = { location: 'Location' };

// Edited details live beside the intake columns, which are never overwritten.
// A cell holding this marker means "the person asked for this to be blank".
export const CLEARED = '(cleared)';

export const ROLES = ['Staff', 'Lead', 'Admin'];

// Opening hours from the Vanguard website, October 2026. Index 0 = Sunday.
export const HOURS_SEED = {
  'Georgetown pharmacy': ['Closed', '09:00-18:00', '09:00-18:00', '09:00-18:00', '09:00-18:00', '09:00-18:00', '10:00-15:00'],
  'Georgetown doctor':   ['Closed', '09:00-17:00', 'Closed', '09:00-17:00', '09:00-17:00', 'Closed', '10:00-15:00'],
  'Hanover pharmacy':    ['10:00-15:00', '09:00-18:00', '09:00-18:00', '09:00-18:00', '09:00-18:00', '09:00-18:00', '10:00-15:00'],
  'Hanover doctor':      ['Closed', '09:00-18:00', '09:00-18:00', 'Closed', '09:00-18:00', '09:00-15:00', 'Closed']
};

export const DEFAULT_SETTINGS = [
  ['MAKE_WEBHOOK_URL', '', 'Make custom webhook for CRM email events. The MAKE_WEBHOOK_URL environment variable overrides this.'],
  ['CALL1_MINUTES', 30, 'Call 1 due this many minutes after the lead arrives (opening hours only).'],
  ['CALL2_HOURS', 3, 'Call 2 due this many hours after call 1, or next morning if past closing.'],
  ['MARKETING_CHECKIN_DAYS', 7, 'Days after the "we tried to reach you" email before the one check-in.'],
  ['DUPLICATE_WINDOW_DAYS', 30, 'Same phone or email within this many days counts as one lead.'],
  ['SHOW_LEADS_FROM', '', 'Optional date (YYYY-MM-DD). Untouched leads older than this stay hidden.'],
  ['EXCLUDE_EMAILS', 'test@meta.com', 'Comma-separated test emails to hide from the CRM.'],
  ['CLOSED_DATES', '2026-10-12, 2026-12-25, 2026-12-26, 2027-01-01', 'Holidays (YYYY-MM-DD, comma-separated). Both sites treated as closed. Confirm with each site.']
];

export function defaultSettingsMap() {
  const out = {};
  for (const [k, v] of DEFAULT_SETTINGS) out[k] = v;
  for (const key of Object.keys(HOURS_SEED)) HOURS_SEED[key].forEach((v, i) => { out[`${key} ${DAYS[i]}`] = v; });
  return out;
}
