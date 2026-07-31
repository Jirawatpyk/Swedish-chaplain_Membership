# Erasure log UX enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the DPO erasure-evidence log (`/admin/compliance/erasure-log`) into a triage-first surface — count-bearing status filter tabs, overdue-first ordering, native `<details>` progressive disclosure, SCCM-aware member-number search, and visual polish — without adding client JS, a migration, or a data-layer read.

**Architecture:** Rework the existing Application use-case `getErasureEvidenceLog` to fold all erased members (capped), derive a status summary, and sort/filter/search in memory (the `listErasedMembers` read is reused unchanged). The page stays a React Server Component: filters/search are URL params, disclosure is native `<details>`. New presentational pieces are synchronous, `useTranslations`-driven server components (no `'use client'`).

**Tech Stack:** Next.js 16 App Router (RSC), React 19, TypeScript strict, next-intl (EN canonical + TH + SV), Tailwind v4, Vitest + @testing-library/react + NextIntlClientProvider, Playwright + axe-core.

## Global Constraints

- **RSC-only — NO client JS.** No `'use client'` added anywhere in this feature. Filters/search = URL params + server; disclosure = native `<details>`. (CSP-hardening constraint.)
- **No schema / migration / new Drizzle read / new audit event type.** Reuse `listErasedMembers`.
- **RBAC unchanged:** page keeps `requireSession('staff')` then `if (user.role !== 'admin') notFound()`. Query params add no authorization surface.
- **Fold semantics unchanged:** `fold()`, `halfRun`, `isOverdue`, `THIRTY_DAYS_MS`, M-2 minimisation, earliest-is-authoritative — untouched. Only orchestration around `fold()` changes.
- **Fold stays SEQUENTIAL** (never parallelise the injected `runInTenant` reads — shared-tenant-connection footgun).
- **Package manager `pnpm`** (never npm). **Never run `pnpm format` / prettier** — hand-format to match surrounding code.
- **i18n:** EN is canonical (`en.json`); every key MUST also exist in `th.json` + `sv.json` (`pnpm check:i18n` blocks on missing). TH must NOT use `italic`. `text-muted-foreground` is the empty-`—` sentinel, not a link colour — real links use link styling.
- **`check:layout`:** the page must keep its `TableContainer` wrapper.
- **Member number:** canonical display is `SCCM-NNNN` via `formatMemberNumber(prefix, n)`; search normalises via `parseMemberNumberQuery` (accepts `SCCM-0042` / `0042` / `42`). Both from `@/modules/members`.
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Never `git add -A`** (untracked PII/junk in the tree). Stage explicit paths only.
- **Pre-push for a touched module** runs the per-module integration gate; this feature touches `src/modules/insights/**` — if push is slow/among renewals churn, `SKIP_INTEGRATION_PREPUSH=1 git push` is the sanctioned override (the use-case change is covered by unit tests; there is no new DB read to integration-test).

---

## File Structure

**Application (Task 1)**
- Modify `src/modules/insights/application/erasure-evidence.ts` — add `ErasureStatusFilter`, `ErasureLogSummary`, `DEFAULT_DISPLAY_CAP`; rework input/result + orchestration (search/summary/filter/sort/cap; sequential fold).
- Modify `src/modules/insights/index.ts` — export the two new types.
- Modify `tests/unit/insights/erasure-evidence.test.ts` — adapt input (`limit` → default cap), make the multi-member ordering assertion order-independent, add triage tests.

**i18n (Task 2)**
- Modify `src/i18n/messages/en.json`, `th.json`, `sv.json` — add filter/search/banner/empty/cap keys; retire `loadMore` + `emptyTail.*` + `resultCount`; repoint the card heading key to `SCCM-NNNN`.

**Presentation (Tasks 3–7)**
- Create `src/app/(staff)/admin/compliance/erasure-log/_components/evidence-card.tsx` — the `<details>` evidence card (extracted from `page.tsx`) + its local helpers.
- Create `src/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs.tsx` — nav + `<Link>` status tabs + local count badge + overflow-box.
- Create `src/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form.tsx` — GET search form + clear link.
- Modify `src/app/(staff)/admin/compliance/erasure-log/page.tsx` — read `status`/`q`; call use-case + `resolveMemberNumberPrefix`; render tabs + search + breach/all-clear banners + card list + empty/cap states; drop cursor/loadMore; SCCM display.
- Modify `src/app/(staff)/admin/compliance/erasure-log/loading.tsx` — tab + search skeletons; collapsed-height card skeletons.
- Modify `src/app/globals.css` — `@media print` rule that force-opens `details[data-evidence]`.
- Delete `src/app/(staff)/admin/compliance/erasure-log/cursor.ts`.
- New tests: `tests/unit/insights/...` (Task 1), `tests/unit/admin/erasure-filter-tabs.test.tsx`, `tests/unit/admin/erasure-search-form.test.tsx`, `tests/unit/admin/erasure-evidence-card.test.tsx`.

**Tests to retire / update (Task 8)**
- Delete `tests/unit/admin/erasure-log-cursor.test.ts` (cursor retired).
- Modify `tests/e2e/admin-erasure-log.spec.ts` — expand a collapsed card before asserting section headings; add tab/search/breach-banner assertions.

---

## Task 1: Rework `getErasureEvidenceLog` (triage engine)

**Files:**
- Modify: `src/modules/insights/application/erasure-evidence.ts`
- Modify: `src/modules/insights/index.ts:250-261`
- Test: `tests/unit/insights/erasure-evidence.test.ts`

**Interfaces:**
- Consumes: existing `GetErasureEvidenceLogDeps` (`listErasedMembers`, `listMemberLinkedUserIds`, `evidenceReader`) — unchanged; existing `fold()`, `GroupedEvidence`; `parseMemberNumberQuery` from `@/modules/members`.
- Produces (later tasks rely on these exact names/types):
  ```ts
  export type ErasureStatusFilter = 'all' | 'overdue' | 'in_progress' | 'complete';
  export interface ErasureLogSummary {
    readonly overdue: number; readonly inProgress: number;
    readonly complete: number; readonly total: number;
  }
  export const DEFAULT_DISPLAY_CAP = 200;
  export interface GetErasureEvidenceLogInput {
    readonly ctx: TenantContext; readonly now: Date;
    readonly filter?: ErasureStatusFilter; readonly search?: string;
    readonly displayCap?: number;
  }
  export interface GetErasureEvidenceLogResult {
    readonly rows: readonly GroupedEvidence[]; readonly summary: ErasureLogSummary;
    readonly capped: boolean; readonly loadedCount: number;
  }
  ```

- [ ] **Step 1: Write the failing tests (triage behaviour)**

Append to `tests/unit/insights/erasure-evidence.test.ts` a new `describe`. `erasedRow` currently stamps every row with the same `erasedAt`; add a variant with an explicit `erasedAt` and an evidence helper for overdue/in-progress/complete.

```ts
// --- Task 1 (triage) helpers ---------------------------------------------
function reqRow(memberId: string, agoMs: number) {
  return {
    id: `req-${memberId}`, eventType: 'member_erasure_requested' as const,
    occurredAtIso: isoMinus(agoMs), actorUserId: 'admin-1', targetUserId: null,
    payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
  };
}
function erasedEvidence(memberId: string) {
  return {
    id: `er-${memberId}`, eventType: 'member_erased' as const,
    occurredAtIso: isoMinus(TEN_MIN_MS - 1000), actorUserId: 'admin-1', targetUserId: null,
    payload: { member_id: memberId, sessions_revoked_total: 1, invitations_revoked_count: 0, re_drive: false },
  };
}
/** erasedAt override so multi-row ordering is deterministic. */
function erasedRowAt(memberId: string, memberNumber: number, erasedAgoMs: number) {
  return { memberId, memberNumber, erasedAt: new Date(isoMinus(erasedAgoMs)) };
}

describe('getErasureEvidenceLog — triage (summary / sort / filter / search / cap)', () => {
  it('summarises overdue / in-progress / complete counts over the loaded set', async () => {
    const deps = makeDeps({
      rows: [erasedRow('over', 1), erasedRow('prog', 2), erasedRow('done', 3)],
      linkedByMember: {},
      evidenceByMember: {
        over: [reqRow('over', FORTY_DAYS_MS)],                       // half-run + 40d → overdue
        prog: [reqRow('prog', TEN_MIN_MS)],                          // half-run + fresh → in-progress
        done: [reqRow('done', TEN_MIN_MS), erasedEvidence('done')], // completed
      },
    });
    const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW });
    expect(out.summary).toEqual({ overdue: 1, inProgress: 1, complete: 1, total: 3 });
    expect(out.capped).toBe(false);
    expect(out.loadedCount).toBe(3);
  });

  it('sorts urgency-first: an OLD overdue pins ABOVE a NEWER complete', async () => {
    const deps = makeDeps({
      // `done` was erased more recently than `over` was requested — newest-first
      // would bury the overdue below it; urgency-first must pin `over` on top.
      rows: [erasedRowAt('done', 10, TEN_MIN_MS), erasedRowAt('over', 11, FORTY_DAYS_MS)],
      linkedByMember: {},
      evidenceByMember: {
        done: [reqRow('done', TEN_MIN_MS), erasedEvidence('done')],
        over: [reqRow('over', FORTY_DAYS_MS)],
      },
    });
    const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW });
    expect(out.rows.map((r) => r.memberId)).toEqual(['over', 'done']);
  });

  it('within the overdue bucket, sorts by requestedAt ASCENDING (longest-overdue first)', async () => {
    const deps = makeDeps({
      rows: [erasedRow('less', 1), erasedRow('more', 2)],
      linkedByMember: {},
      evidenceByMember: {
        less: [reqRow('less', FORTY_DAYS_MS)],               // 40d overdue
        more: [reqRow('more', FORTY_DAYS_MS + 5 * 24 * 3600_000)], // 45d overdue (older)
      },
    });
    const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW });
    expect(out.rows.map((r) => r.memberId)).toEqual(['more', 'less']);
  });

  it('status filter narrows to a single bucket while summary stays full', async () => {
    const deps = makeDeps({
      rows: [erasedRow('over', 1), erasedRow('done', 2)],
      linkedByMember: {},
      evidenceByMember: {
        over: [reqRow('over', FORTY_DAYS_MS)],
        done: [reqRow('done', TEN_MIN_MS), erasedEvidence('done')],
      },
    });
    const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, filter: 'overdue' });
    expect(out.rows.map((r) => r.memberId)).toEqual(['over']);
    expect(out.summary).toEqual({ overdue: 1, inProgress: 0, complete: 1, total: 2 });
  });

  it('SCCM-aware search matches SCCM-0042 / 0042 / 42 to member 42; summary scopes to the searched set', async () => {
    const deps = makeDeps({
      rows: [erasedRow('a', 42), erasedRow('b', 7)],
      linkedByMember: {},
      evidenceByMember: { a: [reqRow('a', TEN_MIN_MS)], b: [reqRow('b', TEN_MIN_MS)] },
    });
    for (const q of ['SCCM-0042', '0042', '42']) {
      const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, search: q });
      expect(out.rows.map((r) => r.memberNumber)).toEqual([42]);
      expect(out.summary.total).toBe(1);
    }
  });

  it('a non-matching / non-member-number search yields zero rows and a zero summary; empty search is a no-op', async () => {
    const deps = makeDeps({
      rows: [erasedRow('a', 42)],
      linkedByMember: {},
      evidenceByMember: { a: [reqRow('a', TEN_MIN_MS)] },
    });
    const miss = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, search: '999' });
    expect(miss.rows).toHaveLength(0);
    expect(miss.summary.total).toBe(0);
    const notNum = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, search: 'not-a-number' });
    expect(notNum.rows).toHaveLength(0);
    const blank = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, search: '   ' });
    expect(blank.rows).toHaveLength(1); // whitespace-only → no search
  });

  it('reports capped=true when the member list returns a full page (nextCursor non-null)', async () => {
    const deps = makeDeps({
      rows: [erasedRow('a', 1), erasedRow('b', 2)],
      nextCursor: { erasedAt: new Date(isoMinus(TEN_MIN_MS)), memberId: 'b' },
      linkedByMember: {},
      evidenceByMember: {},
    });
    const out = await getErasureEvidenceLog(deps, { ctx: CTX, now: NOW, displayCap: 2 });
    expect(out.capped).toBe(true);
    expect(out.loadedCount).toBe(2);
  });
});
```

- [ ] **Step 2: Adapt the existing fold tests to the new input/result shape**

In the SAME file: (a) every existing call `getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW })` and `{ ... limit: 3 ... }` → drop the `limit` property: `{ ctx: CTX, now: NOW }`. (b) In the test currently named *"passes through the member-list nextCursor and reads each erased member"*, rename it to *"reads each erased member (fold is order-independent of input order)"* and make the ordering assertion order-independent:
```ts
expect([...out.rows.map((r) => r.memberId)].sort()).toEqual(['m1', 'm2', 'm3']);
```
(The rows are now urgency-then-`memberId`-desc sorted; the three no-evidence members are all `complete` with equal `erasedAt`, so their input order is not preserved — the test's intent is "each member is read + folded", which the set assertion captures.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/insights/erasure-evidence.test.ts`
Expected: FAIL — new triage tests reference `out.summary` / `out.capped` (undefined) and `filter`/`search`/`displayCap` inputs; the adapted `limit`-drop makes TS/excess-property mismatch surface at type-check.

- [ ] **Step 4: Implement the rework in `erasure-evidence.ts`**

Add the import and the new exports; replace the input/result interfaces and the `getErasureEvidenceLog` body. Keep `fold`, `earliest`, all payload readers, `GroupedEvidence`, `THIRTY_DAYS_MS` exactly as-is.

```ts
// add to the imports block (members barrel already imported for ErasedMemberRow):
import { parseMemberNumberQuery } from '@/modules/members';
```

```ts
export type ErasureStatusFilter = 'all' | 'overdue' | 'in_progress' | 'complete';

export interface ErasureLogSummary {
  readonly overdue: number;
  readonly inProgress: number;
  readonly complete: number;
  readonly total: number;
}

/** Display ceiling — the page folds at most this many newest-erased members.
 *  Erasures are rare, so this never triggers at real volume; it is a safety
 *  bound, surfaced honestly via `capped` when hit. A truly accurate all-org
 *  count beyond the cap would need a light per-member status aggregate read
 *  (deferred). */
export const DEFAULT_DISPLAY_CAP = 200;

export interface GetErasureEvidenceLogInput {
  readonly ctx: TenantContext;
  readonly now: Date;
  /** Status bucket to display; `undefined`/`'all'` shows every bucket. */
  readonly filter?: ErasureStatusFilter;
  /** Member-number query (`SCCM-0042` / `0042` / `42`); `undefined`/blank = no search. */
  readonly search?: string;
  readonly displayCap?: number;
}

export interface GetErasureEvidenceLogResult {
  readonly rows: readonly GroupedEvidence[];
  readonly summary: ErasureLogSummary;
  readonly capped: boolean;
  readonly loadedCount: number;
}

/** The row's triage bucket — derived purely from the existing fold flags. */
function statusOf(row: GroupedEvidence): 'overdue' | 'in_progress' | 'complete' {
  if (row.isOverdue) return 'overdue';
  if (row.halfRun) return 'in_progress'; // halfRun && !isOverdue
  return 'complete';
}

const URGENCY_RANK: Record<'overdue' | 'in_progress' | 'complete', number> = {
  overdue: 0,
  in_progress: 1,
  complete: 2,
};

export async function getErasureEvidenceLog(
  deps: GetErasureEvidenceLogDeps,
  input: GetErasureEvidenceLogInput,
): Promise<GetErasureEvidenceLogResult> {
  const cap = input.displayCap ?? DEFAULT_DISPLAY_CAP;
  const page = await deps.listErasedMembers(input.ctx, { limit: cap });
  const capped = page.nextCursor !== null;

  // Sequential fold — do NOT parallelise (shared tenant-scoped connection;
  // concurrent queries on it would throw "another query is already in progress").
  const folded: GroupedEvidence[] = [];
  for (const member of page.rows) {
    const linkedUserIds = await deps.listMemberLinkedUserIds(input.ctx, member.memberId);
    const evidence = await deps.evidenceReader.readForMember(
      input.ctx,
      member.memberId,
      linkedUserIds,
    );
    folded.push(fold(member, evidence, input.now));
  }

  // Search FIRST (member-number). A blank query is a no-op; a non-empty query
  // that is not a usable member-number (or matches nobody) yields an empty set.
  const rawQ = input.search?.trim() ?? '';
  let searched = folded;
  if (rawQ !== '') {
    const parsed = parseMemberNumberQuery(rawQ);
    searched = parsed === null ? [] : folded.filter((r) => r.memberNumber === parsed);
  }

  // Summary over the searched set (pre status-filter) so tab counts equal
  // "what this tab shows with the current search".
  let overdue = 0;
  let inProgress = 0;
  let complete = 0;
  for (const r of searched) {
    const s = statusOf(r);
    if (s === 'overdue') overdue++;
    else if (s === 'in_progress') inProgress++;
    else complete++;
  }
  const summary: ErasureLogSummary = {
    overdue,
    inProgress,
    complete,
    total: overdue + inProgress + complete,
  };

  const filter = input.filter ?? 'all';
  const filtered = filter === 'all' ? searched : searched.filter((r) => statusOf(r) === filter);

  // Urgency-first; overdue bucket by requestedAt ASC (longest-overdue first);
  // others by erasedAt DESC; final tiebreak memberId DESC (stable).
  const rows = [...filtered].sort((a, b) => {
    const ra = URGENCY_RANK[statusOf(a)];
    const rb = URGENCY_RANK[statusOf(b)];
    if (ra !== rb) return ra - rb;
    if (ra === URGENCY_RANK.overdue) {
      const ta = a.requestedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const tb = b.requestedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
    } else {
      const ea = a.erasedAt.getTime();
      const eb = b.erasedAt.getTime();
      if (ea !== eb) return eb - ea;
    }
    return a.memberId < b.memberId ? 1 : a.memberId > b.memberId ? -1 : 0;
  });

  return { rows, summary, capped, loadedCount: folded.length };
}
```

Delete the old `GetErasureEvidenceLogInput` (with `limit`/`cursor`) and old `GetErasureEvidenceLogResult` (with `nextCursor`) — replaced above.

- [ ] **Step 5: Export the new types from the insights barrel**

In `src/modules/insights/index.ts`, inside the existing erasure export block (lines ~250-261), add:
```ts
  type ErasureStatusFilter,
  type ErasureLogSummary,
  DEFAULT_DISPLAY_CAP,
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `pnpm vitest run tests/unit/insights/erasure-evidence.test.ts`
Expected: PASS (all existing fold tests + new triage tests).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/insights/application/erasure-evidence.ts src/modules/insights/index.ts tests/unit/insights/erasure-evidence.test.ts
git commit -m "feat(insights): erasure-log triage engine — summary + urgency sort + status filter + SCCM search"
```

---

## Task 2: i18n keys (EN canonical → TH + SV)

**Files:**
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (all under `admin.compliance.erasureLog`)

**Interfaces:**
- Produces: the message keys consumed by Tasks 3–6. Exact keys + values below.

- [ ] **Step 1: Add the EN keys + retire dead keys**

In `en.json` under `admin.compliance.erasureLog`: **remove** `loadMore`, `emptyTail` (object), and `resultCount`. **Change** `memberNumber` from `"Member #{number}"` to `"Member {ref}"`. **Add**:
```json
"filter": {
  "navLabel": "Filter erasures by status",
  "all": "All",
  "overdue": "Overdue",
  "inProgress": "In progress",
  "complete": "Complete",
  "countSr": "{count, plural, =0 {no erasures} one {# erasure} other {# erasures}}"
},
"search": {
  "label": "Search by member number",
  "placeholder": "e.g. SCCM-0042",
  "submit": "Search",
  "clear": "Clear search",
  "empty": "No erasure matches {ref}."
},
"breachAlert": "{count, plural, one {# erasure is} other {# erasures are}} past the 30-day statutory window — this may be a reportable breach. Review now.",
"allClear": "All erasures complete — no outstanding breaches.",
"filteredEmpty": {
  "overdue": "No overdue erasures.",
  "inProgress": "No erasures in progress.",
  "complete": "No completed erasures."
},
"filteredSearchEmpty": {
  "overdue": "No overdue erasures match {ref}.",
  "inProgress": "No in-progress erasures match {ref}.",
  "complete": "No completed erasures match {ref}."
},
"capNote": "Showing the newest {cap} erasures. The list and counts above are limited to these — older erasures are not shown."
```

- [ ] **Step 2: Run check:i18n to verify it fails (TH/SV missing)**

Run: `pnpm check:i18n`
Expected: FAIL — the new keys are missing from `th.json` + `sv.json`; the removed keys may be referenced until Tasks 3-6 land, so also grep to confirm no stale reference remains after those tasks (re-run at Task 6).

- [ ] **Step 3: Mirror into TH + SV**

`th.json` (same paths; TH — no `italic` anywhere):
```json
"filter": { "navLabel": "กรองการลบตามสถานะ", "all": "ทั้งหมด", "overdue": "เกินกำหนด", "inProgress": "กำลังดำเนินการ", "complete": "เสร็จสิ้น", "countSr": "{count, plural, other {# รายการ}}" },
"search": { "label": "ค้นหาด้วยหมายเลขสมาชิก", "placeholder": "เช่น SCCM-0042", "submit": "ค้นหา", "clear": "ล้างการค้นหา", "empty": "ไม่พบการลบที่ตรงกับ {ref}" },
"breachAlert": "มีการลบ {count} รายการเกินกรอบเวลาตามกฎหมาย 30 วัน — อาจเข้าข่ายต้องรายงานการละเมิด กรุณาตรวจสอบทันที",
"allClear": "การลบทั้งหมดเสร็จสิ้น — ไม่มีการละเมิดค้างอยู่",
"filteredEmpty": { "overdue": "ไม่มีการลบที่เกินกำหนด", "inProgress": "ไม่มีการลบที่กำลังดำเนินการ", "complete": "ไม่มีการลบที่เสร็จสิ้น" },
"filteredSearchEmpty": { "overdue": "ไม่มีการลบที่เกินกำหนดตรงกับ {ref}", "inProgress": "ไม่มีการลบที่กำลังดำเนินการตรงกับ {ref}", "complete": "ไม่มีการลบที่เสร็จสิ้นตรงกับ {ref}" },
"capNote": "แสดงการลบล่าสุด {cap} รายการ รายการและตัวเลขด้านบนจำกัดเท่านี้ — การลบที่เก่ากว่านี้ไม่แสดง"
```
And `memberNumber` → `"สมาชิก {ref}"`.

`sv.json`:
```json
"filter": { "navLabel": "Filtrera raderingar efter status", "all": "Alla", "overdue": "Försenad", "inProgress": "Pågår", "complete": "Klar", "countSr": "{count, plural, =0 {inga raderingar} one {# radering} other {# raderingar}}" },
"search": { "label": "Sök på medlemsnummer", "placeholder": "t.ex. SCCM-0042", "submit": "Sök", "clear": "Rensa sökning", "empty": "Ingen radering matchar {ref}." },
"breachAlert": "{count, plural, one {# radering} other {# raderingar}} har passerat den lagstadgade 30-dagarsfristen — detta kan vara en rapporteringspliktig incident. Granska nu.",
"allClear": "Alla raderingar är klara — inga utestående incidenter.",
"filteredEmpty": { "overdue": "Inga försenade raderingar.", "inProgress": "Inga pågående raderingar.", "complete": "Inga slutförda raderingar." },
"filteredSearchEmpty": { "overdue": "Inga försenade raderingar matchar {ref}.", "inProgress": "Inga pågående raderingar matchar {ref}.", "complete": "Inga slutförda raderingar matchar {ref}." },
"capNote": "Visar de {cap} senaste raderingarna. Listan och antalen ovan är begränsade till dessa — äldre raderingar visas inte."
```
And `memberNumber` → `"Medlem {ref}"`.

- [ ] **Step 4: Run check:i18n to verify parity**

Run: `pnpm check:i18n`
Expected: PASS (3-locale parity for all present keys). (Removed-key references are cleared in Tasks 3-6; if check:i18n also flags an unused key, that is fine — it blocks on MISSING, not unused.)

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "i18n(erasure-log): filter/search/banner/empty/cap keys; retire pager keys; SCCM heading"
```

---

## Task 3: `EvidenceCard` → native `<details>` (progressive disclosure + SCCM + print + reduced-motion)

**Files:**
- Create: `src/app/(staff)/admin/compliance/erasure-log/_components/evidence-card.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/unit/admin/erasure-evidence-card.test.tsx`

**Interfaces:**
- Consumes: `GroupedEvidence` (`@/modules/insights`); `formatMemberNumber`, `asMemberNumber` (`@/modules/members`).
- Produces:
  ```ts
  export function EvidenceCard(props: {
    readonly row: GroupedEvidence;
    readonly memberPrefix: string;      // tenant SCCM prefix
    readonly fmt: Intl.DateTimeFormat;  // tenant-TZ date formatter
    readonly now: Date;
    readonly topBannerPresent: boolean; // when true, per-card overdue note = role="status"
  }): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing component test**

```tsx
// tests/unit/admin/erasure-evidence-card.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { EvidenceCard } from '@/app/(staff)/admin/compliance/erasure-log/_components/evidence-card';
import type { GroupedEvidence } from '@/modules/insights';

const NOW = new Date('2026-06-20T00:00:00.000Z');
const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function baseRow(over: Partial<GroupedEvidence> = {}): GroupedEvidence {
  return {
    memberId: 'm1', memberNumber: 42, erasedAt: new Date('2026-06-19T00:00:00.000Z'),
    requestedAt: new Date('2026-06-19T00:00:00.000Z'), reason: 'gdpr_erasure_request',
    identityVerified: true, verificationMethod: 'in_person', note: null,
    completedAt: new Date('2026-06-19T00:05:00.000Z'), sessionsRevokedTotal: 1,
    invitationsRevokedCount: 0, reDrive: false, userErasedProofs: [], taxRedactions: [],
    subprocessorOutcome: null, halfRun: false, isOverdue: false, ...over,
  };
}
function renderCard(row: GroupedEvidence, topBannerPresent = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EvidenceCard row={row} memberPrefix="SCCM" fmt={fmt} now={NOW} topBannerPresent={topBannerPresent} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('EvidenceCard', () => {
  it('renders the canonical SCCM-NNNN heading', () => {
    renderCard(baseRow());
    expect(screen.getByText('Member SCCM-0042')).toBeInTheDocument();
  });

  it('a COMPLETE card is a collapsed <details> (no open attribute), inside a data-evidence details', () => {
    const { container } = renderCard(baseRow());
    const details = container.querySelector('details[data-evidence]');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
  });

  it('an OVERDUE card is open by default', () => {
    const { container } = renderCard(baseRow({ halfRun: true, isOverdue: true, completedAt: null }));
    expect(container.querySelector('details[data-evidence]')!.hasAttribute('open')).toBe(true);
  });

  it('keeps the member heading as an <h2> inside the <summary> and adds no manual aria-expanded', () => {
    const { container } = renderCard(baseRow());
    const summary = container.querySelector('summary')!;
    expect(summary.querySelector('h2')).not.toBeNull();
    expect(summary.hasAttribute('aria-expanded')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/admin/erasure-evidence-card.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `evidence-card.tsx`**

Move the `EvidenceCard`, `Field`, `elapsed`, `DASH`, and `T`-type helpers out of `page.tsx` into this file. Convert the outer `<Card>` into a `<details data-evidence>` whose `<summary>` carries the header row (keeping the `<h2 id>`); use `useTranslations` (sync, RSC-safe) instead of a `t` prop; render `SCCM-NNNN` via `formatMemberNumber`.

```tsx
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMemberNumber, asMemberNumber } from '@/modules/members';
import type { GroupedEvidence } from '@/modules/insights';

const DASH = '—';

function elapsed(from: Date, now: Date, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('status.elapsedDays', { count: days });
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return t('status.elapsedHours', { count: hours });
  return t('status.elapsedMinutes', { count: Math.floor(ms / (60 * 1000)) });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function EvidenceCard({
  row, memberPrefix, fmt, now, topBannerPresent,
}: {
  readonly row: GroupedEvidence;
  readonly memberPrefix: string;
  readonly fmt: Intl.DateTimeFormat;
  readonly now: Date;
  readonly topBannerPresent: boolean;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const headingId = `erasure-${row.memberId}`;
  const isComplete = !row.halfRun;
  const fmtDate = (d: Date | null) => (d ? fmt.format(d) : DASH);
  const fmtBool = (b: boolean | null) => (b === null ? DASH : b ? t('value.yes') : t('value.no'));
  const fmtText = (s: string | null) => (s && s.trim() !== '' ? s : DASH);

  const statusVariant: 'destructive' | 'outline' | 'secondary' = row.isOverdue
    ? 'destructive' : row.halfRun ? 'outline' : 'secondary';
  const statusLabel = row.isOverdue ? t('status.overdue') : row.halfRun ? t('status.halfRun') : t('status.complete');
  const ref = formatMemberNumber(memberPrefix, asMemberNumber(row.memberNumber));

  return (
    <Card
      className={cn(
        'p-0', // details owns padding
        row.isOverdue && 'border-l-2 border-l-destructive',
        row.halfRun && !row.isOverdue && 'border-l-2 border-l-amber-500',
      )}
    >
      <details data-evidence open={!isComplete} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 border-b px-6 py-4 [&::-webkit-details-marker]:hidden [&::marker]:content-['']">
          <div className="flex flex-col gap-1">
            <h2 id={headingId} className="font-heading text-base font-medium leading-snug">
              {t('memberNumber', { ref })}
            </h2>
            <p className="text-sm text-muted-foreground">{t('erasedAt', { at: fmtDate(row.erasedAt) })}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={statusVariant}
              className={cn('h-6 px-2.5 text-xs',
                row.halfRun && !row.isOverdue && 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400')}
            >
              {statusLabel}
            </Badge>
            <ChevronDownIcon
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            />
          </div>
        </summary>

        <CardContent className="flex flex-col gap-6 pt-6">
          {/* ...the EXISTING five sections + half-run/overdue banner, verbatim from
              page.tsx, EXCEPT: the half-run/overdue banner's role becomes
              role={row.isOverdue && !topBannerPresent ? 'alert' : 'status'} to
              avoid double-announcing when the page renders the top breach banner. */}
        </CardContent>
      </details>
    </Card>
  );
}
```
Port the five `<section>` blocks (Requested/Completion/Credential/Tax/Sub-processor) and the half-run note **exactly** as they are in the current `page.tsx:242-348`, changing only the half-run note's `role` per the comment above and using the local `fmtDate/fmtBool/fmtText/elapsed`. (Repeat the section markup here rather than referencing it — the implementer may read tasks out of order.)

- [ ] **Step 4: Add the print rule to `globals.css`**

Append to `src/app/globals.css`:
```css
/* Erasure evidence log — force-open every evidence <details> when printing so a
   printed page is a COMPLETE Article 17 accountability record (the print-to-PDF
   fallback the export-cut relies on). */
@media print {
  details[data-evidence] > *:not(summary) { display: block !important; }
  details[data-evidence] summary .lucide-chevron-down { display: none; }
}
```

- [ ] **Step 5: Run the component test + typecheck**

Run: `pnpm vitest run tests/unit/admin/erasure-evidence-card.test.tsx`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS (page.tsx still imports the old inline helpers until Task 6 — if typecheck flags an unused/duplicate symbol, leave page.tsx wiring for Task 6; keep this task's file self-contained).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/admin/compliance/erasure-log/_components/evidence-card.tsx" src/app/globals.css tests/unit/admin/erasure-evidence-card.test.tsx
git commit -m "feat(erasure-log): <details> evidence card — collapse complete, SCCM heading, print force-open, reduced-motion"
```

---

## Task 4: `ErasureFilterTabs` (count-bearing status nav)

**Files:**
- Create: `src/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs.tsx`
- Test: `tests/unit/admin/erasure-filter-tabs.test.tsx`

**Interfaces:**
- Consumes: `ErasureStatusFilter`, `ErasureLogSummary` (`@/modules/insights`).
- Produces:
  ```ts
  export function ErasureFilterTabs(props: {
    readonly active: ErasureStatusFilter;   // default 'all'
    readonly summary: ErasureLogSummary;
    readonly q: string;                      // preserved into each href
  }): React.JSX.Element;
  ```
  Hrefs: `/admin/compliance/erasure-log?status={value}` plus `&q=` when `q` non-empty; `status=all` omits the `status` param.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/admin/erasure-filter-tabs.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ErasureFilterTabs } from '@/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs';

const summary = { overdue: 1, inProgress: 2, complete: 14, total: 17 };
function renderTabs(active = 'all' as const, q = '') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErasureFilterTabs active={active} summary={summary} q={q} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('ErasureFilterTabs', () => {
  it('renders four status links inside a nav landmark with counts', () => {
    renderTabs();
    const nav = screen.getByRole('navigation', { name: /filter erasures by status/i });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(within(nav).getByText('17')).toBeInTheDocument(); // All
    expect(within(nav).getByText('1')).toBeInTheDocument();  // Overdue
  });

  it('marks the active status with aria-current=page', () => {
    renderTabs('overdue');
    expect(screen.getByRole('link', { name: /overdue/i })).toHaveAttribute('aria-current', 'page');
  });

  it('preserves the q param in every href and omits status for All', () => {
    renderTabs('all', '42');
    const all = screen.getByRole('link', { name: /all/i });
    const overdue = screen.getByRole('link', { name: /overdue/i });
    expect(all).toHaveAttribute('href', '/admin/compliance/erasure-log?q=42');
    expect(overdue).toHaveAttribute('href', '/admin/compliance/erasure-log?status=overdue&q=42');
  });

  it('shows the ⚠ overdue affordance only when overdue > 0', () => {
    const { rerender } = renderTabs();
    expect(screen.getByTestId('overdue-warning')).toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErasureFilterTabs active="all" summary={{ overdue: 0, inProgress: 0, complete: 3, total: 3 }} q="" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('overdue-warning')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/admin/erasure-filter-tabs.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `erasure-filter-tabs.tsx`**

Port the `NAV_LIST` / `NAV_LINK_BASE` / `NAV_LINK_INACTIVE` / `NAV_LINK_ACTIVE` constants + the scroll-box wrapper from `renewals-section-tabs.tsx` (a server component here — no `usePathname`; active is a prop). Local count badge (no cross-route import).

```tsx
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ErasureStatusFilter, ErasureLogSummary } from '@/modules/insights';

const BASE = '/admin/compliance/erasure-log';
const NAV_LIST = 'inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground pointer-coarse:h-auto';
const NAV_LINK_BASE = "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring pointer-coarse:min-h-11";
const NAV_LINK_INACTIVE = 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground';
const NAV_LINK_ACTIVE = 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground';

function CountBadge({ count, srLabel, destructive }: { count: number; srLabel: string; destructive?: boolean }) {
  return (
    <>
      <span aria-hidden className={cn(
        'ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums ring-1 ring-inset',
        destructive ? 'bg-destructive/10 text-destructive ring-destructive/20' : 'bg-primary/10 text-primary ring-primary/20',
      )}>{count}</span>
      <span className="sr-only"> {srLabel}</span>
    </>
  );
}

function hrefFor(value: ErasureStatusFilter, q: string): string {
  const p = new URLSearchParams();
  if (value !== 'all') p.set('status', value);
  if (q !== '') p.set('q', q);
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function ErasureFilterTabs({
  active, summary, q,
}: {
  readonly active: ErasureStatusFilter;
  readonly summary: ErasureLogSummary;
  readonly q: string;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const items: ReadonlyArray<{ value: ErasureStatusFilter; label: string; count: number; danger?: boolean }> = [
    { value: 'all', label: t('filter.all'), count: summary.total },
    { value: 'overdue', label: t('filter.overdue'), count: summary.overdue, danger: true },
    { value: 'in_progress', label: t('filter.inProgress'), count: summary.inProgress },
    { value: 'complete', label: t('filter.complete'), count: summary.complete },
  ];
  return (
    <div className="-my-1 min-w-0 overflow-x-auto overflow-y-hidden py-1">
      <nav aria-label={t('filter.navLabel')} className={NAV_LIST}>
        {items.map((it) => {
          const isActive = it.value === active;
          const showDanger = it.value === 'overdue' && summary.overdue > 0;
          return (
            <Link
              key={it.value}
              href={hrefFor(it.value, q)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(NAV_LINK_BASE, isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE,
                showDanger && !isActive && 'text-destructive hover:text-destructive dark:text-destructive')}
            >
              {showDanger ? <AlertTriangleIcon aria-hidden data-testid="overdue-warning" className="size-3.5" /> : null}
              {it.label}
              <CountBadge count={it.count} destructive={showDanger} srLabel={t('filter.countSr', { count: it.count })} />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm vitest run tests/unit/admin/erasure-filter-tabs.test.tsx`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs.tsx" tests/unit/admin/erasure-filter-tabs.test.tsx
git commit -m "feat(erasure-log): count-bearing status filter tabs (nav semantics, overdue-red)"
```

---

## Task 5: `ErasureSearchForm` (GET member-number search)

**Files:**
- Create: `src/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form.tsx`
- Test: `tests/unit/admin/erasure-search-form.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function ErasureSearchForm(props: {
    readonly status: string; // preserved as a hidden field
    readonly q: string;      // current value
  }): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/admin/erasure-search-form.test.tsx
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ErasureSearchForm } from '@/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form';

function renderForm(status = 'all', q = '') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErasureSearchForm status={status} q={q} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('ErasureSearchForm', () => {
  it('is a GET form with a member-number input and a hidden status field', () => {
    const { container } = renderForm('overdue');
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form.getAttribute('action')).toBe('/admin/compliance/erasure-log');
    expect(screen.getByLabelText(/search by member number/i)).toHaveAttribute('name', 'q');
    expect(container.querySelector('input[type="hidden"][name="status"]')).toHaveAttribute('value', 'overdue');
  });

  it('shows a clear-search link only when q is non-empty', () => {
    const { rerender } = renderForm('all', '42');
    expect(screen.getByRole('link', { name: /clear search/i })).toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErasureSearchForm status="all" q="" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('link', { name: /clear search/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/admin/erasure-search-form.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `erasure-search-form.tsx`**

```tsx
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const BASE = '/admin/compliance/erasure-log';

export function ErasureSearchForm({ status, q }: { readonly status: string; readonly q: string }): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const clearHref = status !== 'all' ? `${BASE}?status=${status}` : BASE;
  return (
    <form method="get" action={BASE} className="flex items-center gap-2">
      {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
      <label htmlFor="erasure-q" className="sr-only">{t('search.label')}</label>
      <Input id="erasure-q" name="q" defaultValue={q} placeholder={t('search.placeholder')} className="h-9 w-44" inputMode="numeric" />
      <Button type="submit" variant="outline" size="sm" className="h-9">
        <SearchIcon className="size-4" aria-hidden />
        <span>{t('search.submit')}</span>
      </Button>
      {q !== '' ? (
        <Link href={clearHref} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          {t('search.clear')}
        </Link>
      ) : null}
    </form>
  );
}
```
(If `Input`/`Button` prop shapes differ, match `src/components/ui/input.tsx` + `button.tsx`. Button height `h-9` matches the portal-UI convention.)

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm vitest run tests/unit/admin/erasure-search-form.test.tsx`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form.tsx" tests/unit/admin/erasure-search-form.test.tsx
git commit -m "feat(erasure-log): GET member-number search form (RSC, no JS) + clear affordance"
```

---

## Task 6: Wire the page (params → use-case → tabs + search + banners + list + empty/cap)

**Files:**
- Modify: `src/app/(staff)/admin/compliance/erasure-log/page.tsx`
- Delete: `src/app/(staff)/admin/compliance/erasure-log/cursor.ts`
- Delete: `tests/unit/admin/erasure-log-cursor.test.ts`

**Interfaces:**
- Consumes: `getErasureEvidenceLog`, `makeGetErasureEvidenceLogDeps`, `DEFAULT_DISPLAY_CAP`, `ErasureStatusFilter` (`@/modules/insights`); `resolveMemberNumberPrefix`, `drizzleMemberSettingsRepo` (`@/modules/members`); `EvidenceCard`, `ErasureFilterTabs`, `ErasureSearchForm` (Tasks 3-5).

- [ ] **Step 1: Rewrite the page body**

Replace the cursor/pagination logic with param parsing + the new use-case call + the new layout. Key parsing + validation:
```ts
const VALID_STATUS = new Set<ErasureStatusFilter>(['all', 'overdue', 'in_progress', 'complete']);
function parseStatus(v: string): ErasureStatusFilter {
  return VALID_STATUS.has(v as ErasureStatusFilter) ? (v as ErasureStatusFilter) : 'all';
}
```
In the component (after the RBAC gate, unchanged):
```ts
const params = await searchParams;
const status = parseStatus(str(params.status));
const q = str(params.q);
const now = new Date();
const [result, memberPrefix] = await Promise.all([
  getErasureEvidenceLog(makeGetErasureEvidenceLogDeps(), {
    ctx: tenant, now, filter: status, ...(q ? { search: q } : {}), displayCap: DEFAULT_DISPLAY_CAP,
  }),
  resolveMemberNumberPrefix(tenant, drizzleMemberSettingsRepo),
]);
const dateFmt = /* unchanged Intl.DateTimeFormat from the current page */;
```
Layout (inside `<TableContainer>`, after `<PageHeader>`):
```tsx
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <ErasureFilterTabs active={status} summary={result.summary} q={q} />
  <ErasureSearchForm status={status} q={q} />
</div>

{/* Breach banner (S1) — mutually exclusive with all-clear; only on the unfiltered/unsearched 'all' view. */}
{status === 'all' && q === '' && result.summary.overdue > 0 ? (
  <div role="alert" className="rounded-md border border-destructive/40 bg-destructive-surface p-3 text-sm font-medium text-destructive">
    {t('breachAlert', { count: result.summary.overdue })}
  </div>
) : status === 'all' && q === '' && result.summary.total > 0 && result.summary.inProgress === 0 ? (
  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
    {t('allClear')}
  </div>
) : null}

{result.capped ? (
  <p className="text-sm text-muted-foreground">{t('capNote', { cap: DEFAULT_DISPLAY_CAP })}</p>
) : null}
```
Empty-state selection (replaces the current cursor-based empty logic):
```tsx
{result.rows.length === 0 ? (
  <Card><CardContent>
    <EmptyState icon={ShieldCheckIcon}
      title={/* see mapping */} description={/* see mapping */}
      bordered={false} data-testid="erasure-log-empty" />
  </CardContent></Card>
) : (
  <ul className="flex flex-col gap-[var(--page-section-gap)]">
    {result.rows.map((row) => (
      <li key={row.memberId}>
        <EvidenceCard row={row} memberPrefix={memberPrefix} fmt={dateFmt} now={now}
          topBannerPresent={status === 'all' && q === '' && result.summary.overdue > 0} />
      </li>
    ))}
  </ul>
)}
```
Empty title/description mapping:
- `q !== ''` and `status !== 'all'` → `t('filteredSearchEmpty.<statusCamel>', { ref: q })` (map `in_progress`→`inProgress`), description omitted or a generic hint; render as a single-line EmptyState title.
- `q !== ''` and `status === 'all'` → `t('search.empty', { ref: q })`.
- `q === ''` and `status !== 'all'` → `t('filteredEmpty.<statusCamel>')`.
- `q === ''` and `status === 'all'` → the existing org-empty `t('empty.title')` / `t('empty.body')`.

Remove: `decodeCursor`/`encodeCursor` imports, `cursor` param, `nextHref`, the "Load older" `<a>`, the `resultCount` `<p role="status">`, and the now-moved `EvidenceCard`/`Field`/`elapsed`/`DASH` helpers (they live in Task 3's file — import `EvidenceCard`).

- [ ] **Step 2: Delete the retired cursor module + its test**

```bash
git rm "src/app/(staff)/admin/compliance/erasure-log/cursor.ts" tests/unit/admin/erasure-log-cursor.test.ts
```

- [ ] **Step 3: Verify no stale references + gates**

Run: `pnpm typecheck`
Expected: PASS (no `decodeCursor`/`encodeCursor`/`resultCount`/`loadMore`/`emptyTail` references remain).
Run: `pnpm check:i18n`
Expected: PASS.
Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/admin/compliance/erasure-log/page.tsx"
git commit -m "feat(erasure-log): wire triage page — filter tabs + search + breach/all-clear banners + cap note; retire cursor pager"
```

---

## Task 7: Loading skeleton (CLS-safe for the new shape)

**Files:**
- Modify: `src/app/(staff)/admin/compliance/erasure-log/loading.tsx`

- [ ] **Step 1: Update the skeleton**

Add a tab-strip skeleton (4 pills) + a search-input skeleton in a row matching Task 6's toolbar; make `EvidenceCardSkeleton` render a **collapsed** (summary-only) height for two cards + one expanded, so the collapsed-by-default real cards don't shift upward on load.
```tsx
// inside Loading(), after <PageHeader/>:
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <Skeleton className="h-8 w-72 rounded-lg" />
  <Skeleton className="h-9 w-64 rounded-md" />
</div>
<div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden>
  <CollapsedCardSkeleton />
  <ExpandedCardSkeleton />
  <CollapsedCardSkeleton />
</div>
```
`CollapsedCardSkeleton` = a Card with only the summary row (two text skeletons + a badge pill skeleton + chevron). `ExpandedCardSkeleton` = the current two-grid skeleton.

- [ ] **Step 2: Verify build + layout gate**

Run: `pnpm check:layout`
Expected: PASS (TableContainer pairing intact).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/admin/compliance/erasure-log/loading.tsx"
git commit -m "feat(erasure-log): CLS-safe loading skeleton (tab + search + collapsed cards)"
```

---

## Task 8: E2E update (expand card, tabs, search, breach banner, a11y)

**Files:**
- Modify: `tests/e2e/admin-erasure-log.spec.ts`

- [ ] **Step 1: Update the happy-path assertions**

The seeded evidence member is now **collapsed** if complete. Before asserting the five section headings, open its `<details>`:
```ts
// After navigating to ROUTE as admin and locating the seeded card:
const card = page.locator('details[data-evidence]', { hasText: seededMemberRef });
await card.locator('summary').click(); // expand
await expect(card.getByRole('heading', { name: /request & attestation/i })).toBeVisible();
// ...the other four section headings + the M-2 no-actor-uuid assertion (unchanged).
```
If the seed can be made a half-run/overdue member it renders `open` and no click is needed — either is acceptable; prefer clicking to also cover the disclosure interaction. Update `seededMemberRef` to the canonical `SCCM-NNNN` label the heading now shows.

- [ ] **Step 2: Add new assertions**

```ts
// Status filter nav
await expect(page.getByRole('navigation', { name: /filter erasures by status/i })).toBeVisible();
await page.getByRole('link', { name: /overdue/i }).click();
await expect(page).toHaveURL(/status=overdue/);

// Search
await page.goto(ROUTE);
await page.getByLabel(/search by member number/i).fill('SCCM-0000'); // non-existent
await page.getByRole('button', { name: /^search$/i }).click();
await expect(page.getByTestId('erasure-log-empty')).toBeVisible();
```
Keep the existing `@a11y` axe scan (it now also covers the tabs, `<details>`, and banners) and the `@i18n` EN/TH/SV title assertions.

- [ ] **Step 3: (Optional local) run E2E**

Run: `pnpm test:e2e --grep "admin-erasure-log" --workers=1`
Expected: PASS (requires `E2E_ADMIN/MANAGER/MEMBER_*` + `DATABASE_URL` in `.env.local`; if unavailable locally, verify via the CI/e2e run and do not mark green without running).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/admin-erasure-log.spec.ts
git commit -m "test(erasure-log): e2e for <details> disclosure + status tabs + search + a11y"
```

---

## Final gates (before PR)

Run in order; all must pass:
```bash
pnpm lint
pnpm typecheck
pnpm check:i18n
pnpm check:layout
pnpm vitest run tests/unit/insights/erasure-evidence.test.ts tests/unit/admin/erasure-evidence-card.test.tsx tests/unit/admin/erasure-filter-tabs.test.tsx tests/unit/admin/erasure-search-form.test.tsx
```
Then a `security-engineer` read (PII/GDPR surface): confirm no evidence field or M-2-minimised value leaks into the summary/search/sort paths, and the RBAC/no-leak posture (admin-only `notFound`) is intact. Open the PR (single PR; no migration, no flag; admin-only gate).

## Self-review notes (spec coverage)

- Triage (filter tabs + counts + overdue-red + overdue-first sort + requestedAt-asc within overdue) → Tasks 1, 4.
- Progressive disclosure (native `<details>`, complete collapsed / overdue-open, chevron + reduced-motion, cross-browser marker hide) → Task 3.
- SCCM-aware search + display → Tasks 1 (search normalise), 3 (heading), 5 (form).
- Breach banner (S1) + all-clear + per-card note demotion → Tasks 6, 3.
- Empty matrix incl. filter×search (S10) → Task 6 + Task 2 keys.
- Cap honesty (S8) → Tasks 1, 6, 2.
- Print force-open (B1) → Task 3.
- Responsive scroll-box + mobile stack (S9) → Tasks 4, 6.
- sr-only ICU-plural counts (S7) + retire resultCount → Tasks 4, 2, 6.
- Shared/local count badge, no cross-route import (S11) → Task 4.
- Sequential fold (S12) → Task 1.
- CLS skeleton (S6) → Task 7.
- Retire cursor pager → Task 6.
- Deferred (Open questions, NOT in this plan): `?expand=all`, CSV/PDF export, accurate all-org count + `use cache`.
