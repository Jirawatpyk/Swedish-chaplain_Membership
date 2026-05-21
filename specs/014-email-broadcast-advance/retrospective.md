# F7.1a Email Broadcast Advanced — Retrospective

**Branch**: `014-email-broadcast-advance`
**Status**: Review-clean, READY for ship-day operator gates
**Cumulative**: ~70 in-session task closures across 5+ review rounds
**Authored**: 2026-05-21 (post Round-5+ closure)

---

## Scope shipped

3 user stories + Phase 6 polish:
- **US1** (P1) — Pagination 5k → 50k recipients via per-batch dispatch
- **US2** (P1) — Image embedding with allowlist + ClamAV virus scan
- **US7** (P2) — Multi-template library with snapshot-to-draft semantics

Plus cross-cutting: 5 OTel metrics + 4 alerts + 3 runbooks + DPIA addendum + 17 new audit event types + 18 migrations + 11 new UI surfaces + 11 new API routes.

---

## What worked

**Solo-maintainer review substitute** (Constitution IX) delivered substantive signal:
- 5+ review rounds (R1 narrow code-review · R2 7-agent comprehensive · 3 specialist staff-review) closed 1 CRITICAL + 15 HIGH + 18 MEDIUM + 9+ LOW findings
- `emitTyped<E>` constraint tightening (R6.7 M-12) caught a real type-flow gap
- `emitCrossTenantProbe` discriminated-union consolidation (R4 H1) prevented "new surface, forgot the audit" class of gaps via compile-time `assertNever` guard
- `safeAuditEmit` + counter wiring (R5 CRITICAL) closed the SIEM alarm blind spot that pre-fix would have silenced under audit-rail outage

**Branded type discipline at compile boundary**:
- `IdempotencyKey` + `ChamberSubstitutedBody` + `Hostname` are nominal brands with single-entry-point constructors
- `BroadcastsRepo.updateDraftFromTemplate` requires `ChamberSubstitutedBody` by type — un-substituted template body cannot reach the repo writer
- `TenantSlug` brand sweep (Round 5+ LOW2) widened 18 sites in broadcasts-repo.ts removing `as string` cast smell

**Architecture barrel test as ESLint shadow mitigation**:
- ESLint flat-config has a known shadow bug at `eslint.config.mjs:674` that silently masked the barrel-guard rule
- `tests/unit/architecture/broadcasts-barrel.test.ts` source-scans `src/app/**` + `src/components/**` for deep imports
- 40-item backlog frozen via `file::importPath` keys (drift-resistant against line-number shifts)
- No NEW violations permitted — converges to 0 over time

**4-layer dispatch race defence**:
- cron-tick spacing + FOR UPDATE SKIP LOCKED + idempotency unique + row-state guard (load-bearing)
- Documented in `noop-advisory-lock.ts` extended header why pgAdvisoryLockAdapter NOT wired (pool-exhaustion risk holding connection across multi-second Resend HTTP RTT)

---

## What surprised

**Audit-log append-only trigger** (migration 0001) prevents schema-owner DELETE — meaning probe test cleanup is impossible. Tests accumulate rows on the shared Neon Singapore branch. Mitigation: per-run `randomUUID()` requestId ensures cross-run isolation. Long-term: disposable Neon test branch is the right fix.

**Migration 0172 chamber_app grants reactive fix**: migration 0166 enabled RLS+FORCE on the 4 new tables but forgot to GRANT INSERT/UPDATE/DELETE/SELECT to `chamber_app`. The integration tests caught this on first apply, before any production traffic. Lesson learned: **always pair RLS migration with grant migration** in the same PR.

**`node:stream` + `node:crypto` in Application layer**: Constitution III says "zero framework imports" but Node.js built-ins are runtime primitives, not frameworks. Documented as accepted interpretation — 4 Application files import `node:crypto` + 1 imports `node:stream`. Adding this as an explicit Constitution III commentary note for future readers.

---

## What we'd do differently

**Author Hostname brand in `domain/value-objects/branded-types.ts` upfront** (instead of in the Application port). The Phase 2 ↔ Phase 4 ordering forced a circular-dep workaround documented as Complexity Tracking entry #5. Future features should anchor shared brands in a Domain-level shared file BEFORE the first port reference.

**Add a dedicated `safeAuditEmitTyped` unit test from day one**. Round 5 staff-review identified that the typed variant of `safeAuditEmit` lacks direct unit tests — the metric counter increment relies on indirect coverage through `snapshot-template-to-draft.test.ts`. R008 condition adds the missing 30-LoC test block.

**Avoid scattering `tenantId: string` across port surfaces**. The Round 5+ LOW2 sweep widened 18 sites in one file. The next port should adopt `TenantSlug` from the first method declaration; a single `string` site means future widening sweeps.

**Wire env-var-controlled perf fixtures earlier**. The `PERF_BODY_BYTES + PERF_LOCALE + PERF_DRAFT_COUNT` env-var protocol landed in Round 5 H4 but the file header still claimed "F7.1b polish" — leading to documentation drift that R009 closes. Always update the test file header in the SAME commit as the implementation.

---

## Architectural debt — F7.1b backlog

**B1 — Extract `Hostname` brand to `domain/value-objects/branded-types.ts`** (closes Complexity Tracking #5)
- Source: R002 Round 2 staff-review architectural warning
- Effort: ~15 min (move brand declaration; update 2 imports)
- Risk: low — pure type-only refactor; no runtime impact
- Owner: F7.1b kickoff

**B2 — Refactor 2 cron routes to import via broadcasts barrel** (closes 14 of 40 KNOWN_BACKLOG items)
- Source: R003 Round 2 staff-review architectural warning
- Routes affected: `src/app/api/cron/broadcasts/dispatch-batches/route.ts` (14 deep imports) + `src/app/api/cron/broadcasts/split-large-broadcasts/route.ts` (similar pattern)
- Effort: ~1 hour (barrel-export needed symbols; update imports; verify architecture test still GREEN)
- Risk: low — adapter signatures unchanged
- Owner: F7.1b kickoff

**B3 — Promote `f7AuditAdapter:` invariant-throw string-prefix to tagged `AuditPortInvariantError` class** (S2 polish suggestion)
- Source: R8.5 LOW-1 polish note + Round 2 staff-review S2
- Current: `isAdapterInvariantError(e)` matches `e.message.startsWith('f7AuditAdapter:')` — fragile to message text refactors
- Future: tagged class with `instanceof AuditPortInvariantError` check
- Effort: ~30 min
- Owner: F7.1b kickoff

**B4 — Live-Blob erasure cascade test** (closes R005 Round 2 staff-review medium)
- Source: R005 security-threat-modeler condition
- Current: `member-erasure-cascade.test.ts` uses stub repo for broadcast cascade; no live Vercel Blob `head()` verification
- Future: `member-erasure-cascade-blob.test.ts` exercises full chain on staging tenant — member delete → broadcast delete → Blob `head()` returns 404
- Effort: ~2 hours (requires staging Blob token + cleanup hygiene)
- Risk: medium — needs careful Blob fixture cleanup to avoid pollution
- Owner: F7.1b kickoff OR pre-flag-flip staging exercise

**B5 — Consolidate retry advisory-lock branch coverage** (S3 polish suggestion)
- Source: senior-tester S3
- Current: `retry-failed-batches.test.ts` covers `acquired: true` path; `concurrent-retry-race.test.ts` covers `acquired: false` path
- Future: single test file pinning both branches in isolation (the split is intentional but creates a "read together" cognitive burden)
- Effort: ~20 min
- Owner: F7.1b kickoff

**B6 — Add `page.on('pageerror', ...)` console capture to E2E config** (S4 polish suggestion)
- Source: senior-tester S4 — project-wide gap, not F7.1a-specific
- Current: E2E specs miss client-side React hydration errors + unhandled rejections
- Future: `playwright.config.ts` collects pageerrors + fails on any
- Effort: ~30 min
- Owner: project-wide (not F7.1a deliverable)

**B7 — Tighten axe-core E2E filter from `serious/critical` to all impact levels** (S5 polish suggestion)
- Source: senior-tester S5
- Current: E2E axe scans filter `impact === 'serious' || 'critical'`
- Future: include `moderate` violations as warnings (fail-on-new pattern)
- Owner: F7.2 a11y hardening

**B8 — Tighten reduced-motion E2E assertion** (S6 polish suggestion)
- Source: senior-tester S6
- Current: `expect(['0s', '0ms', '']).toContain(animationDuration)` accepts empty string
- Future: `expect(animationDuration).toBe('0s')` — empty string means media query not applied
- Owner: F7.1b polish

**B9 — Add advisory-lock branch coverage to `auto-retry-failed-batches.test.ts`** (S7 polish suggestion)
- Source: senior-tester S7
- Current: stub deps have no `advisoryLock` key
- Future: if production auto-retry ever requires a lock, test must catch the regression
- Owner: F7.1b kickoff

**B10 — Disposable Neon branch for integration tests** (S8 polish suggestion)
- Source: senior-tester S8 — cumulative audit_log row pollution on shared Neon Singapore
- Future: per-PR Neon branch (Neon `branch` feature) so each test run has fresh state
- Effort: ~4 hours (CI config + branch-cleanup automation)
- Owner: platform-wide initiative

---

## Operational lessons

**Pre-onboarding checklist for next tenant** (covers R001 Round 2 staff-review warning W1):
- The `broadcasts.manual_retry_count` metric carries `broadcast_id` label (high-cardinality). At SweCham scale (~131 members + low broadcast volume) cardinality is benign. **Before onboarding a high-volume tenant**: downgrade label to tenant-only OR migrate to OTel trace span attribute. Failure mode: Prometheus/OTel store memory pressure as broadcast volume scales.

**Documentation hygiene**:
- Spec/plan/implementation drift surfaced 6+ times during review rounds (DPIA event count + bracketHint i18n + subjectPreview field + perf bench env vars + nonexistent runbook refs + `clamav_daemon_unreachable_total` instrument)
- Lesson: every doc claim "X is wired" or "Y exists" must include a file:line cross-reference at authoring time; reviewer can then grep-verify in seconds
- Lesson: prefer code patterns where the test pins the doc claim (e.g., H10 atomicity test pins safeAuditEmit's counter increment)

**Spec-vs-reality alignment**:
- T160 bracket-placeholder + T128b probe-emit metric counter both had implementations that diverged from their spec claims for 1-2 rounds before reviewer caught the gap
- Lesson: when closing a task, run `pnpm grep <file>` for the spec promise to verify code matches; embed the spec line number in the code comment

---

## Constitution compliance posture

| Principle | Status | Sub-clause notes |
|---|---|---|
| I. Data Privacy & Security (NON-NEG) | ✅ PASS | 2-layer tenant isolation; 3 cross-tenant probes on live Neon; 17 audit events; OWASP Top 10 covered; DPIA addendum + 3 runbooks |
| II. Test-First Development (NON-NEG) | ✅ PASS (CT #4 acknowledged) | TDD discipline maintained for new features; Phase 3 retrofit documented |
| III. Clean Architecture (NON-NEG) | ✅ PASS (CT #5 acknowledged) | Domain pure; module barrel test enforces frozen backlog of 40 deep-imports; W2 Hostname inversion tracked in CT #5 |
| IV. PCI DSS (NON-NEG) | ✅ PASS (vacuous) | F7.1a touches no card data |
| V. i18n | ✅ PASS | 3123 keys × EN+TH+SV; `pnpm check:i18n` GREEN |
| VI. Inclusive UX | ✅ PASS | axe-core E2E + `--strict-aria` AST scanner + manual SR QA scaffold (T135) + reduced-motion + viewport-matrix |
| VII. Performance & Observability | ✅ PASS (W1 tracked) | 5 OTel metrics + 4 alerts + 3 runbooks + SLO budgets per US |
| VIII. Reliability | ✅ PASS | 4-layer dispatch race defence + Result<T,E> + advisory locks + idempotency keys + audit append-only |
| IX. Code Quality (Solo-maintainer substitute) | ✅ PASS | 5+ review rounds + 3-agent staff-review + 100% branch on security-critical paths + RLS+FORCE + post-remediation re-review |
| X. Simplicity | ✅ PASS | Zero new npm deps Round 5+; helpers lifted to shared `@/lib/` |

---

## Final ship-day readiness

**In-session work**: ✅ COMPLETE (~70 tasks closed across 5+ rounds)

**Operator-only ship-day gates** (per `qa/ship-day-checklist.md`):
- T135 Manual SR QA on 5 surfaces (NVDA + VoiceOver matrix)
- T136 Quickstart walkthrough end-to-end
- T139 Fly.io ClamAV deploy (`sin` region)
- T140 Vercel env vars (CLAMAV_HOST + CLAMAV_PORT + CRON_SECRET + 4 FEATURE flags)
- T141 cron-job.org coordinator setup (`POST /api/cron/broadcasts/dispatch-batches` every 5 min)
- T142 16-combination flag-matrix on staging
- T143-T146 Production flag-flip sequence (master ON → US7 → US2 → US1)
- T149 Final commit tag at post-flag-flip closure
- T164 F7 MVP SC-001..SC-014 non-regression matrix on staging

**Recommended ship-day order**:
1. Pre-checks: rebase main + run full CI locally (`pnpm lint && pnpm typecheck && pnpm test:integration && pnpm check:i18n && pnpm check:strict-aria && pnpm check:layout && pnpm check:template-seed`)
2. Deploy: Fly.io ClamAV → Vercel env vars → cron-job.org coordinator
3. Validate: staging flag-matrix + SR QA + quickstart walkthrough + F7 MVP regression
4. Flip: master flag ON → 24h watch → US7 ON → 24h watch → US2 ON → 24h watch → US1 ON (SweCham only first, 7-day stability window before second-tenant rollout)
5. Close: T149 final commit tag + retrospective updates

---

## Cross-references

- Latest staff-review report: `reviews/review-20260521-140000.md`
- Prior staff-review (US1-only ship): `reviews/review-20260519-224444.md`
- Ship-day checklist: `qa/ship-day-checklist.md`
- DPIA addendum: `dpia-addendum.md`
- F7.1b backlog: `f71b-backlog.md`
- Constitution: `.specify/memory/constitution.md` (v1.4.0)
