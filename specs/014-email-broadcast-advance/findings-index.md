# F7.1a Findings Index

Authoritative taxonomy of every finding ID surfaced across `/speckit-review`
rounds for the F7.1a (Email Broadcast Advanced) feature. Resolves notation
drift across `F-04` vs `F-4` vs `Finding 4` vs `UX F-6` etc.

## Round 1 — 2026-05-19 (Phase 1-2-3 + 3E review)

6 agents launched in parallel: `code-reviewer`, `silent-failure-hunter`,
`pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`,
`enterprise-ux-designer`. **Total: ~93 findings.**

### code-reviewer (24 findings, prefix F-NN)

| ID | Severity | Topic | Closure |
|----|----------|-------|---------|
| F-01 | CRITICAL | cross-tenant probe audit missing (retry + accept-partial) | Phase 3F.1 (4ee3578d) |
| F-04 | CRITICAL | idempotency-key rotation missing on auto-retry | Phase 3F.1 (4ee3578d) |
| F-04b | CRITICAL | idempotency-key rotation missing on manual retry (Round 2) | Phase 3F.11.1 C2 (ac6c5419) |
| F-05 | HIGH | dispatch eligible scan missing FOR UPDATE SKIP LOCKED | Phase 3F.4 (9e8e8f93) |
| F-06 | LOW | `tenant.slug as never` casts in dispatch | deferred (LOW polish 3F.11.4 candidate) |
| F-07 | LOW | `tenant.slug as never` casts in cancel-broadcast | deferred (LOW polish 3F.11.4 candidate) |
| F-10 | HIGH | tenant_broadcast_settings.dispatch_concurrency_cap not wired | Phase 3F.4 (9e8e8f93) |
| F-11 | MEDIUM | hostname normalization expectation in migration 0164 | Phase 3F.8 (da360de7) doc + Phase 3F.11.3 M2 correction |
| F-12 | MEDIUM | audit-event distinguisher manual vs auto retry | Phase 3F.7 (7b5f1c25) |
| F-13 | LOW | inclusive/exclusive range comment in dispatch | Phase 3F.7 (7b5f1c25) |
| F-14 | HIGH | admin detail page fail-open silent empty placeholder | Phase 3F.8 (da360de7) + Phase 3F.11.1 C3 i18n (ac6c5419) |
| F-15 | MEDIUM | missing-providerBroadcastId backfill cron | DEFERRED to F7.1a.1 backlog |
| F-17 | CRITICAL | splitBroadcastIntoBatches has NO production caller | Phase 3F.1 (4ee3578d) — new cron `/api/cron/broadcasts/split-large-broadcasts/route.ts` |
| F-19 | MEDIUM | FK CASCADE on broadcast_batch_manifests no integration test | Phase 3F.8 (da360de7) |
| F-21 | HIGH | cancel-broadcast batch-halt atomicity gap | Phase 3F.1 (4ee3578d) |
| F-22 | MEDIUM | cron uses tenant.slug instead of resolveTenantDisplayName | Phase 3F.7 (7b5f1c25) |
| F-23 | MEDIUM | apply-batch-webhook not-found forensic audit | Phase 3F.7 (7b5f1c25) + Phase 3F.11.2 H1 logger wrap |
| F-24 | MEDIUM | acceptPartial quota fields not COALESCE-preserved | Phase 3F.7 (7b5f1c25) |
| F-25 | MEDIUM | dispatch-batches cron observability metrics | Phase 3F.4 (9e8e8f93) |
| `Finding 4` | CRITICAL | cancel-broadcast batch-halt unreachable (sending rejected) | Phase 3F.1 (4ee3578d) widened authorizeCancel |

### silent-failure-hunter (12 findings, prefix F-N)

| ID | Severity | Topic | Closure |
|----|----------|-------|---------|
| F-1 | HIGH | empty catch in findBatchByProviderBroadcastIdBypassRls | Phase 3F.1 (4ee3578d) |
| F-3 | HIGH | dispatch updateStatus→failed Result discarded | Phase 3F.4 (9e8e8f93) |
| F-4 | HIGH | Promise.all in batch-dispatcher aborts on first throw | Phase 3F.4 (9e8e8f93) — Promise.allSettled |
| F-5 | MEDIUM | cancel markCancelled return discarded | Phase 3F.4 (9e8e8f93) |
| F-6 | HIGH | apply-batch-webhook audit emit unwrapped | Phase 3F.4 (9e8e8f93) — attribution corrected in Phase 3F.11.3 M2 |
| F-7 | HIGH | split + auto-retry audit emit unwrapped | Phase 3F.4 (9e8e8f93) |
| F-8 | HIGH | dispatch failure-path audit emit unwrapped | Phase 3F.4 (9e8e8f93) |

### pr-test-analyzer (20 findings, Finding N)

| ID | Severity | Topic | Closure |
|----|----------|-------|---------|
| Finding 1 | HIGH | dispatch-broadcast-batch no direct test coverage | Phase 3F.5 (f63fb79d) |
| Finding 2 | HIGH | batch-dispatcher no direct test coverage | Phase 3F.10 (db4aeb07) |
| Finding 3 | HIGH | apply-batch-webhook-event no direct test coverage | Phase 3F.5 (f63fb79d) |
| Finding 5 | MEDIUM | pg-advisory-lock-adapter no live-Neon test | DEFERRED to F7.1a.1 backlog |
| Finding 6 | HIGH | auto-retry budget boundary test missing | Phase 3F.5 (f63fb79d) |
| Finding 7 | HIGH | auto-retry sweep mix behavior test missing | Phase 3F.5 (f63fb79d) |
| Finding 8 | MEDIUM | route handler tests (retry + accept-partial) missing | DEFERRED to F7.1a.1 backlog |
| Finding 9 | MEDIUM | dispatch-batches cron contract test missing | DEFERRED to F7.1a.1 backlog |
| Finding 15 | MEDIUM | webhook-batch-fallback test missing | DEFERRED to F7.1a.1 backlog |
| Finding 20 | MEDIUM | webhook-batch-fallback path duplicate | DEFERRED (= Finding 15) |

### type-design-analyzer (20 findings, "Type Bottom #N")

| ID | Severity | Topic | Closure |
|----|----------|-------|---------|
| Type Bottom #1 | HIGH | BroadcastRetryStatus has ghost 'pending_review' state | Phase 3F.1 (4ee3578d) — `BroadcastRetryStatus = BroadcastStatus` |
| Type Bottom #2 | MEDIUM | TxToken brand cascade refactor | DEFERRED (out-of-scope per 3F.9 commit) |
| #3 | MEDIUM | Discriminated BatchStatusUpdate transition-tagged union | DEFERRED |
| #4 | LOW | Error-kind casing standardization | DEFERRED |
| #5 | LOW | Principle III BypassRls method rename | DEFERRED (convention signals intent) |

### comment-analyzer (20 findings, Comment #N)

7 closed by Phase 3F.3 (0a0a2c50), 3 closed by Phase 3F.4 (9e8e8f93),
remaining ~10 noted in Phase 3F.11.3 M2:
- Comment #6 (dispatch-batches/route.ts stale line ref) → Phase 3F.11.3 M2
- Comment #7 (Phase 3F.1 vs 3F.4 mis-attribution in apply-batch-webhook-event:145) → Phase 3F.11.3 M2 (was `Comment #X` placeholder in Phase 3F.11.3 — resolved in 3F.11.8 to its surfaced Round 1 ID)

### enterprise-ux-designer (13 findings, UX F-N)

| ID | Severity | Topic | Closure |
|----|----------|-------|---------|
| UX Finding 1 | HIGH | RetryDialog focus lands on Confirm | Phase 3F.2 (f08800e1) |
| UX Finding 2 | HIGH | `<Table>` missing accessible name | Phase 3F.2 (f08800e1) |
| UX Finding 3 | HIGH | formatDispatchedAt no Asia/Bangkok TZ | Phase 3F.2 (f08800e1) |
| UX F-4 | MEDIUM | reasonPlaceholder microcopy | Phase 3F.7 (7b5f1c25) |
| UX F-5 | MEDIUM | motion-reduce ring fallback for partially_sent | Phase 3F.7 (7b5f1c25) + Phase 3F.11.2 H3 contrast fix |
| UX F-6 | HIGH | focus return on dialog close | Phase 3F.9 (1c8bb835) ATTEMPTED → Phase 3F.11.1 C1 ACTUAL closure (ac6c5419) — Round 1 fix wired prop on wrong layer |
| UX F-8 | LOW | E2E off-by-one (45 vs 44 chars) | Phase 3F.7 (7b5f1c25) |
| UX F-9 | LOW | SV grammar "Försöka" → "Försök" | Phase 3F.7 (7b5f1c25) |
| UX F-10 | MEDIUM | aria-live placement in `<summary>` | claimed by 3F.3 → Phase 3F.11.2 H2 ACTUAL closure (6e91aa54) |
| UX F-11 | LOW | orphan i18n key `admin.broadcasts.batches.empty` | OPEN — Phase 3F.11.4 candidate |
| UX F-12 | MEDIUM | Table min-width per column | Phase 3F.7 (7b5f1c25) |
| UX F-13 | MEDIUM | canAcceptPartial guard for succeeded=0 | Phase 3F.7 (7b5f1c25) |

---

## Round 2 — 2026-05-19 (Phase 1-2-3 + Phase 3F.x re-review)

6 agents re-launched with delta scope (commits `4ee3578d..db4aeb07`).
**Total: ~17 findings** including 4 silent-broken Phase 3F fixes.

### CRITICAL (4)

| ID | Topic | Closure |
|----|-------|---------|
| C1 | finalFocus on AlertDialog Root instead of Popup | Phase 3F.11.1 (ac6c5419) |
| C2 | Manual-retry idempotency-key rotation missing (= F-04b above) | Phase 3F.11.1 (ac6c5419) |
| C3 | F-14 fail-open panel hardcoded EN | Phase 3F.11.1 (ac6c5419) |
| C4 | Dispatch success-path audit emits unwrapped | Phase 3F.11.1 (ac6c5419) |

### HIGH (4)

| ID | Topic | Closure |
|----|-------|---------|
| H1 | Cross-tenant probe audit emit in 3 use cases has empty catch | Phase 3F.11.2 (6e91aa54) |
| H2 | UX F-10 aria-live in `<summary>` (ARIA 1.2 violation) | Phase 3F.11.2 (6e91aa54) |
| H3 | Ring contrast WCAG SC 1.4.11 fail on partially_sent badge | Phase 3F.11.2 (6e91aa54) |
| H4 | split-large-broadcasts orphan recovery (broadcast stuck in approved) | Phase 3F.11.2 (6e91aa54) |

### MEDIUM (5)

| ID | Topic | Closure |
|----|-------|---------|
| M1 | cancel-broadcast cross-tenant probe + skip pending query | Phase 3F.11.3 |
| M2 | Comment rot from 3F.3 sweep (line refs + phase tags + findings-index) | Phase 3F.11.3 |
| M3 | broadcast_cross_tenant_probe event-type mis-categorisation on webhook | Phase 3F.11.3 |
| M4 | Migration 0164 hostname normalization note unimplemented | Phase 3F.11.3 (rolled into M2) |
| M5 | FOR UPDATE SKIP LOCKED comment scope claim | Phase 3F.11.3 (rolled into M2) |

### LOW + test gaps (carried to Phase 3F.11.4)

Detail: focus-ring offset, BatchStatusForUi alias, `as never` cleanup,
orphan i18n key, 3 new test branches.

---

## Notation Conventions

- **F-NN** (zero-padded 2-digit) — code-reviewer findings (e.g. `F-04`, `F-17`)
- **F-N** (single-digit) — silent-failure-hunter findings (e.g. `F-1`, `F-6`)
- **Finding N** — pr-test-analyzer findings (e.g. `Finding 1`, `Finding 4`)
- **Type Bottom #N** — type-design-analyzer findings
- **Comment #N** — comment-analyzer findings
- **UX F-N** / **UX Finding N** — enterprise-ux-designer findings
- **C1/H1/M1/L1** — Round 2 severity-prefixed IDs

Notation drift fix policy: when an ID appears in multiple sources (e.g.,
`F-04` from code-reviewer AND `F-4` from silent-failure-hunter referring
to DIFFERENT findings), this index disambiguates by listing both with
their source agent. Inline code comments SHOULD reference this index
when ambiguity is possible.

---

## Deferred Backlog (F7.1a.1)

Items explicitly deferred from Phase 3F + Phase 3F.11 closure for the
F7.1a.1 follow-up cycle:

1. F-15 — missing-providerBroadcastId backfill cron (heavy scope)
2. Finding 5 — pg-advisory-lock-adapter live-Neon test
3. Finding 8 — route handler tests (retry-route + accept-partial-route)
4. Finding 9 — dispatch-batches cron contract test
5. Finding 15/20 — webhook-batch-fallback test
6. Type Bottom #2-#5 — TxToken brand cascade + discriminated
   BatchStatusUpdate + casing standardisation + BypassRls rename

Last updated: 2026-05-19 — Phase 3F.11.3 closure
