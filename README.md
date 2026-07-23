# C-TORQ Work Flow — setup & publish guide

v2: adds real accounts. An admin invites people by email, they confirm and set
their own password, log in, and submit entries — no GitHub account, no GitHub
token, ever touches their side. GitHub still holds the data underneath, but
only a server-side Edge Function talks to it now.

## What changed from v1

- Regular users no longer see GitHub at all — Settings only shows their email
  and a Log out button.
- A new **Admin** tab (visible only to admins) invites teammates by email and
  shows who's accepted.
- The GitHub token now lives only in a Supabase Edge Function's secrets —
  never in a browser, never in Settings.
- Supabase Auth handles invite emails, login, and forgot-password.

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

## 8. Known limitations (v2)

- Photos are still embedded as base64 inside the entry — keep them small;
  large ones will fail at the Edge Function/GitHub layer.
- No reminder emails or weekly report yet — still the next build step, and
  now easier: a scheduled job can use the same `profiles` table to know who
  to remind.
- Removing someone's access today means deleting their user in Supabase
  Authentication → Users (a "revoke access" button in the Admin tab is a
  natural v3 addition).
- The very first admin promotion (step 6) is the one manual, one-time step
  in the whole system — everything after that is done from inside the app.

## 9. What's next

- Reminder Job: scheduled GitHub Action or Supabase cron function that reads
  `profiles` + the three repos, flags who's missing an entry, emails them.
- Report Job: weekly scheduled job that aggregates all three repos into a
  styled HTML report (charts, icons), published to GitHub Pages.
- Admin "revoke access" button, and a way to promote/demote admins from the
  Admin tab instead of SQL.
