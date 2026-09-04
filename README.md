# West Paces Sale Book

**https://yearling-selection.vercel.app/**

Keeneland September yearling selection for West Paces Racing. Four people — Conor, Nick,
Larry and Perry — walking 4,642 yearlings across 46 barns, marking In / Maybe / Out,
keeping notes and shortlists, and seeing each other's work.

It is a PWA: add it to a phone's home screen and it opens full-screen and works with no
signal. **Book 1 sells 14 September 2026.**

---

## The one thing to understand

**Nothing waits on the network.** Every mark, note and shortlist change is written to the
phone first and rendered immediately, then queued in an outbox that drains when there is
signal. A man at a barn with no bars marks twenty horses, closes the app, drives out, and
they sync. The sync bar tells the truth about what has and has not been sent, always.

The second thing: **verdicts are per person and never merged.** If Conor marks a horse In
and Nick marks it Out, both are shown, side by side, with initials. Two experts disagreeing
about one horse is the most valuable row in the app; averaging it away would destroy the
signal.

---

## Layout

```
public/            everything that gets deployed — this is the whole site
  index.html       the shell
  app.css          all styling (ported unchanged from the artifact build)
  app.js           all UI: screens, render loop, search, compare, shortlists
  store.js         IndexedDB + outbox + Supabase sync            ← the heart of it
  auth.js          email/password sign-in
  sw.js            service worker: precaches the shell and the catalog
  config.js        Supabase URL + publishable key (both public by design)
  data/            catalog.v1.json — 4,642 hips, versioned by filename
  vendor/          supabase-js, vendored so sign-in works from cache
  fonts/           IBM Plex, self-hosted so type survives with no signal
db/001_schema.sql  tables, indexes, triggers, row level security
tools/             catalog rebuild scripts, local dev server
tests/             the six acceptance tests, plus a Supabase stub
```

There is **no build step**. The files in `public/` are the files that get served. This was
deliberate: fewer moving parts between a fix and a phone on sale day.

## Running it locally

```
npm install                 # only needed for the tests
node tools/serve.js         # http://127.0.0.1:8080, against the real project
npm test                    # the acceptance suite, against a local stub
```

`npm test` never touches live data — it runs the app against `tests/fake-supabase.js`, a
small stand-in for the endpoints the app actually calls.

## Deploying

Vercel, static, no build command, output directory `public/`. `vercel.json` carries the
cache headers: the catalog and fonts are immutable (they are versioned by filename), `/`
and `sw.js` are never cached, so an update reaches installed phones.

Push to the production branch and Vercel redeploys. Nothing else to do.

**Do not turn on `cleanUrls`.** It makes Vercel answer `/index.html` with a 308 to `/`, and
a redirected response cannot fulfil a navigation request. A service worker holding the
shell under that key opens fine on a local server and fails to open at a barn. The worker
now caches the shell under `./` only, and `tests/static.js` reproduces the redirect so the
suite would catch a regression — but the setting is a trap and there is nothing to gain
from it, since the site has one HTML file.

### Checking a deploy before it goes to the team

Open the production URL in a **private window**. If it asks you to log in to Vercel,
Deployment Protection is on and Conor is locked out: Settings → Deployment Protection.

Then, on a phone — this takes five minutes and is the only test that exercises the real
stack end to end:

1. Open it, sign in, **Add to Home Screen**, and reopen it from the home screen. Tap the
   avatar: under BUILD the sheet must read **`salebook-v2 · offline ready`**. If it says
   *Not installed yet*, nothing is cached and step 4 will fail. If it says *Update ready*,
   close the app and reopen it, then look again.
2. Mark a horse In. The bar reads *Synced just now*.
3. **Airplane mode.** Mark five more. The bar must read *5 changes held — no signal*.
4. **Force-quit the app and reopen it, still in airplane mode.** It must open, and all six
   marks must still be there. This is the step that catches a broken offline shell.
5. Airplane mode off. The bar returns to *Synced just now* within a few seconds.
6. On a laptop, sign in as someone else. The verdicts appear within a minute, and marking
   one of them the other way shows both verdicts on the row, with initials.

If step 4 fails, the device is holding an older service worker: open the app once with
signal, close it, open it again, then retest. The BUILD line in the account sheet is the
way to tell — it reports the worker actually serving that device, not the version this
repo happens to be on, and those disagree precisely when something is wrong.

There is deliberately no "reset the app" button. The moment anyone would reach for one is
when something looks wrong at a barn — which is exactly when there is no signal to
re-download the shell, so it would turn a recoverable problem into a dead app with a day's
marks stranded inside it.

## Changing the catalog

The catalog only changes if Keeneland reissues theirs. Then:

```
cd tools
python3 build_data.py       # needs full.txt (pdftotext of the Keeneland PDF) + the CSV
```

Then **bump the filename** — `public/data/catalog.v2.json` — and update the two references
to it, in `public/config.js` and `public/sw.js`. The filename is the cache key; reusing it
would leave old data on phones.

## Accounts

Four accounts exist, one per person, created directly in the database. Passwords were
handed over separately and are not in this repo.

To add or change one, use the Supabase dashboard (Authentication → Users). Set
`display_name` in the user's metadata — a trigger copies it into `public.profiles`, which
is where the app reads names from. Without it the name falls back to the email's local part.

There is deliberately **no password reset email**. The addresses are `@westpaces.local`,
which receives no mail. This is not an oversight: a magic link is useless to a man standing
in a shed row with no signal. If someone is locked out, Perry sets a new password in the
dashboard. To change that, give the accounts real email addresses first.

## Database

Five synced tables plus `horse_pages`. Two design points worth knowing:

- **Nothing is ever hard-deleted.** A deleted row is invisible to an incremental
  `updated_at > cursor` pull, so it would resurrect from another device's cache. Verdicts
  clear to `NULL`; notes, lists and list items soft-delete.
- **Shortlist contents are rows, not an array.** `list_items` is keyed `(list_id, hip)`, so
  two people adding different horses to the same list at the same time simply merge.

Row level security: any signed-in user reads and writes everything — this is one
four-person operation, not multi-tenant software. The single restriction is that you cannot
write a verdict or note as somebody else. That is what makes "Conor marked this" true.

One advisory is left open on purpose: leaked-password protection (HaveIBeenPwned checking)
is off. Turn it on in Authentication → Policies if you ever move to self-chosen passwords.

## Tests

`npm test` runs the six acceptance tests from the build brief — the ones that decide
whether this is finished — plus a layout sweep at 320, 390 and 1440 px checking for
horizontal overflow on every screen.

```
1   Conor marks hip 49 In; Nick sees it on another phone, another account, within a minute
2   Twenty horses marked in airplane mode, app closed and reopened, signal restored — none lost
2b  Marks made offline hours ago still reach the other phone
2c  Sign out, sign in as someone else on the same browser, see their work
3   Larry opens a shortlist on a laptop he has never used
4   Conor and Nick add different horses to the same shortlist at once; both survive
5   Cold load under five seconds on cellular; second load instant
6   Conor In and Nick Out on one horse: both visible, neither overwrites
```

Plus: a client-supplied `updated_at` cannot influence delivery, and a pull larger than one
page arrives complete. 2b and 2c were written after both failed in production.

## Things that were deliberately not done

- **Not Flutter, not React.** A rewrite would have thrown away a settled, tested UI for no
  gain a user could see. See BUILD_BRIEF §1.
- **No redesign.** The colour system, verdict wording, 44 px targets, the two-tap confirms
  and the inline catalog toggle were each chosen with the client for a stated reason.
- **No `prompt()` or `confirm()`.** They fail silently in some contexts and shipped three
  dead buttons once. All confirmation is in-app and two-tap.
- **No Realtime subscription.** A 25-second poll, plus an immediate sync on focus and on
  reconnect, meets the requirement with far less to go wrong in a field tool.
- **3rd and 4th dams are still missing.** This needs `full.txt`, the 14.5 MB `pdftotext`
  dump of the Keeneland catalog, which is not in the repo. The `horse_pages` table exists
  and is empty, ready for it. Nobody misses it at a barn.
