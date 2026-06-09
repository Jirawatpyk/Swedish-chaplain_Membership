# F2 Plan-Change Listeners Post-Commit (Option A) Implementation Plan

> **For agentic workers:** Executed inline by the implementing engineer task-by-task (TDD). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move F8's F2→F8 manual-plan-change listeners (supersede pending tier-upgrade + reschedule renewal cadence) OUT of F3's `changeMemberPlan` transaction and run them POST-COMMIT, each in its own `runInTenant` tx, so an F8 bookkeeping failure can no longer poison the Postgres tx and roll back F3's plan-flip.

**Architecture:** F3's `changeMemberPlan` opens `runInTenant`, writes the plan-flip + audits, and commits. After the commit returns durably, it invokes the registered F8 listeners synchronously (await), each receiving the event ONLY (no F3 tx). The bridge callbacks call the non-`InTx` use-case variants (`supersedePendingTierUpgrade` / `rescheduleOnPlanChange`) which each open their OWN `runInTenant(deps.tenant, …)` (re-establishing RLS), return a `Result`, and never throw. The bridge inspects the Result, logs + bumps the existing failure counters on `!ok`, and swallows — now genuinely best-effort because the plan-flip is already committed.

**Tech Stack:** TypeScript strict, Drizzle ORM, Postgres RLS (`runInTenant`), Vitest (unit + live-Neon integration), pino logger, OTel `renewalsMetrics`.

---

## Consistency model note

- **Before:** F2 plan-flip + F8 bookkeeping shared one tx. A hard SQL failure in a listener poisoned the tx → COMMIT downgraded to ROLLBACK → the plan-flip was silently lost. The bridge's in-tx swallow could NOT prevent this (it only suppresses re-throw; it does not un-poison the connection).
- **After:** F2 plan-flip is atomic + durable on its own. F8 bookkeeping (supersede / reschedule) is post-commit eventual. A listener failure is logged + counted and leaves the (pre-existing, documented) supersede-orphan state for replay; it does NOT roll back the plan-flip.
- **Supersede-orphan gap** is PRE-EXISTING and documented (reconcile cron T185 covers the apply-at-renewal terminal-cycle path + a `manual_plan_change` divergence path via `orphan_member_plan_diverged`, but a failed supersede on a still-active cycle is not auto-reconciled). Option A does NOT make this worse — previously a failed supersede rolled back the plan-flip entirely, which is strictly worse. Extending the reconcile cron is OUT OF SCOPE (noted as follow-up).

## Mirror precedent

F4→F8 `apply-tier-upgrade-on-paid-callback.ts` already runs its F2 finaliser (`finaliseF2ScheduledPlanChangeForCycle`) POST-commit in its own `runInTenant`, log+counter+swallow. `reschedule-on-plan-change.ts` already partially worked around the poisoned-tx bug (Round 4 CRIT-1) by using `emit()` (own tx) for its audit writes — proof the team already hit this wall. Option A completes the fix uniformly.

---

## File Structure

- `src/modules/renewals/application/ports/manual-plan-change-event.ts` — `ManualPlanChangeListener` signature drops the `tx` param.
- `src/modules/members/application/use-cases/change-plan.ts` — move listener loop out of `runInTenant`; run post-commit; no `tx` passed; never re-throws; always returns `ok`.
- `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts` — callbacks take `(evt)` only; call non-`InTx` variants in their own tx; inspect Result; keep counters; rewrite comments.
- `tests/integration/renewals/manual-plan-change-post-commit.test.ts` — NEW: RED→GREEN proof that a failing F8 listener no longer rolls back the plan-flip + happy path.
- `tests/unit/members/application/change-plan-post-commit-listeners.test.ts` — NEW: unit proof the listener loop runs after the tx and a listener throw does not error the use-case.

---

### Task 1: Drop `tx` from the listener signature

**Files:**
- Modify: `src/modules/renewals/application/ports/manual-plan-change-event.ts`

- [ ] **Step 1: Change the `ManualPlanChangeListener` type to drop `tx`**

New body for the type + doc:

```ts
/**
 * Listener signature for F3's `changeMemberPlan` to invoke
 * POST-COMMIT. Each listener runs in its OWN tenant transaction
 * (re-establishing RLS) and is best-effort: a listener failure is
 * logged + counted by the F8 bridge and does NOT roll back F3's
 * already-committed plan-flip.
 */
export type ManualPlanChangeListener = (
  evt: ManualPlanChangeEvent,
) => Promise<void>;
```

Also update the `ManualPlanChangeEvent` doc comment to say the event is dispatched AFTER the F3 tx commits.

- [ ] **Step 2: typecheck** (deferred to Task 5 full gate — the consumers in Tasks 2-3 must change in lockstep).

---

### Task 2: Move the listener loop post-commit in `change-plan.ts`

**Files:**
- Modify: `src/modules/members/application/use-cases/change-plan.ts`

- [ ] **Step 1: Remove the in-tx listener block** (lines ~359-404, the `const listeners = …` through the `for (const listener …)` loop INSIDE `runInTenant`). The tx body ends at `return updated.value;`.

- [ ] **Step 2: Capture the locked old-plan id for the event** — the event needs `oldPlanId` which currently comes from `locked.planId` (read under FOR UPDATE inside the tx). Hoist a `let lockedOldPlanId: string` assigned inside the tx so it's available post-commit.

- [ ] **Step 3: After `runInTenant` returns successfully, run the listeners post-commit:**

```ts
    const updatedMember = await runInTenant(deps.tenant, async (tx) => {
      // … existing tx body … assign lockedOldPlanId = locked.planId as string
      return updated.value;
    });

    // F8 listeners run POST-COMMIT in their OWN tenant tx (best-effort).
    // The plan-flip above is durable; a listener failure is logged +
    // counted by the F8 bridge and does NOT roll the plan-flip back.
    const listeners = deps.manualPlanChangeListeners ?? [];
    if (listeners.length > 0) {
      const evt: ManualPlanChangeListenerEvent = {
        tenantId: deps.tenant.slug,
        memberId,
        oldPlanId: lockedOldPlanId,
        newPlanId: data.new_plan_id,
        actorUserId: meta.actorUserId,
        correlationId: meta.requestId,
        requestId: meta.requestId,
      };
      for (const listener of listeners) {
        try {
          await listener(evt);
        } catch (e) {
          // Defensive only — production F8 listeners (the bridge)
          // never throw (they catch + log + count internally). A
          // custom/test listener that bypasses that contract is
          // logged here but still does NOT fail the use-case: the
          // plan-flip is already committed.
          logger.error(
            {
              err: e instanceof Error ? e.message : String(e),
              tenantId: deps.tenant.slug,
              memberId,
            },
            '[change-plan] post-commit manualPlanChangeListener threw — plan-flip already committed; ignored',
          );
        }
      }
    }

    return ok(updatedMember);
```

- [ ] **Step 4: Update the doc comment** on the `ManualPlanChangeEvent` import block (lines ~63-74) and on `ChangePlanDeps.manualPlanChangeListeners` (lines ~105-114) to state the listeners run POST-COMMIT in their own tx (best-effort), removing the "runs inside the F3 tx so failures roll the F3 plan-change back per Principle VIII" claim.

- [ ] **Step 5:** typecheck deferred to Task 5.

---

### Task 3: Rewrite the bridge to own-tx, post-commit semantics

**Files:**
- Modify: `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts`

- [ ] **Step 1: Swap imports** — use the non-`InTx` variants:

```ts
import { supersedePendingTierUpgrade } from '../../application/use-cases/supersede-pending-tier-upgrade';
import { rescheduleOnPlanChange } from '../../application/use-cases/reschedule-on-plan-change';
```

Remove the `TenantTx` import (no longer needed).

- [ ] **Step 2: Rewrite `wrapListener`** to take `(listener, evt, fn)` where `fn(evt)` returns the use-case `Result`. On a thrown error OR `result.ok === false`, log + bump `renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId)`. Never re-throw:

```ts
async function wrapListener(
  listener: 'supersede' | 'reschedule',
  evt: ManualPlanChangeEvent,
  fn: (evt: ManualPlanChangeEvent) => Promise<{ ok: boolean; error?: unknown }>,
): Promise<void> {
  try {
    const result = await fn(evt);
    if (!result.ok) {
      logger.error(
        {
          err:
            result.error && typeof result.error === 'object' && 'message' in result.error
              ? String((result.error as { message: unknown }).message)
              : String(result.error),
          listener,
          tenantId: evt.tenantId,
          memberId: evt.memberId,
        },
        `[f8-onManualPlanChange] ${listener} listener returned err — post-commit; F2 plan-flip already durable; counter bumped, orphan left for replay`,
      );
      renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId);
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        listener,
        tenantId: evt.tenantId,
        memberId: evt.memberId,
      },
      `[f8-onManualPlanChange] ${listener} listener threw — post-commit; F2 plan-flip already durable; counter bumped, orphan left for replay`,
    );
    renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId);
  }
}
```

- [ ] **Step 3: Rewrite `f8OnManualPlanChangeCallbacks`** so each callback takes `(evt)` only and calls the non-`InTx` use-case (which opens its own `runInTenant`):

```ts
export function f8OnManualPlanChangeCallbacks(
  tenantId: string,
): ReadonlyArray<(evt: ManualPlanChangeEvent) => Promise<void>> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    async (evt) =>
      wrapListener('supersede', evt, (e) =>
        supersedePendingTierUpgrade(deps, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          manualChangeActorUserId: e.actorUserId,
          supersedingPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        }),
      ),
    async (evt) =>
      wrapListener('reschedule', evt, (e) =>
        rescheduleOnPlanChange(deps, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          oldPlanId: e.oldPlanId,
          newPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        }),
      ),
  ];
}
```

- [ ] **Step 4: Rewrite the file-level comment + factory comment** to the corrected semantics: listeners run POST-COMMIT in their own tx (best-effort); a failure is logged + counted and leaves the documented orphan state for reconcile/replay; it does NOT roll back the plan-flip (now genuinely true). Keep the POST-MVP-OBS-7 backlog note + both counters as alert signals. Remove the false "F3 tx commits even if F8 fails (via swallow inside the tx)" / "rolls the F3 plan-change back" claims.

- [ ] **Step 5:** typecheck deferred to Task 5.

---

### Task 4: Tests (TDD — RED first against current code, then GREEN)

**Files:**
- Create: `tests/integration/renewals/manual-plan-change-post-commit.test.ts`
- Create: `tests/unit/members/application/change-plan-post-commit-listeners.test.ts`

- [ ] **Step 1: Write the integration test** — seed a member with an `accepted_pending_apply` tier-upgrade suggestion on an active cycle (via accept), then call `changePlan` with a listener array whose FIRST listener FAILS (inject a supersede that throws/returns err) and assert: (a) the member's `plan_id` IS changed in `members`, (b) the `member_plan_manually_changed` audit row exists, (c) the use-case returned `ok`. The RED proof: run the SAME assertions against the OLD in-tx code (git stash the src changes) → plan UNCHANGED + use-case errored.

- [ ] **Step 2: Write the unit test** — `changePlan` with a stub `runInTenant` (or real-ish deps) where a listener throws → use-case returns `ok` + listener ran AFTER the tx committed.

- [ ] **Step 3: Run RED** against current code BEFORE applying Tasks 1-3 (use a worktree or commit-order). Confirm fail.

- [ ] **Step 4: Apply Tasks 1-3, run GREEN.**

- [ ] **Step 5: Update any existing test asserting in-tx listener rollback** to post-commit semantics (grep found none directly; verify).

---

### Task 5: Full verification gate

- [ ] eslint on touched files clean
- [ ] temp-tsconfig typecheck (excl `.next`, non-incremental) exit 0
- [ ] `pnpm check:dates`, `check:audit-events`, `check:audit-counts` green
- [ ] `pnpm vitest run tests/unit/renewals tests/unit/members` green
- [ ] `pnpm test:integration tests/integration/renewals/` + members change-plan integration green
- [ ] Commit on `063-renewal-audit-fixes`, stage only touched files.
