# West Paces Sale Book — session handoff

Everything a fresh session needs to pick this up. Written 4 Sep 2026.

---

## 1. The engagement

Perry Kramer (General Solutions) is building an AI-augmented yearling selection tool for **Larry Connolly**'s racing operation (West Paces Racing LLC), with bloodstock agent **Conor Foley** and **Nick Esler** as the hands-on users. Four phases, $3,000. Project docs live in the "Winning Horses" Claude project — read `Phase 1 - Scoping.txt` first.

**The sale:** Keeneland September Yearling Sale, **14–26 September 2026**, 4,642 yearlings. Confirmed from Keeneland's own page data — an earlier microsite table showing a Sept 9 start was stale.

**The workflow this serves** (from Phase 1): the team sees ~400 yearlings a day, cuts to a longlist of ~80 on conformation, then to ~20 they'll bid on. This tool supports that funnel. It is explicitly *one more input*, never a replacement for Conor's eye.

**Two tracks:** this UI prototype, and a separate Phase 2 scoring model (predicting peak Equibase Speed Figure for dirt routes) that does not exist yet. The UI reserves an empty slot for its score.

---

## 2. The live prototype

**URL:** https://claude.ai/code/artifact/a78e5ab4-0e1b-410b-8e0e-3dc40b1fa078
Title *West Paces Sale Book*. Runtime contract `0.2.31`, **no capabilities declared**, **sharing: public**.

> **To update it you MUST pass that URL as the Artifact tool's `url` parameter.** Publishing without it creates a *separate* artifact and Conor's link goes stale.

Two other artifacts exist, both superseded — don't publish to them:
- `ca3cf80e-427a-4788-9413-0f6281648067` — earlier build that declared capabilities. Abandoned because **declared capabilities block public sharing**. May hold a little of Perry's test data.
- `ee386b86-f7f5-4db3-90a8-a1480c72c63f` — the wireframe canvas (13 artboards, Claude Design preview). Historical.

---

## 3. Data

All real, no placeholders. 3.22 MB page, all of it embedded (see §5).

| | |
|---|---|
| Hips | 4,642 — the complete 30 Aug catalog |
| Source | `catalog08_30_2026.csv` + the 88 MB `Keeneland_Catalog_2026.pdf`, parsed with `pdftotext` |
| Coverage | colour, sex, foaling date, sire record, 1st dam, 2nd dam — **100%** |
| Barns | 46, all single. Combined groups eliminated |
| Books | 5 books / 12 sessions, hip ranges from Keeneland's `HipGrouping202702.pdf` — all 4,642 assigned, zero gaps |

**Known data facts a new session should not re-litigate:**

- **Page number ≠ hip number** in the PDF. Hips 185–189 and 378–380 don't exist; those gaps fall exactly on session boundaries. The parser reads "Hip No." off each page.
- **CSV and printed catalog disagree on 976 hips' barns.** The catalog prints two barns for 971 (consignors spanning adjacent barns); the CSV assigns one. CSV wins — it's the newer export. The catalog was used only to resolve 57 hips the CSV left combined, via the single overlapping barn. ~1,000 horses show "(prints Barn 3 & 4)" so nobody hunts the wrong barn.
- **32 hips are genuinely ambiguous** — both sources name the same two barns. Listed under the lower number, with the printed note.
- **3rd and 4th dams are deliberately excluded**, and 2nd dam is clipped at 420 characters. All four uncapped is 9.7 MB of text alone, which would take the page to ~10 MB. Perry knows; it is the top reason to move to a real backend.

---

## 4. Feature spec

Identity: name picker on first open (Conor / Nick / Larry / Perry), remembered per device. Notes are attributed to it.

**Barns** — 46 barns with hip counts and per-barn progress. Tap into a barn for the triage list.

**Barn list ("Direction B", chosen by Conor over two alternatives)** — every horse in the barn stays visible; tapping one expands it in place. Row shows a coloured edge bar, hip number, sire × dam, and an empty score slot on the right.

- **Verdict:** In / Maybe / Out. **Green / amber / red**, plus the word (IN, MAYBE, OUT) on every marked row — colour never carries the meaning alone, because red/green is the commonest colour-blindness collision and this is the app's primary signal. Colour means verdict and nothing else; all other chrome is ink on paper.
- **Catalog page** is a *toggle* that expands the pedigree inside the open horse. It does not navigate away — that would lose your place in the barn, which is the whole reason Direction B was chosen.
- **Notes**, attributed and timestamped, editable and deletable in place. Edited notes are flagged "edited". Two-tap delete.
- **Filters:** All / Unseen / In / Maybe / Out.
- **Select** mode → multi-select → *Compare* or *Add to shortlist*.

**Compare** — two to four horses side by side, from a barn or a shortlist. Aligned bands (the horse / where / sells / sire record / 1st dam / 2nd dam / notes) so the eye travels across a row. In/Maybe/Out on each column. Flags a shared sire, and the earliest foal. Past four it stops offering; four 160px columns is the honest limit on a phone.

**Search** — number pad for hip lookup, exact match pinned above prefix matches. On a laptop the physical keyboard works: digits, backspace, Escape to leave, and typing a letter switches to text mode. Text search covers sire, dam, consignor **and the full text of every pedigree page** — "storm cat" returns 126 hips. Opening search always starts empty; back returns to the screen you came from with its filter intact.

**Shortlists** — three sections. *From your verdicts*: Marked In / Marked Maybe, computed live, nothing to create. *Marked In, by book*: appears only where you've marked horses, with sale dates. *Your shortlists*: named lists, created via an in-app sheet with tappable suggestions. Auto lists are read-only but "Save as shortlist" copies one into an editable list. Rename, remove, two-tap delete. Export renders a CSV into a copy box.

**Horse page** — reached from search or a shortlist. Full reflowed catalog page: colour, sex, foaling date, consignor, barn, book/session/sale date, sire record, 1st and 2nd dam, engagements, state foaled.

---

## 5. Architecture, and the constraints that shaped it

Single self-contained HTML page published as an Artifact. **No framework, no build step beyond a Python concat.** Vanilla JS, one `render()`, event delegation on `#app`.

**Why it's built this way — do not "fix" these without reading:**

1. **A published artifact has no backend and its CSP blocks all outbound fetch.** So the entire catalog is embedded in the page. Every byte is a byte Conor downloads at a barn on cellular. This is why dam depth was cut.
2. **Declared capabilities block public sharing.** An earlier build used the artifact self-publish capability for cross-device sync; enabling the public link meant deleting that. Consequence: **nothing syncs between users.** Verdicts, notes and shortlists are `localStorage`, per device. Conor's marks never reach Nick.
3. **`prompt()` and `confirm()` silently fail** in the sandboxed iframe — they return `null` and `false` with no error. This shipped three dead buttons once. All naming and confirmation is in-app UI. **Never use them.**
4. **Page-initiated downloads are inert** in the viewer sandbox. Export is a copy box, not a file.

### Testing — two harnesses, both needed

- `sandbox_test.html` — the page inside `<iframe sandbox="allow-scripts">`. This is what the published artifact actually runs in, and the only place `prompt()` failures show up. **localStorage cannot work here** (opaque origin), so persistence "failures" in this harness are the harness, not a bug.
- `test_local.html` over `python3 -m http.server` — real origin, no `window.claude`. Use this for persistence.

Test at 320px, 390px and 1440px. Check `document.documentElement.scrollWidth` for horizontal overflow every time.

### Source

`sale-book-source.zip` accompanies this file. Rebuild with:

```
python3 build_data.py      # PDF text + CSV -> catalog.json   (needs full.txt from the PDF)
python3 build.py           # tpl_head.html + tpl_app.js + catalog.json -> west-paces-keeneland.html
```

`catalog.json` is included pre-built, so `build.py` alone regenerates the page. `full.txt` (14.5 MB of `pdftotext` output) is not bundled — regenerate from the PDF on Perry's laptop if the data needs changing.

---

## 6. Open items

**Two things in the shipped build actively mislead** — Perry has been told, not yet fixed:
- A shortlist's **"Copy link" copies the app URL, not the list.** Whoever receives it gets an empty copy of the app.
- Row code still renders a teammate's verdict. It can never fire (the shared layer is permanently empty) but implies a feature that doesn't exist.

**Awaiting Conor, Nick and Larry** — a feedback note was drafted (`NOTE_TO_TEAM.md`) asking what to keep / change / remove, with pointed questions on each feature. The one that matters most: **is barn order how they actually move through a day, or do they work in hip order?** That answer reshapes the first screen.

**The real next build:** Supabase + Vercel. Perry already chose it. It fixes, in one move, everything above — genuine multi-user sync, no page-size ceiling so 3rd and 4th dams come back, and no Claude accounts for anyone. Roughly a day once Perry supplies the accounts. Design note for it: **Conor In / Nick Out should not be merged.** Two experts split on one horse is the most valuable row in the app.

**Not built, decided against for now:** max bid per horse on a shortlist (Perry: "not yet").
