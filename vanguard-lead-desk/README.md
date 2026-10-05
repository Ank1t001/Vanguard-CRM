# Vanguard lead desk

_Designed and built by **Help Me Marketing (HMM)** for Vanguard Pharmacy & Clinic._

The CRM the Georgetown and Hanover pharmacy teams use to call, track and book new patient leads. Hosted on Vercel at **crm.vanguardclinics.ca**. The "Vanguard - All Leads" Google Sheet is the database; staff never get access to it.

```
public/          The dashboard staff use (plus phone icons and install manifest)
api/crm.js       The one endpoint the dashboard talks to
api/config.js    Public settings for the sign-in page
api/cron/        Daily job: the Marketing only check-in email
lib/crm.js       The funnel rules: who sees what, call cadence, stage moves
lib/hours.js     Opening hours and call due times
lib/store/       The ONLY code that touches Google Sheets (swap for Supabase later)
scripts/         setup.mjs (run once) and test.mjs
```

Try it first: open `public/index.html` in a browser, or add `?demo` to the live URL. It runs on sample leads.

## How it fits with what already exists

**The website intake script stays exactly as it is.** The Apps Script web app the site and landing page forms post to (currently Version 8) keeps writing new leads into the sheet. The lead desk never touches Apps Script, so there's no redeploy and no form URL to change. Make keeps feeding Meta instant form leads into Georgetown Leads as it does today.

The lead desk only reads the three lead tabs and writes its own CRM columns at the far right. Intake appends rows and fills columns by header name, so the two never collide.

---

## Setup, in order

Allow about 90 minutes. Do every Google and Vercel step **signed in as Vanguard's account (vanguardpharmacyinc@gmail.com)**, so the clinic owns everything.

### 1. Move the sheet to Vanguard's account

Open "Vanguard - All Leads" > **Share** > add vanguardpharmacyinc@gmail.com as Editor > menu next to it > **Transfer ownership**. Accept from Vanguard's inbox.

**Keep the personal account as an Editor afterwards.** The intake web app was deployed from it and runs as that account. If it loses edit access, every website form stops saving leads. Moving intake under Vanguard's account is a separate, later job: it means a new deployment and a new form URL on both sites, so do it when there's time to update every form.

Copy the **sheet ID** from its URL: the long code between `/d/` and `/edit`.

### 2. Google Cloud: one project, two credentials

At console.cloud.google.com, create a project called **Vanguard CRM**.

**a. Turn on the Sheets API.** APIs & Services > Library > search "Google Sheets API" > Enable.

**b. Service account (lets the app read and write the sheet).**
1. APIs & Services > Credentials > Create credentials > **Service account**. Name it `lead-desk`. Skip the optional steps.
2. Open it > **Keys** > Add key > Create new key > **JSON**. A file downloads. Keep it private; it is the key to your lead data.
3. Copy the service account's email (ends in `iam.gserviceaccount.com`).
4. In the sheet: **Share** > paste that email > **Editor** > untick "Notify" > Share.

**c. Sign-in client (lets staff sign in with Google).**
1. APIs & Services > **OAuth consent screen**: External, app name "Vanguard lead desk", Vanguard's support email, default scopes. Save, then **Publish app**.
2. Credentials > Create credentials > **OAuth client ID** > Web application.
3. Authorized JavaScript origins, add all three:
   - `https://crm.vanguardclinics.ca`
   - `https://vanguard-lead-desk.vercel.app` (your Vercel address; adjust if different)
   - `http://localhost:3000`
4. Copy the **Client ID**.

### 3. Clean up, then run setup from your computer

First, remove two leftovers from an earlier attempt:

1. In **Hanover**, **Georgetown Leads** and **Website Leads**, delete the **Call Status** and **Lead Quality** columns (all empty). Right-click the column letter > Delete column. "Lead Quality" would otherwise clash with the CRM's own "Lead quality" column, and setup will stop until they're gone.
2. In the sheet's Apps Script project (Extensions > Apps Script), delete the file **LeadStatusSetup.gs**. Leave **Code.gs**, the intake script, untouched.

Then:

```
npm install
cp .env.example .env
```

Fill in `.env`: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY (the `private_key` value from the JSON file, in double quotes, keeping the `\n`), GOOGLE_CLIENT_ID, and a long random CRON_SECRET. The app tolerates a badly pasted key (surrounding quotes, literal `\n`, Windows line breaks), but paste it cleanly anyway.

```
npm test        # 39 checks, no Google needed
npm run setup   # adds columns and tabs to the real sheet
```

Setup prints what it did. It also warns if any columns hold data without a header, and places the CRM columns after them so nothing is overwritten. Check the sheet: 32 new columns at the right of all three lead tabs (an existing sheet that already has the first 27 just gets the 5 new ones: Assigned at and four Edited columns), and three new tabs, **CRM Activity**, **CRM Staff** and **CRM Settings**. It also sets the sheet's time zone to Toronto if it wasn't already. Running it again is safe.

Open **CRM Settings** and check the opening hours and **CLOSED_DATES** for both sites.

### 4. Put the code on GitHub

Create a private repo (for example `vanguard-lead-desk`) and push this folder. `.env` is excluded by `.gitignore`; never commit it.

### 5. Vercel

1. Create a Vercel account for Vanguard and choose the **Pro** plan (the free plan doesn't allow commercial use). Invite yourself as a member.
2. **Add New > Project** > import the repo. Framework preset: **Other**. Leave build settings empty.
3. **Environment Variables**, add each from your `.env`: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_ID, CRON_SECRET, and MAKE_WEBHOOK_URL once you have it (step 8).
4. **Deploy.** Open the `.vercel.app` address and you should see the sign-in page.

Every push to the main branch redeploys automatically.

### 6. Connect crm.vanguardclinics.ca

1. Vercel project > **Settings > Domains** > add `crm.vanguardclinics.ca`.
2. Vercel shows a **CNAME** record. Add it where vanguardclinics.ca's DNS is managed (HostPapa: cPanel > Zone Editor > Add Record > CNAME, name `crm`, value as Vercel shows).
3. Wait for Vercel to show it as valid. SSL is automatic.

The main website is untouched.

### 7. Add staff

In **CRM Staff**, one row per person: Google email, first name, location (**Georgetown**, **Hanover**, or **Both** for managers and you), role, Active **TRUE**.

Roles: **Staff** works leads at their site. **Lead** can also reassign a lead to another active person at that site. **Admin** can do all of that plus assign website leads that arrived with no location, and open the owner's report.

Any Google account works. Someone without one can create a free account with their work email at accounts.google.com/signup. Set Active to **FALSE** to remove access; it takes effect within a minute.

### 8. Email through Make and Brevo

**Welcome email:** in your existing Make intake scenarios, after the row is added, send the location's welcome email through Brevo, then write the time into **Welcome sent at**.

**Everything else** comes from the CRM. Create a Make scenario starting with a **Custom webhook**, put its URL in Vercel's MAKE_WEBHOOK_URL, and route by `event` and `location`:

| `event` | When | Email |
|---|---|---|
| `marketing_tried` | Call 3 unanswered, lead moves to Marketing only | We tried to reach you |
| `marketing_checkin` | 7 days later (daily job, 10am) | Check-in |
| `follow_up_info` | Moved to Follow-up later | Information |
| `booked` | Intake booked or moved | Confirmation, plus reminder 24 hours before `appointment` |
| `no_show` | Marked No-show | Reschedule |
| `registered` | Marked Registered | Registration confirmed |

Each event carries only `event`, `crmId`, `location`, `firstName`, `email`, `appointment`, `followUp`. No reason, notes or anything about health.

### 9. Test before telling staff

- [ ] **Intake still works:** submit a test form on the website, the Hanover landing page and the Georgetown landing page, and confirm each row lands in the right tab
- [ ] Sign-in works; an email not on CRM Staff is refused
- [ ] Your location's leads show; the other site's don't
- [ ] Opening a lead fills **First opened at / by** in the sheet
- [ ] Tapping the number fills **Call 1 at**
- [ ] No answer moves the lead to Calling with call 2 due 3 hours later
- [ ] Three unanswered calls move it to Marketing only and Make receives `marketing_tried`
- [ ] Spoke to them moves it to Contacted; notes and lead quality save
- [ ] Booking on a no-doctor day shows the warning
- [ ] **CRM Activity** records each step
- [ ] 30 minutes idle signs you out

Then add your test email to **EXCLUDE_EMAILS** in CRM Settings.

### 10. On staff phones

Open crm.vanguardclinics.ca, then **Share > Add to Home Screen** (iPhone) or **menu > Install app** (Android). It opens full screen with the Vanguard icon. Nothing about leads is stored on the phone.

---

## Sessions

Staff sign in with Google once. The server then issues its own session cookie (`__Host-vg_session`: HttpOnly, Secure, SameSite=Strict) that lasts the working day. Defaults, all optional environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_HOURS` | 12 | Hard limit. After this the person signs in again, however active they are. |
| `IDLE_MINUTES` | 30 | Signs out after this long without a click or keystroke. Checked on the server as well as in the browser. The automatic 60-second refresh does not count as activity. |
| `SESSION_SECRET` | falls back to `CRON_SECRET` | Signs the cookie. Set your own long random value in Vercel if you can; changing it signs everyone out. |

The cookie holds only an email and timestamps, never lead data or a role. **CRM Staff is re-read on every request** (cached up to 30 seconds), so setting Active to FALSE locks that person out within about a minute, not when their session ends.

## Features for leads and owners

- **Search** (top bar): name, phone or email, across every stage, in the signed-in person's location only. Phone search ignores spaces, dashes, brackets and a leading +1. Untouched old leads hidden by SHOW_LEADS_FROM are still found.
- **Unassigned** (Admin): Website Leads rows whose Location is blank or not Georgetown/Hanover. Assigning writes the Location column, logs it in CRM Activity, and starts the call 1 clock from that moment (the **Assigned at** column), not from the original timestamp.
- **Reassign** (Lead and Admin): in an open lead, hand it to another active person who works that location. Sets Owner and logs old and new.
- **Report** (Admin): weekly (Monday to Sunday, Toronto time), per location: leads, median time to first call, call 1 on time, contact rate, Marketing only rate, booked rate, no-show and registered rates, lost reasons, and lead quality by campaign. Leads count in the week they arrived or were assigned. No-show and registered rates are out of leads that were booked. A lead that was a no-show and then rebooked counts as booked, not no-show, because only the current stage is kept.
- **Edit details** (everyone): correct a lead's name, phone or email. The intake columns are never changed. The correction is saved in the **Edited first name / last name / phone / email** columns, the CRM shows it everywhere, and the old and new values go to CRM Activity. Putting the original value back clears the correction.

## Good to know

- **Old leads** all show as New at first. Set **SHOW_LEADS_FROM** (YYYY-MM-DD) in CRM Settings to start with a clean queue; older untouched leads stay in the sheet, just hidden.
- **Website Leads** appear once their Location column says Hanover or Georgetown.
- **Duplicates** (same phone or email within 30 days) show as one lead, "Submitted 2 times".
- **Don't hand-edit the CRM columns** in the sheet; it can confuse the call cadence.
- **Don't rename CRM column headers.** The app finds columns by name, so moving them is fine and renaming breaks them.
- **Speed:** each action takes roughly half a second, mostly the Google Sheets API.

## Moving to Supabase later

Only `lib/store/sheets.js` knows about the sheet. Write `lib/store/supabase.js` with the same seven functions (`context`, `listLeads`, `update`, `updateMany`, `addLead`, `log`, `activity`), change one import in `lib/crm.js`, and point Make at Supabase. The dashboard, the funnel rules and the tests stay the same.
