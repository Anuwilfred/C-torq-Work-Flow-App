# C-TORQ Work Flow — setup & publish guide

## v3.6: Projects opened up to everyone + sharing + AEON Ai awareness

- **Everyone can now view Projects, Learning, and Health Challenges** — the
  right-side rail / Admin-tab row is no longer admin-only. Creating,
  editing, or deleting a project (and setting positions) is still
  admin-only; viewing the rings and contributor list is for everyone.
- **Share to group**: at the bottom of a project's page, anyone can post its
  current status (hours used vs. budget, per role) straight into one of
  their own group chats with one tap.
- **AEON Ai now knows about project budgets** — it can answer things like
  "how much of JOB-1042's engineer budget have I used?" by combining the
  project's budget with your own logged hours. It does not know other
  people's usage on a project (that needs the full Projects dashboard scan)
  — for a full team total, it'll point you to the Projects page.
- Fixed low-contrast contributor bars/hours text in the Project detail page.
- Reconfirming something already true from earlier: AEON Ai's access to
  Aeon Teams Chat is scoped to only the groups *you* are personally in —
  never private DMs, and never a group you're not a member of. Nothing
  changed here, just flagging it since it came up.

No new SQL or secrets for this round — just re-upload the frontend files
(section 8g below) and redeploy `get-project-report` and `ai-chat`.

## v3.5: Projects dashboard (admin) — hour budgets, over-usage rings, contributors

On wide screens (laptop/desktop), admins now get a small floating rail on
the right edge of the screen with three buttons: **Projects**, **Learning**,
and **Health Challenges** (the last two are placeholders for now — tell me
what you want in them and I'll build them). On a phone, since there's no
free space for a side rail, the same three buttons appear as a row at the
top of the **Admin** tab instead.

- **Projects**: admin creates a project with a **Job ID**, an optional name,
  and an hour budget split by role — e.g. "Engineers get 40h, Technicians
  get 60h." The New Entry form's "Job ID" field is now a dropdown built from
  this list (it used to be free text — this guarantees hours actually match
  the right project instead of being lost to a typo).
- Tap a project to open its dashboard: two Apple-Watch-style rings, one for
  Engineers and one for Technicians. Each ring fills green as hours get used
  against the budget; if someone goes over budget, the green ring stays
  full and a second, smaller **orange ring** fills to show exactly how many
  hours over (shown as a negative number, e.g. "−2.5h").
- Below the rings: a list of everyone who has logged hours on that project,
  each with a horizontal bar showing how much of the total they contributed.
- **Employee positions**: in Admin → Team, each person now has an
  Engineer / Technician / Other dropdown — this is what the rings use to
  split hours by role. Set this for your team before relying on the rings.

New one-time setup (see section 8f below):
1. Run `projects_schema.sql` in the SQL editor.
2. Deploy the new `get-project-report` Edge Function.
3. Re-upload the changed frontend files.
4. Set everyone's position in Admin → Team.

## v3.4: Real-time workflow — reminders, lunch breaks, location allowances

- **Lunch break**: a toggle on New Entry ("Lunch break") + a minutes field.
  When on, that many minutes are subtracted from the day's total hours.
- **Location allowances**: Admin tab has a "Locations & allowances" card —
  add a place (e.g. "Abu Dhabi") and how many extra hours it's worth. New
  Entry gets an "Allowance area" dropdown built from that list; picking one
  adds the extra hours automatically (looked up server-side, so it can't be
  faked). Reports now show an Allowance gauge and a Lunch/Allowance column
  in the daily breakdown table.
- **Sick leave certificate**: already enforced client-side; now also
  enforced server-side in `submit-entry` — no certificate attached means it's
  recorded as general leave no matter what.
- **Daily job assignments**: Admin tab has a "Today's job assignments" card
  — pick a person, a date, a job/project, optional location/notes, save. This
  is what the morning reminder below actually tells each person.
- **Reminders (push + email)**: two scheduled Edge Function calls a day —
  6:55am Gulf time tells each person their assigned job for the day and
  reminds them to clock in/out; an evening reminder (default 9:00pm Gulf —
  change this if you want a different time) nudges anyone who hasn't
  submitted a daily activity yet. Both go out as a system push notification
  and an email (via Resend). **WhatsApp reminders were intentionally left
  out for now** — the only ToS-compliant way to send WhatsApp messages is
  the official WhatsApp Business Cloud API, which needs a Meta Business
  verification + per-conversation cost; push notifications + email cover the
  same need for free. Ask any time if you want WhatsApp added later.

New one-time setup, in order (see section 8e below for the full walkthrough):
1. Run `location_allowances_schema.sql` and `reminders_schema.sql` in the SQL
   editor.
2. Sign up for a free Resend account, get an API key.
3. Deploy the `send-reminders` Edge Function, set its secrets.
4. Run `reminders_cron.sql` (with your project ref + secret filled in) to
   schedule the two daily reminder calls.
5. Re-upload the changed frontend files (`index.html`, `app.js`,
   `styles.css`, `service-worker.js`).

## v3.3: Team Chat (Slack/WhatsApp-style)

A new **Chat** tab: a left-hand list of conversations plus the open thread
on the right, same layout as Slack or WhatsApp Web.

- **Direct messages**: anyone can start a 1-on-1 chat with any teammate
  (💬+ button). Starting a DM with someone you already have one with just
  reopens the same conversation.
- **Groups**: only admins can create a group (👥+ button) — name it, pick
  who's in it, done.
- **Photos and PDFs**: the 📎 button attaches a file to the next message.
- Messages inside an open conversation appear **instantly** for everyone in
  it (Supabase Realtime). The conversation list itself refreshes every 20
  seconds, so new chats/previews show up without needing a manual reload.
- Runs entirely on the same free Supabase project — no new secrets, no new
  external service. Needs one new SQL file run once (`chat_schema.sql`) and
  one storage bucket created in the dashboard (both one-time setup, see
  section 8d).

## v3.2: AI chat assistant

A glowing orb in the bottom-right corner opens a chat panel (with a
full-screen "mesh" reveal animation) where anyone can ask plain-English
questions about their own saved data — e.g. "what did I work on 23/07/2026?"
or "summarize my last report." Admins can ask about anyone on the team, or
about everyone at once.

- Powered by **Google Gemini** (free tier — see section 8c to get a key).
  This is the one piece of the whole system that isn't free-forever by
  default, but Gemini's free quota is generous and there's no credit card
  needed for it.
- The AI only ever sees the entries it's allowed to: a regular user's
  questions are answered only from their own folder in GitHub; an admin's
  questions can pull from any teammate (mention their name) or the whole
  team (ask a general question with no name).
- It can also **look at attached photos and PDFs** and describe what's in
  them, not just read the text fields — this uses a small amount of extra
  free-tier quota per image.
- Nothing new is stored — every answer is generated fresh by reading
  straight from the same GitHub repos everything else already lives in.

## v3.1: Reports tab

A new **Reports** tab reads a person's timesheet + leave files straight out
of GitHub (nothing new to store or sync) and shows:

- Speedometer-style gauges: Total Hours, Overtime, Days Worked, Sick Leave,
  Holiday, Emergency Leave — all for the selected month.
- Overtime rule: **more than 8 hours in a single day counts as overtime**
  for that day; the rest counts as normal hours.
- A vertical strip of the last 12 months on the right — tap any month to
  jump to it, or use the Prev/Next arrows.
- A daily breakdown table below the gauges (date, mode, project, hours,
  overtime).
- Regular users only ever see their own report. Admins get a person picker
  at the top of the tab and can view anyone's report.

This runs on a new Edge Function, **get-report**, which reuses the same
`GITHUB_TOKEN` / repo secrets already set up for `submit-entry` — no new
secrets, no new accounts, no new service. See section 3b below to deploy it.


v3: a real Timesheet form (job ID, mode of work, leave handling, geolocation),
multi-file attachments on every entry type, a review-before-submit step, and
a full Apple-glass visual redesign. Accounts and GitHub sync work exactly as
in v2 — this is a frontend/data-shape upgrade on top of that.

## What changed from v2 → v3

- **Timesheet form**: Job ID field, plus a "Mode of work" grid with 11
  options — Office, Site, Driver, Work from Home, Exhibition, Inspection,
  Field Work, Other, Sick Leave, Holiday, Emergency Leave.
- **Work modes** (Office, Site, Driver, WFH, Exhibition, Inspection, Field
  Work, Other) show: Project, Location (auto-filled from the device's GPS via
  a free reverse-geocoding lookup, or typed manually), Date (auto-filled to
  today, editable), Start time, End time, Notes.
- **Leave modes** (Sick Leave, Holiday, Emergency Leave) show a start/end
  date range and a reason instead. Sick Leave also shows a document upload
  (PDF or image). If no document is attached, the entry is stored as a
  general **Leave** request rather than Sick Leave — this is enforced
  automatically, not just a suggestion.
- **Review step**: tapping "Review & Submit" no longer saves immediately —
  it shows a summary card of everything entered first. From there you can go
  back and edit, or confirm, which is what actually saves the entry.
- **Multi-file attachments**: Daily Progress and Project Report entries now
  accept multiple files (PDF or images) in one go, not just one photo.
- **Per-person GitHub storage**: every entry — timesheet, leave, daily
  progress, project report — is filed under that person's own folder in the
  repo, so each person's full history lives together. See the folder
  structure below.
- **New look**: dark, glassy, Apple-style UI — blurred translucent cards,
  a soft terracotta/teal gradient background, pill-shaped tab bar, chip-style
  mode picker.

## What changed from v1 → v2 (unchanged in v3)

- Regular users no longer see GitHub at all — Settings only shows their email
  and a Log out button.
- A new **Admin** tab (visible only to admins) invites teammates by email and
  shows who's accepted.
- The GitHub token now lives only in a Supabase Edge Function's secrets —
  never in a browser, never in Settings.
- Supabase Auth handles invite emails, login, and forgot-password.

## How data is organized in GitHub (v3)

Each repo now has one folder per person, and inside that, one folder per
entry category:

```
C-torq-Time-stamps-/
  Priya_Sharma/
    timesheet/2026-07-23_<id>.json
    leave/2026-07-24_<id>.json          (holiday / emergency leave / sick leave)
    leave/2026-07-24_<id>_0_report.pdf   (sick-leave document, if attached)
C-torq-Daily-updates-/
  Priya_Sharma/
    daily-progress/2026-07-23_<id>.json
    daily-progress/2026-07-23_<id>_0_photo.jpg
C-torq-Project-reports-/
  Priya_Sharma/
    project-report/2026-07-23_<id>.json
```

Every attachment is uploaded as its own file right next to the JSON entry;
the JSON only stores each file's name and path, keeping the record itself
small and readable directly in GitHub's history.

## 1. Create the Supabase project (free)

1. Go to supabase.com, create a free account and a new project.
2. Once it's ready, go to **Project Settings → API**. Copy the **Project URL**
   and the **anon public key**.
3. Open `config.js` in this folder and paste them in:
   ```js
   window.CTORQ_CONFIG = {
     SUPABASE_URL: 'https://your-project-ref.supabase.co',
     SUPABASE_ANON_KEY: 'your-anon-public-key',
     APP_URL: 'https://anuwilfred.github.io/C-torq-Work-Flow-App'
   };
   ```
   The anon key is meant to be public — it's safe in this file. Row Level
   Security (next step) is what actually protects the data.

## 2. Run the database schema

1. In Supabase, open **SQL Editor**.
2. Paste in the contents of `supabase/schema.sql` and run it.
3. This creates the `profiles` table, locks it down with Row Level Security,
   and auto-creates a profile the moment someone's invited.

## 3. Deploy the two Edge Functions

You'll need the Supabase CLI once (`npm install -g supabase`), then from this
folder:

```bash
supabase login
supabase link --project-ref your-project-ref

# Secrets for submit-entry — this is the only place the GitHub token lives:
supabase secrets set GITHUB_TOKEN=your_fine_grained_pat
supabase secrets set GITHUB_REPO_OWNER=Anuwilfred
supabase secrets set GITHUB_REPO_TIMESHEETS=C-torq-Time-stamps-
supabase secrets set GITHUB_REPO_DAILY=C-torq-Daily-updates-
supabase secrets set GITHUB_REPO_REPORTS=C-torq-Project-reports-

# Secret for invite-user — the published app URL, used in the invite email link:
supabase secrets set APP_URL=https://anuwilfred.github.io/C-torq-Work-Flow-App

supabase functions deploy invite-user
supabase functions deploy submit-entry
```

The GitHub token here is the same kind from v1 — a fine-grained PAT scoped to
just the three repos, Contents: Read/write. It now lives only as a Supabase
secret, never in anyone's browser.

## 4. Turn on email confirmations & set the redirect URL

1. Supabase → **Authentication → URL Configuration** → add your published app
   URL (e.g. `https://anuwilfred.github.io/C-torq-Work-Flow-App`) to
   **Redirect URLs**.
2. Supabase's default email templates work out of the box for invites and
   password resets — no separate email service needed. You can customize the
   templates later under **Authentication → Email Templates**.

## 5. Publish the app

Same as before: push this whole `ctorq-workflow/` folder to a repo (e.g.
`C-torq-Work-Flow-App`), enable **Settings → Pages**, and you'll get a URL
like `https://anuwilfred.github.io/C-torq-Work-Flow-App/`. Make sure this
matches exactly what you put in `config.js` and in the Supabase redirect URL
setting.

## 6. Bootstrap the first admin (you)

There's no admin yet on a brand new project — including you. Invite yourself
first:

1. In Supabase → **Authentication → Users**, click **Invite user**, enter
   your own email.
2. Check your email, accept the invite, set your password on the app.
3. Back in Supabase → **SQL Editor**, run:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
4. Refresh the app — you should now see the **Admin** tab. From here on,
   invite everyone else directly from that tab.

## 7. Test the flow end to end

1. From the Admin tab, invite a teammate's email.
2. They get an email, click the link, land on the app's "set your password"
   screen, choose a password.
3. They're in — they see New Entry / Queue / Settings (no Admin tab, unless
   you make them one).
4. Turn off their wifi, save an entry — it queues locally. Reconnect — it
   submits automatically and shows up in the matching GitHub repo, filed
   under their name.
5. Test "Forgot password" from the login screen — confirm the reset email
   arrives and the link lets them set a new one.
6. **v3 additions to test**: pick each mode chip and confirm the right
   fields show (work fields vs. leave date range); tap "Use my location" and
   allow the browser's location permission; pick Sick Leave with no document
   attached and confirm it lands in GitHub under `leave/` not flagged as
   sick; attach multiple files to a Daily Progress entry and confirm each
   shows up as its own file next to the JSON in GitHub; confirm the review
   screen appears before anything saves, and that "Back to edit" returns you
   to the form with nothing lost.

## 8. Deploying the v3 update (if upgrading from v2)

Only the **submit-entry** function's code changed — everything else (secrets,
schema, invite-user) stays as already deployed:

1. Supabase → **Edge Functions → submit-entry → Code**. Replace the code with
   the contents of `supabase/functions/submit-entry/index.ts` from this
   folder, then **Deploy**.
2. Re-upload `index.html`, `app.js`, and `styles.css` to the
   `C-torq-Work-Flow-App` GitHub repo, overwriting the existing files.
   GitHub Pages picks up the change automatically within a minute or two.
3. `service-worker.js`'s cache name was bumped — this forces everyone's
   installed app to fetch the new files on next open instead of serving the
   old cached version. Make sure this file is re-uploaded too.
4. Open the app, hard-refresh once (or just reopen it) to confirm the new
   Timesheet form and glass UI show up.

## 8b. Deploying the v3.1 Reports tab

This adds one brand-new Edge Function — it doesn't touch the two you already
have:

1. Supabase → **Edge Functions** → **Deploy a new function** (or "Create a
   function") → name it exactly **get-report**.
2. Paste in the contents of `supabase/functions/get-report/index.ts` from
   this folder → **Deploy**. No new secrets needed — it reuses
   `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, and `GITHUB_REPO_TIMESHEETS`, already
   set for `submit-entry`.
3. If Supabase shows a "Verify JWT" toggle for the new function, turn it
   **off** — same as the other two functions, since it does its own sign-in
   check inside the code.
4. Re-upload `index.html`, `app.js`, `styles.css`, and `service-worker.js` to
   the `C-torq-Work-Flow-App` repo (same drag-and-drop upload as before).
5. Open the app, go to the **Reports** tab, and confirm your own timesheet
   hours show up for the current month.

## 8c. Deploying the v3.2 AI chat assistant

**Get a free Gemini API key:**

1. Go to `aistudio.google.com/apikey` (sign in with a Google account).
2. Click **Create API key** → copy it. This is free, no credit card needed
   for the free tier.

**Set it as a Supabase secret:**

3. Supabase → **Edge Functions → Secrets** (or via CLI:
   `supabase secrets set GEMINI_API_KEY=your_key_here`).

**Deploy the new function:**

4. Supabase → **Edge Functions** → create a new function named exactly
   **ai-chat**. Paste in the contents of `supabase/functions/ai-chat/index.ts`
   from this folder → **Deploy**.
5. Turn **Verify JWT** off for this function too, same as the others.

**Push the frontend:**

6. Re-upload `index.html`, `app.js`, and `styles.css` to the
   `C-torq-Work-Flow-App` repo.
7. Open the app — a glowing orb should appear bottom-right once you're
   signed in. Tap it, ask something like "what did I work on today?", and
   confirm you get a real answer back.

## 8d. Deploying v3.3 Team Chat

**Run the schema:**

1. Supabase → **SQL Editor** → paste in the contents of
   `supabase/chat_schema.sql` from this folder → **Run**.

**Create the storage bucket:**

2. Supabase → **Storage** → **New bucket** → name it exactly
   `chat-attachments` → leave **Public bucket** turned **off** (keep it
   private — the SQL you just ran adds policies that let only people in a
   given chat see or upload its files).

**Push the frontend:**

3. Re-upload `index.html`, `app.js`, and `styles.css` to the
   `C-torq-Work-Flow-App` repo.
4. Open the app, go to the new **Chat** tab. Test: start a DM with a
   teammate (💬+), send a text message and a photo, and confirm it shows up
   on their side too (have them refresh or check on their device). If
   you're an admin, also test creating a group (👥+) with a couple of
   people.

## 8e. Deploying v3.4 (lunch break, allowances, daily assignments, reminders)

**Run the new SQL:**

1. Supabase → **SQL Editor** → paste in `supabase/location_allowances_schema.sql`
   → **Run**.
2. Same again with `supabase/reminders_schema.sql` → **Run**.

**Push the frontend:**

3. Re-upload `index.html`, `app.js`, `styles.css`, and `service-worker.js` to
   the `C-torq-Work-Flow-App` repo. Try New Entry: toggle lunch break, pick
   an allowance area (add one first from Admin → Locations & allowances if
   the list is empty). As an admin, go to Admin → Today's job assignments
   and assign yourself a job for today.

**Set up Resend (free email sending):**

4. Go to resend.com → sign up (free) → **API Keys** → create one, copy it.
   Until you verify your own domain there, emails can only be delivered to
   the address you signed up with — fine for testing, but for real use
   you'll want to verify a domain (Resend walks you through adding a couple
   of DNS records).

**Deploy the reminders function:**

5. Supabase → **Edge Functions** → create a new function named exactly
   **send-reminders**. Paste in `supabase/functions/send-reminders/index.ts`
   → **Deploy**. Turn **Verify JWT** off (same as the other functions —
   this one checks its own secret instead).
6. Set its secrets:
   ```
   supabase secrets set REMINDER_CRON_SECRET=make_up_any_random_string_here
   supabase secrets set RESEND_API_KEY=your_resend_api_key
   supabase secrets set RESEND_FROM="C-TORQ Work Flow <onboarding@resend.dev>"
   ```
   (`VAPID_*`, `GITHUB_TOKEN`, `GITHUB_REPO_*` are already set from earlier
   steps — this function reuses them.)

**Schedule it:**

7. Open `supabase/reminders_cron.sql`, replace `YOUR-PROJECT-REF` with your
   project's reference ID (Settings → General) and `YOUR-SECRET-HERE` with
   the same string you used for `REMINDER_CRON_SECRET` above, then run it in
   the SQL Editor.
8. Times are UTC in that file — 02:55 UTC = 6:55am Gulf time, 17:00 UTC =
   9:00pm Gulf time. The 9pm evening time was picked as a reasonable
   "before bed" nudge and wasn't explicitly requested — change the cron
   schedule if you want a different time.
9. To confirm it's wired up correctly without waiting for the actual time,
   you can trigger it manually once from a terminal:
   ```
   curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-reminders \
     -H "Content-Type: application/json" \
     -H "X-Reminder-Secret: YOUR-SECRET-HERE" \
     -d '{"mode":"morning"}'
   ```
   You should get back `{"ok":true, ...}` and see a push/email land for
   anyone with an active push subscription or a valid email.

## 8f. Deploying v3.5 (Projects dashboard)

**Run the new SQL:**

1. Supabase → **SQL Editor** → paste in `supabase/projects_schema.sql` →
   **Run**.

**Deploy the new function:**

2. Supabase → **Edge Functions** → create a new function named exactly
   **get-project-report**. Paste in
   `supabase/functions/get-project-report/index.ts` → **Deploy**. Turn
   **Verify JWT** off, same as the others.

**Push the frontend:**

3. Re-upload `index.html`, `app.js`, `styles.css`, and `service-worker.js`
   to the `C-torq-Work-Flow-App` repo.

**Set it up:**

4. Go to Admin → Team → set each person's position (Engineer / Technician /
   Other).
5. Look for the floating rail on the right edge of the screen (desktop) or
   the row of buttons at the top of the Admin tab (phone) → tap
   **Projects** → create one: a Job ID, optional name, and hour budgets for
   Engineer and Technician.
6. Have someone submit a New Entry timesheet picking that project from the
   "Project / Job ID" dropdown, then reopen the project — you should see
   their hours reflected in the ring and in the contributor list below it.

## 8g. Deploying v3.6 (Projects for everyone, sharing, AEON Ai project awareness)

No new SQL. Two functions need re-deploying and the frontend needs
re-uploading:

1. Supabase → **Edge Functions** → **get-project-report** → replace the code
   with the updated `supabase/functions/get-project-report/index.ts` →
   **Deploy**.
2. Supabase → **Edge Functions** → **ai-chat** → replace the code with the
   updated `supabase/functions/ai-chat/index.ts` → **Deploy**.
3. Re-upload `index.html`, `app.js`, `styles.css`, and `service-worker.js`
   to the `C-torq-Work-Flow-App` repo.
4. Test: sign in as a non-admin teammate and confirm they can see Projects
   (but not create/delete one), open a project, and use "Share to group."

## 9. Known limitations (v3)

- WhatsApp reminders aren't included — push notifications + email cover it
  for free; WhatsApp would need the official Business Cloud API (Meta
  business verification + per-message cost).
- Removing someone's access today means deleting their user in Supabase
  Authentication → Users (a "revoke access" button in the Admin tab is a
  natural future addition).
- The very first admin promotion (step 6) is the one manual, one-time step
  in the whole system — everything after that is done from inside the app.
- Location fetch requires the browser/device to grant location permission;
  if denied, location can still be typed in manually.

## 10. What's next

- Reminder Job: scheduled GitHub Action or Supabase cron function that reads
  `profiles` + the three repos, flags who's missing an entry, emails them.
- Report Job: weekly scheduled job that aggregates all three repos into a
  styled HTML report (charts, icons), published to GitHub Pages.
- Admin "revoke access" button, and a way to promote/demote admins from the
  Admin tab instead of SQL.
