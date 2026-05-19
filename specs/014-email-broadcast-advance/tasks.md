# Tasks: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Input**: Design documents from `/specs/014-email-broadcast-advance/`
**Prerequisites**: plan.md (required) ✓ · spec.md ✓ · research.md ✓ · data-model.md ✓ · contracts/ (3 active + 5 deferred) ✓ · quickstart.md ✓ · starter-templates.md ✓

**Tests**: REQUIRED per Constitution v1.4.0 Principle II (TDD NON-NEGOTIABLE) — every user story MUST have ≥1 acceptance-level contract test authored BEFORE implementation (RED commit → GREEN). Plus integration tests on live Neon Singapore (cross-tenant probes) + Playwright e2e (axe-core a11y + i18n).

**Organization**: Tasks grouped by user story (US1, US2, US7) for independent implementation + testing. Setup + Foundational phases share across all USs.

**Total**: **164 tasks** (well under 200 threshold per Clarifications round 3 Q1 — F7.1a ships all 3 USs as planned; no US7 deferral needed). Distribution: 10 Setup + 21 Foundational + 30 US1 + 24 US2 + 36 US7 + 43 Polish (28 base + 13 checklist-driven from `checklists/` walkthrough 2026-05-18 + 2 analyze-driven from `/speckit.analyze` 2026-05-18).

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Parallelizable (different files, no incomplete-dep)
- **[Story]**: US1, US2, US7 (story-phase tasks only — setup/foundational/polish have no story label)

## Path Conventions

- **Source**: `src/modules/broadcasts/` (extends F7 MVP bounded context) + `src/app/` (Next.js routes) + `src/components/` (UI)
- **Tests**: `tests/{contract,integration,unit,e2e}/broadcasts/`
- **Migrations**: `drizzle/migrations/0161–0168_f71a_*.sql` (renumbered from 0127-0134 on 2026-05-18 — F14 branched off `main` while 012-eventcreate-integration was concurrently shipping F6 + F1 hardening, which occupied 0127-0160 on the shared Neon main branch; F14 lands AFTER 012's contribution)
- **Infrastructure**: `infra/clamav/` (Fly.io app), `scripts/` (auto-gen + verification)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: New dependencies, infrastructure scaffolding, feature flags. NO user-story-specific code.

- [X] T001 [P] Install new npm dependencies: `pnpm add clamscan@^2.4 @tiptap/extension-image@^3.22` and verify resolved versions in `pnpm-lock.yaml` — **pinned `@tiptap/extension-image@3.22.5`** to match existing core 3.22.5 (Clarifications round 3 Q2); also added `@types/clamscan@^2` (clamscan ships no types of its own)
- [X] T002 [P] Add F7.1a feature flags to `.env.example`: `FEATURE_F71A_BROADCAST_ADVANCED`, `FEATURE_F71A_US1_PAGINATION`, `FEATURE_F71A_US2_IMAGES`, `FEATURE_F71A_US7_TEMPLATES` (all default `"false"`); add `CLAMAV_HOST`, `CLAMAV_PORT="3310"`, `CLAMAV_TIMEOUT_MS="300000"`, `CLAMAV_SHARED_SECRET`
- [X] T003 [P] Add F7.1a feature flags to `src/lib/env.ts` zod schema with boolean parsing + defaults; export typed config object — also added new `env.clamav.{host,port,timeoutMs,sharedSecret}` block; `CLAMAV_SHARED_SECRET` length guard deferred to Phase 2 T025 adapter runtime check (keeps env shape stable across dark→live transition)
- [X] T004 [P] Create `infra/clamav/Dockerfile` extending `clamav/clamav:stable`; enable clamd TCP listener on 3310; expose port
- [X] T005 [P] Create `infra/clamav/fly.toml` for Fly.io `sin` region, `shared-cpu-1x@256mb`; configure health check on 3310; document deploy commands — also configured `[[mounts]]` for `clamav_data` 1 GB volume so freshclam doesn't redownload signatures on every restart
- [X] T006 [P] Create `infra/clamav/README.md` with deploy + monitor + rotate-shared-secret instructions; link to `docs/runbooks/clamav-*` (runbooks themselves created at Phase 6 T124/T125)
- [X] T007 [P] Create `scripts/verify-clamav-connectivity.ts` self-test: connects to `CLAMAV_HOST:CLAMAV_PORT`, runs a known-clean test scan, reports verdict + latency — 4 probes (ping, EICAR, clean buffer, 5-sample latency p50/p95/p99); exit codes split between unconfigured (2) and connectivity failure (1)
- [X] T008 [P] Create `scripts/generate-template-seed-migration.ts` (per critique E2/X2): parses `specs/014-email-broadcast-advance/starter-templates.md` → emits `drizzle/migrations/0168_f71a_default_template_seed.sql` (originally 0134; renumbered Phase 2 — see Migrations note above); supports `--check` mode (regenerate + diff against committed; non-zero exit on drift) for CI gate — strict state-machine parser asserts 5×3=15 rows; `pnpm check:template-seed` alias added
- [X] T009 Extend ESLint `no-restricted-imports` rule in root `eslint.config.mjs` (flat config — project migrated from `.eslintrc.json` pre-F1) to cover the new F7.1a vendor deps. The existing broadcasts barrel-guard at `eslint.config.mjs` lines 341-356 already blocks deep imports across `src/modules/broadcasts/{domain,application,infrastructure}/**` sub-paths from outside the module — no change to that block needed. Phase 1's actual extension: add `clamscan` (Node lib talking to TCP daemon) + `@tiptap/extension-image` (browser RTE plugin) to both `domainForbiddenImports` (eslint.config.mjs lines 14-39) and `applicationForbiddenImports` (lines 39-65) arrays — forcing all imports through Infrastructure ports (Phase 2 T021 + T025 + T073). Mirrors the existing F7 entries for `@tiptap/react`, `@tiptap/starter-kit`, `isomorphic-dompurify`, `email-validator`
- [X] T010 Add CI gate that fails build if `starter-templates.md` and `0168_f71a_default_template_seed.sql` (originally `0134_*.sql`; renumbered Phase 2) drift. Project does not have a monolithic `.github/workflows/ci.yml` — the existing convention (visible in `multi-tenant-readiness.yml`) is **one workflow per concern**, which keeps a hang or failure in one gate from masking another. **Defense-in-depth implementation**: (a) `.husky/pre-push` appended `pnpm check:template-seed` (matches project memory `feedback_contract_in_prepush`: "Critical contract suites in pre-push (~22s)" — fast local feedback before the network round-trip); (b) NEW single-concern workflow `.github/workflows/template-seed-drift.yml` with path-filtered PR trigger on the 3 source/output files + workflow_dispatch + 3-min timeout — the safety net against `git push --no-verify` bypass. Both layers invoke the same `pnpm check:template-seed` alias added in T008

**Checkpoint**: Dependencies + infra + flags ready. Migrations not yet applied.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema migrations + RLS + base ports + barrel exports. MUST complete before any US-phase work begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete (advisory-lock helpers, audit-event types, RLS+FORCE policies are shared).

### Drizzle schema + migrations

- [X] T011 Extend `src/modules/broadcasts/infrastructure/schema.ts` with NEW table `broadcastTemplates` (per data-model § 2.4: id, tenantId, name, subject, bodyHtml, locale enum, startedFromCount, isSeeded, createdByUserId, createdAt, updatedAt, deletedAt + indexes + CHECK constraints) — **Deviation**: `tenantId` typed as TEXT (not uuid as data-model.md § 2.4 mistypes) to match F7 MVP composite-PK convention (src/modules/broadcasts/infrastructure/schema.ts lines 148, 304, 376, 425); Phase 2 plan Risk R1. Single-column PK `id` + tenant+name+locale unique index — tenant isolation enforced by migration 0166 RLS+FORCE. Soft-delete via `deletedAt` per FR-023.
- [X] T012 Extend `src/modules/broadcasts/infrastructure/schema.ts`: add **5 new columns** (not 4 as task originally stated) to `broadcasts` table — `manualRetryCount` (CHECK 0..3), `partialDeliveryAcceptedAt`, `partialDeliveryAcceptedByUserId`, `startedFromTemplateId` FK to broadcastTemplates.id ON DELETE SET NULL, `templateNameSnapshot` TEXT (denormalised name for forensic audit per FR-019 / critique P9). All ADD COLUMN non-destructive — existing F7 MVP broadcasts rows accept defaults.
- [X] T013 Extend `src/modules/broadcasts/infrastructure/schema.ts` with NEW table `broadcastBatchManifests` (per data-model § 2.2: id, tenantId, broadcastId FK, batchIndex, recipientCount, recipientRangeStart, recipientRangeEnd, status TEXT enum [pending, sending, sent, failed, cancelled] (cancelled added per analyze round 2 N1 — supports T163 cancel-with-batch-halt per FR-004), providerAudienceId, idempotencyKey UNIQUE, retryCount, deliveredCount, bouncedCount, complainedCount, unsubscribedCount, dispatchedAt, failedAt, failureReason, createdAt, updatedAt) + CHECK recipientCount ≤ 10000 + CHECK retryCount [0,5] — **Deviation**: composite FK `(tenant_id, broadcast_id) → broadcasts(tenant_id, broadcast_id) ON DELETE CASCADE` (NOT `broadcasts.id` which doesn't exist on the F7 MVP composite-PK schema); Phase 2 plan Risk R7. Status uses TEXT + CHECK constraint (not pgEnum) — small set, extends without ALTER TYPE rituals.
- [X] T014 Extend `src/modules/broadcasts/infrastructure/schema.ts` with NEW table `tenantImageSourceAllowlist` (per data-model § 2.3: id, tenantId TEXT, hostname, isDefault, createdByUserId, createdAt) + CHECK hostname RFC-1035 format no-wildcard. Defaults seeded lazily at runtime by Phase 4 T072 use case (migration 0164 cannot iterate tenants — no central `tenants` table verified live).
- [X] T015 Extend `src/modules/broadcasts/infrastructure/schema.ts`: add **NEW table** `tenantBroadcastSettings` (NOT "extend" as task originally stated — table did NOT exist in F7 MVP; verified by grep across src/modules/broadcasts/** + drizzle/migrations/** finding zero pre-F7.1a occurrences). One row per tenant (tenant_id PRIMARY KEY) + `dispatchConcurrencyCap` INT DEFAULT 4 + CHECK 1..8. Phase 2 plan Risk R2 documents the create-vs-extend deviation from data-model § 2.5.
- [X] T016 Hand-write 5 migration SQL files **0161-0165** (renumbered from 0127-0131 — Phase 2 plan): 0161 templates, 0162 broadcasts ext, 0163 batch manifests, 0164 image allowlist, 0165 tenant settings (NEW table, not EXTEND — see plan.md Risk R2). Project uses hand-written migrations, not `pnpm drizzle-kit generate` (per Phase 2 plan Discovery #4); schema.ts is the source of truth for future drizzle-kit diff
- [X] T017 Write `drizzle/migrations/0166_f71a_rls_policies.sql` (renumbered from 0132) manually: ENABLE ROW LEVEL SECURITY + FORCE + tenant_id policy on `broadcast_templates`, `broadcast_batch_manifests`, `tenant_image_source_allowlist` + `tenant_broadcast_settings`
- [X] T018 Write `drizzle/migrations/0167_f71a_audit_event_grants.sql` (renumbered from 0133) manually: 10 new `ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS` statements (4 US1 + 3 US2 + 3 US7). All 5y retention via existing audit_log.retention_years trigger (Constitution v1.4.0)
- [X] T019 Verify `drizzle/migrations/0168_f71a_default_template_seed.sql` (renumbered from 0134; emitted Phase 1 T008) — re-run generator + `pnpm check:template-seed` → PASS
- [X] T020 Applied 8 migrations 0161-0168 to live Neon Singapore main branch 2026-05-19 (post-012-ship rebase). Verified via `scripts/verify-f71a-migrations.ts`: 166 total applied (was 155); 4 new F71A tables present (`broadcast_templates`, `broadcast_batch_manifests`, `tenant_image_source_allowlist`, `tenant_broadcast_settings`); 5 new columns on `broadcasts` (`manual_retry_count`, `partial_delivery_accepted_at/by`, `started_from_template_id`, `template_name_snapshot`); 10 new audit_event_type enum values; 4 RLS+FORCE policies installed; 15 starter templates seeded for `swecham` tenant. **5 in-flight fixes**: (a) journal timestamps bumped to be monotonic after Dec 3 — drizzle's migrate filters by `created_at` > last applied; (b) 0164 made idempotent with `IF NOT EXISTS` + seed loop removed (no `tenants` table — defaults seeded by runtime use case Phase 4 T072); (c) 0168 tenant source changed from `FROM tenants` to `SELECT DISTINCT tenant_id FROM members WHERE tenant_id NOT LIKE 'test%'`; (d) 0167 header rephrased to remove backticked `statement-breakpoint` substring that confused drizzle's statement splitter; (e) 0168 `ON CONFLICT ON CONSTRAINT name` changed to `ON CONFLICT (tenant_id, name, locale)` because Postgres `ON CONSTRAINT` syntax requires a real UNIQUE CONSTRAINT, not a UNIQUE INDEX. Bonus: applied 0158-0160 (012's tail-end work) along the way.

### Application-layer base infrastructure

- [X] T021 [P] Create `src/modules/broadcasts/application/ports/virus-scanner-port.ts` — `scan(content: Buffer | Readable): Promise<VirusScanVerdict>` where VirusScanVerdict is tagged-union `{verdict: 'clean'|'infected'|'error'|'timeout', durationMs, ...}`. Pure interface, no framework imports.
- [X] T022 [P] Create `src/modules/broadcasts/application/ports/image-allowlist-port.ts` — `findByTenantId(tenantId): Promise<readonly AllowlistEntry[]>` + `add(tenantId, hostname, actorUserId): Promise<Result<void, AllowlistAddError>>` + `remove(tenantId, hostname): Promise<Result<void, AllowlistRemoveError>>` where remove() rejects `is_default=TRUE` rows with `cannot_remove_default`. Introduces `Hostname` branded type (Domain VO Phase 4 T069).
- [X] T023 [P] Create `src/modules/broadcasts/application/ports/broadcast-templates-port.ts` — 6 methods: findById, findByTenantId (with locale filter), create, update, softDelete, incrementStartedFromCount. All Result<T,E> for errors. Tenant-scoped via RLS+FORCE (migration 0166).
- [X] T024 [P] Create `src/modules/broadcasts/application/ports/batch-manifests-port.ts` — 5 methods: findByBroadcast, findPendingByBroadcast, bulkInsert, updateStatus, markCancelled (per data-model § 2.2 N1 for FR-004 cancel halt). Documents advisory-lock contract — use-case acquires lock, NOT this port.

### Infrastructure-layer adapters (skeleton, NOT impl)

- [X] T025 [P] Create `src/modules/broadcasts/infrastructure/clamav-virus-scanner.ts` implementing `VirusScannerPort` via `clamscan@^2.4` Node binding. Lazy singleton init + classify errors (timeout/unreachable/daemon_error/unknown). Empty `CLAMAV_HOST` → `verdict: 'error', reason: 'unconfigured'`. CLAMAV_SHARED_SECRET ≥32 chars runtime guard fires only when master flag ON (deferred from Phase 1 env.ts T003 per shape-stability rationale). **Production-ready impl** (not skeleton — same code path used by Phase 1 `scripts/verify-clamav-connectivity.ts`).
- [X] T026 [P] Create `src/modules/broadcasts/infrastructure/clamav-endpoint-resolver.ts` — pure typed accessor for `env.clamav.*` with prod/dev/staging mode detection (`*.internal` → production; localhost/127.0.0.1 → development; other → staging). Returns tagged-union `{ok: true, ...} | {ok: false, reason}` for fail-closed handling.
- [X] T027 [P] Create `src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts` SKELETON implementing `ImageAllowlistPort`. All methods throw `notImplemented('label')` — real impl lands Phase 4 T072 `manage-image-allowlist.ts`.
- [X] T028 [P] Create `src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts` SKELETON implementing `BroadcastTemplatesPort`. All methods throw `notImplemented` — real impl lands Phase 5 T099-T103.
- [X] T029 [P] Create `src/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo.ts` SKELETON implementing `BatchManifestsPort`. All methods throw `notImplemented` — real impl lands Phase 3 T044-T048. Advisory-lock contract documented in header: use case acquires `pg_advisory_xact_lock('broadcasts-batch:' || tid || ':' || bid || ':' || idx)` BEFORE invoking repo so transaction boundaries align with lock lifetime. **2026-05-19 (Phase 3 Cluster 3B.3)**: REAL impl landed — all 5 methods (findByBroadcast / findPendingByBroadcast / bulkInsert / updateStatus / markCancelled) run inside `runInTenant(ctx, tx => …)` with RLS+FORCE confinement. Unique-violation mapper distinguishes `duplicate_idempotency_key` vs `duplicate_batch_index`. State machine guard inside `updateStatus` mirrors the migration-0163 DB CHECK (pending→sending|cancelled / sending→sent|failed / failed→pending for retry / terminal sent + cancelled). `acquirePerBatchDispatchLock(tx, slug, broadcastId, batchIndex)` exported as standalone helper for the use case T045 advisory-lock acquire boundary. Sibling adapter `drizzle-broadcasts-retry-repo.ts` implements the new `BroadcastsRetryRepo` narrow port (findById / incrementManualRetryCount / acceptPartial) on the same RLS pattern.

### Public barrel + audit event taxonomy

- [X] T030 Extend `src/modules/broadcasts/index.ts` barrel: export new public **TYPES ONLY** per Constitution Principle III — `BatchManifest`, `BatchManifestsPort`, `BatchStatus`, `BatchInsertError`, `BatchUpdateError`, `BatchStatusUpdate`, `NewBatchManifestInput` (US1) + `VirusScannerPort`, `VirusScanVerdict`, `AllowlistEntry`, `AllowlistAddError`, `AllowlistRemoveError`, `Hostname`, `ImageAllowlistPort` (US2) + `BroadcastTemplate`, `BroadcastTemplatesPort`, `CreateTemplateInput`, `ListTemplatesOpts`, `TemplateCreateError`, `TemplateDeleteError`, `TemplateLocale`, `TemplateUpdateError`, `UpdateTemplateInput` (US7). Infrastructure adapter factories NOT exported — composition root wires them inline in Phase 3-5 via `broadcasts-deps.ts`.
- [X] T031 Extend `src/modules/broadcasts/application/ports/audit-port.ts` (NOT `application/audit-event-taxonomy.ts` — wrong path in original task text; actual location verified) with 10 new event-type string literals per data-model § 7. Bumped TypeScript static assertion `extends 43` → `extends 53` to catch future drift. Updated header doc-comment count "= 43 total" → "= 53 total" + added "F7.1a Phase 2 T031 (US1+US2+US7): 10 events" line. All 10 events default to 5y retention via existing `Object.fromEntries(F7_AUDIT_EVENT_TYPES.map(...))` retention map — no separate retention grant needed.

**Checkpoint**: Foundation ready — user story implementation can now begin in parallel by different developers if needed.

---

## Phase 3: User Story 1 — Pagination >5,000 recipients (Priority: P1) 🎯 MVP-blocker for future tenants

**Goal**: Lift broadcast ceiling 5k → 50k via parallel batch dispatch (concurrency cap 4); non-terminal `partially_sent` state with 3-retry admin loop; per-batch + per-broadcast advisory locks.

**Independent Test**: Seed test tenant with 7,500 members; compose `all_members` broadcast; admin approve + dispatch; verify (a) 1 batch of 7,500 (single audience), (b) 7,500 unique recipient emails delivered, (c) one consolidated roll-up, (d) cancel-mid-flight halts pending batches, (e) concurrent admin retry serialized via advisory lock.

### Tests for User Story 1 (TDD RED-first) ⚠️

> **NOTE**: Write tests FIRST, commit RED, then implement → GREEN.

- [X] T032 [P] [US1] Contract test `tests/contract/broadcasts/batch-dispatch.test.ts` — RED 2026-05-19. 5 cases: 5k→1 batch · 25k→3 batches (10k/10k/5k) · 50k→5 batches · idempotency-key collision rejection · exactly-one `broadcast_dispatched_in_batches` audit emit. Uses dynamic-import wrapper `new Function('m','return import(m)')` (memory `project_f5_red_import_pattern`) to bypass typecheck on not-yet-existent use case `split-broadcast-into-batches.ts`. GREEN at Phase 3B T044.
- [X] T033 [P] [US1] Contract test `tests/contract/broadcasts/retry-failed-batches.test.ts` — RED 2026-05-19. 5 cases: partially_sent + budget=0 → succeeds + emits initiated + completed audits · partially_sent + budget=2 → 3rd retry post-increments to 3 · partially_sent + budget=3 → MANUAL_RETRY_BUDGET_EXHAUSTED + budget NOT consumed on rejection · from sent → INVALID_STATE_TRANSITION · from draft → INVALID_STATE_TRANSITION. GREEN at Phase 3B T047.
- [X] T034 [P] [US1] Contract test `tests/contract/broadcasts/accept-partial-delivery.test.ts` — RED 2026-05-19. 5 cases: partially_sent → succeeds + audit + state transition · optional reason · reason >500 chars → input validation rejection · from sent → INVALID_STATE_TRANSITION · from draft → INVALID_STATE_TRANSITION. GREEN at Phase 3B T048.
- [X] T035 [P] [US1] Contract test `tests/contract/broadcasts/concurrent-retry-race.test.ts` (SC-007) — RED 2026-05-19. 3 cases: 2 simultaneous `Promise.all([retryA, retryB])` → exactly 1 succeeds + 1 returns ALREADY_RETRYING_IN_PROGRESS without budget consumption (audit emits 1 not 2) · advisory-lock key uses `broadcasts-retry:` namespace (disjoint from `broadcasts-batch:` + `broadcasts:`) · lock denial → no state mutation + no audit. Uses lock-simulator port. GREEN at Phase 3B T047.
- [X] T036 [P] [US1] Integration test `tests/integration/broadcasts/pagination-cross-tenant-probe.test.ts` (Principle I Review-Gate blocker) — RED 2026-05-19. 6 DB-layer RLS probes against `broadcast_batch_manifests` (SELECT both directions · UPDATE → 0 rows · DELETE → 0 rows · INSERT with cross-tenant id → throws WITH CHECK violation) — DB-layer probes can run GREEN today since migration 0166 applied RLS+FORCE; audit-emit assertion skipped pending Phase 3B `enforce-tenant-context.ts` extension. **Phase 2 gap discovered**: `broadcasts.status` enum lacks `partially_sent` + `partial_delivery_accepted` values (FR-008a/b); migration 0162 added columns but not enum extension. Test fixture uses `sending` (F7 MVP value) as placeholder. Real enum extension lands Phase 3B.
- [X] T037 [P] [US1] Integration test `tests/integration/broadcasts/pagination-7500-end-to-end.test.ts` (CI smoke per critique E11 round 2) — RED 2026-05-19. 3 skip()-marked cases for Phase 3B/3C closure (1 batch / 7500 delivered / no duplicates). Full impl lands when use cases + cron + webhook ext exist. Uses dynamic-import wrapper for non-existent use cases.
- [X] T038 [US1] Integration test `tests/integration/broadcasts/pagination-50k-end-to-end.test.ts` (SC-002 perf bench, env-gated `RUN_PERF_BENCH=true`) — RED 2026-05-19. Test body comments document the operator workflow + 60-min vitest test timeout (budget 45 min + headroom). Phase 6 T138 ship-day operator gate.
- [X] T039 [P] [US1] Unit test `tests/unit/broadcasts/batch-boundary.test.ts` — RED 2026-05-19. 11 cases: empty input, 5k/10k/10001/25k/50k boundaries, contiguous-range invariant. **4 fast-check property-based tests**: sum-of-batch-sizes invariant · no-duplicate-recipients-across-batches (`fc.uniqueArray(fc.uuid())`) · batchIndex 0-based sequential · all-but-last exactly cap-sized. 100 numRuns each. GREEN at Phase 3B T041.
- [X] T040 [P] [US1] E2E test `tests/e2e/broadcasts/pagination-batch-breakdown.spec.ts` (Playwright + axe-core + reduced-motion) — RED 2026-05-19. 4 `expect(false).toBe(true)` skip-equivalent tests with full assertion documentation in comments. `--workers=1` mandatory per memory `feedback_e2e_workers`. GREEN at Phase 3C T049 + Phase 3D T052-T054.

### Implementation for User Story 1

#### Domain layer (pure — no framework imports)

- [X] T041 [P] [US1] Create `src/modules/broadcasts/domain/value-objects/batch-boundary.ts`: pure function `splitIntoBatches(recipientList: Email[], perBatchCap: 10000): BatchManifest[]` + invariants (no duplicate recipients across batches; last batch ≤ cap) — closed 2026-05-19 commit `490bbb5e` (Phase 3 Cluster 3B.1). `RESEND_PER_AUDIENCE_CAP` constant + `computeBatchRanges` count-only variant added; turns T039 unit test GREEN (11/11 with fast-check property-tests).
- [X] T042 [P] [US1] Create `src/modules/broadcasts/domain/policies/batch-concurrency-policy.ts`: policy `validateConcurrencyCap(cap: number): Result<void, ConcurrencyError>` (CHECK 1≤cap≤8 per Clarifications Q1) — closed 2026-05-19 commit `490bbb5e`. MIN/MAX/DEFAULT constants exported.
- [X] T043 [US1] Extend `src/modules/broadcasts/domain/broadcast.ts` aggregate with `splitIntoBatches(perBatchCap)`, `recordPartialSend(failedBatchIds)`, `transitionToRetrying(actor)`, `acceptPartialDelivery(actor, reason?)` methods + `BroadcastStateError` on invalid transitions — closed 2026-05-19 commit `490bbb5e`. 3 standalone state-transition functions (matches F7 MVP flat-aggregate pattern) + 5 new F71A fields (manualRetryCount + 4 nullables) + 2 new BroadcastPhase variants. Also: enum migration 0169 + status-transitions + invariants + status-badge-mapping + Drizzle row mapper.

#### Application layer (orchestration)

- [X] T044 [US1] Create `src/modules/broadcasts/application/use-cases/split-broadcast-into-batches.ts` orchestrating Domain `splitIntoBatches` + persisting batch_manifest rows via `BatchManifestsPort`; emits `broadcast_dispatched_in_batches` audit event — closed 2026-05-19 commit `016d3fbe` (Phase 3 Cluster 3B.2). Idempotency-key collision → BATCH_ALREADY_DISPATCHED. Turns T032 contract test GREEN (5/5).
- [X] T045 [US1] Create `src/modules/broadcasts/application/use-cases/dispatch-broadcast-batch.ts` per contracts/batch-dispatch.md § 1.2: acquires `pg_advisory_xact_lock('broadcasts-batch:'+tenantId+':'+broadcastId+':'+batchIndex)`, calls Resend Broadcasts API with idempotency key `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}`, updates batch_manifest status; ALL writes via `runInTenant()` — closed 2026-05-19 commit `<3C.2>`. Single-batch dispatcher mirrors F7 MVP `dispatch-scheduled-broadcast.ts` gateway sequence (createAudience → addContactsToAudience → createBroadcast → sendBroadcast). Per-batch audience name `broadcast-{tenant}-{broadcast}-batch-{idx}`. Status transitions: pending → sending (BEFORE gateway calls) → sending (persist providerAudienceId on success) OR sending → failed with failureReason on gateway error. Emits `broadcast_send_started` audit per-batch with batchIndex in payload; on gateway error emits `broadcast_failed_to_dispatch` with `gatewayStage`. Advisory-lock currently wired to `noOpAdvisoryLock` stub (Phase 3 Cluster 3D will harden via withTx refactor — see `noop-advisory-lock.ts` header).
- [X] T046 [US1] Create `src/modules/broadcasts/application/services/batch-dispatcher.ts` semaphore-based service orchestrating concurrent batch dispatch with cap from `tenant_broadcast_settings.dispatch_concurrency_cap` (default 4, range 1-8); queues batches beyond cap — closed 2026-05-19 commit `<3C.2>`. Promise-pool impl (zero external deps): N worker fns each pull from a shared queue + call `dispatchBroadcastBatch` until drained. Cap clamped to [1, 8] (defence-in-depth on top of Domain `validateConcurrencyCap`). Per-batch failure does NOT abort the pool (one failed batch still leaves the others running). Returns `{totalBatches, succeeded, failed, results[], elapsedMs}` summary sorted by batchIndex.
- [X] T047 [US1] Create `src/modules/broadcasts/application/use-cases/retry-failed-batches.ts` per contracts § 1.3: acquires `pg_advisory_xact_lock('broadcasts-retry:'+tenantId+':'+broadcastId)` (per critique E4), increments manual_retry_count atomically (CHECK ≤3), re-dispatches ONLY failed batches with original recipient sets, emits `broadcast_retry_initiated` + `broadcast_retry_completed` audit events — closed 2026-05-19 commit `016d3fbe`. Turns T033 contract test GREEN (5/5) + T035 concurrent-race contract test GREEN (3/3, SC-007).
- [X] T048 [US1] Create `src/modules/broadcasts/application/use-cases/accept-partial-delivery.ts` per contracts § 1.4: transitions broadcast state `partially_sent → partial_delivery_accepted`, sets partial_delivery_accepted_at/by, emits `broadcast_partial_delivery_accepted` audit event — closed 2026-05-19 commit `016d3fbe`. No advisory lock (DB `WHERE status='partially_sent'` row-lock serialises). Turns T034 contract test GREEN (5/5).

#### Presentation layer (Next.js routes + components)

- [X] T049 [US1] Extend `src/app/(staff)/admin/broadcasts/[id]/page.tsx` — admin broadcast detail page gains per-batch breakdown section (collapsible `<details>/<summary>`) below consolidated roll-up; reads from `BatchManifestsPort.findByBroadcast()` — closed 2026-05-19 commit `<3D.3>`. Server Component → Client Component prop pipe maps Drizzle `BatchManifest` to plain JSON-serialisable `BatchBreakdownRow[]` (avoids branded type serialisation across boundary). `loadBatchBreakdownRows(slug, broadcastId)` helper at end of file fail-opens to `[]` on storage error (Component renders the "not split" fallback; on-call sees elevated `admin.broadcasts.detail.batch_load_failed` log rate). `manualRetryRemaining = max(0, MANUAL_RETRY_BUDGET - broadcast.manualRetryCount)` computed server-side + passed to client component. `defaultOpen=true` on `partially_sent` / `partial_delivery_accepted` states (admin needs immediate visibility into batch state); other states default closed (perf — avoid rendering 50-row tables on 50k-recipient broadcasts on the critical detail-page paint). Rendered between AuditTimeline and ReviewActions sections.
- [X] T050 [US1] Create `src/app/api/admin/broadcasts/[id]/retry/route.ts` POST handler per contracts § 1.3 (admin role check via F1 RBAC; tenant ctx via middleware; returns `Result<{retryAttempt, retriedBatchCount}, BroadcastError>`) — closed 2026-05-19 commit `<3C.1>`. Wires `retryFailedBatches` use case (3B.2). Error taxonomy → HTTP: BROADCAST_NOT_FOUND 404 / INVALID_STATE_TRANSITION 409 / MANUAL_RETRY_BUDGET_EXHAUSTED 409 / ALREADY_RETRYING_IN_PROGRESS 409. F71A error-code messages added to `F7_ERROR_MESSAGES` (EN+TH) + `F7_ERROR_STATUS` map + `tests/unit/lib/broadcasts-route-helpers.test.ts` EXPECTED record (34/34 GREEN). SC-007 advisory-lock currently wired to `noOpAdvisoryLock` stub — see `infrastructure/noop-advisory-lock.ts` header for Phase 3 Cluster 3D hardening plan.
- [X] T051 [US1] Create `src/app/api/admin/broadcasts/[id]/accept-partial/route.ts` POST handler per contracts § 1.4 — closed 2026-05-19 commit `<3C.1>`. Wires `acceptPartialDelivery` use case (3B.2). Body `{reason?: string ≤500}` (optional empty body accepted). Error taxonomy → HTTP: BROADCAST_NOT_FOUND 404 / INVALID_STATE_TRANSITION 409 / invalid_input.reason_too_long 400 (via `broadcast_partial_delivery_reason_too_long`). No advisory lock (DB row-lock serialises concurrent admin clicks).
- [X] T052 [P] [US1] Create `src/components/broadcasts/admin-batch-breakdown.tsx` (per critique X3/E8 + UX): `<details>` collapsible with per-batch table (batch_index, recipient_range, status badge, dispatched_at, per-batch delivered/bounced/complained/unsubscribed); aria-live="polite" for status changes — closed 2026-05-19 commit `<3D.2>`. Path `src/components/broadcast/admin/batch-breakdown.tsx` (singular `broadcast` namespace to match existing F7 MVP layout). Native `<details>/<summary>` collapsible (no JS state — keyboard + SR free). aria-live="polite" summary line ("{succeeded} sent · {failed} failed · {pending} pending of {total}"). 10-column data table (batchIndex / range / recipientCount / status / dispatchedAt / 4 counters / retryCount). Per-batch status badge variants mapped (sent→default, failed→destructive, pending/cancelled→outline, sending→secondary). Manual-retry budget hint banner (amber when remaining > 0, destructive when exhausted). Conditional action buttons: Retry button (visible when `broadcastStatus='partially_sent' AND manualRetryRemaining > 0 AND failedBatchCount > 0`) → opens T053; Accept-partial button (visible when `broadcastStatus='partially_sent'`) → opens T054. `batchStatusLabel(status, t)` switch-helper per i18n.md CHK053 (no dynamic `t(\`key.${var}\`)`).
- [X] T053 [P] [US1] Create `src/components/broadcasts/admin-retry-confirmation.tsx`: shadcn AlertDialog confirming retry with budget remaining display; focus-trap + reduced-motion — closed 2026-05-19 commit `<3D.2>`. Path `src/components/broadcast/admin/retry-confirmation-dialog.tsx`. shadcn `AlertDialog` (built-in focus-trap + ESC handling). Budget-remaining line "{remaining} of 3 manual retries remaining". Warning copy about Resend quota + duplicate-email risk. Submit button shows i18n `submitting` label + disabled during `useTransition` pending state (SC-007 double-click guard at UI level — DB-layer guard pending Phase 3D AdvisoryLock withTx refactor). On success: parses `{retryAttempt, retriedBatchCount}` from response, shows toast `retrySuccess` with attempt + count, closes dialog, router.refresh(). Error code mapping: budget_exhausted → toast retryBudgetExhausted; already_retrying → retryAlreadyInProgress; invalid_state → retryInvalidState; default → retryServerError. Reduced-motion safe (no custom animations).
- [X] T054 [P] [US1] Create `src/components/broadcasts/admin-accept-partial-modal.tsx`: shadcn AlertDialog with reason text-area (max 500 chars) — closed 2026-05-19 commit `<3D.2>`. Path `src/components/broadcast/admin/accept-partial-dialog.tsx`. Same shadcn AlertDialog primitive as T053 + reject-dialog. Optional reason textarea (rows=4, max 500); double-RAF auto-focus on open (matches reject-dialog pattern). Live counter aria-live="polite" "{count} / 500"; aria-invalid when >500. Summary line "{sent} of {total} batches delivered successfully". Destructive-styled confirm button (terminal action — matches reject-dialog convention). Body only POSTs `reason` when trimmed ≥1 char; empty → omits field per route schema (reason is `optional()`). Error mapping: invalid_state → toast acceptPartialInvalidState; reason_too_long → acceptPartialReasonTooLong; default → acceptPartialServerError.

#### Cron + Operational

- [X] T055 [US1] Create `src/app/api/cron/broadcasts/dispatch-batches/route.ts` POST handler (Bearer auth via `CRON_SECRET`): scans for `batch_manifests.status='pending'` rows older than 5 min; invokes `BatchDispatcher.dispatchPending()` respecting concurrency cap; runs every 5 min via cron-job.org — closed 2026-05-19 commit `<3C.2>`. Bearer auth via `verifyCronBearer(req.headers.authorization, env.cron.secret)` (constant-time, matches F4 outbox + F5 sweep pattern). Kill-switch: `env.features.f7Broadcasts` (F7 master flag — F71A ships dark when F7 is off). Sweep window: 30s grace from batch `created_at` (avoid races with splitter's audit-emit tx). Per-tick: distinct-broadcast scan (limit 20) → for each broadcast: load aggregate + resolve recipients via `resolveSegmentRecipients` + read pending batches + invoke `dispatchAllPendingBatches` service with DEFAULT_CONCURRENCY_CAP=4 (Phase 3D will read per-tenant cap from `tenant_broadcast_settings`). Summary returns `{processed, broadcastsDispatched, batchesDispatched, batchesFailed, skipped, errors}`. Cron-job.org coordinator setup deferred to ship-day operator gate.
- [X] T056 [US1] Extend existing `src/modules/broadcasts/application/use-cases/reconcile-stuck-sending.ts` (F7 MVP) to handle per-batch granularity per FR-005: retry only failed batches up to per-batch automatic retry budget (5) — closed 2026-05-19 commit `<3C.3>`. Chose **sibling-use-case** pattern instead of modifying F7 MVP file (less invasive — leaves F7 MVP test fixtures untouched). New use case `auto-retry-failed-batches.ts` exports `autoRetryFailedBatch(deps, {batch})` per-batch + `sweepAutoRetryFailedBatches(deps, {tenantId, limit})` sweep. `AUTO_RETRY_BUDGET=5` + `AUTO_RETRY_COOLOFF_SECONDS=900` (15-min cool-off to avoid storming Resend after a transient outage). New port method `BatchManifestsPort.findFailedRetryEligible(slug, {retryBudget, cooloffSeconds, limit})` scans cross-broadcast `status='failed' AND retry_count < budget AND failed_at < now() - cooloff` ordered `failed_at ASC` (fair queue). Drizzle impl uses raw SQL inside `runInTenant`. Reconcile-stuck-sending cron route extended to call `sweepAutoRetryFailedBatches` AFTER the broadcast-level reconciliation loop; per-batch failures don't abort the sweep; response body includes `batch_auto_retry: {eligible, retried, errored}` for cron-job.org dashboard. Audit event reuses `broadcast_retry_initiated` with `actorUserId='system'` + `automated: true` payload distinguisher (vs T047 manual retry with admin actor).
- [X] T057 [US1] Extend `src/app/api/webhooks/resend/route.ts` (F7 MVP webhook handler) to update `batch_manifests` per-batch delivered/bounced/complained/unsubscribed counts (NOT just broadcast-level totals) using `batch_index` from Resend event payload — closed 2026-05-19 commit `<3C.4>`. Routes the per-batch path via `provider_broadcast_id` column on `broadcast_batch_manifests` (added in migration 0170 — `batch_index` from event payload was rejected as fragile; Resend events don't include audience name reliably). Webhook flow: F7 MVP `resolveTenantByResendBroadcastId` first → on miss, `resolveTenantByBatchProviderBroadcastId` fallback → if hit, route to new use case `applyBatchWebhookEvent` (T057) which increments one counter (delivered/bounced/complained/unsubscribed) atomically + emits `broadcast_delivery_recorded` audit with batchIndex + recipientEmailHashed + resendEventId payload. F7 MVP single-audience tests still GREEN (174/174 contract). Status auto-transition (sending → sent on terminal counter sum) deferred to 3D advisory-lock-hardening cycle. **Note**: task description originally said "use `batch_index` from event payload" but actual impl uses `provider_broadcast_id` lookup — more reliable + reuses F7 MVP pattern.

#### i18n

- [X] T058 [P] [US1] Add ~60 i18n keys to `src/i18n/messages/en.json` for admin batch breakdown UI + retry confirmation + accept-partial modal + 4 US1 audit-event display strings — closed 2026-05-19 commit `<3D.1>`. 70 keys added covering: 2 status labels (partially_sent / partial_delivery_accepted) merged into existing status blocks (admin.broadcasts.queue.status + portal.broadcasts.history.status); 4 new top-level admin.broadcasts sections: `batches` (per-batch breakdown UI — 22 keys incl. columns + batchStatus map + retry budget hints + summary + empty/notSplit fallbacks), `retryDialog` (T053 confirmation — 10 keys), `acceptPartialDialog` (T054 modal — 12 keys incl. reasonCounter + 500-char help), `toast` (success/error feedback — 9 keys mapping retry + acceptPartial flows). Formal tone consistent with F7 MVP catalogue.
- [X] T059 [P] [US1] Add ~60 i18n keys to `src/i18n/messages/th.json` (TH translation — chamber-business register; verify with `pnpm check:i18n`) — closed 2026-05-19 commit `<3D.1>`. 70-key TH translation mirroring EN. Chamber-business register: "E-Blast" preserved as compound; "ลองส่งซ้ำ" / "ยอมรับการส่งบางส่วน" for retry/accept actions; "กลุ่ม" for batch; "ผู้ดูแล" for admin; formal register (no ครับ/ค่ะ in copy per F7 MVP convention). pnpm check:i18n PASS.
- [X] T060 [P] [US1] Add ~60 i18n keys to `src/i18n/messages/sv.json` (SV translation — formal but warm register; verify with `pnpm check:i18n`) — closed 2026-05-19 commit `<3D.1>`. 70-key SV translation mirroring EN. "Utskick" / "Batch" / "audience" terminology; "Försök igen med misslyckade batcher" for retry; "Godkänn partiell leverans" for accept-partial; "Du har {remaining} av 3 manuella försök kvar" formal-but-direct register matching F7 MVP catalogue. pnpm check:i18n PASS — 2987 keys × 3 locales.

#### Feature flag wiring

- [ ] T061 [US1] Gate all US1 use-cases + UI routes + cron route behind `FEATURE_F71A_US1_PAGINATION=true` AND master `FEATURE_F71A_BROADCAST_ADVANCED=true`; when OFF: dispatch falls back to F7 MVP 5k cap path; broadcast detail page hides per-batch breakdown collapsible

**Checkpoint**: User Story 1 fully functional independently — verified by T037 + T040 passing end-to-end on dev environment.

---

## Phase 4: User Story 2 — Image embedding with allowlist (Priority: P1)

**Goal**: Re-enable `<img>` in body sanitiser when `src` host is on tenant's allowlist; inline image upload to chamber asset bucket with ClamAV scan + 5 MB cap; default allowlist seeded per tenant (chamber asset domain + Resend CDN).

**Independent Test**: Add `example.com` to tenant allowlist; compose draft with `<img src="https://example.com/banner.png">` → submit succeeds; try `<img src="https://attacker.com/track.gif">` → rejected with `broadcast_body_image_source_unsafe`; upload 6 MB image → rejected with `broadcast_image_too_large`; ClamAV scan flagged file → rejected with `broadcast_image_unsafe`.

### Tests for User Story 2 (TDD RED-first) ⚠️

- [ ] T062 [P] [US2] Contract test `tests/contract/broadcasts/image-source-allowlist.test.ts` per contracts/image-upload.md § 1.2: submit body with allowlisted+non-allowlisted srcs → returns `{ unsafeImageSources: string[] }`; audit emits `broadcast_body_image_source_unsafe`
- [ ] T063 [P] [US2] Contract test `tests/contract/broadcasts/upload-inline-image.test.ts` per contracts § 1.1: 4 MB PNG succeeds, 6 MB JPG rejected `broadcast_image_too_large`, ClamAV flagged → `broadcast_image_unsafe`, duplicate content-hash dedup
- [ ] T064 [P] [US2] Contract test `tests/contract/broadcasts/manage-image-allowlist.test.ts` per contracts § 1.3: add hostname succeeds, remove default rejected (`CANNOT_REMOVE_DEFAULT_ALLOWLIST_ENTRY`), wildcard `*.example.com` rejected by zod regex, cross-tenant probe
- [ ] T065 [P] [US2] Integration test `tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts` (Principle I): tenant B cannot see/modify tenant A's allowlist
- [ ] T066 [P] [US2] Integration test `tests/integration/broadcasts/image-virus-scan-flow.test.ts` against live ClamAV (Docker in dev): EICAR test signature → verdict `infected` + audit event; clean PNG → verdict `clean`; scan latency p95 ≤500ms for files ≤2MB (SC-005)
- [ ] T067 [P] [US2] Unit test `tests/unit/broadcasts/image-source-allowlist.test.ts`: pure function tests for hostname matching, RFC-1035 validation, scheme rejection (data:, javascript:)
- [ ] T068 [P] [US2] E2E test `tests/e2e/broadcasts/image-upload-allowlist.spec.ts` (Playwright + axe-core): admin allowlist editor adds hostname → member compose inline-image upload → image renders in dispatched email; assert WCAG 2.1 AA

### Implementation for User Story 2

#### Domain layer

- [ ] T069 [P] [US2] Create `src/modules/broadcasts/domain/value-objects/image-source-allowlist.ts`: pure function `validateHostname(host: string, allowlist: Hostname[]): Result<void, AllowlistError>` (exact hostname match; RFC 1035 format CHECK; no wildcards); + `extractImgSources(bodyHtml: string): Array<{ src: string, alt?: string }>` parse function

#### Application layer

- [ ] T070 [US2] Create `src/modules/broadcasts/application/use-cases/validate-image-source-allowlist.ts` per contracts § 1.2: invoked inside existing `sanitiseBroadcastBody` (F7 MVP) AFTER Tiptap parse + BEFORE persistence; returns first-error with ALL unsafe srcs accumulated; emits `broadcast_body_image_source_unsafe` audit
- [ ] T071 [US2] Create `src/modules/broadcasts/application/use-cases/upload-inline-image.ts` per contracts § 1.1: validate size ≤5MB (FR-012) → `VirusScannerPort.scan()` (FR-013) → content-hash dedup → upload to Vercel Blob in tenant-scoped path → return `{blobUrl, allowlistedHostname, contentHash}`; sanitises filename at boundary per critique E6
- [ ] T072 [US2] Create `src/modules/broadcasts/application/use-cases/manage-image-allowlist.ts` per contracts § 1.3: add/remove via `ImageAllowlistPort`; emits `broadcast_image_allowlist_updated` audit with before/after value

#### Infrastructure layer

- [ ] T073 [P] [US2] Create `src/modules/broadcasts/infrastructure/tiptap-image-extension-config.ts`: configures `@tiptap/extension-image@^3.22` with `inline: false`, `allowBase64: false`; wires into F7 MVP Tiptap editor config
- [ ] T074 [P] [US2] Create `src/modules/broadcasts/infrastructure/vercel-blob-image-storage.ts`: adapts existing F4 Vercel Blob client; tenant-scoped path `images/{tenantId}/{contentHash}.{ext}`; content-hash dedup at upload boundary

#### Presentation layer

- [ ] T075 [US2] Create `src/app/(staff)/admin/broadcasts/settings/page.tsx` — admin settings page with "Image source allowlist" section (table of hostnames with add/remove; defaults shown as locked rows with disabled Remove button)
- [ ] T076 [US2] Create `src/app/api/admin/broadcasts/settings/allowlist/route.ts` POST handler per contracts § 1.3: admin role check; tenant ctx; calls `manageImageAllowlist` use-case
- [ ] T077 [US2] Create `src/app/api/member/broadcasts/inline-image-upload/route.ts` POST handler (multipart) per contracts § 1.1: member role + tenant ctx + draft ownership check; calls `uploadInlineImage` use-case
- [ ] T078 [US2] Extend `src/app/(member)/portal/broadcasts/new/page.tsx` (F7 MVP compose) — wire `tiptap-image-extension-config.ts`; add "Upload image" toolbar button; surface progress + size-cap errors inline
- [ ] T079 [P] [US2] Create `src/components/broadcasts/admin-image-allowlist-editor.tsx`: semantic `<table>` with add-hostname form (zod-validated regex), per-row remove button (disabled for `is_default=true`); aria-live="polite"
- [ ] T080 [P] [US2] Create `src/components/broadcasts/compose-inline-image-uploader.tsx`: file picker triggers `uploadInlineImage` use-case via fetch; renders `<progress aria-label="...">`; on success replaces `<img>` placeholder; on error shows locale-aware banner
- [ ] T081 [P] [US2] Create `src/components/broadcasts/clamav-unreachable-banner.tsx` (per critique P10): inline banner on compose page when ClamAV daemon unreachable (`scan_status='error'` repeatedly); auto-retries scan when daemon returns

#### i18n

- [ ] T082 [P] [US2] Add ~50 i18n keys to `src/i18n/messages/en.json` for allowlist editor + image upload + ClamAV unreachable banner + 3 US2 audit-event display strings
- [ ] T083 [P] [US2] Add ~50 i18n keys to `src/i18n/messages/th.json`
- [ ] T084 [P] [US2] Add ~50 i18n keys to `src/i18n/messages/sv.json`

#### Feature flag wiring

- [ ] T085 [US2] Gate all US2 routes + Tiptap image extension + ClamAV scanner invocations behind `FEATURE_F71A_US2_IMAGES=true` AND master flag; when OFF: Tiptap extension config falls back to F7 MVP no-`<img>` allowlist; admin route 404; member compose hides Upload Image button

**Checkpoint**: User Story 2 fully functional — verified by T066 + T068 passing against live Docker ClamAV.

---

## Phase 5: User Story 7 — Multi-template library (Priority: P2)

**Goal**: Admin authors templates (CRUD) with snapshot semantics (template edit doesn't mutate in-flight drafts); 5 starter templates × 3 locales seeded per tenant; member compose dropdown picker with cascading locale filter + Starter badge; `{{chamber_name}}` server-substituted (HTML-escaped); `[bracketed]` placeholders member-editable.

**Independent Test**: New tenant → admin opens template library → sees 15 seeded rows (5 names × 3 locales) with Starter badges; admin edits "Monthly Newsletter" → member picks template → draft populates with edited content; admin re-edits template → in-flight draft NOT modified (snapshot); admin deletes starter → confirmation banner; XSS test: tenant.display_name=`<script>` → rendered as `&lt;script&gt;` in draft body.

### Tests for User Story 7 (TDD RED-first) ⚠️

- [ ] T086 [P] [US7] Contract test `tests/contract/broadcasts/create-broadcast-template.test.ts` per contracts/broadcast-template.md § 1.1: admin creates template → persisted, audited; member role rejected (RBAC)
- [ ] T087 [P] [US7] Contract test `tests/contract/broadcasts/update-broadcast-template.test.ts` per contracts § 1.2: edit existing template → audit before/after
- [ ] T088 [P] [US7] Contract test `tests/contract/broadcasts/delete-broadcast-template.test.ts` per contracts § 1.3: soft-delete; audit row captures started_from_count snapshot per FR-023
- [ ] T089 [P] [US7] Contract test `tests/contract/broadcasts/snapshot-template-to-draft.test.ts` (SC-007a): snapshot copies subject+body verbatim into draft; subsequent template edits don't mutate draft
- [ ] T090 [P] [US7] Contract test `tests/contract/broadcasts/template-variable-substitution.test.ts` per contracts § 5.4 (NEW per critique E9): only `{{chamber_name}}` substituted at snapshot; `[bracketed]` text preserved literal; XSS escape verification (tenant.display_name with `<script>` → escaped)
- [ ] T091 [P] [US7] Contract test `tests/contract/broadcasts/template-save-image-allowlist.test.ts` per critique E9: template body with non-allowlisted `<img src>` rejected at SAVE time (FR-017)
- [ ] T092 [P] [US7] Contract test `tests/contract/broadcasts/template-render-html-escape.test.ts` per critique E6+E9: `{{chamber_name}}` value HTML-escaped before substitution (XSS prevention)
- [ ] T093 [P] [US7] Integration test `tests/integration/broadcasts/template-cross-tenant-probe.test.ts` (Principle I): tenant B cannot read/modify tenant A's templates
- [ ] T094 [P] [US7] Integration test `tests/integration/broadcasts/template-snapshot-decoupling.test.ts` (SC-007a): create template → start draft → edit template → reload draft → draft body matches PRE-edit template content
- [ ] T095 [P] [US7] Integration test `tests/integration/broadcasts/starter-template-seed.test.ts` (SC-007b per critique P10): run migration 0168 (renumbered from 0134 Phase 2) → assert `SELECT COUNT(*) FROM broadcast_templates WHERE tenant_id=$1 AND is_seeded=TRUE` returns exactly 15 per tenant; re-run → no duplicates + `broadcast_template_seed_skipped_existing_name` audit emitted
- [ ] T096 [P] [US7] E2E test `tests/e2e/broadcasts/template-library-flow.spec.ts` (Playwright + axe-core): admin CRUD + member picker + snapshot decoupling + Starter badge + stale-draft banner

### Implementation for User Story 7

#### Domain layer

- [ ] T097 [P] [US7] Create `src/modules/broadcasts/domain/value-objects/template-snapshot.ts`: pure function `substituteChamberName(body: string, chamberName: string): string` (HTML-escapes chamberName via existing F7 MVP `escapeHtml` helper; substitutes `{{chamber_name}}` ONLY; leaves all other `{{var}}` and `[bracketed]` literal)
- [ ] T098 [US7] Extend `src/modules/broadcasts/domain/broadcast.ts` aggregate with `startedFromTemplate(templateId, templateNameSnapshot)` method that records both FK + denormalised name (per critique P9)

#### Application layer

- [ ] T099 [US7] Create `src/modules/broadcasts/application/use-cases/create-broadcast-template.ts` per contracts § 1.1: validates name uniqueness (tenant-scoped), runs body through F7 MVP sanitiser + US2 image-source allowlist validation (FR-017), persists, audits `broadcast_template_created`
- [ ] T100 [US7] Create `src/modules/broadcasts/application/use-cases/update-broadcast-template.ts` per contracts § 1.2
- [ ] T101 [US7] Create `src/modules/broadcasts/application/use-cases/delete-broadcast-template.ts` per contracts § 1.3: soft-delete; audit captures `started_from_count`
- [ ] T102 [US7] Create `src/modules/broadcasts/application/use-cases/snapshot-template-to-draft.ts` per contracts § 1.4: loads template (RLS-scoped) → calls `substituteChamberName(body, tenant.display_name)` → updates draft subject+body+template_name_snapshot+started_from_template_id → increments template.started_from_count
- [ ] T103 [US7] Create `src/modules/broadcasts/application/use-cases/list-broadcast-templates.ts` per contracts § 1.5: returns templates filtered by `locale=current_user_locale || tenant_default_locale || 'en'` (cascading per critique P3 + Clarifications round 3 Q3); MRU ordering per FR-018

#### Presentation layer

- [ ] T104 [US7] Create `src/app/(staff)/admin/broadcasts/templates/page.tsx` (admin template library list per critique P6): renders templates with Starter badge for `is_seeded=TRUE` + filter pills (Starter only / Admin-authored / All); table with name, subject preview, started-from count, last modified; edit/delete row actions
- [ ] T105 [US7] Create `src/app/(staff)/admin/broadcasts/templates/new/page.tsx` (admin authoring): Tiptap editor (same instance as member compose) + form fields name + subject + locale picker
- [ ] T106 [US7] Create `src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx` (admin editing): same editor; for `is_seeded=TRUE` shows confirmation banner per critique P6 + FR-021
- [ ] T107 [US7] Create `src/app/api/admin/broadcasts/templates/route.ts` POST handler (admin role) per contracts § 1.1
- [ ] T108 [US7] Create `src/app/api/admin/broadcasts/templates/[id]/route.ts` PATCH + DELETE handlers per contracts § 1.2 + 1.3
- [ ] T109 [US7] Create `src/app/api/member/broadcasts/draft/[id]/snapshot-template/route.ts` POST handler (member role + draft ownership) per contracts § 1.4
- [ ] T110 [US7] Create `src/app/api/broadcasts/templates/route.ts` GET handler (member OR admin role) per contracts § 1.5 — list with locale filter
- [ ] T111 [US7] Extend `src/app/(member)/portal/broadcasts/new/page.tsx` (F7 MVP compose) — add template picker as first compose action; auto-select template if URL has `?template={id}` query
- [ ] T112 [P] [US7] Create `src/components/broadcasts/admin-template-library.tsx`: list with Starter badges + filter pills per critique P6
- [ ] T113 [P] [US7] Create `src/components/broadcasts/admin-template-editor.tsx`: Tiptap editor wrapper + name/subject form + sanitiser pre-check
- [ ] T114 [P] [US7] Create `src/components/broadcasts/admin-template-edit-confirm-starter.tsx` (per critique P6): confirmation banner when editing `is_seeded=TRUE` template; "This is a starter template seeded by the platform..."
- [ ] T115 [P] [US7] Create `src/components/broadcasts/compose-template-picker.tsx` (per critique X3/E8): shadcn Combobox with locale-cascading filter + MRU ordering + Starter badge in dropdown items
- [ ] T116 [P] [US7] Create `src/components/broadcasts/compose-bracket-placeholder.tsx` (per critique P4 / FR-019): Tiptap node-view rendering `[bracketed text]` with grey background + dashed border; first-use microcopy tooltip "Click any [bracketed text] to replace with your content."
- [ ] T117 [P] [US7] Create `src/components/broadcasts/compose-stale-draft-banner.tsx` (per critique E5 + FR-019): on draft load, if `template_updated_at > draft.created_at AND draft.created_at < now() - interval '30 days'` show banner with optional "Refresh from current" CTA (re-runs `snapshotTemplateToDraft`)

#### i18n

- [ ] T118 [P] [US7] Add ~60 i18n keys to `src/i18n/messages/en.json` for admin template library + editor + member picker + stale-draft banner + Starter badge + 3 US7 audit-event display strings + bracket-placeholder microcopy
- [ ] T119 [P] [US7] Add ~60 i18n keys to `src/i18n/messages/th.json` (TH chamber-business register; review by chamber compliance liaison post-ship per spec FR-020)
- [ ] T120 [P] [US7] Add ~60 i18n keys to `src/i18n/messages/sv.json` (SV formal but warm)

#### Feature flag wiring

- [ ] T121 [US7] Gate all US7 routes + use-cases behind `FEATURE_F71A_US7_TEMPLATES=true` AND master; when OFF: admin route 404, member compose dropdown shows only "Blank" + F7 MVP starter (seeded rows remain dormant in DB per critique E11 round 2 + E10)

**Checkpoint**: User Story 7 fully functional — verified by T095 + T096 passing on dev environment.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Observability, runbooks, ship-day operator checklist items, manual QA gates.

### Observability (per plan.md Principle VII)

- [ ] T122 [P] Create `src/lib/metrics/broadcasts-f71a.ts` registering 5 new OpenTelemetry metrics: `broadcasts.batch_dispatch_duration_ms{tenant,batch_index}`, `broadcasts.partial_send_count{tenant}`, `broadcasts.manual_retry_count{tenant,broadcast_id}`, `broadcasts.image_scan_duration_ms{tenant,verdict}`, `broadcasts.clamav_signature_age_hours{}` (probed via `CLAMD VERSION` socket call)
- [ ] T123 [P] Configure 4 new alerts (Vercel Analytics or equivalent): `clamav_signature_age >48h` critical, `clamav_daemon_unreachable >2min` critical, `partial_send_rate >5%` warn, `dispatch_concurrency_saturation >80%` warn
- [ ] T124 [P] Create `docs/runbooks/clamav-signature-stale.md`: when alert fires, runbook covers (a) check Fly.io machine status, (b) `fly ssh console -a clamav-swecham → freshclam --debug`, (c) restart container if needed, (d) verify scan latency returns to <500ms p95
- [ ] T125 [P] Create `docs/runbooks/clamav-daemon-down.md`: when alert fires, runbook covers (a) `fly status -a clamav-swecham`, (b) restart `fly machine restart`, (c) failover plan if extended outage (flip `FEATURE_F71A_US2_IMAGES=false` per plan kill-switch criteria)
- [ ] T126 [P] Create `docs/runbooks/broadcast-partial-send-recovery.md`: when `partially_sent` broadcast hits 3-retry budget, runbook covers (a) check audit-event detail for failure reason, (b) check Resend account-level rate-limit headers via Resend dashboard, (c) decision tree: retry-after-rate-limit-clears vs accept-partial-delivery vs investigate-batch-specific-failure

### Cross-tenant probe expansion (Principle I Review-Gate)

- [ ] T127 [P] Extend `tests/integration/broadcasts/pagination-cross-tenant-probe.test.ts` (T036) with ≥4 probe cases (READ, UPDATE, DELETE, audit-emission) per data-model § 6 pattern
- [ ] T128 [P] Extend `tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts` (T065) with same 4 probe cases
- [ ] T129 [P] Extend `tests/integration/broadcasts/template-cross-tenant-probe.test.ts` (T093) with same 4 probe cases

### CI gates

- [ ] T130 Verify `pnpm check:i18n` passes (all ~170 new EN/TH/SV keys parity); update CI workflow if needed
- [ ] T131 Verify `pnpm check:layout` passes (no layout-container drift introduced by F7.1a routes)
- [ ] T132 Run full CI pipeline locally per CLAUDE.md: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1` — confirm all green
- [ ] T133 Verify coverage thresholds: Domain 100% line (batch-boundary, image-source-allowlist, template-snapshot pure functions); Application 80% line/branch; **100% branch on security-critical paths** (validate-image-source-allowlist, scan-inline-image-for-virus, snapshot-template-to-draft variable substitution, retry-failed-batches advisory-lock acquisition)
- [ ] T134 Run `pnpm tsx scripts/generate-template-seed-migration.ts --check` locally + verify CI gate runs in PR workflow

### Manual QA (per SC-008)

- [ ] T135 Manual screen-reader QA on 5 F7.1a surfaces with NVDA OR VoiceOver: admin batch breakdown, admin retry confirmation modal, admin image-source allowlist editor, admin template library + editor, member template picker dropdown — document findings in `specs/014-email-broadcast-advance/qa/sr-qa-2026-{date}.md`
- [ ] T136 Run quickstart.md § 8 manual walkthrough end-to-end (all 3 USs); verify each US passes its Independent Test criteria

### Ship-day operator checklist (per critique P1)

- [ ] T137 Capture F7 MVP baseline snapshot per critique P1: query F7 MVP `broadcasts` table for {tenant count, broadcasts/week/tenant, segment distribution, max recipient count, draft-abandonment rate, suppression-list growth rate}; write to `docs/observability/f7-mvp-baseline-2026-{ship-date}.md`
- [ ] T138 Update `specs/014-email-broadcast-advance/f71b-backlog.md` "Promotion criteria" table with concrete numbers from T137 baseline (replacing hand-waved assumptions)
- [ ] T139 Deploy ClamAV to Fly.io `sin` region per `infra/clamav/README.md`: `fly auth login` → `fly launch --copy-config --name clamav-swecham --region sin --no-deploy` → `fly secrets set CLAMAV_SHARED_SECRET="$(openssl rand -hex 32)"` → `fly deploy` → verify `fly status -a clamav-swecham` shows "running" + `fly logs` shows "clamd[1]: Listening daemon"
- [ ] T140 Add Vercel env vars: `CLAMAV_HOST`, `CLAMAV_PORT=3310`, `CLAMAV_SHARED_SECRET` (from T139), `FEATURE_F71A_BROADCAST_ADVANCED=false` (master kill-switch), `FEATURE_F71A_US{1,2,7}_*=false` per `quickstart.md § 9.1`
- [ ] T141 Configure cron-job.org coordinator for `POST /api/cron/broadcasts/dispatch-batches` per `quickstart.md § 9.2`: **cadence every 5 minutes**, Bearer auth via `CRON_SECRET` env var, retry-OFF per platform convention; dashboard entry titled "F7.1a US1 Dispatch Batches"
- [ ] T142 Run 16-combination flag-matrix test plan per plan.md § Ship-day flag-matrix on staging environment; document results in `specs/014-email-broadcast-advance/qa/flag-matrix-2026-{date}.md`

### Ship-day flag flip sequence (per research § 5)

- [ ] T143 Flip `FEATURE_F71A_BROADCAST_ADVANCED=true` (master ON; per-US flags still OFF — UI surfaces available but features dark); smoke-test admin can navigate to `/admin/broadcasts/{settings,templates}` without 404
- [ ] T144 Flip `FEATURE_F71A_US7_TEMPLATES=true` (lowest-risk first); verify member compose dropdown shows 5 starter templates × tenant locale; verify Starter badge appears
- [ ] T145 Flip `FEATURE_F71A_US2_IMAGES=true` (depends on Fly.io ClamAV healthy from T139); verify image upload + allowlist editor work; monitor `image_scan_duration_ms` metric for 24h
- [ ] T146 Flip `FEATURE_F71A_US1_PAGINATION=true` (highest risk, last); start with SweCham only (~131 members, well under 5k cap — won't trigger new pagination paths immediately); monitor `partial_send_count` + `dispatch_concurrency_saturation` for 7 days; only roll out to second tenant after 7-day stability window

### Documentation + retrospective hooks

- [ ] T147 [P] Update `CLAUDE.md` (root project) "Recent Changes" section: add F7.1a entry with summary (3 USs, 8 migrations, 10 audit events, Fly.io ClamAV, starter templates seed)
- [ ] T148 [P] Update root `docs/phases-plan.md` F7.1a status: "Spec + plan + design complete; tasks T001-T148 executing on `014-email-broadcast-advance`"
- [ ] T149 Tag final implementation commit with `[Spec Kit] feat(F7.1a): ship dark — all 164 tasks complete (T001-T164)` ready for `/speckit.verify` gate

### Checklist-driven polish tasks (from `checklists/` walkthrough 2026-05-18 — 13 gap closures)

These tasks close the 13 ❌/⚠️ items identified in the manual checklist walkthrough. Each task references the originating checklist item ID for traceability.

**Security gaps** (per `checklists/security.md`):
- [ ] T150 [P] Document cross-member-within-tenant guard invariant in `plan.md § Constitution Check I` (covers CHK006); preserves invariant for F7.1b promotion (US3 contact opt-in, US4 attachments) where member-portal routes could cross-member
- [ ] T151 Strengthen `spec.md FR-013` with explicit ClamAV scan timeout for images (5 min, conservative `error` verdict on timeout) — follow the same 5-minute timeout pattern documented for attachments in `contracts/deferred-f71b/broadcast-attachment.md` (which uses FR-027 numbering in the deferred-f71b spec; F7.1a images need parity at the implementation level even though the FR number differs) (covers CHK020)
- [ ] T152 Add explicit pipeline-order invariant to `spec.md FR-013`: "Image bytes MUST NOT reach Vercel Blob persistence layer BEFORE scan verdict='clean' is recorded; rejected uploads (infected/error/timeout) are NEVER persisted" (covers CHK023)
- [ ] T153 [P] Author DPIA addendum at `specs/014-email-broadcast-advance/dpia-addendum.md` covering: (a) US2 member-content processing surface (image upload + ClamAV scan as sub-processor), (b) US7 admin-content authoring surface (template body as platform-controlled content with tenant-scoped RLS), (c) GDPR Art. 13 lawful-basis enumeration, (d) ROPA entries for new audit-event types (covers CHK036)

**Performance gap** (per `checklists/performance.md`):
- [ ] T154 Specify SC-007a snapshot perf bench fixture parameters in `tests/integration/broadcasts/template-snapshot-decoupling.test.ts` task description (T094): body size = 200 KB (F7 MVP body cap), tenant member count = 1000, locale variant = TH (highest character density for UTF-8 byte count); document per critique (covers CHK033)

**A11y gaps** (per `checklists/a11y.md`):
- [ ] T155 [P] Strengthen `spec.md SC-008` with explicit color-contrast requirement: "≥4.5:1 for text per WCAG 2.1 SC 1.4.3 (AA) on all 11 new F7.1a surfaces" — inherits F4 design tokens but state explicitly so reviewer can verify (covers CHK004)
- [ ] T156 [P] Add focus-management requirements to plan.md UI tasks T053+T054+T081 (modal/dialog components): (a) focus-trap during open, (b) focus-restoration to triggering button on close, (c) universal focus ring per F4 design system (covers CHK012 + CHK014)
- [ ] T157 [P] Document tab-order policy for shadcn Combobox template picker in `contracts/broadcast-template.md § 3`: (a) focus enters dropdown on open, (b) Tab cycles through visible items, (c) Esc closes + restores focus to trigger button (covers CHK010)
- [ ] T158 [P] Add explicit `<label for>` association requirement to `plan.md UI T080` image upload component scaffold: file picker MUST have associated `<label>` (not icon-only); accessible name via i18n key (covers CHK019)
- [ ] T159 [P] Specify Playwright viewport-matrix sizes in `plan.md tests/e2e tree`: test 320px (mobile-min), 768px (tablet), 1280px (desktop), 1920px (desktop-wide) for every new F7.1a e2e spec (covers CHK028)
- [ ] T160 Add touch-device behavior to `spec.md FR-019` bracket-placeholder rendering: "Both behaviors coexist via `@media (hover: hover)` CSS check — desktop (hover-capable): click = enter edit mode + tooltip on hover; touch devices (no hover): single-tap = enter edit mode + first-time-only microcopy tooltip shows on first compose-from-template render and dismisses after first tap. Click handler is universal (NOT replaced); hover tooltip is opt-in for hover-capable devices only" (covers CHK029)
- [ ] T161 [P] Require i18n-keyed `aria-label` strings (NOT hard-coded English) in `plan.md UI component scaffolds`. **Implementation detail**: extend `scripts/check-i18n-coverage.ts` (existing F1 script per CLAUDE.md) with a new `--strict-aria` flag that runs a TSX AST scan via `@typescript-eslint/parser` (already a dep) to detect: (a) JSX attribute names matching `^aria-` with string-literal values (not `t('key')` calls), (b) `role` attribute with literal labels. Reports violations per file:line; non-zero exit on any violation. Add to `pnpm check:i18n` CI gate (covers CHK033)
- [ ] T162 Specify axe-core scan threshold + a11y remediation policy in `plan.md Constitution Check VI`: "Zero violations on critical surfaces (admin batch breakdown, image upload, template picker); warnings logged + reviewed at Polish phase; block-merge on color-contrast + label-association issues only" (covers CHK037 + CHK038)

### Analyze-driven coverage gap closures (from `/speckit.analyze` 2026-05-18 — 2 HIGH gaps)

These tasks close the 2 HIGH coverage gaps identified in cross-artifact analysis. Each task references the originating spec ID for traceability.

- [ ] T163 [US1] Extend F7 MVP `cancelBroadcast` use-case in `src/modules/broadcasts/application/use-cases/cancel-broadcast.ts` to **halt pending batch_manifests within ≤60 seconds** per FR-004: query pending batch_manifests via `broadcastBatchManifestsRepo.findPendingByBroadcastId(broadcastId)` → batch-update status='cancelled' atomically via `broadcastBatchManifestsRepo.markCancelled(batchManifestIds)` (the 'cancelled' enum value added per analyze N1); **extend existing F7 MVP `broadcast_cancelled` audit event payload** (NOT a new event type per analyze N2 strategy b) with two new payload fields: `halted_batch_count` (count of pending → cancelled) + `delivered_batch_count` (count of already-sent batches preserved); ALL writes via `runInTenant()` per Principle I. Contract test `tests/contract/broadcasts/cancel-broadcast-batch-halt.test.ts` asserts: (a) cancel mid-dispatch → pending batches transition to `cancelled`; (b) already-sent batches stay `sent`; (c) audit row payload includes halted_batch_count + delivered_batch_count for transparency (closes analyze C1 / FR-004 gap)
- [ ] T164 Create `specs/014-email-broadcast-advance/qa/` directory if not exists (per analyze N5), then re-run F7 MVP success-criteria suite (`specs/010-email-broadcast/checklists/` validation set) against F7.1a-enabled staging environment per SC-010: execute all F7 MVP SC-001 through SC-014 verifications with `FEATURE_F71A_*=true` flags ON; document any regressions in `specs/014-email-broadcast-advance/qa/f7-mvp-regression-2026-{ship-date}.md`; block ship if any F7 MVP SC regresses (closes analyze C2 / SC-010 gap)

**Deferred items** (documented in checklists but NOT new tasks — F7.1a doesn't require fix):
- `security CHK030` (consent-withdrawability invariant) — F7.1b carry-forward (US3 contact opt-in not in F7.1a scope)
- `performance CHK006` (Constitution VII budget traceability) — docs polish, low priority
- `performance CHK018` (template-picker scale fixture) — F7.1a low priority (SweCham 131 members; future SaaS scale problem)
- `performance CHK028` (ClamAV-down policy explicit) — implicit via CHK022 banner UX + auto-retry
- `a11y CHK035` (text-spacing for TH/SV expansion) — inherited from F7 MVP baseline; no F7.1a-specific risk

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1, T001–T010)**: No dependencies — can start immediately. Most tasks parallelizable [P].
- **Foundational (Phase 2, T011–T031)**: Depends on Setup. T011-T015 schema MUST precede T016 generate; T016 MUST precede T017-T019 manual SQL; T020 (apply) MUST be last. Then T021-T031 parallelizable.
- **User Stories (Phases 3-5)**: All depend on Foundational. **Can run in parallel** if multiple devs (US1 + US2 + US7 are independent per Clean Architecture).
- **Polish (Phase 6)**: Depends on all 3 USs being implementation-complete.

### User Story Dependencies

- **US1 (P1) Pagination**: No dependencies on US2 or US7. Can ship first if prioritising TAM-unlock.
- **US2 (P1) Image embedding**: No dependencies on US1 or US7. Depends on Fly.io ClamAV deployment (T139 in Polish phase, BUT ClamAV adapter T025+T026 in Foundational means dev work proceeds against Docker ClamAV without prod deployment).
- **US7 (P2) Templates**: Depends on Foundational. ALSO depends on **US2 sanitiser integration** (T070 validate-image-source-allowlist) for template-save-image-allowlist test (T091) — but can be developed against a US2 stub if needed; full integration test runs once both implemented.

### Within Each User Story

- Tests (T0**a, T0**b, ...) MUST be RED-committed BEFORE implementation tasks (TDD per Constitution Principle II)
- Domain layer (pure functions) BEFORE Application layer (use-cases)
- Application layer BEFORE Presentation layer (API routes + UI components)
- Infrastructure layer can develop in parallel with Application (different files, ports decouple them)

### Parallel Opportunities

- All Setup tasks marked [P] (T001-T008) can run in parallel
- T021-T031 (Foundational ports + adapters) parallelizable
- All US-phase test files (T032-T040 for US1, T062-T068 for US2, T086-T096 for US7) can be RED-committed in parallel
- Within each US, Domain tasks + Infrastructure adapter tasks parallelizable (different files)
- Polish documentation tasks (T124-T126 runbooks, T147-T148 docs) all parallelizable

---

## Parallel Example: Foundational Phase (T021-T031)

```bash
# Launch all port interfaces + infrastructure adapters together (different files, no deps):
Task: "Create VirusScannerPort in src/modules/broadcasts/application/ports/virus-scanner-port.ts"
Task: "Create ImageAllowlistPort in src/modules/broadcasts/application/ports/image-allowlist-port.ts"
Task: "Create BroadcastTemplatesPort in src/modules/broadcasts/application/ports/broadcast-templates-port.ts"
Task: "Create BatchManifestsPort in src/modules/broadcasts/application/ports/batch-manifests-port.ts"
Task: "Implement ClamAV adapter in src/modules/broadcasts/infrastructure/clamav-virus-scanner.ts"
Task: "Implement ClamAV endpoint resolver in src/modules/broadcasts/infrastructure/clamav-endpoint-resolver.ts"
Task: "Implement allowlist Drizzle repo in src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts"
Task: "Implement templates Drizzle repo in src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts"
Task: "Implement batch-manifests Drizzle repo in src/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo.ts"
```

## Parallel Example: User Story 1 Tests (T032-T040)

```bash
# Launch all US1 tests RED in parallel (different test files):
Task: "Contract test batch-dispatch in tests/contract/broadcasts/batch-dispatch.test.ts"
Task: "Contract test retry-failed-batches in tests/contract/broadcasts/retry-failed-batches.test.ts"
Task: "Contract test accept-partial-delivery in tests/contract/broadcasts/accept-partial-delivery.test.ts"
Task: "Contract test concurrent-retry-race in tests/contract/broadcasts/concurrent-retry-race.test.ts"
Task: "Integration test pagination-cross-tenant-probe in tests/integration/broadcasts/pagination-cross-tenant-probe.test.ts"
Task: "Integration test pagination-7500-end-to-end in tests/integration/broadcasts/pagination-7500-end-to-end.test.ts"
Task: "Unit test batch-boundary in tests/unit/broadcasts/batch-boundary.test.ts"
Task: "E2E test pagination-batch-breakdown in tests/e2e/broadcasts/pagination-batch-breakdown.spec.ts"
```

---

## Implementation Strategy

### MVP-first (recommended for solo-dev)

Per ship-day flag-flip sequencing in research.md § 5, ship in this order even though tasks.md is in priority order:

1. Complete Phase 1 (Setup, T001-T010)
2. Complete Phase 2 (Foundational, T011-T031) — **BLOCKS all user stories**
3. Complete **Phase 5 (US7)** first — lowest-risk; 5 starter templates seed; UI-additive; admin-only surface — ship dark behind `FEATURE_F71A_US7_TEMPLATES=false`
4. Validate US7 independently (T095 + T096) → flip flag ON in staging → smoke test
5. Complete **Phase 4 (US2)** — image embedding + ClamAV; depends on Fly.io ClamAV deploy (T139); ship dark
6. Validate US2 → flip flag ON in staging → smoke test
7. Complete **Phase 3 (US1)** — pagination + advisory locks (highest complexity); ship dark
8. Validate US1 → flip flag ON in staging (start with SweCham, monitor 7 days, then expand)
9. Complete Phase 6 (Polish) in parallel with US-phase work for documentation tasks; cron coordinator + flag-matrix test on staging once all 3 USs implemented

### Incremental Delivery (alternative — priority order)

1. Setup + Foundational
2. US1 (P1 Pagination) → ship dark behind flag → smoke test → flip ON for one tenant
3. US2 (P1 Image embedding) → ship dark → smoke test → flip ON
4. US7 (P2 Templates) → ship dark → smoke test → flip ON
5. Polish + manual QA + flag-matrix in parallel with last US-phase

### Parallel Team Strategy

With 3 developers:

1. All complete Setup + Foundational together (T001-T031)
2. Once Foundational done:
   - **Dev A**: US1 (Phase 3, T032-T061)
   - **Dev B**: US2 (Phase 4, T062-T085)
   - **Dev C**: US7 (Phase 5, T086-T121)
3. All 3 USs integrate independently; merge to single feature branch
4. All collaborate on Polish (Phase 6, T122-T149)

For solo-dev (current Chamber-OS posture): sequential, ~10-15 tasks/day = **~12-18 working days** total. Within Q1 r3 timeline expectation; aligned with maintainer's "decide at /speckit.tasks gate" outcome (149 tasks ≤ 200 threshold → ship all 3 USs as planned).

---

## Notes

- **[P] tasks** = different files, no incomplete dependencies — can run truly in parallel
- **[Story] label** maps task to specific user story for traceability + independent completion
- **Each user story is independently completable + testable** (per Clean Architecture + per-US feature flags)
- **TDD discipline**: verify tests fail (RED) BEFORE implementing (GREEN); commit RED + GREEN separately or as clearly-tagged change set
- **Commit after each task** or logical group; use Conventional Commits + `[Spec Kit]` prefix per CLAUDE.md
- **Per Clarifications round 3 Q1**: 149 tasks ≤ 200 threshold → **ship all 3 USs as planned**; no US7 deferral needed
- **Per Clarifications round 3 Q2**: Tiptap already on 3.22.5 in F7 MVP package.json — clean extension-add, no MAJOR upgrade work
- **Per Clarifications round 3 Q3**: cross-locale template authoring is permissive (admin can author any locale); picker filter (T103) handles member-side display
- **Per Clarifications round 3 Q4**: SC-007c adoption metric = % of submitting members (not % of broadcasts) — measure in T137 + post-ship retrospective
- Avoid: vague task descriptions, same-file conflicts in [P] tasks, cross-story dependencies that break US-independence
- Stop at any checkpoint (end of each Phase) to validate independently before continuing
