# Member Erasure — US2d (Reconciliation Sweep + erasure_outcome Metric) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** A cron that finds members whose erasure committed (`erased_at IS NOT NULL`) but whose completion proof never landed (no `member_erased` audit — a cascade failed post-commit) and re-drives them to completion, plus a `members_erasure_outcome_total` metric + a stuck-erasure alert signal — so a partial GDPR-Art.17 erasure can never silently sit incomplete forever.

**Architecture:** A new cron route (`/api/cron/members/reconcile-erasures`) modelled on the F7 `reconcile-stuck-sending` route: Bearer `CRON_SECRET` auth, a feature-flag kill-switch, and a candidate SELECT (`members WHERE erased_at IS NOT NULL AND NOT EXISTS (member_erased audit)` with `FOR UPDATE SKIP LOCKED` + batch `LIMIT`) released before the re-drive loop. For each stuck member it **re-invokes the production `eraseMember`** (which is idempotent: the pre-flight `findErasedAtById` sees `erased_at` set → skips the `member_erasure_requested` re-emit (no Art.12 clock restart), the scrub is repeatable, every cascade is individually idempotent, and `member_erased` is emitted only once all cascades report clean). The cron tallies each outcome and emits `members_erasure_outcome_total{outcome,tenant}`. **Load-bearing detail:** the `NOT EXISTS` subquery against `audit_log` MUST carry an explicit `al.tenant_id = <slug>` filter — `audit_log` uses a PERMISSIVE RLS policy (NULL-tenant F1 rows are visible to every context), so the filter is correctness, not defence-in-depth.

**Tech Stack:** TypeScript 5.7 strict · Drizzle ORM + Neon Postgres (RLS, `runInTenant`, `FOR UPDATE SKIP LOCKED`) · OTel metrics (`src/lib/metrics.ts`) · Vitest · Next.js route handler.

---

## Pre-flight (read before Task 1)

- **`eraseMember` is the re-drive mechanism** — `src/modules/members/application/use-cases/erase-member.ts`. Re-running it on an already-erased member is safe + completes a partial run (verified US1: pre-flight `findErasedAtById` skips the requested re-emit when `erased_at` is set; the scrub is idempotent; the post-commit cascades are each idempotent; `member_erased` emits only on a fully-clean run). Signature: `eraseMember(memberId, { reason }, { actorUserId, requestId }, deps)`. The reason enum is `'gdpr_erasure_request' | 'pdpa_deletion_request'` — the reconciler reads the ORIGINAL reason from the member's `member_erasure_requested` audit payload (`payload->>'reason'`), defaulting to `'gdpr_erasure_request'`. Production deps via `buildEraseMemberDeps(tenant)` (`members-deps.ts:168-193`).
- **The completion proof** is the `member_erased` audit (`erase-member.ts` emit payload `{ member_id: memberId, reason, … }`). `members.erased_at` is `schema-members.ts:180`.
- **Audit-existence query pattern** — model on the at-risk-scorer's `EXISTS` subquery against `auditLog` (`src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts:235-264`) — note the **load-bearing `al.tenant_id` filter rule** documented at that file's `:50-62`. The `auditLog` Drizzle table symbol + `members` table are both importable.
- **Cron route pattern** — F7 `src/app/api/cron/broadcasts/reconcile-stuck-sending/route.ts`: `runtime='nodejs'`, `dynamic='force-dynamic'`, `verifyCronBearer(request.headers.get('authorization'), env.cron.secret)` → 401, kill-switch `if (!env.features.<flag>) return 200 {skipped}`, `resolveTenantFromRequest` + `asTenantContext`, candidate select in one `runInTenant` (`FOR UPDATE SKIP LOCKED` + `LIMIT MAX_PER_TICK`), `summary` counters, per-item best-effort loop, split 200/500 response (`uncaught_error || server_error > 0` → 500). The redact cron (`…/redact-expired-event-buyers/route.ts`) also adds `maxDuration = 300`.
- **Metric pattern** — `src/lib/metrics.ts`: `counter(name, description)` (`:92-102`) + `safeMetric(fn)` (`:1136`) helpers; model on `invoicingMetrics.eventBuyerPiiRedacted(outcome, tenantId)` (`:659-666`) — a per-outcome counter. There is currently **no** `membersMetrics`/`erasureMetrics` export — add one.
- **Feature flag** — check `src/lib/env.ts` for an existing members/erasure feature flag; if none, add `FEATURE_MEMBER_ERASURE_RECONCILE` (default true in prod, gate the cron). (Mirror how `env.features.f7Broadcasts` is declared.)
- **F3 audit count** — US2d emits NO new members audit event (the reconciler re-emits the existing `member_erased`); the `f3-audit-event-type-count.test.ts` count stays **31**.
- **Run commands** — as US2a-c. The cron has no migration unless the feature flag needs a column (it doesn't — env var only).
- **Related deferred finding (US2a /code-review)** — this reconciler IS the closure for deferred finding #3 in `docs/superpowers/specs/2026-06-16-member-erasure-design.md` § "Known limitations / deferred (US2a /code-review)" (a failed F1 linked-login erasure currently strands until US2d; interim closure is a manual `eraseMember` re-drive, alerted via `authMetrics.eraseCascadeOutcome('failed'|'last_admin'|'threw')`). Align the new `members_erasure_outcome_total` with that existing `eraseCascadeOutcome` signal so both read coherently on one dashboard. **Caveat:** the `'erase-user-last-admin'` / `eraseCascadeOutcome('last_admin')` case is NOT auto-recoverable by re-drive — the reconciler will loop on it forever; surface it as a DISTINCT stuck-erasure alert needing operator action (promote another admin / transfer the admin's contact link), never as a transient retry. (Finding #1, the tenant-NULL `user_erased` DPO-evidence gap, is US3, not US2d.)
- **Related deferred finding (US2c /code-review #5 → design-doc §8)** — the F6 registration fan-out has NO per-`(tenant, member)` serialization and is a POST-COMMIT best-effort cascade (outside the scrub tx's `FOR UPDATE`). The `members`-candidate `FOR UPDATE SKIP LOCKED` here guards reconciler-tick-vs-tick, but it does NOT stop a reconciler re-drive from racing an ORIGINAL in-flight `eraseMember`'s post-commit F6 fan-out. When that race hits a quota-UNCOUNTED registration (no advisory lock on the uncounted path), both passes can emit a duplicate `pii_erasure_requested` and the loser's `hardDelete` 404s as `invariant_violation` → a **benign `failedCount`**. **So the reconciler must NOT treat that spurious `failedCount` as a hard/stuck error** — it self-heals on the next clean tick (idempotent; quota is recomputed-on-read, never double-credited — the partial-commit double-credit hazard itself was already FIXED in US2c via `runInTenantWithRollbackOnErr`). Map it to a transient `partial`/retry outcome, distinct from the non-retryable `'erase-user-last-admin'` stuck alert above. (The design-doc §8 note also flags an optional per-`(tenant, member)` lock as the eventual clean fix.)

**File-structure map:**
- Modify `src/lib/metrics.ts` — add an `erasureMetrics.outcome(...)` counter.
- Modify `src/lib/env.ts` — add the reconcile feature flag (if none exists).
- Modify `src/modules/members/application/ports/member-repo.ts` + `…/infrastructure/db/drizzle-member-repo.ts` — add `findStuckErasuresInTx`.
- Create `src/app/api/cron/members/reconcile-erasures/route.ts`.
- Modify `docs/observability.md` + `docs/runbooks/cron-jobs.md` — the metric + the cron entry + the stuck-erasure alert.
- Tests: members integration (the stuck-query finds incomplete, ignores complete), the cron contract test (auth/kill-switch/reconcile loop), an integration proving a partial erasure is completed by the reconciler.

---

## Task 1: `erasureMetrics.outcome` counter

**Files:**
- Modify: `src/lib/metrics.ts`
- Test: `tests/unit/lib/erasure-metrics.test.ts` (create — if the metrics module has a test harness; else rely on the integration emit + the typecheck)

- [ ] **Step 1: Add the metric** — add a new export block in `src/lib/metrics.ts` (after an existing `*Metrics` block), modelled on `invoicingMetrics.eventBuyerPiiRedacted`:
```ts
export type MemberErasureOutcome = 'reconciled' | 'still_pending' | 'error';

export const erasureMetrics = {
  /** Member-erasure reconciliation sweep outcome by tenant (COMP-1 US2d). */
  outcome(outcome: MemberErasureOutcome, tenantId: string): void {
    safeMetric(() => {
      counter(
        'members_erasure_outcome_total',
        'Member-erasure reconciliation sweep outcomes (reconciled→completed this tick / still_pending→a cascade still failing / error) by tenant',
      ).add(1, { outcome, tenant: tenantId });
    });
  },
};
```

- [ ] **Step 2: True typecheck → 0; commit.** (If `src/lib/metrics.ts` has an export-shape test, run it.)

```bash
git add src/lib/metrics.ts
git commit -m "feat(metrics): erasureMetrics.outcome counter (COMP-1 US2d)"
```

---

## Task 2: `MemberRepo.findStuckErasuresInTx` — the reconciler candidate query

**Files:**
- Modify: `src/modules/members/application/ports/member-repo.ts`, `src/modules/members/infrastructure/db/drizzle-member-repo.ts`
- Test: `tests/integration/members/find-stuck-erasures.test.ts` (create)

- [ ] **Step 1: Write the failing integration test (RED)** — seed (a) a member with `erased_at` set + a `member_erased` audit (COMPLETE — must NOT be returned), (b) a member with `erased_at` set + NO `member_erased` audit (STUCK — must be returned, with its reason from the `member_erasure_requested` audit), (c) a non-erased member (must NOT be returned):
```ts
it('returns only erased members lacking a member_erased audit, with the original reason', async () => {
  const complete = await seedErasedMember(ctx, { withMemberErasedAudit: true, reason: 'gdpr_erasure_request' });
  const stuck = await seedErasedMember(ctx, { withMemberErasedAudit: false, reason: 'pdpa_deletion_request' });
  const live = await seedMember(ctx); // not erased
  const rows = await runInTenant(ctx, (tx) => memberRepo.findStuckErasuresInTx(tx, ctx.slug, 50));
  const ids = rows.map((r) => r.memberId);
  expect(ids).toContain(stuck.memberId);
  expect(ids).not.toContain(complete.memberId);
  expect(ids).not.toContain(live.memberId);
  expect(rows.find((r) => r.memberId === stuck.memberId)?.reason).toBe('pdpa_deletion_request');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Add the port method + impl**

Port:
```ts
  /**
   * COMP-1 US2d — reconciler candidate query. Returns erased members
   * (`erased_at IS NOT NULL`) that lack the `member_erased` completion audit
   * (a post-commit cascade failed), newest-erasure-first, locked
   * `FOR UPDATE SKIP LOCKED` (so concurrent cron ticks don't double-drive).
   * `reason` is read from the member's `member_erasure_requested` audit
   * (defaults to 'gdpr_erasure_request'). The audit_log subquery carries an
   * EXPLICIT tenant filter (PERMISSIVE RLS — load-bearing, not defence).
   */
  findStuckErasuresInTx(
    tx: TenantTx,
    tenantSlug: string,
    limit: number,
  ): Promise<ReadonlyArray<{ readonly memberId: MemberId; readonly reason: 'gdpr_erasure_request' | 'pdpa_deletion_request' }>>;
```
Impl (raw `sql` — the anti-join + the reason lateral are clearest in SQL):
```ts
async findStuckErasuresInTx(tx, tenantSlug, limit) {
  const rows = (await tx.execute(sql`
    SELECT m.member_id::text AS member_id,
           COALESCE(
             (SELECT al.payload->>'reason'
              FROM audit_log al
              WHERE al.tenant_id = ${tenantSlug}
                AND al.event_type = 'member_erasure_requested'
                AND al.payload->>'member_id' = m.member_id::text
              ORDER BY al.timestamp DESC LIMIT 1),
             'gdpr_erasure_request'
           ) AS reason
    FROM members m
    WHERE m.erased_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM audit_log al2
        WHERE al2.tenant_id = ${tenantSlug}
          AND al2.event_type = 'member_erased'
          AND al2.payload->>'member_id' = m.member_id::text
      )
    ORDER BY m.erased_at DESC
    LIMIT ${limit}
    FOR UPDATE OF m SKIP LOCKED
  `)) as unknown as Array<{ member_id: string; reason: string }>;
  return rows.map((r) => ({
    memberId: asMemberId(r.member_id),
    reason: r.reason === 'pdpa_deletion_request' ? 'pdpa_deletion_request' : 'gdpr_erasure_request',
  }));
}
```
Notes: `FOR UPDATE OF m` locks only the `members` row (the audit subqueries aren't lockable). `members` is strict-RLS so the outer `WHERE` needs no explicit tenant filter, but BOTH `audit_log` subqueries DO (PERMISSIVE RLS). The `reason` is normalised to the enum (anything not `pdpa_deletion_request` → `gdpr_erasure_request`). Use the file's `asMemberId` constructor.

- [ ] **Step 4: Run — PASS; commit.**

```bash
git add src/modules/members/application/ports/member-repo.ts src/modules/members/infrastructure/db/drizzle-member-repo.ts tests/integration/members/find-stuck-erasures.test.ts
git commit -m "feat(members): findStuckErasuresInTx reconciler candidate query (COMP-1 US2d)"
```

---

## Task 3: The reconcile-erasures cron route

**Files:**
- Create: `src/app/api/cron/members/reconcile-erasures/route.ts`
- Modify: `src/lib/env.ts` (the feature flag, if none exists)
- Test: `tests/contract/members/reconcile-erasures-route.contract.test.ts` (create)

- [ ] **Step 1: Add the feature flag** (if no members-erasure flag exists) — in `src/lib/env.ts`, add `featureMemberErasureReconcile` (env `FEATURE_MEMBER_ERASURE_RECONCILE`, default `true`), mirroring an existing `env.features.*` boolean. Add it to `.env.example` / the env docs.

- [ ] **Step 2: Write the failing contract test (RED)** — mock the deps; assert: (a) no/invalid Bearer → 401; (b) flag off → 200 `{skipped:true}` (no reconcile); (c) valid + flag on, with the stuck-query stubbed to 2 members → `eraseMember` called twice, the metric emitted per outcome, response 200 with `{ processed: 2, reconciled, still_pending }`; (d) one re-drive throws → that one counts as `error`, the loop continues, response is 500 (so cron-job.org retries). Mirror the F7 reconcile route contract test structure (stub `verifyCronBearer`, `runInTenant`, the repo + `eraseMember`).

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement the route** — model on F7 reconcile-stuck-sending:
```ts
import { type NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { verifyCronBearer } from '@/lib/cron-auth';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { asTenantContext } from '@/modules/tenants';
import { eraseMember } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { drizzleMemberRepo } from '@/modules/members/...'; // the repo singleton with findStuckErasuresInTx
import { erasureMetrics } from '@/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const MAX_PER_TICK = 50;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }
  const tenant = asTenantContext(resolveTenantFromRequest(request).slug);
  if (!env.features.memberErasureReconcile) {
    return NextResponse.json({ skipped: true, reason: 'feature_disabled' }, { status: 200 });
  }

  // Candidate select — released before the re-drive loop (FOR UPDATE SKIP LOCKED
  // prevents two ticks grabbing the same rows; the lock drops when this tx commits).
  let stuck: ReadonlyArray<{ memberId: string; reason: 'gdpr_erasure_request' | 'pdpa_deletion_request' }>;
  try {
    stuck = await runInTenant(tenant, (tx) => drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.slug, MAX_PER_TICK));
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e), tenantId: tenant.slug }, 'cron.members.reconcile_erasures.query_failed');
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }

  const summary = { processed: 0, reconciled: 0, still_pending: 0, error: 0 };
  const deps = buildEraseMemberDeps(tenant);
  for (const { memberId, reason } of stuck) {
    summary.processed++;
    try {
      const res = await eraseMember(memberId as never, { reason }, { actorUserId: 'system:cron', requestId: null }, deps);
      if (res.ok && res.value.cascadesComplete) { summary.reconciled++; erasureMetrics.outcome('reconciled', tenant.slug); }
      else { summary.still_pending++; erasureMetrics.outcome('still_pending', tenant.slug);
        logger.warn({ tenantId: tenant.slug, memberId }, 'cron.members.reconcile_erasures.still_pending'); }
    } catch (e) {
      summary.error++;
      erasureMetrics.outcome('error', tenant.slug);
      logger.error({ err: e instanceof Error ? e.message : String(e), tenantId: tenant.slug, memberId }, 'cron.members.reconcile_erasures.uncaught');
    }
  }

  logger.info({ tenantId: tenant.slug, ...summary }, 'cron.members.reconcile_erasures.tick_complete');
  return NextResponse.json(summary, { status: summary.error > 0 ? 500 : 200 });
}
```
Adjust the `drizzleMemberRepo` import to the real singleton path (the one exposing `findStuckErasuresInTx`). `eraseMember`'s memberId arg is branded — cast via the real `asMemberId` (not `as never`). `actorUserId: 'system:cron'` matches the cron sentinel other routes use.

- [ ] **Step 5: Run the contract test — PASS; commit.**

```bash
git add src/app/api/cron/members/reconcile-erasures/route.ts src/lib/env.ts tests/contract/members/reconcile-erasures-route.contract.test.ts .env.example
git commit -m "feat(members): reconcile-erasures cron + erasure_outcome metric (COMP-1 US2d)"
```

---

## Task 4: End-to-end live-Neon — the reconciler completes a partial erasure

**Files:**
- Test: `tests/integration/members/reconcile-erasures.test.ts` (create)

- [ ] **Step 1: Write the e2e (RED→GREEN)** — produce a STUCK erasure on live Neon: run `eraseMember` with a deps where ONE post-commit cascade is forced to fail (e.g. inject a `userErasure`/`broadcastsContentScrub`/`eventRegistrationErasure` adapter that returns `failed` — reuse the no-op-but-failing stub), so the member is scrubbed (`erased_at` set) but `member_erased` is NOT emitted. Confirm `findStuckErasuresInTx` returns it. Then call the reconciler's re-drive (either POST the route with a valid Bearer, or call the same loop directly with the REAL `buildEraseMemberDeps` so the cascade now succeeds). Assert:
- after the re-drive, a `member_erased` audit now exists for the member;
- `findStuckErasuresInTx` no longer returns it (it's complete);
- **no double `member_erased`** if the reconciler runs twice (re-running the now-complete member is skipped by the query — it's no longer stuck);
- the `members_erasure_outcome_total{outcome:'reconciled'}` path was taken (assert via the response summary `reconciled === 1`).
```ts
it('reconciler completes a partial erasure (member_erased emitted, then no longer stuck)', async () => {
  const { memberId } = await seedPartialErasure(ctx); // erased_at set, member_erased ABSENT (forced cascade fail)
  const before = await runInTenant(ctx, (tx) => drizzleMemberRepo.findStuckErasuresInTx(tx, ctx.slug, 50));
  expect(before.map((r) => r.memberId)).toContain(memberId);

  await driveReconcileOnce(ctx); // posts the route OR runs the loop with real deps

  const audits = await rawSelectAuditTypesForMember(ctx, memberId);
  expect(audits.filter((t) => t === 'member_erased')).toHaveLength(1);
  const after = await runInTenant(ctx, (tx) => drizzleMemberRepo.findStuckErasuresInTx(tx, ctx.slug, 50));
  expect(after.map((r) => r.memberId)).not.toContain(memberId);
});
```

- [ ] **Step 2: Final gates** — members integration (find-stuck + reconcile) + the contract test + lint + true typecheck.

- [ ] **Step 3: Update docs** — add to `docs/observability.md` the `members_erasure_outcome_total` metric + a **stuck-erasure alert** (`still_pending` or `error` > 0 over N ticks → page the DPO/on-call); add to `docs/runbooks/cron-jobs.md` the new cron entry (path, cadence — e.g. */30 min, Bearer `CRON_SECRET`, kill-switch flag, the 500-on-error retry semantics). Commit.

```bash
git add tests/integration/members/reconcile-erasures.test.ts docs/observability.md docs/runbooks/cron-jobs.md
git commit -m "test(members): reconciler completes partial erasure e2e + observability docs (COMP-1 US2d)"
```

---

## Self-Review

**Spec coverage (§6 "reconciliation sweep" + "erasure_outcome metric + alert"):** the candidate query (`erased_at` set + no `member_erased`, tenant-filtered audit subqueries, `FOR UPDATE SKIP LOCKED`) → Task 2 ✓; re-drive via the idempotent `eraseMember` (no Art.12 restart, no double `member_erased`) → Task 3 + Task 4 ✓; `erasure_outcome` metric → Task 1, emitted per outcome in the loop → Task 3 ✓; stuck-erasure alert → Task 4 Step 3 (metric + observability doc) ✓; the cron mirrors the F7 reconcile route (auth, kill-switch, batch, split 200/500) → Task 3 ✓.

**Placeholders:** the `drizzleMemberRepo` import path is a "resolve to the real singleton" instruction (grep-located), not a TODO. The feature-flag step is conditional on whether one exists (checked first). No `0XXX` migration (env var only; no new audit event — F3 count stays 31). The e2e's `seedPartialErasure`/`driveReconcileOnce` helpers are described concretely (force a cascade fail / POST the route).

**Type consistency:** `findStuckErasuresInTx(tx, tenantSlug, limit) → {memberId, reason}[]` consistent Task 2 ↔ Task 3 (the loop destructures `{memberId, reason}`). `erasureMetrics.outcome(MemberErasureOutcome, tenantId)` consistent Task 1 ↔ Task 3. `eraseMember(memberId, {reason}, {actorUserId, requestId}, deps)` matches the real US1 signature; `cascadesComplete` (not `completed`) read from the result.

**Scope boundary:** US2d is the reconciler + metric only. It DEPENDS on the cascades existing (US2a F1, US2b F7, US2c F6 wired into `eraseMember`) — but it reconciles WHATEVER cascades are wired at the time (it re-drives the whole `eraseMember`), so it works even if only a subset of US2a-c has landed. Best executed last in the US2 sequence.
