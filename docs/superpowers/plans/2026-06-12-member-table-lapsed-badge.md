# Member-table lapsed-membership badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a "Lapsed" badge beside the Status badge in the `/admin/members` table for members whose latest renewal cycle has lapsed (terminal `lapsed`/`cancelled`, past expiry).

**Architecture:** A pure Domain predicate `isMembershipLapsed` (single source of truth, shared by the portal dashboard and the admin badge) + a renewals batch use-case `loadMembersMembershipStatus` backed by one `DISTINCT ON (member_id)` query (no N+1, tenant-isolated via `runInTenant`) enriches the current page's rows server-side, mirroring the existing `projectEngagementScore` enrichment. The badge is presentation-only.

**Tech Stack:** TypeScript strict, Next.js 16 RSC, Drizzle ORM (Neon Postgres), Vitest + Testing Library, next-intl. Design spec: `docs/superpowers/specs/2026-06-12-member-table-lapsed-badge-design.md` (v2).

---

## File Structure

**Create:**
- `tests/unit/renewals/domain/is-membership-lapsed.test.ts` — predicate truth-table
- `src/modules/renewals/application/use-cases/load-members-membership-status.ts` — batch use-case
- `tests/unit/renewals/application/load-members-membership-status.test.ts` — use-case unit (mock repo)
- `tests/integration/renewals/load-members-membership-status.test.ts` — live-Neon integration
- `drizzle/migrations/0215_f8_renewal_cycles_member_recency_idx.sql` — index migration
- `tests/unit/components/members/members-table-lapsed-badge.test.tsx` — badge component test

**Modify:**
- `src/modules/renewals/domain/renewal-cycle.ts` — add `isMembershipLapsed` (after line 286)
- `src/modules/renewals/index.ts` — barrel-export `isMembershipLapsed` + `loadMembersMembershipStatus`
- `src/app/(member)/portal/_lib/dashboard-stats.ts` — refactor `deriveMembershipStat` step-4 to delegate
- `tests/unit/portal/dashboard/dashboard-stats.test.ts` — add characterization + overdue-regression
- `src/modules/renewals/application/ports/renewal-cycle-repo.ts` — add `findLatestCyclesForMembers`
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` — implement it
- `src/modules/renewals/infrastructure/schema-renewal-cycles.ts` — add the recency index
- `src/app/(staff)/admin/members/page.tsx` — enrich rows with `membership_lapsed`
- `src/components/members/members-table.tsx` — `MembersTableRow.membership_lapsed` + badge in status cell
- `src/i18n/messages/{en,th,sv}.json` — `admin.members.directory.membershipLapsed` + `membershipLapsedSr`

---

## Task 1: Domain predicate `isMembershipLapsed`

**Files:**
- Modify: `src/modules/renewals/domain/renewal-cycle.ts` (insert after line 286, next to `daysUntilExpiry`)
- Modify: `src/modules/renewals/index.ts` (export after `daysUntilExpiry`, line ~81)
- Test: `tests/unit/renewals/domain/is-membership-lapsed.test.ts`

- [ ] **Step 1: Write the failing truth-table test**

Create `tests/unit/renewals/domain/is-membership-lapsed.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isMembershipLapsed, type RenewalCycle } from '@/modules/renewals';

const NOW = new Date('2026-06-06T00:00:00.000Z');
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

/** Build a RenewalCycle fixture (mirrors tests/unit/portal/dashboard/dashboard-stats.test.ts). */
function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: 'c1',
    memberId: 'm1',
    status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: FUTURE,
    expiresAt: FUTURE,
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    linkedCreditNoteId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedReason: null,
    linkedInvoiceId: null,
    enteredPendingAt: null,
    ...overrides,
  } as RenewalCycle;
}

describe('isMembershipLapsed', () => {
  it('true: terminal lapsed cycle past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(true);
  });

  it('true: terminal cancelled cycle past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(true);
  });

  it('true: ended-terminal cycle with an UNPARSEABLE expiresAt', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: 'not-a-date' }),
        NOW,
      ),
    ).toBe(true);
  });

  it('false: completed cycle (paid/renewed — good standing) even past expiry', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'completed', closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1', expiresAt: PAST }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: non-terminal active cycle (future expiry)', () => {
    expect(isMembershipLapsed(cycle({ status: 'awaiting_payment', expiresAt: FUTURE }), NOW)).toBe(false);
  });

  it('false: non-terminal cycle PAST expiry (overdue/grace — NOT lapsed)', () => {
    expect(isMembershipLapsed(cycle({ status: 'awaiting_payment', expiresAt: PAST }), NOW)).toBe(false);
  });

  it('false: terminal lapsed cycle whose expiresAt is in the FUTURE (coverage still live)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: FUTURE }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: pending_admin_reactivation (non-terminal)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'pending_admin_reactivation', enteredPendingAt: PAST, expiresAt: PAST }),
        NOW,
      ),
    ).toBe(false);
  });

  it('false: expiresAt EXACTLY == now (strict <, not ≤)', () => {
    expect(
      isMembershipLapsed(
        cycle({ status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: NOW.toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/renewals/domain/is-membership-lapsed.test.ts`
Expected: FAIL — `isMembershipLapsed` is not exported from `@/modules/renewals`.

- [ ] **Step 3: Implement the predicate**

In `src/modules/renewals/domain/renewal-cycle.ts`, immediately AFTER the `daysUntilExpiry` function (ends line 286), add:

```typescript
/**
 * A membership has LAPSED when its most-recent cycle is ended-terminal
 * (`lapsed` or `cancelled` — NOT `completed`, which means the member
 * paid/renewed and is in good standing) AND its coverage has ended
 * (`expiresAt` in the past, or unparseable → still treated as lapsed).
 *
 * The terminal-status gate is load-bearing: a NON-terminal cycle that is
 * merely past `expiresAt` is `overdue` (in grace), NOT lapsed — so the gate
 * must check the status FIRST, before the expiry. This is the single source
 * of truth for "lapsed", consumed by both the portal dashboard's
 * `deriveMembershipStat` and the admin member-table badge.
 */
export function isMembershipLapsed(cycle: RenewalCycle, now: Date): boolean {
  if (!isTerminalCycleStatus(cycle.status) || cycle.status === 'completed') {
    return false;
  }
  const expiresMs = Date.parse(cycle.expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs < now.getTime();
}
```

(`isTerminalCycleStatus` is already imported in this file — it backs `isOverdue` at line 272.)

- [ ] **Step 4: Export from the barrel**

In `src/modules/renewals/index.ts`, the domain re-export block exports `isOverdue, daysUntilExpiry` from `'./domain/renewal-cycle'` (around line 81). Add `isMembershipLapsed` to that same export list:

```typescript
export {
  // ...existing...
  isOverdue,
  daysUntilExpiry,
  isMembershipLapsed,
  // ...
} from './domain/renewal-cycle';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/renewals/domain/is-membership-lapsed.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` (Expected: clean — if the dev server is running, use the temp-tsconfig method that excludes `.next`).

```bash
git add src/modules/renewals/domain/renewal-cycle.ts src/modules/renewals/index.ts tests/unit/renewals/domain/is-membership-lapsed.test.ts
git commit -m "feat(renewals): add isMembershipLapsed domain predicate (#4)"
```

---

## Task 2: Refactor portal `deriveMembershipStat` to delegate (behavior-preserving)

**Files:**
- Modify: `src/app/(member)/portal/_lib/dashboard-stats.ts` (step-4 lapsed branch, lines 76–90)
- Test: `tests/unit/portal/dashboard/dashboard-stats.test.ts` (add characterization + regression)

- [ ] **Step 1: Write the characterization + overdue-regression tests (RED-safe against current code)**

In `tests/unit/portal/dashboard/dashboard-stats.test.ts`, add a new `describe` block (the file already has a `cycle(overrides)` helper and `const NOW = new Date('2026-06-06T00:00:00.000Z')`; reuse them). Add the import:

```typescript
import { isMembershipLapsed } from '@/modules/renewals';
```

Then add:

```typescript
describe('deriveMembershipStat ⟺ isMembershipLapsed (characterization)', () => {
  // The admin lapsed-badge reuses isMembershipLapsed; this pins the
  // equivalence so the step-4 refactor below stays behavior-preserving.
  const PAST = '2026-01-01T00:00:00.000Z';
  const FUTURE = '2027-01-01T00:00:00.000Z';
  const cases: ReadonlyArray<Partial<import('@/modules/renewals').RenewalCycle>> = [
    { status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: PAST },
    { status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: PAST },
    { status: 'completed', closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1', expiresAt: PAST },
    { status: 'awaiting_payment', expiresAt: PAST },
    { status: 'awaiting_payment', expiresAt: FUTURE },
    { status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: FUTURE },
  ];
  it.each(cases)('kind===lapsed iff isMembershipLapsed for %o', (override) => {
    const c = cycle(override);
    const kindIsLapsed = deriveMembershipStat(c, NOW).kind === 'lapsed';
    expect(kindIsLapsed).toBe(isMembershipLapsed(c, NOW));
  });
});

describe('deriveMembershipStat overdue regression (post-refactor)', () => {
  it('a non-terminal past-expiry cycle stays kind:overdue, NOT lapsed', () => {
    const c = cycle({ status: 'awaiting_payment', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(deriveMembershipStat(c, NOW).kind).toBe('overdue');
  });
});
```

- [ ] **Step 2: Run to verify they PASS against the current (un-refactored) code**

Run: `pnpm vitest run tests/unit/portal/dashboard/dashboard-stats.test.ts`
Expected: PASS — these characterize EXISTING behavior. (If any fail now, the predicate in Task 1 diverges from the current step-4 logic — stop and reconcile before refactoring.)

- [ ] **Step 3: Refactor step-4 to delegate**

In `src/app/(member)/portal/_lib/dashboard-stats.ts`:

(a) add `isMembershipLapsed` to the existing `@/modules/renewals` import (lines 10–14):

```typescript
import {
  daysUntilExpiry,
  isOverdue,
  isTerminalCycleStatus,
  isMembershipLapsed,
  type RenewalCycle,
} from '@/modules/renewals';
```

(b) replace the step-4 block (lines 76–90, from `const isEndedTerminal =` through the closing `}` of the `if (isEndedTerminal) { ... }`) with exactly:

```typescript
  // 057 R2 finding A — only ENDED-terminal cycles (lapsed/cancelled, NOT the
  // paid/renewed `completed`) past expiry represent ended coverage. This is the
  // canonical `isMembershipLapsed` predicate (single source of truth shared with
  // the admin member-table badge). The `isOverdue` branch above already consumed
  // every non-terminal past-expiry cycle, so delegating here is behavior-
  // preserving (pinned by the characterization test). Return shape is byte-for-
  // byte the original lapsed branch (`expiryIso: cycle.expiresAt`).
  if (isMembershipLapsed(cycle, now)) {
    return { kind: 'lapsed', variant: 'destructive', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
```

`isTerminalCycleStatus` may now be unused in this file — if `pnpm lint` flags it as unused, remove it from the import. (It is still used elsewhere in the file at the `days <= 30 && !isTerminalCycleStatus(status)` and `days === null && !isTerminalCycleStatus(status)` branches — so it stays. Do NOT remove it.)

- [ ] **Step 4: Run the full dashboard-stats suite to verify GREEN**

Run: `pnpm vitest run tests/unit/portal/dashboard/dashboard-stats.test.ts`
Expected: PASS (all existing tests + the new characterization + overdue regression).

- [ ] **Step 5: Lint + typecheck + commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/app/\(member\)/portal/_lib/dashboard-stats.ts tests/unit/portal/dashboard/dashboard-stats.test.ts
git commit -m "refactor(portal): deriveMembershipStat delegates to isMembershipLapsed (#4)"
```

---

## Task 3: Recency index migration (0215)

**Files:**
- Create: `drizzle/migrations/0215_f8_renewal_cycles_member_recency_idx.sql`
- Modify: `src/modules/renewals/infrastructure/schema-renewal-cycles.ts` (add the index to the table's index block)

- [ ] **Step 1: Add the index to the Drizzle schema**

In `src/modules/renewals/infrastructure/schema-renewal-cycles.ts`, inside the `(table) => ({ ... })` index block (alongside `pipelineIdx`, `memberIdx`, `eligibilityIdx`, `activeMemberUniq`), add:

```typescript
    // Serves the lapsed-badge batch query: DISTINCT ON (member_id)
    // ORDER BY member_id, created_at DESC — an index skip-scan per member,
    // no Sort node (spec §6 / decision #6). `desc()` import from drizzle-orm.
    memberRecencyIdx: index('renewal_cycles_member_recency_idx').on(
      table.tenantId,
      table.memberId,
      table.createdAt.desc(),
    ),
```

If `table.createdAt.desc()` is not valid in this Drizzle version, use the SQL form: `.on(table.tenantId, table.memberId, sql\`${table.createdAt} DESC\`)` (the file already imports `sql`).

- [ ] **Step 2: Create the migration SQL**

Create `drizzle/migrations/0215_f8_renewal_cycles_member_recency_idx.sql`:

```sql
-- F8 #4 lapsed-badge — supporting index for the per-page batch
-- DISTINCT ON (member_id) ... ORDER BY member_id, created_at DESC query in
-- loadMembersMembershipStatus. Makes it an index skip-scan (no Seq Scan / Sort).
CREATE INDEX IF NOT EXISTS "renewal_cycles_member_recency_idx"
  ON "renewal_cycles" ("tenant_id", "member_id", "created_at" DESC);
```

- [ ] **Step 3: Register the migration in the journal**

Run: `pnpm drizzle-kit generate` ONLY IF it produces exactly this index and no drift. Otherwise, hand-add the 0215 entry to `drizzle/migrations/meta/_journal.json` following the existing entry format (idx = next integer, tag = `0215_f8_renewal_cycles_member_recency_idx`, matching the sibling entries). Inspect the generated diff before keeping it.

- [ ] **Step 4: Apply the migration to live Neon**

Run: `pnpm drizzle-kit migrate`
Expected: applies 0215; `renewal_cycles_member_recency_idx` now exists.

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/0215_f8_renewal_cycles_member_recency_idx.sql drizzle/migrations/meta/_journal.json src/modules/renewals/infrastructure/schema-renewal-cycles.ts
git commit -m "feat(renewals): index renewal_cycles (tenant_id, member_id, created_at DESC) (#4)"
```

---

## Task 4: Repo batch method `findLatestCyclesForMembers`

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (add method to the `RenewalCycleRepo` interface, after `findActiveForMember` ~line 156)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (implement it)

- [ ] **Step 1: Add the port method**

In `src/modules/renewals/application/ports/renewal-cycle-repo.ts`, add to the `RenewalCycleRepo` interface:

```typescript
  /**
   * The MOST-RECENT cycle (by created_at DESC, cycle_id DESC tiebreak) for each
   * member id, in ONE query (DISTINCT ON). Used by the lapsed-badge enrichment
   * to avoid N+1 across the ≤50 rows of the member-directory page. Returns at
   * most one cycle per member that HAS a cycle; members with none are absent.
   * Tenant-isolated via runInTenant (RLS+FORCE) — a foreign member id matches
   * nothing. An empty `memberIds` MUST short-circuit at the use-case (no DB hit).
   */
  findLatestCyclesForMembers(
    tenantId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyArray<RenewalCycle>>;
```

- [ ] **Step 2: Implement in the Drizzle adapter**

In `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts`, add the method to the repo object/factory (it already imports `{ db, runInTenant } from '@/lib/db'`, `renewalCycles` from the schema, and `rowToDomain`). Add `inArray, desc` to the existing `drizzle-orm` import. The method mirrors the `runInTenant(ctx, async (tx) => …)` pattern used by every other read method (`ctx` is the `TenantContext` the factory closes over):

```typescript
  async findLatestCyclesForMembers(
    _tenantId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyArray<RenewalCycle>> {
    if (memberIds.length === 0) return [];
    return runInTenant(ctx, async (tx) => {
      const rows = await tx
        .selectDistinctOn([renewalCycles.memberId])
        .from(renewalCycles)
        .where(inArray(renewalCycles.memberId, [...memberIds]))
        // DISTINCT ON requires the leading ORDER BY key to match the distinct
        // column; created_at DESC + cycle_id DESC picks the latest, deterministic
        // tiebreak — mirrors loadMemberRenewalStatus's 'created_at_desc'.
        .orderBy(
          renewalCycles.memberId,
          desc(renewalCycles.createdAt),
          desc(renewalCycles.cycleId),
        );
      return rows.map(rowToDomain);
    });
  },
```

NOTE: `runInTenant`'s tenant context is the same `ctx`/tenant every sibling method uses — use that variable, not `_tenantId` (the param is kept for port-signature parity; RLS already scopes by the run-in-tenant context). If the sibling methods pass `tenantId` into `runInTenant`, follow that exact form instead.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (No standalone unit test here — the repo is covered by the Task 6 integration test against live Neon, per project convention that repos are integration-tested.)

- [ ] **Step 4: Commit**

```bash
git add src/modules/renewals/application/ports/renewal-cycle-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts
git commit -m "feat(renewals): findLatestCyclesForMembers batch repo method (#4)"
```

---

## Task 5: Use-case `loadMembersMembershipStatus` + unit tests

**Files:**
- Create: `src/modules/renewals/application/use-cases/load-members-membership-status.ts`
- Modify: `src/modules/renewals/index.ts` (export the use-case near `loadMemberRenewalStatus`, ~line 495)
- Test: `tests/unit/renewals/application/load-members-membership-status.test.ts`

- [ ] **Step 1: Write the failing unit test (mock repo)**

Create `tests/unit/renewals/application/load-members-membership-status.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { loadMembersMembershipStatus } from '@/modules/renewals';
import type { RenewalCycle } from '@/modules/renewals';

const NOW = new Date('2026-06-06T00:00:00.000Z');
const clock = { now: () => NOW };

function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't', cycleId: 'c', memberId: 'm', status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z', periodTo: '2027-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z', cycleLengthMonths: 12, tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p', frozenPlanPriceThb: '50000.00', frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB', linkedCreditNoteId: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', closedAt: null, closedReason: null, linkedInvoiceId: null,
    enteredPendingAt: null, ...overrides,
  } as RenewalCycle;
}

describe('loadMembersMembershipStatus', () => {
  it('returns ONLY the lapsed member ids', async () => {
    const repo = {
      findLatestCyclesForMembers: vi.fn().mockResolvedValue([
        cycle({ memberId: 'lapsed-1', status: 'lapsed', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'lapsed', expiresAt: '2026-01-01T00:00:00.000Z' }),
        cycle({ memberId: 'active-1', status: 'awaiting_payment', expiresAt: '2027-01-01T00:00:00.000Z' }),
        cycle({ memberId: 'completed-1', status: 'completed', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'paid', linkedInvoiceId: 'i', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ]),
    };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: ['lapsed-1', 'active-1', 'completed-1', 'no-cycle'] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect([...res.value].sort()).toEqual(['lapsed-1']);
  });

  it('short-circuits empty input WITHOUT calling the repo', async () => {
    const repo = { findLatestCyclesForMembers: vi.fn() };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: [] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.size).toBe(0);
    expect(repo.findLatestCyclesForMembers).not.toHaveBeenCalled();
  });

  it('propagates a repo throw (the page wrapper degrades it to empty)', async () => {
    const repo = { findLatestCyclesForMembers: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(
      loadMembersMembershipStatus(
        { cyclesRepo: repo as never, clock },
        { tenantId: 't', memberIds: ['m1'] },
      ),
    ).rejects.toThrow('db down');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/renewals/application/load-members-membership-status.test.ts`
Expected: FAIL — `loadMembersMembershipStatus` not exported.

- [ ] **Step 3: Implement the use-case**

Create `src/modules/renewals/application/use-cases/load-members-membership-status.ts`:

```typescript
import { ok, type Result } from '@/lib/result';
import { isMembershipLapsed } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export interface LoadMembersMembershipStatusInput {
  readonly tenantId: string;
  readonly memberIds: readonly string[];
}

/**
 * The set of member ids (from the given page) whose MOST-RECENT renewal cycle
 * has lapsed (terminal lapsed/cancelled, past expiry — see isMembershipLapsed).
 * One batch query (no N+1). Empty input short-circuits with no DB round-trip.
 * `now` comes from the injected clock (deterministic in tests). A repo throw
 * propagates — the caller (member-directory page) wraps this best-effort and
 * degrades a failure to "no badges" (spec §4).
 */
export async function loadMembersMembershipStatus(
  deps: Pick<RenewalsDeps, 'cyclesRepo' | 'clock'>,
  input: LoadMembersMembershipStatusInput,
): Promise<Result<ReadonlySet<string>, never>> {
  if (input.memberIds.length === 0) return ok(new Set<string>());
  const now = deps.clock.now();
  const cycles = await deps.cyclesRepo.findLatestCyclesForMembers(
    input.tenantId,
    input.memberIds,
  );
  const lapsed = new Set<string>();
  for (const c of cycles) {
    if (isMembershipLapsed(c, now)) lapsed.add(c.memberId);
  }
  return ok(lapsed);
}
```

(Confirm the `Result`/`ok` import path matches the sibling use-case `load-member-renewal-status.ts` — it imports `ok` from `@/lib/result`. Match it exactly.)

- [ ] **Step 4: Export from the barrel**

In `src/modules/renewals/index.ts`, near the `loadMemberRenewalStatus` export (~line 491–505), add:

```typescript
export {
  loadMembersMembershipStatus,
  type LoadMembersMembershipStatusInput,
} from './application/use-cases/load-members-membership-status';
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run tests/unit/renewals/application/load-members-membership-status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add src/modules/renewals/application/use-cases/load-members-membership-status.ts src/modules/renewals/index.ts tests/unit/renewals/application/load-members-membership-status.test.ts
git commit -m "feat(renewals): loadMembersMembershipStatus batch use-case (#4)"
```

---

## Task 6: Integration test (live Neon) — cross-tenant + multi-cycle parity + EXPLAIN

**Files:**
- Create: `tests/integration/renewals/load-members-membership-status.test.ts`

Mirror `tests/integration/renewals/at-risk-bulk-write.test.ts` for the harness (`createTestTenant`, `seedF8MembershipPlan`, direct `tx.insert(renewalCycles)`, `makeRenewalsDeps(tenant.ctx.slug)`, cleanup).

- [ ] **Step 1: Write the integration test**

Create `tests/integration/renewals/load-members-membership-status.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  loadMembersMembershipStatus,
  makeRenewalsDeps,
  loadMemberRenewalStatus,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
// ↑ adjust the helper import path to match at-risk-bulk-write.test.ts exactly.

const NOW_PAST = '2026-01-01T00:00:00.000Z';
const NOW_FUTURE = '2027-01-01T00:00:00.000Z';

async function insertCycle(
  tenantSlug: string,
  memberId: string,
  o: { status: string; expiresAt: string; createdAt: string; closedReason?: string },
): Promise<void> {
  await db.insert(renewalCycles).values({
    tenantId: tenantSlug,
    cycleId: randomUUID(),
    memberId,
    status: o.status,
    periodFrom: new Date(NOW_PAST),
    periodTo: new Date(o.expiresAt),
    expiresAt: new Date(o.expiresAt),
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: randomUUID(),
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    createdAt: new Date(o.createdAt),
    ...(o.closedReason ? { closedAt: new Date(o.createdAt), closedReason: o.closedReason } : {}),
  });
}

describe('loadMembersMembershipStatus (integration, live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const mLapsed = randomUUID();
  const mActive = randomUUID();
  const mNone = randomUUID();
  const mMulti = randomUUID();
  const bMember = randomUUID();

  beforeAll(async () => {
    tenantA = await createTestTenant('lapsed-badge-a');
    tenantB = await createTestTenant('lapsed-badge-b');
    // tenant A: lapsed, active, multi-cycle (latest=lapsed by created_at), none.
    await insertCycle(tenantA.ctx.slug, mLapsed, { status: 'lapsed', expiresAt: NOW_PAST, createdAt: NOW_PAST, closedReason: 'lapsed' });
    await insertCycle(tenantA.ctx.slug, mActive, { status: 'awaiting_payment', expiresAt: NOW_FUTURE, createdAt: NOW_PAST });
    // multi-cycle: an OLDER completed cycle + a NEWER lapsed cycle → latest (created_at) = lapsed.
    await insertCycle(tenantA.ctx.slug, mMulti, { status: 'completed', expiresAt: NOW_FUTURE, createdAt: '2025-01-01T00:00:00.000Z', closedReason: 'paid' });
    await insertCycle(tenantA.ctx.slug, mMulti, { status: 'lapsed', expiresAt: NOW_PAST, createdAt: '2026-02-01T00:00:00.000Z', closedReason: 'lapsed' });
    // tenant B: a lapsed member that tenant A must NOT see.
    await insertCycle(tenantB.ctx.slug, bMember, { status: 'lapsed', expiresAt: NOW_PAST, createdAt: NOW_PAST, closedReason: 'lapsed' });
  });

  afterAll(async () => {
    await tenantA?.cleanup();
    await tenantB?.cleanup();
  });

  it('positive control: returns exactly the lapsed members of tenant A', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [mLapsed, mActive, mNone, mMulti],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect([...res.value].sort()).toEqual([mLapsed, mMulti].sort());
  });

  it('cross-tenant negative control: tenant A cannot see tenant B lapsed members', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const res = await loadMembersMembershipStatus(deps, {
      tenantId: tenantA.ctx.slug,
      memberIds: [bMember],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.size).toBe(0);
  });

  it('multi-cycle parity: the batch picks the SAME cycle as loadMemberRenewalStatus', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const single = await loadMemberRenewalStatus(deps, { tenantId: tenantA.ctx.slug, memberId: mMulti });
    expect(single.ok).toBe(true);
    const batch = await loadMembersMembershipStatus(deps, { tenantId: tenantA.ctx.slug, memberIds: [mMulti] });
    expect(batch.ok).toBe(true);
    // single's latest cycle is the lapsed one → so the batch flags mMulti as lapsed.
    if (single.ok) expect(single.value.cycle?.status).toBe('lapsed');
    if (batch.ok) expect(batch.value.has(mMulti)).toBe(true);
  });

  it('EXPLAIN: the batch query uses the recency index — no Seq Scan / no Sort', async () => {
    const idsSql = `ARRAY['${mLapsed}','${mActive}','${mMulti}']::uuid[]`;
    const planRows = (await db.execute(
      `EXPLAIN SELECT DISTINCT ON (member_id) * FROM renewal_cycles
       WHERE tenant_id = '${tenantA.ctx.slug}' AND member_id = ANY(${idsSql})
       ORDER BY member_id, created_at DESC, cycle_id DESC` as never,
    )) as unknown as Array<Record<string, string>>;
    const plan = planRows.map((r) => Object.values(r)[0]).join('\n');
    expect(plan).not.toMatch(/Seq Scan/i);
    expect(plan).toMatch(/renewal_cycles_member_recency_idx|Index/i);
  });
});
```

(Adjust the `createTestTenant` import path + `db.execute` raw-query shape to match the project's exact helpers — read `at-risk-bulk-write.test.ts` and an existing `EXPLAIN`-using test first.)

- [ ] **Step 2: Run the integration test**

Run: `pnpm test:integration -- tests/integration/renewals/load-members-membership-status.test.ts`
Expected: PASS (4 tests). If EXPLAIN shows a `Seq Scan`/`Sort`, re-confirm Task 3's migration applied (`pnpm drizzle-kit migrate`).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/renewals/load-members-membership-status.test.ts
git commit -m "test(renewals): live-Neon integration for loadMembersMembershipStatus (#4)"
```

---

## Task 7: i18n keys (EN/TH/SV)

**Files:**
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json`

- [ ] **Step 1: Add both keys to all three locales**

Inside the `admin.members.directory` object in each file, add:

`en.json`:
```json
"membershipLapsed": "Lapsed",
"membershipLapsedSr": "Membership lapsed — needs renewal",
```

`th.json`:
```json
"membershipLapsed": "หมดอายุ",
"membershipLapsedSr": "สมาชิกภาพหมดอายุ — ต้องต่ออายุ",
```

`sv.json`:
```json
"membershipLapsed": "Förfallen",
"membershipLapsedSr": "Medlemskap förfallet — kräver förnyelse",
```

- [ ] **Step 2: Verify parity**

Run: `pnpm check:i18n`
Expected: PASS — both keys present in EN/TH/SV (no missing-key failure).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "i18n(members): membershipLapsed + SR text EN/TH/SV (#4)"
```

---

## Task 8: Page enrichment — `membership_lapsed` on the row

**Files:**
- Modify: `src/components/members/members-table.tsx` (add field to `MembersTableRow`, lines 70–116)
- Modify: `src/app/(staff)/admin/members/page.tsx` (compute the lapsed set; set the field in the row map)

- [ ] **Step 1: Add the field to `MembersTableRow`**

In `src/components/members/members-table.tsx`, inside the `MembersTableRow` type (after `status`, ~line 99), add:

```typescript
  /**
   * #4 — true when the member's most-recent renewal cycle has lapsed
   * (terminal lapsed/cancelled, past expiry). Derived server-side in the page
   * via loadMembersMembershipStatus; the cell renders a badge when true.
   * Always set (never optional) to match the row-builder's exhaustive map.
   */
  readonly membership_lapsed: boolean;
```

- [ ] **Step 2: Compute the lapsed set + enrich rows in the page**

In `src/app/(staff)/admin/members/page.tsx`:

(a) add the import near the other module barrels (after the `@/modules/insights` import, line 34):

```typescript
import {
  loadMembersMembershipStatus,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
```

(adjust `errKind` import path to match `dashboard-reads.ts` — it imports `errKind` from `@/lib/log-id`.)

(b) add a best-effort wrapper as a module-scope helper (above the page component):

```typescript
/**
 * Best-effort lapsed-membership enrichment. Renewals is a secondary read on the
 * member-directory hot path — a failure must NEVER take down the directory.
 * Handles BOTH a Result `!ok` AND a thrown repo call (a runInTenant query can
 * throw, not just return !ok). On either path: log one warn (errKind +
 * memberIdsCount only, no ids/PII) and return an empty set → no badges.
 */
async function loadMembersMembershipStatusSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberIds: readonly string[],
): Promise<ReadonlySet<string>> {
  try {
    const res = await loadMembersMembershipStatus(makeRenewalsDeps(tenant.slug), {
      tenantId: tenant.slug,
      memberIds,
    });
    if (res.ok) return res.value;
    logger.warn(
      { tenantId: tenant.slug, errKind: 'result_not_ok', memberIdsCount: memberIds.length },
      '[members-lapsed] loadMembersMembershipStatus !ok — badges suppressed',
    );
    return new Set<string>();
  } catch (e) {
    logger.warn(
      { tenantId: tenant.slug, errKind: errKind(e), memberIdsCount: memberIds.length },
      '[members-lapsed] loadMembersMembershipStatus threw — badges suppressed',
    );
    return new Set<string>();
  }
}
```

(Confirm `tenant.slug` is the correct field on the `resolveTenantFromRequest()` return — match what `makeRenewalsDeps`/`dashboard-reads.ts` use; the dashboard uses `ctx.slug`. If `resolveTenantFromRequest()` returns a `TenantContext`, `tenant.slug` is correct.)

(c) the page currently awaits `resolveMemberNumberPrefix` (lines 259–262) THEN maps rows. Replace that single await with a `Promise.all` that also computes the lapsed set (both depend only on the already-resolved search result — overlap their round-trips):

```typescript
  const memberIds = result.value.items.map((row) => row.member.memberId);
  const [memberPrefix, lapsedIds] = await Promise.all([
    resolveMemberNumberPrefix(tenant, deps.memberSettings),
    loadMembersMembershipStatusSafe(tenant, memberIds),
  ]);
```

(d) in the row map (lines 264–299), add the field to the returned object (after `status: row.member.status,`):

```typescript
    status: row.member.status,
    membership_lapsed: lapsedIds.has(row.member.memberId),
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. (The `MembersTableSkeleton` and any other `MembersTableRow` constructors do not need the field — only real rows do; skeletons render placeholder cells.)

- [ ] **Step 4: Commit**

```bash
git add src/components/members/members-table.tsx src/app/\(staff\)/admin/members/page.tsx
git commit -m "feat(members): enrich directory rows with membership_lapsed (#4)"
```

---

## Task 9: Badge UI in the status cell + component test

**Files:**
- Modify: `src/components/members/members-table.tsx` (status column cell ~line 524; import `TriangleAlert`)
- Test: `tests/unit/components/members/members-table-lapsed-badge.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `tests/unit/components/members/members-table-lapsed-badge.test.tsx`. Mirror any existing members-table component test for the `NextIntlClientProvider` / messages wrapper; if none exists, use this self-contained form:

```typescript
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';
import en from '@/i18n/messages/en.json';

function baseRow(overrides: Partial<MembersTableRow>): MembersTableRow {
  return {
    member_id: 'm1', member_number_display: 'SCCM-0001', company_name: 'Acme Co.',
    country: 'TH', plan_id: 'p1', plan_year: 2026, plan_display_name: 'Regular Corporate',
    status: 'active', engagement: null, last_activity_at: null, primary_contact: null,
    membership_lapsed: false, ...overrides,
  };
}

function renderTable(rows: MembersTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MembersTable rows={rows} nextCursor={null} />
    </NextIntlClientProvider>,
  );
}

describe('MembersTable lapsed badge', () => {
  it('renders the Lapsed badge + SR text on a lapsed row', () => {
    renderTable([baseRow({ membership_lapsed: true })]);
    expect(screen.getByText('Lapsed')).toBeInTheDocument();
    expect(screen.getByText('Membership lapsed — needs renewal')).toBeInTheDocument();
  });

  it('renders NO Lapsed badge on a non-lapsed row', () => {
    renderTable([baseRow({ membership_lapsed: false })]);
    expect(screen.queryByText('Lapsed')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/components/members/members-table-lapsed-badge.test.tsx`
Expected: FAIL — no "Lapsed" text rendered.

- [ ] **Step 3: Implement the badge in the status cell**

In `src/components/members/members-table.tsx`:

(a) add `TriangleAlert` to the `lucide-react` import (the block at lines 55–61):

```typescript
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  PencilIcon,
  TriangleAlert,
} from 'lucide-react';
```

(b) replace the `status` column cell (lines 524–536) with a version that wraps the status control + the lapsed badge as siblings (badge OUTSIDE the `InlineStatusCell` button — so a click on the warning never fires the status toggle):

```typescript
    columnHelper.accessor('status', {
      header: () => t('columns.status'),
      cell: (info) => (
        <span className="inline-flex items-center gap-1.5">
          {enableSelection ? (
            <InlineStatusCell
              memberId={info.row.original.member_id}
              status={info.getValue()}
              onSave={onInlineEdit}
            />
          ) : (
            <StatusBadge status={info.getValue()} />
          )}
          {info.row.original.membership_lapsed ? (
            <Badge
              variant="outline"
              className="gap-1 border-destructive/40 text-destructive"
            >
              <TriangleAlert aria-hidden="true" className="size-3" />
              <span>{t('membershipLapsed')}</span>
              <span className="sr-only">{t('membershipLapsedSr')}</span>
            </Badge>
          ) : null}
        </span>
      ),
    }),
```

(`Badge` is already imported at line 52; `t` is `useTranslations('admin.members.directory')`, line 366.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/unit/components/members/members-table-lapsed-badge.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout`
Expected: clean.

```bash
git add src/components/members/members-table.tsx tests/unit/components/members/members-table-lapsed-badge.test.tsx
git commit -m "feat(members): lapsed-membership badge in the directory status cell (#4)"
```

---

## Final verification (after all tasks)

- [ ] Run the renewals + members unit/contract subset: `pnpm vitest run tests/unit/renewals tests/unit/portal/dashboard tests/unit/components/members`
- [ ] Run the new integration test: `pnpm test:integration -- tests/integration/renewals/load-members-membership-status.test.ts`
- [ ] Full local CI subset: `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout`
- [ ] (Optional) Browser-verify: seed a lapsed member, open `/admin/members`, confirm the outline "Lapsed" badge sits beside the green "Active" badge on that row only.

## Notes for the implementer

- **Tenant isolation (Principle I):** the batch repo MUST run inside `runInTenant` — never the global `db` singleton (silent RLS bypass). The cross-tenant integration test (Task 6) is the Review-Gate blocker proof.
- **Apply-migration-before-commit (gotcha):** Task 3 adds a migration AND Task 6 references the index — run `pnpm drizzle-kit migrate` + the integration test before committing Task 6.
- **No new metric:** the failure signal is the page-side `warn` (Task 8) only — do not add an unwired metric instrument.
- **Sequential commits:** if dispatching file-mutating subagents, run them sequentially (shared git index) and verify `git log`/`git status` between tasks.
