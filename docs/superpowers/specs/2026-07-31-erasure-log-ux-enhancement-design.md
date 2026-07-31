# Erasure evidence log — UX enhancement (triage + progressive disclosure + search)

**Date:** 2026-07-31
**Author:** brainstorming session (Jirawat + Claude)
**Status:** design — pending user review (enterprise-ux-designer review round 1 folded in)
**Scope area:** `src/app/(staff)/admin/compliance/erasure-log/**` + `src/modules/insights/application/erasure-evidence.ts` + `src/i18n/messages/{en,th,sv}.json`

## Problem

The DPO erasure-evidence log (`/admin/compliance/erasure-log`) is a read-only,
admin-only accountability view — one card per erased member, each showing the
full Article 17 evidence. It renders correctly but the **UX does not serve the
DPO's primary job**: *"are there any overdue/half-run erasures (reportable
breaches) right now, and where?"*

Concrete gaps (2026-07-31 UX audit):

- **No triage.** No at-a-glance count of overdue / in-progress / complete. An
  `OVERDUE` erasure (past the 30-day PDPA §30 window = a reportable breach) is
  ordered strictly newest-`erased_at`-first, so an old overdue card can sit
  **buried below** newer complete ones — exactly the item that must surface first.
- **No filter / no search.** To find a specific member's erasure or all overdue
  ones, the DPO scrolls the whole list.
- **Uniform verbosity.** Every card renders all five evidence sections fully
  expanded, even a routine complete erasure — the page is tall and hard to scan.
- **Flat visual hierarchy.** A complete and an overdue card differ only by a
  small status badge.

This is a **presentation + Application-read enhancement**, not a schema or
evidence-content change. Copy source of truth is **EN** (`en.json`); **TH + SV
mirror** it. No Article 17 evidence field is added, removed, or reinterpreted.

## Non-goals (explicitly out of scope)

- **CSV / PDF export.** Considered and cut from v1 (see Decisions §6). Export is
  the heaviest, highest-risk piece (PII egress → full security review, a new
  route + rate-limit + contract tests). **Print-to-PDF of the page is the interim
  accountability artefact** — and for that to be honest, the print stylesheet
  MUST force-open every collapsed card (see §4 / finding B1). Export deferred to a
  clean fast-follow.
- **No new audit event type.** Nothing here mints a new `audit_event_type` /
  migration (viewing the page is already un-audited; this change adds no
  data-egress action that needs one).
- **No data-model / schema change.** No new column, table, migration, or Drizzle
  read. The triage engine reuses the existing `listErasedMembers` read.
- **No client interactivity / no client JS.** The page is deliberately RSC-only
  (a hard constraint carried over from the CSP incident history). Filters, search,
  and disclosure are all achieved server-side (URL params) or with native HTML
  (`<details>`) — zero `'use client'` added.
- **RBAC unchanged.** Still `requireSession('staff')` then `notFound()` for
  non-admin (the no-leak posture). Query params add no new authorization surface.
- **Fold / evidence semantics unchanged.** `fold()`, `halfRun`, `isOverdue`,
  `THIRTY_DAYS_MS`, the M-2 minimisation, the earliest-is-authoritative doctrine —
  all preserved exactly. Only the orchestration *around* `fold()` changes.

## Decisions (locked with user)

1. **Layout:** Approach **A — Enhanced Cards**. Keep the card-per-member list;
   layer triage + filter + search + disclosure on top. (Rejected: B dense-table —
   evidence too rich for a row + marginal density win at this volume; C two-zone
   split — more complex + empty-top-zone edge case.)
2. **Directions (all four selected):** triage, progressive disclosure, search,
   visual polish.
3. **Triage bar = count-bearing filter tabs (merged).** One control, not a
   standing separate summary sentence + tabs (DRY, less vertical space, mirrors the
   renewals `renewals-section-tabs` nav pattern the user just shipped, #9). A
   *conditional* breach alert (§5) is not a standing sentence and does not
   relitigate this.
4. **Pagination:** drop keyset/cursor (incompatible with a derived-status
   urgency-first sort); **fold all erased members up to a display cap (200),
   sort urgency-first, render all**; show a non-silent, honest cap note only when
   the cap is hit. Retire `cursor.ts`.
5. **Progressive disclosure:** native `<details>` — complete cards collapsed,
   overdue/in-progress cards `open` by default. No JS.
6. **Export:** **removed from v1** (see Non-goals). Search stays (lightweight,
   no PII egress).

## Review round 1 — enterprise-ux-designer (2026-07-31), resolutions

Traceability of the design review folded into the sections below.

| ID | Finding | Resolution |
|----|---------|------------|
| **B1** | Collapsing complete cards breaks the print-to-PDF accountability fallback the export-cut relies on | **Fixed** — `@media print` force-opens every `<details>` (§4) |
| S1 | Breach state has weaker treatment than the all-clear state | **Fixed** — conditional destructive breach banner, mutually exclusive with all-clear (§5) |
| S2 | `<summary>` a11y under-specified | **Fixed** — keep `<h2>` inside `<summary>`; forbid manual `aria-expanded`/`role` (§4) |
| S3 | Ctrl-F won't expand collapsed cards in Firefox/Safari | **Partial** — matched-search card opens (§3); Firefox/Safari find + `?expand=all` escape hatch → Open questions |
| S4 | Search/display ignores canonical `SCCM-NNNN` (055) → zero-pad match fails | **Fixed** — reuse the canonical member-number formatter for display + search normalise (§3/§4) |
| S5 | Chevron rotation missing reduced-motion guard (ux-standards §10.1) | **Fixed** — `motion-reduce` guard (§4) |
| S6 | Loading skeleton (tall/expanded) → real (short/collapsed) = CLS | **Fixed** — collapsed-height skeletons + search-input skeleton (§7) |
| S7 | Tab counts lack sr-only ICU-plural labels; `resultCount` region fate undefined | **Fixed** — `filter.*.countSr` keys; retire `resultCount` (§2/i18n) |
| S8 | Cap-note undercounts on a breach surface; "refine with search" can't find an unknown overdue | **Fixed** — honest cap copy, drop the false remedy (§5) |
| S9 | 4 tabs + search overflow at 320px | **Fixed** — port renewals scroll-box wrapper + stack search below tabs `< sm` (§2/§3) |
| S10 | filter × search intersection empty-state undefined | **Fixed** — combined-empty copy + clear affordance whenever `q` active (§5) |
| S11 | Importing renewals' `TabCountBadge` couples route features | **Fixed** — promote a shared count-badge (or local copy), no cross-route import (§2) |
| S12 | "Bounded-parallel fold" risks shared tenant-connection "query in progress" | **Fixed** — keep the fold **sequential** (§1) |
| N1 | Overdue bucket sort | **Adopted** — within overdue, sort `requestedAt` ascending (longest-overdue first) (§1) |
| N4 | Cross-browser marker hiding | **Adopted** — `::-webkit-details-marker` + `::marker` both (§4) |
| N6 | Red Overdue-tab contrast + icon semantics | **Adopted** — contrast-test both modes; ⚠ gated on `overdue>0`, `aria-hidden` (§2) |
| N2/N3/N7 | fold `use cache`; `?expand=all`; invoices-idiom consistency | Open questions |

**Protected (do not "fix" in a later round):** `<nav>`+`aria-current` (NOT an ARIA
tablist — a status change is a full navigation); native `<details>`/`<summary>`
disclosure; M-2 minimisation + search scoped to member-number only; RBAC no-leak +
fail-safe param handling; badge carries **text** (colour is reinforcement only);
good-news framing for filtered-empty + a quiet all-clear banner; TH no-italic +
`text-muted-foreground` = empty-sentinel (not link colour).

---

## 1. Triage engine — `getErasureEvidenceLog` rework (Application)

File: `src/modules/insights/application/erasure-evidence.ts`.

The use-case currently pages a keyset window and returns `{ rows, nextCursor }`.
Rework it to load-all-capped + derive-summary + sort + filter + search. **No new
dependency** — it still uses the injected `listErasedMembers`,
`listMemberLinkedUserIds`, and `evidenceReader` (the `GetErasureEvidenceLogDeps`
interface is unchanged); only its orchestration and result shape change.

### New input / output shape

```ts
export type ErasureStatusFilter = 'all' | 'overdue' | 'in_progress' | 'complete';

export interface GetErasureEvidenceLogInput {
  readonly ctx: TenantContext;
  readonly now: Date;
  readonly filter?: ErasureStatusFilter; // default 'all'
  readonly search?: string;              // member-number query; optional
  readonly displayCap?: number;          // default DISPLAY_CAP (200)
}

export interface ErasureLogSummary {
  readonly overdue: number;
  readonly inProgress: number;
  readonly complete: number;
  readonly total: number; // overdue + inProgress + complete (of the searched set)
}

export interface GetErasureEvidenceLogResult {
  readonly rows: readonly GroupedEvidence[]; // sorted urgency-first, filtered+searched
  readonly summary: ErasureLogSummary;       // counts over the SEARCHED set (pre status-filter)
  readonly capped: boolean;                  // true when the cap was hit (more exist)
  readonly loadedCount: number;              // folded rows before status-filter (for the cap note)
}
```

`ErasedMembersCursor` / `nextCursor` drop out of this use-case's surface (the
type stays exported from the members barrel — it is still part of
`listErasedMembers`'s own signature; see §6).

### Orchestration

1. `page = listErasedMembers(ctx, { limit: displayCap })` — newest `erased_at`
   first (unchanged read). `capped = page.nextCursor !== null`.
2. Fold every member (`listMemberLinkedUserIds` + `evidenceReader.readForMember`
   + existing `fold`). **Keep the fold SEQUENTIAL** (finding S12): the injected
   reads run under `runInTenant`, and firing them concurrently risks the shared
   tenant-scoped-connection "another query is already in progress" class — the
   same connection-threading footgun CLAUDE.md warns about. At real erasure volume
   the sequential N+1 is fast; do not trade correctness for a premature win.
3. **Status of a folded row** (reuse existing flags, no new logic):
   `overdue = row.isOverdue`; `in_progress = row.halfRun && !row.isOverdue`;
   `complete = !row.halfRun`.
4. **Search** (member number) applied FIRST — see §3 for the SCCM-aware
   normalisation. `summary` is computed over this searched set (so the tab counts
   always equal "what this tab would show with the current search").
5. **Summary** = counts of overdue / in_progress / complete over the searched set.
6. **Status filter**: `filter` narrows the displayed `rows` (`all` = no narrow).
7. **Sort** displayed rows: urgency rank (`overdue` 0 → `in_progress` 1 →
   `complete` 2); **within the overdue bucket, `requestedAt` ascending**
   (longest-past-the-30-day-window first = highest regulatory exposure, finding
   N1); within in-progress + complete, `erasedAt` desc; final tiebreak `memberId`
   desc (stable).

### Cap limitation (documented, non-silent)

Loading the newest `displayCap` by `erased_at` means an overdue erasure OLDER
than the cap window could be missed, and the summary counts would then undercount
(finding S8). At SweCham's real volume (erasures are rare — far under 200) this
never triggers. When `capped` is true the page shows an **honest** note that the
list *and counts* are limited to the newest {cap} (§5). A future accurate
all-org count needs a light per-member status aggregate read (deferred; Open
questions + a module comment).

---

## 2. Triage + filter tabs (Presentation, RSC)

A new RSC strip below `PageHeader`, mirroring `renewals-section-tabs.tsx`
(`<nav aria-label>` + Next `<Link>` + `aria-current="page"`, styling constants
ported for pixel parity — **including the scoped scroll-container wrapper**
`-my-1 min-w-0 overflow-x-auto overflow-y-hidden py-1` so 4 count tabs survive
320px and TH/SV label expansion, finding S9):

```
[ All 17 ] [ ⚠ Overdue 1 ] [ In progress 2 ] [ Complete 14 ]
```

- URL param `?status=all|overdue|in_progress|complete` (default `all`); each tab
  is a `<Link>` that **preserves the current `?q=`**. Active tab = `aria-current`
  + active styling. Invalid/unknown `status` → treated as `all` (fail-safe).
- Counts come from `summary` (`All` = `summary.total`). The count is the triage
  signal — no standing separate summary sentence.
- **Count badge:** do NOT import renewals' route-private `TabCountBadge` (finding
  S11). Promote a shared count badge to `src/components/shell/` (or a small local
  copy). Each count pairs the visible number with an **sr-only ICU-plural label**
  (`filter.*.countSr`, finding S7) so a screen reader hears "Overdue, 1 erasure",
  not a bare "1".
- **Overdue emphasis:** when `summary.overdue > 0`, the Overdue tab renders in the
  destructive treatment (red) **and** shows a leading ⚠ icon (`aria-hidden` — the
  word "Overdue" carries the meaning; finding N6); when `0`, neutral, no icon (no
  permanent wolf-crying). Contrast-test the destructive tab text/badge in **both**
  light + dark, active + inactive (must hit 4.5:1, finding N6).

## 3. Search (Presentation, RSC — no JS)

A plain `<form method="get">` beside the tabs (stacked BELOW the tabs `< sm`,
side-by-side at `sm+`, finding S9):

- text input `name="q"` (member number) + submit + a hidden
  `<input name="status" value={currentStatus}>` so a search preserves the active
  status tab.
- **SCCM-aware matching (finding S4):** reuse the canonical member-number
  formatter/parser shipped in 055/PR #70 (the one the members directory + command
  palette + portal badge use). Accept `SCCM-0017`, `0017`, and `17` — normalise
  both the query and each `memberNumber` to the same canonical form before
  matching (a prefix/contains match on the canonical string), so a zero-padded
  input can't silently miss. Empty `q` → no search.
- The matched member's card renders `open` (§4) — the DPO is clearly drilling in
  (partial mitigation for the Firefox/Safari Ctrl-F gap, finding S3).
- A **clear-search** affordance (link back to the page without `q`, real link
  styling — not muted) shows whenever `q` is active.
- No debounce / no live filtering (that needs client JS) — submit-driven, correct
  for an RSC surface.

## 4. Card + progressive disclosure (Presentation)

`EvidenceCard` becomes a native `<details>` (still an RSC-local helper, no client
code):

- `<details open={!isComplete}>` — **overdue + in-progress open by default**,
  **complete collapsed**. `isComplete = !row.halfRun`. The matched-search card
  also opens (§3).
- `<summary>` = the current card header row, made the clickable/keyboard toggle:
  the **existing `<h2 id>` is kept inside the `<summary>`** (finding S2 — preserves
  screen-reader heading-jump across the list and enriches the disclosure's
  accessible name), plus `Erased {date}` + the status badge + a right-aligned
  chevron. Native `<summary>` is focusable and toggles on Enter/Space.
  - **Do NOT add manual `role` or `aria-expanded`** to `<summary>` (finding S2) —
    `<details>`/`<summary>` supplies expanded/collapsed state natively; a manual
    ARIA state double-announces.
  - Hide the default marker cross-browser (finding N4):
    `list-none [&::-webkit-details-marker]:hidden [&::marker]:content-['']`.
  - Add a lucide `ChevronDown` rotated via `group-open:rotate-180`
    (`<details className="group">`) with a **reduced-motion guard** (finding S5) —
    `motion-reduce:transition-none` (the up/down end-state stays; only the tween is
    suppressed).
- Expanded body = the **existing five evidence sections, unchanged**
  (Request & attestation / Completion / Login credential / Tax-document
  redactions / Sub-processor) + the existing half-run/overdue banner (demoted to
  `role="status"` when the top-level breach banner is present — §5 / avoid
  double-alert).
- **Member-number display:** render the canonical `SCCM-NNNN` (055) in the heading
  instead of the raw `Member #{number}`, matching every sibling surface (finding
  S4 — also what makes the new search coherent).
- **Visual hierarchy (polish):** overdue card gets a left accent
  (`border-l-2 border-destructive`), in-progress an amber accent; complete stays
  neutral. Badge variants unchanged (destructive / amber half-run / secondary).
- **Print (finding B1 — Blocker):** a print stylesheet force-opens every card so a
  printed page is a complete accountability record:
  ```css
  @media print { details > *:not(summary) { display: block !important; } }
  ```
  (also neutralise the chevron in print). An E2E/print assertion (or a QA
  checkbox) confirms all evidence sections render when printed.

## 5. Empty / edge + status banners

- **Breach alert (finding S1):** when `filter=all && summary.overdue > 0`, a
  **destructive banner above the list** with the count + a one-line consequence
  ("1 erasure is past the 30-day statutory window — this may be a reportable
  breach. Review now."). **Mutually exclusive** with the all-clear banner. Because
  a server-rendered `role="alert"` is not reliably auto-announced, the banner is
  **visibly prominent** and the overdue count also appears in early page text —
  don't lean on `role="alert"` alone; and the per-card overdue note is demoted to
  `role="status"` to avoid a double-announce.
- **All-clear reassurance:** `filter=all` AND `summary.overdue == 0 &&
  summary.inProgress == 0 && summary.total > 0` → a subtle success banner: "All
  erasures complete — no outstanding breaches." (DPO confidence; screenshot-able.)
- **Filtered-empty:** e.g. `?status=overdue` with none → "No overdue erasures"
  (good-news framing, not an alarm `EmptyState`).
- **Search-empty:** `?q=SCCM-0017` with no match → "No erasure matches
  SCCM-0017" + a clear-search link.
- **Combined filter × search empty (finding S10):** e.g. `?status=overdue&q=0017`
  where member 17 exists but is complete → "No overdue erasures match SCCM-0017"
  (not the misleading plain filtered-empty) + the clear-search link. The clear
  affordance appears whenever `q` is active, regardless of status.
- **Org-empty (unchanged):** the existing `empty.*` `EmptyState`. The
  `emptyTail.*` copy (a pagination artefact) is retired with the pager.
- **Cap note (finding S8):** `capped` → an honest muted note above the list: the
  list **and counts** are limited to the newest {cap} erasures; older erasures are
  not shown. No "refine with search" remedy (it can't find an unknown overdue).

## 6. Retire keyset pagination

- Delete `src/app/(staff)/admin/compliance/erasure-log/cursor.ts` (page-local, no
  other consumer) and the page's `nextHref` / "Load older" `<a>`.
- The page no longer reads/writes `?cursor=`. `ErasedMembersCursor` stays exported
  from the members barrel (still used by `listErasedMembers`'s own signature).

## 7. Loading skeleton (finding S6 — CLS)

Update `loading.tsx` so the shimmer matches the new final shape (CLS 0,
ux-standards §2.1):

- add a **tab-strip skeleton** row (~4 pill skeletons) + a **search-input
  skeleton** so neither row shifts on load;
- make the card skeletons **summary-height (collapsed)** for most cards, with
  **one expanded** skeleton to represent an overdue/in-progress card — because most
  cards load collapsed, tall expanded skeletons would jump upward on hydration.

Error boundary (`error.tsx`) unchanged.

## i18n (EN canonical → TH + SV mirror)

New keys under `admin.compliance.erasureLog` (illustrative — finalised in tasks):

- `filter.all` / `filter.overdue` / `filter.inProgress` / `filter.complete`
  (visible tab labels), `filter.*.countSr` (sr-only, `{count, plural, …}` — Thai
  has one plural form, Swedish two; **don't fake Thai plurals**), `filter.navLabel`.
- `search.label` / `search.placeholder` / `search.submit` / `search.clear` /
  `search.empty` (`{ref}` = canonical SCCM-NNNN).
- `breachAlert` (`{count, plural, …}` — destructive banner, S1).
- `filteredEmpty.overdue` / `filteredEmpty.inProgress` / `filteredEmpty.complete`
  and `filteredSearchEmpty` (`{ref}`, combined state, S10).
- `allClear`, `capNote` (`{cap}`, honest copy).
- Card heading key updated to render `SCCM-NNNN` (S4).

Retire: `loadMore`, `emptyTail.*`, and the sr-only `resultCount` live region
(pager/redundant now that visible tab counts exist — finding S7). `check:i18n`
must stay green (3-locale parity). TH must not use `italic` (faux-oblique bends
tone marks); `text-muted-foreground` stays the empty-`—` sentinel — the
clear-search + cap-note links use real link styling, not muted.

## Test impact

- **Unit (use-case)** `getErasureEvidenceLog`: summary counts; urgency-first sort
  (overdue pinned above a newer complete) **+ overdue bucket by `requestedAt` asc**
  (N1); status filter each value; SCCM-aware search (`SCCM-0017`/`0017`/`17` all
  match member 17) + search-scoped summary; cap flag + `loadedCount`; **sequential
  fold** correctness. Update the existing use-case tests (shape change:
  `nextCursor` → `summary` / `capped`).
- **Component / RSC**: `<details open>` open/closed by status (+ matched-search
  open); `<summary>` keeps the `<h2>` and has **no** manual `aria-expanded`; tab
  active state + `aria-current`; tab `Link` hrefs preserve `q`; Overdue-tab
  destructive styling + ⚠ gated on `overdue>0`; breach banner ⇔ all-clear mutual
  exclusion; search form preserves `status`; each empty variant incl. combined;
  cap note copy; canonical `SCCM-NNNN` rendered.
- **E2E**: `@a11y` axe scan (tabs + `<details>` + banners); keyboard toggle of a
  `<details>` summary; nav between status tabs; **print/expand assertion** (B1) —
  a printed/`?expand=all` page renders all evidence sections; 320px overflow (S9);
  `motion-reduce` chevron (S5).
- **Delete** the `cursor.ts` unit tests; drop cursor assertions from the page test.
- Gates: `pnpm lint` + `pnpm typecheck` + `check:i18n` + `check:layout`
  (TableContainer pairing kept) + unit/component. This is a **PII / GDPR
  presentation surface** → an `enterprise-ux-designer` pass (done — round 1) and a
  light `security-engineer` read (confirm no evidence field or minimised value
  newly leaks into the summary/search/sort paths, and RBAC/no-leak posture intact).

## Rollout

Single PR (presentation + one Application use-case; no migration, no flag). Ships
behind the existing admin-only gate — no feature flag needed (no new data
surface). No prod data or cron impact.

## Open questions

None blocking. Deferred:

- **`?expand=all` escape hatch (N3/S3):** a URL param that server-side sets `open`
  on every `<details>` — would solve Ctrl-F-in-Firefox/Safari, print, and bulk
  drill-in in one stroke. Cheap; decide during tasks whether to include in v1 or
  the fast-follow. Document the Firefox/Safari `<details>` find-in-page limitation
  regardless.
- **CSV / PDF export fast-follow** (cut from v1).
- **Accurate all-org status count** (a light per-member status aggregate read) if
  erasure volume ever approaches the cap; pairs with a short-TTL `use cache` on the
  fold so tab-switching is instant (N2).
- **Filter-idiom consistency check (N7):** confirm status-filter-as-nav-tabs does
  not gratuitously diverge from the invoices filter idiom (#264/#265).
