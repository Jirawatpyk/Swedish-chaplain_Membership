# COMP-1 US3-C — Sub-processor Erasure Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On member erasure, best-effort propagate the erasure to external sub-processors (Resend audiences the member received broadcasts in; Stripe = pure no-op today), recording the outcome in a new `subprocessor_erasure_propagated` audit for the DPO trail.

**Architecture:** A new `SubprocessorErasurePort` (members/application) + adapter (members/infrastructure), wired into `eraseMember` as a post-commit cascade between the F6 fan-out (`erase-member.ts:833`) and the `member_erased` completion gate (`erase-member.ts:835`). The Resend arm best-effort removes the member's email from each audience it received a broadcast in; the audience↔email pairs are **captured inside the atomic scrub tx** (before the US2b delivery tombstone redacts `recipient_email_lower`) and threaded to the post-commit cascade. The Stripe arm is a pure no-op (no member↔customer model exists; zero payments symbols imported). A new audit type + one `ALTER TYPE` migration.

**Tech Stack:** TypeScript strict, Drizzle, Resend SDK (`contacts.remove`), the existing broadcasts Resend gateway (`resendBroadcastsGateway`, barrel-exported), Vitest + live-Neon integration + Playwright e2e.

---

## Grounding corrections to the 2026-06-19 design (READ FIRST)

The design (`docs/superpowers/specs/2026-06-19-member-erasure-us3-bcde-design.md` § US3-C) was written before the US2b 2nd-/code-review **atomic-move** of the delivery tombstone landed. Two of its assumptions are now wrong against `main`; this plan corrects them and **flags both for plan-review sign-off**:

1. **Audience derivation CANNOT happen post-commit.** The design (line 39) says the adapter "derives the member's audiences from the member's broadcast-delivery history (delivery → broadcast → `resend_audience_id`)." But the US2b delivery tombstone now runs **inside the atomic scrub tx** (`erase-member.ts:378`), redacting `broadcast_deliveries.recipient_email_lower` → `'[redacted]'`, and `recipient_member_id` is **always NULL in production** (US2b keystone finding). So by post-commit time BOTH join keys are destroyed. **Correction:** capture the `(resend_audience_id, recipient_email_lower)` pairs **inside the atomic tx, BEFORE the tombstone** (line 378), and thread them to the post-commit cascade. (Mirrors how US2b captures `contactEmailsForCancel` at `erase-member.ts:361` before the tombstone.)

2. **A reconciler re-drive cannot retry the Resend removal** (the captured pairs are destroyed by the same erasure → a US2d re-drive re-captures an empty set). The design (line 37) says "any non-`ok` flips `allCascadesClean`, the reconciler re-drives on failure." But the re-drive is **vacuous** (empty input → no-op `ok`), so blocking `member_erased` would only delay it one reconciler tick and then emit it anyway — while polluting the DPO log with a misleading second (vacuous-`ok`) audit. **Correction (recommended, flagged):** make the cascade **non-blocking** — emit `subprocessor_erasure_propagated` with the real outcome + fire a metric for alerting, but do NOT flip `allCascadesClean`. `member_erased` reflects that the controller's authoritative copy is erased; the best-effort sub-processor propagation is tracked by its own audit + alert + runbook (US3-E). **This deviates from the 6-specialist design and changes the meaning of the `member_erased` completion proof — it MUST be signed off by the security-engineer + pdpa-gdpr-compliance-officer at plan-review.** If they prefer the design's blocking model, swap Task 5's gating (see Task 5 § Gating alternative).

Everything else follows the design: `SubprocessorErasurePort` + adapter, Stripe pure no-op, Resend best-effort, new audit type + one migration, idempotent.

---

## File Structure

**Create:**
- `drizzle/migrations/0228_subprocessor_erasure_propagated_audit.sql` — `ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'subprocessor_erasure_propagated'`.
- `src/modules/members/application/ports/subprocessor-erasure-port.ts` — `SubprocessorErasurePort` + `SubprocessorErasureResult` + input type.
- `src/modules/members/application/ports/broadcasts-audience-derivation-port.ts` — `BroadcastsAudienceDerivationPort` (in-tx read of the member's `(audienceId, email)` pairs).
- `src/modules/members/infrastructure/adapters/subprocessor-erasure-adapter.ts` — the adapter (Stripe no-op + Resend best-effort).
- `src/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter.ts` — forwards the members tx to the broadcasts barrel method.
- `tests/unit/members/application/subprocessor-erasure-adapter.test.ts`
- `tests/integration/members/subprocessor-erasure.test.ts`
- `tests/integration/members/erase-member-subprocessor-cascade.test.ts` (capstone + cross-tenant + re-drive)

**Modify:**
- `src/modules/members/application/ports/audit-port.ts:69` — add `| 'subprocessor_erasure_propagated'` to `F3AuditEventType`.
- `src/modules/auth/infrastructure/db/schema.ts` — add `'subprocessor_erasure_propagated'` to the shared `audit_event_type` pgEnum tuple.
- `tests/unit/members/application/f3-audit-event-type-count.test.ts:54` + `:71,:74` — add the value to the tuple + bump `toBe(31)` → `toBe(32)`.
- **NOT** `tests/integration/audit/completeness.test.ts` — plan-review (drizzle) verified that test iterates the **F1** `AUDIT_EVENT_TYPES` domain tuple (length 33); an **F3-only** event (like `member_erased`) is intentionally absent from it, so it stays at 33. Bumping it would turn it RED. The f3-count test is the real guard.
- `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts` — add `removeContactFromAudience(audienceId, email)` to `BroadcastsGatewayPort`.
- `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` — implement `removeContactFromAudience`.
- `src/modules/broadcasts/application/ports/broadcasts-repo.ts` + `.../db/drizzle-broadcasts-repo.ts` — add `listMemberResendAudienceContactsInTx` (or a sibling repo); export a barrel-callable for the members adapter.
- `src/modules/broadcasts/index.ts` — export the new audience-derivation barrel method.
- `src/modules/members/application/use-cases/erase-member.ts` — surface `capturedSubprocessorPairs` from the atomic tx; add the in-tx pair capture before the tombstone; add the post-commit cascade + audit; extend `EraseMemberDeps`.
- `src/modules/members/members-deps.ts:186` — wire the two new adapters into `buildEraseMemberDeps`.
- `src/lib/metrics.ts` — add `memberSubprocessorErasure(resendOutcome, tenantId)` → `member_subprocessor_erasure_total`.
- `docs/runbooks/cron-jobs.md` (or a new `docs/runbooks/member-erasure.md`) — the `resend_outcome=failed` alert + manual-remediation procedure.

---

## Task 1: New audit type `subprocessor_erasure_propagated` (4-place + migration)

**Files:**
- Create: `drizzle/migrations/0228_subprocessor_erasure_propagated_audit.sql`
- Modify: `drizzle/migrations/meta/_journal.json`, `src/modules/members/application/ports/audit-port.ts:69`, `src/modules/auth/infrastructure/db/schema.ts`, `tests/unit/members/application/f3-audit-event-type-count.test.ts`
- Do NOT modify `tests/integration/audit/completeness.test.ts` (F1-tuple-only, stays at 33 — see plan-review BLOCKING-1).

- [ ] **Step 1: Write the failing count test first**

In `tests/unit/members/application/f3-audit-event-type-count.test.ts`, add `'subprocessor_erasure_propagated'` to the `F3_AUDIT_EVENTS` tuple (after `'member_erased'`, line 54) and change the assertion (`:71`, `:74`):

```ts
  // COMP-1 US3-C (migration 0228) — best-effort sub-processor erasure
  // propagation outcome (Resend audience contact removal + Stripe no-op).
  'subprocessor_erasure_propagated',
] as const;
// ...
  it('F3 audit event type count is 32 (31 prior + subprocessor_erasure_propagated)', () => {
    expect(_).toBe(true);
    expect(F3_AUDIT_EVENTS.length).toBe(32);
  });
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm vitest run tests/unit/members/application/f3-audit-event-type-count.test.ts`
Expected: FAIL — `_AssertF3Coverage` resolves to `never` (TS2322) because the union has no `subprocessor_erasure_propagated` yet, and `length` is 32 vs union-31.

- [ ] **Step 3: Add the value to the F3 union**

In `src/modules/members/application/ports/audit-port.ts`, after `| 'member_erased'` (line 69):

```ts
  | 'member_erased'
  // COMP-1 US3-C (migration 0228) — best-effort sub-processor erasure
  // propagation. Payload: { member_id, reason, resend_outcome,
  // resend_contacts_removed_count, resend_contacts_failed_count,
  // stripe_outcome } — ids + outcomes ONLY, never erased PII. 5y retention.
  | 'subprocessor_erasure_propagated';
```

- [ ] **Step 4: Add the value to the shared pgEnum**

In `src/modules/auth/infrastructure/db/schema.ts`, add `'subprocessor_erasure_propagated'` to the `audit_event_type` pgEnum tuple (alongside the existing `member_erased`/`event_buyer_pii_redacted` values). Keep alphabetical/grouped consistency with the surrounding entries.

- [ ] **Step 5: Author the migration**

Create `drizzle/migrations/0228_subprocessor_erasure_propagated_audit.sql`:

```sql
-- COMP-1 US3-C — best-effort sub-processor erasure propagation audit type.
-- ADD VALUE is transactional-safe in PG16; IF NOT EXISTS makes a re-apply a no-op.
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'subprocessor_erasure_propagated';
```

Hand-append the journal entry to `drizzle/migrations/meta/_journal.json` (idx 228, `version` matching the sibling entries, a `when` timestamp strictly greater than 0227's — hand-assign `1798535700000`, i.e. 0227's `when` + 100000, per the [[reference_parallel_branch_migration_number_collision]] convention). No snapshot regen needed for an enum-only `ADD VALUE`.

- [ ] **Step 6: Apply the migration + verify**

Run: `pnpm drizzle-kit migrate` (applies 0228 to live Neon — per [[feedback_migration_apply_before_commit]]).
Then: `pnpm vitest run tests/unit/members/application/f3-audit-event-type-count.test.ts` → GREEN.
Then verify `tests/integration/audit/completeness.test.ts` **still passes at 33** (it must NOT change — F3-only event):
`pnpm vitest run --config vitest.integration.config.ts tests/integration/audit/completeness.test.ts` → GREEN, unchanged.

- [ ] **Step 7: Commit**

```bash
git add drizzle/migrations/0228_subprocessor_erasure_propagated_audit.sql drizzle/migrations/meta/_journal.json src/modules/members/application/ports/audit-port.ts src/modules/auth/infrastructure/db/schema.ts tests/unit/members/application/f3-audit-event-type-count.test.ts
git commit -m "feat(members): register subprocessor_erasure_propagated audit type (COMP-1 US3-C)"
```

---

## Task 2: Resend gateway `removeContactFromAudience` wrapper

**Files:**
- Modify: `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts`, `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts`
- Test: `tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts` (create)

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const removeMock = vi.fn();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => ({ contacts: { remove: removeMock } }),
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

describe('resendBroadcastsGateway.removeContactFromAudience', () => {
  beforeEach(() => removeMock.mockReset());

  it('resolves on a successful removal', async () => {
    removeMock.mockResolvedValue({ data: { deleted: true }, error: null });
    await expect(
      resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@x.io'),
    ).resolves.toBeUndefined();
    expect(removeMock).toHaveBeenCalledWith({ audienceId: 'aud_1', email: 'a@x.io' });
  });

  it('treats a 404 (contact/audience already absent) as success', async () => {
    removeMock.mockResolvedValue({ data: null, error: { statusCode: 404, message: 'not found' } });
    await expect(
      resendBroadcastsGateway.removeContactFromAudience('aud_1', 'gone@x.io'),
    ).resolves.toBeUndefined();
  });

  it('throws a retryable GatewayThrowable on a 5xx (after exhausting the retry budget)', async () => {
    // `withRetry` retries 5× with real setTimeout backoff (1+2+4+8+16s). Use
    // fake timers so the test does not hang ~31s — `mockResolvedValue` keeps
    // returning the 503 so every attempt fails, then the final throw surfaces.
    vi.useFakeTimers();
    removeMock.mockResolvedValue({ data: null, error: { statusCode: 503, message: 'down' } });
    const p = resendBroadcastsGateway.removeContactFromAudience('aud_1', 'a@x.io');
    const assertion = expect(p).rejects.toMatchObject({ name: 'GatewayThrowable', kind: 'retryable' });
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it — expect RED** (`removeContactFromAudience is not a function`).

Run: `pnpm vitest run tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts`

- [ ] **Step 3: Add the port method**

In `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts`, add to `BroadcastsGatewayPort`:

```ts
  /**
   * COMP-1 US3-C — best-effort removal of a contact from an audience on
   * member erasure. A 404 (contact or audience already absent) resolves
   * (idempotent); a 5xx / network error throws a retryable GatewayThrowable
   * so the caller can classify it as a propagation failure.
   */
  removeContactFromAudience(audienceId: string, email: string): Promise<void>;
```

- [ ] **Step 4: Implement it in the gateway**

In `resend-broadcasts-gateway.ts`, add to the `resendBroadcastsGateway` object (after `retrieveBroadcast`), reusing `withRetry` + `classifyResendError`:

```ts
  async removeContactFromAudience(audienceId: string, email: string): Promise<void> {
    try {
      await withRetry(
        async () => {
          const sdk = client();
          const result = (await sdk.contacts.remove({
            audienceId,
            email,
          })) as ResendSdkResponse<{ deleted: boolean }>;
          if (result.error) {
            throw classifyResendError(result.error ?? undefined, 'audience', audienceId);
          }
        },
        { method: 'removeContactFromAudience' },
      );
      logger.info({ audienceId }, 'resend.broadcasts.contact_removed');
    } catch (e) {
      // A 404 → the contact/audience is already gone → erasure goal already met.
      if (e instanceof GatewayThrowable && e.kind === 'resource_missing') return;
      throw e;
    }
  },
```

- [ ] **Step 5: Run the test — GREEN.**

- [ ] **Step 6: Commit**

```bash
git add src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts
git commit -m "feat(broadcasts): removeContactFromAudience gateway wrapper (COMP-1 US3-C)"
```

---

## Task 3: In-tx audience↔email pair capture (broadcasts read + members port)

**Files:**
- Modify: `src/modules/broadcasts/application/ports/broadcasts-repo.ts`, `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts`, `src/modules/broadcasts/index.ts`
- Create: `src/modules/members/application/ports/broadcasts-audience-derivation-port.ts`, `src/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter.ts`
- Test: `tests/integration/broadcasts/list-member-resend-audience-contacts.test.ts` (create)

> **Design note (Clean Architecture, plan-review-decided):** this is a SEPARATE in-tx read, NOT folded into the US2b `tombstoneDeliveriesInTx` RETURNING. Plan-review (chamber-os-architect) ruled the fold-in is the WRONG call: it would pull a members/subprocessor concern into a broadcasts-owned method + couple US3-C to US2b shipped code. The extra in-tx `SELECT DISTINCT` on the member's (few) deliveries is negligible. Keep it separate.

- [ ] **Step 1: Write the failing integration test** (live Neon)

```ts
// tests/integration/broadcasts/list-member-resend-audience-contacts.test.ts
// Seed: a tenant (note its `tenant_id` column stores the SLUG — pass slug, not
// uuid) + a member with a live contact email E; a broadcast B with
// resend_audience_id 'aud_X'; a broadcast_delivery row (broadcast_id=B,
// recipient_email_lower=E, recipient_member_id=NULL — production shape).
// Assert: listMemberResendAudienceContactsInTx(tx, slug, [E]) === [{ audienceId:'aud_X', email:E }]
//   → and explicitly assert the result is NON-EMPTY for a populated member (a
//     silent [] would make the post-commit cascade a false-clean no-op).
// BLOCKING-3 regression: pass a MIXED-CASE input ('E.toUpperCase()') and assert
//   it STILL matches the lower-cased delivery row (the lower-case+de-dupe guard).
// Also assert: a broadcast with resend_audience_id NULL yields no pair; an email
// not in any delivery yields []; cross-tenant deliveries are excluded (the
// tenant_id filter — seed a 2nd tenant with the same email E, assert it's absent).
```
(Full seed mirrors `tests/integration/invoicing/redact-expired-member-invoices.test.ts` fixture style — reuse the integration harness's `runInTenant`.)

- [ ] **Step 2: Run — expect RED** (method does not exist).

- [ ] **Step 3: Add the broadcasts repo method**

In `drizzle-broadcasts-repo.ts`, add (raw SQL; `tenant_id` filter is load-bearing — `broadcast_deliveries` RLS is FORCE but the explicit filter is belt-and-suspenders + scopes the join):

```ts
async listMemberResendAudienceContactsInTx(
  tx: TenantTx,
  tenantSlug: string,
  emails: readonly string[],
): Promise<ReadonlyArray<{ audienceId: string; email: string }>> {
  // Parity with the other raw-SQL broadcasts in-tx reads (refuse an unbound /
  // wrong-tenant tx — defence in depth above the explicit tenant_id filter + RLS).
  assertTenantBoundTx(tx, tenantSlug, 'listMemberResendAudienceContactsInTx');
  // BLOCKING-3 (plan-review): recipient_email_lower is ALWAYS lower-cased;
  // contact emails are case-PRESERVED in storage. Lower-case + de-dupe before
  // matching, else a `Mixed.Case@x.io` contact misses its own delivery →
  // its audience is missed → the member's contact SURVIVES in a Resend
  // audience (the US2b coverage-survival class). Mirror US2b's `lowered` set.
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (lowered.length === 0) return [];
  // BLOCKING-2 (plan-review): bind as ARRAY[...]::text[] (the repo idiom), NOT
  // `= ANY(${emails})` — a raw JS array through the Neon serverless driver hits
  // the "argument must be of type string" class (see this repo's L983-987 note).
  const rows = (await tx.execute(sql`
    SELECT DISTINCT b.resend_audience_id AS audience_id, d.recipient_email_lower AS email
    FROM broadcast_deliveries d
    JOIN broadcasts b ON b.broadcast_id = d.broadcast_id
    WHERE d.tenant_id = ${tenantSlug}
      AND d.recipient_email_lower = ANY(ARRAY[${sql.join(lowered.map((e) => sql`${e}`), sql`, `)}]::text[])
      AND b.resend_audience_id IS NOT NULL
  `)) as unknown as Array<{ audience_id: string; email: string }>;
  return rows.map((r) => ({ audienceId: r.audience_id, email: r.email }));
}
```
Add the signature to `broadcasts-repo.ts` (the `BroadcastsRepo` interface) and a barrel-callable wrapper in `src/modules/broadcasts/index.ts`:

```ts
// COMP-1 US3-C — in-tx capture of the (resend audience, recipient email) pairs
// for a member's received broadcasts, called from the members atomic erase tx
// BEFORE the US2b delivery tombstone redacts recipient_email_lower.
export { listMemberResendAudienceContactsInTx } from './infrastructure/db/drizzle-broadcasts-repo';
```
(If the repo is factory-style `makeDrizzleBroadcastsRepo`, expose a thin free-function `listMemberResendAudienceContactsInTx(tx, slug, emails)` that constructs/uses it — mirror the existing barrel pattern for the cross-module in-tx reads.)

- [ ] **Step 4: Members port + adapter**

`src/modules/members/application/ports/broadcasts-audience-derivation-port.ts`:

```ts
import type { TenantTx } from '@/lib/db';

/** COMP-1 US3-C — in-tx read of the (Resend audience, email) pairs the member
 *  received broadcasts in. Called inside eraseMember's atomic scrub tx, BEFORE
 *  the delivery tombstone redacts the emails. ZERO broadcasts imports leak —
 *  the adapter forwards the tx to the broadcasts barrel.
 *  NB: distinct name from the broadcasts gateway's `AudienceContact` (different
 *  shape) to avoid a cross-module type-name collision (plan-review NIT). */
export interface SubprocessorAudienceContact {
  readonly audienceId: string;
  readonly email: string;
}
export interface BroadcastsAudienceDerivationPort {
  listMemberAudienceContactsInTx(
    tx: TenantTx,
    tenantSlug: string,
    emails: readonly string[],
  ): Promise<ReadonlyArray<SubprocessorAudienceContact>>;
}
```

`src/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter.ts`:

```ts
import { listMemberResendAudienceContactsInTx } from '@/modules/broadcasts';
import type { BroadcastsAudienceDerivationPort } from '../../application/ports/broadcasts-audience-derivation-port';

export const broadcastsAudienceDerivationAdapter: BroadcastsAudienceDerivationPort = {
  listMemberAudienceContactsInTx: (tx, tenantSlug, emails) =>
    listMemberResendAudienceContactsInTx(tx, tenantSlug, emails),
};
```

- [ ] **Step 5: Run the integration test — GREEN.**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/broadcasts/list-member-resend-audience-contacts.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/modules/broadcasts/application/ports/broadcasts-repo.ts src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts src/modules/broadcasts/index.ts src/modules/members/application/ports/broadcasts-audience-derivation-port.ts src/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter.ts tests/integration/broadcasts/list-member-resend-audience-contacts.test.ts
git commit -m "feat(members): in-tx Resend audience-contact derivation for erasure (COMP-1 US3-C)"
```

---

## Task 4: `SubprocessorErasurePort` + adapter (Stripe no-op + Resend best-effort)

**Files:**
- Create: `src/modules/members/application/ports/subprocessor-erasure-port.ts`, `src/modules/members/infrastructure/adapters/subprocessor-erasure-adapter.ts`
- Modify: `src/lib/metrics.ts`
- Test: `tests/unit/members/application/subprocessor-erasure-adapter.test.ts`

- [ ] **Step 1: Port + result types**

`subprocessor-erasure-port.ts`:

```ts
export type SubprocessorResendOutcome = 'ok' | 'partial' | 'failed';

/** Stripe is a pure no-op TODAY (no member↔customer model). Typed as a literal
 *  so a future customer-erasure path widens it explicitly. */
export interface SubprocessorErasureResult {
  readonly resendOutcome: SubprocessorResendOutcome;
  readonly resendContactsRemoved: number;
  readonly resendContactsFailed: number;
  readonly stripeOutcome: 'ok';
}

export interface SubprocessorErasureInput {
  readonly memberId: string;
  readonly reason: string;
  /** (audience, email) pairs captured in the atomic scrub tx (pre-redaction). */
  readonly audienceContacts: ReadonlyArray<{ audienceId: string; email: string }>;
  readonly tenantSlug: string;
  readonly requestId: string;
}

/** Best-effort — NEVER throws (mirrors the F6/F7 cascade ports). */
export interface SubprocessorErasurePort {
  propagate(input: SubprocessorErasureInput): Promise<SubprocessorErasureResult>;
}
```

- [ ] **Step 2: Write the failing adapter unit test**

```ts
// tests/unit/members/application/subprocessor-erasure-adapter.test.ts
// Mock @/modules/broadcasts → { resendBroadcastsGateway: { removeContactFromAudience } }.
// Cases:
//  1. no pairs → { resendOutcome:'ok', resendContactsRemoved:0, resendContactsFailed:0, stripeOutcome:'ok' } + gateway NOT called.
//  2. 2 pairs both resolve → resendContactsRemoved:2, resendOutcome:'ok'.
//  3. 1 of 2 rejects (retryable) → resendContactsRemoved:1, resendContactsFailed:1, resendOutcome:'partial'.
//  4. all reject → resendOutcome:'failed'.
//  5. an already-removed contact (gateway resolves on 404) counts as removed/ok.
// Assert the adapter NEVER throws even when the gateway throws.
```

- [ ] **Step 3: Run — RED.**

- [ ] **Step 4: Implement the adapter**

`subprocessor-erasure-adapter.ts`:

```ts
import { resendBroadcastsGateway } from '@/modules/broadcasts';
import { logger } from '@/lib/logger';
import type {
  SubprocessorErasurePort,
  SubprocessorErasureResult,
} from '../../application/ports/subprocessor-erasure-port';

export const subprocessorErasureAdapter: SubprocessorErasurePort = {
  async propagate(input): Promise<SubprocessorErasureResult> {
    // ── Stripe arm: PURE no-op (Principle IV / architect S1). No member↔Stripe-
    // customer model exists; payments are ad-hoc Payment Intents. ZERO payments
    // symbols imported. Future-proofing: when a member↔customer model is added,
    // add a `customerErasure` use-case INSIDE the payments module + export it
    // from the payments barrel; call THAT here — never import payments infra.
    const stripeOutcome = 'ok' as const;

    // ── Resend arm: best-effort remove each captured (audience, email) pair.
    let removed = 0;
    let failed = 0;
    for (const { audienceId, email } of input.audienceContacts) {
      try {
        await resendBroadcastsGateway.removeContactFromAudience(audienceId, email);
        removed += 1; // includes a 404 (already absent) — the gateway resolves.
      } catch (e) {
        failed += 1;
        logger.warn(
          {
            memberId: input.memberId,
            requestId: input.requestId,
            audienceId, // NEVER the email — forbidden-fields hygiene.
            errKind: e instanceof Error ? e.constructor.name : 'unknown',
            cascade: 'subprocessor_resend',
          },
          'erase-member: subprocessor Resend contact removal failed',
        );
      }
    }

    const resendOutcome =
      failed === 0 ? 'ok' : removed === 0 ? 'failed' : 'partial';
    return { resendOutcome, resendContactsRemoved: removed, resendContactsFailed: failed, stripeOutcome };
  },
};
```

- [ ] **Step 5: Add the metric**

In `src/lib/metrics.ts`, add (mirror `memberDocumentPiiRedacted` from US3-B):

```ts
/** COMP-1 US3-C — sub-processor erasure propagation outcome, per tenant.
 *  A `failed`/`partial` value should page the DPO runbook (US3-E). */
memberSubprocessorErasure(resendOutcome: 'ok' | 'partial' | 'failed', tenantId: string): void {
  safeMetric(() => counter('member_subprocessor_erasure_total', { resend_outcome: resendOutcome, tenant: tenantId }).add(1));
},
```

- [ ] **Step 6: Run — GREEN. Commit**

```bash
git add src/modules/members/application/ports/subprocessor-erasure-port.ts src/modules/members/infrastructure/adapters/subprocessor-erasure-adapter.ts src/lib/metrics.ts tests/unit/members/application/subprocessor-erasure-adapter.test.ts
git commit -m "feat(members): subprocessor erasure adapter — Stripe no-op + Resend best-effort (COMP-1 US3-C)"
```

---

## Task 5: Wire the cascade into `eraseMember`

**Files:**
- Modify: `src/modules/members/application/use-cases/erase-member.ts`, `src/modules/members/members-deps.ts`
- Test: `tests/integration/members/subprocessor-erasure.test.ts`

- [ ] **Step 1: Extend `EraseMemberDeps`** (in `erase-member.ts`, near the existing `broadcastsDeliveryTombstone`/`eventRegistrationErasure` deps):

```ts
  readonly broadcastsAudienceDerivation: BroadcastsAudienceDerivationPort;
  readonly subprocessorErasure: SubprocessorErasurePort;
```
(import the two port types at the top.)

- [ ] **Step 2: Capture the pairs IN the atomic tx, BEFORE the tombstone**

In the atomic scrub tx, immediately after `contactEmailsForCancel` is read (`erase-member.ts:361-362`) and BEFORE the delivery tombstone (`:378`):

```ts
      // COMP-1 US3-C — capture the (Resend audience, email) pairs the member
      // received broadcasts in, WHILE the emails are still live (the tombstone
      // below redacts recipient_email_lower; recipient_member_id is always
      // NULL). Surfaced to the post-commit subprocessor cascade — it cannot be
      // re-derived post-scrub.
      // M-1 (plan-review, DELIBERATE asymmetry — do NOT "simplify" to best-effort):
      // this in-tx CAPTURE is FAIL-LOUD (throw → rolls back the whole erasure),
      // while the post-commit Resend REMOVAL (below) is best-effort/non-blocking.
      // Rationale: a derivation-read failure means we don't KNOW the member's
      // audiences → proceeding would silently under-propagate; better to abort +
      // let the reconciler retry the WHOLE erasure (the read is re-drivable while
      // contacts are still live). Once the inputs are captured, the external
      // removal is genuinely best-effort (its inputs don't survive a re-drive).
      capturedSubprocessorPairs =
        await deps.broadcastsAudienceDerivation.listMemberAudienceContactsInTx(
          tx,
          deps.tenant.slug,
          contactEmailsForCancel,
        );
```
Declare `let capturedSubprocessorPairs: ReadonlyArray<{ audienceId: string; email: string }> = [];` in the outer scope (next to `let tombstonedDeliveriesCount = 0;` at `:300`).

- [ ] **Step 3: Post-commit cascade — between F6 (`:833`) and the member_erased gate (`:835`)**

```ts
  // COMP-1 US3-C — best-effort sub-processor erasure propagation. NON-BLOCKING
  // (does NOT flip allCascadesClean): the Resend-removal inputs were captured
  // only in the first-pass atomic tx and are destroyed by this same erasure, so
  // a US2d reconciler re-drive re-captures an EMPTY set and cannot retry. The
  // outcome is recorded in `subprocessor_erasure_propagated` + a metric for the
  // DPO alert/runbook (US3-E). member_erased reflects the controller's
  // authoritative-copy erasure; sub-processor propagation is tracked separately.
  // Adapter never throws; the defensive catch mirrors the other cascades.
  try {
    const sub = await deps.subprocessorErasure.propagate({
      memberId,
      reason,
      audienceContacts: capturedSubprocessorPairs,
      tenantSlug: deps.tenant.slug,
      requestId: meta.requestId,
    });
    memberSubprocessorErasure(sub.resendOutcome, deps.tenant.slug);
    await runInTenant(deps.tenant, async (tx) => {
      const done = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'subprocessor_erasure_propagated',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `subprocessor_erasure_propagated ${memberId}`,
        payload: {
          member_id: memberId,
          reason,
          resend_outcome: sub.resendOutcome,
          resend_contacts_removed_count: sub.resendContactsRemoved,
          resend_contacts_failed_count: sub.resendContactsFailed,
          stripe_outcome: sub.stripeOutcome,
        },
      });
      if (!done.ok) throw new Error('subprocessor_audit_failed');
    });
  } catch (cascadeErr) {
    // The audit-emit (not the propagation) failed → log; do NOT block
    // member_erased (the propagation outcome is lost from the trail but the
    // erasure is authoritative). The metric above still fired.
    logger.error(
      { err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr), memberId, requestId: meta.requestId, cascade: 'subprocessor_erasure' },
      'erase-member: subprocessor cascade audit failed',
    );
  }
```
(import `memberSubprocessorErasure` from `@/lib/metrics`.)

> **Gating alternative (if plan-review rejects non-blocking):** wrap the propagate result with `if (sub.resendOutcome !== 'ok') allCascadesClean = false;` BEFORE the member_erased gate, and accept the vacuous-`ok` re-drive (document it). Keep the audit either way.

- [ ] **Step 4: Wire the two adapters in `members-deps.ts`** (`buildEraseMemberDeps`, after `eventRegistrationErasure`):

```ts
    broadcastsAudienceDerivation: broadcastsAudienceDerivationAdapter,
    subprocessorErasure: subprocessorErasureAdapter,
```
(add the two imports at the top.)

- [ ] **Step 5: Integration test** (`tests/integration/members/subprocessor-erasure.test.ts`, live Neon)

Drive the REAL `eraseMember` deps with a `vi.mock`'d `@/modules/broadcasts` `resendBroadcastsGateway.removeContactFromAudience`. Seed a member with a contact email + a delivery in an audience. Assert: after erase, `removeContactFromAudience` called with (audienceId, email); a `subprocessor_erasure_propagated` audit row exists with `resend_outcome:'ok'`, `resend_contacts_removed_count:1`; `member_erased` IS emitted (non-blocking) even when the gateway is forced to reject (resend_outcome:'failed', member_erased still present).

- [ ] **Step 6: Gates + commit**

Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/members/subprocessor-erasure.test.ts` → GREEN. True typecheck (temp tsconfig excl `.next`) + `pnpm lint`.

```bash
git add src/modules/members/application/use-cases/erase-member.ts src/modules/members/members-deps.ts tests/integration/members/subprocessor-erasure.test.ts
git commit -m "feat(members): wire subprocessor erasure cascade into eraseMember (COMP-1 US3-C)"
```

---

## Task 6: Capstone e2e + cross-tenant + re-drive + observability docs

**Files:**
- Create: `tests/integration/members/erase-member-subprocessor-cascade.test.ts`
- Modify: `docs/runbooks/member-erasure.md` (create or append)

- [ ] **Step 1: Capstone integration/e2e test** covering, in one flow:
  - Member with 2 received audiences → erase → both removals attempted → 1 `subprocessor_erasure_propagated` (resend_outcome:'ok', removed:2) → `member_erased` emitted, `cascadesComplete:true`.
  - **Cross-tenant (Principle-I gate-blocker, security cond-1 — must be a GENUINE 2-tenant live-Neon test, not a mocked filter):** a tenant-A erase does NOT remove tenant-B audience contacts + does NOT see tenant-B deliveries in the pair capture (seed tenant-B with the same email).
  - **Re-drive (empty-set):** force the first-pass removal to reject (resend_outcome:'failed') → re-run `eraseMember` (reconciler shape) → the pair capture is now empty (contacts scrubbed) → the cascade no-ops with resend_outcome:'ok', removed:0 → a SECOND `subprocessor_erasure_propagated` row (honest: failed then ok-empty) → `member_erased` present exactly once.
  - **Throw-path rollback (security cond-2):** force the in-tx pair-capture (`broadcastsAudienceDerivation.listMemberAudienceContactsInTx`) to THROW → assert the WHOLE atomic erasure rolls back: `members.erased_at` stays NULL, contacts NOT scrubbed, NO `member_erased`, the member is re-drivable. (Proves the FAIL-LOUD capture, which a mock-only suite would hide.)

- [ ] **Step 2: Observability + compliance docs** — in `docs/runbooks/member-erasure.md`:
  - The `member_subprocessor_erasure_total{resend_outcome="failed"}` (and `partial`) alert + the manual-remediation procedure (operator queries the `subprocessor_erasure_propagated` audit for the failed member, manually removes the contact via the Resend dashboard, records completion).
  - **H-1 (pdpa Art.12(3) / PDPA §30):** the manual remediation MUST complete within the SAME one-month erasure window (bind the SLA to the US3-A attestation timestamp / the `member_erasure_requested` audit time — cross-ref the US3-D evidence log), NOT "eventually".
  - **Security cond-3:** state explicitly that a re-drive's SECOND `subprocessor_erasure_propagated{resend_outcome:'ok', removed:0}` row is a VACUOUS empty-set no-op and is **NOT** proof the Resend removal succeeded — the authoritative signal is the FIRST pass's outcome + the metric. An operator must not read the later `ok` as remediation.
  - **The documented residual:** best-effort-ONCE (a first-pass failure is not auto-retried because the inputs are destroyed by the same erasure); Resend historical / un-enumerable audiences are out of reach.
  - **H-2 (pdpa Art.30(1)(e)):** record this residual as an EXPLICIT US3-C → US3-E exit dependency (the RoPA must name "Resend sub-processor: best-effort-once propagation, un-enumerable historical audiences, manual remediation on failure") so it cannot be dropped when US3-E is written. Note it in the design's known-limitations section too.

- [ ] **Step 3: Full gate sweep**

Run: true typecheck (temp tsconfig excl `.next`) → 0; `pnpm lint` → 0; `pnpm check:i18n && pnpm check:audit-counts && pnpm check:multi-tenant && pnpm check:fixme`; the US3-C unit + integration suites green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/members/erase-member-subprocessor-cascade.test.ts docs/runbooks/member-erasure.md
git commit -m "test(members): capstone + cross-tenant + re-drive for subprocessor cascade (COMP-1 US3-C)"
```

---

## Security review (mandatory — PII/erasure surface, ≥2 reviewers)

Per the design + Constitution: this touches US1-core `eraseMember` + a NEW external-API surface (Resend `contacts.remove`). The security-engineer + pdpa-gdpr-compliance-officer MUST review and sign:
- The **non-blocking gating deviation** (does `member_erased` honestly mean "erased" when a first-pass Resend removal failed? — the recommended answer + the audit/alert/runbook compensating controls).
- Tenant isolation: the in-tx pair capture filters `tenant_id = slug`; the cross-tenant test is a gate-blocker.
- Forbidden-fields hygiene: the adapter logs `audienceId` + `errKind` only, NEVER the email; the audit payload carries ids + outcomes only, never erased PII.
- No payments symbols imported (Stripe arm is a pure no-op).

## Self-Review (completed)

- **Spec coverage:** design § US3-C → Tasks: Stripe no-op (T4) ✓, Resend best-effort (T2+T3+T4) ✓, new audit type 31→32 + 4-place + migration (T1) ✓, wired post-commit after F6 before member_erased (T5) ✓, pre-scrub email capture threaded (T3+T5, corrected to in-tx pair capture) ✓, idempotent/reconciler-safe (T5+T6 re-drive test) ✓, future-proofing note (T4 Stripe comment) ✓, residual documented (T6 runbook) ✓, security review ✓.
- **Two design corrections** (audience capture in-tx; non-blocking gating) are flagged explicitly for plan-review sign-off — NOT silently applied.
- **Type consistency:** `SubprocessorErasureResult`/`SubprocessorErasureInput`/`AudienceContact` names are used identically across T3/T4/T5. The audit payload keys match the design (+ a `resend_contacts_failed_count` for completeness).
- **No placeholders:** every code step has real code; SQL uses the verified columns (`broadcasts.resend_audience_id`, `broadcast_deliveries.recipient_email_lower`, `.broadcast_id`); the audit count (31→32) is verified against `f3-audit-event-type-count.test.ts`.

## Execution Handoff

Two options:
1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review (spec then quality/security), per the established US2/US3 cadence.
2. **Inline Execution** — batch with checkpoints.

**Plan-review-first: DONE (2026-06-20).** All 4 specialists APPROVE-WITH-CHANGES; both deviations VALIDATED against code:
- **chamber-os-architect** — APPROVE-WITH-CHANGES (in-tx capture verified correct; Clean Arch + Constitution PASS, no Complexity-Tracking entry). Changes folded: removed the fold-in-tombstone alternative; renamed `AudienceContact`→`SubprocessorAudienceContact`; `assertTenantBoundTx` added; non-empty test assertion.
- **security-engineer** — SIGN-WITH-CONDITIONS (endorses non-blocking as "more honest than blocking", re-drive-empty-set verified). Conditions folded: genuine 2-tenant cross-tenant test (T6), throw-path rollback test (T6), runbook "2nd ok-empty ≠ proof" (T6).
- **pdpa-gdpr-compliance-officer** — APPROVE-WITH-CHANGES (best-effort-once + non-blocking endorsed as Art.17(2)/Art.19-compliant + forced, not weaker). Folded: H-1 Art.12 one-month SLA, H-2 RoPA exit dependency, M-1 fail-loud asymmetry rationale (all in T5/T6).
- **drizzle-migration-reviewer** — APPROVE-WITH-CHANGES (migration 0228 clean, idx free, 4-place correct). Folded: BLOCKING-1 dropped `completeness.test.ts` (F1-tuple-only, stays 33); BLOCKING-2 `ANY(ARRAY[...]::text[])` idiom; BLOCKING-3 lower-case+de-dupe emails.

No NON-NEGOTIABLE blockers remain. The plan is build-ready; the security checklist final sign + the pdpa conditional sign land at the implementation review gate (after T6's tests + runbook exist).
