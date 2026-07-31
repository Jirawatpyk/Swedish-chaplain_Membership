# Erasure evidence log — UX enhancement (triage + progressive disclosure + search)

**Date:** 2026-07-31
**Author:** brainstorming session (Jirawat + Claude)
**Status:** design — pending user review
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
  route + rate-limit + contract tests) and the current page already IS the
  accountable view (a DPO can print-to-PDF). Deferred to a clean fast-follow.
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
   separate summary sentence + tabs (DRY, less vertical space, mirrors the
   renewals `renewals-section-tabs` nav pattern the user just shipped, #9).
4. **Pagination:** drop keyset/cursor (incompatible with a derived-status
   urgency-first sort); **fold all erased members up to a display cap (200),
   sort urgency-first, render all**; show a non-silent "showing newest 200 of N"
   note only when the cap is hit. Retire `cursor.ts`.
5. **Progressive disclosure:** native `<details>` — complete cards collapsed,
   overdue/in-progress cards `open` by default. No JS.
6. **Export:** **removed from v1** (see Non-goals). Search stays (lightweight,
   no PII egress).

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
  readonly search?: string;              // member-number query (digits); optional
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
  readonly loadedCount: number;              // folded rows before status-filter (for "of N")
}
```

`ErasedMembersCursor` / `nextCursor` drop out of this use-case's surface (the
type stays exported from the members barrel — it is still part of
`listErasedMembers`'s own signature; see §6).

### Orchestration

1. `page = listErasedMembers(ctx, { limit: displayCap })` — newest `erased_at`
   first (unchanged read). `capped = page.nextCursor !== null`.
2. Fold every member (`listMemberLinkedUserIds` + `evidenceReader.readForMember`
   + existing `fold`). **Bounded-parallel** fold (small chunks) instead of the
   current strict sequential loop — at cap 200 the sequential N+1 would be ~400
   round-trips; real volume is tiny either way, but bound it so the worst case
   stays reasonable. Order from the read is not relied on (we re-sort next).
3. **Status of a folded row** (reuse existing flags, no new logic):
   `overdue = row.isOverdue`; `in_progress = row.halfRun && !row.isOverdue`;
   `complete = !row.halfRun`.
4. **Search** (member number) applied FIRST: normalise `search` to digits; if
   non-empty, keep rows where `String(row.memberNumber).startsWith(digits)`.
   `summary` is computed over this searched set (so the tab counts always equal
   "what this tab would show with the current search").
5. **Summary** = counts of overdue / in_progress / complete over the searched set.
6. **Status filter**: `filter` narrows the displayed `rows` (`all` = no narrow).
7. **Sort** displayed rows: urgency rank (`overdue` 0 → `in_progress` 1 →
   `complete` 2), then `erasedAt` desc, then `memberId` desc (stable tiebreak).

### Cap limitation (documented, non-silent)

Loading the newest `displayCap` by `erased_at` means an overdue erasure OLDER
than the cap window could be missed. At SweCham's real volume (erasures are
rare — far under 200) this never triggers. When `capped` is true the page shows
a visible note. A future accurate all-org count would need a light per-member
status aggregate read (deferred; noted in the module comment).

---

## 2. Triage + filter tabs (Presentation, RSC)

A new RSC strip below `PageHeader`, mirroring `renewals-section-tabs.tsx`
(`<nav aria-label>` + Next `<Link>` + `aria-current="page"`, styling constants
ported for pixel parity):

```
[ All 17 ] [ ⚠ Overdue 1 ] [ In progress 2 ] [ Complete 14 ]
```

- URL param `?status=all|overdue|in_progress|complete` (default `all`); each tab
  is a `<Link>` that **preserves the current `?q=`**. Active tab = `aria-current`
  + active styling.
- Counts come from `summary` (`All` = `summary.total`). The count is the triage
  signal — no separate summary sentence.
- **Overdue emphasis:** when `summary.overdue > 0`, the Overdue tab renders in the
  destructive treatment (red) even when not active, so a breach draws the eye
  before any click. When `0`, it renders neutral (no false alarm).
- Invalid/unknown `status` value → treated as `all` (fail-safe, like the audit
  filter guards).

## 3. Search (Presentation, RSC — no JS)

A plain `<form method="get">` beside the tabs:

- text input `name="q"` (member number) + a submit button (`buttons.search`
  or a new key) + a hidden `<input name="status" value={currentStatus}>` so a
  search preserves the active status tab.
- Server reads `q`, normalises to digits, passes to the use-case (`search`).
- Empty `q` → no search. A clear affordance (link back to the same page without
  `q`) shown only when a search is active.
- No debounce / no live filtering (that would need client JS) — submit-driven,
  which is correct for an RSC surface.

## 4. Card + progressive disclosure (Presentation)

`EvidenceCard` becomes a native `<details>` (still an RSC-local helper, no client
code):

- `<details open={!isComplete}>` — **overdue + in-progress open by default**,
  **complete collapsed**. `isComplete = !row.halfRun`.
- `<summary>` = the current card header row, made the clickable/keyboard toggle:
  `[status icon] Member #NN · Erased {date} · [status badge]` + a right-aligned
  chevron. Native `<summary>` is focusable and toggles on Enter/Space — free
  keyboard a11y.
  - Hide the default disclosure marker (`list-none
    [&::-webkit-details-marker]:hidden`); add a lucide `ChevronDown` that rotates
    via the Tailwind `group-open:` variant (`<details className="group">`).
- Expanded body = the **existing five evidence sections, unchanged**
  (Request & attestation / Completion / Login credential / Tax-document
  redactions / Sub-processor) + the existing half-run/overdue banner.
- **Visual hierarchy (polish):** overdue card gets a left accent
  (`border-l-2 border-destructive`), in-progress an amber accent; complete stays
  neutral. Badge variants unchanged (destructive / amber half-run / secondary).

Note: for a half-run/overdue row the summary keeps "Erased {date}" (the
`erased_at` stamp that lists the member) but the open banner leads with
"Requested {elapsed} ago" — the existing, more meaningful signal.

## 5. Empty / edge states

- **All-clear reassurance:** `filter=all` AND `summary.overdue == 0 &&
  summary.inProgress == 0 && summary.total > 0` → a subtle success banner atop the
  list: "All erasures complete — no outstanding breaches." (DPO confidence.)
- **Filtered-empty:** e.g. `?status=overdue` with none → "No overdue erasures"
  (good-news framing, not an error/`EmptyState` with alarm).
- **Search-empty:** `?q=NNN` with no match → "No erasure matches #NNN" + a clear-search link.
- **Org-empty (unchanged):** no erasures ever → the existing `empty.*` `EmptyState`.
  The `emptyTail.*` copy (a pagination artefact) is retired with the pager.
- **Cap note:** `capped` → "Showing the newest {cap} erasures of more — refine
  with search." Rendered as a muted note above the list (non-silent).

## 6. Retire keyset pagination

- Delete `src/app/(staff)/admin/compliance/erasure-log/cursor.ts` (page-local,
  no other consumer) and the page's `nextHref` / "Load older" `<a>`.
- The page no longer reads/writes `?cursor=`. `ErasedMembersCursor` stays exported
  from the members barrel (still used by `listErasedMembers`'s own signature).

## 7. Loading skeleton

Update `loading.tsx` to add a tab-strip skeleton row (a short row of ~4 pill
skeletons) above the card skeletons, so the shimmer matches the new final shape
(CLS 0, ux-standards §2.1). Error boundary (`error.tsx`) unchanged.

## i18n (EN canonical → TH + SV mirror)

New keys under `admin.compliance.erasureLog` (illustrative — finalised in tasks):

- `filter.all` / `filter.overdue` / `filter.inProgress` / `filter.complete`
  (tab labels; counts injected as `{count}`), `filter.navLabel` (`<nav aria-label>`).
- `search.label` / `search.placeholder` / `search.submit` / `search.clear` /
  `search.empty` (`{number}`).
- `filteredEmpty.overdue` / `filteredEmpty.inProgress` / `filteredEmpty.complete`.
- `allClear` (reassurance banner).
- `capNote` (`{cap}`).

Retire: `loadMore`, `emptyTail.*` (pager-only). `check:i18n` must stay green
(3-locale parity). TH must not use `italic` (faux-oblique bends tone marks) and
`text-muted-foreground` stays the empty-`—` sentinel, not a link colour
(house rules).

## Test impact

- **Unit (use-case)** `getErasureEvidenceLog`: summary counts; urgency-first sort
  (overdue pinned above a newer complete); status filter each value; search
  prefix match + search-scoped summary; cap flag + `loadedCount`; bounded-parallel
  fold preserves correctness. Update the existing use-case tests (shape change:
  `nextCursor` → `summary` / `capped`).
- **Component / RSC**: `<details open>` open/closed by status; tab active state +
  `aria-current`; tab `Link` hrefs preserve `q`; Overdue-tab destructive styling
  gated on `overdue>0`; search form preserves `status`; each empty variant.
- **E2E**: `@a11y` axe scan (tabs + `<details>` + banners); keyboard toggle of a
  `<details>` summary; nav between status tabs.
- **Delete** the `cursor.ts` unit tests; drop cursor assertions from the page test.
- Gates: `pnpm lint` + `pnpm typecheck` + `check:i18n` + `check:layout`
  (TableContainer pairing kept) + unit/component. This is a **PII / GDPR
  presentation surface** → an `enterprise-ux-designer` pass (per CLAUDE.md, any
  UI change) and a light `security-engineer` read (confirm no evidence field or
  minimised value newly leaks into the summary/search/sort paths, and RBAC/no-leak
  posture intact).

## Rollout

Single PR (presentation + one Application use-case; no migration, no flag). Ships
behind the existing admin-only gate — no feature flag needed (no new data
surface). No prod data or cron impact.

## Open questions

None blocking. Deferred: (a) CSV/PDF export fast-follow; (b) an accurate all-org
status count (light aggregate read) if erasure volume ever approaches the cap.
