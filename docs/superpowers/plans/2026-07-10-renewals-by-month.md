# Renewals-by-Month Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Renewals by month" horizontal bar-chart widget above the `/admin/renewals` pipeline that shows how many members' renewals fall in Overdue · this month · the next 11 months · "or later" (from `renewal_cycles.expires_at`, Asia/Bangkok), where clicking a bucket filters the pipeline via `?month=<key>`; plus a pill-matched colour polish on the urgency tabs.

**Architecture:** One shared SQL predicate `MONTH_PLANNING_MEMBER_SQL` (`status ∈ OPEN_CYCLE_STATUSES AND not-erased`) drives BOTH a new repo aggregation (`countCyclesByExpiryMonth`) AND the month-filtered pipeline rows, so `sum(all buckets) === count(that predicate) === rows returned per bucket` (reconciliation invariant). Bucketing math is pure Domain (unit-tested across the BKK boundary); the aggregation and pipeline row-filter are Infrastructure (integration-tested on live Neon); the month lens is mutually-exclusive with the urgency lens and scopes ROWS only (the urgency summary badges stay on the unfiltered 90-day base).

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript strict (`exactOptionalPropertyTypes`) · Drizzle ORM (Neon Postgres, RLS via `runInTenant`) · next-intl (en/th/sv) · Tailwind v4 · Vitest (unit + live-Neon integration + component). **Zero new npm dependencies** (Constitution X).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-10-renewals-by-month-design.md` (v3). Read it before starting.
- **Reconciliation invariant (non-negotiable):** `sum(all 14 buckets) === count(MONTH_PLANNING_MEMBER_SQL)`, and for every bucket key `bucket.count === rows returned by monthFilter=<key>` on the same seeded set.
- **`MONTH_PLANNING_MEMBER_SQL = status = ANY(OPEN_CYCLE_STATUSES) AND MEMBER_NOT_ERASED_SQL`** — `OPEN_CYCLE_STATUSES = ['upcoming','reminded','awaiting_payment']`. `lapsed` (terminal) and `pending_admin_reactivation` are **intentionally excluded**. `MEMBER_NOT_ERASED_SQL` (COMP-1 H4) is **mandatory** on every new query.
- **RLS:** every DB read runs inside `runInTenant(tenant, async (tx) => …)` and uses the threaded `tx`, **never** the global `db` singleton. No explicit `tenant_id` WHERE.
- **Buddhist Era is display-only, via the helper.** `expires_at` is `timestamptz`. Month labels for `th-TH` render BE years ONLY through `formatLocalisedDate`/`getDateFormatLocale` (`'th-TH-u-ca-buddhist'`) — never a literal year, never `+543` arithmetic. A month label MUST carry its year (the window spans two BE years). BKK is fixed UTC+7, no DST.
- **14 buckets, fixed order:** `overdue` · current month (m0) · next 11 months (m1…m11) · `later`. Bucket→band colour: overdue→red, m0→orange, m1–m2→amber, m3–m11 + later→slate. **No blue anywhere.**
- **Clean Architecture:** view-model types live in pure `domain/` (zero framework imports) and are re-exported via BOTH `index.ts` (server barrel) and `client.ts` (client-safe barrel). Presentation resolves labels; the view-model carries none.
- **Colour language:** reuse the exact Tailwind class strings from `src/components/renewals/urgency-pill.tsx` `VARIANT_CLASSES` (lines 16-33) for tabs + chart bands — copy verbatim, do not invent shades.
- **i18n:** every new user-facing string added to `en.json` (canonical) AND `th.json` AND `sv.json` in the same task — `pnpm check:i18n` fails on a missing EN key and CI-blocks on missing TH/SV. Thai plural uses only the `other` category.
- **Commit style:** Conventional Commits, `[Spec Kit]`-free (this is a docs/superpowers-driven feature, not a Spec Kit gate). Example: `feat(renewals): add month-bucketing domain helper`.
- **Test commands:** unit `pnpm test <path>` · integration `pnpm test:integration <path>` (live Neon DEV branch — never prod) · typecheck `pnpm typecheck` (final gate after the last edit) · `pnpm check:i18n`. E2E if run: `--workers=1`.
- **Branch:** `renewals-by-month` (already checked out; spec committed `fda704d5`). Do NOT `git add -A` (repo has gitignored PII working files) — stage explicit paths only. Never `git stash`.

---

## File Structure

**New files:**
- `src/modules/renewals/domain/renewal-month-bucket.ts` — pure bucketing math + view-model types.
- `src/modules/renewals/application/use-cases/load-renewal-month-summary.ts` — use-case (throw propagates).
- `src/app/(staff)/admin/renewals/_components/renewals-by-month-section.tsx` — async server section + skeleton.
- `src/components/renewals/month-bar-chart.tsx` — client horizontal bar list.
- `src/components/renewals/month-bucket-label.ts` — pure label helper + `MonthBarItem` type (shared by section + chart).
- `src/components/renewals/month-filter-chip.tsx` — client clear-filter chip.
- `tests/unit/renewals/domain/renewal-month-bucket.test.ts`
- `tests/unit/components/renewals/month-bucket-label.test.ts`
- `tests/unit/app/renewals/month-bar-chart.test.tsx`
- `tests/integration/renewals/count-cycles-by-month.test.ts`
- `tests/unit/renewals/application/load-pipeline-month.test.ts`

**Modified files:**
- `src/modules/renewals/application/ports/renewal-cycle-repo.ts` — `countCyclesByExpiryMonth` decl + return type; `monthFilter`/`nowIso` on `PipelineQueryOpts`.
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` — `MONTH_PLANNING_MEMBER_SQL`, `monthBoundPredicate`, `countCyclesByExpiryMonth`, month-branch in `loadPipelinePage`.
- `src/modules/renewals/application/use-cases/load-pipeline.ts` — `month` + `nowIso` schema + precedence forwarding.
- `src/modules/renewals/index.ts` — export use-case + VM types.
- `src/modules/renewals/client.ts` — re-export VM types.
- `src/i18n/messages/{en,th,sv}.json` — `admin.renewals.byMonth.*` + `table.noRowsInMonth` + `table.srResultCountMonth`.
- `src/components/renewals/urgency-pill.tsx` — `export` the `VARIANT_CLASSES` const (extract as shared source of truth; values unchanged).
- `src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx` — pill-matched badge colours + nullable `current` ("All" state).
- `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx` — `monthFilterActive` prop → `noRowsInMonth` empty copy.
- `src/components/renewals/result-count-announcer.tsx` — optional `monthLabel` prop.
- `src/app/(staff)/admin/renewals/page.tsx` — parse/validate `?month`, render section + chip, thread month filter, nullable tabs.

---

## Task 1: Domain bucketing helpers + view-model types

**Files:**
- Create: `src/modules/renewals/domain/renewal-month-bucket.ts`
- Test: `tests/unit/renewals/domain/renewal-month-bucket.test.ts`
- Modify: `src/modules/renewals/client.ts`, `src/modules/renewals/index.ts` (re-export types)

**Interfaces:**
- Produces (imported by Tasks 2, 3, 4, 5, 7, 8):
  - `interface RawMonthCount { readonly month: string; readonly count: number }` — `month` is `'YYYY-MM'` (BKK).
  - `interface RenewalMonthAggregation { readonly overdueCount: number; readonly months: readonly RawMonthCount[]; readonly laterCount: number }`
  - `interface RenewalMonthBucket { readonly key: string; readonly count: number }` — `key ∈ 'overdue' | 'YYYY-MM' | 'later'`.
  - `interface RenewalMonthSummary { readonly buckets: readonly RenewalMonthBucket[]; readonly maxCount: number; readonly totalCount: number }`
  - `function bkkYearMonth(iso: string): string`
  - `function addMonthsToYm(ym: string, n: number): string`
  - `function bkkMonthStartInstant(ym: string): Date`
  - `function buildMonthWindow(nowIso: string): string[]` — 12 keys, current BKK month first.
  - `function foldRawMonths(raw: readonly RawMonthCount[], nowIso: string): RenewalMonthAggregation`
  - `function buildRenewalMonthSummary(agg: RenewalMonthAggregation, nowIso: string): RenewalMonthSummary`
  - `function parseMonthParam(raw: string | undefined | null): string | null`
  - `const MIN_BAR_PERCENT = 4` and `function barWidthPercent(count: number, maxCount: number): number`

- [ ] **Step 1: Write the failing test file**

Create `tests/unit/renewals/domain/renewal-month-bucket.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  bkkYearMonth,
  addMonthsToYm,
  bkkMonthStartInstant,
  buildMonthWindow,
  foldRawMonths,
  buildRenewalMonthSummary,
  parseMonthParam,
  barWidthPercent,
  MIN_BAR_PERCENT,
} from '@/modules/renewals/domain/renewal-month-bucket';

describe('bkkYearMonth — Asia/Bangkok wall-clock month', () => {
  it('maps a +07 midnight cycle to its BKK month (host-TZ independent)', () => {
    // 2026-12-01T00:00+07 === 2026-11-30T17:00Z; BKK wall-clock month is 2026-12.
    expect(bkkYearMonth('2026-12-01T00:00:00+07:00')).toBe('2026-12');
    expect(bkkYearMonth('2026-11-30T17:00:00Z')).toBe('2026-12');
  });
  it('does not roll a late-UTC instant back a month in BKK', () => {
    // 2026-06-30T18:00Z === 2026-07-01T01:00+07 → BKK month 2026-07.
    expect(bkkYearMonth('2026-06-30T18:00:00Z')).toBe('2026-07');
  });
});

describe('addMonthsToYm', () => {
  it('adds within a year', () => {
    expect(addMonthsToYm('2026-07', 3)).toBe('2026-10');
  });
  it('crosses the December→January boundary', () => {
    expect(addMonthsToYm('2026-11', 2)).toBe('2027-01');
    expect(addMonthsToYm('2026-07', 12)).toBe('2027-07');
  });
});

describe('bkkMonthStartInstant', () => {
  it('is the UTC instant of the 1st at 00:00 +07', () => {
    expect(bkkMonthStartInstant('2026-12').toISOString()).toBe(
      '2026-11-30T17:00:00.000Z',
    );
  });
});

describe('buildMonthWindow', () => {
  it('returns 12 chronological keys starting at the current BKK month', () => {
    const w = buildMonthWindow('2026-07-10T05:00:00Z'); // BKK 2026-07-10 12:00
    expect(w).toHaveLength(12);
    expect(w[0]).toBe('2026-07');
    expect(w[11]).toBe('2027-06');
  });
});

describe('foldRawMonths', () => {
  const now = '2026-07-10T05:00:00Z'; // BKK month 2026-07; later threshold 2027-07
  it('splits past → overdue, in-window → months, >=+12mo → later', () => {
    const agg = foldRawMonths(
      [
        { month: '2026-05', count: 3 }, // overdue
        { month: '2026-06', count: 2 }, // overdue
        { month: '2026-07', count: 5 }, // window m0
        { month: '2027-02', count: 4 }, // window
        { month: '2027-07', count: 6 }, // later (== +12mo)
        { month: '2028-01', count: 1 }, // later
      ],
      now,
    );
    expect(agg.overdueCount).toBe(5);
    expect(agg.laterCount).toBe(7);
    expect(agg.months).toEqual([
      { month: '2026-07', count: 5 },
      { month: '2027-02', count: 4 },
    ]);
  });
});

describe('buildRenewalMonthSummary', () => {
  const now = '2026-07-10T05:00:00Z';
  it('produces 14 ordered zero-filled buckets with max + total', () => {
    const summary = buildRenewalMonthSummary(
      {
        overdueCount: 2,
        months: [
          { month: '2026-07', count: 17 },
          { month: '2026-09', count: 3 },
        ],
        laterCount: 1,
      },
      now,
    );
    expect(summary.buckets).toHaveLength(14);
    expect(summary.buckets[0]).toEqual({ key: 'overdue', count: 2 });
    expect(summary.buckets[1]).toEqual({ key: '2026-07', count: 17 });
    expect(summary.buckets[2]).toEqual({ key: '2026-08', count: 0 }); // zero-filled
    expect(summary.buckets[3]).toEqual({ key: '2026-09', count: 3 });
    expect(summary.buckets[13]).toEqual({ key: 'later', count: 1 });
    expect(summary.maxCount).toBe(17);
    expect(summary.totalCount).toBe(23);
  });
});

describe('parseMonthParam', () => {
  it('accepts overdue / later / valid YYYY-MM', () => {
    expect(parseMonthParam('overdue')).toBe('overdue');
    expect(parseMonthParam('later')).toBe('later');
    expect(parseMonthParam('2027-01')).toBe('2027-01');
  });
  it('rejects garbage / out-of-range month → null', () => {
    expect(parseMonthParam('2026-13')).toBeNull();
    expect(parseMonthParam('2026-00')).toBeNull();
    expect(parseMonthParam('nope')).toBeNull();
    expect(parseMonthParam(undefined)).toBeNull();
    expect(parseMonthParam(null)).toBeNull();
  });
});

describe('barWidthPercent', () => {
  it('scales proportionally and floors nonzero to MIN_BAR_PERCENT', () => {
    expect(barWidthPercent(17, 17)).toBe(100);
    expect(barWidthPercent(2, 17)).toBeCloseTo(11.76, 1); // 17-vs-2 domination stays visible
    expect(barWidthPercent(1, 1000)).toBe(MIN_BAR_PERCENT); // tiny nonzero floored
    expect(barWidthPercent(0, 17)).toBe(0); // zero stays zero
    expect(barWidthPercent(5, 0)).toBe(0); // empty dataset guard
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/unit/renewals/domain/renewal-month-bucket.test.ts`
Expected: FAIL — `Cannot find module '@/modules/renewals/domain/renewal-month-bucket'`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/renewals/domain/renewal-month-bucket.ts`:

```ts
/**
 * Renewals-by-month — pure Domain bucketing helpers + view-model types.
 *
 * Groups `renewal_cycles.expires_at` (timestamptz) into a fixed 14-bucket
 * planning window in the Asia/Bangkok wall-clock calendar: `overdue` ·
 * current month (m0) · next 11 months · `later`. Zero framework imports
 * (Constitution III) so both the server barrel and the client-safe barrel
 * can re-export the view-model types without dragging the server graph into
 * the browser bundle.
 *
 * Asia/Bangkok is a fixed UTC+7 offset (no DST), so month math is explicit
 * offset arithmetic — deterministic regardless of the host TZ the test or
 * server runs in (never a bare host-local `Date`).
 */

/** One SQL `to_char(... 'YYYY-MM')` group row from the aggregation. */
export interface RawMonthCount {
  readonly month: string;
  readonly count: number;
}

/** Repo aggregation output — already folded into overdue / window / later. */
export interface RenewalMonthAggregation {
  readonly overdueCount: number;
  readonly months: readonly RawMonthCount[];
  readonly laterCount: number;
}

/** One rendered bucket. `key ∈ 'overdue' | 'YYYY-MM' | 'later'`. */
export interface RenewalMonthBucket {
  readonly key: string;
  readonly count: number;
}

/** The full chart view-model: 14 ordered buckets + scaling denominator + total. */
export interface RenewalMonthSummary {
  readonly buckets: readonly RenewalMonthBucket[];
  readonly maxCount: number;
  readonly totalCount: number;
}

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ISO instant → its Asia/Bangkok wall-clock `'YYYY-MM'`. */
export function bkkYearMonth(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + BKK_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** `'YYYY-MM'` + n months → `'YYYY-MM'` (n may be negative). */
export function addMonthsToYm(ym: string, n: number): string {
  const [ys, ms] = ym.split('-');
  const total = Number(ys) * 12 + (Number(ms) - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** The UTC instant corresponding to the 1st of `ym` at 00:00 Asia/Bangkok. */
export function bkkMonthStartInstant(ym: string): Date {
  return new Date(`${ym}-01T00:00:00+07:00`);
}

/** 12 chronological `'YYYY-MM'` keys, current BKK month first. */
export function buildMonthWindow(nowIso: string): string[] {
  const start = bkkYearMonth(nowIso);
  return Array.from({ length: 12 }, (_, i) => addMonthsToYm(start, i));
}

/**
 * Fold raw `to_char`-grouped month counts into overdue / in-window / later
 * relative to the BKK current month. String comparison on `'YYYY-MM'` is
 * lexicographically correct for a fixed-width same-format key.
 */
export function foldRawMonths(
  raw: readonly RawMonthCount[],
  nowIso: string,
): RenewalMonthAggregation {
  const currentYm = bkkYearMonth(nowIso);
  const laterYm = addMonthsToYm(currentYm, 12);
  let overdueCount = 0;
  let laterCount = 0;
  const months: RawMonthCount[] = [];
  for (const r of raw) {
    if (r.month < currentYm) overdueCount += r.count;
    else if (r.month >= laterYm) laterCount += r.count;
    else months.push({ month: r.month, count: r.count });
  }
  return { overdueCount, months, laterCount };
}

/** Assemble the ordered, zero-filled 14-bucket view-model. */
export function buildRenewalMonthSummary(
  agg: RenewalMonthAggregation,
  nowIso: string,
): RenewalMonthSummary {
  const window = buildMonthWindow(nowIso);
  const monthMap = new Map(agg.months.map((m) => [m.month, m.count]));
  const buckets: RenewalMonthBucket[] = [
    { key: 'overdue', count: agg.overdueCount },
    ...window.map((ym) => ({ key: ym, count: monthMap.get(ym) ?? 0 })),
    { key: 'later', count: agg.laterCount },
  ];
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const totalCount = buckets.reduce((s, b) => s + b.count, 0);
  return { buckets, maxCount, totalCount };
}

/**
 * Validate a raw `?month` param: `'overdue'` / `'later'` / strict `YYYY-MM`
 * (rejects `2026-13` / `2026-00`). Invalid → null (caller treats as absent).
 */
export function parseMonthParam(raw: string | undefined | null): string | null {
  if (raw === 'overdue' || raw === 'later') return raw;
  if (typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return null;
}

/** Nonzero bars floor to this %, so a dominated bucket is still visible. */
export const MIN_BAR_PERCENT = 4;

/** Bar fill percent (0–100). Nonzero clamps up to `MIN_BAR_PERCENT`. */
export function barWidthPercent(count: number, maxCount: number): number {
  if (maxCount <= 0 || count <= 0) return 0;
  return Math.max(MIN_BAR_PERCENT, (count / maxCount) * 100);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/unit/renewals/domain/renewal-month-bucket.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Re-export the VM types via both barrels**

In `src/modules/renewals/client.ts`, append after the existing `PipelineRow`/`UrgencyBucket` re-export block (currently ends at line 46):

```ts

// Renewals-by-month view-model types — pure Domain (client-bundle-safe).
export type {
  RenewalMonthBucket,
  RenewalMonthSummary,
  RenewalMonthAggregation,
} from './domain/renewal-month-bucket';
```

In `src/modules/renewals/index.ts`, add a new `export type` block immediately after the pipeline-shapes block (which ends at line 296, `} from './application/ports/renewal-cycle-repo';`):

```ts

// Renewals-by-month view-model types (pure Domain).
export type {
  RenewalMonthBucket,
  RenewalMonthSummary,
  RenewalMonthAggregation,
  RawMonthCount,
} from './domain/renewal-month-bucket';
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/modules/renewals/domain/renewal-month-bucket.ts \
        src/modules/renewals/client.ts \
        src/modules/renewals/index.ts \
        tests/unit/renewals/domain/renewal-month-bucket.test.ts
git commit -m "feat(renewals): add month-bucketing domain helpers + VM types"
```

---

## Task 2: Repo aggregation `countCyclesByExpiryMonth`

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (add method decl, before line 391)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (add `MONTH_PLANNING_MEMBER_SQL` + `EXPIRY_MONTH_SQL` after line 383; add method after `loadPipelinePage` ends ~line 1267)
- Test: `tests/integration/renewals/count-cycles-by-month.test.ts`

**Interfaces:**
- Consumes: `foldRawMonths`, `RenewalMonthAggregation` (Task 1); `OPEN_CYCLE_STATUSES` (`domain/value-objects/cycle-status.ts:67`); existing `MEMBER_NOT_ERASED_SQL` (`drizzle-renewal-cycle-repo.ts:378-383`).
- Produces (imported by Task 3, and `MONTH_PLANNING_MEMBER_SQL`/`monthBoundPredicate` by Task 5):
  - Port method `countCyclesByExpiryMonth(tenantId: string, opts: { nowIso: string; timezone: 'Asia/Bangkok' }): Promise<RenewalMonthAggregation>`
  - Module-scope `const MONTH_PLANNING_MEMBER_SQL: SQL`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/renewals/count-cycles-by-month.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Fixed "now" so the 12-month window + overdue/later thresholds are stable.
const NOW_ISO = '2026-07-10T05:00:00Z'; // BKK 2026-07-10 12:00 → window 2026-07…2027-06

describe('countCyclesByExpiryMonth — integration', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(erased: boolean): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Co ${memberId.slice(0, 6)}`,
        status: 'active',
        registrationDate: '2025-01-01',
        planId: 'regular',
        country: 'TH',
        ...(erased ? { erasedAt: new Date() } : {}),
      }),
    );
    return memberId;
  }

  async function seedCycle(args: {
    memberId: string;
    status: string;
    expiresAt: Date;
  }): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId: args.memberId,
        status: args.status,
        periodFrom: new Date(args.expiresAt.getTime() - 365 * MS_PER_DAY),
        periodTo: args.expiresAt,
        expiresAt: args.expiresAt,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }

  it('folds counts into overdue / window months / later and excludes erased + terminal', async () => {
    const live = await seedMember(false);
    const erased = await seedMember(true);

    // overdue (BKK 2026-05)
    await seedCycle({ memberId: live, status: 'upcoming', expiresAt: new Date('2026-05-15T04:00:00Z') });
    // current window month 2026-07 (BKK) — two members
    await seedCycle({ memberId: live, status: 'reminded', expiresAt: new Date('2026-07-20T04:00:00Z') });
    await seedCycle({ memberId: live, status: 'awaiting_payment', expiresAt: new Date('2026-07-25T04:00:00Z') });
    // window month 2027-02
    await seedCycle({ memberId: live, status: 'upcoming', expiresAt: new Date('2027-02-10T04:00:00Z') });
    // later (== now + 12mo boundary, BKK 2027-07)
    await seedCycle({ memberId: live, status: 'upcoming', expiresAt: new Date('2027-07-05T04:00:00Z') });
    // EXCLUDED: erased member's live cycle
    await seedCycle({ memberId: erased, status: 'upcoming', expiresAt: new Date('2026-07-20T04:00:00Z') });
    // EXCLUDED: terminal + pending_admin_reactivation
    await seedCycle({ memberId: live, status: 'lapsed', expiresAt: new Date('2026-07-20T04:00:00Z') });
    await seedCycle({ memberId: live, status: 'completed', expiresAt: new Date('2026-07-20T04:00:00Z') });
    await seedCycle({ memberId: live, status: 'pending_admin_reactivation', expiresAt: new Date('2026-07-20T04:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });

    expect(agg.overdueCount).toBe(1);
    expect(agg.laterCount).toBe(1);
    const map = new Map(agg.months.map((m) => [m.month, m.count]));
    expect(map.get('2026-07')).toBe(2);
    expect(map.get('2027-02')).toBe(1);
    // erased + terminal + pending_admin_reactivation never counted:
    const total =
      agg.overdueCount + agg.laterCount + agg.months.reduce((s, m) => s + m.count, 0);
    expect(total).toBe(5);
  });
});
```

> If `members` insert columns differ from the seed above, mirror the exact column set the existing `tests/integration/helpers/seed-renewal-cycle.ts` uses for its `members` insert (read that helper). Do not add columns that don't exist on the schema.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/renewals/count-cycles-by-month.test.ts`
Expected: FAIL — `deps.cyclesRepo.countCyclesByExpiryMonth is not a function`.

- [ ] **Step 3: Add the port method declaration**

In `src/modules/renewals/application/ports/renewal-cycle-repo.ts`:

Add the VM-type import at the top of the file's type imports (near the other domain imports):

```ts
import type { RenewalMonthAggregation } from '../../domain/renewal-month-bucket';
```

Add `monthFilter` + `nowIso` to `PipelineQueryOpts` (currently lines 460-465) — replace it with:

```ts
export interface PipelineQueryOpts {
  readonly tier?: TierBucket;
  readonly urgency?: UrgencyBucket;
  /**
   * Renewals-by-month lens — `'overdue' | 'YYYY-MM' | 'later'` (validated
   * upstream by the use-case). When present the row query is rebuilt from
   * `MONTH_PLANNING_MEMBER_SQL` + a month bound and the 90-day ceiling is
   * SUPPRESSED; the urgency summary + lapsed count are UNAFFECTED. Requires
   * `nowIso` to resolve the BKK month boundaries. Ignores `tier`.
   */
  readonly monthFilter?: string;
  /** ISO instant driving the month-filter boundaries (BKK). */
  readonly nowIso?: string;
  readonly cursor?: string | null;
  readonly limit: number;
}
```

Add the method declaration inside the `RenewalCycleRepo` interface, immediately after `listMembersWithoutCycle(...)` (which ends at line 390) and before `countCyclesForMemberInTx` (line 392):

```ts

  /**
   * Renewals-by-month aggregation. Groups `MONTH_PLANNING_MEMBER_SQL`
   * cycles by `to_char(expires_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`
   * then folds into overdue / 12-month window / later relative to `nowIso`.
   * Excludes GDPR-erased members + terminal + pending_admin_reactivation
   * cycles by construction (see the shared predicate). Runs inside
   * `runInTenant` (RLS+FORCE; threads `tx`, never global `db`).
   *
   * `expires_at` is `timestamptz`; `AT TIME ZONE 'Asia/Bangkok'` yields the
   * correct BKK wall-clock month. A future column-type change to a plain
   * timestamp would silently break this — must trip review.
   */
  countCyclesByExpiryMonth(
    tenantId: string,
    opts: { nowIso: string; timezone: 'Asia/Bangkok' },
  ): Promise<RenewalMonthAggregation>;
```

- [ ] **Step 4: Add `MONTH_PLANNING_MEMBER_SQL` + `EXPIRY_MONTH_SQL` in the repo**

In `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts`, add these imports (top of file, near the existing domain imports):

```ts
import { OPEN_CYCLE_STATUSES } from '../../domain/value-objects/cycle-status';
import {
  foldRawMonths,
  bkkYearMonth,
  addMonthsToYm,
  bkkMonthStartInstant,
} from '../../domain/renewal-month-bucket';
import type { RenewalMonthAggregation } from '../../domain/renewal-month-bucket';
```

Immediately AFTER the `MEMBER_NOT_ERASED_SQL` definition (ends line 383), add:

```ts

/**
 * Renewals-by-month planning set — the SINGLE predicate shared by the
 * `countCyclesByExpiryMonth` aggregation AND the month-filtered pipeline
 * rows, so `sum(all buckets) === count(this) === rows-per-bucket`
 * (reconciliation invariant). `OPEN_CYCLE_STATUSES` = the module's canonical
 * "an upcoming renewal that will actually happen" set; it deliberately
 * EXCLUDES `lapsed` (terminal — surfaced by the Lapsed tab) and
 * `pending_admin_reactivation` (a reopened money-hold). `MEMBER_NOT_ERASED_SQL`
 * (COMP-1 H4) is non-negotiable — dropping it would re-admit a GDPR-erased
 * member and break reconciliation with the month-filtered pipeline.
 */
const MONTH_PLANNING_MEMBER_SQL: SQL = and(
  inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
  MEMBER_NOT_ERASED_SQL,
)!;

/** BKK wall-clock `'YYYY-MM'` bucket key for a cycle's `expires_at`. */
const EXPIRY_MONTH_SQL = sql<string>`to_char(${renewalCycles.expiresAt} AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;

/**
 * Half-open `expires_at` bound for a `?month` bucket, in BKK. Used by the
 * month-filtered pipeline rows (Task 5) so the row set matches the bucket's
 * counted set exactly. Bounds are JS `Date` instants (drizzle binds them as
 * `timestamptz` params) — no `to_char` in the WHERE, so the `expires_at`
 * index stays usable.
 */
function monthBoundPredicate(key: string, nowIso: string): SQL {
  const currentYm = bkkYearMonth(nowIso);
  if (key === 'overdue') {
    return sql`${renewalCycles.expiresAt} < ${bkkMonthStartInstant(currentYm)}`;
  }
  if (key === 'later') {
    return sql`${renewalCycles.expiresAt} >= ${bkkMonthStartInstant(addMonthsToYm(currentYm, 12))}`;
  }
  return and(
    sql`${renewalCycles.expiresAt} >= ${bkkMonthStartInstant(key)}`,
    sql`${renewalCycles.expiresAt} < ${bkkMonthStartInstant(addMonthsToYm(key, 1))}`,
  )!;
}
```

> Confirm `inArray` is already imported (it is — line 20: `import { and, asc, eq, ne, sql, inArray, desc, or, isNull, isNotNull, type SQL } from 'drizzle-orm';`).

- [ ] **Step 5: Implement `countCyclesByExpiryMonth`**

In the same file, add the method to the returned repo object, immediately AFTER `loadPipelinePage` closes (~line 1267) and BEFORE `countCyclesForMemberInTx` (~line 1275):

```ts
    async countCyclesByExpiryMonth(
      _tenantId: string,
      opts: { nowIso: string; timezone: 'Asia/Bangkok' },
    ): Promise<RenewalMonthAggregation> {
      // Threads `tx` from runInTenant — RLS auto-scopes; NEVER global db.
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select({
            month: EXPIRY_MONTH_SQL.as('month'),
            count: sql<number>`count(*)::int`,
          })
          .from(renewalCycles)
          .where(MONTH_PLANNING_MEMBER_SQL)
          .groupBy(EXPIRY_MONTH_SQL);
        return foldRawMonths(
          rows.map((r) => ({ month: r.month, count: r.count })),
          opts.nowIso,
        );
      });
    },
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `pnpm test:integration tests/integration/renewals/count-cycles-by-month.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/renewals/application/ports/renewal-cycle-repo.ts \
        src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts \
        tests/integration/renewals/count-cycles-by-month.test.ts
git commit -m "feat(renewals): add countCyclesByExpiryMonth aggregation + shared planning predicate"
```

---

## Task 3: Use-case `loadRenewalMonthSummary`

**Files:**
- Create: `src/modules/renewals/application/use-cases/load-renewal-month-summary.ts`
- Modify: `src/modules/renewals/index.ts` (export use-case)
- Test: `tests/unit/renewals/application/load-renewal-month-summary.test.ts`

**Interfaces:**
- Consumes: `buildRenewalMonthSummary`, `RenewalMonthSummary` (Task 1); `RenewalCycleRepo.countCyclesByExpiryMonth` (Task 2); `RenewalsDeps` (`../../infrastructure/renewals-deps`); `ok`/`Result` (`@/lib/result`).
- Produces (imported by Task 9):
  - `function loadRenewalMonthSummary(deps: Pick<RenewalsDeps, 'cyclesRepo'>, input: { tenantId: string; nowIso: string }): Promise<Result<RenewalMonthSummary, never>>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renewals/application/load-renewal-month-summary.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadRenewalMonthSummary } from '@/modules/renewals/application/use-cases/load-renewal-month-summary';
import type { RenewalMonthAggregation } from '@/modules/renewals/domain/renewal-month-bucket';

const NOW = '2026-07-10T05:00:00Z';

function depsWith(agg: RenewalMonthAggregation) {
  return {
    cyclesRepo: {
      countCyclesByExpiryMonth: vi.fn().mockResolvedValue(agg),
    },
  } as never;
}

describe('loadRenewalMonthSummary', () => {
  it('maps the aggregation into the 14-bucket summary', async () => {
    const deps = depsWith({
      overdueCount: 2,
      months: [{ month: '2026-07', count: 17 }],
      laterCount: 1,
    });
    const result = await loadRenewalMonthSummary(deps, {
      tenantId: 't1',
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets).toHaveLength(14);
    expect(result.value.totalCount).toBe(20);
    expect(result.value.maxCount).toBe(17);
    expect(result.value.buckets[0]).toEqual({ key: 'overdue', count: 2 });
    expect(result.value.buckets[13]).toEqual({ key: 'later', count: 1 });
  });

  it('propagates an infra throw (does NOT swallow into an empty summary)', async () => {
    const deps = {
      cyclesRepo: {
        countCyclesByExpiryMonth: vi
          .fn()
          .mockRejectedValue(new Error('db down')),
      },
    } as never;
    await expect(
      loadRenewalMonthSummary(deps, { tenantId: 't1', nowIso: NOW }),
    ).rejects.toThrow('db down');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/unit/renewals/application/load-renewal-month-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the use-case**

Create `src/modules/renewals/application/use-cases/load-renewal-month-summary.ts`:

```ts
/**
 * Renewals-by-month — `loadRenewalMonthSummary`.
 *
 * Thin orchestration over `cyclesRepo.countCyclesByExpiryMonth` (which runs
 * the RLS-scoped aggregation inside one `runInTenant` block) → the pure
 * `buildRenewalMonthSummary` view-model. Input is server-sourced (no request
 * body) so the Result error channel is `never`.
 *
 * An infrastructure throw PROPAGATES — this use-case does NOT catch (mirrors
 * `loadMembersWithoutCycle`). The page/section wrapper try/catches best-effort
 * and renders a "couldn't load" card, so a renewals-side failure never crashes
 * the pipeline page. Empty (all buckets 0) is a distinct non-error render.
 *
 * Tenant isolation: the repo threads `tx` from `runInTenant`; this use-case
 * never touches a DB client directly (Constitution Principle I + III).
 */
import { ok, type Result } from '@/lib/result';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  buildRenewalMonthSummary,
  type RenewalMonthSummary,
} from '../../domain/renewal-month-bucket';

export interface LoadRenewalMonthSummaryInput {
  readonly tenantId: string;
  /** ISO instant anchoring the BKK 12-month window (page-level, shared with the pipeline month filter). */
  readonly nowIso: string;
}

export async function loadRenewalMonthSummary(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  input: LoadRenewalMonthSummaryInput,
): Promise<Result<RenewalMonthSummary, never>> {
  const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(input.tenantId, {
    nowIso: input.nowIso,
    timezone: 'Asia/Bangkok',
  });
  return ok(buildRenewalMonthSummary(agg, input.nowIso));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/unit/renewals/application/load-renewal-month-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the use-case from the server barrel**

In `src/modules/renewals/index.ts`, add after the `loadPipeline` export block (lines 298-304):

```ts

export {
  loadRenewalMonthSummary,
  type LoadRenewalMonthSummaryInput,
} from './application/use-cases/load-renewal-month-summary';
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/renewals/application/use-cases/load-renewal-month-summary.ts \
        src/modules/renewals/index.ts \
        tests/unit/renewals/application/load-renewal-month-summary.test.ts
git commit -m "feat(renewals): add loadRenewalMonthSummary use-case"
```

---

## Task 4: Pipeline app-layer — `month` param + precedence

**Files:**
- Modify: `src/modules/renewals/application/use-cases/load-pipeline.ts`
- Test: `tests/unit/renewals/application/load-pipeline-month.test.ts`

**Interfaces:**
- Consumes: `parseMonthParam` (Task 1); `PipelineQueryOpts.monthFilter`/`nowIso` (Task 2).
- Produces: `loadPipelineInputSchema` accepts optional `month: string` + `nowIso: string`; the use-case forwards at most one of `{urgency}` vs `{monthFilter, nowIso}` to `cyclesRepo.loadPipelinePage` (valid month wins; invalid/absent month → urgency honoured).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renewals/application/load-pipeline-month.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadPipeline } from '@/modules/renewals/application/use-cases/load-pipeline';

function makeDeps() {
  const loadPipelinePage = vi.fn().mockResolvedValue({
    rows: [],
    nextCursor: null,
    summary: {
      totalInWindow: 0,
      byUrgency: { 't-90': 0, 't-60': 0, 't-30': 0, 't-14': 0, 't-7': 0, 't-0': 0, grace: 0, lapsed: 0 },
      lapsedCount: 0,
    },
  });
  return { deps: { cyclesRepo: { loadPipelinePage } } as never, loadPipelinePage };
}

const NOW = '2026-07-10T05:00:00Z';

describe('loadPipeline — month vs urgency precedence', () => {
  it('a valid month forwards monthFilter+nowIso and DROPS urgency', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, {
      tenantId: 't1',
      urgency: 't-30',
      month: '2027-02',
      nowIso: NOW,
      limit: 50,
    });
    const opts = loadPipelinePage.mock.calls[0][1];
    expect(opts.monthFilter).toBe('2027-02');
    expect(opts.nowIso).toBe(NOW);
    expect(opts.urgency).toBeUndefined();
  });

  it('overdue / later are valid month keys', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, { tenantId: 't1', month: 'overdue', nowIso: NOW, limit: 50 });
    expect(loadPipelinePage.mock.calls[0][1].monthFilter).toBe('overdue');
  });

  it('an invalid month is ignored and urgency is honoured', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, {
      tenantId: 't1',
      urgency: 't-7',
      month: '2026-13',
      nowIso: NOW,
      limit: 50,
    });
    const opts = loadPipelinePage.mock.calls[0][1];
    expect(opts.monthFilter).toBeUndefined();
    expect(opts.urgency).toBe('t-7');
  });

  it('a valid month with NO nowIso falls back to urgency (defensive)', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, { tenantId: 't1', urgency: 't-7', month: '2027-02', limit: 50 });
    const opts = loadPipelinePage.mock.calls[0][1];
    expect(opts.monthFilter).toBeUndefined();
    expect(opts.urgency).toBe('t-7');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/unit/renewals/application/load-pipeline-month.test.ts`
Expected: FAIL — `monthFilter` is `undefined` (schema strips unknown keys; forwarding not yet implemented).

- [ ] **Step 3: Extend the schema + forwarding**

In `src/modules/renewals/application/use-cases/load-pipeline.ts`:

Add the import (after line 30):

```ts
import { parseMonthParam } from '../../domain/renewal-month-bucket';
```

Add two keys to `loadPipelineInputSchema` (currently lines 43-51) — insert before `cursor`:

```ts
  // Renewals-by-month lens. Kept loose (raw string) so an invalid value is
  // treated as ABSENT (→ urgency still applies), not a hard 400.
  month: z.string().optional(),
  nowIso: z.string().datetime().optional(),
```

Inside `loadPipeline`, after `const input = parsed.data;` (line 77) and before the `withActiveSpan` call, compute the effective lens:

```ts
  // F6 — validate month precedence in the use-case (not SQL). A present +
  // VALID month wins and urgency is ignored; an invalid month string is
  // treated as absent so a valid urgency still applies. The month path needs
  // `nowIso` for the BKK boundaries; without it, fall back to urgency.
  const monthFilter =
    input.nowIso !== undefined ? parseMonthParam(input.month) : null;
  const useMonthLens = monthFilter !== null;
```

Replace the repo call block (lines 93-100) with:

```ts
      const r = await deps.cyclesRepo.loadPipelinePage(input.tenantId, {
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        // Mutually-exclusive lenses: month wins, else urgency.
        ...(useMonthLens
          ? { monthFilter: monthFilter as string, nowIso: input.nowIso as string }
          : input.urgency !== undefined
            ? { urgency: input.urgency }
            : {}),
        ...(input.cursor !== undefined && input.cursor !== null
          ? { cursor: input.cursor }
          : {}),
        limit: input.limit ?? 50,
      });
```

> The `span.setAttribute('renewals.urgency_filter', input.urgency ?? 'all')` and metric calls below stay as-is — they still describe the urgency summary, which is unchanged under a month filter.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/unit/renewals/application/load-pipeline-month.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/renewals/application/use-cases/load-pipeline.ts \
        tests/unit/renewals/application/load-pipeline-month.test.ts
git commit -m "feat(renewals): thread ?month lens through load-pipeline with urgency precedence"
```

---

## Task 5: Drizzle `loadPipelinePage` — month filter (suppress 90d, summary unchanged)

**Files:**
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (`pageFilters` build block, lines 1159-1174)
- Test: extend `tests/integration/renewals/count-cycles-by-month.test.ts` with reconciliation cases

**Interfaces:**
- Consumes: `MONTH_PLANNING_MEMBER_SQL`, `monthBoundPredicate` (Task 2); `PipelineQueryOpts.monthFilter`/`nowIso` (Task 2).
- Produces: `loadPipelinePage` rows filtered by month (90d ceiling suppressed, tier ignored, rebuilt from the planning predicate — NOT `baseFilters.slice()`); `summary.byUrgency` + `lapsedCount` UNCHANGED by a month filter.

- [ ] **Step 1: Write the failing reconciliation test**

Append to `tests/integration/renewals/count-cycles-by-month.test.ts` (inside the same `describe`, after the existing test):

```ts
  it('month-filtered pipeline reconciles with the bucket count, suppresses the 90d ceiling, and leaves the urgency summary unchanged', async () => {
    // Fresh tenant slice within the same suite tenant is fine — assert by
    // month membership, not absolute totals, to stay robust to prior rows.
    const live = await seedMember(false);
    // A cycle > 90 days out (BKK 2027-02) — invisible to the urgency window,
    // visible to the month lens.
    await seedCycle({ memberId: live, status: 'upcoming', expiresAt: new Date('2027-02-14T04:00:00Z') });

    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const agg = await deps.cyclesRepo.countCyclesByExpiryMonth(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      timezone: 'Asia/Bangkok',
    });
    const febBucket = agg.months.find((m) => m.month === '2027-02');
    expect(febBucket).toBeDefined();

    // Baseline summary WITHOUT month filter.
    const base = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      urgency: 't-30',
      limit: 200,
    });

    // Rows WITH month filter — 90d ceiling must be suppressed (Feb 2027 > 90d).
    const monthPage = await deps.cyclesRepo.loadPipelinePage(tenant.ctx.slug, {
      monthFilter: '2027-02',
      nowIso: NOW_ISO,
      limit: 200,
    });

    // Reconciliation: rows returned for the month == the bucket count.
    expect(monthPage.rows.length).toBe(febBucket!.count);
    expect(monthPage.rows.every((r) => r.expiresAt >= '2027-02')).toBe(true);

    // F3: the urgency summary + lapsed count are identical with/without month.
    expect(monthPage.summary.byUrgency).toEqual(base.summary.byUrgency);
    expect(monthPage.summary.lapsedCount).toBe(base.summary.lapsedCount);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/renewals/count-cycles-by-month.test.ts`
Expected: FAIL — `monthPage.rows` is empty (the 90d ceiling from `baseFilters.slice()` filters out the Feb-2027 cycle; month filter not yet wired into rows).

- [ ] **Step 3: Rebuild the row filters under a month filter**

In `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts`, replace the `pageFilters` build block (lines 1159-1174) with:

```ts
        // Page query filters. Two mutually-exclusive shapes:
        //  - MONTH lens (opts.monthFilter present): REBUILD from
        //    MONTH_PLANNING_MEMBER_SQL — NOT baseFilters.slice(). baseFilters
        //    carries `status NOT IN (cancelled,completed)` (keeps lapsed) AND
        //    the 90-day ceiling; the month bounds ARE the window and lapsed
        //    must not leak into an `overdue` click. Tier is intentionally
        //    ignored (the chart aggregation is whole-tenant). Summary +
        //    lapsedCount above stay on `baseFilters` → urgency badges are
        //    unchanged by a month filter (F3, "two independent lenses").
        //  - URGENCY lens (default): unchanged — slice baseFilters + urgency.
        let pageFilters: SQL[];
        if (opts.monthFilter && opts.nowIso) {
          pageFilters = [
            MONTH_PLANNING_MEMBER_SQL,
            monthBoundPredicate(opts.monthFilter, opts.nowIso),
          ];
        } else {
          pageFilters = baseFilters.slice();
          if (opts.urgency && opts.urgency !== 'lapsed') {
            pageFilters.push(eq(URGENCY_CASE_SQL, opts.urgency));
          }
        }
        if (cursor) {
          pageFilters.push(
            or(
              sql`${renewalCycles.expiresAt} > ${cursor.expiresAt}`,
              and(
                eq(renewalCycles.expiresAt, new Date(cursor.expiresAt)),
                sql`${renewalCycles.cycleId} > ${cursor.cycleId}`,
              ),
            )!,
          );
        }
```

> The downstream page `SELECT … .where(and(...pageFilters))` + `ORDER BY (expires_at, cycle_id) ASC` + `limit(limit + 1)` is UNCHANGED — it already consumes `pageFilters`.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm test:integration tests/integration/renewals/count-cycles-by-month.test.ts`
Expected: PASS (both the aggregation test and the reconciliation test).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts \
        tests/integration/renewals/count-cycles-by-month.test.ts
git commit -m "feat(renewals): month-filter pipeline rows, suppress 90d ceiling, keep summary on base"
```

---

## Task 6: i18n — `admin.renewals.byMonth.*` + pipeline month keys

**Files:**
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json`

**Interfaces:**
- Produces (consumed by Tasks 7-12): keys under `admin.renewals.byMonth.*`, plus `admin.renewals.table.noRowsInMonth` and `admin.renewals.table.srResultCountMonth`.

- [ ] **Step 1: Add the EN keys**

In `src/i18n/messages/en.json`, inside `admin.renewals`, add a `byMonth` object as a sibling of `urgencyBuckets` (insert directly before the `"table": {` key):

```json
      "byMonth": {
        "title": "Renewals by month",
        "subtitle": "{count, plural, one {# renewal over the next year} other {# renewals over the next year}}",
        "overdue": "Overdue",
        "later": "{month} or later",
        "listAriaLabel": "Renewals by month",
        "bucketAriaLabel": "{label}: {count, plural, one {# member} other {# members}}",
        "zeroBucketAriaLabel": "{label}: no members",
        "selectedSr": "selected",
        "clearFilter": "Clear month filter",
        "filterChip": "Renewing in {month}",
        "emptyTitle": "No upcoming renewals",
        "emptyDescription": "No members have an upcoming renewal to plan for yet.",
        "loadFailed": "Couldn't load the renewals-by-month overview. Please try again."
      },
```

In the same `admin.renewals.table` object, add two keys after `"noRowsInBucket"`:

```json
        "noRowsInMonth": "No members renew in {month}.",
        "srResultCountMonth": "{count, plural, one {Showing # member renewing in {month}} other {Showing # members renewing in {month}}}",
```

- [ ] **Step 2: Add the TH keys**

In `src/i18n/messages/th.json`, mirror the same structure under `admin.renewals`:

```json
      "byMonth": {
        "title": "การต่ออายุรายเดือน",
        "subtitle": "{count, plural, other {# รายการต่ออายุในช่วง 12 เดือนข้างหน้า}}",
        "overdue": "เกินกำหนด",
        "later": "{month} เป็นต้นไป",
        "listAriaLabel": "การต่ออายุรายเดือน",
        "bucketAriaLabel": "{label}: {count, plural, other {# สมาชิก}}",
        "zeroBucketAriaLabel": "{label}: ไม่มีสมาชิก",
        "selectedSr": "เลือกอยู่",
        "clearFilter": "ล้างตัวกรองเดือน",
        "filterChip": "ต่ออายุใน {month}",
        "emptyTitle": "ยังไม่มีการต่ออายุที่กำลังจะถึง",
        "emptyDescription": "ยังไม่มีสมาชิกที่มีการต่ออายุที่กำลังจะถึงให้วางแผน",
        "loadFailed": "โหลดภาพรวมการต่ออายุรายเดือนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"
      },
```

Add to `admin.renewals.table` (TH):

```json
        "noRowsInMonth": "ไม่มีสมาชิกที่ต่ออายุใน {month}",
        "srResultCountMonth": "{count, plural, other {แสดง # สมาชิกที่ต่ออายุใน {month}}}",
```

- [ ] **Step 3: Add the SV keys**

In `src/i18n/messages/sv.json`, mirror under `admin.renewals`:

```json
      "byMonth": {
        "title": "Förnyelser per månad",
        "subtitle": "{count, plural, one {# förnyelse under det kommande året} other {# förnyelser under det kommande året}}",
        "overdue": "Förfallna",
        "later": "{month} eller senare",
        "listAriaLabel": "Förnyelser per månad",
        "bucketAriaLabel": "{label}: {count, plural, one {# medlem} other {# medlemmar}}",
        "zeroBucketAriaLabel": "{label}: inga medlemmar",
        "selectedSr": "vald",
        "clearFilter": "Rensa månadsfilter",
        "filterChip": "Förnyas i {month}",
        "emptyTitle": "Inga kommande förnyelser",
        "emptyDescription": "Inga medlemmar har en kommande förnyelse att planera för ännu.",
        "loadFailed": "Det gick inte att läsa in översikten över förnyelser per månad. Försök igen."
      },
```

Add to `admin.renewals.table` (SV):

```json
        "noRowsInMonth": "Inga medlemmar förnyas i {month}.",
        "srResultCountMonth": "{count, plural, one {Visar # medlem som förnyas i {month}} other {Visar # medlemmar som förnyas i {month}}}",
```

- [ ] **Step 4: Verify i18n coverage + JSON validity**

Run: `pnpm check:i18n`
Expected: PASS — no missing EN keys; TH/SV present (no warnings that CI-block).

Run: `pnpm typecheck`
Expected: PASS (next-intl augments message types from `en.json`).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "i18n(renewals): add byMonth chart + month-filtered pipeline strings"
```

---

## Task 7: Pure label helper + `MonthBarItem` type

**Files:**
- Create: `src/components/renewals/month-bucket-label.ts`
- Test: `tests/unit/components/renewals/month-bucket-label.test.ts`

**Interfaces:**
- Consumes: `formatLocalisedDate` (`@/lib/format-date-localised`).
- Produces (imported by Tasks 8, 9):
  - `interface MonthBarItem { readonly key: string; readonly label: string; readonly count: number; readonly barPercent: number; readonly interactive: boolean }`
  - `function formatMonthKeyLabel(monthKey: string, locale: string): string` — `'YYYY-MM'` → localized "Month YYYY" (BE year for th via the helper, never a literal).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/components/renewals/month-bucket-label.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMonthKeyLabel } from '@/components/renewals/month-bucket-label';

describe('formatMonthKeyLabel', () => {
  it('renders EN month + Gregorian year', () => {
    const label = formatMonthKeyLabel('2027-07', 'en');
    expect(label).toContain('July');
    expect(label).toContain('2027');
  });

  it('renders TH month with the BUDDHIST-ERA year (2569, never 2026)', () => {
    const label = formatMonthKeyLabel('2026-12', 'th');
    expect(label).toContain('2569'); // 2026 + 543
    expect(label).not.toContain('2026');
  });

  it('does not drift a month across the UTC boundary', () => {
    // 2026-12 must render December, not November.
    expect(formatMonthKeyLabel('2026-12', 'en')).toContain('December');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/unit/components/renewals/month-bucket-label.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/components/renewals/month-bucket-label.ts`:

```ts
/**
 * Renewals-by-month — pure presentation label helper + chart view item.
 *
 * `formatMonthKeyLabel` converts a `'YYYY-MM'` bucket key into a localized
 * "Month YYYY" label. For `th-TH` the year renders in the Buddhist Era via
 * `formatLocalisedDate`/`getDateFormatLocale` (`'th-TH-u-ca-buddhist'`) — the
 * calendar does the +543, so NEVER add a literal year or arithmetic (the
 * off-by-543 class of bug). `timeZone: 'UTC'` on a `-01T00:00:00Z` anchor
 * keeps the month stable across runtimes.
 */
import { formatLocalisedDate } from '@/lib/format-date-localised';

/** A single rendered bar row (server-resolved, serialisable to the client chart). */
export interface MonthBarItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly barPercent: number;
  readonly interactive: boolean;
}

export function formatMonthKeyLabel(monthKey: string, locale: string): string {
  return formatLocalisedDate(`${monthKey}-01T00:00:00Z`, locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/unit/components/renewals/month-bucket-label.test.ts`
Expected: PASS.

> If the TH BE assertion fails, STOP and read `src/lib/format-date-localised.ts` — do NOT add `+543` here; the helper must supply BE via the calendar. A failure means the options need `getDateFormatLocale` under the hood (it already does per the helper's contract).

- [ ] **Step 5: Commit**

```bash
git add src/components/renewals/month-bucket-label.ts \
        tests/unit/components/renewals/month-bucket-label.test.ts
git commit -m "feat(renewals): add month-bucket label helper (BE-aware) + MonthBarItem type"
```

---

## Task 8: `MonthBarChart` client component

**Files:**
- Create: `src/components/renewals/month-bar-chart.tsx`
- Modify: `src/components/renewals/urgency-pill.tsx` (add `export` to `VARIANT_CLASSES`)
- Test: `tests/unit/app/renewals/month-bar-chart.test.tsx`

**Interfaces:**
- Consumes: `MonthBarItem` (Task 7); `VARIANT_CLASSES` from `urgency-pill.tsx`; `UrgencyBucket` from `@/modules/renewals/client`; `admin.renewals.byMonth.*` i18n (Task 6).
- Produces (imported by Task 9):
  - `interface MonthBarChartProps { readonly items: ReadonlyArray<MonthBarItem>; readonly selectedKey: string | null }`
  - `function MonthBarChart(props: MonthBarChartProps): React.JSX.Element`

- [ ] **Step 1: Export `VARIANT_CLASSES` from the pill (shared colour source of truth)**

In `src/components/renewals/urgency-pill.tsx`, add `export` to the existing `VARIANT_CLASSES` const (line 16) — change `const VARIANT_CLASSES` to `export const VARIANT_CLASSES`. Do NOT change any class values. (This makes the pill's palette the single source the chart + tabs reuse, per the spec's "reuse the exact Tailwind class strings".)

- [ ] **Step 2: Write the failing component test**

Create `tests/unit/app/renewals/month-bar-chart.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(''),
}));

function renderChart(items: MonthBarItem[], selectedKey: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonthBarChart items={items} selectedKey={selectedKey} />
    </NextIntlClientProvider>,
  );
}

const ITEMS: MonthBarItem[] = [
  { key: 'overdue', label: 'Overdue', count: 2, barPercent: 12, interactive: true },
  { key: '2026-07', label: 'July 2026', count: 17, barPercent: 100, interactive: true },
  { key: '2026-08', label: 'August 2026', count: 0, barPercent: 0, interactive: false },
  { key: 'later', label: 'July 2027 or later', count: 1, barPercent: 4, interactive: true },
];

describe('MonthBarChart', () => {
  it('renders a list with one row per bucket + counts', () => {
    renderChart(ITEMS);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('nonzero buckets are links to ?month=<key>', () => {
    renderChart(ITEMS);
    const link = screen.getByRole('link', { name: /July 2026/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('month=2026-07'));
  });

  it('a zero bucket is NOT a link and is aria-disabled', () => {
    renderChart(ITEMS);
    expect(screen.queryByRole('link', { name: /August 2026/ })).toBeNull();
    expect(screen.getByText('August 2026').closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('the selected bucket carries aria-current', () => {
    renderChart(ITEMS, '2026-07');
    const link = screen.getByRole('link', { name: /July 2026/ });
    expect(link).toHaveAttribute('aria-current', 'true');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/unit/app/renewals/month-bar-chart.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the component**

Create `src/components/renewals/month-bar-chart.tsx`:

```tsx
/**
 * Renewals-by-month — horizontal bar list (client).
 *
 * A `<ul role="list">` of `label │ bar │ count` rows; each NONZERO bucket row
 * is a full-width `<Link>` to `?month=<key>` (soft-nav; clears `?urgency` +
 * `?cursor`, mirroring the urgency-tabs contract). Zero buckets render
 * non-interactive (muted, `aria-disabled`, out of tab order — the "0 in July"
 * signal still aids planning). The selected bucket gets `aria-current` + a ring
 * + bolder count (non-colour affordance, WCAG 1.4.1). Band colours reuse the
 * shipped `UrgencyPill` palette (slate→amber→orange→red) so the chart, the
 * polished tabs, and the pills speak ONE colour language. No blue.
 */
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { VARIANT_CLASSES } from '@/components/renewals/urgency-pill';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import type { UrgencyBucket } from '@/modules/renewals/client';

export interface MonthBarChartProps {
  readonly items: ReadonlyArray<MonthBarItem>;
  readonly selectedKey: string | null;
}

/**
 * Bucket-position → representative urgency bucket, so the bar band reuses the
 * pill's exact Tailwind class string. Order: [overdue, m0, m1, m2, m3…m11, later].
 *   overdue → red (t-0) · m0 → orange (t-7) · m1-m2 → amber (t-14) · rest → slate (t-90)
 */
function bandBucketForIndex(i: number): UrgencyBucket {
  if (i === 0) return 't-0';
  if (i === 1) return 't-7';
  if (i === 2 || i === 3) return 't-14';
  return 't-90';
}

export function MonthBarChart({
  items,
  selectedKey,
}: MonthBarChartProps): React.JSX.Element {
  const t = useTranslations('admin.renewals.byMonth');
  const params = useSearchParams();

  function hrefFor(key: string): string {
    const next = new URLSearchParams(params.toString());
    next.set('month', key);
    next.delete('urgency'); // mutually-exclusive lens
    next.delete('cursor'); // reset pagination
    return `/admin/renewals?${next.toString()}`;
  }

  return (
    <ul role="list" aria-label={t('listAriaLabel')} className="flex flex-col gap-1">
      {items.map((item, i) => {
        const bandClass = VARIANT_CLASSES[bandBucketForIndex(i)];
        const isSelected = selectedKey === item.key;
        const rowLabel = item.interactive
          ? t('bucketAriaLabel', { label: item.label, count: item.count })
          : t('zeroBucketAriaLabel', { label: item.label });

        const inner = (
          <>
            <span className="w-40 shrink-0 truncate text-sm text-foreground">
              {item.label}
            </span>
            <span className="relative h-4 flex-1 overflow-hidden rounded bg-muted/40">
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-0 left-0 rounded ring-1 ring-inset',
                  bandClass,
                )}
                style={{ width: `${item.barPercent}%` }}
              />
            </span>
            <span
              className={cn(
                'w-8 shrink-0 text-right text-sm tabular-nums',
                isSelected ? 'font-bold text-foreground' : 'font-medium text-muted-foreground',
              )}
            >
              {item.count}
            </span>
          </>
        );

        return (
          <li key={item.key}>
            {item.interactive ? (
              <Link
                href={hrefFor(item.key)}
                aria-label={rowLabel}
                aria-current={isSelected ? 'true' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-md px-2 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'ring-2 ring-inset ring-ring',
                )}
              >
                {inner}
              </Link>
            ) : (
              <div
                aria-disabled="true"
                aria-label={rowLabel}
                className="flex min-h-11 items-center gap-3 rounded-md px-2 opacity-60"
              >
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/unit/app/renewals/month-bar-chart.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/renewals/month-bar-chart.tsx \
        src/components/renewals/urgency-pill.tsx \
        tests/unit/app/renewals/month-bar-chart.test.tsx
git commit -m "feat(renewals): add MonthBarChart client bar list + export shared pill palette"
```

---

## Task 9: `RenewalsByMonthSection` server component + skeleton

**Files:**
- Create: `src/app/(staff)/admin/renewals/_components/renewals-by-month-section.tsx`
- Create: `src/components/renewals/month-filter-chip.tsx`

**Interfaces:**
- Consumes: `loadRenewalMonthSummary` (Task 3); `barWidthPercent`, `addMonthsToYm`, `bkkYearMonth` (Task 1); `formatMonthKeyLabel`, `MonthBarItem` (Task 7); `MonthBarChart` (Task 8); `getLocale`/`getTranslations` (next-intl/server); `makeRenewalsDeps` (`@/modules/renewals`).
- Produces (imported by Task 12):
  - `async function RenewalsByMonthSection(props: { tenantSlug: string; nowIso: string; selectedMonth: string | null }): Promise<React.JSX.Element>`
  - `function RenewalsByMonthSectionSkeleton(): React.JSX.Element`
  - `function MonthFilterChip(props: { monthLabel: string })` (client, in `month-filter-chip.tsx`)

- [ ] **Step 1: Write the clear-filter chip (client)**

Create `src/components/renewals/month-filter-chip.tsx`:

```tsx
/**
 * Renewals-by-month — dismissible "Renewing in {month}" chip (client).
 *
 * Shown when a `?month` filter is active. The ✕ is a real button that clears
 * `?month` + `?cursor` (soft-nav) and returns focus to the chart region so
 * keyboard focus is never lost after the row unmounts (WCAG 2.4.3).
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function MonthFilterChip({ monthLabel }: { readonly monthLabel: string }) {
  const t = useTranslations('admin.renewals.byMonth');
  const router = useRouter();
  const params = useSearchParams();

  function clear() {
    const next = new URLSearchParams(params.toString());
    next.delete('month');
    next.delete('cursor');
    const qs = next.toString();
    router.push(qs ? `/admin/renewals?${qs}` : '/admin/renewals');
    // Return focus to the chart region (its row link unmounts on clear).
    requestAnimationFrame(() => {
      document.getElementById('renewals-by-month')?.focus();
    });
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm">
      <span>{t('filterChip', { month: monthLabel })}</span>
      <button
        type="button"
        onClick={clear}
        aria-label={t('clearFilter')}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}
```

- [ ] **Step 2: Write the server section + skeleton**

Create `src/app/(staff)/admin/renewals/_components/renewals-by-month-section.tsx`:

```tsx
/**
 * Renewals-by-month — async server section for `/admin/renewals`.
 *
 * Calls `loadRenewalMonthSummary`, resolves each bucket's localized label
 * (BE-aware month+year via `formatMonthKeyLabel`; `overdue`/`later` via
 * next-intl), computes bar widths, and hands a serialisable view-model to the
 * client `<MonthBarChart>`. Own `<section aria-labelledby>` + a REAL `<h2>`
 * (not shadcn CardTitle, which renders a `<div>`). Best-effort error handling:
 * an infra throw renders a "couldn't load" card so it never crashes the page.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/shell/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { CalendarClock } from 'lucide-react';
import { logger } from '@/lib/logger';
import {
  loadRenewalMonthSummary,
  makeRenewalsDeps,
  type RenewalMonthSummary,
} from '@/modules/renewals';
import {
  barWidthPercent,
  addMonthsToYm,
  bkkYearMonth,
} from '@/modules/renewals/domain/renewal-month-bucket';
import {
  formatMonthKeyLabel,
  type MonthBarItem,
} from '@/components/renewals/month-bucket-label';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import { MonthFilterChip } from '@/components/renewals/month-filter-chip';

export async function RenewalsByMonthSection({
  tenantSlug,
  nowIso,
  selectedMonth,
}: {
  readonly tenantSlug: string;
  readonly nowIso: string;
  readonly selectedMonth: string | null;
}) {
  const t = await getTranslations('admin.renewals.byMonth');
  const locale = await getLocale();
  const deps = makeRenewalsDeps(tenantSlug);

  let summary: RenewalMonthSummary;
  try {
    const r = await loadRenewalMonthSummary(deps, { tenantId: tenantSlug, nowIso });
    // Error channel is `never` today; THROW if a real variant is ever added so
    // the catch renders "couldn't load" instead of a silently empty chart.
    if (!r.ok) {
      throw new Error('loadRenewalMonthSummary returned an unexpected error');
    }
    summary = r.value;
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.RENEWALS_BY_MONTH_LOAD',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] renewals-by-month load failed',
    );
    return (
      <Card>
        <CardContent
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center gap-4 py-12 text-center"
        >
          <AlertTriangle aria-hidden="true" className="h-10 w-10 text-destructive" />
          <div className="text-base font-medium text-destructive">
            {t('loadFailed')}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Resolve labels in Presentation (Constitution III — VM carries none).
  const laterStartKey = addMonthsToYm(bkkYearMonth(nowIso), 12);
  const items: MonthBarItem[] = summary.buckets.map((b) => {
    const label =
      b.key === 'overdue'
        ? t('overdue')
        : b.key === 'later'
          ? t('later', { month: formatMonthKeyLabel(laterStartKey, locale) })
          : formatMonthKeyLabel(b.key, locale);
    return {
      key: b.key,
      label,
      count: b.count,
      barPercent: barWidthPercent(b.count, summary.maxCount),
      interactive: b.count > 0,
    };
  });

  const selectedLabel =
    selectedMonth === null
      ? null
      : (items.find((i) => i.key === selectedMonth)?.label ?? null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <section
          id="renewals-by-month"
          tabIndex={-1}
          aria-labelledby="renewals-by-month-heading"
          className="flex flex-col gap-3 focus-visible:outline-none"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <div className="space-y-1">
              <h2 id="renewals-by-month-heading" className="text-base font-semibold">
                {t('title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('subtitle', { count: summary.totalCount })}
              </p>
            </div>
            {selectedLabel !== null ? (
              <MonthFilterChip monthLabel={selectedLabel} />
            ) : null}
          </div>

          {summary.totalCount === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              bordered={false}
            />
          ) : (
            <MonthBarChart items={items} selectedKey={selectedMonth} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** Suspense fallback — 14 bar placeholders matching the final layout (CLS 0). */
export function RenewalsByMonthSectionSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="flex flex-col gap-1">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex min-h-11 items-center gap-3 px-2">
              <Skeleton className="h-4 w-40 shrink-0" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-8 shrink-0" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

> The two `lucide-react` imports (`AlertTriangle`, `CalendarClock`) can be merged into one import statement; keep whichever form lints clean. Confirm `EmptyState` accepts `icon`/`title`/`description`/`bordered` props (it does — see `members-without-cycle-tray.tsx:107-113`).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (No new unit test — this async server component is covered by the integration tests behind it + the page-level manual check in Task 12. The reviewer gate + typecheck are the deliverable's gate.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/admin/renewals/_components/renewals-by-month-section.tsx" \
        src/components/renewals/month-filter-chip.tsx
git commit -m "feat(renewals): add RenewalsByMonthSection server component + clear-filter chip"
```

---

## Task 10: Urgency-tabs colour polish + nullable "All" state

**Files:**
- Modify: `src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx`
- Test: extend `tests/unit/app/renewals/` with a tabs test (create `tests/unit/app/renewals/urgency-bucket-tabs.test.tsx` if none exists)

**Interfaces:**
- Consumes: `VARIANT_CLASSES` from `urgency-pill.tsx` (exported in Task 8).
- Produces: `UrgencyBucketTabsProps.current: UrgencyBucket | null` (null = month lens active → no tab selected); each tab's count badge tinted with its pill band class.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/app/renewals/urgency-bucket-tabs.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyBucketTabs } from '@/app/(staff)/admin/renewals/_components/urgency-bucket-tabs';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(''),
}));

const COUNTS = { 't-90': 1, 't-60': 2, 't-30': 3, 't-14': 4, 't-7': 5, 't-0': 6, grace: 7, lapsed: 0 };

function renderTabs(current: 't-30' | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs current={current} counts={COUNTS} lapsedCount={9} />
    </NextIntlClientProvider>,
  );
}

describe('UrgencyBucketTabs colour + All state', () => {
  it('tints the t-0 count badge with the red pill band class', () => {
    renderTabs('t-30');
    // The t-0 badge (count 6) carries a red-family class from VARIANT_CLASSES.
    const badge = screen.getByText('6');
    expect(badge.className).toMatch(/red/);
  });

  it('renders with no active tab when current is null (month lens active)', () => {
    const { container } = renderTabs(null);
    expect(container.querySelector('[data-state="active"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/unit/app/renewals/urgency-bucket-tabs.test.tsx`
Expected: FAIL — badge has `bg-muted` (no red), and `current: null` is a type error / renders an active tab.

- [ ] **Step 3: Apply the polish + nullable current**

In `src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx`:

Add the import (after line 18):

```ts
import { VARIANT_CLASSES } from '@/components/renewals/urgency-pill';
```

Change the prop type (line 44) from `readonly current: UrgencyBucket;` to:

```ts
  readonly current: UrgencyBucket | null;
```

Change the `<Tabs value={current} …>` (line 99) to tolerate null (Radix renders no active tab for an empty value):

```tsx
      <Tabs value={current ?? ''} onValueChange={handleChange}>
```

Replace the count-badge `<span>` (lines 136-141) with a band-tinted version — the badge reuses the exact pill class for its bucket:

```tsx
              <span
                className={cn(
                  'ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-xs font-medium ring-1 ring-inset tabular-nums',
                  VARIANT_CLASSES[bucket],
                )}
                aria-hidden
              >
                {count}
              </span>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/unit/app/renewals/urgency-bucket-tabs.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (Task 12 will pass `null` for `current` under the month lens; other call sites already pass a bucket).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/admin/renewals/_components/urgency-bucket-tabs.tsx" \
        tests/unit/app/renewals/urgency-bucket-tabs.test.tsx
git commit -m "feat(renewals): pill-matched urgency-tab badge colours + nullable All state"
```

---

## Task 11: Pipeline table + announcer — month-aware empty copy & live region

**Files:**
- Modify: `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx`
- Modify: `src/components/renewals/result-count-announcer.tsx`

**Interfaces:**
- Produces (consumed by Task 12):
  - `PipelineTableProps` gains `readonly monthLabel?: string` — when present, the empty cell renders `noRowsInMonth` instead of `noRows`/`noRowsInBucket`.
  - `ResultCountAnnouncerProps` gains `readonly monthLabel?: string` — when present, announces `srResultCountMonth` (and `urgencyKey` may be omitted).

- [ ] **Step 1: Add `monthLabel` to the pipeline table empty state**

In `src/app/(staff)/admin/renewals/_components/pipeline-table.tsx`:

Change the props interface (lines 71-73):

```tsx
export interface PipelineTableProps {
  readonly rows: ReadonlyArray<PipelineRow>;
  /** When set, the empty state reads "No members renew in {month}" (month lens). */
  readonly monthLabel?: string;
}
```

Change the function signature (line 75) to destructure it:

```tsx
export function PipelineTable({ rows, monthLabel }: PipelineTableProps) {
```

Replace the empty-cell body (lines 215-221) with a month-aware variant:

```tsx
            <TableCell
              colSpan={columns.length}
              className="text-center text-muted-foreground py-8"
            >
              {monthLabel !== undefined ? (
                <p className="text-sm font-medium text-foreground">
                  {t('noRowsInMonth', { month: monthLabel })}
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">{t('noRows')}</p>
                  <p className="mt-1 text-xs">{t('noRowsInBucket')}</p>
                </>
              )}
            </TableCell>
```

- [ ] **Step 2: Add `monthLabel` to the result-count announcer**

In `src/components/renewals/result-count-announcer.tsx`:

Change the props interface (lines 24-37) to make `urgencyKey` optional and add `monthLabel`:

```tsx
export interface ResultCountAnnouncerProps {
  /** Number of pipeline rows visible after server-side filter. */
  readonly count: number;
  /** The active urgency-tab key — omit when the month lens is active. */
  readonly urgencyKey?:
    | 't-90'
    | 't-60'
    | 't-30'
    | 't-14'
    | 't-7'
    | 't-0'
    | 'grace'
    | 'lapsed';
  /** When set, announces the month lens instead of the urgency bucket. */
  readonly monthLabel?: string;
}
```

Replace the component body (lines 39-68) with:

```tsx
export function ResultCountAnnouncer({
  count,
  urgencyKey,
  monthLabel,
}: ResultCountAnnouncerProps) {
  const tTable = useTranslations('admin.renewals.table');
  const tBuckets = useTranslations('admin.renewals.urgencyBuckets');
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {monthLabel !== undefined
        ? tTable('srResultCountMonth', { count, month: monthLabel })
        : urgencyKey !== undefined
          ? tTable('srResultCount', {
              count,
              // URL param uses hyphens (`t-90`); i18n keys use snake (`t_90`).
              urgency: tBuckets(urgencyKey.replace('-', '_')),
            })
          : ''}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (existing call site in `page.tsx` passes `urgencyKey` positionally-by-name — still valid; Task 12 adds the month path).

- [ ] **Step 4: Run the existing renewals unit tests (regression)**

Run: `pnpm test tests/unit/app/renewals/`
Expected: PASS (no regression in existing table/announcer coverage).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/renewals/_components/pipeline-table.tsx" \
        src/components/renewals/result-count-announcer.tsx
git commit -m "feat(renewals): month-aware pipeline empty copy + result-count announcer"
```

---

## Task 12: Wire the page — parse `?month`, render section, thread filter

**Files:**
- Modify: `src/app/(staff)/admin/renewals/page.tsx`

**Interfaces:**
- Consumes: everything above — `RenewalsByMonthSection`/`RenewalsByMonthSectionSkeleton` (Task 9), `parseMonthParam` (Task 1), the extended `loadPipeline` (Task 4), nullable `UrgencyBucketTabs` (Task 10), `PipelineTable.monthLabel` + `ResultCountAnnouncer.monthLabel` (Task 11), `formatMonthKeyLabel` (Task 7).

- [ ] **Step 1: Add imports + `month` to SearchParams**

In `src/app/(staff)/admin/renewals/page.tsx`:

Add to the `@/modules/renewals` import block (lines 34-42), the `parseMonthParam` symbol — but note `parseMonthParam` lives in the domain, re-exported nowhere yet. Import it from the client barrel is wrong (it's a function, server-only-safe pure). Add a server-barrel re-export first: in `src/modules/renewals/index.ts`, add to the Task-1 VM re-export block:

```ts
export { parseMonthParam } from './domain/renewal-month-bucket';
```

Then in `page.tsx`, add these imports:

```ts
import { parseMonthParam } from '@/modules/renewals';
import { formatMonthKeyLabel } from '@/components/renewals/month-bucket-label';
import {
  RenewalsByMonthSection,
  RenewalsByMonthSectionSkeleton,
} from './_components/renewals-by-month-section';
```

Add `month` to the `SearchParams` interface (lines 80-86):

```ts
  /** Renewals-by-month lens — `'overdue' | 'YYYY-MM' | 'later'`. */
  readonly month?: string;
```

- [ ] **Step 2: Parse the month lens + compute nowIso**

After the `cursor` / `isPendingReviewView` parsing (line 134), add:

```ts
  // Renewals-by-month lens. A present + VALID month wins over urgency
  // (mutually-exclusive). `nowIso` anchors BOTH the chart aggregation and the
  // pipeline month bounds — computed ONCE so they reconcile exactly.
  const nowIso = new Date().toISOString();
  const month = parseMonthParam(query.month);
  const monthLensActive = month !== null;
```

- [ ] **Step 3: Thread the month lens into `loadPipeline`**

Replace the `loadPipeline` call (lines 165-171) with:

```ts
  const result = await loadPipeline(deps, {
    tenantId: tenantCtx.slug,
    ...(tier !== undefined ? { tier } : {}),
    urgency,
    ...(monthLensActive ? { month: month as string, nowIso } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });
```

- [ ] **Step 4: Render the section (Suspense) above the pipeline card + adjust tabs/table/announcer**

Insert the month section immediately after `<RenewalsPageShell …>` opens and BEFORE the pipeline `<Card>` (line 250). The section is Suspense-wrapped so its aggregation streams in without blocking the pipeline render:

```tsx
      <Suspense fallback={<RenewalsByMonthSectionSkeleton />}>
        <RenewalsByMonthSection
          tenantSlug={tenantCtx.slug}
          nowIso={nowIso}
          selectedMonth={month}
        />
      </Suspense>
```

Compute a `monthLabel` for the pipeline empty copy + announcer (add near the `paginationParams` block, after line 220):

```ts
  // Localized label for the active month lens (BE-aware). `overdue`/`later`
  // reuse the byMonth strings; a `YYYY-MM` renders the localized month+year.
  const tByMonth = await getTranslations('admin.renewals.byMonth');
  const locale = await getLocale();
  const monthLabel =
    month === null
      ? undefined
      : month === 'overdue'
        ? tByMonth('overdue')
        : month === 'later'
          ? tByMonth('later', {
              month: formatMonthKeyLabel(
                // later-window start = current BKK month + 12
                new Date(new Date(nowIso).getTime() + 7 * 3600 * 1000)
                  .toISOString()
                  .slice(0, 7),
                locale,
              ),
            })
          : formatMonthKeyLabel(month, locale);
```

> Simpler + DRY: import `addMonthsToYm` + `bkkYearMonth` and write `formatMonthKeyLabel(addMonthsToYm(bkkYearMonth(nowIso), 12), locale)` for the `later` label (matches the section). Prefer that form — add `addMonthsToYm, bkkYearMonth` to the `@/modules/renewals` import (re-export them from `index.ts` if not already):
>
> In `index.ts` extend the Task-1 re-export: `export { parseMonthParam, addMonthsToYm, bkkYearMonth } from './domain/renewal-month-bucket';`
> Then: `? tByMonth('later', { month: formatMonthKeyLabel(addMonthsToYm(bkkYearMonth(nowIso), 12), locale) })`

Update the `UrgencyBucketTabs` render (lines 263-267) to pass `null` when the month lens is active:

```tsx
                <UrgencyBucketTabs
                  current={monthLensActive ? null : urgency}
                  counts={summary.byUrgency}
                  lapsedCount={summary.lapsedCount}
                />
```

Update the `ResultCountAnnouncer` (lines 270-273):

```tsx
              <ResultCountAnnouncer
                count={rows.length}
                {...(monthLensActive
                  ? { monthLabel: monthLabel as string }
                  : { urgencyKey: urgency })}
              />
```

Update the `PipelineTable` render (line 277) to pass the month label:

```tsx
                <PipelineTable rows={rows} {...(monthLabel !== undefined ? { monthLabel } : {})} />
```

> The `nextHref` pagination block currently sets `?urgency=` from `paginationParams`. Under the month lens the "Next 50" link must carry `?month=` instead. Update the `paginationParams` build (lines 213-216) to branch:
>
> ```ts
>   const paginationParams = new URLSearchParams();
>   if (tier !== undefined) paginationParams.set('tier', tier);
>   if (monthLensActive) {
>     paginationParams.set('month', month as string);
>   } else {
>     paginationParams.set('urgency', urgency);
>   }
>   if (nextCursor !== null) paginationParams.set('cursor', nextCursor);
> ```

- [ ] **Step 5: Typecheck + lint + full renewals test regression**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

Run: `pnpm test tests/unit/app/renewals/ tests/unit/renewals/`
Expected: PASS.

- [ ] **Step 6: Manual smoke (user-run dev server on :3100)**

Ask the user to open `/admin/renewals` and verify (do NOT start/stop their dev server):
1. The "Renewals by month" card renders above the pipeline with 14 rows.
2. Clicking a nonzero month row navigates to `?month=YYYY-MM`, the pipeline filters to that month, the urgency tabs go to the no-selection state, and the "Renewing in {month}" chip appears.
3. Clicking ✕ on the chip clears back to the default urgency view.
4. TH locale shows BE years (e.g. 2569, not 2026) in the month labels.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(staff)/admin/renewals/page.tsx" src/modules/renewals/index.ts
git commit -m "feat(renewals): wire renewals-by-month section + ?month pipeline lens into the page"
```

---

## Final Verification (before finishing the branch)

- [ ] Run the full renewals unit + integration suites:
  - `pnpm test tests/unit/renewals/ tests/unit/app/renewals/ tests/unit/components/renewals/`
  - `pnpm test:integration tests/integration/renewals/count-cycles-by-month.test.ts`
- [ ] `pnpm check:i18n` — GREEN.
- [ ] `pnpm typecheck` — GREEN (final gate, after the last edit).
- [ ] `pnpm lint` — GREEN (catches lint-only errors typecheck/vitest miss).
- [ ] Reconciliation invariant proven by `count-cycles-by-month.test.ts` (bucket count == month-filtered rows; erased + terminal + `pending_admin_reactivation` in neither; summary unchanged under month filter).
- [ ] No `git add -A` used anywhere; only explicit paths staged.

---

## Self-Review notes (author)

**Spec coverage:** placement/additive (Task 9 + 12) · horizontal bar list (Task 8) · `?month` filter incl. overdue/YYYY-MM/later (Tasks 4, 5, 12) · mutually-exclusive lenses + precedence (Task 4) · 14 buckets + BKK boundary (Task 1) · F1 suppress 90d (Task 5) · F2 shared predicate (Task 2) · F3 summary unchanged (Task 5) · U1 pill-matched colours (Tasks 8, 10) · U2 overdue bucket (Task 1) · clear chip + focus return (Task 9) · month-aware empty copy + live region (Task 11) · BE-aware labels (Task 7) · reconciliation invariant (Tasks 2, 5 tests) · i18n × 3 (Task 6) · skeleton/empty/error states (Task 9).

**Type consistency:** `RenewalMonthAggregation`/`RenewalMonthSummary`/`RenewalMonthBucket`/`RawMonthCount` (Task 1) used verbatim in Tasks 2, 3, 9. `MonthBarItem` (Task 7) used in Tasks 8, 9. `PipelineQueryOpts.monthFilter`/`nowIso` (Task 2) consumed identically in Tasks 4, 5. `UrgencyBucketTabsProps.current: UrgencyBucket | null` (Task 10) fed by Task 12. `VARIANT_CLASSES` exported once (Task 8) reused in Tasks 8, 10.

**Deferred (YAGNI, per spec Out-of-scope):** urgency-label humanization, hiding zero urgency buckets, per-tier month breakdown, by-month CSV, combined month+urgency filter, option-B timeline.
