# Sale Book v1 — build brief for Claude Code

**Goal:** take the working prototype from a single-device page to a real product where Conor, Nick, Larry and Perry each sign in and see each other's work, on any device, including with no signal at a barn.

**The date that governs everything:** Book 1 sells **14 September 2026**. Yearlings are on the grounds and inspected several days before that — confirm the exact day with Conor, but assume it must work by **10 September**. That is **six days** from now. Every decision below is made against that.

---

## 1. Stack — and why not Flutter

**Use: the existing web app + Supabase + Vercel. Keep it a PWA.**

Flutter was raised. It's the wrong tool for this job, for four reasons that are about this project rather than the framework:

1. **It's a rewrite in Dart.** Roughly 1,000 lines of tested vanilla JS, a validated 3.15 MB dataset and every settled interaction go in the bin. Six days.
2. **Distribution kills it.** Flutter's advantage is native iOS/Android — which means an Apple developer account, provisioning, TestFlight and review, for four users. The current model is a URL you add to the home screen, where it opens full-screen and works offline. For a team of four that is strictly better.
3. **Nobody here writes Dart.** Perry works in Python and with AI tooling; there is no one to maintain a Dart codebase after the sale.
4. **The content is text.** Pedigree pages are dense reflowing type — a browser's home ground.

A PWA gives home-screen install, offline, and instant updates with no app store. Reconsider native only if the team later wants camera-based conformation capture.

**Concretely:**

| | |
|---|---|
| Frontend | The existing page, ported. Vanilla JS is fine — **do not rewrite in React to feel modern.** If it must be componentised, do it after the sale. |
| Backend | Supabase (Postgres + Auth) |
| Hosting | Vercel, or Netlify. Static — no SSR needed, there's no SEO and every user is authenticated |
| Offline | Service worker for the shell + catalog; IndexedDB write queue |

---

## 2. What to port, what to leave alone

The source zip has `tpl_head.html` (all CSS), `tpl_app.js` (all logic), `build.py`, and a pre-built `catalog.json`.

**Reuse as-is:** every screen, the render loop, the colour and verdict system, search, compare, shortlists, the sheets. These have been through several rounds with the client and are settled.

**Replace only the storage layer.** In `tpl_app.js` it is deliberately narrow: `loadLocal()`, `saveLocal()`, and the mutators `setVerdict`, `addNote`, `editNote`, `deleteNote`, `newList`, `renameList`, `deleteList`, `toggleInList`, `addManyToList`. Everything else reads through `verdicts()`, `notesFor()`, `allLists()`. Swap what sits behind those and the UI is untouched.

---

## 3. Data model

```sql
-- people
profiles           id uuid pk (= auth.users.id), display_name text

-- one row per person per horse; no conflict is possible by construction
verdicts           hip int, user_id uuid, verdict text check (in|maybe|out),
                   updated_at timestamptz, primary key (hip, user_id)

-- append-only; soft delete so a deletion syncs rather than resurrecting
notes              id uuid pk, hip int, user_id uuid, body text,
                   created_at, edited_at, deleted_at

-- item rows, NOT an array column: two people adding different horses
-- to the same list must not clobber each other
lists              id uuid pk, name text, owner_id uuid, created_at, updated_at, deleted_at
list_items         list_id uuid, hip int, added_by uuid, added_at, position int,
                   primary key (list_id, hip)
```

**Verdicts stay per-person and are never merged.** If Conor marks In and Nick marks Out, show both. Two experts split on one horse is the most valuable row in the app — resolving it into a house view destroys the signal. The UI already has `teamVerdict()` waiting for this.

**RLS:** this is one four-person operation, not a multi-tenant SaaS. Any authenticated user reads and writes all rows. Do not build org scoping.

---

## 4. Auth

**Email + password, accounts created by Perry in the Supabase dashboard.** Sign in once at a desk; the session persists.

Do **not** use email magic links. The failure mode is a man at a barn with no signal who has been logged out and now needs to receive an email. Password auth survives on a cached session.

Keep the existing name picker as the first-run screen only if it maps to the signed-in user — otherwise drop it.

---

## 5. Offline — the part that actually matters

This is the requirement that makes or breaks it at a barn. Build it first, not last.

- **Local-first writes.** Every mutation writes to IndexedDB immediately and renders instantly. Never block the UI on the network.
- **Outbox.** Queue each mutation; flush on reconnect and on an interval. Retry with backoff.
- **Reads.** Hydrate from the local cache on open, then reconcile from Supabase in the background. The app must be fully usable before any request completes.
- **Conflict.** Verdicts are keyed `(hip, user_id)` — last write from that person wins, which is correct. Notes are append-only. `list_items` are per-row, so concurrent adds merge naturally. There is no merge UI to build.
- **Visible sync state.** Keep the existing sync bar and make it honest: pending count, last synced, and a clear offline indicator. Field tools that hide sync state are how a day's work disappears silently.

---

## 6. The catalog

3.15 MB of static reference data. **Do not put it in Postgres for page load** — it never changes during a sale and would make every open slow.

Ship `catalog.json` as a static asset, precached by the service worker, versioned by filename so an update busts the cache.

**Then restore the deep pedigree.** 3rd and 4th dams were cut only because a single-file artifact had to embed everything. With a backend: put the full page text in a `horse_pages` table (hip, full text) and fetch per hip on demand, caching locally. That closes the gap Perry noticed against Keeneland's site. Regenerate from the catalog PDF with `extract.py` — raise the character caps and add `d3`/`d4`.

---

## 7. Fix on the way through

- **Shortlist "Copy link" copies the app URL, not the list.** Make it a real shared link, or remove the button.
- **Dead teammate-verdict code** in `rowHTML` — this becomes live and correct once sync exists.
- Notes and verdicts currently key off a display name. Move to `user_id`.

---

## 8. Traps — read before writing code

These are all things that already bit this build:

1. **Test at 320px, 390px and 1440px, every time.** Check `document.documentElement.scrollWidth` for horizontal overflow.
2. **Offline is not a feature flag.** Test with the network actually off, then restored, and confirm nothing is lost.
3. Keep the two-tap confirm pattern instead of `confirm()` dialogs — it is better UX than a modal and it is what the client has now been trained on.
4. **Do not redesign.** The colour system, the 44px targets, the verdict wording and the inline catalog toggle were each chosen with the client for a stated reason. The handoff doc records why.

---

## 9. Sequence

| | | |
|---|---|---|
| 1 | Supabase project, schema, RLS, four accounts | 0.5 day |
| 2 | Auth + swap the storage layer behind the existing functions | 1 day |
| 3 | Offline queue + service worker + honest sync UI | 1.5 days |
| 4 | Deploy to Vercel, install as PWA, test on real phones over cellular | 0.5 day |
| 5 | Deep pedigree (3rd/4th dam) restored via the backend | 0.5 day |
| 6 | Buffer for feedback from Conor and Nick | 2 days |

**Ship 1–4 first and get it in Conor's hands.** Deep pedigree is a genuine improvement but nobody misses it at a barn; sync failing on sale day would be fatal.

---

## 10. Acceptance — the tests that decide whether it is done

1. Conor marks hip 49 In on his phone. Nick opens the app on a different phone, different account, and sees Conor's verdict within a minute.
2. Conor marks twenty horses **in airplane mode**, closes the app, reopens it, restores signal. All twenty sync. None are lost.
3. Larry opens a shortlist on a laptop he has never used and sees the current list.
4. Conor and Nick add different horses to the same shortlist at the same time. Both survive.
5. Cold load over cellular is under five seconds; second load is instant.
6. Conor marks In, Nick marks Out on the same horse. Both verdicts are visible. Neither overwrites the other.

---

## What to hand Claude Code

1. `sale-book-source.zip` — templates, logic, build scripts, prebuilt catalog, test harness
2. `Sale Book - Session Handoff.md` — full feature spec, data provenance, constraints
3. This brief
4. Supabase project URL + anon key + service role key; Vercel account
5. Any feedback that has come back from Conor, Nick or Larry — **that outranks everything above**
