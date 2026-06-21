# F7 Broadcast Send Hardening — PR-2 (ephemeral audience cleanup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop F7 from accumulating Resend audiences (defect #5: a new audience is created per broadcast and NEVER deleted → the tenant hits the Resend account's audience/segment plan limit). Add a `deleteAudience` gateway method and a cleanup cron that deletes a broadcast's Resend audience once the broadcast is TERMINAL, tracked idempotently by a new `audience_deleted_at` column — proven not to leak recipients across members and to leave the COMP-1 GDPR erasure cascade working.

**Architecture:** F7 already creates one ephemeral audience per broadcast (`dispatch-scheduled-broadcast.ts` createAudience → addContacts → createBroadcast → sendBroadcast, with the id persisted via `attachAudienceId`). The only missing half is deletion. We add `deleteAudience(audienceId)` to the gateway (mirrors `createAudience`; 404 = idempotent success), an `audience_deleted_at` column for idempotent tracking, a `cleanup-orphaned-audiences` use-case + cron (mirrors `reconcile-stuck-sending`) that deletes audiences for TERMINAL broadcasts past a grace window, and tests proving no cross-member leak and that GDPR erasure still works after cleanup.

**Tech Stack:** TypeScript strict, Vitest, Drizzle ORM + postgres-js (live Neon for integration), Resend SDK. No new npm deps.

## Global Constraints

- Package manager **pnpm**. Branch: `f7-broadcast-send-hardening-pr2` (worktree `wt-f7-pr2`, stacked off PR-1's tip `5c6926ee`). Do NOT touch other worktrees/branches.
- TDD: failing test → RED → implement → GREEN → commit. Conventional Commits.
- Clean Architecture (Principle III): the use-case imports no ORM/Resend types; the gateway owns Resend; the cron route is presentation.
- **Tenant isolation (Principle I)**: every repo query + the cleanup use-case run inside `runInTenant(ctx, tx => …)`; the new column inherits the broadcasts table's RLS+FORCE (no new policy needed, but the cleanup cron must resolve per-tenant context like `reconcile-stuck-sending`).
- **THE INVARIANT (idempotency gotcha)**: an audience may be DELETED only for a broadcast in a TERMINAL status (`sent`, `failed_to_dispatch`, `cancelled`, `rejected`, `partial_delivery_accepted`). A non-terminal broadcast (`approved`/`sending`) may still RETRY and REUSE its `resend_audience_id` (dispatch line ~533) — deleting it early would cause a `resource_missing` on the retry. The cleanup query MUST filter on terminal status.
- `deleteAudience` and all cleanup steps are **best-effort**: a failure logs + leaves `audience_deleted_at` NULL so the next cron tick retries; it never throws into a transition.
- Resend errors: 404 on a deleted audience = idempotent success; 5xx/network = retryable. `removeContactFromAudience` + `getAudienceContactCount` already treat 404 as success/not_found — do NOT regress that (it is what makes COMP-1 erasure tolerate a cleaned audience).
- Migration: determine the NEXT free Drizzle migration index from `drizzle/migrations/meta/_journal.json` (per the parallel-branch collision hazard — pick the next unused index, add a journal entry). Column add is `ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience_deleted_at TIMESTAMPTZ` (idempotent).
- Review gate: **≥2 reviewers, one signs the security checklist** — this touches recipient-email handling on the Resend sub-processor + the COMP-1 GDPR erasure surface (Principle I). The cross-member integration test (Task 5) is a Review-gate blocker.

---

## File Structure

**Create**
- `src/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences.ts` — the use-case.
- `tests/unit/broadcasts/application/cleanup-orphaned-audiences.test.ts`
- `src/app/api/cron/broadcasts/cleanup-audiences/route.ts` — the cron route.
- `tests/contract/broadcasts/cleanup-audiences-route.test.ts` (or unit) — auth + summary shape.
- `drizzle/migrations/NNNN_broadcasts_audience_deleted_at.sql` (+ snapshot + journal entry)
- `tests/integration/broadcasts/audience-cleanup.test.ts` — live-Neon: cleanup deletes a terminal broadcast's audience + marks it; skips non-terminal.
- `tests/integration/broadcasts/audience-cross-member-isolation.test.ts` — live-Neon: two members' concurrent dispatches use SEPARATE audiences; no recipient crosses members.
- `tests/integration/broadcasts/erasure-after-audience-cleanup.test.ts` — live-Neon: COMP-1 erasure cascade succeeds (404-tolerant) after the audience was cleaned.

**Modify**
- `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts` — add `deleteAudience`.
- `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` — implement `deleteAudience`.
- `tests/support/broadcasts/resend-contract-fake.ts` — add `audiences.remove` to the fake (+ optionally `delete`).
- `src/modules/broadcasts/infrastructure/schema.ts` — add `audienceDeletedAt` column.
- `src/modules/broadcasts/application/ports/broadcasts-repo.ts` + `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` — `markAudienceDeletedInTx` + `listTerminalBroadcastsWithLiveAudience`.
- `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` — compose the cleanup use-case for the cron.
- `docs/runbooks/cron-jobs.md` + `docs/go-live-readiness.md` — the new cron + ship checklist.

---

## Task 1: `deleteAudience` gateway method + contract-fake support

**Files:**
- Modify: `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts` (add `deleteAudience(audienceId: string): Promise<void>` near `createAudience`)
- Modify: `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` (implement it, mirroring `createAudience` lines ~191-209 + `removeContactFromAudience`'s 404-as-success at ~393-414)
- Modify: `tests/support/broadcasts/resend-contract-fake.ts` (add `audiences.remove(id)` to the fake client)
- Test: `tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts` (add deleteAudience cases) + extend `tests/unit/broadcasts/support/resend-contract-fake.test.ts`

**Interfaces:**
- Produces: `BroadcastsGatewayPort.deleteAudience(audienceId: string): Promise<void>` — resolves on success OR 404 (already gone); throws a retryable `GatewayThrowable` on 5xx/network (consumed best-effort by callers).

- [ ] **Step 1: Read the patterns.** Read `resend-broadcasts-gateway.ts` `createAudience` (~191-209), `removeContactFromAudience` (~393-414, note the 404→resolve at ~410-411), and the `getResendBroadcastsClient` mock seam in `tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts`. Confirm the Resend SDK delete method name (`sdk.audiences.remove(id)` — verify against `node_modules/resend` types; it returns `{ data, error }`).

- [ ] **Step 2: Write the failing gateway unit test** in `resend-remove-contact.test.ts`'s sibling style (new describe), mocking `getResendBroadcastsClient` → `{ audiences: { remove: removeAudMock } }`:
```ts
it('deleteAudience resolves on success', async () => {
  removeAudMock.mockResolvedValue({ data: { deleted: true, id: 'aud_1' }, error: null });
  await expect(resendBroadcastsGateway.deleteAudience('aud_1')).resolves.toBeUndefined();
  expect(removeAudMock).toHaveBeenCalledWith('aud_1'); // or { id: 'aud_1' } — match the SDK signature you verified
});
it('deleteAudience treats 404 (already gone) as success', async () => {
  removeAudMock.mockResolvedValue({ data: null, error: { statusCode: 404, message: 'not found' } });
  await expect(resendBroadcastsGateway.deleteAudience('gone')).resolves.toBeUndefined();
});
it('deleteAudience throws retryable on 5xx', async () => {
  vi.useFakeTimers();
  removeAudMock.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'down' } });
  const p = resendBroadcastsGateway.deleteAudience('aud_1');
  const a = expect(p).rejects.toMatchObject({ name: 'GatewayThrowable', kind: 'retryable' });
  await vi.runAllTimersAsync(); await a; vi.useRealTimers();
});
```

- [ ] **Step 3: Run RED** — `pnpm vitest run tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts` → FAIL (deleteAudience undefined).

- [ ] **Step 4: Add to the port** — in `broadcasts-gateway-port.ts`, add to the interface near `createAudience`:
```ts
  /**
   * Delete an ephemeral per-broadcast audience after the broadcast reaches a
   * terminal status (PR-2 #5 cleanup). Best-effort: 404 (already gone) resolves;
   * 5xx/network throw retryable so the cleanup cron retries next tick.
   */
  readonly deleteAudience: (audienceId: string) => Promise<void>;
```

- [ ] **Step 5: Implement in the gateway** — mirror `createAudience`'s `withRetry` wrapper; on the SDK result, treat 404 as success (return), else `classifyResendError(result.error, 'audience', audienceId)` (a 404 here means already-gone → but we short-circuit it BEFORE classify so it resolves; only non-404 errors throw):
```ts
  async deleteAudience(audienceId: string): Promise<void> {
    await withRetry(async () => {
      const sdk = client();
      const result = (await sdk.audiences.remove(audienceId)) as ResendSdkResponse<{ deleted: boolean; id: string }>;
      if (result.error) {
        if (result.error.statusCode === 404) {
          logger.info({ audienceId }, 'resend.broadcasts.audience_already_absent');
          return; // idempotent: already gone
        }
        throw classifyResendError(result.error, 'audience', audienceId);
      }
      logger.info({ audienceId }, 'resend.broadcasts.audience_deleted');
    }, { method: 'deleteAudience' });
  },
```

- [ ] **Step 6: Run GREEN** — the 3 gateway tests pass.

- [ ] **Step 7: Add `audiences.remove` to the contract-fake** — in `tests/support/broadcasts/resend-contract-fake.ts`, add to `ResendBroadcastsClientLike.audiences` and the impl: `remove(id: string): Promise<ResendResult<{ deleted: boolean; id: string }>>` returning `{ data: { deleted: true, id }, error: null }` for a known id (one previously created), and `{ data: null, error: { statusCode: 404, … } }` for an unknown id (so a double-delete is exercised). Track removed ids if useful. Add a case to `resend-contract-fake.test.ts` asserting remove of a created id succeeds and of an unknown id 404s.

- [ ] **Step 8: typecheck + lint + commit.** `pnpm typecheck` (0), `pnpm eslint <changed files>` (0).
```bash
git add src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts tests/support/broadcasts/resend-contract-fake.ts tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts tests/unit/broadcasts/support/resend-contract-fake.test.ts
git commit -m "feat(broadcasts): add deleteAudience gateway method (PR-2 #5)"
```

---

## Task 2: `audience_deleted_at` column + repo query/mark

**Files:**
- Create: `drizzle/migrations/NNNN_broadcasts_audience_deleted_at.sql` (+ the matching snapshot under `meta/` + a `_journal.json` entry — generate via `pnpm drizzle-kit generate` after the schema edit, OR hand-author following the latest migration's shape; verify the index is the next free one)
- Modify: `src/modules/broadcasts/infrastructure/schema.ts` (add `audienceDeletedAt: timestamp('audience_deleted_at', { withTimezone: true })`)
- Modify: `src/modules/broadcasts/application/ports/broadcasts-repo.ts` (add the two methods to the interface)
- Modify: `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` (implement them)
- Test: `tests/integration/broadcasts/audience-cleanup.test.ts` (live Neon)

**Interfaces:**
- Produces:
  - `listTerminalBroadcastsWithLiveAudience(tenantId, graceCutoff: Date, limit: number): Promise<ReadonlyArray<{ broadcastId: string; resendAudienceId: string }>>` — broadcasts in a terminal status with `resend_audience_id IS NOT NULL` AND `audience_deleted_at IS NULL` AND `updated_at < graceCutoff`.
  - `markAudienceDeletedInTx(tx, broadcastId): Promise<void>` — sets `audience_deleted_at = now()`.

- [ ] **Step 1: Add the column to the Drizzle schema** (`schema.ts`, in the `broadcasts` table definition, near `resendAudienceId`):
```ts
  audienceDeletedAt: timestamp('audience_deleted_at', { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration** — run `pnpm drizzle-kit generate` (it produces `drizzle/migrations/NNNN_*.sql` + updates `meta/`). If it conflicts or you hand-author, the SQL is:
```sql
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience_deleted_at TIMESTAMPTZ;
```
Confirm the chosen index is the next free one in `meta/_journal.json` (collision hazard — do not reuse an index another branch took).

- [ ] **Step 3: Apply + verify** — `pnpm drizzle-kit migrate` against live Neon (the column add is additive + idempotent). Confirm with a quick `\d broadcasts` style check or an integration read.

- [ ] **Step 4: Write the failing integration test** `tests/integration/broadcasts/audience-cleanup.test.ts` — follow the seeding harness in `tests/integration/broadcasts/dispatch-failure-notification.test.ts`. Seed (in `runInTenant`): a member + one broadcast with `status='failed_to_dispatch'`, `resend_audience_id='aud_seed_1'`, `audience_deleted_at=NULL`, `updated_at` 2h ago; and one broadcast with `status='approved'` (non-terminal) + a `resend_audience_id`. Assert `listTerminalBroadcastsWithLiveAudience(tenant, now()-1h, 50)` returns ONLY the failed one (terminal + past grace), NOT the approved one.

- [ ] **Step 5: Run RED** — `npx vitest run --config vitest.integration.config.ts tests/integration/broadcasts/audience-cleanup.test.ts` → FAIL (methods undefined).

- [ ] **Step 6: Implement the repo methods** in `drizzle-broadcasts-repo.ts`, inside `runInTenant`/`withTx` like the other methods. The terminal-status set:
```ts
const TERMINAL_WITH_AUDIENCE = ['sent', 'failed_to_dispatch', 'cancelled', 'rejected', 'partial_delivery_accepted'] as const;
```
`listTerminalBroadcastsWithLiveAudience`: `SELECT broadcast_id, resend_audience_id FROM broadcasts WHERE tenant_id = $t AND status::text IN (…) AND resend_audience_id IS NOT NULL AND audience_deleted_at IS NULL AND updated_at < $graceCutoff ORDER BY updated_at ASC LIMIT $limit`. `markAudienceDeletedInTx`: `UPDATE broadcasts SET audience_deleted_at = now() WHERE tenant_id = $t AND broadcast_id = $id`. Add both to the port interface.

- [ ] **Step 7: Run GREEN** + add a second assertion: after `markAudienceDeletedInTx`, the row no longer appears in the list (idempotency).

- [ ] **Step 8: typecheck + lint + commit.**
```bash
git add src/modules/broadcasts/infrastructure/schema.ts drizzle/migrations src/modules/broadcasts/application/ports/broadcasts-repo.ts src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts tests/integration/broadcasts/audience-cleanup.test.ts
git commit -m "feat(broadcasts): audience_deleted_at column + terminal-audience cleanup query (PR-2 #5)"
```

---

## Task 3: `cleanup-orphaned-audiences` use-case

**Files:**
- Create: `src/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences.ts`
- Create: `tests/unit/broadcasts/application/cleanup-orphaned-audiences.test.ts`

**Interfaces:**
- Produces: `cleanupOrphanedAudiences(deps, input: { graceMs: number; limit: number }): Promise<Result<{ processed: number; deleted: number; failed: number }, { kind: 'cleanup.server_error'; message: string }>>` where `deps = { tenant, broadcastsRepo, broadcastsGateway, clock, audit? }`. For each candidate: best-effort `gateway.deleteAudience(audienceId)`; on success `markAudienceDeletedInTx`; on throw, log + leave the row (retried next tick) and increment `failed`.

- [ ] **Step 1: Write the failing unit test** — mock `broadcastsRepo.listTerminalBroadcastsWithLiveAudience` to return 2 candidates; mock `broadcastsGateway.deleteAudience` to resolve for #1 and throw a retryable `GatewayThrowable` for #2; assert the result is `{ processed: 2, deleted: 1, failed: 1 }`, that `markAudienceDeletedInTx` was called for #1 only, and that the throw for #2 did NOT propagate (best-effort). Include a "0 candidates → {processed:0,deleted:0,failed:0}" case.

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** — compute `graceCutoff = new Date(clock.now().getTime() - input.graceMs)`; `runInTenant`: list candidates; for each, `try { await gateway.deleteAudience(c.resendAudienceId); await repo.markAudienceDeletedInTx(tx, c.broadcastId); deleted++ } catch (e) { logger.warn({ broadcastId, err }, 'broadcasts.audience_cleanup.delete_failed'); failed++ }`; return `ok({ processed, deleted, failed })`. Wrap unexpected errors in `err({ kind: 'cleanup.server_error', message })`. (Per `mock-only-tests-miss-throw-paths`: the per-item try/catch + the throw-path test in Step 1 are mandatory.)

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: typecheck + lint + commit.**
```bash
git add src/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences.ts tests/unit/broadcasts/application/cleanup-orphaned-audiences.test.ts
git commit -m "feat(broadcasts): cleanup-orphaned-audiences use-case (PR-2 #5)"
```

---

## Task 4: cleanup cron route + composition + runbook

**Files:**
- Create: `src/app/api/cron/broadcasts/cleanup-audiences/route.ts`
- Modify: `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` (compose the use-case + the per-tenant iteration, mirroring how `reconcile-stuck-sending` is composed)
- Modify: `docs/runbooks/cron-jobs.md`
- Test: `tests/contract/broadcasts/cleanup-audiences-route.test.ts`

- [ ] **Step 1: Read the template** — `src/app/api/cron/broadcasts/reconcile-stuck-sending/route.ts` + its deps composition. Capture: `verifyCronBearer(request.headers.get('authorization'), env.cron.secret)` → 401 on fail; the per-tenant loop; the JSON summary; the Node runtime pin if present.

- [ ] **Step 2: Write the failing route test** — POST without a valid Bearer → 401; POST with the right Bearer → 200 + a JSON body shaped `{ processed, deleted, failed }` (mock the use-case at the composition seam the same way the reconcile route test does).

- [ ] **Step 3: Run RED.**

- [ ] **Step 4: Implement the route** mirroring `reconcile-stuck-sending`: `export async function POST(request)`, verifyCronBearer guard, resolve the tenant list, run `cleanupOrphanedAudiences` per tenant with `{ graceMs: <e.g. 60*60*1000>, limit: <e.g. 200> }`, aggregate, return `NextResponse.json(summary)`. Compose deps in `broadcasts-deps.ts`.

- [ ] **Step 5: Run GREEN.**

- [ ] **Step 6: Runbook** — add a `cleanup-audiences` entry to `docs/runbooks/cron-jobs.md` (Bearer `CRON_SECRET`, suggested cadence e.g. */15, retry-OFF, purpose: bound the Resend audience count).

- [ ] **Step 7: typecheck + lint + commit.**
```bash
git add src/app/api/cron/broadcasts/cleanup-audiences/route.ts src/modules/broadcasts/infrastructure/broadcasts-deps.ts docs/runbooks/cron-jobs.md tests/contract/broadcasts/cleanup-audiences-route.test.ts
git commit -m "feat(broadcasts): cleanup-audiences cron route + runbook (PR-2 #5)"
```

---

## Task 5: COMP-1 erasure + cross-member isolation integration tests (Review-gate blocker)

**Files:**
- Create: `tests/integration/broadcasts/erasure-after-audience-cleanup.test.ts`
- Create: `tests/integration/broadcasts/audience-cross-member-isolation.test.ts`

- [ ] **Step 1: erasure-after-cleanup test** — read the COMP-1 erasure entrypoint (`subprocessor-erasure-adapter.ts` + `listMemberResendAudienceContactsInTx`). Seed a member + a broadcast whose `audience_deleted_at` is set (audience cleaned) with a `broadcast_deliveries` row for the member's email; drive the erasure cascade for that member with the contract-fake's `removeContactFromAudience` returning 404 (audience gone). Assert the cascade RESOLVES (treats 404 as success — the data is already erased at the sub-processor), no throw. This proves D4 (cleanup does not break GDPR erasure).

- [ ] **Step 2: cross-member isolation test** — seed two members (A, B) in the same tenant, each with an `approved` broadcast targeting only their own recipients. Drive both dispatches concurrently against the contract-fake (which records each `createAudience` + the contacts added per audience). Assert: two DISTINCT `resend_audience_id`s were created (one per broadcast), and the contacts added to A's audience are exactly A's recipients (no B recipient in A's audience, and vice-versa). This pins the ephemeral-per-broadcast design against any future regression to a shared audience (the cross-member PII-leak the single-reusable design would have had).

- [ ] **Step 3: Run both** — `npx vitest run --config vitest.integration.config.ts tests/integration/broadcasts/erasure-after-audience-cleanup.test.ts tests/integration/broadcasts/audience-cross-member-isolation.test.ts` → GREEN (live Neon).

- [ ] **Step 4: commit.**
```bash
git add tests/integration/broadcasts/erasure-after-audience-cleanup.test.ts tests/integration/broadcasts/audience-cross-member-isolation.test.ts
git commit -m "test(broadcasts): erasure-after-cleanup + cross-member audience isolation (PR-2 #5, Review-gate)"
```

---

## Task 6: Ship docs

**Files:**
- Modify: `docs/go-live-readiness.md`

- [ ] **Step 1:** under the F7 send-hardening section add checklist items: the `cleanup-audiences` cron is registered in cron-job.org (Bearer `CRON_SECRET`, */15, retry-OFF); confirm the Resend audience count stays bounded post-deploy (spot-check the Resend dashboard after the first cron runs). Note PR-2 closes defect #5; the COMP-1 erasure interaction is covered by the erasure-after-cleanup test.
- [ ] **Step 2: commit.**
```bash
git add docs/go-live-readiness.md
git commit -m "docs(broadcasts): F7 audience-cleanup cron ship checklist (PR-2)"
```

---

## Final verification (before opening the PR)
- [ ] `pnpm vitest run tests/unit/broadcasts tests/contract/broadcasts` GREEN.
- [ ] `npx vitest run --config vitest.integration.config.ts tests/integration/broadcasts` GREEN (live Neon).
- [ ] `pnpm typecheck` + `pnpm lint` clean.
- [ ] Open PR-2 → base `main` (or stacked on PR-1's branch until PR-1 merges). **≥2 reviewers, one signs the security checklist** (recipient-email sub-processor + COMP-1 GDPR surface); the cross-member isolation test is the Review-gate blocker.

## Self-review notes (author)
- Spec coverage: D2 ephemeral-cleanup = Tasks 1-4; D4 COMP-1 = Task 5 step 1 (the gateway already 404-tolerates, so this is a confirming test, not new code); the cross-member Review-gate test = Task 5 step 2; audience-count contract enforcement already exists from PR-1's fake (extended with `remove` here). The "audience-limit error classification" risk: the existing classifier maps Resend's plan-limit 4xx to `permanent` → `failed_to_dispatch`; with the cleanup cron keeping the count bounded this is acceptable, but note it in the PR body as a known behavior (a transient overflow surfaces as a failed dispatch until the cron frees room).
- Known reference-not-inline: the cron route + deps composition mirror `reconcile-stuck-sending` (read it rather than inlining its ~exact code); the migration index is determined at implementation time from `_journal.json`.
