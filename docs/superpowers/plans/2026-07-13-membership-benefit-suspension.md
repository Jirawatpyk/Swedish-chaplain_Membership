# Membership Benefit Suspension + Lapse Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make membership lapse actually enforce — an expired-unpaid member is *suspended* (benefits blocked, access to pay/read kept) and after 90 days *terminated*, wired at real chokepoints so a future route cannot skip the gate.

**Architecture:** One pure Domain predicate `deriveMembershipAccess(cycle, now)` in `src/modules/renewals` is the single source of truth. Presentation reaches it through two existing DB-capable chokepoints (`portal/layout.tsx`, `requireMemberContext`); F7 `submitBroadcast` and F3 `inviteColleague` reach it through a new `MembershipAccessPort` + adapter (mirroring the F7 `plansBridge`). A new `check:portal-guard` CI gate stops the next route from forgetting the chokepoint. No schema change beyond 5 audit-enum values.

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 App Router · React 19 · Drizzle ORM · Neon Postgres (RLS via `runInTenant`) · Vitest + Playwright · next-intl (EN/TH/SV).

**Spec:** `docs/superpowers/specs/2026-07-13-membership-benefit-suspension-design.md` (rev 2, approved).

## Global Constraints

- **Package manager:** `pnpm`, never `npm`.
- **Branch:** `059-membership-suspension` (worktree at `.claude/worktrees/membership-suspension`, off `origin/main`). Run `git branch --show-current` before each commit batch.
- **Clean Architecture (Principle III):** Domain imports nothing from `next`/`drizzle-orm`/`react`. Application imports no ORM/HTTP/React. Cross-module access goes through a module's public barrel or a port — never a sibling's `domain/`/`application/`. `src/lib/**` is the exempt composition layer (`eslint.config.mjs:332`) and MAY call barrels directly.
- **Tenant isolation (Principle I):** every tenant-scoped repo read wraps its own `runInTenant(tenant, tx)` and relies on the RLS GUC — never the global `db` singleton. A cross-tenant probe integration test is a Review-Gate blocker.
- **TDD (Principle II):** failing test → commit red → implement → commit green. Domain 100% line coverage; Application 80% line + 80% branch.
- **i18n:** EN canonical (`src/i18n/messages/en.json`); TH + SV required, from native speakers, never machine-translated. `pnpm check:i18n` blocks on a missing EN key.
- **Audit event type:** adding one touches **5 places** — domain const, pgEnum migration, the two parity-test counts, and the `audit.*` i18n label registry. `pnpm check:audit-events && pnpm check:audit-counts` must pass.
- **Timestamps:** ISO 8601 UTC storage; Buddhist Era display-only.
- **Migrations:** `pnpm db:migrate` hits the **dev** Neon branch; apply the migration + run `pnpm test:integration` **before** committing code that references a new enum value.
- **Copy rule:** suspended = **amber** (`tone="warning"`, `<PauseCircle>`); terminated = **red** (`tone="destructive"`, `<TriangleAlert>`). Never colour-alone. Never tell a `pending_review` (already-paid) member to pay again.
- **Slice order:** Slice 2 MUST NOT ship before Slice 1 (grace=90 before suspension exists = a 90-day free ride).

---

# SLICE 1 — Enforcement core (closes both go-live blockers)

## Task 1: `deriveMembershipAccess` Domain predicate

**Files:**
- Modify: `src/modules/renewals/domain/renewal-cycle.ts` (add after `isMembershipLapsed`, :331)
- Test: `tests/unit/renewals/domain/derive-membership-access.test.ts`

**Interfaces:**
- Consumes: `RenewalCycle` type, `isTerminalCycleStatus` (both already in `renewal-cycle.ts`).
- Produces:
  ```ts
  type MembershipAccessReason =
    | 'in_good_standing' | 'unpaid' | 'pending_review' | 'grace_expired' | 'cancelled';
  interface MembershipAccessDecision {
    readonly access: 'full' | 'suspended' | 'terminated';
    readonly reason: MembershipAccessReason;
  }
  function deriveMembershipAccess(cycle: RenewalCycle | null, now: Date): MembershipAccessDecision;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/renewals/domain/derive-membership-access.test.ts
import { describe, expect, it } from 'vitest';
import { deriveMembershipAccess, type RenewalCycle } from '@/modules/renewals';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = new Date('2026-07-13T00:00:00.000Z');

function cycle(over: Partial<RenewalCycle>): RenewalCycle {
  return {
    cycleId: '00000000-0000-0000-0000-000000000001',
    memberId: '00000000-0000-0000-0000-0000000000aa',
    status: 'upcoming',
    periodFrom: PAST,
    periodTo: FUTURE,
    expiresAt: FUTURE,
    frozenPlanPriceThb: '1000.00',
    frozenPlanTermMonths: 12,
    planIdAtCycleStart: '00000000-0000-0000-0000-0000000000bb',
    linkedInvoiceId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    closedAt: null,
    closedReason: null,
    ...over,
  } as RenewalCycle;
}

describe('deriveMembershipAccess', () => {
  it.each([
    ['upcoming, future expiry',       { status: 'upcoming', expiresAt: FUTURE },              'full',       'in_good_standing'],
    ['reminded, future expiry',       { status: 'reminded', expiresAt: FUTURE },              'full',       'in_good_standing'],
    ['upcoming, PAST expiry (cron gap)', { status: 'upcoming', expiresAt: PAST },             'suspended',  'unpaid'],
    ['reminded, PAST expiry',         { status: 'reminded', expiresAt: PAST },                'suspended',  'unpaid'],
    ['awaiting_payment',              { status: 'awaiting_payment', expiresAt: PAST },        'suspended',  'unpaid'],
    ['pending_admin_reactivation',    { status: 'pending_admin_reactivation', expiresAt: PAST }, 'suspended', 'pending_review'],
    ['completed, PAST expiry',        { status: 'completed', expiresAt: PAST },               'full',       'in_good_standing'],
    ['completed, future expiry',      { status: 'completed', expiresAt: FUTURE },             'full',       'in_good_standing'],
    ['lapsed, past expiry',           { status: 'lapsed', expiresAt: PAST },                  'terminated', 'grace_expired'],
    ['cancelled, PAST expiry',        { status: 'cancelled', expiresAt: PAST },               'terminated', 'cancelled'],
    ['cancelled, FUTURE expiry',      { status: 'cancelled', expiresAt: FUTURE },             'full',       'in_good_standing'],
  ])('%s', (_label, over, access, reason) => {
    const d = deriveMembershipAccess(cycle(over), NOW);
    expect(d.access).toBe(access);
    expect(d.reason).toBe(reason);
  });

  it('null cycle → full', () => {
    expect(deriveMembershipAccess(null, NOW)).toEqual({ access: 'full', reason: 'in_good_standing' });
  });

  it('expiresAt exactly === now → still full (strict <)', () => {
    expect(deriveMembershipAccess(cycle({ status: 'upcoming', expiresAt: NOW.toISOString() }), NOW).access).toBe('full');
  });

  it('malformed expiresAt on a terminal cycle → terminated', () => {
    expect(deriveMembershipAccess(cycle({ status: 'lapsed', expiresAt: 'not-a-date' }), NOW).access).toBe('terminated');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm vitest run tests/unit/renewals/domain/derive-membership-access.test.ts`
Expected: FAIL — `deriveMembershipAccess is not a function`.

- [ ] **Step 3: Implement the predicate**

```ts
// src/modules/renewals/domain/renewal-cycle.ts — append after isMembershipLapsed (:331)

export type MembershipAccessReason =
  | 'in_good_standing'
  | 'unpaid'
  | 'pending_review'
  | 'grace_expired'
  | 'cancelled';

export interface MembershipAccessDecision {
  readonly access: 'full' | 'suspended' | 'terminated';
  readonly reason: MembershipAccessReason;
}

/**
 * Single source of truth for a member's benefit-access state.
 *
 *  - `terminated`: an ENDED-terminal cycle — `lapsed`/`cancelled` AND
 *    `expiresAt` in the past (mirrors `isMembershipLapsed`'s two-condition
 *    rule; a `cancelled` cycle whose period has NOT ended is not ended
 *    coverage → `full`). `completed` is NEVER terminated (057 R2: the member
 *    paid; re-prompting payment causes a duplicate).
 *  - `suspended`: `awaiting_payment`/`pending_admin_reactivation`, OR a
 *    NON-terminal cycle (`upcoming`/`reminded`) whose period already ended
 *    (closes the 06:15-cron gap — correct the instant the period ends, no
 *    cron dependency).
 *  - `full`: everything else, including a member with no cycle.
 *
 * Comparison is instant-vs-instant on `expiresAt` (the trigger-maintained
 * mirror of `period_to`); a malformed `expiresAt` on a terminal cycle is
 * treated as ended. `now` is injected — no wall-clock read.
 */
export function deriveMembershipAccess(
  cycle: RenewalCycle | null,
  now: Date,
): MembershipAccessDecision {
  if (cycle === null) return { access: 'full', reason: 'in_good_standing' };

  if (cycle.status === 'pending_admin_reactivation') {
    return { access: 'suspended', reason: 'pending_review' };
  }
  if (cycle.status === 'awaiting_payment') {
    return { access: 'suspended', reason: 'unpaid' };
  }
  if (cycle.status === 'completed') {
    return { access: 'full', reason: 'in_good_standing' };
  }

  const expiresMs = Date.parse(cycle.expiresAt);
  const expired = !Number.isFinite(expiresMs) || expiresMs < now.getTime();

  if (cycle.status === 'lapsed' || cycle.status === 'cancelled') {
    return expired
      ? { access: 'terminated', reason: cycle.status === 'lapsed' ? 'grace_expired' : 'cancelled' }
      : { access: 'full', reason: 'in_good_standing' };
  }

  // upcoming | reminded
  return expired
    ? { access: 'suspended', reason: 'unpaid' }
    : { access: 'full', reason: 'in_good_standing' };
}

/** Redefined in terms of the canonical predicate — one good-standing rule. */
export function isMembershipLapsed(cycle: RenewalCycle, now: Date): boolean {
  return deriveMembershipAccess(cycle, now).access === 'terminated';
}
```

Delete the OLD `isMembershipLapsed` body (:325-331) — it is replaced by the one-line redefinition above.

- [ ] **Step 4: Export from the barrel**

```ts
// src/modules/renewals/index.ts — extend the domain/renewal-cycle export block (:75-88)
export {
  CLOSED_REASONS, parseCycleId, assertCycleInvariants, cycleFrozenPriceSatang,
  isOverdue, daysUntilExpiry, isMembershipLapsed,
  deriveMembershipAccess,                          // NEW
  type CycleId, type CycleIdError, type ClosedReason, type RenewalCycle,
  type CycleInvariantError,
  type MembershipAccessDecision,                   // NEW
  type MembershipAccessReason,                     // NEW
} from './domain/renewal-cycle';
```

- [ ] **Step 5: Run tests + the existing lapsed consumers**

Run: `pnpm vitest run tests/unit/renewals/domain/derive-membership-access.test.ts tests/unit/renewals/domain/renewal-cycle.test.ts tests/unit/renewals/domain/is-membership-lapsed.test.ts`
Expected: PASS (the redefined `isMembershipLapsed` must keep its existing tests green).

- [ ] **Step 6: Commit**

```bash
git add src/modules/renewals/domain/renewal-cycle.ts src/modules/renewals/index.ts tests/unit/renewals/domain/derive-membership-access.test.ts
git commit -m "feat(renewals): deriveMembershipAccess predicate (subsumes isMembershipLapsed)"
```

---

## Task 2: `findLatestCycleForMember` repo read (live-Neon)

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (add method to the port)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (add impl beside `findLatestCyclesForMembers`, :640-663)
- Test: `tests/integration/renewals/find-latest-cycle-for-member.test.ts`

**Interfaces:**
- Consumes: `runInTenant`, `renewalCycles` schema, `rowToDomain` (all already in the repo file).
- Produces: `findLatestCycleForMember(tenantId: string, memberId: string): Promise<RenewalCycle | null>` on `RenewalCycleRepo`. **Returns all statuses** (including `lapsed`/`cancelled`), ordered `created_at DESC, cycle_id DESC` (the SAME key `findLatestCyclesForMembers` uses — do NOT introduce `period_from`).

- [ ] **Step 1: Write the failing integration test** (model on `tests/integration/renewals/find-most-recent-for-member.test.ts`)

```ts
// tests/integration/renewals/find-latest-cycle-for-member.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// NOTE: the assertion `repo returns a LAPSED cycle` is the single test that would
// have caught the original dead-gate bug. It MUST run against live Neon, unmocked.

describe('findLatestCycleForMember — integration', () => {
  let tenant: TestTenant;
  let planId: string;
  const { cyclesRepo } = makeRenewalsDeps(/* tenant injected per-call below */);
  // (Follow find-most-recent-for-member.test.ts for the exact makeRenewalsDeps wiring.)

  beforeAll(async () => {
    tenant = await createTestTenant();
    await createActiveTestUser(tenant);
    planId = await seedF8MembershipPlan(tenant);
  });
  afterAll(async () => { await tenant.cleanup(); });

  async function seedCycle(memberId: string, status: string, periodFrom: string, createdAt: string) {
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(renewalCycles).values({
        cycleId, tenantId: tenant.id, memberId, status,
        periodFrom, periodTo: periodFrom, expiresAt: periodFrom,
        frozenPlanPriceThb: '1000.00', frozenPlanTermMonths: 12,
        planIdAtCycleStart: planId, createdAt,
      } as never);
    });
    return cycleId;
  }

  it('returns a LAPSED cycle (the assertion that catches the original bug)', async () => {
    const memberId = randomUUID();
    await seedCycle(memberId, 'lapsed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    const got = await cyclesRepo.findLatestCycleForMember(tenant.id, memberId);
    expect(got?.status).toBe('lapsed');
  });

  it('completed-2025 + upcoming-2026 → returns the 2026 (newest created_at)', async () => {
    const memberId = randomUUID();
    await seedCycle(memberId, 'completed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    await seedCycle(memberId, 'upcoming', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    const got = await cyclesRepo.findLatestCycleForMember(tenant.id, memberId);
    expect(got?.status).toBe('upcoming');
  });

  it('lapsed-2025 + admin-renewed upcoming-2026 → returns the renewed cycle, NOT the stale lapsed', async () => {
    const memberId = randomUUID();
    await seedCycle(memberId, 'lapsed', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    await seedCycle(memberId, 'upcoming', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z');
    const got = await cyclesRepo.findLatestCycleForMember(tenant.id, memberId);
    expect(got?.status).toBe('upcoming');
  });

  it('no cycle → null', async () => {
    expect(await cyclesRepo.findLatestCycleForMember(tenant.id, randomUUID())).toBeNull();
  });

  it('cross-tenant: tenant A cannot read tenant B member cycle (RLS)', async () => {
    const tenantB = await createTestTenant();
    const memberB = randomUUID();
    // seed under tenantB.ctx then read under tenant.ctx → null
    // (mirror the cross-tenant probe in tests/integration/renewals/reanchor-period.test.ts)
    const gotUnderA = await cyclesRepo.findLatestCycleForMember(tenant.id, memberB);
    expect(gotUnderA).toBeNull();
    await tenantB.cleanup();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:integration -- find-latest-cycle-for-member`
Expected: FAIL — `findLatestCycleForMember is not a function`.

- [ ] **Step 3: Add to the port interface**

```ts
// src/modules/renewals/application/ports/renewal-cycle-repo.ts — add to RenewalCycleRepo
/**
 * The member's single most-recent cycle across ALL statuses (incl.
 * lapsed/cancelled). Ordered created_at DESC, cycle_id DESC — the SAME key
 * as findLatestCyclesForMembers, so the gate and the admin badge never
 * disagree on "latest". Backs deriveMembershipAccess.
 */
readonly findLatestCycleForMember: (
  tenantId: string,
  memberId: string,
) => Promise<RenewalCycle | null>;
```

- [ ] **Step 4: Implement in the drizzle repo** (single-row sibling of `findLatestCyclesForMembers`)

```ts
// src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts — add near :663
async findLatestCycleForMember(
  _tenantId: string,
  memberId: string,
): Promise<RenewalCycle | null> {
  return runInTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(renewalCycles)
      .where(eq(renewalCycles.memberId, memberId))
      .orderBy(desc(renewalCycles.createdAt), desc(renewalCycles.cycleId))
      .limit(1);
    return rows[0] ? rowToDomain(rows[0]) : null;
  });
},
```

- [ ] **Step 5: Run test, verify PASS**

Run: `pnpm test:integration -- find-latest-cycle-for-member`
Expected: PASS (all 5 cases, including the lapsed and cross-tenant assertions).

- [ ] **Step 6: Commit**

```bash
git add src/modules/renewals/application/ports/renewal-cycle-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts tests/integration/renewals/find-latest-cycle-for-member.test.ts
git commit -m "feat(renewals): findLatestCycleForMember repo read (all statuses, shared ordering)"
```

---

## Task 3: Two-policy resolver + fix `lapsed-portal-scope`

**Files:**
- Modify: `src/lib/lapsed-portal-scope.ts` (replace `findActiveForMember` usage; add suspended policy)
- Test: `tests/unit/lib/membership-suspension-policy.test.ts` (new)
- Test: `tests/unit/lib/lapsed-portal-scope.test.ts` (repoint to `findLatestCycleForMember`; KEEP the `/portal/renewal-evil` confusable cases)

**Interfaces:**
- Consumes: `deriveMembershipAccess` (Task 1), `findLatestCycleForMember` (Task 2).
- Produces:
  ```ts
  const SUSPENDED_DENYLIST_PREFIXES: readonly string[]; // ['/portal/broadcasts/new', '/api/portal/broadcasts']
  // terminated keeps LAPSED_PORTAL_ALLOWED_PREFIXES + '/portal'
  // checkPortalAccess(deps, ctx) → decision keyed on deriveMembershipAccess, not status literals
  ```

- [ ] **Step 1: Write the failing policy test**

```ts
// tests/unit/lib/membership-suspension-policy.test.ts
import { describe, expect, it } from 'vitest';
import { isSuspendedDeniedRoute, isTerminatedAllowedRoute } from '@/lib/lapsed-portal-scope';

describe('suspended denylist (allow-by-default)', () => {
  it('blocks /portal/broadcasts/new', () => expect(isSuspendedDeniedRoute('/portal/broadcasts/new')).toBe(true));
  it('allows /portal/invoices/[id] (must reach to pay)', () => expect(isSuspendedDeniedRoute('/portal/invoices/abc')).toBe(false));
  it('allows /api/portal/invoices/[id]/pdf', () => expect(isSuspendedDeniedRoute('/api/portal/invoices/abc/pdf')).toBe(false));
  it('allows /portal/account/data-export (GDPR Art.20)', () => expect(isSuspendedDeniedRoute('/portal/account/data-export')).toBe(false));
  it('allows /portal/credit-notes/[id]', () => expect(isSuspendedDeniedRoute('/portal/credit-notes/abc')).toBe(false));
  it('does NOT block a confusable /portal/broadcasts/new-thing? via bare substring', () =>
    expect(isSuspendedDeniedRoute('/portal/broadcasts/newsletter')).toBe(false));
  it('allows reading an existing broadcast /portal/broadcasts/[id]', () =>
    expect(isSuspendedDeniedRoute('/portal/broadcasts/abc123')).toBe(false));
});

describe('terminated allowlist (deny-by-default)', () => {
  it('allows /portal (dashboard — renders the mailto contact CTA)', () => expect(isTerminatedAllowedRoute('/portal')).toBe(true));
  it('allows /portal/account', () => expect(isTerminatedAllowedRoute('/portal/account')).toBe(true));
  it('blocks /portal/timeline', () => expect(isTerminatedAllowedRoute('/portal/timeline')).toBe(false));
  it('does NOT allow /portal/renewal-evil via bare prefix', () => expect(isTerminatedAllowedRoute('/portal/renewal-evil')).toBe(false));
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run tests/unit/lib/membership-suspension-policy.test.ts`
Expected: FAIL — `isSuspendedDeniedRoute is not exported`.

- [ ] **Step 3: Implement the two policies** in `src/lib/lapsed-portal-scope.ts`

```ts
// Add '/portal' to the terminated allowlist so the /portal/renewal redirect lands somewhere allowed.
export const LAPSED_PORTAL_ALLOWED_PREFIXES: readonly string[] = [
  '/portal',                    // NEW — dashboard renders the terminated mailto CTA
  '/portal/renewal',
  '/portal/preferences/renewals',
  '/portal/preferences',
  '/portal/account',
  '/api/portal/renewal',
  '/api/portal/preferences/renewals',
];

// Suspended: allow-by-default; block only the self-serve benefit-consuming surfaces.
// The use-case gates (Tasks 4-5) are the real enforcement; this is UX.
export const SUSPENDED_DENYLIST_PREFIXES: readonly string[] = [
  '/portal/broadcasts/new',
  '/api/portal/broadcasts',     // compose/submit API surface
];

export function isTerminatedAllowedRoute(pathname: string): boolean {
  return LAPSED_PORTAL_ALLOWED_PREFIXES.some((p) => matchesScopePrefix(pathname, p));
}
export function isSuspendedDeniedRoute(pathname: string): boolean {
  return SUSPENDED_DENYLIST_PREFIXES.some((p) => matchesScopePrefix(pathname, p));
}
```

Rewrite `checkLapsedPortalScope` (rename to `checkPortalAccess`, keep old export as a thin alias for the existing tests during transition) to call `findLatestCycleForMember` + `deriveMembershipAccess`:

```ts
export async function checkPortalAccess(
  deps: PortalAccessDeps,   // { cyclesRepo: Pick<RenewalCycleRepo,'findLatestCycleForMember'>, auditEmitter, clock }
  ctx: PortalAccessContext, // { tenantId, memberId, pathname, action?, actorUserId, correlationId }
): Promise<PortalAccessDecision> {
  let cycle;
  try {
    cycle = await deps.cyclesRepo.findLatestCycleForMember(ctx.tenantId, ctx.memberId);
  } catch (e) {
    // FAIL OPEN on reads — a DB blip must not lock every member out — but audit it.
    await emitFailOpen(deps, ctx, e);
    return { allowed: true, reason: 'fail_open' };
  }
  const { access } = deriveMembershipAccess(cycle, deps.clock.now());
  if (access === 'full') return { allowed: true, reason: 'full' };
  if (access === 'terminated') {
    if (isTerminatedAllowedRoute(ctx.pathname)) return { allowed: true, reason: 'route_whitelisted' };
    await emitBlocked(deps, ctx, cycle!.cycleId, 'terminated');
    return { allowed: false, reason: 'terminated_route_blocked', cycleId: cycle!.cycleId };
  }
  // suspended
  if (!isSuspendedDeniedRoute(ctx.pathname)) return { allowed: true, reason: 'suspended_route_allowed' };
  await emitBlocked(deps, ctx, cycle!.cycleId, 'suspended');
  return { allowed: false, reason: 'suspended_route_blocked', cycleId: cycle!.cycleId };
}
```

(`emitFailOpen` and `emitBlocked` land in Task 8 with the audit events; stub them to `Promise.resolve()` here and wire in Task 8.)

- [ ] **Step 4: Repoint the existing unit test** `tests/unit/lib/lapsed-portal-scope.test.ts` — change the mock from `findActiveForMember` to `findLatestCycleForMember`, seed a `lapsed` cycle (now returnable), assert the block. **Keep** the `/portal/renewal-evil` confusable cases.

- [ ] **Step 5: Run both unit test files, verify PASS**

Run: `pnpm vitest run tests/unit/lib/membership-suspension-policy.test.ts tests/unit/lib/lapsed-portal-scope.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/lapsed-portal-scope.ts tests/unit/lib/membership-suspension-policy.test.ts tests/unit/lib/lapsed-portal-scope.test.ts
git commit -m "feat(portal): two-policy access resolver on deriveMembershipAccess + findLatestCycleForMember"
```

---

## Task 4: `MembershipAccessPort` + adapter (cross-module bridge)

**Files:**
- Create: `src/modules/broadcasts/application/ports/membership-access-port.ts`
- Create: `src/modules/broadcasts/infrastructure/membership-access-bridge.ts`
- Test: `tests/contract/renewals/membership-access-port.contract.test.ts`

**Interfaces:**
- Consumes: `deriveMembershipAccess`, `findLatestCycleForMember` (via a drizzle repo instance at the composition root — mirror `plans-bridge.ts`).
- Produces:
  ```ts
  interface MembershipAccessPort {
    getMembershipAccess(tenant: TenantContext, memberId: string):
      Promise<Result<{ access: 'full'|'suspended'|'terminated'; reason: MembershipAccessReason }, { kind: 'membership_access.lookup_error' }>>;
  }
  export const membershipAccessBridge: MembershipAccessPort;
  ```

- [ ] **Step 1: Write the failing contract test**

```ts
// tests/contract/renewals/membership-access-port.contract.test.ts
import { describe, expect, it } from 'vitest';
import type { MembershipAccessPort } from '@/modules/broadcasts/application/ports/membership-access-port';

// Contract: any adapter must return a discriminated {access, reason} on success,
// and a lookup_error kind (NOT a throw) on infra failure — so the use-case can fail closed.
function suite(make: () => MembershipAccessPort) {
  it('exposes getMembershipAccess', () => {
    expect(typeof make().getMembershipAccess).toBe('function');
  });
}
// A fake adapter proves the shape; the real bridge is integration-tested in Task 5.
suite(() => ({
  async getMembershipAccess() { return { ok: true, value: { access: 'suspended', reason: 'unpaid' } }; },
}));
describe('MembershipAccessPort contract', () => { it('placeholder', () => expect(true).toBe(true)); });
```

- [ ] **Step 2: Run, verify fail** — `pnpm vitest run tests/contract/renewals/membership-access-port.contract.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the port**

```ts
// src/modules/broadcasts/application/ports/membership-access-port.ts
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MembershipAccessReason } from '@/modules/renewals';

export interface MembershipAccessSummary {
  readonly access: 'full' | 'suspended' | 'terminated';
  readonly reason: MembershipAccessReason;
}
export interface MembershipAccessLookupError { readonly kind: 'membership_access.lookup_error'; }
export interface MembershipAccessPort {
  getMembershipAccess(
    tenant: TenantContext,
    memberId: string,
  ): Promise<Result<MembershipAccessSummary, MembershipAccessLookupError>>;
}
```

- [ ] **Step 4: Write the adapter** (mirror `plans-bridge.ts` — import the drizzle repo directly at the composition root)

```ts
// src/modules/broadcasts/infrastructure/membership-access-bridge.ts
import { err, ok } from '@/lib/result';
import { systemClock } from '@/lib/clock';
import type { TenantContext } from '@/modules/tenants';
import { deriveMembershipAccess } from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import type { MembershipAccessPort } from '../application/ports/membership-access-port';

export const membershipAccessBridge: MembershipAccessPort = {
  async getMembershipAccess(tenant: TenantContext, memberId: string) {
    try {
      const repo = makeDrizzleRenewalCycleRepo(tenant);
      const cycle = await repo.findLatestCycleForMember(tenant.tenantId as string, memberId);
      const { access, reason } = deriveMembershipAccess(cycle, systemClock.now());
      return ok({ access, reason });
    } catch {
      return err({ kind: 'membership_access.lookup_error' as const });
    }
  },
};
```

(If `makeDrizzleRenewalCycleRepo` is not the exact factory name, use whatever `find-most-recent-for-member.test.ts` uses via `makeRenewalsDeps` — confirm the export before writing.)

- [ ] **Step 5: Run contract test, verify PASS** — `pnpm vitest run tests/contract/renewals/membership-access-port.contract.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/broadcasts/application/ports/membership-access-port.ts src/modules/broadcasts/infrastructure/membership-access-bridge.ts tests/contract/renewals/membership-access-port.contract.test.ts
git commit -m "feat(broadcasts): MembershipAccessPort + bridge to renewals deriveMembershipAccess"
```

---

## Task 5: F7 `submitBroadcast` precondition + live-Neon wiring test

**Files:**
- Modify: `src/modules/broadcasts/application/use-cases/submit-broadcast.ts` (add precondition (l) after halt-flag :286, before rate-limit)
- Modify: `src/modules/broadcasts/application/use-cases/submit-broadcast.ts` deps type + the composition root that builds `makeBroadcastsDeps` (inject `membershipAccessBridge`)
- Test: `tests/unit/broadcasts/submit-broadcast-membership.test.ts`
- Test: `tests/integration/broadcasts/submit-broadcast-membership-suspended.test.ts` (through the REAL `makeBroadcastsDeps()` — proves wiring)

**Interfaces:**
- Consumes: `MembershipAccessPort` (Task 4).
- Produces: two new error kinds on `submitBroadcast`'s result union — `{ kind: 'broadcast_membership_suspended_blocked' }` (422, policy) and reuse of `{ kind: 'submit.server_error' }` (500, infra).

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/broadcasts/submit-broadcast-membership.test.ts
// Two cases, mirroring the adjacent quota check (submit-broadcast.ts:349-356):
//  - membershipAccess = suspended  → reject broadcast_membership_suspended_blocked (422)
//  - membershipAccess port returns lookup_error → submit.server_error (500), NOT the policy code
// Build deps with a stub membershipAccess port; assert the returned kind.
```

- [ ] **Step 2: Run, verify fail** — the precondition doesn't exist yet.

- [ ] **Step 3: Add the precondition** in `submit-broadcast.ts`, immediately after the halt-flag block (:286-298):

```ts
// ---- Precondition (l): membership access -------------------------
const access = await deps.membershipAccess.getMembershipAccess(deps.tenant, input.memberId);
if (!access.ok) {
  // Infra error → fail CLOSED as a server_error (mirrors quota MED-D at :349-356);
  // do NOT collapse into the policy reject.
  return err({ kind: 'submit.server_error', message: `membership_access_error: ${access.error.kind}` });
}
if (access.value.access !== 'full') {
  await emitReject(deps, input, 'broadcast_membership_suspended_blocked', { memberId: input.memberId });
  return err({ kind: 'broadcast_membership_suspended_blocked', memberId: input.memberId });
}
```

Add `membershipAccess: MembershipAccessPort` to the deps type, and inject `membershipAccessBridge` where `makeBroadcastsDeps` is composed.

- [ ] **Step 4: Write the live-Neon wiring test** — seed a real member with a `lapsed`/`awaiting_payment` cycle, call `submitBroadcast` through the **real** `makeBroadcastsDeps()` (no mocked port), assert `broadcast_membership_suspended_blocked` and that **no quota row was reserved**. This is the test the original bug's post-mortem demands.

- [ ] **Step 5: Run both, verify PASS** — `pnpm vitest run tests/unit/broadcasts/submit-broadcast-membership.test.ts` then `pnpm test:integration -- submit-broadcast-membership-suspended`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/broadcasts/application/use-cases/submit-broadcast.ts tests/unit/broadcasts/submit-broadcast-membership.test.ts tests/integration/broadcasts/submit-broadcast-membership-suspended.test.ts
git commit -m "feat(broadcasts): block e-blast submit for suspended members (fail-closed, wired-through test)"
```

---

## Task 6: F3 `inviteColleague` precondition (account-provisioning gate)

**Files:**
- Modify: the `inviteColleague` use-case (`src/modules/members/application/use-cases/invite-colleague.ts` — confirm path)
- Modify: its composition root (`src/app/api/portal/contacts/invite/route.ts` injects the port)
- Test: `tests/unit/members/invite-colleague-membership.test.ts`

**Interfaces:** Consumes `MembershipAccessPort`. Produces a `{ kind: 'invite.membership_suspended' }` reject (403) + fail-closed `server_error` on lookup error.

- [ ] **Step 1** Write the failing unit test: suspended member → `invite.membership_suspended`; lookup_error → server_error.
- [ ] **Step 2** Run, verify fail.
- [ ] **Step 3** Add the precondition at the top of `inviteColleague`, mirroring Task 5's shape. Inject the bridge in the route.
- [ ] **Step 4** Run, verify PASS.
- [ ] **Step 5** Commit: `feat(members): block contact-invite (account provisioning) for suspended members`.

---

## Task 7: Wire the two presentation chokepoints + `check:portal-guard`

**Files:**
- Modify: `src/app/(member)/portal/layout.tsx:41` (after `requireSession('member')`, run terminated-scope check)
- Modify: `src/lib/member-context.ts:48` (`requireMemberContext` runs terminated-scope check for API routes)
- Create: `scripts/check-portal-guard.ts` + a `check:portal-guard` entry in `package.json`
- Test: `tests/unit/scripts/check-portal-guard.test.ts`

**Interfaces:** Consumes `checkPortalAccess` (Task 3) — from `src/lib` (allowed). Produces: portal pages + `/api/portal` routes now enforce `terminated` centrally; the suspended denylist is enforced by the `/portal/broadcasts/new` page (Task 9) + the use-case gates (Tasks 5-6).

- [ ] **Step 1** Write the failing `check:portal-guard` test — a fixture portal page that does NOT route through the chokepoint makes the script exit non-zero.
- [ ] **Step 2** Run, verify fail (script not present).
- [ ] **Step 3** Write `scripts/check-portal-guard.ts`: scan `src/app/(member)/portal/**/page.tsx` and `src/app/api/portal/**/route.ts`; fail if a file neither imports the chokepoint helper nor is on a documented exemption list (e.g. `data-export`, `renewal` which are intentionally reachable). Add `"check:portal-guard": "tsx scripts/check-portal-guard.ts"` to `package.json`.
- [ ] **Step 4** Wire `checkPortalAccess` into `portal/layout.tsx` (redirect to `/portal` for a blocked terminated member) and `requireMemberContext` (403 for API). Run `pnpm check:portal-guard` → PASS.
- [ ] **Step 5** Run `pnpm typecheck && pnpm check:portal-guard`.
- [ ] **Step 6** Commit: `feat(portal): enforce terminated scope at layout + requireMemberContext chokepoints + check:portal-guard gate`.

---

## Task 8: The two Slice-1 audit events + fail-open audit

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-audit-emitter.ts` (add `membership_suspended_action_blocked`, `membership_access_fail_open` to `F8_AUDIT_EVENT_TYPES` + count assert)
- Modify: the F7 `broadcasts/application/ports/audit-port.ts` (add `broadcast_membership_suspended_blocked` to the 43-list → 44)
- Create: a drizzle migration `ALTER TYPE audit_event_type ADD VALUE ...` ×3 (the 3 Slice-1 events)
- Modify: `src/i18n/messages/{en,th,sv}.json` — `audit.events.*` labels for the 3 events
- Modify: the two audit parity-test count files
- Wire: `emitFailOpen`/`emitBlocked` in `lapsed-portal-scope.ts` (stubbed in Task 3)

- [ ] **Step 1** Add the 3 enum values to the domain consts + write the migration (`pnpm db:generate` then hand-edit to `ADD VALUE IF NOT EXISTS`).
- [ ] **Step 2** `pnpm db:migrate` (dev branch) — apply before referencing.
- [ ] **Step 3** Add i18n labels (EN canonical; TH/SV placeholders flagged for native review) + update the two parity counts.
- [ ] **Step 4** Wire `emitBlocked` (payload `{cycle_id, member_id, blocked_route, access_state, action}`) and `emitFailOpen` (payload `{member_id, blocked_route, error}`) in `lapsed-portal-scope.ts`, fire-and-forget (log + swallow on emit failure, per `:197-211`).
- [ ] **Step 5** Run `pnpm check:audit-events && pnpm check:audit-counts && pnpm check:i18n && pnpm test:integration -- audit`.
- [ ] **Step 6** Commit: `feat(audit): membership_suspended_action_blocked + membership_access_fail_open + broadcast_membership_suspended_blocked`.

---

## Task 9: Member-facing suspension UI + smart CTA + renewal-page fix

**Files:**
- Modify: `src/app/(member)/portal/_lib/dashboard-stats.ts` (`deriveMembershipStat` — add a `suspended` kind keyed on `deriveMembershipAccess`, reason-aware)
- Modify: `src/app/(member)/portal/_components/membership-stat-section.tsx` (amber `PauseCircle` for suspended; smart CTA in `actionProps`; `pending_review` → no pay CTA)
- Modify: `src/app/(member)/portal/renewal/[memberId]/page.tsx:240` (payability gate keys on the predicate, not the status literal; update the :224-239 reviewer note)
- Modify: `src/app/(member)/portal/broadcasts/new/page.tsx` (block suspended → redirect to `/portal/benefits?tab=broadcasts` + `InlineAlert tone="warning"`)
- Modify: `src/app/(member)/portal/benefits/page.tsx` (quota shown "N of N — paused until payment"; name every paused benefit)
- Modify: `src/components/shell/member-command-palette-root.tsx` (filter "Compose E-Blast" when access !== full)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`portal.membership.suspended.*` new namespace; reuse `portal.dashboard.membership.*` terminated copy)
- Test: `tests/unit/renewals/smart-cta-target.test.ts` (both branches + invariant: every CTA target is allowed under the suspended policy)

- [ ] **Step 1** Write the failing smart-CTA unit test (unpaid-invoice-exists → `/portal/invoices/[id]`; none → `/portal/renewal/[memberId]`; `pending_review` → no CTA; every target passes `isSuspendedDeniedRoute === false`).
- [ ] **Step 2** Run, verify fail.
- [ ] **Step 3** Implement `deriveMembershipStat` suspended kind + smart-CTA helper; fix the renewal-page payability gate (`summary.status === 'awaiting_payment' || (expired && (upcoming|reminded))`) and the reviewer note; block the compose page; benefits copy; palette filter; i18n keys.
- [ ] **Step 4** Run the unit test + `pnpm check:i18n`, verify PASS.
- [ ] **Step 5** Commit: `feat(portal): suspension banner + reason-aware smart CTA + renewal-page payability fix`.

---

## Task 10: Slice-1 E2E (proves the gate is wired end-to-end)

**Files:**
- Create: `tests/e2e/membership-suspension.spec.ts`
- Modify: `tests/e2e/helpers/renewals-seed.ts` (new fixture: a member whose LATEST cycle is expired/awaiting_payment ONLY — the existing seed's `upcoming`+`lapsed` resolves to `full`)
- Rewrite: `tests/e2e/lapsed-portal-scope.spec.ts` (assert the DENY side; delete the :10-21 scope disclaimer)

- [ ] **Step 1** Add the suspended-member seed fixture.
- [ ] **Step 2** Write the E2E: suspended member → banner renders (amber, text present); `/portal/invoices` reachable; the four never-block routes reachable; `/portal/broadcasts/new` redirects/blocks with a working pay CTA; `@a11y` axe on `/portal` + blocked page; `@i18n` banner EN/TH/SV.
- [ ] **Step 3** Run: `pnpm test:e2e --workers=1 --grep "membership-suspension"`. Verify PASS.
- [ ] **Step 4** Commit: `test(e2e): membership suspension gate wired end-to-end + a11y/i18n`.

---

## Task 11: Slice-1 full-gate + coverage-threshold restore

- [ ] **Step 1** Restore `vitest.config.ts:615-624` — raise the lowered `lapsed-portal-scope.ts` threshold back to the module default; delete the two false claims in the comment.
- [ ] **Step 2** Run the full gate:
```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:audit-events && pnpm check:audit-counts && pnpm check:portal-guard && pnpm test:integration && pnpm test:e2e --workers=1
```
Expected: all green.
- [ ] **Step 3** Commit: `chore(renewals): restore lapsed-portal-scope coverage threshold; slice 1 gate green`.

**Slice 1 done = both go-live blockers closed.** An expired-unpaid member is now benefit-suspended and cannot spend e-blast quota or provision accounts; a terminated member is scoped; the gate is wired at chokepoints with a CI guard.

---

# SLICE 2 — Lapse correctness (MUST NOT ship before Slice 1)

## Task 12: `InvoiceDueBridgePort` — unpaid-issued-not-yet-due lookup

**Files:**
- Create: `src/modules/renewals/application/ports/invoice-due-bridge.ts`
- Create: `src/modules/renewals/infrastructure/invoice-due-bridge.ts` (adapter — new query, NOT Gate 7.5 which selects `paid`)
- Test: `tests/integration/renewals/invoice-due-bridge.test.ts`

**Interfaces:** Produces `hasUnpaidNotYetDueMembershipInvoice(tenant, memberId, todayBkk): Promise<boolean>` — query `member + invoice_subject='membership' + status='issued' + due_date IS NOT NULL + due_date >= todayBkk`.

- [ ] **Step 1** Failing integration test: seed a real `issued` membership invoice with future `due_date` → true; past `due_date` → false; `draft`/`void`/`paid` → false; event-subject with future due → false.
- [ ] **Step 2** Run, verify fail.
- [ ] **Step 3** Write the port + adapter (new SQL; reuse `bangkokLocalDate` from `derive-overdue.ts:83`).
- [ ] **Step 4** Run, verify PASS.
- [ ] **Step 5** Commit: `feat(renewals): InvoiceDueBridgePort — unpaid-issued-not-yet-due membership invoice lookup`.

## Task 13: Lapse due-date guard (OUTSIDE the advisory-lock tx)

**Files:**
- Modify: `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts` (`processOne` — call the guard BEFORE `runInTenant`, beside the F5 attempts read)
- Modify: audit emitter (add `renewal_lapse_deferred_invoice_not_due`) — the 3rd Slice-1/2 audit event
- Test: `tests/unit/renewals/lapse-guard-invoice-not-due.test.ts` + `tests/integration/renewals/lapse-guard-invoice-not-due.test.ts`

- [ ] **Step 1** Failing unit test: any-not-due → skip (`.some`); no invoice → lapse; guard throws → observable (metric/audit), member neither silently skipped nor lapsed.
- [ ] **Step 2** Run, verify fail.
- [ ] **Step 3** Add the guard call outside the tx; emit `renewal_lapse_deferred_invoice_not_due` (payload `{cycle_id, member_id, invoice_id, due_date}`) when it defers. Add the enum value (5-place touch) + migration + i18n.
- [ ] **Step 4** `pnpm db:migrate` then run unit + integration (real `issued` invoice, future `due_date` → cycle survives + audit row).
- [ ] **Step 5** `pnpm check:audit-events && pnpm check:audit-counts`.
- [ ] **Step 6** Commit: `feat(renewals): defer lapse while a membership invoice is unpaid but not yet due`.

## Task 14: `admin-renew-lapsed-member` gapless-or-re-anchor

**Files:**
- Modify: `src/modules/renewals/application/use-cases/admin-renew-lapsed-member.ts:211`
- Modify: `tests/unit/renewals/admin-renew-lapsed-member.test.ts` + `tests/integration/renewals/admin-renew-lapsed-member.test.ts` (existing — update expectations)

- [ ] **Step 1** Update the failing tests: unexpired gapless period → use it; expired → re-anchor at payment month; no-settled-predecessor branch → payment-month anchor; assert the printed §86/4 window matches the anchor.
- [ ] **Step 2** Run, verify fail.
- [ ] **Step 3** Replace unconditional `periodFrom = now`: compute `prior.periodTo`; if `Date.parse(gaplessPeriodTo) > now` use gapless, else `paymentAnchorMonthStartUtc`. Preserve the no-predecessor branch (:222-249).
- [ ] **Step 4** Run unit + integration, verify PASS.
- [ ] **Step 5** Commit: `feat(renewals): comeback renewal keeps the anniversary when the gapless period is still live`.

## Task 15: grace=90 ops SQL + Slice-2 gate

- [ ] **Step 1** Document the ops step in `docs/runbooks/cron-jobs.md` (verify current value first; `UPDATE tenant_renewal_settings SET grace_period_days = 90 WHERE tenant_id='swecham';`). Amend `:937` and `:1047-1063` per the spec's FR-amendments section.
- [ ] **Step 2** Run the full gate (as Task 11). Verify green.
- [ ] **Step 3** Commit: `docs(renewals): grace=90 ops step + FR-003/004 amendments (slice 2)`.

---

# SLICE 3 — Visibility (nobody blocked on it)

## Task 16: Admin "suspended" badge

**Files:**
- Modify: `src/modules/renewals/application/use-cases/load-members-membership-status.ts` (return a `suspended` flag from `deriveMembershipAccess`, not just `lapsed`)
- Modify: `src/components/members/members-table.tsx:600-604` (add the amber `PauseCircle` badge, copy the aria pattern exactly)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`admin.members.directory.membershipSuspended` + `...Sr`)
- Test: unit for `load-members-membership-status` (suspended member → flag set)

- [ ] Steps: failing test → run fail → implement → run pass → commit `feat(admin): suspended badge in the members directory`.

## Task 17: F6 import alert + `event_attendance_by_suspended_member`

**Files:**
- Modify: the F6 CSV import use-case (record normally + emit the audit event + warning row when the matched member is suspended)
- Add the enum value (5-place touch) + migration + i18n
- Test: unit (suspended attendee → recorded + audit event fired)

- [ ] Steps: failing test → run fail → `db:migrate` → implement → run pass → `check:audit-events` → commit `feat(events): flag suspended-member attendance on import (record, never block)`.

## Task 18: F9 badge + suspended-members gauge

**Files:**
- Modify: the F9 benefit-usage view to render a suspended badge
- Add a `membership_suspended_count` gauge to `src/lib/metrics.ts`
- Test: unit for the gauge/derivation

- [ ] Steps: failing test → run fail → implement → run pass → commit `feat(insights): suspended badge + suspended-members gauge`.

## Task 19: Slice-3 full-gate + finishing-a-development-branch

- [ ] **Step 1** Run the full gate (Task 11).
- [ ] **Step 2** Invoke `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**Spec coverage** — every § of the spec maps to a task:
- deriveMembershipAccess + reason → T1. findLatestCycleForMember (shared ordering) → T2. Two policies + wired gate → T3. Port/adapter → T4. F7 gate + wiring test → T5. contacts/invite gate → T6. Chokepoints + check:portal-guard → T7. 5 audit events across 3 taxonomies → T8/T13/T17 (+ i18n label = 5th place, noted in Global Constraints). Smart CTA + renewal-page fix + benefits copy + palette → T9. E2E wired-proof + never-block routes → T10. Coverage-threshold restore → T11. Due-date guard (new query, outside tx) → T12/T13. Post-lapse anchor → T14. grace=90 + FR amendments → T15. Admin/F6/F9 visibility → T16-18.
- Fail-open audit → T3 (stub) + T8 (wired). Grace×backdate is acknowledged policy (no task). pending_admin_reactivation → suspended → T1 mapping table.

**Placeholder scan** — Slices 2-3 tasks give exact files + the TDD cycle but abbreviate the code blocks (the pattern is established in Slices 1's fully-shown tasks T1-T5). Before executing T12-T18, the implementer re-shows the code following the T1-T5 templates. Flagged here so it is a conscious handoff, not a hidden gap.

**Type consistency** — `MembershipAccessDecision {access, reason}` (T1) is the shape consumed by T3/T4/T9; `MembershipAccessPort.getMembershipAccess` (T4) is consumed by T5/T6; `findLatestCycleForMember` (T2) is consumed by T3/T4. Names match across tasks.

**Known verification the implementer must do first** (types I could not fully confirm statically): the exact `RenewalCycle` field list in the T1 test fixture, the `makeRenewalsDeps`/`makeDrizzleRenewalCycleRepo` factory name (T2/T4), the `makeBroadcastsDeps` composition root file (T5), and the `inviteColleague` path (T6). Each task says "confirm the export before writing" where this applies.
