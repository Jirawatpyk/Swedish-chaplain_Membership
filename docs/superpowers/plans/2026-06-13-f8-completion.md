# F8-Completion — Renewal-Flow Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Source spec:** `docs/superpowers/specs/2026-06-13-f8-completion-design.md` (v2). Read it before starting any slice — this plan is the executable form of that spec's decisions.
>
> **Execution convention (this repo):** dispatch project subagents from `.claude/agents` (software-engineer to implement; senior-tester / spec-compliance-auditor / chamber-os-qa-engineer + domain specialists drizzle-migration-reviewer / thai-tax-compliance-auditor / security-engineer / reliability-guardian to review). Dispatch **sequentially** (shared git index — no concurrent committers). Branch base: cut a fresh `068-f8-completion` (or per-slice branches `068a`/`068b`/…) off `main`. Do NOT commit on `main`.

**Goal:** Make the F8 renewal pipeline work end-to-end in production for the SweCham launch — a member can renew, a lapsed member can come back, an operator can run the launch sequence to completion — by wiring the unconnected F4↔F8 boundaries (cycle creation, →awaiting_payment transition, frozen-price billing, portal gate, admin lapsed-comeback) and making the cycle state machine authoritative.

**Architecture:** Four sequential slices. **Slice 0** makes the state machine authoritative (complete the `TRANSITIONS` map, then enforce it; remove the dead `'grace'` arm). **Slice 1** makes cycles *exist* (a shared `createCycleInTx` helper consumed by an on-paid steady-state callback, the member import, and a new `createMember` onboarding listener) and bills the **frozen** price on the §86/4 tax invoice. **Slice 2** makes cycles *payable* (a T-0 expiry cron + a lazy confirm-transition, both to `awaiting_payment`, plus the portal payability gate). **Slice 3** gives admins a reachable lapsed-comeback action (create a fresh `awaiting_payment` cycle + §86/4). The `pending_admin_reactivation` money-hold reactivate/reject routes are **deferred post-launch** (design retained, not built).

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 App Router · Drizzle ORM + Neon Postgres (RLS via `runInTenant`) · Vitest (unit + live-Neon integration) · Playwright + axe (E2E) · `pg_advisory_xact_lock` per-cycle serialisation · F4 invoicing (react-pdf §86/4) · F5 Stripe bridge.

**Constitution gates:** Principle I (two-layer tenant isolation — every new writer + route + the import gets a cross-tenant integration test) · Principle II (TDD — failing test first) · Principle III (Clean Architecture — Domain/Application/Infrastructure boundaries; no leak) · Principle IV (PCI — no card data touched; refund path is deferred) · Slice 3 + the frozen-price tax fix are security/tax-sensitive → ≥2 reviewers, one signs the security/tax checklist.

---

## File Structure (what each slice touches)

**Slice 0 — state machine authoritative (presentation-free, zero behavioural risk):**
- Modify: `src/modules/renewals/domain/value-objects/cycle-status.ts` (add 2 edges + `InvalidCycleTransitionError`; doc terminal split)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (enforce `assertCanTransition` in `transitionStatus`)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts:258` (drop `'grace'`)
- Modify: `docs/data-model` / spec note for the terminal-state divergence
- Test: `tests/unit/renewals/domain/cycle-status.test.ts`, `tests/integration/renewals/transition-status-enforcement.test.ts`

**Slice 1 — cycles exist + frozen-price tax fix + import cold-start:**
- Create: `src/modules/renewals/application/use-cases/create-cycle-in-tx.ts` (the shared helper)
- Create: `src/modules/renewals/application/use-cases/create-next-cycle-on-paid.ts`
- Create: `src/modules/renewals/infrastructure/ports-adapters/f8-on-create-member-callbacks.ts` (onboarding listener factory)
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` + `.../drizzle/drizzle-renewal-cycle-repo.ts` (add `findActiveForMemberInTx`)
- Modify: `src/modules/renewals/infrastructure/renewals-deps.ts:489` (add callback[2])
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` (MOVE `renewal_cycle_created` deferred→shipped)
- Modify: `src/modules/members/application/use-cases/create-member.ts` (+ `onboardingListeners` post-commit) + `src/app/api/members/route.ts` (wire factory)
- Modify (tax): `src/modules/renewals/application/ports/f4-invoicing-bridge.ts` + `.../ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts` + `src/modules/renewals/application/use-cases/confirm-renewal.ts:273` (thread `frozenPlanPriceThb`) + `src/modules/invoicing/application/use-cases/create-invoice-draft.ts` (renewal-signal contract) + reuse `cycleFrozenPriceSatang` (`src/modules/renewals/domain/renewal-cycle.ts:254`)
- Modify (import): `scripts/import-members.ts` (+ per-member `createCycleInTx`) + `docs/member-import-spec.md` (§5/§8)
- Tests: unit (`create-cycle-in-tx`, `create-next-cycle-on-paid`, `create-member` listener) + integration (frozen-price 3-assertion, confirm-with-plan-change, reg-fee suppression, first-delivery creation, concurrent dual-writer, import cold-start, cross-tenant)

**Slice 2 — cycles payable + portal gate:**
- Create: `drizzle/migrations/0XXX_f8_renewal_entered_awaiting_payment.sql` (`ALTER TYPE … ADD VALUE`)
- Create: `src/modules/renewals/application/use-cases/enter-awaiting-payment-on-expiry.ts`
- Create: `src/app/api/cron/renewals/enter-awaiting-payment/[tenantId]/route.ts` + `.../enter-awaiting-payment-coordinator/route.ts`
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` + adapter (`listCyclesEligibleForAwaitingPayment`)
- Modify: `src/modules/renewals/application/use-cases/confirm-renewal.ts:140,182` (Step-1 lock + lazy transition)
- Modify: `src/modules/renewals/application/ports/renewal-audit-emitter.ts` (+`renewal_entered_awaiting_payment` tuple 64→65 + payload + `source` discriminator) + 2 count test files
- Modify: `src/app/(member)/portal/renewal/[memberId]/page.tsx:216` (G4 gate) + `src/i18n/messages/{en,th,sv}.json`
- Modify: `docs/runbooks/cron-jobs.md`
- Tests: unit + integration (flip + lapse sees it + convergence) + E2E (G4)

**Slice 3 — admin lapsed-comeback (reachable fresh-cycle path):**
- Create: `src/modules/renewals/application/use-cases/admin-renew-lapsed-member.ts` (fresh cycle via `createCycleInTx` + F4 §86/4)
- Create: `src/app/api/admin/members/[memberId]/renew/route.ts` + a client action component
- Modify: the admin member detail/lapsed surface to expose the action + `src/i18n/messages/{en,th,sv}.json`
- Tests: unit + integration (fresh cycle + invoice + cross-tenant) + E2E (admin lapsed-comeback)

---

# Slice 0 — State machine authoritative

> Ship first. Disjoint from Slice 1 (can run a parallel branch). Zero behavioural risk; makes the state machine authoritative *before* new writers land on it. **Ordering inside the slice is load-bearing: complete the map (0.2) BEFORE enforcing it (0.3)** — both undeclared edges are live money/timeout paths that would abort a payment tx if enforcement landed first.

### Task 0.1 — G6: remove the dead `'grace'` status literal

**Files:**
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts:255-262`
- Test: `tests/integration/renewals/dispatch-candidate-repo.test.ts` (existing — extend, or characterization)

- [ ] **Step 1: Write/extend a characterization test** asserting the dispatch-candidate query returns the same rows with the `'grace'` literal removed (a cycle whose `expires_at` is in the post-expiry grace window is still included via the date filter, NOT the status filter).

```typescript
// tests/integration/renewals/dispatch-candidate-repo.test.ts
it('includes a post-expiry grace-window cycle via the date filter, not a grace status', async () => {
  // Seed an `awaiting_payment` cycle with expires_at = now - 5 days (inside grace).
  // listDispatchCandidates({ cutoffExpiresAt: now+90d, maxOffsetDays: 30 }) MUST include it.
  const page = await repo.listDispatchCandidates(tenantId, { cutoffExpiresAt, maxOffsetDays: 30 });
  expect(page.items.map((c) => c.cycleId)).toContain(graceWindowCycleId);
});
```

- [ ] **Step 2: Run it — expect PASS** (the date window already includes grace rows; this pins behaviour before the edit). `pnpm vitest run tests/integration/renewals/dispatch-candidate-repo.test.ts`

- [ ] **Step 3: Remove the literal + fix the comment.** At `drizzle-dispatch-candidate-repo.ts:258` change:
```typescript
// BEFORE
sql`${renewalCycles.status} IN ('upcoming','reminded','awaiting_payment','grace')`,
// AFTER
sql`${renewalCycles.status} IN ('upcoming','reminded','awaiting_payment')`,
```
and fix the comment at lines 255-256 to state grace inclusion is achieved by the `expires_at >= NOW() - (maxOffsetDays * INTERVAL '1 day')` window, not a `'grace'` status (no DB row can ever hold `'grace'` — the `0087` CHECK + `CYCLE_STATUSES` reject it). Cross-check `drizzle-renewal-cycle-repo.ts:808` is already correct (it is).

- [ ] **Step 4: Run the test — expect PASS** (unchanged behaviour). `pnpm vitest run tests/integration/renewals/dispatch-candidate-repo.test.ts`

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts tests/integration/renewals/dispatch-candidate-repo.test.ts
git commit -m "fix(renewals): remove dead 'grace' status literal from dispatch-candidate filter (G6 / F8-completion slice 0)"
```

### Task 0.2 — G5a: complete the `TRANSITIONS` map (the 2 missing edges)

**Files:**
- Modify: `src/modules/renewals/domain/value-objects/cycle-status.ts:87-103`
- Test: `tests/unit/renewals/domain/cycle-status.test.ts`

The map currently (verbatim) is missing two edges real writers use: `upcoming → completed` (offline-mark of an `upcoming` cycle via `mark-paid-offline.ts`, whose `PAYABLE_STATUSES = {'awaiting_payment','upcoming'}`) and `pending_admin_reactivation → lapsed` (reconcile-timeout via `reconcile-pending-reactivations.ts`).

- [ ] **Step 1: Write the failing unit test.**
```typescript
// tests/unit/renewals/domain/cycle-status.test.ts
import { canTransition } from '@/modules/renewals/domain/value-objects/cycle-status';

it('allows upcoming → completed (offline-mark of an upcoming cycle)', () => {
  expect(canTransition('upcoming', 'completed')).toBe(true);
});
it('allows pending_admin_reactivation → lapsed (reconcile-timeout)', () => {
  expect(canTransition('pending_admin_reactivation', 'lapsed')).toBe(true);
});
it('still rejects a nonsense edge (completed → upcoming)', () => {
  expect(canTransition('completed', 'upcoming')).toBe(false);
});
it('still rejects upcoming → pending_admin_reactivation', () => {
  expect(canTransition('upcoming', 'pending_admin_reactivation')).toBe(false);
});
```

- [ ] **Step 2: Run — expect the first two FAIL.** `pnpm vitest run tests/unit/renewals/domain/cycle-status.test.ts`

- [ ] **Step 3: Add the two edges.** In `cycle-status.ts` `TRANSITIONS`:
```typescript
const TRANSITIONS: Record<CycleStatus, readonly CycleStatus[]> = {
  upcoming: ['reminded', 'awaiting_payment', 'completed', 'cancelled'], // +completed (offline-mark of upcoming)
  reminded: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['completed', 'lapsed', 'pending_admin_reactivation', 'cancelled'],
  pending_admin_reactivation: ['completed', 'cancelled', 'lapsed'], // +lapsed (reconcile-timeout)
  lapsed: ['awaiting_payment', 'pending_admin_reactivation'],
  completed: [],
  cancelled: [],
};
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run tests/unit/renewals/domain/cycle-status.test.ts`

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/domain/value-objects/cycle-status.ts tests/unit/renewals/domain/cycle-status.test.ts
git commit -m "feat(renewals): declare upcoming→completed + pending→lapsed edges in TRANSITIONS map (G5a / slice 0)"
```

### Task 0.3 — G5b: enforce `assertCanTransition` in `transitionStatus`

**Files:**
- Modify: `src/modules/renewals/domain/value-objects/cycle-status.ts` (add `InvalidCycleTransitionError` class)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts:727` (unwrap + throw before building setClause)
- Test: `tests/integration/renewals/transition-status-enforcement.test.ts` (live Neon — **HARD GATE**)

`assertCanTransition` returns a `Result` (does NOT throw). `transitionStatus` must unwrap it and throw a domain-mapped error on the err branch — placed **before** the optimistic CAS `WHERE status = from` runs.

- [ ] **Step 1: Add the error class** to `cycle-status.ts` (next to `CycleTransitionConflictError` / `CycleNotFoundError`):
```typescript
export class InvalidCycleTransitionError extends Error {
  constructor(
    readonly from: CycleStatus,
    readonly to: CycleStatus,
  ) {
    super(`Invalid cycle transition: ${from} → ${to} is not a declared edge`);
    this.name = 'InvalidCycleTransitionError';
  }
}
```

- [ ] **Step 2: Write the failing integration test (HARD GATE — derive edges by exercising real use-cases).**
```typescript
// tests/integration/renewals/transition-status-enforcement.test.ts
// The 6 REAL edges MUST be derived by driving each use-case and observing the
// edge it produces — NOT a re-typed literal of TRANSITIONS (a re-typed list
// would pass even if the map and the live writers diverged).
it('every real cycle edge passes through the now-enforcing transitionStatus', async () => {
  // Drive: confirm-renewal (awaiting→completed via mark-complete), lapse-cron
  // (awaiting→lapsed), cancel (upcoming→cancelled / awaiting→cancelled),
  // mark-paid-offline (upcoming→completed), reconcile-timeout
  // (pending→lapsed), enter-awaiting (upcoming→awaiting — Slice 2; stub here).
  // Assert none throw InvalidCycleTransitionError.
});
it('an illegal edge throws InvalidCycleTransitionError before the CAS', async () => {
  await expect(
    repo /* in a tx */.transitionStatus(tx, tenantId, cycleId, { from: 'completed', to: 'upcoming' }),
  ).rejects.toBeInstanceOf(InvalidCycleTransitionError);
});
it('cancel-of-lapsed is rejected by the domain ahead of the repo call', () => {
  // canTransition('lapsed','cancelled') === false → the use-case rejects
  // before transitionStatus is ever invoked.
  expect(canTransition('lapsed', 'cancelled')).toBe(false);
});
```

- [ ] **Step 3: Run — expect the illegal-edge test FAILs** (no enforcement yet; today it falls through to the CAS and throws `CycleNotFoundError`/conflict, not `InvalidCycleTransitionError`). `pnpm vitest run tests/integration/renewals/transition-status-enforcement.test.ts` (config `vitest.integration.config.ts`).

- [ ] **Step 4: Enforce in `transitionStatus`.** At `drizzle-renewal-cycle-repo.ts:727` (top of the method, before `const setClause`):
```typescript
const guard = assertCanTransition(args.from, args.to);
if (!guard.ok) {
  throw new InvalidCycleTransitionError(args.from, args.to);
}
const txDb = tx as typeof db;
const setClause: Record<string, unknown> = { status: args.to };
// … unchanged …
```
Import `assertCanTransition` + `InvalidCycleTransitionError` from the domain VO. Keep the existing CAS + probe logic intact (defense-in-depth: domain edge check first, optimistic concurrency second).

- [ ] **Step 5: Run — expect PASS** (all 6 real edges pass; illegal throws). `pnpm vitest run tests/integration/renewals/transition-status-enforcement.test.ts`

- [ ] **Step 6: Run the full renewals integration suite** to prove no live writer regressed (this is why 0.2 precedes 0.3): `pnpm test:integration -- renewals`

- [ ] **Step 7: Commit.**
```bash
git add src/modules/renewals/domain/value-objects/cycle-status.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts tests/integration/renewals/transition-status-enforcement.test.ts
git commit -m "feat(renewals): enforce assertCanTransition in transitionStatus (G5b / slice 0)"
```

### Task 0.4 — Document the terminal-state divergence

**Files:**
- Modify: `src/modules/renewals/domain/value-objects/cycle-status.ts` (comment) + `docs/data-model` (the renewals data-model doc)

- [ ] **Step 1: Add an explanatory comment** at the `TRANSITIONS` map (and a paragraph in the data-model doc) stating reject→`cancelled` (explicit refusal, leaves the re-engagement funnel) vs timeout→`lapsed` (passive expiry, stays in it) is **intentional and must NOT be converged** — converging shifts members between at-risk/lapsed reporting buckets (`drizzle-renewal-cycle-repo.ts:347` short-circuits urgency on `status='lapsed'`).

- [ ] **Step 2: Commit (doc-only).**
```bash
git add src/modules/renewals/domain/value-objects/cycle-status.ts docs/
git commit -m "docs(renewals): document intentional terminal-state divergence (cancelled vs lapsed) (slice 0)"
```

---

# Slice 1 — Make cycles exist + frozen-price tax fix + import cold-start

> Depends on Slice 0 (the state machine must be authoritative before writers land). The shared `createCycleInTx` helper is the single source of cycle-creation truth — every creation entry point consumes it, none forks a parallel creator.

### Task 1.1 — Add `findActiveForMemberInTx` (in-tx-visible idempotency guard)

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (port decl, mirror `findByIdInTx` @ ~94)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (adapter, mirror `findByIdInTx` body — **NO `runInTenant`**, the caller holds the tenant-scoped tx)
- Test: `tests/integration/renewals/find-active-for-member-in-tx.test.ts`

**Why (the happy-path-DEAD bug it prevents):** F4 fires `f8OnPaidCallbacks` BEFORE `withTx` commits, so callback[0]'s prior-cycle `→completed` flip is still uncommitted when callback[2] runs. The connection-fresh `findActiveForMember` (opens its own `runInTenant`) cannot see that uncommitted flip under READ COMMITTED → it still sees the prior cycle as active → callback[2] no-ops → the next cycle is NEVER created. Threading F4's `tx` lets the guard see the in-flight completion.

- [ ] **Step 1: Write the failing integration test** — inside one `runInTenant` tx: insert an active cycle, then `findActiveForMemberInTx(tx, tenantId, memberId)` returns it; transition it to `completed` **in the same tx**, then `findActiveForMemberInTx` returns `null` (sees the uncommitted flip). Contrast: a sibling assertion that the connection-fresh `findActiveForMember` would still see it (documents the difference).

- [ ] **Step 2: Run — expect FAIL** (method does not exist).

- [ ] **Step 3: Add the port declaration** (mirror `findByIdInTx`, `renewal-cycle-repo.ts`):
```typescript
/**
 * Same as `findActiveForMember` but accepts the caller's tx handle so the
 * read participates in the surrounding transaction — it can see an
 * uncommitted prior-cycle `→completed` flip made earlier in the SAME tx
 * (e.g. F4 `f8OnPaidCallbacks[0]` before `withTx` commits). The
 * connection-fresh variant CANNOT (READ COMMITTED), which would make the
 * on-paid next-cycle creation no-op on first delivery. Constitution VIII.
 */
findActiveForMemberInTx(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
): Promise<RenewalCycle | null>;
```

- [ ] **Step 4: Add the adapter** (mirror `findByIdInTx`, `drizzle-renewal-cycle-repo.ts`):
```typescript
async findActiveForMemberInTx(
  tx: unknown,
  _tenantId: string,
  memberId: string,
): Promise<RenewalCycle | null> {
  const txDb = tx as typeof db;
  const rows = await txDb
    .select()
    .from(renewalCycles)
    .where(
      and(
        eq(renewalCycles.memberId, memberId),
        sql`${renewalCycles.status} NOT IN ('lapsed','cancelled','completed')`,
      ),
    )
    .limit(1);
  return rows[0] ? rowToDomain(rows[0]) : null;
}
```

- [ ] **Step 5: Run — expect PASS.** `pnpm vitest run tests/integration/renewals/find-active-for-member-in-tx.test.ts` (integration config).

- [ ] **Step 6: Commit.**
```bash
git add src/modules/renewals/application/ports/renewal-cycle-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts tests/integration/renewals/find-active-for-member-in-tx.test.ts
git commit -m "feat(renewals): add findActiveForMemberInTx (in-tx idempotency guard) (slice 1)"
```

### Task 1.2 — Ship `renewal_cycle_created` audit (whitelist MOVE, NO migration)

**Files:**
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts:67,244` (MOVE the literal from `_F8_ENUM_DEFERRED` into `F8_ENUM_SHIPPED_TUPLE`)
- Modify: the 2 count-assertion files (`tests/**/audit-event.test.ts` + `tests/**/completeness.test.ts` — find the F8 count assertions)
- Test: those 2 count files

`renewal_cycle_created` is **already in the pgEnum** (migration `0109`) and already in the `F8_AUDIT_EVENT_TYPES` domain tuple. Shipping it is a **MOVE** (deferred→shipped) + the 2 count files + the emit site (which lands in Task 1.3's `createCycleInTx`). **NO `ALTER TYPE … ADD VALUE` migration.**

- [ ] **Step 1: Bump the failing count assertion(s)** for the shipped-tuple count to include `renewal_cycle_created`. Find them: `grep -rn "renewal_cycle_created\|F8_ENUM_SHIPPED" tests/`. Update the expected count + add the comment line (provenance).

- [ ] **Step 2: Run — expect FAIL** (count mismatch). `pnpm vitest run tests/<the two count files>`

- [ ] **Step 3: MOVE the literal.** In `drizzle-renewal-audit-emitter.ts`: delete `'renewal_cycle_created'` from `_F8_ENUM_DEFERRED` (~244) and add it to `F8_ENUM_SHIPPED_TUPLE` (~67), preserving the `as const satisfies ReadonlyArray<F8AuditEventType>` shape.

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run tests/<the two count files>`

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts tests/
git commit -m "feat(renewals): ship renewal_cycle_created audit (whitelist move, no migration) (slice 1)"
```

### Task 1.3 — Extract the shared `createCycleInTx` helper

**Files:**
- Create: `src/modules/renewals/application/use-cases/create-cycle-in-tx.ts`
- Test: `tests/unit/renewals/create-cycle-in-tx.test.ts`

The single home for all cycle-creation invariants: frozen-price snapshot, in-tx idempotency no-op, gapless period derivation, `renewal_cycle_created` audit emit. **All four creation entry points consume it** (on-paid callback, import cold-start, createMember onboarding listener, Slice-3 admin fresh-cycle).

- [ ] **Step 1: Write failing unit tests** (mock `cyclesRepo`, `planLookup`/`getEffectivePlanForRenewal`, `auditEmitter`):
```typescript
// tests/unit/renewals/create-cycle-in-tx.test.ts
it('no-ops when an active cycle already exists (idempotency)', async () => {
  cyclesRepo.findActiveForMemberInTx.mockResolvedValue(existingCycle);
  const out = await createCycleInTx(deps, tx, { tenantId, memberId, periodFrom, planId });
  expect(out).toEqual({ kind: 'skipped_active_exists' });
  expect(cyclesRepo.insert).not.toHaveBeenCalled();
});
it('derives periodTo = periodFrom + 12 months and freezes the resolved plan price', async () => {
  cyclesRepo.findActiveForMemberInTx.mockResolvedValue(null);
  planLookup.loadPlanFrozenFields.mockResolvedValue({ status: 'found', plan: { tierBucket, priceTHB: '15000.00', termMonths: 12, currency: 'THB' } });
  await createCycleInTx(deps, tx, { tenantId, memberId, periodFrom: '2026-01-01T00:00:00.000Z', planId });
  expect(cyclesRepo.insert).toHaveBeenCalledWith(tx, tenantId, expect.objectContaining({
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2027-01-01T00:00:00.000Z',
    frozenPlanPriceThb: '15000.00',
    frozenPlanTermMonths: 12,
  }));
});
it('emits renewal_cycle_created in the same tx after insert', async () => { /* assert auditEmitter.emitInTx called with type renewal_cycle_created */ });
it('throws when the plan cannot be resolved (caller decides to swallow or roll back)', async () => {
  planLookup.loadPlanFrozenFields.mockResolvedValue({ status: 'not_found' });
  await expect(createCycleInTx(deps, tx, { tenantId, memberId, periodFrom, planId })).rejects.toThrow();
});
```

- [ ] **Step 2: Run — expect FAIL** (file missing).

- [ ] **Step 3: Implement `create-cycle-in-tx.ts`.** Signature + body (uses the extracted facts — `NewRenewalCycleInput` shape, `loadPlanFrozenFields` return, `cyclesRepo.insert(tx, tenantId, input)`):
```typescript
import { addMonths } from '@/lib/dates'; // or js-joda Asia/Bangkok-safe month add; reuse the repo's existing month math
import type { TenantTx } from '@/lib/db';

export interface CreateCycleInTxDeps {
  readonly cyclesRepo: Pick<RenewalCycleRepo, 'findActiveForMemberInTx' | 'insert'>;
  readonly planLookup: PlanLookupForRenewalPort;      // loadPlanFrozenFields
  readonly auditEmitter: RenewalAuditEmitter;          // emitInTx
  readonly idFactory: { cycleId(): CycleId };
}
export interface CreateCycleInTxInput {
  readonly tenantId: string;
  readonly memberId: string;
  /** ISO 8601 UTC anchor. Steady-state: prior.periodTo. Import/onboarding: registration_date. */
  readonly periodFrom: string;
  readonly planId: string;
  /** Audit/observability provenance. */
  readonly source: 'on_paid' | 'import' | 'onboarding' | 'admin_lapsed_comeback';
  readonly actorUserId: string | null;
  readonly actorRole: 'cron' | 'admin' | 'system';
  readonly correlationId: string;
}
export type CreateCycleOutcome =
  | { readonly kind: 'created'; readonly cycle: RenewalCycle }
  | { readonly kind: 'skipped_active_exists' };

export async function createCycleInTx(
  deps: CreateCycleInTxDeps,
  tx: TenantTx,
  input: CreateCycleInTxInput,
): Promise<CreateCycleOutcome> {
  // 1. Idempotency — in-tx-visible guard (NEVER the connection-fresh variant).
  const active = await deps.cyclesRepo.findActiveForMemberInTx(tx, input.tenantId, input.memberId);
  if (active) return { kind: 'skipped_active_exists' };

  // 2. Frozen-price snapshot (12-month THB only for launch).
  const plan = await deps.planLookup.loadPlanFrozenFields({ tenantId: input.tenantId, planId: input.planId });
  if (plan.status !== 'found') {
    throw new Error(`createCycleInTx: plan ${input.planId} not resolvable (${plan.status})`);
  }

  // 3. Gapless period derivation.
  const periodTo = addMonths(input.periodFrom, plan.plan.termMonths); // termMonths === 12

  const cycleId = deps.idFactory.cycleId();
  const newCycle: NewRenewalCycleInput = {
    tenantId: input.tenantId,
    cycleId,
    memberId: input.memberId,
    periodFrom: input.periodFrom,
    periodTo,
    cycleLengthMonths: plan.plan.termMonths,
    tierAtCycleStart: plan.plan.tierBucket,
    planIdAtCycleStart: input.planId,
    frozenPlanPriceThb: plan.plan.priceTHB,     // decimal string e.g. "15000.00"
    frozenPlanTermMonths: plan.plan.termMonths,
  };
  const cycle = await deps.cyclesRepo.insert(tx, input.tenantId, newCycle);

  // 4. Audit in the SAME tx (Principle VIII state↔audit atomicity).
  await deps.auditEmitter.emitInTx(
    tx,
    { type: 'renewal_cycle_created' as const, payload: {
        cycle_id: cycleId, member_id: input.memberId,
        plan_id: input.planId, period_from: input.periodFrom, period_to: periodTo,
        frozen_plan_price_thb: plan.plan.priceTHB, source: input.source,
    } },
    { tenantId: input.tenantId, actorUserId: input.actorUserId, actorRole: input.actorRole, correlationId: input.correlationId },
  );
  return { kind: 'created', cycle };
}
```
> **Note for implementer:** reuse the repo's existing month-add helper for `periodTo` (the repo already derives `periodTo` from `periodFrom + cycleLengthMonths`; do NOT introduce js-joda drift — match the existing arithmetic). Confirm the `renewal_cycle_created` payload shape against `renewal-audit-emitter.ts:261`.

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run tests/unit/renewals/create-cycle-in-tx.test.ts`

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/application/use-cases/create-cycle-in-tx.ts tests/unit/renewals/create-cycle-in-tx.test.ts
git commit -m "feat(renewals): shared createCycleInTx helper (single source of cycle-creation truth) (slice 1)"
```

### Task 1.4 — `create-next-cycle-on-paid` + wire as `f8OnPaidCallbacks[2]`

**Files:**
- Create: `src/modules/renewals/application/use-cases/create-next-cycle-on-paid.ts`
- Modify: `src/modules/renewals/infrastructure/renewals-deps.ts:489` (append callback[2] to the array)
- Test: `tests/unit/renewals/create-next-cycle-on-paid.test.ts` + `tests/integration/renewals/create-next-cycle-on-paid.test.ts`

Thin wrapper over `createCycleInTx`. Resolves the just-paid cycle via `findByInvoiceIdInTx`; `periodFrom = prior.periodTo` (gapless); **THROWS on failure** (atomic with the just-completed payment's F4 tx; Stripe at-least-once retry heals via the idempotency guard).

- [ ] **Step 1: Write failing unit tests** — period math (`periodFrom = prior.periodTo`), no-op when `findByInvoiceIdInTx` returns null, delegates to `createCycleInTx`, **re-throws** on `createCycleInTx` failure (does NOT swallow).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.**
```typescript
// create-next-cycle-on-paid.ts — runs as f8OnPaidCallbacks[2], AFTER callback[0] flips prior→completed.
export async function createNextCycleOnPaidInTx(
  deps: CreateCycleInTxDeps & { cyclesRepo: Pick<RenewalCycleRepo, 'findByInvoiceIdInTx' | 'findActiveForMemberInTx' | 'insert'> },
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<void> {
  const prior = await deps.cyclesRepo.findByInvoiceIdInTx(tx, evt.tenantId, evt.invoiceId);
  if (!prior) return; // not a renewal invoice — no-op
  // periodFrom = prior.periodTo (gapless). createCycleInTx no-ops if an active
  // cycle already exists — but because callback[0] flipped prior→completed in
  // THIS tx, findActiveForMemberInTx (in-tx-visible) correctly excludes it, so
  // the new cycle IS created on first (non-retry) delivery.
  await createCycleInTx(deps, tx, {
    tenantId: evt.tenantId,
    memberId: prior.memberId,
    periodFrom: prior.periodTo,
    planId: prior.planIdAtCycleStart,
    source: 'on_paid',
    actorUserId: null,
    actorRole: 'system',
    correlationId: evt.correlationId ?? `on-paid:${evt.invoiceId}`,
  });
  // THROWS propagate → F4 tx rolls back → Stripe retry heals (idempotent).
}
```

- [ ] **Step 4: Wire callback[2]** in `renewals-deps.ts` `f8OnPaidCallbacks` (the array currently ends at the tier-upgrade callback ~647). Append a 3rd element mirroring callback[0]'s `TenantTx` brand-check + dynamic-import discipline (the `INVALID_TX` precedent at ~547-577 — re-throw on a non-`TenantTx` value, do NOT swallow):
```typescript
return [
  async (evt, txUnknown) => { /* callback[0] markCycleComplete — unchanged */ },
  makeApplyTierUpgradeOnPaidCallback(deps, tenantId),                 // callback[1]
  async (evt, txUnknown) => {                                         // callback[2] NEW
    const { isTenantTx } = await import('@/lib/db');
    if (txUnknown === undefined || !isTenantTx(txUnknown)) {
      // Mirror callback[0]: log INVALID_TX + throw (F4 tx must roll back; a
      // fallback-runInTenant would NOT see callback[0]'s uncommitted completion).
      const { logger } = await import('@/lib/logger');
      logger.error({ errorId: 'F8.ONPAID.CREATE_NEXT.INVALID_TX', tenantId, invoiceId: evt.invoiceId, memberId: evt.memberId }, '[f8-onPaid] create-next-cycle got non-TenantTx — F4 tx must roll back');
      throw new Error('createNextCycleOnPaid: F4 threaded non-TenantTx');
    }
    const { createNextCycleOnPaidInTx } = await import('../application/use-cases/create-next-cycle-on-paid');
    await createNextCycleOnPaidInTx(deps /* shaped */, evt, txUnknown);
  },
];
```
> **Ordering invariant:** callback[2] MUST run after callback[0] (completion). The array order guarantees this (sequential await in F4's callback loop — confirm F4 awaits them in order; if F4 runs them concurrently, the idempotency guard still protects correctness but the first-delivery creation test in Step 6 will catch any ordering break).

- [ ] **Step 5: Run unit — expect PASS.**

- [ ] **Step 6: Write + run the integration test (live Neon, MANDATORY).** Pay a renewal invoice → assert (a) the prior cycle is `completed` AND a NEW `upcoming` cycle exists **on the first webhook delivery** (proves `findActiveForMemberInTx` sees callback[0]'s uncommitted flip); (b) a webhook **retry** does not create a duplicate (idempotency no-op, no constraint violation); (c) extend `f4-callback-rollback.test.ts`: two concurrent writers racing to create the same member's cycle → exactly one succeeds, the loser fails gracefully (constraint no-op / conflict), no orphan, payment not double-rolled.

- [ ] **Step 7: Apply-migration-not-needed check + run integration.** No new migration here (`renewal_cycle_created` shipped in 1.2). `pnpm test:integration -- create-next-cycle-on-paid`.

- [ ] **Step 8: Commit.**
```bash
git add src/modules/renewals/application/use-cases/create-next-cycle-on-paid.ts src/modules/renewals/infrastructure/renewals-deps.ts tests/unit/renewals/create-next-cycle-on-paid.test.ts tests/integration/renewals/create-next-cycle-on-paid.test.ts tests/integration/renewals/f4-callback-rollback.test.ts
git commit -m "feat(renewals): create next cycle on prior-cycle-paid (f8OnPaidCallbacks[2], throws+heals) (slice 1)"
```

### Task 1.5 — Frozen-price §86/4 billing (the tax fix)

**Files:**
- Modify: `src/modules/renewals/application/ports/f4-invoicing-bridge.ts` (+`frozenPlanPriceThb` on `IssueInvoiceForRenewalInput`)
- Modify: `src/modules/renewals/application/use-cases/confirm-renewal.ts:273` (thread `cycleAfterPlanChange.frozenPlanPriceThb`)
- Modify: `src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts:34` (pass the renewal signal)
- Modify: `src/modules/invoicing/application/use-cases/create-invoice-draft.ts` (renewal-signal input contract)
- Reuse: `cycleFrozenPriceSatang` (`src/modules/renewals/domain/renewal-cycle.ts:254`) — the existing safe THB-decimal→satang integer parser (split on `.`, no float)
- Test: `tests/integration/invoicing/frozen-price.test.ts` (expand to 3-assertion) + `tests/integration/renewals/confirm-with-plan-change.test.ts` + `tests/integration/invoicing/renewal-regfee-suppression.test.ts`

> **This is an input-CONTRACT change to `createInvoiceDraft`, reviewed as such. Tax-sensitive → thai-tax-compliance-auditor + ≥2 reviewers (one signs the tax checklist).**
>
> **VAT-EXCLUSIVE WARNING:** the membership `unitPriceSatang` override is the **VAT-exclusive** unit price (VAT 7% added on top at issue via `calculateVat`). This is **opposite** to the event-path `amountOverride` (VAT-INCLUSIVE, `vatInclusive: true`). Copying event semantics is a 7%-wrong total. Membership stays `vatInclusive: false`.

- [ ] **Step 1: Write the failing 3-assertion integration test** (expand `frozen-price.test.ts`):
```typescript
it('bills the cycle frozen price on the issued §86/4, VAT-exclusive, non-zero satang', async () => {
  // Create a cycle frozen at '50000.50' THB. Then BUMP the F2 plan catalogue price.
  // Confirm the renewal → issue the §86/4.
  expect(membershipLineSubtotalSatang).toBe(5000050n);          // (1) frozen × 100, VAT-EXCLUSIVE
  expect(issuedGrandTotalSatang).toBe(5000050n + 350003n);      // (2) frozen×100×1.07 (VAT 7% on top); use the exact calculateVat rounding
  // (3) non-zero satang ('50000.50') surfaces parse/round bugs — already exercised.
});
```
> Compute the exact expected grand total with the project's `calculateVat` rounding (round-half-away on the 7% of 5000050 satang) — do NOT hardcode `350003` without verifying against `calculateVat(5000050, vatRate)`.

- [ ] **Step 2: Run — expect FAIL** (today it bills the live bumped price).

- [ ] **Step 3: Thread the frozen price.** (a) Add to `IssueInvoiceForRenewalInput`:
```typescript
/** FR-022 — the cycle's frozen membership price (decimal THB string, e.g. "50000.50"),
 *  VAT-EXCLUSIVE. Server-sourced from the cycle row — NEVER a request body. */
readonly frozenPlanPriceThb: string;
```
(b) In `confirm-renewal.ts:273`, pass `frozenPlanPriceThb: cycleAfterPlanChange.frozenPlanPriceThb` into `issueInvoiceForRenewal(...)` (the value is already in scope — Task fact-extract confirmed `cycleAfterPlanChange` carries it). (c) In the drizzle bridge adapter, pass a NEW renewal-signal object into `createInvoiceDraft`.

- [ ] **Step 4: Add the renewal-signal contract to `createInvoiceDraft`.** Extend `createInvoiceDraftSchema` / `CreateInvoiceDraftInput` with an optional `renewalSignal`:
```typescript
renewalSignal: z.object({
  // VAT-EXCLUSIVE membership unit price in satang, parsed server-side from
  // the cycle's frozen decimal-THB string via cycleFrozenPriceSatang.
  unitPriceSatang: z.bigint(), // or a branded Satang — match the project's type
}).optional(),
```
Behaviour when `renewalSignal` is set: **force `proRateFactor = '1.0000'`** (skip the `calculateProRateFactor` derivation at ~161-170), **suppress the `registration_fee` re-bill** (skip the `!member.registrationFeePaid` branch at ~205), and **use `renewalSignal.unitPriceSatang`** as the membership line `unitPrice` (instead of `getAnnualFeeSatang`):
```typescript
const isRenewal = input.renewalSignal !== undefined;
const proRateFactor = isRenewal ? '1.0000' : calculateProRateFactor({ /* … */ });
const membershipUnitPrice = isRenewal
  ? Money.fromSatangUnsafe(input.renewalSignal.unitPriceSatang)
  : Money.fromSatangUnsafe(planFee);
// … membership line uses membershipUnitPrice …
// reg-fee block: `if (!isRenewal && !member.registrationFeePaid && registrationFeeSatang > 0n) { … }`
```
In the bridge adapter, compute `unitPriceSatang` from the frozen string with the **existing** parser (do NOT write a new one, do NOT `parseFloat`):
```typescript
import { cycleFrozenPriceSatang } from '@/modules/renewals'; // or extract its core to @/lib/money as parseThbDecimalToSatang
// adapter holds frozenPlanPriceThb string → unitPriceSatang = parseThbDecimalToSatang(frozenPlanPriceThb)
```
> **Implementer decision:** `cycleFrozenPriceSatang` takes a `RenewalCycle`. Either (a) pass the whole cycle through the bridge, or (b) **extract its 4-line core** into `parseThbDecimalToSatang(thb: string): bigint` in `@/lib/money.ts` and call it from both `cycleFrozenPriceSatang` and the bridge. Prefer (b) — one shared parser, both sites covered, no duplication. Keep `VALID_FROZEN_PRICE_RE` validation.

- [ ] **Step 5: Run the 3-assertion test — expect PASS.**

- [ ] **Step 6: Write + run the confirm-with-plan-change test (B6).** Confirm a renewal with a `newPlanId` → `updateFrozenPlan` re-snapshots to a higher-priced plan; bump BOTH plans' catalogue price; assert the invoice bills the **NEW plan's frozen value** (not old frozen, not either live price).

- [ ] **Step 7: Write + run the reg-fee suppression + pro-rate test.** A renewal of an existing member with `registrationFeePaid=false` does NOT add a `registration_fee` line AND `proRateFactor == '1.0000'`.

- [ ] **Step 8: Run the full invoicing + renewals integration suites.** `pnpm test:integration -- invoicing renewals` (the override sits inside the F4 paid/issue path — mocks hide §87/VAT bugs).

- [ ] **Step 9: Commit.**
```bash
git add src/modules/renewals/application/ports/f4-invoicing-bridge.ts src/modules/renewals/application/use-cases/confirm-renewal.ts src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts src/modules/invoicing/application/use-cases/create-invoice-draft.ts src/lib/money.ts src/modules/renewals/domain/renewal-cycle.ts tests/integration/invoicing/frozen-price.test.ts tests/integration/renewals/confirm-with-plan-change.test.ts tests/integration/invoicing/renewal-regfee-suppression.test.ts
git commit -m "fix(invoicing): bill cycle frozen price on §86/4 renewal invoice (FR-022, VAT-exclusive override) (slice 1)"
```

### Task 1.6 — `createMember` onboarding listener (post-launch new-member arm)

**Files:**
- Modify: `src/modules/members/application/use-cases/create-member.ts` (+`onboardingListeners` to `CreateMemberDeps`, post-commit invoke)
- Create: `src/modules/renewals/infrastructure/ports-adapters/f8-on-create-member-callbacks.ts` (factory mirroring `f8OnManualPlanChangeCallbacks`)
- Modify: `src/app/api/members/route.ts` (wire the factory into `buildMembersDeps` for the create path)
- Test: `tests/unit/members/create-member-onboarding-listener.test.ts`

`createMember` has **no** listener mechanism today (confirmed). Add one mirroring `change-plan.ts:378-424` (post-commit, per-listener try/catch, OTel-count on throw, never fails the use-case). This is the **post-launch onboarding** arm only — NOT the initial cohort (that's the import, Task 1.7).

- [ ] **Step 1: Write failing unit tests** — listener invoked post-commit with the new member's id; a throwing listener is swallowed (use-case still returns `ok`) + an OTel counter increments; no listener → unchanged behaviour.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the mechanism to `create-member.ts`.** Add to `CreateMemberDeps`:
```typescript
/** F8-completion — post-commit best-effort listeners (e.g. create the member's
 *  initial renewal cycle). Mirror change-plan's manualPlanChangeListeners: each
 *  runs in its OWN tenant tx (the listener opens it), failures are logged +
 *  counted, NEVER roll back the member create. Optional. */
onboardingListeners?: ReadonlyArray<(evt: CreateMemberListenerEvent) => Promise<void>>;
```
Define `CreateMemberListenerEvent = { tenantId; memberId; registrationDate; planId; correlationId }`. After the `runInTenant` returns `created` (and before `return ok(...)`), invoke (verbatim shape from `change-plan.ts:404-424`):
```typescript
const listeners = deps.onboardingListeners ?? [];
for (const listener of listeners) {
  try {
    await listener({ tenantId: deps.tenant.slug, memberId: created.member.memberId, registrationDate: created.member.registrationDate, planId: created.member.planId, correlationId: meta.requestId });
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e), tenantId: deps.tenant.slug, memberId: created.member.memberId }, '[create-member] post-commit onboardingListener threw — member already committed; ignored');
    renewalsMetrics?.bootstrapCycleCreateFailed?.add?.(1, { tenant_id: deps.tenant.slug }); // OTel counter (Task 1.8)
  }
}
```

- [ ] **Step 4: Create the factory** `f8OnCreateMemberCallbacks(tenantId)` (mirror `f8OnManualPlanChangeCallbacks` at `f2-plan-change-bridge.ts:164`): returns a single listener that opens its own `runInTenant` tx and calls `createCycleInTx(deps, tx, { …, periodFrom: registrationDate, source: 'onboarding', actorRole: 'system' })`.

- [ ] **Step 5: Wire at the route.** In `src/app/api/members/route.ts` POST, when F8 is enabled, spread the factory into the create deps (mirror the changePlan wiring at `[memberId]/route.ts:198`):
```typescript
const deps = buildMembersDeps(tenant);
const createDeps = env.features.f8Renewals
  ? { ...deps, onboardingListeners: (await import('@/modules/renewals')).f8OnCreateMemberCallbacks(tenant.slug) }
  : deps;
const result = await createMember(rawBody, { actorUserId: ctx.current.user.id, requestId: ctx.requestId }, createDeps);
```

- [ ] **Step 6: Run unit — expect PASS.** Add an integration test: creating a member with F8 on creates exactly one `upcoming` cycle anchored at `registration_date`; a duplicate create (idempotency-key replay) does not create a 2nd cycle.

- [ ] **Step 7: Commit.**
```bash
git add src/modules/members/application/use-cases/create-member.ts src/modules/renewals/infrastructure/ports-adapters/f8-on-create-member-callbacks.ts src/modules/renewals/index.ts src/app/api/members/route.ts tests/unit/members/create-member-onboarding-listener.test.ts tests/integration/
git commit -m "feat(members): post-commit onboarding listener creates initial renewal cycle for new members (slice 1)"
```

### Task 1.7 — Import-integrated cold-start (initial 131-member cohort)

**Files:**
- Modify: `scripts/import-members.ts` (per-member `createCycleInTx` inside the existing batch tx loop)
- Modify: `docs/member-import-spec.md` (§5 execution model + §8 test plan grow the cycle-creation step)
- Test: `tests/integration/scripts/import-members-cycles.test.ts`

The 131 SweCham members are NOT yet in the DB — they arrive via this one-time import. The initial cycle is created **by/alongside the import**, in the **same batch `runInTenant` tx**, per-member in the existing loop. Period anchor is **resolved by data**: `period_from = registration_date`, `period_to = +12 months`, frozen at the resolved `plan_id` price. No operator-supplied date.

> **Reviewer safety template (drizzle-migration-reviewer + reliability-guardian):** per-row uses the batch `tx` from `runInTenant` (**never the global `db`** — RLS gotcha); `--dry-run` writes nothing; **no member PII in stdout** (uuid/row-index only); double-run idempotency via `findActiveForMemberInTx` no-op; cross-tenant integration test. RoPA/runbook note records the bulk cold-start as a processing activity.

- [ ] **Step 1: Write the failing integration test** — `commitMembers` with a small anonymized fixture creates one `upcoming` cycle per imported member (count == members created), anchored at each member's `registration_date`, frozen at the resolved plan price; a **dry-run produces zero cycles**; a **re-run is idempotent** (no duplicate cycle — `findActiveForMemberInTx` no-op); cross-tenant (rows land under the correct `tenant_id`); a mid-batch cycle-insert failure rolls back ALL member+contact+cycle rows (atomic).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the cycle-creation step** inside the per-member loop in `commitMembers` (after the member + contact inserts, still inside the single `runInTenant(ctx, async (tx) => …)`):
```typescript
// F8-completion — initial renewal cycle for the imported member, same tx.
await createCycleInTx(
  { cyclesRepo, planLookup: makeDrizzlePlanLookupForRenewal(ctx), auditEmitter, idFactory },
  tx,
  { tenantId: ctx.slug, memberId, periodFrom: m.registrationDate.toISOString(), planId: m.planId,
    source: 'import', actorUserId, actorRole: 'system', correlationId: `import-members-${randomUUID()}` },
);
cyclesCreated += 1;
```
Add a `cyclesCreated` counter to `CommitOutcome` + the PII-free report line. (The repo/audit/planLookup deps must be constructible from `ctx` inside the script — mirror how the member-number allocator is already used in the loop.)

- [ ] **Step 4: Update `docs/member-import-spec.md`** §5 (the commit run now creates members + contacts + **initial renewal cycles** in one tx) + §8 (add the cycle-creation tests: dry-run zero cycles, idempotent re-run, RLS isolation, rollback). Add the RoPA/runbook note.

- [ ] **Step 5: Run the integration test — expect PASS.** `pnpm test:integration -- import-members`

- [ ] **Step 6: Commit.**
```bash
git add scripts/import-members.ts docs/member-import-spec.md tests/integration/scripts/import-members-cycles.test.ts
git commit -m "feat(import): create initial renewal cycle per imported member (import-integrated cold-start) (slice 1)"
```

### Task 1.8 — Observability counters

**Files:**
- Modify: `src/lib/metrics.ts` (add `renewal_bootstrap_cycle_create_failed` + `renewal_import_cycle_create_failed` counters) + wire into Tasks 1.6/1.7 swallow paths
- Modify: `docs/observability.md` (register the 2 counters + their alert thresholds)

- [ ] **Step 1: Add the two OTel counters** in the `renewalsMetrics` namespace (mirror `onPaidInvalidTx`). The bootstrap-listener swallow path (1.6) and the import per-row failure path (1.7) each increment + log at error with **uuid/row-index identifiers only — NEVER the member entity / PII**.

- [ ] **Step 2: Register in `docs/observability.md`** with SLO/alert notes (a non-zero `bootstrap_cycle_create_failed` rate means new members are silently dropping out of the renewal pipeline — page-worthy).

- [ ] **Step 3: Commit.**
```bash
git add src/lib/metrics.ts docs/observability.md
git commit -m "feat(observability): counters for bootstrap + import cycle-create failures (slice 1)"
```

---

# Slice 2 — Make cycles payable + portal gate

> Depends on Slice 1 (cycles must exist). Both the T-0 cron and the lazy confirm-transition go through the CAS guard → idempotent, race-safe. After this slice the self-service renew loop is observable end-to-end.

### Task 2.1 — `renewal_entered_awaiting_payment` audit (FULL new event + migration)

**Files:**
- Create: `drizzle/migrations/0XXX_f8_renewal_entered_awaiting_payment.sql`
- Modify: `src/modules/renewals/application/ports/renewal-audit-emitter.ts` (tuple 64→65 + payload shape + `source` discriminator) + `drizzle-renewal-audit-emitter.ts` (shipped tuple) + the 2 count test files

Zero hits in the codebase + NOT in the pgEnum. Full new-event: migration applied + `pnpm test:integration` GREEN **before** the emit site ships (the new pgEnum value is invisible to unit mocks; emitting pre-migration falls to pino-only → silent audit gap). Payload includes `source: 'cron' | 'confirm'`.

- [ ] **Step 1: Write the migration.**
```sql
-- 0XXX_f8_renewal_entered_awaiting_payment.sql
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'renewal_entered_awaiting_payment';
```

- [ ] **Step 2: Apply it + run integration FIRST (gotcha discipline).** `pnpm drizzle-kit migrate` then `pnpm test:integration -- renewals` — confirm GREEN against live Neon before touching any emit code.

- [ ] **Step 3: Bump the 4-place count** — add `'renewal_entered_awaiting_payment'` to `F8_AUDIT_EVENT_TYPES` (tuple count assertion 64→65) + the shipped emitter tuple + the typed payload shape (`{ cycle_id; member_id; source: 'cron'|'confirm'; entered_at }`) + the 2 count test files. Run them red→green.

- [ ] **Step 4: Commit.**
```bash
git add drizzle/migrations/0XXX_f8_renewal_entered_awaiting_payment.sql src/modules/renewals/application/ports/renewal-audit-emitter.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts tests/
git commit -m "feat(renewals): renewal_entered_awaiting_payment audit event (migration + 4-place count + source discriminator) (slice 2)"
```

### Task 2.2 — `listCyclesEligibleForAwaitingPayment` repo method

**Files:**
- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` + `.../drizzle/drizzle-renewal-cycle-repo.ts`
- Test: `tests/integration/renewals/list-eligible-awaiting-payment.test.ts`

Clone `listCyclesEligibleForLapse` (~689): `WHERE status IN ('upcoming','reminded') AND expires_at <= :nowIso`, order `expires_at ASC`. **Use `<= now`** (vs the lapse cron's `< now - grace`) so a cycle is never simultaneously eligible for both in one pass.

- [ ] **Step 1: Write the failing integration test** — seed an `upcoming` cycle with `expires_at <= now` → returned; one with `expires_at > now` → not returned; a `reminded` one with `expires_at <= now` → returned; ordered `expires_at ASC`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the port decl + adapter** (mirror `listCyclesEligibleForLapse` — `runInTenant`, returns `RenewalCyclePage`):
```typescript
async listCyclesEligibleForAwaitingPayment(
  _tenantId: string,
  args: { readonly nowIso: string; readonly pageSize: number },
): Promise<RenewalCyclePage> {
  return runInTenant(tenant, async (tx) => {
    const rows = await tx.select().from(renewalCycles).where(and(
      sql`${renewalCycles.status} IN ('upcoming','reminded')`,
      sql`${renewalCycles.expiresAt} <= ${args.nowIso}`,
    )).orderBy(sql`${renewalCycles.expiresAt} ASC`).limit(args.pageSize);
    return { items: rows.map(rowToDomain), nextCursor: null };
  });
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/application/ports/renewal-cycle-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts tests/integration/renewals/list-eligible-awaiting-payment.test.ts
git commit -m "feat(renewals): listCyclesEligibleForAwaitingPayment repo method (slice 2)"
```

### Task 2.3 — `enter-awaiting-payment-on-expiry` use-case (T-0 cron writer)

**Files:**
- Create: `src/modules/renewals/application/use-cases/enter-awaiting-payment-on-expiry.ts`
- Test: `tests/unit/renewals/enter-awaiting-payment-on-expiry.test.ts` + `tests/integration/renewals/enter-awaiting-payment-on-expiry.test.ts`

**Clone `lapse-cycles-on-grace-expiry.ts` 1:1**, changing: the eligibility list call (`listCyclesEligibleForAwaitingPayment`), the transition (`from: actualStatus ∈ {upcoming,reminded}, to: 'awaiting_payment'`), the audit event (`renewal_entered_awaiting_payment`, `source: 'cron'`), and the outcome taxonomy. Keep verbatim: per-cycle `acquireCycleLockInTx` + tx-bound `findByIdInTx` re-read + per-cycle fault isolation (`try/catch` + counter + continue) + `race_skipped` on status drift + audit-emit-in-tx + the exhaustive-switch `_exhaustive: never` pin.

- [ ] **Step 1: Write the failing unit test** — drives the use-case with a stub repo: an eligible `upcoming` cycle flips to `awaiting_payment`; a cycle that drifted out of `upcoming|reminded` between list + re-read → `race_skipped`; a throwing cycle is isolated (counted, loop continues); the count invariant `flipped + race_skipped + errors === processed` holds.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** by cloning `lapse-cycles-on-grace-expiry.ts`. The `processOne` body:
```typescript
return runInTenant(deps.tenant, async (tx) => {
  await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
  const reread = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
  if (!reread || (reread.status !== 'upcoming' && reread.status !== 'reminded')) return 'race_skipped';
  try {
    await deps.cyclesRepo.transitionStatus(tx, tenantId, cycleId, { from: reread.status, to: 'awaiting_payment' });
  } catch (e) {
    if (e instanceof CycleTransitionConflictError || e instanceof CycleNotFoundError) return 'race_skipped';
    throw e;
  }
  await deps.auditEmitter.emitInTx(tx,
    { type: 'renewal_entered_awaiting_payment' as const, payload: { cycle_id: cycleId, member_id: asMemberId(reread.memberId), source: 'cron' as const, entered_at: now.toISOString() } },
    { tenantId, actorUserId: null, actorRole: 'cron', correlationId });
  return 'flipped';
});
```
> No tenant-settings/grace lookup needed (the eligibility is `expires_at <= now`, no grace offset) — drop that block from the clone.

- [ ] **Step 4: Run unit — expect PASS.**

- [ ] **Step 5: Write + run integration** — flip an `upcoming` cycle, then assert the lapse cron now sees it as `awaiting_payment` (the two crons compose: enter→awaiting, later lapse→lapsed). Cross-tenant probe: tenant A's cron cannot flip tenant B's cycle.

- [ ] **Step 6: Commit.**
```bash
git add src/modules/renewals/application/use-cases/enter-awaiting-payment-on-expiry.ts tests/unit/renewals/enter-awaiting-payment-on-expiry.test.ts tests/integration/renewals/enter-awaiting-payment-on-expiry.test.ts
git commit -m "feat(renewals): enter-awaiting-payment-on-expiry T-0 writer (clone of lapse cron) (slice 2)"
```

### Task 2.4 — Cron route pair + schedule

**Files:**
- Create: `src/app/api/cron/renewals/enter-awaiting-payment/[tenantId]/route.ts`
- Create: `src/app/api/cron/renewals/enter-awaiting-payment-coordinator/route.ts`
- Modify: `docs/runbooks/cron-jobs.md`
- Test: `tests/contract/cron/enter-awaiting-payment-route.test.ts` (or the existing cron route test pattern)

**Copy the lapse-cycles route pair verbatim**, changing only: the use-case (`enterAwaitingPaymentOnExpiry`), the `ROUTE_LABEL`, the advisory-lock namespace (`renewals:enter-awaiting:` — disjoint from `renewals:lapse:`/`dispatch:`/`at-risk:`/`tierupgrade:`), and the response field names. Keep verbatim: `gateCronBearerOrRespond`, `env.features.f8Renewals` kill-switch, `env.flags.readOnlyMode` short-circuit (200 + skipped), the single-tenant guard (`tenantId !== env.tenant.slug`), fresh `correlationId`, `Promise.allSettled` fan-out, the `numFromJson` helper, the fixed-taxonomy error categorisation.

- [ ] **Step 1: Write the contract test** — Bearer-less request → 401 + `cron_bearer_auth_rejected` audit; `READ_ONLY_MODE` → 200 skipped; valid → invokes the use-case + returns the per-tenant counts.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create both route files** by copying the lapse pair + the deltas above.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Register the schedule** in `docs/runbooks/cron-jobs.md` — `enter-awaiting-payment-coordinator` on a cadence that runs at/after T-0 daily (e.g. `*/30` or daily; match the lapse cadence convention), Bearer `CRON_SECRET`, retry-OFF.

- [ ] **Step 6: Commit.**
```bash
git add src/app/api/cron/renewals/enter-awaiting-payment src/app/api/cron/renewals/enter-awaiting-payment-coordinator docs/runbooks/cron-jobs.md tests/contract/cron/
git commit -m "feat(renewals): enter-awaiting-payment cron route pair + schedule (slice 2)"
```

### Task 2.5 — B-lazy: confirm-renewal self-transition (early renewal)

**Files:**
- Modify: `src/modules/renewals/application/use-cases/confirm-renewal.ts:140,182`
- Test: `tests/integration/renewals/confirm-lazy-transition.test.ts` (convergence)

In `confirm-renewal` Step-1: acquire the per-cycle advisory lock as the **FIRST statement** (it currently acquires only at Step-4 — the B4 fix), then if `status ∈ {upcoming,reminded}` → `transitionStatus(tx, …, {from: status, to: 'awaiting_payment'})` in the Step-1 tx; **idempotent** when already `awaiting_payment` (treat as success, NOT `cycle_not_payable`); emit `renewal_entered_awaiting_payment` `source: 'confirm'`.

- [ ] **Step 1: Write the failing convergence integration test** — concurrent cron-flip + confirm-flip on the same `upcoming` cycle → exactly **ONE** `awaiting_payment` row; the loser sees `CycleTransitionConflictError` and re-reads cleanly (no orphan, no double-flip). Plus: confirming an `upcoming` cycle self-transitions it to `awaiting_payment` then proceeds to issue the §86/4 (early-renewal happy path); confirming an already-`awaiting_payment` cycle is unchanged.

- [ ] **Step 2: Run — expect FAIL** (today `confirm-renewal:182` rejects non-`awaiting_payment` with `cycle_not_payable`).

- [ ] **Step 3: Implement.** At the top of the Step-1 `runInTenant` body (`confirm-renewal.ts:140`), add `await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);` as the first statement. Replace the `:182` gate:
```typescript
// BEFORE: if (cycle.status !== 'awaiting_payment') return err({ kind: 'cycle_not_payable', currentStatus: cycle.status });
// AFTER:
if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
  await deps.cyclesRepo.transitionStatus(tx, input.tenantId, cycleId, { from: cycle.status, to: 'awaiting_payment' });
  await deps.auditEmitter.emitInTx(tx,
    { type: 'renewal_entered_awaiting_payment' as const, payload: { cycle_id: cycleId, member_id: input.memberId, source: 'confirm' as const, entered_at: deps.clock.nowIso() } },
    { tenantId: input.tenantId, actorUserId: input.actorUserId, actorRole: input.actorRole, correlationId: input.correlationId });
  cycle = { ...cycle, status: 'awaiting_payment' }; // reflect for the rest of Step-1
} else if (cycle.status !== 'awaiting_payment' && cycle.status !== 'pending_admin_reactivation') {
  // terminal (completed/lapsed/cancelled) or other non-payable → keep the existing reject
  return err({ kind: 'cycle_not_payable' as const, currentStatus: cycle.status });
}
// (pending_admin_reactivation stays a server-side reject too unless the money-hold path is built)
```
> The advisory lock makes the Step-1 flip genuinely serialised against the cron (closes the B4 window). Keep the Step-4 lock as-is (the link step still needs it).

- [ ] **Step 4: Run the convergence test — expect PASS.**

- [ ] **Step 5: Run the full confirm-renewal integration suite** (the change sits on the money path). `pnpm test:integration -- confirm-renewal`

- [ ] **Step 6: Commit.**
```bash
git add src/modules/renewals/application/use-cases/confirm-renewal.ts tests/integration/renewals/confirm-lazy-transition.test.ts
git commit -m "feat(renewals): lazy confirm-transition upcoming|reminded→awaiting_payment (Step-1 lock, B-lazy) (slice 2)"
```

### Task 2.6 — G4: portal payability gate + i18n + E2E

**Files:**
- Modify: `src/app/(member)/portal/renewal/[memberId]/page.tsx:216-227`
- Modify: `src/i18n/messages/{en,th,sv}.json` (new `portal.renewal.*` keys)
- Test: `tests/e2e/renewal-payability-gate.spec.ts`

Branch on `summary.status` (already available): render `<RenewalConfirmFlow>` only for `awaiting_payment`; for `upcoming|reminded` show a read-only "renewal window not yet open / reminder pending" card; for `pending_admin_reactivation` show an "awaiting admin verification" notice. The server gate (`confirm-renewal` → 409) stays the backstop.

- [ ] **Step 1: Add the i18n keys** to all three locales (TH mandatory — missing key → runtime `MISSING_MESSAGE`): `portal.renewal.notYetOpenTitle/Body`, `portal.renewal.pendingReviewTitle/Body`. Run `pnpm check:i18n`.

- [ ] **Step 2: Write the failing E2E** (`tests/e2e/renewal-payability-gate.spec.ts`, `--workers=1`): an `upcoming` cycle renders the read-only not-yet-open state (no enabled Confirm button); an `awaiting_payment` cycle renders the Confirm flow. Skip-at-runtime when E2E fixtures absent (match the F8 i18n spec pattern).

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement the gate** at `page.tsx:216`:
```tsx
{summary.status === 'awaiting_payment' ? (
  <Card><CardContent>
    <RenewalConfirmFlow memberId={urlMemberId} cycleId={summary.cycleId} planYear={planYear}
      currentPlanId={summary.planIdAtCycleStart} currentPlanLabel={currentPlanLabel} availablePlans={availablePlans} />
  </CardContent></Card>
) : summary.status === 'pending_admin_reactivation' ? (
  <ReadOnlyNotice title={t('pendingReviewTitle')} body={t('pendingReviewBody')} />
) : (
  <ReadOnlyNotice title={t('notYetOpenTitle')} body={t('notYetOpenBody')} />
)}
```
> **Reviewer note (do NOT flag as a bug):** until Slice 2's writers run, the `awaiting_payment` branch is unreachable for most members, so this correctly renders the not-yet-payable state — that is correct, not "renewal is broken."

- [ ] **Step 5: Run E2E — expect PASS.** `pnpm test:e2e --workers=1 --grep "payability gate"`

- [ ] **Step 6: Commit.**
```bash
git add "src/app/(member)/portal/renewal/[memberId]/page.tsx" src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/e2e/renewal-payability-gate.spec.ts
git commit -m "feat(portal): gate renewal Confirm flow on cycle payability (G4) (slice 2)"
```

---

# Slice 3 — Admin lapsed-comeback (reachable fresh-cycle path)

> Depends on Slice 2 (awaiting_payment must be reachable). **Security/tax-sensitive (renewal invoice + member payment) → ≥2 reviewers, one signs the security checklist.** Ships ONLY the reachable common-case path: an admin creates a fresh `awaiting_payment` cycle + §86/4 for a lapsed member. The `pending_admin_reactivation` money-hold reactivate/reject routes + `blockAutoReactivation` UI + "Pending review" tab are **DEFERRED post-launch** (design retained in the spec §C; the race-safe `adminReactivateLapsedCycle`/`adminRejectReactivation` use-cases already exist and can be wired then).

### Task 3.1 — `admin-renew-lapsed-member` use-case

**Files:**
- Create: `src/modules/renewals/application/use-cases/admin-renew-lapsed-member.ts`
- Test: `tests/unit/renewals/admin-renew-lapsed-member.test.ts` + `tests/integration/renewals/admin-renew-lapsed-member.test.ts`

Creates a fresh `awaiting_payment` cycle for a lapsed member via `createCycleInTx` (period_from = now, or the member's next-period anchor — **decide: `period_from = now`** for a comeback, frozen at the member's current `plan_id`), then issues a §86/4 renewal invoice via the F4 bridge (frozen price, reusing the Slice-1 tax fix). Because `createCycleInTx` inserts `upcoming`-shaped frozen columns, immediately transition the fresh cycle to `awaiting_payment` (so it's payable) — OR add a `startStatus` param to `createCycleInTx`. **Decide: add an optional `startStatus: 'upcoming' | 'awaiting_payment'` to `createCycleInTx`** (default `'upcoming'`) so the admin path creates it directly payable in one insert — cleaner than insert-then-transition.

- [ ] **Step 1: Add `startStatus` to `createCycleInTx`** (default `'upcoming'`; the insert sets `status: startStatus`). Update the helper's unit test for the `awaiting_payment` start.

- [ ] **Step 2: Write the failing unit + integration tests** — admin renews a lapsed member → a fresh `awaiting_payment` cycle exists + a §86/4 invoice is issued at the frozen price; the member can then pay → callback[0] completes → callback[2] creates the next `upcoming` cycle (the loop closes); a non-lapsed member (already has an active cycle) → `createCycleInTx` no-ops / the use-case returns a clear `member_has_active_cycle` error; cross-tenant probe rejected.

- [ ] **Step 3: Implement** — open a `runInTenant` tx: `createCycleInTx(deps, tx, { …, periodFrom: now, planId: member.planId, source: 'admin_lapsed_comeback', startStatus: 'awaiting_payment', actorRole: 'admin', actorUserId })` → then issue the §86/4 via the F4 bridge (reuse `issueInvoiceForRenewal` with the frozen price) → link the invoice. Mirror `confirm-renewal`'s issue-outside-tx + link-in-tx structure to avoid widening the orphan window. Audit `renewal_cycle_created` (from the helper) + the existing invoice-issued audit.

- [ ] **Step 4: Run unit + integration — expect PASS.** `pnpm test:integration -- admin-renew-lapsed-member`

- [ ] **Step 5: Commit.**
```bash
git add src/modules/renewals/application/use-cases/admin-renew-lapsed-member.ts src/modules/renewals/application/use-cases/create-cycle-in-tx.ts src/modules/renewals/index.ts tests/unit/renewals/admin-renew-lapsed-member.test.ts tests/integration/renewals/admin-renew-lapsed-member.test.ts
git commit -m "feat(renewals): admin-renew-lapsed-member (fresh awaiting_payment cycle + §86/4) (slice 3)"
```

### Task 3.2 — Admin route + UI + i18n + E2E

**Files:**
- Create: `src/app/api/admin/members/[memberId]/renew/route.ts`
- Create: a client action component (mirror `outreach-dialog.tsx` fetch+toast+refresh) on the admin member detail / lapsed surface
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Test: `tests/contract/admin/member-renew-route.test.ts` + `tests/e2e/admin-lapsed-comeback.spec.ts`

- [ ] **Step 1: Write the contract test** — POST `/api/admin/members/[memberId]/renew` with `requireAdminContext('members','write')`, kill-switch, error switch (`member_not_found`→404, `member_has_active_cycle`→409, `plan_not_found`→422, `server_error`→500). Copy the `cancel/route.ts` skeleton + the `requireRenewalAdminContext`/`resolveTenantFromRequest`/`makeRenewalsDeps` pattern.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create the route** (copy `cancel/route.ts`, swap the use-case + error arms). **RBAC: `action='write'` (admin-only), not `manager_exception`.** Hide the UI affordance for managers.

- [ ] **Step 4: Create the UI action** — a "Renew / reactivate this member" button on the lapsed member surface, rendered only for lapsed members + admin role. Confirm dialog (mirror `outreach-dialog.tsx`): explicit copy ("this creates a renewal invoice for the member to pay"), `fetch` POST, `sonner` toast, `router.refresh()`. Add i18n keys (`admin.renewals.*` or `admin.members.*`) in en/th/sv. Run `pnpm check:i18n`.

- [ ] **Step 5: Write + run the E2E** (`--workers=1`) — admin opens a lapsed member, clicks Renew, a fresh awaiting_payment cycle + invoice appear; manager does NOT see the button.

- [ ] **Step 6: Run — expect PASS.**

- [ ] **Step 7: Commit.**
```bash
git add "src/app/api/admin/members/[memberId]/renew/route.ts" "src/app/(staff)/admin/members" src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/contract/admin/member-renew-route.test.ts tests/e2e/admin-lapsed-comeback.spec.ts
git commit -m "feat(admin): lapsed-member renew action — route + UI (reachable lapsed-comeback) (slice 3)"
```

---

# Production-ready gate (spans all slices — the headline acceptance bar)

> Not a code slice — the launch sequence + production E2E smoke that must pass before SweCham go-live. Run after Slices 0-3 merge.

- [ ] **Go-live sequence dry-run** (per `docs/go-live-readiness.md` §6b + `docs/member-import-spec.md` §5), in order: provision tenant → seed plans for `plan_year` (`scripts/seed-swecham-2026-plans.ts`) → bootstrap admin → **PITR snapshot** → member import `--dry-run` (clean report) → `--commit` (creates members + contacts + initial cycles in one tx/member, idempotent) → flip `FEATURE_F8_RENEWALS=true` → **verify one `upcoming`/`awaiting_payment` cycle per imported member** (count == imported count; no member without a cycle).
- [ ] **Production E2E smoke** of the real renew journey against the launch build, all three paths: **(a) new member** (onboarded → cycle created → reminder → awaiting_payment → confirm → §86/4 at frozen price → pay → completed → next cycle created); **(b) renew** (steady-state loop closes); **(c) lapsed-comeback** (Slice-3 fresh cycle → pay → active).
- [ ] **Cron schedules registered** (`enter-awaiting-payment`, lapse, reconcile, dispatch) in `docs/runbooks/cron-jobs.md`; bulk cold-start recorded in RoPA.
- [ ] **Final cross-cutting CI** (reproduce locally): `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:audit-counts && pnpm test:integration && pnpm test:e2e --workers=1`.

---

## Deferred (post-launch — design retained in spec §C, NOT built here)

- The `pending_admin_reactivation` money-hold **reactivate** (`POST /api/admin/renewals/[cycleId]/reactivate`) + **reject-with-refund** (`POST …/reject`, typed "REFUND" confirmation, F5 refund + credit-note) routes.
- The `<PendingReactivationActions>` cycle-detail UI + the "Pending review" status-filtered discovery tab.
- The `blockAutoReactivation` admin UI (the safety branch that makes `pending_admin_reactivation` reachable in the first place).
- When built: wire `f5RefundBridge` into the `RenewalsDeps` default factory; reject is `action='write'` + a per-(tenant,admin) rate-limit (30/5min), no route-level retry (two-tx refund outside the F8 tx); ≥2 reviewers + security checklist.

---

## Self-Review (writing-plans checklist — run before handoff)

**1. Spec coverage** — every spec goal/decision maps to a task:
- Goal 0 (production-ready) → the Production-ready gate section. ✓
- Goal 1 (creation writer + frozen snapshot) → Tasks 1.2-1.4, 1.6, 1.7 (all via shared `createCycleInTx`). ✓
- Goal 2 (→awaiting_payment writer) → Tasks 2.2-2.5. ✓
- Goal 3 (admin reactivate reachable) → Slice 3 (reachable fresh-cycle path; money-hold deferred per Resolved #6). ✓
- Goal 4 (portal payability gate) → Task 2.6. ✓
- Goal 5 (state machine authoritative) → Slice 0. ✓
- Goal 6 (frozen-price §86/4) → Task 1.5. ✓
- Goal 7 (audit sites + invariants + production smoke) → audit tasks 1.2/2.1, the integration tests in every task, the production smoke. ✓
- Spec §A discipline (THROW on callback[2], swallow ONLY on the onboarding listener) → Tasks 1.4 (throw) + 1.6 (swallow). ✓
- Spec §B4 (Step-1 lock) → Task 2.5. ✓
- Spec §Frozen-price (a) integer parse, (b) VAT-exclusive, (c) server-sourced + contract change → Task 1.5. ✓
- Spec migration asymmetry (`renewal_cycle_created` MOVE vs `renewal_entered_awaiting_payment` full event) → Tasks 1.2 vs 2.1. ✓

**2. Placeholder scan** — no "TBD"/"add error handling"/"similar to Task N" without code. The clone tasks (2.3, 2.4, 3.2) name the exact source file + the precise deltas (the source is existing code, not an unwritten task). ✓

**3. Type consistency** — `createCycleInTx` signature is identical across its consumers (1.4, 1.6, 1.7, 3.1); `findActiveForMemberInTx` signature matches between port (1.1) and all callers; `renewal_entered_awaiting_payment` payload (`source` discriminator) is identical in the cron (2.3) and the lazy-confirm (2.5); `startStatus` added to `createCycleInTx` in 3.1 is backward-compatible (default `'upcoming'`). ✓

**4. Known refinements vs spec v2** (folded in, flagged for implementers):
- The THB→satang parser **already exists** (`cycleFrozenPriceSatang`) — Task 1.5 reuses/extracts it rather than writing a new one (the spec said "the plan must write one"; the reader proved it exists). De-risks the float bug.
- The member import is **one batch `runInTenant` tx with a per-member loop** (not "one tx per member" as the spec phrasing implied) — Task 1.7 adds `createCycleInTx` inside that loop; atomicity is whole-batch (matches the existing import contract).
- `frozenPlanPriceThb` is already in scope at `cycleAfterPlanChange` in confirm-renewal — Task 1.5 threads it directly, no re-read.
