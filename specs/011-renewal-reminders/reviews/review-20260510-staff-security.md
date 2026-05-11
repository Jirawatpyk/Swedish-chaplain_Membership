# F8 Renewal Reminders — Staff-Engineer Security Review (Ship-Readiness)

**Reviewer**: Security Threat Modeler (Claude Sonnet 4.6) — STRIDE + Constitution v1.4.0 Principle I pass
**Branch**: `011-renewal-reminders` · HEAD: `ac55a5fd`
**Date**: 2026-05-10
**Scope**: Renewal-link token, RBAC enforcement, lapsed-portal scope, cron Bearer auth, PII/log redaction, cross-tenant probes, webhook integration, F5 refund bridge, R5+R6 regression verification.
**Methodology**: STRIDE per DFD trust boundary, Principle I 5-sub-clause check, cross-cutting checks per operating rules.

---

## Summary Verdict

**APPROVED FOR SHIP-DARK** behind `FEATURE_F8_RENEWALS=false`.

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 0 |
| 🟡 MEDIUM | 2 |
| 🟢 LOW | 3 |

Constitution v1.4.0 Principle I (Tenant Isolation): **PASS** — all 5 sub-clauses verified.
SAQ-A Scope: **PRESERVED** — F8 has no direct payment surfaces; F5 bridge delegates correctly.

---

## Threat Register

| ID | STRIDE | Threat | L | I | Mitigation | Severity |
|----|--------|--------|---|---|------------|----------|
| R001 | T / I | `constantTimeEqual` in hmac-verifier falls back to string-length equality (`a.length !== b.length` returns false early, bypassing `timingSafeEqual`) — length oracle if MAC lengths differ structurally | L | H | `hmac-verifier.ts:45-49`: both MACs are HMAC-SHA256 = fixed 43 chars base64url. Same length always. No oracle. **CLOSED** — no action. | 🟢 LOW |
| R002 | S | Renewal-link token cross-tenant reuse: attacker obtains valid `v1.<payload>.<mac>` for tenant A and submits to tenant B | L | H | `verify-renewal-link-token.ts:127`: verifier checks `payload.tid === expectedTenantId` (request-resolved, not token-claimed). Cross-tenant fails at step 5 with `cross_tenant` audit emit. **CLOSED**. | 🟢 LOW |
| R003 | I | Token replay after 30d TTL: expired token rehashed with original secret passes HMAC but fails `exp` check | M | M | `hmac-verifier.ts:133`: `parsePayload` checks `exp`. `consumed_link_tokens` PK blocks replay of non-expired tokens. Both layers verified. **CLOSED**. | 🟢 LOW |
| R004 | I | `peekTokenTenantId` used for access-control decision — unauthenticated tenant routing | L | H | `peek-tenant-id.ts` JSDoc explicitly prohibits branching on returned value for authz. Callers only use it for pre-verify log enrichment. Verified no production call site uses the result for DB binding. **CLOSED**. | 🟢 LOW |
| R005 | E | Manager invokes admin-only mutating endpoint (cancel, mark-paid-offline, send-reminder-now, tier-upgrade accept/dismiss/escalate, task done/skip/reassign) | M | H | `renewals-route-helpers.ts:132`: `requireRenewalAdminContext(request, 'write')` calls `requireRole` then emits `f8_role_violation_blocked` audit. Verified across all 10 mutating routes. At-risk outreach uses `'manager_exception'` label allowing manager. **CLOSED**. | 🟢 LOW |
| R006 | E | Member invokes admin or cron route | M | H | `requireRenewalAdminContext` rejects member role at F1 session layer (no session redirect for `/api/admin/**`). Cron routes use Bearer auth only — no session path. **CLOSED**. | 🟢 LOW |
| R007 | S | Cron route Bearer token length timing oracle: early-return on byte-length mismatch leaks whether secret length matches | L | M | `cron-auth.ts:36-40`: UTF-8 byte-length check returns `false` without timing branch distinct from `timingSafeEqual` — both paths reject immediately. No meaningful timing difference on the 401 response path. **CLOSED**. | 🟢 LOW |
| R008 | D | Cron Bearer rejection storm: attacker floods coordinator with bad tokens, exhausting Upstash quota | M | M | `gateCronBearerOrRespond`: rate-limits per-IP at `f8:cron:bearer-rejected:<ip>` 60-req/60s sliding window. Upstash outage fail-open (logs + proceeds to 401 — denial is safe direction). **CLOSED**. | 🟢 LOW |
| R009 | I | `cron_bearer_auth_rejected` audit missing on Upstash outage path | L | M | `cron-auth.ts:120-133`: catch logs `cron.coordinator.rate_limit_check_failed_fail_open`, invokes `rateLimitFallbackCounter()`, then falls through to the audit emit block + 401 — audit is always attempted even on Upstash outage. **CLOSED**. | 🟢 LOW |
| R010 | I | `lapsed_member_action_blocked` audit fails silently when auditEmitter throws | L | L | `lapsed-portal-scope.ts:179-200`: catch swallows + `logger.warn` — by design per Wave I2 contract (audit fire-and-forget). Never blocks the user-facing 403. Metric gap only. **ACCEPTABLE**. | 🟢 LOW |
| R011 | T | Lapsed-portal bypass via path-confusable: `/portal/renewal-evil` matches `/portal/renewal` prefix | L | H | `lapsed-portal-scope.ts:154-161`: `matchesScopePrefix` requires next char to be `0x2F (/)`  or `0x3F (?)` after prefix — substring match rejected. Confirmed fix landed. **CLOSED**. | 🟢 LOW |
| R012 | I | Renewal-link token raw value leaked to logs | M | H | `logger.ts:453-464`: `renewal_token` + `renewal_link` (camel + snake + nested wildcard) in `REDACT_PATHS`. Token is never logged raw; only `tokenSha256` passed to consumed_link_tokens. **CLOSED**. | 🟢 LOW |
| R013 | I | `outcomeNote` / `skippedReason` free-text PII (up to 1000/500 chars) leaked to pino logs | M | M | `logger.ts:154-161`: `outcomeNote`, `outcome_note`, `skippedReason`, `skipped_reason` all in REDACT_PATHS. Phase 8 staff-review W5 confirmed closed. **CLOSED**. | 🟢 LOW |
| R014 | I | `RENEWAL_LINK_TOKEN_SECRET_*` env-var value logged if object serialised | L | H | `logger.ts:469-473`: `RENEWAL_LINK_TOKEN_SECRET` + `renewal_link_token_secret` + camelCase forms in REDACT_PATHS. **CLOSED**. | 🟢 LOW |
| R015 | T | Cross-tenant write via `bulkInsertOpenIfAbsent` in tier-upgrade-suggestion-repo: input.tenantId ≠ adapter slug passes RLS (app-layer Principle I clause 1 gap) | L | H | `drizzle-tier-upgrade-suggestion-repo.ts:538-543` (R6-H2): guard throws if `input.tenantId !== tenant.slug`. Confirmed landed in HEAD. **CLOSED**. | 🟢 LOW |
| R016 | T | Cross-tenant write via `bulkTransitionToSent` raw UPDATE touches another tenant's rows if RLS misconfigured | L | H | `drizzle-renewal-reminder-event-repo.ts:474` (R6-M3-err): `AND r.tenant_id = ${tenant.slug}` hardcoded in raw UPDATE. Re-fetch at line 490 also filters `eq(tenantId, tenant.slug)`. Defence-in-depth confirmed. **CLOSED**. | 🟢 LOW |
| R017 | T / E | `evaluateTierUpgrade` `outerTx` path: `flushPage` failure caught at use-case boundary → outer `runInTenant` commits partial writes → state↔audit drift | M | H | `evaluate-tier-upgrade.ts:492-499` (R6-B1 fix): when `outerTx` is provided, `flushPage` result is awaited WITHOUT a surrounding try/catch — throws propagate to the route's `runInTenant` closure for rollback. Non-outerTx path (lines 500-519) wraps with catch + err. **Fix confirmed landed in HEAD.** Missing integration test on the outerTx failure path (noted in R6 review). See **R017** below. | 🟡 MEDIUM |
| R018 | T | `bulkTransitionToSent` re-fetch returns rows in unspecified order; JSDoc documents "input order" contract that callers may rely on for zip-by-index logic in future outer-loop wiring | L | M | `drizzle-renewal-reminder-event-repo.ts:480-502`: current MVP cron callers do not zip by index. Risk is latent for future outer-loop wiring (T262 retrospective.md lines 113-126). JSDoc says "input order" but Postgres IN-list has no ordering guarantee. | 🟡 MEDIUM |
| R019 | I | F5 refund bridge: `refund_failed.errorCode` + `detail` returned to admin route caller | L | M | `admin-reject-reactivation.ts:204-221`: `errorCode` + `detail` are logged via `logger.warn` (internal) and returned as `err({kind:'refund_failed', errorCode, detail})` to the use-case. The route handler for this use-case was not found exposed as a standalone route at HEAD — `adminRejectReactivation` is exported from barrel but has no route.ts in `/api/admin/renewals/`. Detail does not reach member portal. **CLOSED** — no member-facing oracle. | 🟢 LOW |
| R020 | S | `confirmRenewal` portal route: URL `memberId` not validated against session before use-case call | L | H | `confirm/route.ts:67-73` (C1 review-fix): `urlMemberId !== ctx.memberId` check with generic 404 per FR-027. Confirmed landed. **CLOSED**. | 🟢 LOW |
| R021 | R | Webhook (Resend bounce) returns 5xx → Resend retry storm | L | H | R5-C3: split DB-error vs app-error catch — early-return 200 on Resend-side delivery-not-found; only 5xx on genuine infrastructure failure. `bounce_hook_failed_total` counter fires on app-path to alert SRE before storm starts. **CLOSED**. | 🟢 LOW |
| R022 | I | `f8_role_violation_blocked` audit emit failure swallowed silently | L | M | `renewals-route-helpers.ts:167-176`: catch + `logger.warn` with `correlationId` + `actorRole`. Never blocks the 403. Pattern consistent with Wave I2 fire-and-forget contract. **ACCEPTABLE**. | 🟢 LOW |

---

## Principle I — Tenant Isolation 5-Sub-Clause Verification

| Sub-clause | Status | Evidence |
|------------|--------|---------|
| 1. App-layer `runInTenant` on every use-case | PASS | All 20+ use-cases wrap DB writes in `runInTenant(deps.tenant, ...)`. Checked `evaluate-tier-upgrade.ts`, `admin-reject-reactivation.ts`, `confirm-renewal.ts`. |
| 2. DB-layer RLS + FORCE RLS on all 9 F8 tables | PASS | CHK019: `pnpm check:multi-tenant` 24/24 SCOPED PASS. Migration SQL verified in data-model.md § 5. |
| 3. Cross-tenant probe integration test | PASS | `tenant-isolation.test.ts` 50/50 probes GREEN across 9 F8 tables × 6 probe patterns (CHK023). |
| 4. Audit emit on deny path | PASS | `renewal_cross_tenant_probe` emitted at use-case layer. `cron_bearer_auth_rejected` + `lapsed_member_action_blocked` + `f8_role_violation_blocked` all confirmed. |
| 5. Super-admin path gated + logged | PASS | No super-admin bypass path exists in F8. Admin actions all go through `requireRenewalAdminContext` + RLS. |

---

## Review-Gate Blockers

**None** — 0 CRITICAL findings.

---

## Medium Findings Detail

### R017 — Missing integration test for `evaluateTierUpgrade` `outerTx` failure path

**File**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:492-499`
**STRIDE**: Tampering (state↔audit drift if rollback does not fire)
**Why it matters**: The R6-B1 fix (throw propagation on outerTx path) is correctly implemented in code. However, no integration test drives the cron route's `outerTx` path with a failing `bulkEmitInTx` and asserts that `tier_upgrade_suggestions` row count is unchanged (rollback verified). Without this test, a future refactor could silently re-introduce the drift.
**Test required**: Add `tests/integration/renewals/evaluate-tier-upgrade-outer-tx-rollback.test.ts` — inject a failing audit emitter, call `evaluateTierUpgrade` with `outerTx` provided, assert suggestion-insert rolled back (count unchanged).
**Constitution mapping**: Principle II (Test-First), Principle VIII (state↔audit atomicity).

### R018 — `bulkTransitionToSent` JSDoc order contract inconsistent with implementation

**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:447-514`
**STRIDE**: Tampering (future callers may silently misattribute `dispatchedAt`/`deliveryId` to wrong cycles)
**Why it matters**: JSDoc at `application/ports/renewal-reminder-event-repo.ts:152` documents "Returns updated rows in **input order**". The implementation uses a `SELECT ... IN (ids)` re-fetch without ORDER BY — Postgres makes no ordering guarantee. Current MVP cron callers do not zip by index, so no exploit today. But T262 outer-loop wiring (retrospective.md lines 113-126) would be directly affected.
**Fix**: Either (a) re-order result using `new Map(rows.map(r => [r.reminderEventId, r])); return inputs.map(i => map.get(i.reminderEventId)!)` or (b) amend JSDoc to "order unspecified — caller must look up by `reminderEventId`". Add a test that asserts behaviour when input order differs from DB return order.
**Constitution mapping**: Principle II (Test-First — contract must match implementation).

---

## Cross-Cutting Checks Summary

| Check | Status |
|-------|--------|
| CSRF (Origin allow-list on mutating routes) | PASS — F1 middleware covers all `/api/**` |
| Session fixation / idle TTL | PASS — F1 30min idle / 12h absolute (F8 does not introduce sessions) |
| argon2id DoS on token verify | N/A — HMAC-SHA256 not argon2 |
| Rate limiting on token verify path | PASS — portal rate-limit via Upstash; cron bearer-rejection rate-limited |
| Enumeration via error messages | PASS — FR-027 generic "expired or invalid" page for all token failure modes |
| Timing attacks on HMAC compare | PASS — `timingSafeEqual` + UTF-8 byte-length pre-check |
| IDOR on cycle/task/suggestion IDs | PASS — `cyclesRepo.findById(tenantId, cycleId)` always scopes by tenant; UUID non-guessable |
| Mass assignment on body schemas | PASS — all routes use `z.object({...}).safeParse(raw)` with explicit field list |
| Log injection / secret leakage | PASS — REDACT_PATHS covers all 7 FR-049 fields including R10-added `outcomeNote`/`skippedReason` |
| PAN in `payment_reference` (mark-paid-offline) | PASS — dual-pass PAN guard (ASCII fast-path + Unicode digit fallback for Round 7) |
| SAQ-A scope | PASS — F8 has zero payment card surfaces; F5 bridge delegates via F5's Stripe Elements path |
| Hardcoded secrets | PASS — grep finds no hardcoded secret values; all from `env` zod gate |
| SQL injection in raw `sql` template | PASS — `bulkTransitionToSent` raw UPDATE uses Drizzle `sql` tagged template with parameterized values; no string concatenation |
| PDPA / GDPR automated-decision-making | PASS — DPIA § F8 documents not-Art.22 (at-risk score is advisory, no automated membership decision) |
| Audit retention (5y) | PASS — F8 events inherit `audit_log.retention_years DEFAULT 5`; CHK038 verified |

---

## Recommended `security.md § 5` Checklist Items

```
- [ ] R017-FIX: Add `tests/integration/renewals/evaluate-tier-upgrade-outer-tx-rollback.test.ts` —
      drive outerTx path with failing bulkEmitInTx; assert tier_upgrade_suggestions count unchanged.
      (Constitution Principle II + VIII; blocks F11 outer-loop wiring safety)

- [ ] R018-FIX: Choose one of (a) Map-based reorder in bulkTransitionToSent or
      (b) JSDoc amendment + caller discipline; add a test pinning the chosen contract.
      (Constitution Principle II; required before T262 outer-loop wiring is enabled)

- [ ] CHK039 (deferred): Add tests/integration/renewals/f8-f5-refund-bridge.test.ts
      once F5 integration test infra is reusable post-soak. Not a ship blocker.
```

---

## Constitution Mapping

| Finding | Principle |
|---------|-----------|
| R017 (outerTx test gap) | II (Test-First NON-NEG), VIII (Audit atomicity) |
| R018 (JSDoc/impl contract mismatch) | II (Test-First NON-NEG), III (Clean Architecture — port contract) |
| CHK039 (F5 bridge integration test deferred) | II (Test-First NON-NEG) — explicitly deferred with rationale |

---

## Open Questions

1. Is there an integration test proving the `consumed_link_tokens` PK conflict correctly handles concurrent double-click (two simultaneous requests with the same token)? The unit tests cover the `markConsumed` replay path but a real-concurrency Postgres test would strengthen the guarantee.
2. The `adminRejectReactivation` use-case is exported from the barrel but has no route.ts in `/api/admin/renewals/`. Is this pending a future phase, or is it invoked from another surface not found in this review? If the latter, confirm the caller applies `requireRenewalAdminContext('write')`.
