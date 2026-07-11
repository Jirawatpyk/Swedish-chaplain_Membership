# F5 Payment Bug-fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 confirmed + 1 contested F5 Online Payment bugs found by an adversarial bug hunt, centred on introducing a correct async refund lifecycle (Stripe `charge.refund.updated`) with idempotent credit-note issuance.

**Architecture:** Three sequential PRs off `origin/main` in worktree `f5-refund-lifecycle`. `refund.status` from Stripe becomes the source of truth, delivered by a new `charge.refund.updated` webhook subscription → `processRefundUpdated` use-case. Credit-note issuance is made idempotent-per-refund at the DB layer (partial unique index) + application layer (read-existing). A new terminal payment status `auto_refunded` fixes the stale-invoice stuck-pending row.

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 App Router · Drizzle ORM + Neon Postgres (RLS+FORCE) · Stripe SDK (card + PromptPay Connect) · Vitest + Playwright · next-intl (EN/TH/SV).

**Source spec:** `docs/superpowers/specs/2026-07-11-f5-payment-bugfixes-design.md` (v1 design + v2 consolidation + v2.1 re-review flags RR-1…RR-8). Reviewed by 5 specialists × 2 rounds — all CLEARED.

## Global Constraints

- **TDD**: failing test → commit red → implement → commit green. Every use-case change ships ≥1 test authored before the code.
- **Coverage**: Domain 100% line; Application 80% line + 80% branch; **100% branch on security-critical F5 use-cases** (initiate/confirm/fail/cancel/refund + new `processRefundUpdated`).
- **Migrations**: apply the migration (`pnpm db:migrate` → dev Neon branch) **then** `pnpm test:integration` **before committing** any schema change. Unit mocks hide DB CHECK gaps.
- **Tenant isolation (Principle I, NON-NEGOTIABLE)**: every tenant-scoped repo query threads the `tx` from `runInTenant` — never the pool-global `db`. New use-cases ship a **cross-tenant integration test** (Review-Gate blocker).
- **PCI SAQ-A (Principle IV, NON-NEGOTIABLE)**: card metadata enters only via `extractCardMetadata`. No PAN/last4/brand/client_secret/raw-event/Stripe-Signature/`error.message` in any log/audit/response. Webhook envelopes carry id-refs + status + satang only.
- **Audit event type = 7 places (F5)**: (1) `F5AuditEventType` union `src/modules/payments/application/ports/audit-port.ts`, (2) `F5_AUDIT_RETENTION_YEARS` map (same file), (3) `F5AuditPayloadByType` interface (same file), (4) migration `ALTER TYPE audit_event_type ADD VALUE` (idempotent DO-block), (5) `auditEventTypeEnum` pgEnum tuple `src/modules/auth/infrastructure/db/schema.ts`, (6) i18n labels `audit.eventType.<value>` in `src/i18n/messages/{en,th,sv}.json`, (7) do **NOT** add the migration to `F5_MIGRATIONS` in `scripts/check-audit-event-count.ts`. Prefer reusing `refund_succeeded` + a new `path` discriminator arm (TS-only, zero migration) over new enum values.
- **Money**: THB satang as `bigint` branded `Satang` (`@/lib/money`). Never coerce to `number` past `Number.MAX_SAFE_INTEGER`.
- **Commits**: Conventional Commits (commit-msg hook). Money-path/PII/audit surface ⇒ ≥2 reviewers at Review gate.
- **Pre-push**: `pnpm typecheck` as the final gate after the LAST edit before commit; run full `pnpm lint` in review gates (typecheck+vitest miss lint-only errors).
- **Worktree**: run dev/e2e on `:3101` (never touch `:3100`); `.env.local` already copied.
- **PR order**: **PR-C → PR-A → PR-B** (PR-A depends on PR-C's single-projection route fix; PR-B depends on PR-A's refund shape).

---

# Phase 0 — Pre-flight gates (do FIRST, once)

### Task 0.1: Confirm migration numbering + baseline green

**Files:** none (verification only)

- [ ] **Step 1: Re-check the highest migration number on origin/main**

Run:
```bash
git ls-tree origin/main drizzle/migrations | tail -5
```
Expected: highest is `0239_broadcast_templates_partial_uniq.sql`. Our files claim **0240, 0241, 0242**. If another branch landed 0240+, bump ours (+ update `drizzle/migrations/meta/_journal.json`) per the parallel-branch-collision convention.

- [ ] **Step 2: Confirm the payments baseline is green**

Run:
```bash
pnpm test tests/unit/payments tests/contract/payments
```
Expected: `498 passed` (0 failed). This is the clean baseline — any later red is ours.

### Task 0.2: RR-4 — BLOCKING credit_notes duplicate pre-flight (ship-day gate, document now)

**Files:**
- Create: `docs/runbooks/f5-0242-preflight-credit-note-dupes.md`

- [ ] **Step 1: Write the runbook** with the exact pre-flight query the operator MUST run against **both** the `dev` Neon branch and prod **before** deploying migration 0242 (a pre-existing duplicate makes `CREATE UNIQUE INDEX` fail the whole auto-migrate deploy):

```sql
SELECT tenant_id, source_refund_id, COUNT(*) AS n
FROM credit_notes
WHERE source_refund_id IS NOT NULL
GROUP BY tenant_id, source_refund_id
HAVING COUNT(*) > 1;
```
Document: if rows return → void the duplicate CN + reconcile the §87 sequence before the migration. Note prod risk is LOW (wiped 2026-06-24/07-10) but the `dev` branch (accumulated refund test rows) is higher.

- [ ] **Step 2: Commit**
```bash
git add docs/runbooks/f5-0242-preflight-credit-note-dupes.md
git commit -m "docs(payments): RR-4 preflight runbook for 0242 credit_notes unique index"
```

---

# Phase PR-C — Webhook route / verifier re-projection (#5, #6, #7)

Mechanical, low-risk, unblocks PR-A. Branch: work continues on `worktree-f5-refund-lifecycle`; PR-C is the first slice committed. (At PR-open time this slice is cherry-picked/branched — see Execution Handoff.)

### Task C.1: #5 — carry `amountProjectionFailed` through the route re-projection

**Files:**
- Modify: `src/app/api/webhooks/stripe/route.ts` (the `verifiedEvent.dataObject` literal, ~lines 559-598)
- Test: `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts`

**Interfaces:**
- Consumes: `VerifiedStripeEvent.dataObject.amountProjectionFailed?: boolean` (already on the port type, `webhook-verifier-port.ts:108`).
- Produces: the route's rebuilt `dataObject` now preserves `amountProjectionFailed`.

- [ ] **Step 1: Write the failing test** — a `charge.refunded` verifier envelope with `dataObject.amountProjectionFailed === true` must reach the dispatched use-case input unchanged. Assert on the `processWebhookEvent` mock's received `event.dataObject.amountProjectionFailed === true`.

- [ ] **Step 2: Run it — expect FAIL** (route drops the flag today).
Run: `pnpm test tests/contract/payments/post-webhooks-stripe-events.contract.test.ts -t "amountProjectionFailed"`

- [ ] **Step 3: Add the copy** in the `dataObject` literal:
```ts
...(rawDataObject?.['amountProjectionFailed'] === true
  ? { amountProjectionFailed: true }
  : {}),
```
(Place alongside the existing `amountSatang` spread. Because in prod `rawEvent` IS the verifier envelope, `rawDataObject['amountProjectionFailed']` is the verifier-set flag.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix(payments): preserve amountProjectionFailed through webhook route re-projection (#5)`

### Task C.2: #6 — carry `disputeId` + project the real charge id defensively (PCI-2)

**Files:**
- Modify: `src/modules/payments/infrastructure/stripe/stripe-webhook-verifier.ts` (dispute branch of `project()`)
- Modify: `src/app/api/webhooks/stripe/route.ts` (`dataObject` literal — copy `disputeId`)
- Test: `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts` + a verifier unit test.

**Interfaces:**
- Produces: for `charge.dispute.created`, `dataObject.disputeId` = the `dp_…` id, and `dataObject.latestChargeId` = the REAL `ch_…` (from `raw['charge']`, defensively extracted), so the dispute audit records a correct `charge_id`.

- [ ] **Step 1: Write the failing verifier unit test** — a dispute event whose `charge` is (a) a string `ch_x` and (b) an expanded `{ id: 'ch_x', payment_method_details: { card: { last4: '4242' } } }` must both project `latestChargeId === 'ch_x'` and MUST NOT leak `last4`. And `disputeId === 'dp_x'`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the dispute branch using the existing defensive helper shape (mirror `extractLatestChargeId`):
```ts
// in project() dispute arm
const ch = raw['charge'];
const chargeId =
  typeof ch === 'string' ? ch
  : (ch !== null && typeof ch === 'object'
      && typeof (ch as Record<string, unknown>)['id'] === 'string')
    ? ((ch as Record<string, unknown>)['id'] as string)
    : null;
// project: { ...id (dp_ id), disputeId: rawId, latestChargeId: chargeId }
```
Then in `route.ts` re-projection add `...(rawDataObject?.['disputeId'] ? { disputeId: String(rawDataObject['disputeId']) } : {})`.
Update `process-webhook-event.ts:685-687` dispute audit so `charge_id: dataObject.latestChargeId ?? null` (the real charge) and `dispute_id: dataObject.disputeId ?? null`.

- [ ] **Step 4: Run — expect PASS** (both the string + expanded-object cases; negative-assert no `last4`).

- [ ] **Step 5: Commit** `fix(payments): record real charge id + disputeId on dispute audit, defensively (#6)`

### Task C.3: #7 — map `invoice_data_corrupt` to 422 (not 500)

**Files:**
- Modify: `src/app/api/payments/initiate/route.ts` (`httpStatusForUseCaseError`, ~lines 83-120)
- Modify: `src/lib/payments-errors-i18n.ts` (add `F5RouteErrorCode` `'invoice_data_corrupt'`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (add the route-error i18n key)
- Test: `tests/contract/payments/post-payments-initiate.contract.test.ts`

- [ ] **Step 1: Write the failing test** — when `initiatePayment` returns `{ code: 'invoice_data_corrupt' }`, the route responds **422** with routeCode `invoice_data_corrupt` (not 500 `internal_error`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add** `case 'invoice_data_corrupt': return { status: 422, routeCode: 'invoice_data_corrupt' };` + the `F5RouteErrorCode` union member + EN/TH/SV messages (mirror existing `tenant_settings_incomplete` copy, TH: "ข้อมูลใบแจ้งหนี้ผิดพลาด กรุณาติดต่อผู้ดูแลระบบ").

- [ ] **Step 4: Run — expect PASS.** Also run `pnpm check:i18n` (no missing EN keys).

- [ ] **Step 5: Commit** `fix(payments): map invoice_data_corrupt to 422 with distinct route code (#7)`

### Task C.4: M-f — assert route re-projection is a superset of the verifier envelope keys

**Files:**
- Create: `tests/unit/payments/webhook-reprojection-superset.test.ts`

**Rationale:** #5/#6 exist because the envelope is projected twice (verifier + route). This test kills the drop-field bug class permanently so PR-A's new `refundStatus` can't be silently dropped.

- [ ] **Step 1: Write the test** — enumerate the optional keys of `VerifiedStripeEvent['dataObject']` (`id, type, latestChargeId, refundIds, lastPaymentErrorCode, disputeId, amountSatang, amountProjectionFailed` + PR-A's `refundStatus`). Build a synthetic verifier envelope with every key set, run it through the route's re-projection helper (extract the `dataObject` rebuild into an exported pure fn `reprojectDataObject(rawDataObject)` in `route.ts`), assert every present key survives.

- [ ] **Step 2: Extract** the `dataObject` rebuild in `route.ts` into `export function reprojectDataObject(...)` (pure), call it from the handler. Run the test — expect PASS (after C.1/C.2 copies; `refundStatus` key added in PR-A Task A.9).

- [ ] **Step 3: Commit** `test(payments): pin route re-projection as superset of verifier envelope (M-f)`

### Task C.5: PR-C gate + open PR

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test tests/unit/payments tests/contract/payments && pnpm check:i18n` — all green.
- [ ] **Step 2:** Open PR-C (see Execution Handoff for branch mechanics). Body cites #5/#6/#7 + M-f.

---

# Phase PR-A — Refund lifecycle (#1, #2, #3, #8) + migrations

Depends on PR-C. This is the core. Build order: migrations → domain → repos → F4 bridge idempotency → `retrieveRefund` gateway → `issueRefund` refactor → `processRefundUpdated` → webhook wiring → `charge.refunded` cleanup → `confirm-payment` `auto_refunded` → sweep → di → #8 → F9/i18n → dead-code → integration tests.

## PR-A.1 — Migrations (RR-3) + apply + CHECK-compat integration probes

### Task A.1: Migration 0240 — `auto_refunded` status + card CHECK + durable column + its unique index

**Files:**
- Create: `drizzle/migrations/0240_payments_auto_refunded_status.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (drizzle-kit adds the entry — verify)
- Modify: `src/modules/payments/infrastructure/schema.ts` (add `autoRefundProcessorRefundId: text('auto_refund_processor_refund_id')` to `payments`)

- [ ] **Step 1: Hand-write the migration** (do NOT `db:generate` — CHECK/index edits are hand-authored per project precedent; drizzle-kit won't emit CHECK ALTERs):
```sql
-- 0240 — F5 auto_refunded terminal payment status + durable auto-refund marker.
-- Widens payments_status_enum + card-metadata CHECK; adds the auto-refund
-- processor-refund-id column (durable A4b lookup key) + partial unique index.

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_status_enum";--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_enum"
  CHECK ("status" IN ('pending','succeeded','failed','canceled','partially_refunded','refunded','auto_refunded'));--> statement-breakpoint

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_card_metadata_iff_card";--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_metadata_iff_card"
  CHECK (
    ("method" = 'promptpay' AND "card_brand" IS NULL AND "card_last4" IS NULL
      AND "card_exp_month" IS NULL AND "card_exp_year" IS NULL)
    OR
    ("method" = 'card' AND (
      ("card_brand" IS NOT NULL AND "card_last4" IS NOT NULL
        AND "card_exp_month" IS NOT NULL AND "card_exp_year" IS NOT NULL)
      OR
      ("status" IN ('pending','failed','canceled','auto_refunded')
        AND "card_brand" IS NULL AND "card_last4" IS NULL
        AND "card_exp_month" IS NULL AND "card_exp_year" IS NULL)
    ))
  );--> statement-breakpoint

ALTER TABLE "payments" ADD COLUMN "auto_refund_processor_refund_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_auto_refund_processor_refund_id_uniq"
  ON "payments" ("tenant_id","auto_refund_processor_refund_id")
  WHERE "auto_refund_processor_refund_id" IS NOT NULL;--> statement-breakpoint
```
Add the `_journal.json` entry manually (tag `0240_payments_auto_refunded_status`, idx = next, matching the existing format). Add the Drizzle column to `schema.ts`.

- [ ] **Step 2: Apply to dev + run the CHECK-compat integration probe.** First author the probe test `tests/integration/payments/auto-refunded-check-compat.test.ts`: INSERT a `card`+`pending`+NULL-metadata payment, UPDATE to `auto_refunded` **with `completed_at` set** → passes; UPDATE to `auto_refunded` **without** `completed_at` → REJECTED by `payments_completed_at_iff_not_pending`; INSERT a second payment for the same invoice after the first is `auto_refunded` → allowed (auto_refunded outside `payments_one_active_per_invoice`).

- [ ] **Step 3:** `pnpm db:migrate && pnpm test:integration tests/integration/payments/auto-refunded-check-compat.test.ts` — expect PASS. (Apply-then-integration BEFORE commit.)

- [ ] **Step 4: Commit** `feat(payments): 0240 auto_refunded status + card CHECK + durable auto-refund marker`

### Task A.2: Migration 0242 — `credit_notes` unique index on `source_refund_id` (CRITICAL-1 DB backstop)

**Files:**
- Create: `drizzle/migrations/0242_credit_notes_source_refund_uniq.sql`
- Modify: `drizzle/migrations/meta/_journal.json`

> RR-4: the operator runs the dup pre-flight (Task 0.2 runbook) before this deploys. Locally, the `dev` branch may have dupes from refund tests — clean them first if `db:migrate` fails here.

- [ ] **Step 1: Hand-write the migration:**
```sql
-- 0242 — CRITICAL-1: make credit-note issuance idempotent per refund at the DB layer.
-- Replaces the 0038 non-unique index (redundant once unique). A losing concurrent
-- CN insert unique-violates and rolls back the whole tx → §87 counter-row returns
-- to the pool (no gap). See docs/superpowers/specs/2026-07-11-...#CRITICAL-1.
DROP INDEX IF EXISTS "credit_notes_source_refund_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_source_refund_id_uniq"
  ON "credit_notes" ("tenant_id","source_refund_id")
  WHERE "source_refund_id" IS NOT NULL;--> statement-breakpoint
```
(No `CONCURRENTLY` — drizzle-kit wraps each migration in a tx.)

- [ ] **Step 2: Apply to dev.** `pnpm db:migrate`. If it fails with a unique violation, run the Task 0.2 dup query on dev, void/fix the duplicate CN rows, re-run.

- [ ] **Step 3: Commit** `feat(invoicing): 0242 credit_notes source_refund_id unique index (CRITICAL-1)`

### Task A.3: Migration 0241 — new audit event types (only what can't reuse `refund_succeeded`)

**Files:**
- Create: `drizzle/migrations/0241_audit_log_refund_reconcile_events.sql`
- Modify: `src/modules/payments/application/ports/audit-port.ts` (union + retention map + payload interface)
- Modify: `src/modules/auth/infrastructure/db/schema.ts` (`auditEventTypeEnum` tuple)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`audit.eventType.*`)
- Do **NOT** touch `scripts/check-audit-event-count.ts` `F5_MIGRATIONS` (RR-3 / M-b place 7).

**New enum values** (webhook-finalize reuses `refund_succeeded` + `path: 'webhook_refund_updated'` — TS-only, no enum): `auto_refund_failed_needs_manual_reconcile` (retention **10y** — money-not-returned forensic).
(`refund_pending_awaiting_processor` ships as a **metric only**, not an audit event — see Task A.16; no enum needed.)

- [ ] **Step 1: Add the `path` arm** to `F5AuditPayloadByType['refund_succeeded']`: extend the `path` union to `'admin_initiated' | 'webhook_recovery' | 'webhook_refund_updated'`. (No migration for this.)

- [ ] **Step 2: Write the migration** for the one genuinely-new type:
```sql
DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'auto_refund_failed_needs_manual_reconcile';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
```

- [ ] **Step 3: Touch the 7 places** for `auto_refund_failed_needs_manual_reconcile`: `F5AuditEventType` union; `F5_AUDIT_RETENTION_YEARS` = 10; `F5AuditPayloadByType` payload `{ payment_id, invoice_id, auto_refund_processor_refund_id, refund_status, amount_satang, runbook_url }` (RR-8 allow-list — no card/raw/error.message); `auditEventTypeEnum` tuple; en/th/sv labels; NOT in `F5_MIGRATIONS`.

- [ ] **Step 4: Apply + run audit-parity.** `pnpm db:migrate && pnpm test:integration tests/integration/payments/audit-event-type-parity.test.ts && pnpm check:audit-events && pnpm test tests/unit/insights/audit-event-label-coverage.test.ts` — all green.

- [ ] **Step 5: Commit** `feat(payments): 0241 auto_refund_failed audit type + refund_succeeded webhook path arm`

## PR-A.2 — Domain

### Task A.4: `auto_refunded` payment status + transition edge

**Files:**
- Modify: `src/modules/payments/domain/payment.ts` (`PAYMENT_STATUSES`, `TERMINAL_PAYMENT_STATUSES`)
- Modify: `src/modules/payments/domain/policies/payment-status-transitions.ts` (`TRANSITIONS`)
- Modify: `src/modules/payments/domain/refund.ts` (docstring only — `processor_refund_id` may be non-null while pending)
- Test: `tests/unit/payments/payment-status-transitions.test.ts`

**Interfaces:**
- Produces: `PaymentStatus` gains `'auto_refunded'` (terminal); legal edge `pending → auto_refunded`.

- [ ] **Step 1: Write failing tests** — `canTransition('pending','auto_refunded')` ok; `canTransition('auto_refunded', <any>)` err (terminal); `isTerminalPaymentStatus('auto_refunded') === true`; `SUCCEEDED_LINEAGE` does **not** include `auto_refunded` (assert `enforceOneSucceededPerInvoice(['auto_refunded'])` returns ok).

- [ ] **Step 2: Run — expect FAIL** (compile error: `TRANSITIONS` Record missing key).

- [ ] **Step 3: Implement** — add `'auto_refunded'` to `PAYMENT_STATUSES` + `TERMINAL_PAYMENT_STATUSES`; in `TRANSITIONS` add `'auto_refunded'` to `pending`'s list and `auto_refunded: []`. Update `refund.ts:85` comment: `processor_refund_id` set once Stripe accepts (may be non-null while `pending`); only `credit_note_id` is `NOT NULL iff succeeded`.

- [ ] **Step 4: Run — expect PASS.** Also `pnpm typecheck` (Record-exhaustive consumers compile).

- [ ] **Step 5: Commit** `feat(payments): auto_refunded terminal payment status + pending edge`

## PR-A.3 — Repository methods (RR-1, H-c, L-a)

### Task A.5: `refundsRepo.updateStatus` returns null on expectedCurrentStatus miss + audit ALL callers (RR-1)

**Files:**
- Modify: `src/modules/payments/infrastructure/repos/drizzle-refunds-repo.ts` (`updateStatus`, ~lines 112-165)
- Modify: `src/modules/payments/application/use-cases/sweep-stale-pending-refunds.ts` (handle null return — see below)
- Test: `tests/integration/payments/drizzle-refunds-repo.test.ts`

**Interfaces:**
- Produces: `updateStatus(tx, input)` — when `input.expectedCurrentStatus` is set AND zero rows match, **returns `null`** (mirrors `drizzle-payments-repo.ts:302-313`); without `expectedCurrentStatus`, keeps throw-on-zero. Callers: sweep, issue-refund Phase B (new helper), processRefundUpdated, process-charge-refunded.

- [ ] **Step 1: Write failing integration test** — `updateStatus(tx, { …, expectedCurrentStatus:'pending' })` on a row already `succeeded` returns `null` (not throw).

- [ ] **Step 2: Run — expect FAIL** (currently throws).

- [ ] **Step 3: Implement** the null-return branch (copy the payments-repo pattern). **RR-1 sweep fix**: `sweep-stale-pending-refunds.ts` passes `expectedCurrentStatus:'pending'` and previously relied on THROW to roll the per-row tx back (so its pre-flip `stale_pending_refund_detected` audit doesn't commit on a lost race). Change the sweep so that on a `null` return it **explicitly throws inside the withTx** (e.g. `if (updated === null) throw new StalePendingRaceSkip()`), caught by the existing per-row `try/catch` → row rolls back → `skippedCount++`. This preserves the "no false stale_pending audit" invariant.

- [ ] **Step 4: Write + run the sweep regression test** — a pending refund finalized to `succeeded` by a concurrent writer between the sweep's list-read and flip → sweep emits **NO** `stale_pending_refund_detected` audit and counts it skipped. Integration (live Neon).

- [ ] **Step 5: Run all — expect PASS.**

- [ ] **Step 6: Commit** `fix(payments): refundsRepo.updateStatus returns null on race + sweep rolls back cleanly (RR-1/H-b)`

### Task A.6: `attachProcessorRefundId` + `lockForUpdateByProcessorRefundId` + auto-refund column read

**Files:**
- Modify: `src/modules/payments/application/ports/refunds-repo.ts` (+ 2 method signatures)
- Modify: `src/modules/payments/application/ports/payments-repo.ts` (+ `findAutoRefundByProcessorRefundId`)
- Modify: `src/modules/payments/infrastructure/repos/drizzle-refunds-repo.ts`
- Modify: `src/modules/payments/infrastructure/repos/drizzle-payments-repo.ts`
- Test: `tests/integration/payments/drizzle-refunds-repo.test.ts` + `drizzle-payments-repo.test.ts`

**Interfaces:**
- Produces:
  - `attachProcessorRefundId(tx, { refundId, tenantId, processorRefundId }): Promise<void>` — sets ONLY `processor_refund_id` (keeps `pending`, `completed_at` NULL). CHECK-safe (biconditional false=false; L-a narrow method).
  - `lockForUpdateByProcessorRefundId(tx, tenantId, processorRefundId): Promise<Refund | null>` — `SELECT … WHERE tenant_id=? AND processor_refund_id=? FOR UPDATE` (H-c serialize).
  - `findAutoRefundByProcessorRefundId(tx, tenantId, processorRefundId): Promise<{ paymentId, invoiceId } | null>` — reads `payments WHERE auto_refund_processor_refund_id=?` (durable A4b lookup; replaces the audit_log lookup).

- [ ] **Step 1: Write failing integration tests** — round-trip each: attach id to a pending row (CHECK passes); lock-for-update returns the row under a tx; find-auto-refund returns the payment when the column is set, null otherwise; cross-tenant: all three return null/empty for another tenant's id.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** all three in the Drizzle repos, each inside the passed `tx` (or `runInTenant(ctx, …)` for the non-tx read), threading `tenant_id`. Never the pool-global `db`.

- [ ] **Step 4: Run — expect PASS** incl. cross-tenant.

- [ ] **Step 5: Commit** `feat(payments): repo methods for refund-id attach/lock + durable auto-refund lookup`

## PR-A.4 — F4 credit-note idempotency (CRITICAL-1 app layer, RR-2)

### Task A.7: `issueCreditNoteFromRefund` returns the existing CN for a repeat `refundId`

**Files:**
- Modify: `src/modules/invoicing/application/use-cases/issue-credit-note-from-refund.ts`
- Modify: `src/modules/invoicing/application/use-cases/issue-credit-note.ts` (read-existing-by-sourceRefundId under invoice lock)
- Modify: `src/modules/invoicing/infrastructure/repos/*credit-note*repo*.ts` (+ `findBySourceRefundId(tx, tenantId, sourceRefundId)`)
- Test: `tests/integration/invoicing/credit-note-from-refund-idempotent.test.ts`

**Interfaces:**
- Produces: `issueCreditNoteFromRefund(input)` — if a CN already exists for `(tenant_id, source_refund_id)`, returns `ok({ creditNoteId, creditNoteNumber })` of the EXISTING CN (no new §87 number, no new PDF). On a concurrent unique-violation (`23505`), reconcile in a **fresh tx**.

- [ ] **Step 1: Write failing integration test** — call `issueCreditNoteFromRefund` twice with the same `refundId` → the second returns the SAME `creditNoteId`/number; exactly ONE `credit_notes` row; the §87 sequence advanced by exactly 1.

- [ ] **Step 2: Run — expect FAIL** (currently issues 2 CNs).

- [ ] **Step 3: Implement.** Inside the existing invoice `FOR UPDATE` lock (issue-credit-note.ts:286), **after** acquiring the lock (RR-2 TOCTOU), `findBySourceRefundId` first → return existing if present. Wrap the allocate+insert; on Postgres `23505` (unique index `credit_notes_source_refund_id_uniq`), let the tx abort, then in a **fresh `withTx`** re-read the sibling CN and return it (RR-2: cannot SELECT in the aborted tx). Add a helper `reconcileExistingCreditNote(tenantId, sourceRefundId)`.

- [ ] **Step 4: Write + run the concurrency integration test** — two `issueCreditNoteFromRefund` for the same refund racing (Promise.all) → exactly one CN, no §87 gap (assert `tenant_document_sequences.next_sequence_number` advanced by 1).

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Add the §87-allocator-is-a-counter-row guard test** (RR-2) — a unit/integration assertion that `postgres-sequence-allocator` uses an UPDATE-counter (not `nextval`), so a future switch can't silently reintroduce a gap. (Assert the losing insert's rollback returns the number.)

- [ ] **Step 7: Commit** `fix(invoicing): idempotent credit-note issuance per source_refund_id (CRITICAL-1)`

## PR-A.5 — `retrieveRefund` gateway method (PCI-3, for the sweep)

### Task A.8: add `retrieveRefund` to the port + Stripe gateway (allow-list, Connect-scoped)

**Files:**
- Modify: `src/modules/payments/application/ports/processor-gateway-port.ts` (+ `retrieveRefund` + `RetrievedRefund` type)
- Modify: `src/modules/payments/infrastructure/stripe/stripe-gateway.ts`
- Test: `tests/unit/payments/stripe-gateway-retrieve-refund.test.ts`

**Interfaces:**
- Produces: `RetrievedRefund = { id: string; status: string; chargeId: string | null; paymentIntentId: string | null; amountSatang: Satang }`. `retrieveRefund(refundId, stripeAccount): Promise<Result<RetrievedRefund, ProcessorGatewayError>>` — `client.refunds.retrieve(id, undefined, connectOptions(stripeAccount))`, projecting ONLY those 5 fields; same defensive amount projection as `createRefund`; logs allow-list `{stripeAccount, refundId, status}` only.

- [ ] **Step 1: Write failing unit test** — feed a synthetic Stripe Refund (with `destination_details.card`, `charge` expanded) → returned VO has ONLY the 5 fields; **negative-assert** no `destination_details`, no card keys. `connectOptions` applied when account ≠ platform.

- [ ] **Step 2: Run — expect FAIL** (method missing).

- [ ] **Step 3: Implement** mirroring `createRefund`'s amount-projection + `mapStripeError` + `connectOptions`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `feat(payments): retrieveRefund gateway method (allow-list, Connect-scoped) (PCI-3)`

## PR-A.6 — `issueRefund` refactor: shared `finalizeSucceededRefund` + status branch (#1)

### Task A.9: extract `finalizeSucceededRefund` + branch `issueRefund` on Stripe refund status

**Files:**
- Create: `src/modules/payments/application/use-cases/_finalize-succeeded-refund.ts` (shared helper)
- Modify: `src/modules/payments/application/use-cases/issue-refund.ts`
- Modify: `src/modules/payments/application/ports/webhook-verifier-port.ts` (add `readonly refundStatus?: string | null` to `dataObject`)
- Test: `tests/unit/payments/issue-refund.test.ts` (+ existing suite must stay green)

**Interfaces:**
- Produces:
  - `finalizeSucceededRefund(deps, tx, { refundId, tenantId, paymentId, invoiceId, amountSatang, actorUserId, requestId, path })` → issues the F4 CN (idempotent per Task A.7), flips refund→`succeeded` **with `expectedCurrentStatus='pending'`** (returns cleanly if a sibling won — null = no-op), flips payment→`partially_refunded|refunded`, reads F4-authoritative invoice status (tax#5), emits `refund_succeeded` with the given `path`. Idempotent + race-safe. Returns `{ creditNoteId, creditNoteNumber, paymentNextStatus, invoiceStatus }`.
  - `IssueRefundSuccess` gains a `pending` variant: `{ kind: 'succeeded', refund, payment, invoice } | { kind: 'pending', refund: { id, status:'pending', processorRefundId } }`.
- Consumes: A.6 `attachProcessorRefundId`, A.7 idempotent CN, A.5 null-return `updateStatus`.

- [ ] **Step 1: Write failing tests** for the three Stripe-status branches:
  - `createRefund → { status:'succeeded' }` → issues CN + flips → `kind:'succeeded'` (existing behaviour; assert one CN).
  - `createRefund → { status:'pending' }` (or `'requires_action'`) → **NO CN**, refund row stays `pending` with `processor_refund_id` set, returns `kind:'pending'`.
  - `createRefund → { status:'failed' }` → `finaliseFailedRefund` (now also sets `processor_refund_id`), returns typed err.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** After `createRefund` ok: call `attachProcessorRefundId` (short tx) so the row is webhook-matchable; then `switch (stripeRefund.value.status)`:
  - `'succeeded'` → `finalizeSucceededRefund(…, path:'admin_initiated')` inside Phase B tx (fixes `issue-refund.ts:474` missing `expectedCurrentStatus`).
  - `'pending' | 'requires_action'` → return `ok({ kind:'pending', … })`.
  - `'failed' | 'canceled'` → `finaliseFailedRefund` (extend it to accept + persist `processorRefundId`) → return `err({ code:'processor_unavailable', kind:'permanent', reason: stripeRefund.value.status })`.
  Extend `finaliseFailedRefund` signature with optional `processorRefundId`.

- [ ] **Step 4: Update the refunds route** (`src/app/api/refunds/initiate/route.ts`) to map `kind:'pending'` → 202 with a `{ refund:{ status:'pending' }, message }` body (member/admin sees "refund submitted, awaiting confirmation"). Add EN/TH/SV copy.

- [ ] **Step 5: Run all issue-refund tests — expect PASS** (100% branch).

- [ ] **Step 6: Commit** `feat(payments): issueRefund finalizes CN only on Stripe status=succeeded; pending awaits webhook (#1)`

## PR-A.7 — `processRefundUpdated` use-case + webhook wiring (#1 reconcile, #2)

### Task A.10: webhook verifier `refund` branch + `F5_HANDLED_EVENT_TYPES` + route re-projection (PCI-1)

**Files:**
- Modify: `src/modules/payments/infrastructure/stripe/stripe-webhook-verifier.ts` (`project()` — new `objectType === 'refund'` arm)
- Modify: `src/modules/payments/application/ports/webhook-verifier-port.ts` (`F5_HANDLED_EVENT_TYPES` += `'charge.refund.updated'`; `dataObject.refundStatus` already added in A.9)
- Modify: `src/app/api/webhooks/stripe/route.ts` (`reprojectDataObject` copies `refundStatus`)
- Test: verifier unit + `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts` + the M-f superset test (now includes `refundStatus`)

- [ ] **Step 1: Write failing tests** — a `charge.refund.updated` event projects `{ id: re_…, status, latestChargeId: ch_… (defensive), refundStatus }` and NOTHING card-related; the route re-projection preserves `refundStatus`; `F5_HANDLED_EVENT_TYPES_SET.has('charge.refund.updated')`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the `refund` arm (explicit allow-list per PCI-1 code sample in spec v2 PCI-1): project `status` → `refundStatus`, `charge` → `latestChargeId` (defensive string|object.id|null), `amount` → `projectAmountSafely`. Add the event type to the tuple. Add `refundStatus` copy to `reprojectDataObject`.

- [ ] **Step 4: Run — expect PASS** (incl. M-f superset).

- [ ] **Step 5: Commit** `feat(payments): project charge.refund.updated envelope + subscribe (PCI-1)`

### Task A.11: `processRefundUpdated` use-case

**Files:**
- Create: `src/modules/payments/application/use-cases/process-refund-updated.ts`
- Modify: `src/modules/payments/application/use-cases/process-webhook-event.ts` (dispatch `charge.refund.updated`)
- Test: `tests/unit/payments/process-refund-updated.test.ts` (100% branch) + `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts`

**Interfaces:**
- Consumes: A.6 `lockForUpdateByProcessorRefundId`, `findAutoRefundByProcessorRefundId`; A.9 `finalizeSucceededRefund`; A.5 null-return `updateStatus`; A.8 not needed here.
- Produces: `processRefundUpdated(deps, { tenantId, refundId, refundStatus, chargeId, eventId, requestId }) → Result<ProcessRefundUpdatedOutcome, …>`. Outcome kinds: `reconciled_succeeded | reconciled_failed | already_finalized | still_pending | out_of_band | auto_refund_recognized | auto_refund_failed`.

- [ ] **Step 1: Write failing tests** for each branch (all inside one `withTx`, threading `tx`):
  - lock refund by `processor_refund_id`; **not found** → check `findAutoRefundByProcessorRefundId`:
    - matches an auto-refund + incoming `succeeded|pending` → `auto_refund_recognized` (suppress OOB, benign audit); markProcessed.
    - matches an auto-refund + incoming `failed|canceled` → emit `auto_refund_failed_needs_manual_reconcile` (10y) + paging metric → `auto_refund_failed` (RR/B2 — do NOT suppress).
    - no match → existing `out_of_band_refund_detected` path (genuine Dashboard refund).
  - refund found, `status != 'pending'` → `already_finalized` no-op.
  - refund found, `status == 'pending'`:
    - incoming `succeeded` → `finalizeSucceededRefund(…, path:'webhook_refund_updated')`; if it returns null (sibling won) → `already_finalized`. Port the SB-1 lock ordering (payment `FOR UPDATE` before the refunds aggregate read) inside `finalizeSucceededRefund` (RR-5 / H-c).
    - incoming `failed|canceled` → `finaliseFailedRefund` (no CN) → `reconciled_failed`.
    - incoming `pending` → `still_pending` no-op.
  - Always `markProcessed(tx, eventId)` atomically at the tail.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `processRefundUpdated`; wire the `case 'charge.refund.updated'` branch in `process-webhook-event.ts` (mirror the `charge.refunded` branch shape, forwarding `refundStatus`).

- [ ] **Step 4: Run — expect PASS** (100% branch).

- [ ] **Step 5: Commit** `feat(payments): processRefundUpdated reconciles async refunds via charge.refund.updated (#1/#2)`

### Task A.12: `charge.refunded` cleanup — remove dead pending-flip, keep mismatch (#2, RR-5)

**Files:**
- Modify: `src/modules/payments/application/use-cases/process-charge-refunded.ts`
- Test: `tests/unit/payments/process-charge-refunded.test.ts`

- [ ] **Step 1: Write failing test** — `charge.refunded` on a `pending` refund row (now matchable via A.9's early `processor_refund_id`) does **NOT** issue a CN and does **NOT** flip to succeeded (finalization owned by `charge.refund.updated`); the amount-mismatch sanity branch still fires on divergence; out-of-band branch still fires for unknown refund ids.

- [ ] **Step 2: Run — expect FAIL** (old branch flips it).

- [ ] **Step 3: Implement** — remove the `existing.status === 'pending'` flip-to-succeeded block (lines ~212-367) BUT keep the amount-mismatch check (reachable for matched pending rows) + the `!existing` out-of-band branch + already-finalised no-op. The SB-1 parent-payment recovery moves to `finalizeSucceededRefund` (A.11), so it is not lost.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix(payments): charge.refunded no longer finalizes refunds; keeps mismatch/OOB (#2)`

## PR-A.8 — `confirm-payment` stale auto-refund → `auto_refunded` (#3, CRITICAL-2)

### Task A.13: flip payment to `auto_refunded` + durable marker + failed-auto-refund alert

**Files:**
- Modify: `src/modules/payments/application/use-cases/confirm-payment.ts` (Phase B stale-refund tail)
- Modify: `src/modules/payments/infrastructure/di.ts` (`makeConfirmPaymentDeps` — no new deps needed; reuse paymentsRepo)
- Test: `tests/unit/payments/confirm-payment.test.ts` + `tests/integration/payments/stale-invoice-auto-refund.test.ts`

**Interfaces:**
- Consumes: A.4 `auto_refunded` edge; A.6 durable column write; A.3 `auto_refund_failed_needs_manual_reconcile`.

- [ ] **Step 1: Write failing tests** —
  - stale auto-refund succeeds → payment flips `pending → auto_refunded` **with `completed_at`** (guarded `expectedCurrentStatus='pending'`, atomic with `markProcessed`), `auto_refund_processor_refund_id` column set = the Stripe `re_` id; NO `refunds` row; NO F4 CN (tax#4).
  - the later `charge.refund.updated(succeeded)` for that `re_` id → `findAutoRefundByProcessorRefundId` matches → `auto_refund_recognized`, NO false OOB alert.
  - the later `charge.refund.updated(failed)` for that `re_` id → `auto_refund_failed_needs_manual_reconcile` audit + paging metric (CRITICAL-2 — not suppressed).

- [ ] **Step 2: Run — expect FAIL** (today the row stays `pending`).

- [ ] **Step 3: Implement** the Phase B success path: `updateStatus(tx, { paymentId, tenantId, nextStatus:'auto_refunded', expectedCurrentStatus:'pending', completedAt })` + set `auto_refund_processor_refund_id = refund.value.id` (extend the payments `updateStatus` patch OR a dedicated `markAutoRefunded` method — prefer a dedicated method for intent-clarity) atomic with the existing audit + `markProcessed`. Keep emitting `payment_auto_refunded_stale_invoice` / `_concurrent_manual_mark` (money-trail).

- [ ] **Step 4: Run — expect PASS** (unit + live-Neon integration).

- [ ] **Step 5: Commit** `fix(payments): stale-invoice auto-refund flips payment to auto_refunded + durable marker (#3/CRITICAL-2)`

## PR-A.9 — Stripe-aware sweep backstop (A5, M-i)

### Task A.14: sweep retrieves refund status from Stripe + finalizes (not blind-fail)

**Files:**
- Modify: `src/modules/payments/application/use-cases/sweep-stale-pending-refunds.ts`
- Modify: `src/modules/payments/infrastructure/di.ts` (`makeSweepStalePendingRefundsDeps` — add `processorGateway`, `tenantSettingsRepo`, `invoicingBridge`)
- Test: `tests/unit/payments/sweep-stale-pending-refunds.test.ts` + `tests/integration/payments/sweep-stripe-aware.test.ts`

- [ ] **Step 1: Write failing tests** — for each stale pending refund: `retrieveRefund` →
  - `succeeded` → `finalizeSucceededRefund` (issues CN idempotently, flips) → swept.
  - `failed|canceled` → `finaliseFailedRefund` → swept.
  - `pending` → **skip** (do NOT mark failed); if age > N days → emit escalation metric/alert (M-i).
  - Retrieve error → skip + count, no state change.
  Bound: cap rows per run + a shorter per-call timeout so the loop can't exceed the Vercel function budget (M-i).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the Stripe-aware loop (retrieve outside the row lock; finalize inside a per-row tx via `finalizeSucceededRefund`/`finaliseFailedRefund`). Keep per-row `try/catch` skip semantics. Reuse the RR-1 null-return handling.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `feat(payments): Stripe-aware stale-pending-refund sweep finalizes instead of blind-fail (A5)`

## PR-A.10 — #8 resume-race (verify-first, Option i)

### Task A.15: verify the resume-race, then reconcile `failed → succeeded` at confirm

**Files:**
- Test first: `tests/integration/payments/fail-then-succeed-resume-race.test.ts`
- Modify: `src/modules/payments/application/use-cases/confirm-payment.ts` (terminal `failed` → genuine succeeded charge branch)
- Test: `tests/unit/payments/confirm-payment.test.ts`

- [ ] **Step 1: Write the failing replay test** — payment attempt-1 `pending`; retry resumes the same PI (findPending keys only on `status='pending'`); `payment_intent.payment_failed` commits `failed`; then `payment_intent.succeeded` (real charge) arrives → assert TODAY it drops as `already_succeeded` with no invoice flip, no auto-refund, no forensic audit (documents the bug).

- [ ] **Step 2: Run — expect the test to demonstrate the bug** (assertion on the buggy no-op).

- [ ] **Step 3: Implement Option (i)** — in `confirmPayment`, when the locked row is terminal `failed` AND the event is a genuine `payment_intent.succeeded` with a real charge (from `retrievePaymentIntent`), do NOT silently no-op: emit a forensic audit + auto-refund the captured funds (reuse the stale-refund Stripe path) + leave the row `failed` (NO `failed→auto_refunded` edge — architect F-9). Trigger ONLY on `failed → succeeded`, never on `succeeded → succeeded`. **RR-6:** reuse the durable-marker + `findAutoRefundByProcessorRefundId` recognition for this auto-refund's `re_` id so its own `charge.refund.updated(succeeded)` does NOT fire a false OOB (or document the false OOB as expected for this rare path).

- [ ] **Step 4: Flip the test to assert the fix** (forensic audit + auto-refund issued; invoice not left silently unpaid). Run — expect PASS.

- [ ] **Step 5: Commit** `fix(payments): reconcile failed→succeeded late charge (auto-refund + forensic) (#8)`

## PR-A.11 — Cross-cutting: F9 revenue, i18n, monitoring, dead-code

### Task A.16: `auto_refunded` non-revenue in F9 + status labels + `refund_pending_awaiting_processor` metric + subscription gate (M-h, H-e)

**Files:**
- Modify: F9 insights revenue/refund aggregation (grep `src/modules/insights/**` + `src/app/(staff)/admin/**` for `PaymentStatus` literals / `status IN`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (payment-status label `auto_refunded`; refund `pending` awaiting copy)
- Modify: `src/lib/metrics.ts` (+ `refundPendingAwaitingProcessor` gauge + `autoRefundFailedNeedsReconcile` counter)
- Modify: `docs/go-live-readiness.md` or a ship checklist (H-e: enable `charge.refund.updated` delivery in Stripe endpoint config)
- Test: F9 aggregation unit test asserting `auto_refunded` excluded from revenue.

- [ ] **Step 1: Write failing test** — an `auto_refunded` payment is NOT counted in F9 revenue (mirrors the F9 credit-note-revenue lesson); a `pending` refund shows the awaiting state.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — classify `auto_refunded` as non-revenue; add EN/TH/SV labels (`audit.eventType.auto_refund_failed_needs_manual_reconcile` + payment-status `auto_refunded`); wire the two metrics; emit `refund_pending_awaiting_processor` gauge from `issueRefund`'s `kind:'pending'` return + the sweep's still-pending skip; add the Stripe-subscription go-live gate line.

- [ ] **Step 4: Run — expect PASS + `pnpm check:i18n`.**

- [ ] **Step 5: Commit** `feat(insights): auto_refunded is non-revenue + refund-pending monitoring + i18n (M-h/H-e)`

### Task A.17: remove the orphaned `findStaleInvoiceAutoRefund` (RR-5 dead-code)

**Files:**
- Modify: `src/modules/payments/infrastructure/repos/drizzle-payments-repo.ts` (delete `findStaleInvoiceAutoRefund`, ~lines 475-494) + its port declaration, IF no remaining caller.

- [ ] **Step 1:** `grep -rn "findStaleInvoiceAutoRefund" src tests` — confirm the durable-column lookup (A.6) fully replaced it and there are no other callers.

- [ ] **Step 2:** Delete the method + port signature + any test that only covered it. Run `pnpm typecheck`.

- [ ] **Step 3: Commit** `refactor(payments): drop orphaned audit-log auto-refund lookup (RR-5)`

## PR-A.12 — Integration suite + gate

### Task A.18: concurrency + cross-tenant integration tests (Review-Gate blockers)

**Files:**
- Create: `tests/integration/payments/concurrent-double-cn.test.ts`, `tests/integration/payments/process-refund-updated-cross-tenant.test.ts`, `tests/integration/payments/async-promptpay-refund-lifecycle.test.ts`

- [ ] **Step 1:** Concurrent A1-succeeded + `charge.refund.updated(succeeded)` on a **partial** refund → exactly ONE CN, `credited_total` correct, no §87 gap (CRITICAL-1 teeth).
- [ ] **Step 2:** Cross-tenant: a `re_` id from tenant A must not resolve/finalize under tenant B (Principle I blocker).
- [ ] **Step 3:** Async PromptPay lifecycle: `createRefund→pending` → row pending, no CN → `charge.refund.updated(succeeded)` → CN issued + flips; the `failed` variant → no CN + `reconciled_failed`.
- [ ] **Step 4:** `pnpm test:integration tests/integration/payments/` — all green (apply all 3 migrations first).
- [ ] **Step 5: Commit** `test(payments): concurrency + cross-tenant + async-refund integration suite`

### Task A.19: PR-A gate

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:audit-events && pnpm check:multi-tenant && pnpm test:integration tests/integration/payments` — all green.
- [ ] **Step 2:** Open PR-A. Body: bugs #1/#2/#3/#8 + CRITICAL-1/2 + migrations 0240/0241/0242 + RR-1…RR-8. Flag ≥2 reviewers + security checklist (money-path). Note the RR-4 ship-day pre-flight + Stripe-subscription enable in the PR description.

---

# Phase PR-B — Refund pre-flight vs F4 credited_total (#4) + F4-authoritative invoice status (tax#5)

Depends on PR-A (uses the shared `finalizeSucceededRefund` + refund shape). Rebase onto PR-A.

### Task B.1: pre-flight `remaining = min(payment-based, invoice-credit-based)`

**Files:**
- Modify: `src/modules/payments/application/use-cases/issue-refund.ts` (Phase A pre-flight)
- Modify: `src/modules/payments/application/ports/invoicing-bridge-port.ts` + `src/modules/payments/infrastructure/invoicing-bridge.ts` (expose `credited_total_satang` on the payability read, or add a small bridge read `getInvoiceCreditedTotal(tenantId, invoiceId)`)
- Modify: `src/modules/payments/domain/invariants/refund-not-exceeding-remainder.ts` (accept an optional `invoiceCreditedTotalSatang` + `invoiceTotalSatang` → cap)
- Test: `tests/unit/payments/refund-not-exceeding-remainder.test.ts` + `tests/integration/payments/refund-vs-manual-credit-note.test.ts`

**Interfaces:**
- Consumes: F4 `credited_total_satang` for the invoice.
- Produces: `checkRefundNotExceedingRemainder` computes `remaining = min(payment.amountSatang − Σ(F5 succeeded refunds), invoice.totalSatang − invoice.creditedTotalSatang)`.

- [ ] **Step 1: Write failing tests** — invoice=payment=10000; a manual F4 CN of 4000 already exists (credited_total=4000); an F5 refund of 8000 → **rejected** `refund_exceeds_remaining` (remaining = min(10000, 6000) = 6000) **before** any Stripe call. And a 6000 refund → allowed. (Integration: assert Stripe `createRefund` is never invoked on the rejected path.)

- [ ] **Step 2: Run — expect FAIL** (today 8000 passes, money moves, F4 later rejects → orphan refund).

- [ ] **Step 3: Implement** — thread the invoice `credited_total_satang` + `total_satang` from the F4 bridge into the Phase A pre-flight; extend `computeRefundableAmount`/`checkRefundNotExceedingRemainder` to take the min. Reject before `createRefund`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix(payments): refund pre-flight accounts for F4 credit notes (#4)`

### Task B.2: report invoice.status from F4 (authoritative) in the shared finalize helper (tax#5)

**Files:**
- Modify: `src/modules/payments/application/use-cases/_finalize-succeeded-refund.ts`
- Modify: `src/modules/payments/application/use-cases/issue-refund.ts` (drop the arithmetic `isFullyRefunded ? 'credited' : 'partially_credited'` derivation at :496-498/:635-638)
- Test: `tests/unit/payments/issue-refund.test.ts`

- [ ] **Step 1: Write failing test** — with a pre-existing manual F4 CN, `issueRefund` returns `invoice.status` matching F4's authoritative value (e.g. F4 = `credited`), NOT F5's refund-sum arithmetic (`partially_credited`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — read the invoice status from the F4 bridge/CN result inside `finalizeSucceededRefund` and return that; remove the F5-arithmetic derivation. All of A1/A2/A5 now report identically.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `fix(payments): report F4-authoritative invoice status on refund (tax#5)`

### Task B.3: PR-B gate

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:integration tests/integration/payments` — green.
- [ ] **Step 2:** Open PR-B (rebased on PR-A). Body cites #4 + tax#5.

---

# Cross-fiscal-year CN numbering (tax#2 — accountant sign-off, NOT a code task in these PRs)

Document the CURRENT behaviour explicitly (CN §87 number + document-year follow the parent
**invoice's** fiscal year, `issue-credit-note.ts:577` `loaded.fiscalYear`, while `issueDate` =
settlement date). Add a boundary integration test that PINS current behaviour (refund started FY N,
settled FY N+1; SweCham = calendar FY) so it can't silently change. Raise "invoice-FY vs
issue-date-FY for credit notes" as an **accountant sign-off item** (same class as the held
§86/10-netting / ภ.พ.30 questions). This is F4-wide, out of scope for the code changes above.

- [ ] Add `tests/integration/invoicing/credit-note-cross-fiscal-year.test.ts` pinning current behaviour + a doc note in `docs/` flagging the accountant question.

---

# Self-Review (spec coverage)

- **#1** (refund books success on non-succeeded status) → A.9 (status branch) + A.8 (retrieveRefund) + A.11 (webhook reconcile). ✓
- **#2** (dead pending-recovery + false OOB) → A.6 (early processor_refund_id via A.9) + A.12 (charge.refunded cleanup) + A.11 (proper finalize). ✓
- **#3** (stale auto-refund stuck pending) → A.4 (auto_refunded) + A.13 (flip + durable marker + failed alert). ✓
- **#4** (pre-flight ignores F4 CN) → B.1. ✓
- **#5** (amountProjectionFailed dropped) → C.1. ✓
- **#6** (disputeId dropped) → C.2. ✓
- **#7** (invoice_data_corrupt → 500) → C.3. ✓
- **#8** (failed→succeeded stranded) → A.15. ✓
- **CRITICAL-1** (CN idempotency) → A.2 (index) + A.7 (return-existing + fresh-tx reconcile) + A.9/A.11 (guarded finalize). ✓
- **CRITICAL-2** (failed auto-refund silent) → A.13 (durable column + status-branched alert). ✓
- **RR-1** (sweep coupling) → A.5. **RR-2** (fresh-tx) → A.7. **RR-3** (3 migrations) → A.1/A.2/A.3. **RR-4** (pre-flight) → 0.2. **RR-5** (dead-code + A3) → A.12/A.17. **RR-6** (#8 OOB) → A.15. **RR-7** (tax) → B.2 + cross-FY section. **RR-8** (PCI payload) → A.3. ✓
- **PCI-1/2/3** → A.10 + C.2 + A.8. **M-f** (superset) → C.4. **M-h** (F9) → A.16. ✓

**Placeholder scan:** none — every task has file paths, code for the tricky logic, and exact commands. **Type consistency:** `finalizeSucceededRefund`, `attachProcessorRefundId`, `lockForUpdateByProcessorRefundId`, `findAutoRefundByProcessorRefundId`, `retrieveRefund`/`RetrievedRefund`, `processRefundUpdated`, `auto_refunded`, `refundStatus`, `auto_refund_processor_refund_id`, `refund_succeeded` path `'webhook_refund_updated'`, `auto_refund_failed_needs_manual_reconcile` — names consistent across tasks.

---

# Execution Handoff

Branch mechanics: work proceeds on `worktree-f5-refund-lifecycle`. Because the 3 PRs are
independent-but-ordered, either (a) implement PR-C → open PR → branch PR-A off it → etc.
(stacked), or (b) implement all on the worktree branch and split into 3 PRs at the end via
`git checkout -b` + cherry-pick per phase. Given the strong PR-A↔PR-C coupling on the verifier/route,
(a) stacked is cleaner. Follow the stacked-PR squash-merge rules (rebase --onto, bottom-up).
