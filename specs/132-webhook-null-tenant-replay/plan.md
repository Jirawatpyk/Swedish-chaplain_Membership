# Plan: 132 — adopt a NULL-tenant processor_events row on replay (L-1)

Spec: `specs/132-webhook-null-tenant-replay/spec.md`. Branch `132-webhook-null-tenant-replay` (this worktree, from `origin/main` 0a5091e57). One slice. Migration 0320 (one `audit_event_type` value, added in review round 1); no flag, no new dependency.

## Context

A Stripe event that first arrived for an unregistered account leaves a `processor_events` row with `tenant_id NULL`, `processed_at NULL`. When it is replayed after the account is registered, the dispatch runs but `markProcessed` (as `chamber_app`) matches 0 rows: the 0036 SELECT policy hides NULL-tenant rows. The probe on Neon dev confirmed it (26 Oct 2026). So every replay dispatches again and the log never records the work as done. The maintainer chose option (a): adopt the row on the owner connection when a replay arrives.

## Approach

1. **Repo, `insertIfNew` duplicate path** (`src/modules/payments/infrastructure/repos/drizzle-processor-events-repo.ts`). It already runs on the owner `db`. After the ON CONFLICT re-read, when `input.tenantId !== null` and the existing row has `tenantId === null`, run one owner-role UPDATE:
   `SET tenant_id = input.tenantId, outcome = 'processed' WHERE id = $id AND tenant_id IS NULL AND outcome IN ('acknowledged_only','rejected_environment_mismatch','rejected_api_version_mismatch') AND processor_account_id = input.processorAccountId AND livemode = input.livemode RETURNING *`.
   - 1 row → return `{ inserted: false, event: adopted, adoptedFrom: <old outcome> }`.
   - 0 rows (a predicate failed, or a concurrent replay adopted it first) → return the re-read row unchanged (re-read once more so a concurrent adopt is seen).
   - `outcome = 'processed'` matches what a fresh step-6 insert writes, so the existing recovery path, the default branch's `updateOutcome`, and the `unprocessed-events-count` gauge all behave as for a normal row. `received_at`, `correlation_id`, `payload_sha256` stay the first delivery's.
2. **Port** (`application/ports/processor-events-repo.ts`): the result gains an optional `adoptedFrom?: ProcessorEventOutcome`. Optional so no existing stub has to change; docstring rewritten.
3. **Use case** (`application/use-cases/process-webhook-event.ts`, step 6):
   - if `adoptedFrom` is set → `logger.info('stripe-webhook.unresolved_row_adopted', { eventId, eventType, tenantId, adoptedFrom })` + `paymentsMetrics.webhookUnresolvedRowAdopted(tenantId, type)`, then the existing recovery path (processed_at is NULL) dispatches.
   - **fail-closed backstop**: if not inserted and `inserted.event.tenantId !== tenantId` (still NULL, or another tenant) → do not dispatch; `logger.warn('stripe-webhook.duplicate_tenant_mismatch', { eventId, eventType, tenantId, storedTenant: 'null' | 'other' })` + `paymentsMetrics.webhookDuplicateTenantMismatch(tenantId, type)`; return `ok({ kind: 'duplicate' })`. This closes the loop for every row (a)'s predicate refuses (`rejected_signature`, account or livemode mismatch) and for an account that moved tenants. No account id in labels.
4. **Metrics** (`src/lib/metrics.ts`): two counters next to `webhookDispatchRecoveryReplay`: `payments_webhook_unresolved_row_adopted_total`, `payments_webhook_duplicate_tenant_mismatch_total`, labels `tenant`, `event_type`. Add both to `docs/observability.md` § payments metrics table.
5. **Docs**: repo + port docstrings; `specs/009-online-payment/data-model.md` § 5.4 reality-check block and the `tenant_id` row (~240), noting 0036's comment is historical; the `unprocessed-events-count` route docstring (acknowledged_only rows are no longer *permanently* NULL); `docs/decisions.md` new **D-031** "a replay adopts a NULL-tenant processor_events row on the owner connection" (revises the 2026-04-25 "never promoted" rule); `docs/changelog.md` line.

**Security (new owner-role write)**: the written tenant comes only from `resolveTenantByProcessorAccountId` (server-side lookup of the signature-verified event's account), never from the payload directly; the `processor_account_id` + `livemode` equality bounds adoption to the row's own account; `rejected_signature` is excluded (and the CHECK forbids it anyway); the backstop refuses to dispatch any mismatch. RLS is unchanged.

**Not taken**: (b) policy change (exposes every rejection row to every tenant); (c) refuse-only (event could never be applied); adopting only `acknowledged_only` (the env/api-version rows would keep looping — the backstop would stop the loop but leave them unprocessable after a config fix).

**Overlap with open PR #663**: it edits the same repo file (imports, factory docstring, `markProcessed`/`updateOutcome` get `tenant_id = tenantSlugOf(tx)`). The adopted row carries the resolved tenant, so both compose; whichever merges second rebases (a small import/docstring conflict).

## Test plan (RED commit first, then GREEN)

| Done-when | Test that goes red first |
|---|---|
| 1, 2 | **Integration** `tests/integration/payments/webhook-null-tenant-replay.test.ts` (new, live Neon dev, `createTwoTestTenants`, real `makeProcessWebhookEventDeps`): seed a NULL-tenant `acknowledged_only` row for account X; replay an unknown-type event (`customer.created`, default branch: `updateOutcome` + `markProcessed`, no money side effects) with tenant A → row has `tenant_id = A`, `processed_at` set, original `received_at`/`correlation_id`; replay again → `{ kind: 'duplicate' }`. Same for a `rejected_api_version_mismatch` row. RED today: tenant stays NULL, processed_at NULL, second call not duplicate. |
| 3 | Same file: a NULL row with a different `processor_account_id` → tenant stays NULL, result `duplicate`, no dispatch (processed_at NULL). Unit (`tests/unit/payments/application/process-webhook-event.test.ts`): duplicate stub with `tenantId: null` / another tenant and `processedAt: null` → `duplicate`, no sub-use-case called, mismatch metric called. |
| 1 (repo) | Integration in `processor-events-idempotency.test.ts`: `insertIfNew` with a tenant on an existing NULL `acknowledged_only` row returns `adoptedFrom: 'acknowledged_only'` and the adopted row; `rejected_signature` row is not adopted. |
| 4 | Unit: `adoptedFrom` set → adopted metric + info log called once with no account id. |
| 5 | Docs reviewed by the reviewers; no test. |

Cleanup: rows deleted in a `SET LOCAL ROLE neondb_owner` tx (as the existing idempotency test does), tenants via `tenant.cleanup()`. The temporary `zz-l1-probe.test.ts` is deleted before the first commit.

## Constitution Check

I tenancy: two layers kept; the owner write is bounded by account + NULL predicate, backstop refuses mismatches (security-engineer reviews). II TDD: RED commit then GREEN. III Clean Architecture: SQL stays in the repo, metrics/logs in the use case, port widened optionally. IV PCI: no card data touched; no payload in logs. V–X: no UI/i18n; observability adds two counters + docs; no dependency.

## Complexity Tracking

**Deviation — Principle I, database layer.** The adoption UPDATE runs on the owner connection (`neondb_owner`, BYPASSRLS) and sets `tenant_id` itself, so RLS does not guard that one statement. Its walls are the app predicate (`tenant_id IS NULL`, adoptable outcome, same account or `''`, same livemode), the tenant coming only from the server-side account lookup of a signature-verified event, the CHECK forbidding a tenant on `rejected_signature`, and the use-case refusal of any mismatched duplicate. Rejected simpler alternatives: a policy change (every tenant would see every rejection row) and refuse-only (the event could never be applied). Recorded as D-031.

Payment surface → solo-maintainer review (review-and-ship § 2), its five checks:

1. Repeated independent rounds (round 1: `/code-review high` 5 Low/cleanup; financial-integrity PASS, 5 Low; security APPROVE WITH FIXES, 2 Medium; pci-saqa PASS, 0; reliability 3 Medium; senior-tester NOT SHIP-READY, 2 Critical test gaps — all closed in round-1 fixes below): `/code-review high` + `financial-integrity-reviewer`, `pci-saqa-guardian`, `security-engineer`, `reliability-guardian`, fresh subagents per round, until a round finds no High/Medium; counts per round in the PR.
2. Staff review: `whole-branch-reviewer` + `security-engineer` + `senior-tester` on the same diff.
3. Coverage + real infrastructure: `pnpm test:coverage`; integration on Neon dev for the adoption and the refusal (`webhook-null-tenant-replay.test.ts`, `processor-events-idempotency.test.ts`).
4. Defence in depth: the 0036 RLS policies are unchanged and still hide NULL rows from `chamber_app`; CHECK `processor_events_sig_reject_implies_null_tenant` refuses a tenant on a `rejected_signature` row at the database even if the repo predicate regressed.
5. Post-remediation: the reviewer that raises a finding re-runs on its fix in a new subagent.

## Verification

`pnpm check` → `pnpm test:coverage` → `pnpm vitest run tests/contract/` → `pnpm test:integration tests/integration/payments/webhook-null-tenant-replay.test.ts tests/integration/payments/processor-events-idempotency.test.ts tests/integration/payments/unprocessed-events-count.test.ts`. No UI, so no :3400 run; the integration test is the end-to-end proof (Done-when evidence goes in `plan.md` § Evidence). Then `/code-review high origin/main...HEAD`, the reviewers above, PR via the template, CI green. No merge.

## Rollout / Risks

Deploys with the merge; behaviour changes only for duplicate deliveries whose stored tenant is NULL or different. Risk: an operator replay now settles an invoice for a payment that arrived before the account was registered — that is the intended outcome; the adopt log + metric make it visible.

## Evidence

- RED (commit d64c6ecb0), Neon dev, 26 Oct 2026: `webhook-null-tenant-replay.test.ts` — "a acknowledged_only row is adopted…" → `expected null to be 'test-bc21c208'` (tenant stays NULL); "a row from another account is not adopted and not dispatched" → `expected 'acknowledged_only' to be 'duplicate'` (it was dispatched); `processor-events-idempotency.test.ts` "a resolved-tenant replay adopts…" → `expected undefined to be 'acknowledged_only'`; unit `process-webhook-event.test.ts` 3 new cases failed (backstop + metrics absent).
- Done when 1, 2: GREEN — `webhook-null-tenant-replay.test.ts` both outcomes (`acknowledged_only`, `rejected_api_version_mismatch`): row ends `tenant_id` = test tenant, `processed_at` set, `received_at` / `correlation_id` the first delivery's; the second replay returns `duplicate`.
- Done when 3: GREEN — another account's row stays `tenant_id NULL`, `processed_at NULL`, `acknowledged_only`, result `duplicate`; `rejected_signature` row not adopted (idempotency test); unit: NULL / other-tenant duplicate → `duplicate`, no `markProcessed`, no `markPaidFromProcessor`, mismatch metric + warn.
- Done when 4: unit — adoption counts once and logs `stripe-webhook.unresolved_row_adopted` with `adoptedFrom`, no account id.
- Done when 5: repo + port docstrings, data-model § 5.4 + `tenant_id` row, gauge docstring, `docs/observability.md`, D-031, changelog.
- Gates: `pnpm check` exit 0; unit `tests/unit/payments/` 46 files / 816 tests passed; integration (3 files incl. `unprocessed-events-count`) 12/12 passed.

### Review round 1 → fixes (maintainer decisions 26 Oct 2026: audit event; adopt the `''` account row)

- Audit trail (security R-2, reliability M-3, financial L-3): new `webhook_unresolved_event_adopted` (migration 0320, 10 y) emitted on a `null` tx before dispatch; payload ids + outcome only.
- No-account row (reliability M-2, financial L-1, security L-4): adoption also accepts a row recorded with `''`; runbook § Unresolved rows and replays covers what is still refused; alert rule `f5-webhook-duplicate-tenant-mismatch`.
- Crash-recovery metric no longer counts an adoption (reliability L-1, financial L-2).
- Step 6 no longer opens an empty tenant tx around `insertIfNew` (reliability M-1).
- Repo pre-checks the predicate before the UPDATE; `ADOPTABLE_OUTCOMES` readonly (code-review efficiency + simplification).
- Tests (senior-tester C-1/C-2/H-1/H-2, security R-1): env-mismatch adoption, livemode mismatch, `''` account, two concurrent replays (one audit row), another tenant's unstamped row refused on live Neon with two tenants, second replay leaves the stamp unchanged, adoption not counted as recovery.
- Docs: env-mismatch adoption is reachable only after the deployment's live/test mode changed (code-review correctness note).
- Not done: a live `payment_intent.succeeded` settlement through an adopted row (financial "recommended"). The default branch and `unknown_intent` both stamp through the same `markProcessed`; the settlement path's idempotency is unchanged by this PR.
- Evidence round 2: RED 512243734 — audit query failed (enum value absent), `''` row `expected undefined to be 'acknowledged_only'`, unit adoption audit `expected [] to have a length of 1`. GREEN: migration 0320 applied to Neon dev and verified in `pg_enum` (n = 1); integration 4 files 20/20 (replay, idempotency, audit-event-type parity, unprocessed-events-count); unit payments + guard + label coverage 853 passed; payments webhook contract tests 18/18; `tsc` clean.

### Review round 2 → fixes

Round 2 (fresh subagents on 8cefc0e7d): financial-integrity PASS (3 Low); security APPROVE, checklist signed (2 Low); reliability 1 Medium + 2 Low; senior-tester NOT SHIP-READY (1 High, 1 Medium); spec-compliance COMPLIANT (DW5 partial, Low).

- Adoption and audit not atomic (reliability M-1, senior-tester H-R2-1, security L-1, spec DW4 Low): `insertIfNew` takes `onAdopted(ownerTx, adoptedFrom, event)` and runs the UPDATE and the callback in one owner transaction; the use case writes the audit row there (non-null tx → the adapter bubbles a failure, the adoption rolls back, the next replay adopts again).
- Fallback branch only probabilistically tested (senior-tester Medium): deterministic row-lock test — the adopting UPDATE blocks on a held lock, the holder commits a tenant, the replay returns the committed row with no adoption and `onAdopted` uncalled.
- The `''` arm depends on the route's SweCham-gated fallback (security L-2): comment at the fallback in `route.ts` ties it to D-031.
- The race loser counts as a crash recovery (financial L-1, reliability L-1, security INFO): accepted and documented in `docs/observability.md` (it does re-dispatch like one).
- Docs: spec / plan no longer say "no migration"; data-model `tenant_id` row no longer claims an FK (0036 has none).
- Not red first: the livemode, two-tenant and concurrent integration tests (512243734) and the row-lock test guard code that already existed (54d37017e, 8cefc0e7d); they were proven by mutation in senior-tester round 2 (M1–M6 all killed), not by a RED run.
- Accepted Lows: mismatch refusal leaves no audit row (only warn + counter + alert); no live `payment_intent.succeeded` settlement test through an adopted row; adopted row keeps the first delivery's `api_version` / `payload_sha256`.
- Evidence round 3: RED 172c18f32 — unit `expected null to be { owner: 'adoption-tx' }`; integration "a failing onAdopted rolls the adoption back" → `promise resolved … instead of rejecting`. GREEN: integration replay + idempotency 15/15 (row-lock test 1834 ms, i.e. it blocked); unit payments + architecture 823 passed.
