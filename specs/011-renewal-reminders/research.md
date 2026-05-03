# F8 — Renewal Tracking + Smart Reminders — Research

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 0 output (`/speckit.plan`)

---

## R1 — Renewal-link token design (locked at /speckit.clarify Session 2026-05-03 round 3 Q4 for URL format)

### Decision

Use **HMAC-SHA256** on a JSON payload, NOT JWT. Single-use enforcement via a dedicated `consumed_link_tokens` table. TTL 30 days. Dedicated secret `RENEWAL_LINK_TOKEN_SECRET` (≥32 bytes, distinct from F1 auth cookie signing secret and F7 unsubscribe token secret) — dual-key rotation per R16.

**URL format (revised at /speckit.critique round 2 / M4)**: F8 uses F1's existing `resolveTenantFromRequest()` abstraction in `src/lib/tenant-context.ts`. The abstraction is **era-agnostic**:

- **MVP era (single-tenant SweCham)**: URL = `https://swecham.zyncdata.app/portal/renewal/<memberId>?token=<v1.payload.mac>`. `resolveTenantFromRequest()` returns the constant `env.tenant.slug` ("swecham"). Defence-in-depth becomes a `payload.tid === "swecham"` check.
- **Post-F10 era (multi-tenant SaaS)**: URL = `https://<tenant>.zyncdata.app/portal/renewal/<memberId>?token=<...>`. `resolveTenantFromRequest()` returns per-request resolved tenant from subdomain/host. Defence-in-depth check uses subdomain-derived value.

F8 verifier code is **identical** in both eras — F8 does NOT extend F1's middleware; F1's existing `resolveTenantFromRequest()` abstraction handles the era transition transparently when F10 ships.

Token payload format: `v1.<base64url(payload)>.<base64url(mac)>` where payload = `{v: 1, tid: <tenant_id>, mid: <member_id>, cid: <cycle_id>, iat: <epoch_ms>, exp: <epoch_ms>}` and mac = `HMAC-SHA256(secret, payload_bytes)`.

Verification flow (revised at /speckit.critique round 2 / M4 to use F1's existing abstraction):
1. **F8 route handler resolves `tenantFromRequest` via `resolveTenantFromRequest(req)`** from F1's `src/lib/tenant-context.ts`. In MVP era this returns the constant `env.tenant.slug`; in post-F10 era it returns per-request subdomain-derived tenant. No F8-specific middleware extension needed.
2. F8 route handler parses token format; reject malformed → `renewal_token_invalid` audit with `reason: 'malformed'`
3. `crypto.timingSafeEqual` on MAC (try `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` first, then `_FALLBACK` per R16); reject tampered → `renewal_token_invalid` audit with `reason: 'mac_mismatch'`
4. Check `now < exp` → reject expired → audit `reason: 'expired'`
5. **Cross-tenant check**: if `payload.tid !== tenantFromRequest` → reject → audit `reason: 'cross_tenant'`. Defence-in-depth: in MVP era this catches "attacker signs token for tenant X but our deployment serves tenant Y"; in post-F10 era this catches "attacker uses Tenant-A subdomain with Tenant-B-signed token".
6. Check `consumed_link_tokens` for `(tenant_id, sha256(token))` → if found, reject replay → audit `reason: 'replay'`
7. Bind `tid` from payload to `app.current_tenant` via `runInTenant` → query `members WHERE tenant_id = $tid AND member_id = $mid` (defence-in-depth per critique E11) → if zero rows, reject → audit `reason: 'member_not_found_in_tenant'`
8. INSERT into `consumed_link_tokens` with sha256(token) as PK to prevent replay
9. Sign-in member to a session and redirect to `/portal/renewal/<member_id>`

### Token re-issuance semantics (CHK033 round-2 security gap resolution)

Each scheduled reminder step generates a FRESH token at dispatch time (NOT at cycle-creation time). Each token is independent (its own `iat` / `exp` / sha256 hash):

- T-90 token issued at T-90 dispatch with TTL 30d (valid through T-60).
- T-30 token issued at T-30 dispatch with TTL 30d (valid through T+0).
- Independence: T-90 token continues to verify until its TTL expires OR until consumed (whichever first).
- Cycle-completion cancellation: when a member clicks T-90 token at T-60 and completes renewal, the cycle transitions to `completed` AND remaining scheduled reminder steps are cancelled (FR-023 cancel-remaining-reminders). T-30 token is never generated for this cycle.
- Race-condition handling: if T-30 dispatch fires concurrently with cycle-completion (very rare but possible), the T-30 token is generated, dispatched, and lands in member's inbox AFTER cycle is `completed`. If member clicks the T-30 link, FR-027 verification step 7 (member-tenant ownership) passes BUT FR-027 step 8 (cycle status check) returns "Your renewal is already complete" page (idempotent no-op, no double invoice). Audit `renewal_token_clicked_on_completed_cycle` for forensic visibility.
- Token table cleanup: `consumed_link_tokens` retains hashes for 60 days post-consume (per E7 prune cron); after that, replay attempts on consumed tokens are indistinguishable from random invalid tokens (both reject at FR-027 step 5 mac-mismatch / step 6 replay).

### Rationale

- HMAC vs JWT: F1+F7 already established the HMAC pattern (F7 unsubscribe tokens). JWT brings RS256 key-management overhead with no benefit for a closed-system signed link. HMAC is shorter and faster to verify.
- Single-use via DB row, NOT just `exp` claim: links are emailed and members may forward them; DB-row consumption is the only way to prevent replay if an inbox is compromised post-renewal.
- 30-day TTL: matches typical reminder cadence (T-90 → T-30 → T-7 → T+0). A T-90 link should still work at T-60. After T+0 a fresh link is generated by the next reminder dispatch.
- Dedicated secret: per Constitution Principle I + F7 precedent. Independent rotation. Forbidden in pino logs (FR-049 redact list extended).

### Alternatives Considered

- **JWT**: rejected — RS256 key management overhead with no security benefit; HS256 is functionally equivalent to HMAC.
- **TTL via `exp` claim only, no DB tracking**: rejected — replay attacks possible if a member's email is compromised after they renew; admin asks "did the member renew themselves or did someone else click the link?" must be answerable from logs.
- **Shared secret with F7 unsubscribe**: rejected — independent rotation per F7 precedent; secret compromise should not blast-radius across features.
- **Plaintext token in DB**: rejected — insider access to DB would expose live tokens; sha256 the token before persistence (only the hash is needed for replay detection).

---

## R2 — Cron idempotency + concurrency pattern

### Decision

Reuse the F4/F5/F7 cron pattern: `SELECT … FOR UPDATE SKIP LOCKED` per-row + `pg_advisory_xact_lock(hashtextextended('renewals:dispatch:'||tenantId, 0))` per tenant. Lock namespace `renewals:` is disjoint from F4 `invoicing:` and F5 `payments:` and F7 `broadcasts:` so no cross-feature contention.

Three cron jobs each get their own advisory-lock namespace:
- `renewals:dispatch:<tenantId>` (daily reminder dispatch)
- `renewals:atrisk:<tenantId>` (weekly at-risk recompute)
- `renewals:tierupgrade:<tenantId>` (weekly tier-upgrade evaluate)

Idempotency at the row level via partial unique indexes on `renewal_reminder_events(cycle_id, step_id)` (FR-011) and on `tier_upgrade_suggestions(tenant_id, member_id) WHERE status IN ('open', 'accepted_pending_apply')` (FR-038).

### Rationale

- Disjoint namespaces guarantee no contention between F4 (§87 sequential numbering) and F8 dispatching reminders for the same member concurrently.
- `SKIP LOCKED` allows multiple cron-worker instances to share work without deadlock if Vercel ever runs the cron handler in parallel.
- Advisory lock is auto-released at tx-end (no manual cleanup needed).
- Per-tenant locking lets one tenant's slow cron not block another tenant's pass.

### Alternatives Considered

- **Single global lock**: rejected — would serialise all tenants behind one another; doesn't scale to 50+ tenants in SaaS phase.
- **Application-level mutex (Redis lock)**: rejected — adds an external dependency at a layer where Postgres advisory locks already work; F4/F5/F7 precedent is to use Postgres natively.
- **No locking, rely on idempotency only**: rejected — multiple workers could double-call Resend transactional API even if DB writes are idempotent; the lock prevents wasted external API calls.

---

## R3 — Membership year anchor maths

### Decision

`expires_at` is **per-member anchored** (Q1 round 1):
- First cycle: `expires_at = joined_at + plan.term_months` (where `term_months` is read from F2's `membership_plans` table; default 12 if NULL)
- Subsequent cycles: `expires_at = previous_expires_at + plan.term_months`

Fiscal-boundary date math via `@js-joda/core` + `@js-joda/timezone` (Asia/Bangkok), reused unchanged from F4. All `expires_at` values stored as `timestamptz` in UTC; rendered with `Intl.DateTimeFormat` per recipient locale; Buddhist Era applied for `th-TH` display only.

Multi-year cycle handling (Q4 round 1):
- A 3-year Diamond Partnership has `period_from = 2026-01-15` and `period_to = 2029-01-15` → `expires_at = 2029-01-15`
- The cron computes `year_in_cycle = floor((today - period_from) / 365 days) + 1`
- Email steps fire only when `year_in_cycle === N` (final year); task steps fire annually with `year_in_cycle` rebased

Rollover atomicity: when F4 marks a renewal invoice paid, F8's hook (`markCycleCompleteFromInvoicePaid`) advances `members.expires_at` and creates the NEXT `RenewalCycle` row with `period_from = old_expires_at`, all in the same DB transaction.

### Rationale

- Per-member anchor matches the F4 invoicing model (`docs/membership-benefits-analysis.md` already assumes per-member anniversaries) and produces a smooth year-round cron load.
- ISO 8601 UTC storage is constitution-mandated (Principle V); BE display is rendering-time only.
- Atomic rollover prevents the "paid but `expires_at` unchanged" inconsistency that would surface as a member complaint.

### Alternatives Considered

- **Calendar-year anchor**: rejected at Q1 round 1; flagged as OOS-11 for future tenant-configurable extension.
- **Compute `expires_at` on-the-fly from F4 invoice history**: rejected — couples F8 reads to F4 schema; better to materialise on `members` row + advance atomically on invoice-paid event.

---

## R4 — At-risk score formula calibration

### Decision

Adopt the 8-factor formula from `docs/smart-chamber-features.md` § 3 with the FR-029a feature-port fallback (Q3 round 1) layered on top:

```
Active factors (always):
- E-Blast quota used <30%             → +15
- Cultural-ticket quota used <50%     → +10
- Invoices overdue count >0           → +25
- Days since last payment >180        → +10
- Days since last contact update >365 → +5
- Tier downgraded in last 12 months   → +15

F6-gated factors (active only when EventAttendeesPort.isAvailable()):
- Events attended last 12 months == 0           → +25
- Events attended last 3 months == 0 (and >0/12)→ +10

Score = min(active_max, sum of triggered factors)
where active_max = 100 if F6 active, 70 if F6 inactive
```

Bands are computed as fractions of `active_max`:
- `healthy` = `score < 0.25 * active_max`
- `warning` = `0.25 ≤ score < 0.50`
- `at-risk` = `0.50 ≤ score < 0.75`
- `critical` = `score ≥ 0.75`

When `active_max = 100` → bands 0–24 / 25–49 / 50–74 / 75–100.
When `active_max = 70` → bands 0–17 / 18–34 / 35–52 / 53–70.

Synthetic-data validation: load 100 fixture members with mixed engagement profiles, assert score distribution roughly 60% healthy / 25% warning / 12% at-risk / 3% critical (matches typical chamber industry baseline).

### Rationale

- Rule-based formula is transparent + defensible to PDPA Section 32 + GDPR Art. 22 explainability obligation.
- Fractional bands keep the buckets meaningful regardless of which factors are active.
- Per-tenant configurability of weights is OUT of MVP scope (Constitution Principle X simplicity); ships as F8 follow-up if multiple tenants disagree.

### Alternatives Considered

- **ML model trained on historical renewals**: rejected per Constitution Principle X + smart-chamber-features.md § 3.
- **Multiplicative formula** (factors multiply rather than add): rejected — addition is easier to reason about, harder to produce extreme scores from edge cases.
- **Per-tenant configurable weights**: deferred to post-MVP follow-up; a single canonical formula makes cross-tenant comparison + product-team learning easier in MVP.

---

## R5 — F6 readiness probe pattern

### Decision

Define an `EventAttendeesPort` interface in `src/modules/renewals/application/ports/`:

```ts
export interface EventAttendeesPort {
  isAvailable(): Promise<boolean>;
  countEventsAttendedByMember(memberId: MemberId, since: Instant): Promise<number>;
}
```

**F6 contract assertion (CHK025 round-2 integration gap resolution)**: when F6 ships its real adapter, F6 MUST satisfy this exact contract:

- `isAvailable()` returns `true` after F6 module is wired into composition root with `FEATURE_F6_EVENTS=true` (mirrors F1+F4+F5+F7 kill-switch convention).
- `countEventsAttendedByMember(memberId, since)` returns the count of events with `event.start_date >= since` AND `event_registrations.matched_member_id === memberId` AND `event_registrations.tenant_id === current tenant context` AND `event_registrations.status === 'attended'`.
- Return type: non-negative integer (count, not estimate). Empty / no-data case → 0 (NOT null, NOT throw).
- Performance contract: <50ms p95 per member-id at SaaS scale (5k members × 8 weekly cron invocations = 40k calls per cron run; <50ms keeps at-risk recompute <60s SLO).
- Tenant context: F6 reads from `app.current_tenant` per existing F8 cron `runInTenant` wrap (no F6-specific tenant resolution needed).

F8's stub-port + F6's eventual real implementation MUST both be covered by an F8-owned **contract test** (`tests/contract/event-attendees-port.contract.test.ts`) that asserts identical input/output shapes regardless of which adapter is wired. Contract test added to plan.md Testing list. Mirrors F7's `EventAttendeesRepository` stub-port + contract-test pattern from F7 ship.

Ship two adapters:
- `f6-event-attendees-port-stub.ts` (in `src/modules/renewals/infrastructure/ports-adapters/`) — returns `false` from `isAvailable()` and throws if `count*` is called. Used until F6 ships.
- (future) `f6-event-attendees-port-drizzle.ts` (added by F6 in `src/modules/events/infrastructure/`) — wired in when F6 lands; returns `true` from `isAvailable()` + reads `event_registrations` table per contract above.

Composition root selects the adapter based on `process.env.FEATURE_F6_EVENTS === 'true'` (matches the F1+F4+F5+F7 kill-switch convention).

### Rationale

- Mirrors F7's `EventAttendeesRepository` stub-port pattern exactly — F7 set the precedent that F8 reuses without invention.
- Hexagonal architecture honoured: F8 Application layer depends on the port interface, NOT on F6's implementation.
- Auto-activates when F6 ships without F8 code change.

### Alternatives Considered

- **Direct cross-module import of F6 module**: rejected — violates Clean Architecture Principle III; modules import each other only via public barrel + port interfaces.
- **Hardcoded `false` until F6 manually flipped**: rejected — feature-port pattern is more flexible and testable; staging can flip independently of production.

---

## R6 — Transactional vs marketing email separation

### Decision

F8 reminder emails go through the **F1+F4 transactional Resend surface**:
- API key: `RESEND_API_KEY` (existing F1 env var; same one F4 uses for invoice-PDF emails)
- Webhook: F1's `email_delivery_events` table (NOT F7's `broadcast_deliveries`)
- Suppression list: NONE (transactional emails do not honour marketing unsubscribe; member-specific opt-out is via FR-016 in-app preference, NOT inbox unsubscribe)
- Reply-to: tenant-configurable per `tenant_renewal_settings.reply_to_email`
- List-Unsubscribe header: NOT included (transactional ≠ marketing)

F8 emails do include a "Manage your renewal preferences" link (FR-015) pointing to `/portal/preferences/renewals` — an in-app preference page, NOT a one-click unsubscribe.

### Rationale

- Renewal communications are part of the contract performance under PDPA Section 24(5) and GDPR Art. 6(1)(b) — the chamber has a legal basis to communicate about contract lifecycle events without separate marketing consent.
- Mixing F8 with F7 Resend Broadcasts would: (a) consume the chamber's E-Blast quota for system-mandated communications, (b) honour the F7 marketing-unsubscribe list and silently drop renewal reminders for members who unsubscribed from marketing — a contractual gap, (c) muddy sender reputation if a member complains about a renewal reminder as if it were marketing.
- F1+F4 transactional reputation is already established and well-monitored.

### Alternatives Considered

- **Use F7 Resend Broadcasts surface**: rejected — see above (suppression list + quota + reputation issues).
- **Separate Resend API key for renewal-only**: rejected — adds an env var with no security benefit; F1+F4 transactional pool is sufficiently isolated by purpose taxonomy.
- **Consolidate all transactional + marketing under one suppression list**: rejected — legal regimes are different (PDPA §24(1) consent vs §24(5) contract performance).

---

## R7 — Tier-upgrade pending state lifecycle

### Decision

Adopt the Q5 round 2 design:

1. Admin "Accept" → suggestion status `open` → `accepted_pending_apply` with `accepted_at`, `accepted_by_user_id`, `target_apply_at_cycle_id` populated. NO mutation of `members.plan_id`.
2. F8 dispatches a single transactional email to member: "Your upgrade to {target_plan} has been approved; effective at next renewal {expires_at}". Audit `tier_upgrade_pending_member_notified`.
3. If `expires_at - today > 180 days`, F8's daily cron creates a `RenewalEscalationTask` of type `verify_pending_tier_upgrade` due at T-180.
4. At next renewal cycle rollover, F4's `createMembershipInvoice` is extended to read pending suggestions (`getPendingTierUpgradeForMember(memberId)` — F8 barrel export) and issue the invoice at the upgraded plan's price; suggestion transitions to `applied`. Atomic with F2's `changeMemberPlan`.
5. If admin manually changes plan via F2 mid-pending, F8 listens for the F2 `member_plan_changed` event and auto-cancels the pending suggestion with status `superseded`.

### Rationale

- Avoids surprise mid-year invoicing (the original FR-039 intent before clarification).
- Member receives immediate communication so the upgrade is not a "silent mystery" at next renewal.
- Admin gets a re-verify task at T-180 (6 months later) so circumstance changes (member shrunk, contract dispute) can be detected before the invoice fires.
- Auto-cancel on manual override prevents stale pending state from interfering with admin's deliberate action.

### Alternatives Considered

- **Immediate plan mutation + pro-rated invoice for the difference**: rejected at Q5 round 2 (option C) — violates the "no surprise mid-year invoicing" intent.
- **Silent wait until next cycle, no member email**: rejected at Q5 round 2 (option A) — admin and member both forget; high "lost upgrade" rate reported by other chamber-management products.
- **Admin-set effective date** (option D): rejected — adds decision overhead per accept; risk of admin mistake.

---

## R8 — F1 bounce-event integration (rev. 2 — REVISED per critique E1)

### Decision

**Synchronous in-process invocation** from F1's existing Resend transactional webhook handler. F1's webhook handler at `/api/webhooks/resend` (existing) directly calls F8's `detectBounceThreshold(ctx, memberId)` use-case via the F8 public barrel after persisting the bounce row to `email_delivery_events`.

Flow:

1. Resend sends bounce event to `/api/webhooks/resend`
2. F1 webhook handler verifies signature (existing F1 logic)
3. F1 webhook handler INSERTs the bounce row into `email_delivery_events` (existing F1 logic)
4. F1 webhook handler resolves `member_id` from the recipient address (existing F1 logic — F1 already needs this for retry semantics)
5. **NEW**: if `FEATURE_F8_RENEWALS === true` AND the resolved `member_id` is non-null, F1 webhook handler imports `detectBounceThreshold` from F8's public barrel and invokes it synchronously (`await detectBounceThreshold({tenantId, memberId})`)
6. F8's `detect-bounce-threshold.ts` use-case queries the last 30 days of bounce events for that member, checks the 3-trigger thresholds (FR-012a Q4 round 2), updates `members.email_unverified = true` if crossed, creates a `manual_outreach_required` escalation task (idempotent), emits audit `member_email_unverified_threshold_crossed`
7. Use-case is idempotent + fast (<50ms) so the F1 webhook handler stays under its 250ms p95 budget

Reset path (member updates email + verifies):

1. F1 emits `email_verification_succeeded` audit event after verification flow completes
2. F1's verification handler (in addition to its own logic) calls F8's `resetEmailUnverified(ctx, memberId)` synchronously via the F8 barrel
3. F8 sets `email_unverified = false`, closes any active `manual_outreach_required` task, emits audit event

### Rationale

- **LISTEN/NOTIFY does not work in Vercel Fluid Compute** (the original R8 approach). Function instances are short-lived and cannot maintain a persistent Postgres connection across invocations. The next-invocation-processes-backlog claim was incorrect; LISTEN backlog is per-connection, not durable.
- Synchronous in-process call is the correct pattern for serverless: F1 webhook handler is already alive when the bounce is persisted, F8 use-case takes <50ms, no separate worker / queue / connection-pool to maintain.
- F1 has soft-dependency on F8's barrel (acceptable — `if (FEATURE_F8_RENEWALS) detectBounceThreshold(...)` is a no-op when F8 is dark; F1 keeps shipping unchanged when F8 is disabled).
- Uses the F8 module's public surface only; no deep imports into F8 internals from F1.

### Alternatives Considered

- **Postgres LISTEN/NOTIFY** (original R8): rejected — does not work in Vercel Fluid Compute serverless (broken architecture; flagged in critique E1).
- **Separate worker process polling `email_delivery_events`**: rejected — adds infrastructure (a long-running worker on Render or Railway) for what a synchronous in-process call handles in <50ms.
- **Vercel Queues + worker**: feasible but over-engineered for the bounce-detection use case. Reserve queue infra for genuinely async work (e.g., bulk email exports in F9+).
- **F1 emits an event → F8 consumes via a domain event bus**: rejected — adds a domain-event abstraction with no current second consumer; YAGNI per Constitution Principle X.

### Implementation note

The F1 webhook handler change is a 4-line addition in F1's `src/modules/auth/infrastructure/resend-webhook-handler.ts` (or equivalent). Coordinate with F1 maintainer + add to plan.md Complexity Tracking entry #3.

### F1 transactional Resend retry budget alignment (CHK016 round-2 reliability gap resolution)

F1's existing transactional Resend retry budget (per F1 contract): exponential backoff with 3 retry attempts inside the F1 webhook + outer queue retry up to 24h on transient failures. F8 reminder dispatch consumes F1's retry budget transparently — F8 calls F1's `dispatchTransactionalEmail(template_id, to, locale, props)` which handles its own retry. F8 layer adds NO additional retry on top (would compound to 9 retries total which is wasteful + risks Resend rate-limit).

F8's FR-010a 24h retry window ALIGNS with F1's outer queue retry semantics — they reference the same underlying mechanism. F8 marks a reminder event as `failure_reason: 'transient'` (consumed F1 retry budget) only after F1's retry exhausts. This avoids double-counting retries.

Token: same `RESEND_API_KEY` (single transactional pool reputation; no F8-specific key).

---

---

## R9 — 5 tier buckets backfill

### Decision

Map each existing SweCham 2026 Membership Package PDF tier to canonical 5-bucket enum during migration 0091:

| F2 plan name | `renewal_tier_bucket` |
|---|---|
| Thai Alumni | `thai_alumni` |
| Individual | `thai_alumni` (small individuals collapse with alumni for reminder cadence) |
| Start-up Corporate | `start_up` |
| Regular Corporate | `regular` |
| Large Corporate | `regular` |
| Premium Corporate | `premium` |
| Diamond Partnership | `partnership` |
| Platinum Partnership | `partnership` |
| Gold Partnership | `partnership` |

Any future SweCham plans must be assigned a bucket on creation (NOT NULL constraint). Default policy fixtures for all 5 buckets ship as part of migration 0087 (`tenant_renewal_schedule_policies`) populated during tenant onboarding.

Migration 0091 atomicity:
1. `ALTER TABLE membership_plans ADD COLUMN renewal_tier_bucket text NULL`
2. `UPDATE membership_plans SET renewal_tier_bucket = CASE plan_name WHEN ... END`
3. Verify zero NULL rows: `SELECT COUNT(*) FROM membership_plans WHERE renewal_tier_bucket IS NULL` → must be 0
4. `ALTER TABLE membership_plans ALTER COLUMN renewal_tier_bucket SET NOT NULL`
5. `ALTER TABLE membership_plans ADD CONSTRAINT plan_bucket_valid CHECK (renewal_tier_bucket IN ('thai_alumni','start_up','regular','premium','partnership'))`

### Rationale

- 1:1 mapping is straightforward; no cross-bucket plans in current SweCham roster.
- `Individual` collapses with `thai_alumni` because SweCham's individual tier is small-budget similar to alumni; reminder cadence T-30 / T-14 / T-3 / T+7 fits both.
- NOT NULL constraint enforced post-backfill prevents future plans from shipping without bucket assignment.

### Alternatives Considered

- **Allow NULL bucket → fall back to `regular`**: rejected — silent fallback to wrong cadence is the worst outcome; explicit bucket selection at plan creation forces the chamber to think about cadence.
- **Per-tenant bucket taxonomy**: rejected at Q2 round 1 (option B) — admin overhead too high; fixed buckets simpler.

---

## R10 — Cron-job.org operational pattern

### Decision

Reuse the F4/F5/F7 cron-job.org operational pattern unchanged. Three new cron-job.org jobs configured at staging + production:

| Job name | Endpoint | Cadence | Bearer auth |
|---|---|---|---|
| F8 Renewal Dispatch | `POST /api/cron/renewals/dispatch` | Daily 06:00 Asia/Bangkok | `CRON_SECRET` (shared with F4/F5/F7) |
| F8 At-Risk Recompute | `POST /api/cron/renewals/at-risk-recompute` | Weekly Sunday 02:00 Asia/Bangkok | `CRON_SECRET` |
| F8 Tier-Upgrade Evaluate | `POST /api/cron/renewals/tier-upgrade-evaluate` | Weekly Sunday 03:00 Asia/Bangkok | `CRON_SECRET` |

Each job's runbook entry added to `docs/runbooks/cron-jobs.md` (existing F7 catalogue):
- Setup checklist (cron-job.org dashboard URL + Bearer token + endpoint URL)
- Failure-recovery procedure (manual curl trigger + state reconciliation)
- Secret rotation procedure (shared `CRON_SECRET` rotates atomically across F4/F5/F7/F8; see existing F7 runbook)
- SLO (success rate ≥99% over 30 days; cron-job.org email-on-failure to ops list)

### Rationale

- Hobby plan compatible (Vercel native cron limited to 1×/day; cron-job.org allows 5-min cadence for free).
- Operationally proven across F4 (5 min stale-pending), F5 (5 min stale-pending-count), F7 (5 min broadcasts dispatch + 15 min stuck-sending reconciliation).
- Secret rotation is a single env-var update that all 4 features pick up without code change.

### Alternatives Considered

- **Vercel native cron**: rejected — Hobby plan limit; would force daily-only cadence unsuitable for at-risk + tier-upgrade weekly schedules (those are technically OK at daily, but the precedent of cron-job.org is established and consistent).
- **Self-hosted cron** (e.g., on Neon's compute): rejected — additional infra surface, no benefit at current scale.

---

## R11 — SC-004 baseline measurement methodology (NEW per critique P1 + P14)

### Decision

**Baseline computation formula** (also defines the post-F8 measurement formula — same denominator both periods so the 10pp delta is meaningful):

```
renewal_rate = (members whose RenewalCycle.status === 'completed'
                within expires_at + grace_period_days)
             / (members whose previous-cycle expires_at fell
                within the measurement window)
```

**Pre-F8 baseline source**: SweCham 2024-2025 admin records (Excel + admin invoice records). Computed before /speckit.implement starts. Dataset reconciliation:

1. Extract from F3 `members` table: each member's `joined_at` + paid-invoice history (from F4)
2. For each historical year-cohort (2024, 2025), compute `(renewals_completed_within_grace) / (renewals_eligible)`
3. Document the baseline value (likely 75-85% per industry benchmark) in `specs/011-renewal-reminders/perf-benchmarks.md` as "F8 SC-004 pre-launch baseline" (file created at /speckit.implement Phase 1 setup)

**Post-F8 measurement window**: rolling 90-day window starting day +30 after F8 production go-live (warm-up period).

**Target**: baseline + 10 percentage points within 90 days. If baseline is 80%, target is 90%.

### Rationale

- Without a numeric baseline, SC-004 is unmeasurable vapour (per critique P1 / P14).
- Same formula both periods eliminates bias from changing definition.
- 30-day warm-up acknowledges F8 needs to land + members need to receive at least one full reminder cycle before the metric is meaningful.

### Alternatives Considered

- **Industry benchmark substitute** (assume 75% pre-F8): rejected — too imprecise; SweCham-specific value matters.
- **Same-day measurement post-launch**: rejected — first 30 days is dominated by members whose cycles started pre-F8.

---

## R12 — F4 invoice-paid hook contract (NEW per critique E2; locked at /speckit.clarify Session 2026-05-03 round 3 Q3)

### Decision

**LOCKED: Option A — callback parameter on F4's `markPaidFromProcessor` use-case**.

F4's `markPaidFromProcessor` accepts an optional `onPaidCallbacks: ((evt: F4InvoicePaidEvent) => Promise<void>)[]` parameter populated at composition-root wiring time. F8's composition root pushes a `markCycleCompleteFromInvoicePaid` callback into this array. F4 invokes each callback inside the same DB transaction that persists the invoice state change. If any callback throws, F4 rolls back the entire tx (invoice stays unpaid; cycle stays `awaiting_payment`; F5 webhook handler records the failure for retry per F5's existing reconciliation cron).

```ts
// F4 barrel — extended use-case signature
export async function markPaidFromProcessor(
  ctx: TenantContext,
  input: MarkPaidInput,
  options?: {
    onPaidCallbacks?: ((evt: F4InvoicePaidEvent) => Promise<void>)[]
  }
): Promise<Result<F4InvoicePaidEvent, MarkPaidError>>

// F4InvoicePaidEvent shape (canonical contract)
export interface F4InvoicePaidEvent {
  invoiceId: InvoiceId
  memberId: MemberId
  tenantId: TenantId
  paidAt: Instant
  amountThb: Decimal
  vatThb: Decimal
  paymentMethod: 'stripe_card' | 'stripe_promptpay' | 'bank_transfer' | 'cash' | 'cheque'
  triggeredBy: 'webhook' | 'admin_manual' | 'admin_offline_mark'
}
```

F8's composition root wiring:

```ts
// src/lib/composition-root.ts (or equivalent per project convention)
const f4Barrel = createF4Barrel({
  // ...
  defaultOnPaidCallbacks: [
    (evt) => markCycleCompleteFromInvoicePaid(ctx, evt),  // F8 hook
    // future: F9 timeline hook, etc.
  ],
})
```

**Callback execution semantics (E1-r2 + E2-r2 added at /speckit.critique round 2)**:

- **Per-callback time budget**: each callback in `onPaidCallbacks` MUST execute within p95 < 500ms. Callbacks MUST NOT make external API calls (Resend / Stripe / etc.) inside the F4 transaction — those happen async via a follow-up job dispatched after the tx commits. F8's `markCycleCompleteFromInvoicePaid` writes DB rows (cycle close + reminder cancel + welcome-email queue insert) but defers the actual email send to a post-commit dispatcher. This protects F4 transaction lock contention; long-running callbacks would backlog concurrent F4 cron passes.
- **Multi-callback atomic failure**: all registered callbacks share one transaction. First callback failure rolls back ALL prior callbacks + the F4 invoice mark-paid mutation itself. There is no per-callback retry semantics; if a callback fails, the entire invoice-paid event is treated as not-yet-applied and F5 webhook handler records the failure for retry per F5's existing reconciliation cron. Future callback consumers (F9, F10) MUST be designed accordingly: idempotent + fast + DB-write-only.
- **Callback ordering**: callbacks fire in registration order; earlier callbacks see earlier-registered DB writes within the tx. Document any inter-callback dependencies in the composition-root comment.

### Rationale

- Atomic guarantee — preserves FR-023 intent that cycle complete + invoice paid + receipt email enqueue + reminder cancel happen in one DB transaction. Eliminates the "invoice paid but cycle still awaiting_payment" inconsistency window that Option B would allow.
- Smallest F4 contract change (~10 lines + 1 contract test asserting callback fires exactly once per state-transition).
- F8/F4 coupling stays at composition-root level only — no shared infra (no pub-sub bus, no Redis dependency, no EventEmitter).
- Testable: F8 unit tests mock the callback parameter directly; F4 contract test asserts callback is invoked + rollback on callback failure.
- Locked at /speckit.clarify Session 2026-05-03 round 3 Q3.

### Alternatives Considered (rejected)

- **Option B (audit-event listener)**: rejected — eventually consistent (separate tx for cycle advance), risks "paid but not renewed" inconsistency window, breaks FR-023 atomic guarantee.
- **Option C (new domain-event bus infra)**: rejected — over-engineering at MVP; no second consumer yet; YAGNI per Constitution Principle X.
- **Option D (F8 polls F4 invoices)**: rejected — wasteful + 5-min lag + no atomic recovery semantics.

### Implementation note

F4's `markPaidFromProcessor` change is a small additive PR (~10 lines + 1 contract test). Coordinate via plan.md Complexity Tracking entry #3. F8's `markCycleCompleteFromInvoicePaid` use-case implements the callback per FR-023 atomic semantics.

### Rationale

- F4's invoice-paid event is the canonical trigger for F8 cycle completion (FR-023). Without a hook, F8 must poll F4 invoices for state changes — wasteful + introduces lag.
- Option A keeps the cycle-complete + invoice-paid mutation atomic — eliminates "paid but not yet renewed" inconsistency window.
- Option B is fallback if F4 maintainer prefers not to extend `markPaidFromProcessor` signature.

### Alternatives Considered

- **F8 polls F4 invoices**: rejected — wasteful + lag.
- **F4 calls F8 use-case via barrel**: equivalent to Option A.
- **Database trigger on `invoices` UPDATE**: rejected — Postgres triggers cannot easily call back into application code; defeats Clean Architecture (Principle III).

### Implementation note

F4's `markPaidFromProcessor` change is small (~10 lines + 1 contract test). Coordinate via plan.md Complexity Tracking entry #3.

---

## R13 — F2 scheduled-plan-change use-case (NEW per critique E3)

### Decision

**Coordinate with F2 maintainer**: F2's barrel gains a new use-case `applyScheduledPlanChange(memberId: MemberId, options: { effectiveAtCycleId: CycleId, newPlanId: PlanId, scheduledByUserId: UserId })`. Stored in a new F2 table `scheduled_plan_changes` (member, effective_at_cycle_id, new_plan_id, scheduled_by_user_id, scheduled_at, applied_at?, status).

Flow at F8 tier-upgrade acceptance time:

1. F8 `accept-tier-upgrade.ts` calls F2 `scheduleNextRenewalPlanChange(memberId, {effectiveAtCycleId, newPlanId})`
2. F2 INSERTs into `scheduled_plan_changes` (status `pending`)
3. At F4 renewal-invoice-creation time (E2 hook fires), F4 calls F2 `getEffectivePlanForRenewal(memberId, cycleId)` which returns the scheduled plan if a `pending` row exists for that cycle, else the current plan
4. F4 issues invoice at the resolved plan's price
5. After F4 invoice paid (E2 hook fires again on success), F2 transitions the `scheduled_plan_changes` row to `applied` and updates `members.plan_id` atomically
6. F8 listens for the apply event and transitions the suggestion to `status = 'applied'`

If the member's plan changes manually between accept and renewal (P5/E19 race), F2 emits a `member_plan_manually_changed` event; F8 listens and transitions the suggestion to `superseded`.

### Rationale

- F8's tier-upgrade pending semantics require F2 awareness of "effective at next cycle" timing. F2's existing `changeMemberPlan` is immediate-only.
- Storing scheduled changes in F2's table (not F8's) keeps the plan-management invariants in F2's bounded context.
- F4 reading effective plan at invoice time keeps the invoice price authoritative.

### Alternatives Considered

- **F8 stores the pending plan change**: rejected — F2 owns plan-related state; F8 stores only the "suggestion" envelope.
- **F8 calls F2 immediate `changeMemberPlan` at F4 invoice time**: feasible but couples the timing of plan change to invoice creation; misses the case where invoice is rolled back post-creation.

### Implementation note

F2 barrel addition + new `scheduled_plan_changes` table + 2 use-cases (schedule + apply). Add to plan.md Complexity Tracking entry #4.

---

## R14 — Per-tenant cron fan-out coordinator (NEW per critique X1)

### Decision

**Replace single-handler-iterates-all-tenants pattern with a coordinator + per-tenant fan-out**:

1. cron-job.org calls a coordinator endpoint `/api/cron/renewals/dispatch-coordinator` (daily 06:00 Asia/Bangkok)
2. Coordinator endpoint reads `tenants WHERE active = TRUE` (fast — small table) and for each tenant, enqueues per-tenant work
3. Per-tenant work mechanism options (chosen at implementation time, all serverless-compatible):
   - **Option A**: Coordinator triggers an internal HTTP call (`fetch`) to `/api/cron/renewals/dispatch/[tenantId]` with `Authorization: Bearer <CRON_SECRET>` (via Node `fetch` to the same Vercel deployment). Each per-tenant invocation gets its own 300s budget. Coordinator returns 200 after all tenants enqueued (~1s). RECOMMENDED for MVP.
   - **Option B**: Coordinator INSERTs into a `cron_work_queue` table; per-tenant workers polled by separate cron-job.org jobs (`/api/cron/renewals/dispatch-worker`). More complex but resilient to coordinator failure.
   - **Option C**: Vercel Queues (per active session-start vercel knowledge update — public beta). Coordinator publishes per-tenant work; queue infra fans out. Most operationally clean but adds Vercel Queues dependency.
4. Each per-tenant invocation runs the existing 60s/tenant SLO (FR-017) within its own 300s function budget — well under the ceiling.
5. Coordinator emits `cron_dispatch_orchestrated` audit with `{tenants_enqueued, duration_ms}` for visibility.
6. If a per-tenant invocation fails, coordinator's audit doesn't roll back; on next-day pass the failed tenant's pass retries naturally (idempotency per FR-011).

Apply same pattern to:
- `/api/cron/renewals/at-risk-recompute-coordinator` → `/api/cron/renewals/at-risk-recompute/[tenantId]` (weekly Sun 02:00)
- `/api/cron/renewals/tier-upgrade-evaluate-coordinator` → `/api/cron/renewals/tier-upgrade-evaluate/[tenantId]` (weekly Sun 03:00)

Tenant count cap: at 50 tenants the coordinator's parallel-fetch fan-out completes in ~1-2 seconds (HTTP-call overhead is the bottleneck; not actual work). At 500 tenants the coordinator may want to batch into 50-tenant chunks. MVP target is 50 tenants; revisit if SaaS growth pushes past that.

### Rationale

- **Single Vercel function cannot finish 50-tenant cron pass within 300s** (per active session-start vercel knowledge update — default function timeout is 300s on all plans). Per-tenant SLO 60s × 50 tenants = 3000s = 50 minutes; orders of magnitude over the cap.
- Per-tenant fan-out lets each tenant's work run in its own function instance with its own 300s budget.
- Option A (HTTP-call fan-out) is the simplest serverless-native pattern and requires zero new infrastructure (no queue, no worker process, no DB queue table).
- Pattern is idempotent and self-healing: if a per-tenant invocation fails, next-day cron picks it up naturally.

### Alternatives Considered

- **Single handler iterates all tenants**: original plan; rejected per critique X1 — exceeds 300s timeout at SaaS scale.
- **External worker process** (e.g., on Render): rejected — adds infrastructure for what Vercel functions handle natively at the tenant level.
- **Increase Vercel timeout to 800s** (Pro plan support): rejected — even 800s is insufficient at SaaS scale (300+ tenants × 60s = 18000s).

### Implementation note

Update FR-017 + FR-036 + FR-057 in spec.md. Update plan.md SLO budgets (per-tenant unchanged, total-pass coordinator-bounded). Update contracts/cron-renewals-api.md to reflect coordinator + per-tenant endpoints. Add audit event `cron_dispatch_orchestrated` to taxonomy.

---

## R15 — F8 scope completeness + production go-live policy (REVISED v3 by maintainer 2026-05-03)

### Decision

**F8 ships complete in scope within this branch** — every US (US1–US6), every FR, every UI surface (admin pipeline · at-risk widget · tier-upgrade queue · escalation task list · member self-service renewal flow · preferences page · schedule-policy editor · tenant settings), every backend use-case, every cron job, every audit event, every test — all merged + verified in staging end-to-end before the F8 PR merges.

**Production go-live (= chamber starts using the system)** is a separate operational decision:

1. F8 ships **dark** in production (`FEATURE_F8_RENEWALS=false`) when the F8 PR merges
2. F8 stays dark while remaining MVP work (F6 + F9 + R6 folder rename + Phase 5B polish) lands
3. When **the entire planned MVP is complete + stable in staging**, the kill-switch is flipped on for ALL features simultaneously (single coordinated cutover) using Vercel Rolling Releases 10% → 50% → 100%
4. Chamber begins using the system at that flip — first-time exposure to the full Chamber-OS surface

Why a single coordinated cutover rather than per-feature go-live:

- Chamber-OS has zero existing end-users today (chamber still uses Excel). There is no "in-flight users" to protect with staged rollout.
- Per-feature go-live would force chamber admin to learn surfaces incrementally + re-train on each new ship — operationally worse than a single onboarding event.
- Single-cutover lets the chamber experience a complete, consistent product on day one (matches `docs/smart-chamber-features.md` § 3 design intent of unified admin shell).

### Rationale

- The earlier critique X2 / R15 v1 suggestion to "ship pipeline-only at launch with UI placeholders for at-risk + tier-upgrade + tasks" assumed Chamber-OS was already live for chamber adoption (with users to protect via staged rollout + baseline data to capture). **Maintainer clarified 2026-05-03: this assumption is wrong** — Chamber-OS has no live chamber users; the MVP will go live as one event when everything is ready. Therefore the staged-rollout reasoning does not apply.
- F8 scope completeness in this branch is the right unit of work because: F8 is shipped + tested as one feature; future maintenance treats F8 as one feature; reverting F8 is one operation; the F9 admin shell is a separate concern that hosts F8 surfaces consistently.

### Alternatives Considered

- **Pipeline-only ship + UI placeholders + flip surfaces with F9** (R15 v1, X2 remediation): rejected by maintainer 2026-05-03. Reasoning was based on incorrect assumption that Chamber-OS is live with end-users.
- **Per-feature production flip after each F merges** (Option A from maintainer's clarification table): rejected — chamber would experience incremental UI churn with each ship; single onboarding event is operationally simpler.
- **Ship F8 production-on (kill-switch true) immediately at merge**: rejected — chamber not ready to adopt; would expose unfinished surrounding context (no F9 admin shell, no audit viewer for compliance review, no R6 rename).

### Implementation note

A12 in spec.md updated to v3. plan.md `## Predecessors` production gate paragraph updated. Quickstart §8 production rollout updated to reflect single-cutover model.

---

## R16 — Token secret rotation procedure (NEW per critique E9)

### Decision

Adopt **dual-key rotation pattern** (mirrors F1 session secret rotation):

- Two env vars: `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (current) and `RENEWAL_LINK_TOKEN_SECRET_FALLBACK` (previous, retained during rotation window)
- Verifier tries `PRIMARY` first; on MAC mismatch, tries `FALLBACK`. If `FALLBACK` succeeds, the token is treated as valid AND the audit event includes `{used_key: 'fallback'}` for observability.
- Rotation procedure (~30-day window):
  1. Generate new secret: `openssl rand -base64 32`
  2. Set `RENEWAL_LINK_TOKEN_SECRET_FALLBACK = <current value>` in Vercel env
  3. Set `RENEWAL_LINK_TOKEN_SECRET_PRIMARY = <new value>`
  4. Redeploy
  5. New tokens issued during the window are signed with the new PRIMARY
  6. Old tokens (issued in the last 30 days before rotation) still verify against FALLBACK
  7. After 30 days, remove FALLBACK
- Single env var at steady state: only `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` is required when no rotation is in progress (FALLBACK is optional and only set during the rotation window)

### Rationale

- Single-secret rotation invalidates all in-flight tokens at the moment of swap → members clicking T-30 emails would see "invalid token" page → support load + bad UX.
- Dual-key rotation lets old tokens continue working through their natural TTL (30 days) while new tokens use the new key.
- Mirrors F1 session secret rotation pattern (already documented in `docs/runbooks/secret-rotation.md`).

### Alternatives Considered

- **Single secret with hard rotation**: rejected — invalidates in-flight tokens.
- **Token-version-prefix in payload** (e.g., `v2.<payload>.<mac>` after rotation): rejected — complex; needs schema migration on each rotation.
- **Quarterly mandatory rotation**: deferred to operational policy (not encoded in spec; see runbook).

### Implementation note

Add to `docs/runbooks/secret-rotation.md` (extends existing F1 secret rotation runbook). Update `src/lib/env.ts` to validate both env vars with FALLBACK optional. Update `src/modules/renewals/infrastructure/tokens/hmac-renewal-link-verifier.ts` to attempt both keys.

---

## R17 — Cron-secret leak threat model + Bearer-auth-rejection audit (NEW per /speckit.checklist security gap CHK029)

### Decision

`CRON_SECRET` (shared across F4/F5/F7/F8 cron jobs) leak threat model + mitigation:

**Attack surface**:
- Secret leaks via env-var dump (compromised Vercel env or insider)
- Secret leaks via cron-job.org config UI compromise
- Secret leaks via deployment log accidentally including header

**Mitigations (defence in depth)**:

1. **Bearer-auth rejection on EVERY cron handler**: missing OR malformed OR mismatched header → 401 + audit event `cron_bearer_auth_rejected` with `{route, ip_hash, attempted_token_prefix_8chars, attempted_token_length}` (NEVER log the full attempted token; prefix-8 + length is enough for forensic correlation without secret exposure).
2. **Rate limit on 401 responses per source IP**: 10 failed-auth attempts per IP per 5 minutes → 429 (prevents brute-force; legitimate cron-job.org sends 1 valid request per scheduled tick). Implemented at Upstash rate-limiter layer (existing F1 infrastructure).
3. **Secret rotation procedure** (extends existing F4/F5/F7 pattern): rotation schedule = quarterly OR on suspected compromise; procedure documented in `docs/runbooks/secret-rotation.md`:
   - Generate new secret: `openssl rand -base64 32`
   - Set new value in BOTH Vercel env AND cron-job.org config — atomic-ish (small window of mismatch tolerated by retry; legitimate cron retries within 5 min naturally)
   - Old secret immediately revoked; previous successful run is the canonical confirmation
   - On suspected compromise: rotate immediately; review audit log for `cron_bearer_auth_rejected` events from non-cron-job.org IPs in past 30 days
4. **Alert rule on `cron_bearer_auth_rejected` spike**: >10 events in 1 hour from any single IP → page security on-call (extends FR-056 alert rules). Distinguishes "cron-job.org temporarily misconfigured" (resolves within minutes) vs "active brute-force" (sustained).
5. **No fallback "weak Bearer" mode**: 401 always; never accept session cookie or other auth scheme on cron endpoints (defence against confused-deputy + accidental same-origin POST).

### Rationale

- Constitution Principle I (Data Privacy & Security NON-NEGOTIABLE) requires explicit mitigation for known attack vectors on shared secrets.
- F4/F5/F7 already use shared `CRON_SECRET` with identical Bearer-auth pattern; F8's threat-model addition propagates back to those features as a unified runbook.
- Audit event `cron_bearer_auth_rejected` is forensic-friendly without leaking secret material.

### Alternatives Considered

- **Per-feature cron secrets** (F8-only `CRON_SECRET_F8`): rejected — multiplies env vars + rotation surface; no security benefit at current scale (single solo maintainer rotates all four together anyway).
- **mTLS between cron-job.org and Vercel**: rejected — cron-job.org doesn't support mTLS; would require migrating to a different cron provider; out-of-scope for F8.
- **OAuth2 client-credentials flow**: rejected — over-engineering at MVP; static Bearer is industry-standard for service-to-service cron.

### Implementation note

- Update `src/lib/env.ts` zod schema: `CRON_SECRET` minimum 32 bytes (already enforced) + add boot-time check that the value is NOT a default placeholder.
- Add Upstash rate-limit bucket for cron `401` responses.
- Add audit event `cron_bearer_auth_rejected` to F8 taxonomy (now 58 total events).
- Document rotation procedure in `docs/runbooks/secret-rotation.md` (extends existing F1 secret rotation runbook).

---

## Summary

All 17 research areas have a documented decision + rationale + alternatives. No outstanding NEEDS CLARIFICATION items. R8 revised (synchronous in-process invocation per critique E1). R11–R16 added per critique findings P1/P14, E2, E3, X1, E17/X2, E9. R17 added per /speckit.checklist security gap CHK029 (cron-secret leak threat model). R5 expanded for F6 stub-port contract assertion (CHK025). R12 expanded for F1 transactional Resend retry budget alignment (CHK016). R1 expanded for token-re-issuance semantics (CHK033). Ready for Phase 1 design re-confirmation.

**Next**: spec.md FRs/SCs/audit-events updated to reflect research changes; plan.md Complexity Tracking entries #3 + #4 added; contracts/cron-renewals-api.md restructured for coordinator + per-tenant fan-out; checklists `[Gap]` markers flipped to `[Spec §FR-…]` references after gap-resolution writes.
