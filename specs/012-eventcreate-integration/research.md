# Phase 0 Research: F6 — EventCreate Integration

**Branch**: `012-eventcreate-integration` | **Date**: 2026-05-12

This document consolidates the research decisions that resolve the Technical Context's unknowns and justify the dependency / pattern choices in `plan.md`. Each section follows the **Decision → Rationale → Alternatives considered** structure mandated by the Spec Kit Phase 0 template.

The base research consumed inputs from `docs/event-integration-analysis.md` (the original feature scoping doc), `docs/saas-architecture.md` (multi-tenancy strategy), `docs/membership-benefits-analysis.md` (Partnership + Corporate quota definitions), `docs/observability.md` § 14 (metrics + alerts conventions), and the in-repo precedents from F1–F8 (especially F5's webhook receiver + F7's webhook receiver + F8's adapter-port pattern). No external web fetches were required for v1 of this plan beyond the EventCreate + Zapier capability research already captured in `docs/event-integration-analysis.md` § 2.

---

## R1 — EventCreate integration surface: Zapier-mediated webhook is the only path

**Decision**: F6 ingests EventCreate data exclusively via Zapier-mediated HTTP POST webhooks signed with a per-tenant HMAC-SHA256 secret. Each chamber tenant owns its own EventCreate account, configures its own Zap, and points the Zap's "Webhooks by Zapier" action at a tenant-specific URL on Chamber-OS.

**Rationale**:

1. EventCreate **does not expose a public REST or GraphQL API** (confirmed via `docs/event-integration-analysis.md` § 2 research consolidated 2026-04-11). There is no developer documentation, no API key issuance path, and no native webhook surface for third-party developers.
2. Zapier is EventCreate's **only documented programmatic integration** — they ship two triggers (`New Attendees Registered` and `New Purchase Complete`) and 8,000+ downstream actions including "Webhooks by Zapier" which lets us point at any HTTPS endpoint.
3. Zapier's free-tier 15-minute polling cadence is **acceptable for chamber events** — registration latency tolerance for membership-benefit accounting is hours, not seconds. Paid Zapier tiers offer faster polling for tenants who want it.
4. The HMAC + timestamp + idempotency-key envelope is industry-standard (Stripe, Slack, GitHub all use the same pattern) and gives us a fully audit-loggable, replay-resistant ingest path even though Zapier itself is a black-box middleware.

**Alternatives considered**:

- **Direct EventCreate API**: rejected — does not exist.
- **Scraping EventCreate landing pages**: rejected — fragile, ToS-violating, and EventCreate is the chamber's authoritative source so any divergence is the chamber's data, not ours.
- **CSV-only import (no webhook)**: rejected — defeats the automation goal; admin would still re-key data manually. CSV is now repositioned as **first-class ingest** for non-EventCreate tenants AND backfill/outage-recovery for EventCreate tenants (Session 2026-05-12 round 3 Q1).
- **Self-hosted Zap (e.g., n8n)**: rejected for v1 default path — adds operational surface compared to tenant-owned Zapier accounts that work today. **However, n8n / Make.com is the documented middleware-swap contingency** if Zapier deprecates the EventCreate trigger (see Supply-chain risk section below).

**Supply-chain risk — Zapier deprecation contingency (E21)**:

F6's webhook ingest path depends on Zapier maintaining its EventCreate trigger. Zapier has retired third-party app integrations before with ~6-month notice (lower-traffic apps periodically lose integration support when the app vendor stops investing in the Zapier partnership). If Zapier deprecates the EventCreate trigger, F6's primary ingest path breaks for all EventCreate tenants.

**Three-layer graceful degradation strategy** (committed at Session 2026-05-12 round 3 Q5):

1. **Primary (today)**: Zapier → F6 webhook. Active ingest path; no migration needed.
2. **Middleware-swap fallback**: Tenant reconfigures the same automation in **n8n (self-hosted)** or **Make.com (formerly Integromat)**. Both tools support the EventCreate trigger (or equivalent polling via EventCreate's HTML/JSON RSS feeds + custom HTTP module) AND outbound HTTP POST with computed HMAC headers — the F6 webhook contract is industry-standard. **Zero F6 code change required** because the inbound contract is unchanged; only the tenant-side middleware identity changes. The integration config wizard's walkthrough section adds a "Using an alternative middleware?" expandable panel (deferred to F6.1 — until Zapier actually deprecates, the Zapier walkthrough is sufficient).
3. **Ultimate fallback**: CSV upload (US5). Now first-class per round 3 Q1, so tenants can switch ingest mode without losing the membership-side automation. Latency degrades from ~15 min (Zapier) to manual-CSV-upload cadence, but data integrity is preserved.

**Rejected contingencies**:

- **Build native EventCreate scraper**: rejected by R1 — no public API; HTML scraping is fragile and ToS-risky.
- **Pressure EventCreate to add native webhooks**: not in our control; cannot be relied upon as a contingency.
- **Migrate tenants to a different event SaaS**: out of our control; tenant relationship + investment in EventCreate is theirs.

This supply-chain risk is **documented openly** so future maintainers understand the dependency and the migration paths. If Zapier deprecation becomes imminent (e.g., 90-day notice), the maintainer triggers a contingency runbook (`docs/runbooks/eventcreate-zapier-deprecation-response.md`, to be authored at `/speckit.checklist` gate IF Zapier announces) that covers per-tenant Zap-to-n8n migration steps.

---

## R2 — Webhook signature scheme: HMAC-SHA256 + 5-min timestamp + request-ID idempotency

**Decision**: Each webhook delivery carries three headers — `X-Chamber-Signature` (HMAC-SHA256 hex of `timestamp.body` with tenant secret), `X-Chamber-Timestamp` (Unix seconds, ±300s tolerance), `X-Request-ID` (Zapier-generated UUID, idempotency key). Verification uses `crypto.timingSafeEqual` from the Node standard library against both the active secret and (if present, within 24h) the grace secret. All non-success paths return identical generic 401 bodies to avoid signature oracles.

**Rationale**:

1. **HMAC-SHA256** is the de-facto webhook auth standard (Stripe, GitHub, Slack, Twilio, SendGrid). Already taught to the maintainer via F5's Stripe webhook implementation.
2. **5-minute timestamp window** is the industry default (Stripe uses 5 min; GitHub uses 5 min; AWS Sig v4 uses 5 min). Wide enough to absorb clock skew between Zapier's data centre and Vercel `sin1`; narrow enough that captured-and-replayed deliveries from a long-stored MITM cannot still verify.
3. **`X-Request-ID` as idempotency key** with 7-day Redis-backed dedup: Zapier guarantees a stable UUID per Zap trigger event and retries on transient HTTP 5xx. The 7-day window covers Zapier's max retry horizon.
4. **`crypto.timingSafeEqual`** prevents timing-attack sidechannels. Naive `===` comparison leaks one byte per CPU cycle in worst case.
5. **Generic 401 body on all failure modes** prevents oracles (an attacker probing different secrets / timestamps / payloads should not be able to distinguish "wrong secret" from "old timestamp" from "tampered body"). Audit log captures the discriminated outcome for forensic use.
6. **`timingSafeEqual` length-check + try/catch wrapper (E8)** — Node's `crypto.timingSafeEqual` **throws** (not returns false) if the two buffers are different lengths. Practical attack vector: an attacker sends a truncated or oversized `X-Chamber-Signature` value → `timingSafeEqual` raises → unhandled error → HTTP 500 (information leak: "the server crashed on this input"). Mitigation: in `verify-webhook-signature.ts`, normalise the input first (strip `sha256=` prefix; validate hex format; assert exact 64-char hex length for SHA-256), then construct the comparison buffer; wrap the `timingSafeEqual` call itself in `try { … } catch { return rejected }` as defence-in-depth. Unit tests MUST cover: (a) missing `sha256=` prefix, (b) wrong-length signature (too short), (c) wrong-length signature (too long), (d) non-hex characters, (e) header completely missing — all return `webhook_signature_rejected` with identical 401 generic body.

**Webhook secret threat model (E9)**: the active secret is stored as plaintext TEXT in `tenant_webhook_configs.webhook_secret_active`. Neon encrypts the column at rest (AES-256, GCM-mode) so a stolen disk snapshot cannot read it. Live-database attackers (SQL injection, leaked credentials, malicious insider with `swecham_app_rw` role) **can** read the raw secret and use it to sign fake webhooks. Mitigations: (a) the application-layer parameterised-query discipline (Drizzle) + ESLint rules eliminate SQL injection vectors; (b) DB credential rotation is part of the standard ops runbook (`docs/runbooks/`); (c) the 24h grace window (FR-008) lets us rotate quickly on suspected compromise; (d) signature-rejection burst alert (research.md R10 alert #1) detects fake-signed traffic AFTER the rotation forces the attacker into the old grace key. Industry pattern (Stripe, GitHub) is the same — webhook secrets are raw at rest by necessity (HMAC requires the key in the clear). Recommend documenting this trade-off in `security.md` (not yet authored for F6; create at `/speckit.checklist` gate).

**Alternatives considered**:

- **JWT-Bearer in `Authorization` header**: rejected — JWT adds parser-surface attack class (CVE-2015-9235 et al.), and the symmetric-secret HMAC case is exactly the use case HMAC-SHA256 webhook auth is designed for. JWT is over-built here.
- **mTLS client certificates**: rejected — Zapier does not expose certificate management in their Webhooks-by-Zapier action.
- **Plain shared-secret in body or header (no signature over body)**: rejected — allows body tampering after credential capture.
- **No timestamp window (signature-only)**: rejected — opens long-window replay attacks.
- **No idempotency key (rely on attendee-externalId only)**: rejected — Zapier's retry behaviour is at the HTTP level (same `X-Request-ID`); de-duping at the attendee-externalId layer alone would still double-process a Zapier retry that arrives after we crashed but before we durably persisted the attendee row.

---

## R3 — Idempotency store: F6-owned `eventcreate_idempotency_receipts` table

**Decision** (revised round-2 critique 2026-05-12 — see `critiques/critique-20260512-123940-round2.md` M2): F6 introduces its own idempotency table `eventcreate_idempotency_receipts(tenant_id TEXT, source TEXT, request_id TEXT, processed_at TIMESTAMPTZ, ttl_expires_at TIMESTAMPTZ, PRIMARY KEY(tenant_id, source, request_id))` with RLS+FORCE policies + partial TTL-cleanup index + dedicated daily TTL-sweep cron. The `source` column carries the discriminator `'eventcreate_webhook'` or `'eventcreate_csv'` (CHECK constraint). Migration 0134 creates this F6-owned table. See data-model.md § 1.4 for the full DDL.

**Rationale**:

1. **Schema impedance prevents reusing F5's `processor_events`** — F5's idempotency mechanism is `processor_events` (specs/009-online-payment/data-model.md:231), whose PK is the Stripe event id `evt_…` and whose columns are shaped for Stripe payloads (signature_version, api_version, livemode, etc.). EventCreate request IDs cannot fit the Stripe-event-id shape, and the Stripe-specific columns would be NULL waste for F6 rows. Reuse is not viable without a significant cross-feature schema generalisation.
2. **Bounded-context discipline** — Constitution Principle III (Clean Architecture) favours per-feature data ownership. F4 owns invoicing tables; F5 owns payment + processor_events tables; F7 owns broadcast tables; F8 owns renewal tables. F6 owning its own idempotency-receipts table maintains this pattern.
3. **Atomic with strict-transactional ACID unit** — the receipt INSERT lives in the same Drizzle transaction as the side effects (FR-037), so rollback drops the receipt cleanly and Zapier retry-after-recovery correctly succeeds. This is the same in-tx idempotency model F5 uses for `processor_events`.
4. **Operational containment** — at design envelope (~50k webhooks/yr + ~10k CSV rows/yr), the table grows to ~10k rows/yr/tenant before sweep. A daily TTL-sweep cron (`/api/internal/retention/sweep-eventcreate-idempotency`, see R9 multi-tenant sweep pattern) keeps it bounded at ~200 rows in flight. Cron handler iterates tenants via super-admin enumeration → `runInTenant` per tenant — same pattern as the pseudonymisation sweep.
5. **Future generalisation path is preserved** — if a 4th integration arrives (Eventbrite native webhook, etc.) and three independent feature-owned idempotency tables become operationally burdensome, a future migration can generalise into a shared `webhook_idempotency_receipts` table. Until then, per-feature ownership has lower complexity than a premature shared table.

**Alternatives considered**:

- **Reuse F5's `idempotency_receipts` table** (the round-1 plan): rejected at round-2 critique because **F5 does not have an `idempotency_receipts` table** — F5's `processor_events` is Stripe-specific (PK=stripe_event_id, columns shaped for Stripe). The original plan was based on a phantom-artefact reference; the "reuse" approach was never viable.
- **Generalise F5's `processor_events` into a shared `webhook_idempotency_receipts`**: rejected for v1 — touches F5 code + migrations + tests; large blast radius for marginal benefit at 3-integration scale. Revisit if a 4th integration arrives.
- **In-memory Upstash key (no DB)**: rejected — would mean the idempotency check is outside the strict-transactional ingest path (FR-037), introducing a race where the receipt is recorded before the underlying tx commits. Postgres-backed idempotency lets the receipt live in the same tx as the side effects.
- **Stripe-Idempotency-Key-style "request-deduplication only on success"**: rejected — Zapier-side retries on 5xx need to be no-op on retry even if the original request succeeded; only a "wrote-once" semantic gives us that.

---

## R4 — Attendee → member matching: 4-rule cascade with hand-rolled fuzzy

**Decision**: Match attempts proceed in deterministic order: (1) exact `LOWER(contacts.email)` match, (2) email-domain match against `members.email_domain` (skip if email's domain is on the personal-email deny list), (3) fuzzy normalised-company-name match (Levenshtein ≤ 3 against tenant members), (4) `match_type = 'non_member'`. Ambiguous fuzzy matches (>1 winner) set `match_type = 'unmatched'` for admin relink. Implementation is hand-rolled domain logic in `src/modules/events/domain/`.

**Rationale**:

1. **Rule ordering is determinism-critical** — the same attendee row across two ingest passes must produce the same `match_type` (audit replayability + acceptance tests reproducible). Exact-email > domain > fuzzy is the canonical specificity ordering.
2. **Personal-email deny list (gmail/yahoo/hotmail/outlook/icloud)** prevents the long tail of `jane.andersson@gmail.com` matching against a tenant where one member's CEO happens to also be `someone@gmail.com`. Domain matching gives false positives at huge volume there; we skip rather than match.
3. **Hand-rolled Levenshtein** — for the design envelope (<2k members per tenant), a 40-line `levenshtein(a, b)` function with the standard two-row DP table is O(|a| × |b|) ≈ a few µs per pair; running over <2k members is sub-millisecond. No library dependency, no maintenance, fully testable. F3 already established the pattern of pure-TS domain utilities in `src/modules/*/domain/`.
4. **Ambiguous fuzzy → unmatched (not auto-pick)** — the cost of a wrong auto-pick is a wrong quota decrement against the wrong member (silent quota-leak). The cost of `unmatched` is one admin click. Asymmetric — choose the lower-impact wrong default.

**Alternatives considered**:

- **`fuse.js` / `string-similarity` library**: rejected — adds maintenance + supply-chain surface for a <100-line function the project will own end-to-end. Revisit at >2k-member tenant scale if match latency becomes an issue.
- **Postgres `pg_trgm` extension fuzzy match** (F3 uses it for search): considered. Rejected for v1 because the match logic must run inside the strict-transactional ingest (FR-037), and pushing fuzzy logic into SQL adds a join + GIN-index plan dependency that's harder to unit-test. May reconsider if SC-002 (≥95% match rate) is missed in real data and the heuristic needs more sophistication.
- **ML similarity (sentence-transformer embedding)**: rejected — premature, expensive, hard to audit ("why did the model link this attendee?" is a PDPA Section 32 / GDPR Article 22 obligation we don't want to take on).
- **Skip rule 3 entirely (only exact email + domain)**: considered. Rejected because it would degrade match rate on attendees who register with a personal email but identify a chamber-member company in EventCreate's `company_name` field — common case at chamber events.

---

## R5 — Quota accounting: read-from-F2 at-ingest, advisory-lock + computed-on-read

**Decision**: At ingest time, the use-case `apply-quota-effect.ts` (a) acquires a tenant-scoped Postgres advisory lock keyed by `(tenant_id, matched_member_id, event_id)` to serialise concurrent quota decisions for the same logical seat-allocation, (b) queries the matched member's currently-active plan via F2's barrel function `getMemberPlanForBucket(memberId)` (introduced in F8 for renewal evaluation) to read the partnership-per-event allotment (Diamond 6 / Platinum 4 / Gold 2) for partner-benefit events and the cultural-annual allotment (Premium 2 / Large 1) for cultural events, (c) computes the **currently-consumed count from `event_registrations` rows** (`SELECT count(*) FROM event_registrations WHERE matched_member_id = X AND event_id = Y AND counted_against_partnership = true` for partnership; `… WHERE counted_against_cultural_quota = true AND extract(year FROM events.start_date) = Y` for cultural), (d) writes the new registration row with `counted_against_* = (consumed_count < allotment)`, (e) emits the corresponding audit event, (f) commits — releasing the advisory lock automatically at tx-end.

**Quota state model**: there is **no stored counter**. The source of truth is `SUM(counted_against_partnership) WHERE matched_member_id = X AND event_id = Y` (and the cultural analogue). Concurrent writers cannot race because the advisory lock at step (a) serialises every quota decision for the same `(tenant, member, event)` tuple — only one tx at a time computes-and-decides.

**Advisory-lock namespace**: `pg_advisory_xact_lock(hashtextextended('eventcreate-quota:' || tenant_id || ':' || matched_member_id || ':' || event_id, 0))`. The `'eventcreate-quota:'` prefix namespaces it **disjoint** from F4 (`'invoicing:'`), F5 (`'payments:'`), F7 (`'broadcasts:'`), and F8 cron coordinator locks — zero cross-feature contention. Lock is released automatically at tx end (commit OR rollback per FR-037).

**Canonical SQL execution order** (RLS context-binding MUST happen before advisory lock so the lock is acquired under the correct tenant context):

```sql
BEGIN;
SET LOCAL app.current_tenant = $tenantId;   -- (1) RLS bind FIRST — every query in this tx will be tenant-scoped
SELECT pg_advisory_xact_lock(                -- (2) THEN acquire the advisory lock under that tenant context
  hashtextextended(
    'eventcreate-quota:' || $tenantId || ':' || $memberId || ':' || $eventId,
    0
  )
);
-- (3) read plan + read consumed-count + insert idempotency receipt + upsert event + insert registration + decide quota
INSERT INTO eventcreate_idempotency_receipts (...) ON CONFLICT DO NOTHING RETURNING request_id;
INSERT INTO events (...) ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET (...) RETURNING event_id, archived_at;
INSERT INTO event_registrations (...) RETURNING registration_id;
-- (4) emit audit event
INSERT INTO audit_log (event_type, tenant_id, payload, summary, ...) VALUES (...);
COMMIT;                                       -- (5) advisory lock + RLS binding both released atomically
```

`runInTenant(ctx, fn)` opens a fresh connection (or a connection from the pool with `SET LOCAL` issued at the top of the tx), so advisory locks are session-isolated per Postgres advisory-lock semantics — adversarial cross-tenant lock probes would fail tenant-resolution earlier in the route handler and never reach the lock acquisition.

**Rationale**:

1. **Single tx with registration insert** — FR-037 requires strict ACID; quota decision and registration row commit together or roll back together. Drift across rows impossible by construction.
2. **Read F2 plan at ingest time (not write-time)** — captures the member's plan **as of the event**, audit-correct historical snapshot. Future member plan upgrades/downgrades don't retroactively alter past events.
3. **Advisory lock + computed-on-read (not `FOR UPDATE` on a stored counter)** — there is no stored counter to lock. A computed-on-read counter cannot use row-level locks for serialisation; the advisory lock is the correct primitive. This matches the F5 TOCTOU guard pattern (different lock namespace, same conceptual mechanism).
4. **No stored counter** — `SUM(counted_against_*)` on demand is the canonical source. Drift impossible: archive/refund/relink credit-back all flip the same boolean column the SUM reads. The query cost is bounded by the per-event partial index `event_registrations(tenant_id, matched_member_id) WHERE matched_member_id IS NOT NULL` (data-model § 1.2) — sub-millisecond at design envelope (≤500 attendees per event).
5. **Property-based test for SC-004's 0-error promise** — F6 includes `tests/integration/events/quota-concurrency.test.ts` using `fast-check` (existing F4/F8 devDep, no new dep): spawns N=10 concurrent ingest workers against the same `(tenant, member, partner-benefit-event)` with a 6-ticket allotment, asserts SUM(`counted_against_partnership`) ≤ 6 across 100 random worker schedules. Mirrors F8 R8 fast-check precedent.

**Alternatives considered**:

- **Async quota update after registration commit**: rejected per FR-037 — strict transactional is the chosen reliability model.
- **`FOR UPDATE` row-lock on a stored counter**: requires introducing a `members.partnership_quota_consumed_per_event` JSONB column (or per-event-per-member counter table). Rejected for v1: adds schema surface + drift risk if archive/refund forgets to decrement. The advisory-lock-around-compute-on-read is simpler and has no drift class of bug.
- **`SERIALIZABLE` transaction isolation**: would also prevent the race but Postgres's SERIALIZABLE has serialisation-failure retries that are awkward to handle inside the FR-037 strict-rollback model. Advisory lock is more predictable.
- **Stored counter denormalisation for fast read**: rejected for v1 because the events list (FR-020) reads aggregate match-rate + total registration count — not per-member quota counters; the dashboard query doesn't depend on a fast counter read. Revisit if a future "member quota summary" surface lands in F6.1.

---

## R6 — Strict-transactional ingest (FR-037) implementation pattern

**Decision**: The `ingest-webhook-attendee.ts` use-case opens a single Drizzle transaction at the top of the function and performs, in order:

1. `SET LOCAL app.current_tenant = $tenantId` (binds RLS for the connection)
2. `INSERT INTO eventcreate_idempotency_receipts (tenant_id, source, request_id, processed_at, ttl_expires_at) ON CONFLICT DO NOTHING RETURNING request_id` — F6-owned idempotency table per R3; if no row returned (conflict), the request is a duplicate; rollback (no side effects) and return 409
3. `INSERT INTO events (...) ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET (...mutable fields) RETURNING event_id, archived_at` — upsert event row; capture archived_at to decide whether quota applies
4. `INSERT INTO event_registrations (...) ON CONFLICT (tenant_id, event_id, external_id) DO NOTHING RETURNING registration_id, match_type` — insert registration; if conflict, the attendee-externalId was already processed (second idempotency layer) → return 200 with the existing match info (no new side effects)
5. If `archived_at IS NULL` AND event was flagged partner-benefit or cultural AND attendee matched a member: call `apply-quota-effect` which does `SELECT … FOR UPDATE` on the counter + UPDATE
6. Audit emit via `auditPort.emit({eventType: 'webhook_receipt_verified', outcome: 'matched', ...})` within the same tx
7. Commit

On any error before commit, the tx rolls back and the use-case returns Result.err. The route handler catches this and returns HTTP 5xx so Zapier retries via its backoff. A **separate** non-transactional `auditPort.emit({eventType: 'webhook_rolled_back', ...})` writes the failure audit in its own tx so observability is preserved even on rollback.

**Dual-write fallback for the failure audit**: if the separate audit-tx also fails (e.g., DB is fully unavailable — the most common cause of the primary-tx failure in the first place), `auditPort.emitRolledBack(...)` MUST additionally write a structured `pino.fatal({event: 'webhook_rolled_back', requestId, failureStage, audit_secondary_tx_failure: true, primaryError, secondaryError}, '...')` line to stderr. Vercel Fluid Compute captures stderr as runtime logs even when the DB is down, so the failure is **never invisible** — at minimum it appears in the runtime log stream and triggers the standard log-based alert. The pino call is wrapped in try/catch so a stderr write failure (extremely unlikely — fd 2 always exists) does not crash the handler.

**Rationale**:

1. **All side effects inside one tx** → no partial commits → quota drift impossible by construction
2. **Idempotency receipt is part of the tx** → rollback drops it, so Zapier's retry on 5xx is correctly recognised as fresh (not duplicate-rejected); successful retry after recovery commits cleanly
3. **Second idempotency layer at registration-externalId** → catches the edge case where the receipt was committed but somehow a duplicate `X-Request-ID` slips through (defence in depth)
4. **Failed-delivery audit in separate tx** → observability never lost; the audit log is the canonical record even when the body fails

**Alternatives considered**:

- **Two-phase commit / Saga pattern**: rejected — overkill at this scale; Drizzle gives us local DB-level ACID for free.
- **Outbox pattern for audit log**: considered. Rejected because the failure-audit must be emitted on rollback, where the outbox row would also be rolled back. Separate tx is the correct primitive.

---

## R7 — Webhook secret rotation with 24h grace key

**Decision**: `tenant_webhook_configs` stores both `webhook_secret_active` (always non-null) and `webhook_secret_grace` (nullable, with `grace_rotated_at` timestamp). On rotation, the current active secret moves to grace, a new secret is generated and saved as active, and `grace_rotated_at = NOW()`. Verification tries the active secret first; on mismatch and only if `grace_rotated_at > NOW() - INTERVAL '24 hours'`, it tries the grace secret in a second `timingSafeEqual`. After 24h the grace secret is logically expired (still in the DB until the next rotation overwrites it). A daily cron clears expired grace keys.

**Rationale**:

1. **24h grace** is enough for a tenant admin who got a Zap update notification + needs to manually update the secret in Zapier UI + waits for next Zap deploy
2. **`timingSafeEqual` on both** — same algorithm, no sidechannel difference between active and grace verification
3. **Audit log differentiates** — `secret_grace_used` audit entry flags any webhook that verified on the grace key, so an admin sees the migration is in progress and can confirm completion
4. **Stored, not derived** — the grace secret is a real persisted value, not a "derived key from old rotated_at"; a deterministic-derivation scheme would still need timing-safe comparison and adds no benefit

**Alternatives considered**:

- **Hard cutover (no grace)**: rejected — would drop in-flight Zaps every rotation; very rough on the admin
- **Multi-key rotation (N grace keys)**: rejected — adds complexity for a use case (rotate-twice-within-24h) that's vanishingly rare
- **Stripe-style "endpoint signing secret rotation"**: same pattern as ours; chosen because it's known-good

---

## R8 — CSV import: streaming parse, inline processing, no background queue

**Decision**: The CSV import handler at `/api/admin/events/import` accepts `multipart/form-data`, streams the file through a hand-rolled streaming parser (Node `Readable` + `readline.createInterface` over the buffer; tens of lines), validates each row with the same zod schema used by the webhook handler, and runs the same `match-attendee-to-member` + `apply-quota-effect` logic inline within the function execution. Rows are processed in batches of 100 (each batch is its own tx; idempotency on `(tenant_id, source='eventcreate_csv', request_id=row_hash)`). Maximum file size is 5 MiB (enforced at multipart parse boundary); rows beyond max are rejected with 413.

**Rationale**:

1. **1k rows / <60s** (SC-006) fits well within Vercel Fluid Compute's 300s function timeout; no need for a job queue
2. **Same code path as webhook** → equivalence (SC-006's "byte-equivalent" claim) is by construction, not by parallel implementation
3. **Hand-rolled streaming parser** — `csv-parse` or `papaparse` would add a 200kB dep + maintenance for what is a <60-line internal function (the F6 CSV format is tightly specified, no quoted-comma-inside-quoted-field edge cases that would justify a full parser)
4. **Batch of 100 per tx** — bounds the tx size so a single bad row in row 850 doesn't roll back the first 800 valid rows; the import-result page reports the bad-row error inline

**Alternatives considered**:

- **`csv-parse` library**: rejected — overkill for our format; supply-chain + maintenance burden
- **Background-job queue (BullMQ / Inngest)**: rejected for v1 — adds infrastructure for a workload that fits in one function execution. Revisit at 10k-row imports.
- **All-or-nothing single transaction**: rejected — one bad row should not block 999 good rows
- **No idempotency on CSV rows**: rejected — admin who clicks "Import" twice should not double-process; row-hash idempotency catches it cheaply

**CSV format strictness contract (E20)**: the hand-rolled parser supports a **tightly-specified CSV variant**, not RFC 4180 in full:

- **Supported**: UTF-8 (BOM tolerated and stripped); `\n` or `\r\n` line endings; comma field separator; optional double-quoted fields with `""` escape for an embedded quote.
- **NOT supported (rejected explicitly)**:
  - Embedded newlines (`\n` or `\r\n`) **inside** quoted fields — these typically arise from Excel's "wrap-in-cell" mode and would require multi-line tokenisation
  - Non-comma separators (semicolon, tab)
  - Trailing-comma rows (`a,b,c,`) — the parser treats the trailing empty field as a column count violation
  - Mixed quoting within one row (`"a",b,"c"` is supported; `'a',b,c` is not)
  - Inline comments (`#` lines) — comments are not part of the format
- **Error report copy**: each parser-rejection row's error message names the specific violation (e.g., "row 47: unterminated quoted field at column 3") so admins can fix their export and re-upload.

Justification: the F6 CSV format is deliberately constrained because (a) the inputs we expect (admin-exported Excel sheets, hand-written CSVs from Google Sheets) all conform to this subset, (b) RFC-4180-full edge cases add ~100 lines of parser code + ~10 edge-case tests for negligible additional support, (c) a strict parser produces clearer error messages than a lenient one. If a tenant produces a non-conforming CSV, the admin's remediation is to re-export from Excel as "CSV UTF-8 (Comma delimited)" which is the tested format.

Test fixtures in `tests/integration/events/csv-fixtures/`:
- `happy-1000-rows.csv` — straight format
- `with-bom.csv` — BOM at start; stripped on read
- `crlf-line-endings.csv` — Windows line endings
- `quoted-fields-with-comma.csv` — `"Anantara Riverside, Bangkok"` location
- `quoted-fields-with-escape.csv` — `"O""Hara"` company name
- `malformed-embedded-newline.csv` — fixture for the unsupported case; asserts the parser reports the row
- `malformed-missing-required-column.csv` — fixture for header validation failure (400 + no processing)
- `malformed-wrong-separator-semicolon.csv` — fixture for separator violation

---

## R9 — Differentiated PII retention: 5y member-linked, 2y non-member, then pseudonymise

**Decision**: A daily cron at `/api/internal/retention/pseudonymise-eventcreate` (cron-job.org Bearer-auth pattern, daily 03:00 Asia/Bangkok) scans `event_registrations` for rows where:

- `match_type IN ('non_member', 'unmatched')`
- `pii_pseudonymised_at IS NULL`
- `registered_at < NOW() - INTERVAL '2 years'`

For each qualifying row, the cron updates `attendee_email`, `attendee_name`, `attendee_company` to deterministic SHA-256 salted hashes (per-tenant salt from `EVENTCREATE_PII_PSEUDONYM_SALT` env var concatenated with `tenant_id`), sets `pii_pseudonymised_at = NOW()`, and emits a `pii_pseudonymised` audit row per registration. Member-linked rows (`match_type IN ('member_contact', 'member_domain', 'member_fuzzy')`) are excluded and retain full PII until their 5-year audit threshold (handled separately by the F3-precedent retention sweep). Manual admin erasure via FR-032a is orthogonal — it deletes rows outright and is not subject to the 2y threshold.

**Rationale**:

1. **Per-tenant salt** ensures the same email hashed for tenant A is a different hash from tenant B — prevents cross-tenant re-identification by hash lookup
2. **Deterministic hash (not random salt per row)** preserves the ability to recompute aggregate match-rate / attendance counts post-pseudonymisation; this is the data-utility justification under PDPA / GDPR pseudonymisation definitions
3. **Daily sweep, 7-day allowance** (SC-011 measures completion within 7 days of threshold) gives operational headroom for incident response — if the cron is paused for a maintenance window, the 7-day SLO doesn't trip immediately
4. **Cron-job.org Bearer-auth pattern** matches F4/F5/F7/F8 — no new infrastructure

**Multi-tenant cron strategy (E18)**: there is a **single global cron-job.org entry** (NOT one entry per tenant) — `https://swecham.chamber-os.app/api/internal/retention/pseudonymise-eventcreate` triggered daily at 03:00 Asia/Bangkok. The handler iterates tenants in-process:

```ts
// pseudo-code in src/app/api/internal/retention/pseudonymise-eventcreate/route.ts
const tenantsWithEligibleRows = await db
  .selectDistinct({ tenant_id: eventRegistrations.tenant_id })
  .from(eventRegistrations)
  .where(/* match_type IN ('non_member','unmatched') AND age > 2y AND pii_pseudonymised_at IS NULL */)
  .execute({ as: 'super-admin' }); // BYPASS RLS for this enumeration query only

for (const { tenant_id } of tenantsWithEligibleRows) {
  await runInTenant({ tenantId: tenant_id }, async () => {
    await pseudonymiseStaleNonMemberPii({ /* port-injected deps */ });
  });
  // each per-tenant pass is its own RLS-bound execution; failures isolated per tenant
}
```

The enumeration query uses a dedicated `swecham_super` connection (BYPASS RLS) just to LIST tenants with eligible rows — no PII is read by the enumeration. The actual per-tenant sweep runs under `runInTenant` with normal RLS enforcement, isolating each tenant's work. Per-tenant sweep duration is bounded by the partial index `event_regs_pseudonymise_eligibility_idx`; total cron duration scales linearly with tenant count. At SweCham single-tenant scale this is ~1s; at 50 tenants × ~100 rows/sweep this is still <60s within one function execution. If total duration approaches the timeout, the cron can be split into multiple cron-job.org entries (one per tenant-batch) without changing the handler logic. Audit emission per tenant: `pii_pseudonymisation_sweep_run` records the per-tenant pass; the global cron handler logs (NOT audit-log) the total tenant count + total duration for observability.

**Alternatives considered**:

- **Soft-delete (set `pii_purged_at`, NULL out PII)**: same outcome, but using deterministic hash instead of NULL preserves audit-rebuild capability for aggregate stats
- **Full row delete at 2y**: rejected — destroys aggregate-stats utility (chamber's "how many attendees did we have at events in 2024?" reporting)
- **Random-salt hash (non-deterministic)**: rejected — destroys aggregate-rate utility, would still require keeping the salt → no privacy benefit
- **Manual admin "purge" only (no automatic sweep)**: rejected — non-scalable; PDPA / GDPR data-minimisation is a regulatory requirement, not a discretionary action

**GDPR Art. 4(5) pseudonymisation classification (E10)**: the deterministic-hash-with-per-tenant-salt approach qualifies as **pseudonymisation** (not anonymisation) under GDPR Art. 4(5) — the data subject can still be re-identified by combining the pseudonymised data with "additional information" (the salt). The salt is held separately (in Vercel env var `EVENTCREATE_PII_PSEUDONYM_SALT`, not in the database), satisfying Art. 4(5)'s "kept separately" requirement. Re-identification attack surface:

- **Brute-force against a known email list**: an attacker who already has a list of suspected email addresses can hash each one (with the per-tenant salt) and compare to the stored pseudonymised values. **Mitigated by**: (a) the salt being a 32-byte cryptographic random value held only as a Vercel env var (not committed, not logged, not exposed via any API), so without the salt the attacker cannot compute matching hashes; (b) RLS scoping the pseudonymised rows to the correct tenant — cross-tenant probe attempts are blocked at the DB layer.
- **Rainbow-table attack**: infeasible with a 32-byte salt because each tenant requires a unique rainbow table.
- **Insider-with-salt-access** (Vercel ops team, project maintainer): residual risk; mitigated by limiting Vercel team membership and rotating the salt on personnel changes per the F1 secrets-management baseline.

Salt-rotation policy: rotate on security-incident OR every 3 years. Salt rotation invalidates the deterministic-hash mapping (pseudonymised rows become re-pseudonymised under the new salt at the next sweep), which is fine because **aggregate stats survive** (the counts and counted_against_* flags are not hashed). Document the rotation policy in `docs/runbooks/eventcreate-pii-salt-rotation.md` at `/speckit.checklist` gate.

---

## R10 — Observability surface: ~10 metrics + ~5 alerts + 3 runbooks

**Decision**: F6 ships the observability baseline mandated by FR-036, conforming to `docs/observability.md` § 14. Concretely:

**OTel metrics** (all `eventcreate_*` namespaced):

1. `eventcreate_webhook_receipts_total` — counter, labels: `tenant_id`, `signature_outcome`, `processing_outcome`
2. `eventcreate_webhook_ingest_latency_seconds` — histogram (p50 / p95 / p99), labels: `tenant_id`
3. `eventcreate_match_rate_gauge` — gauge of (matched_registrations / total_registrations) over rolling 30-day window per tenant
4. `eventcreate_csv_import_duration_seconds` — histogram, labels: `tenant_id`, `row_count_bucket`
5. `eventcreate_partnership_quota_decrement_total` — counter, labels: `tenant_id`, `member_id_hash`
6. `eventcreate_cultural_quota_decrement_total` — counter, labels: `tenant_id`, `member_id_hash`
7. `eventcreate_refund_credit_back_total` — counter, labels: `tenant_id`
8. `eventcreate_secret_rotation_total` — counter, labels: `tenant_id`, `rotation_outcome`
9. `eventcreate_ingest_disabled_tenant_gauge` — gauge (0/1) per tenant
10. `eventcreate_pseudonymisation_sweep_rows_total` — counter per daily cron pass
11. `eventcreate_idempotency_sweep_rows_total` — counter per daily cron pass (labels: `tenant_id`); increments by `rowsDeleted` per pass. Signals (a) the sweep is running and (b) the table size is bounded. Added per round-4 AA1.

**Alerts** (Vercel/cron-job.org log-based alerts → Resend email to maintainer):

1. **Signature-rejection burst**: `eventcreate_webhook_receipts_total{signature_outcome="rejected"}` rate > 10/min sustained for 5 min per tenant
2. **Match-rate degradation**: `eventcreate_match_rate_gauge` drops below 0.95 for any tenant over rolling 24h window (SC-002 threshold)
3. **Webhook p95 over SLO**: `eventcreate_webhook_ingest_latency_seconds` p95 > 0.3s for any tenant over rolling 1h
4. **CSV import failure spike**: `eventcreate_csv_import_duration_seconds_count{outcome="failed"}` > 3 per tenant per hour
5. **Ingest-disabled tenant**: `eventcreate_ingest_disabled_tenant_gauge == 1` for any tenant (informational; the kill switch is rare)
6. **Idempotency sweep stalled**: `rate(eventcreate_idempotency_sweep_rows_total[2d]) == 0` for any tenant WHILE `eventcreate_idempotency_receipts` row count is growing (signals the daily cron has silently stopped — would otherwise allow the idempotency table to grow unbounded). Added per round-4 AA1.

**Runbooks** (under `docs/runbooks/`):

1. `eventcreate-signature-failure-investigation.md` — triage steps when alert #1 fires
2. `eventcreate-match-rate-degradation-triage.md` — investigation playbook when alert #2 fires
3. `eventcreate-secret-rotation-procedure.md` — operational steps to rotate a tenant's webhook secret, update Zapier, and verify round-trip

**Rationale**:

1. Matches F7/F8 ship-readiness bar (F7: 18 metrics + 11 alerts + 5 runbooks; F8: 12 metrics + 5 alerts + 3 runbooks). F6 lands at ~10/~5/3, proportionate to F6's smaller surface (3 tables vs. F7's 4 / F8's 7)
2. Signature-rejection burst alert catches both credential leaks (someone is testing stolen secrets) and Zapier misconfiguration (post-rotation Zap not updated)
3. Match-rate alert is the leading indicator that member onboarding (F3) has fallen behind event registration — gives the chamber early warning before a Diamond member's attendee accidentally hits non-member
4. Webhook p95 alert is the SC-003 SLO guardian — if it trips, Zapier will start retrying and audit log will fill with `webhook_rolled_back` entries

**Alternatives considered**:

- **F4-style 18+ metrics**: rejected — disproportionate to F6's surface; would dilute alert signal
- **F8-style metric naming `feature_<n>_*`**: rejected in favour of `eventcreate_*` because the upstream system identity matters for cross-cutting dashboards (e.g., "all integrations" view)
- **Custom dashboards in Vercel Analytics**: deferred to Phase 9 cross-cutting work — out of scope for plan

---

## R11 — F8 `EventAttendeesPort` adapter wiring

**Decision**: F8's `EventAttendeesPort.isAvailable()` and `EventAttendeesPort.getEventAttendeesByMember(memberId)` interfaces (defined in `src/modules/renewals/application/ports/event-attendees-port.ts`) are implemented at F6 ship-time by F6's `getEventAttendeesByMember` use-case. The canonical method name is **`getEventAttendeesByMember`** — used uniformly across spec.md, plan.md, this research doc, quickstart.md, and the eventual F6 application barrel export. If F8's existing port interface uses a different method name (e.g., legacy `getAttendanceByMember` mentioned in early drafts), the F6 implementer MUST first file an F8 amendment to rename the interface — F6 will NOT carry a translation shim. The implementation lives in `src/modules/events/application/get-event-attendees-by-member.ts` and is exposed via the F6 public barrel. F8's composition root (`src/app/(staff)/admin/renewals/...` route loaders and `src/app/api/cron/renewals/...` cron handlers) swaps the stub adapter for the F6 adapter at runtime via a feature-flag check on `FEATURE_F6_EVENTCREATE`.

**Rationale**:

1. **F8 designed this seam explicitly** — the stub port returns `isAvailable() === false` while F6 is dark, and F8's at-risk score formula degrades gracefully (event-attendance factors contribute 0 to the score, max-active band score reduces from 100 to 70 without code change). Test coverage: `tests/integration/renewals/at-risk-f6-fallback.test.ts` (existing F8 test).
2. **Composition-root swap (not per-use-case branching)** — keeps Application-layer code unaware of F6's existence; F8 still imports only `EventAttendeesPort` from its own module barrel
3. **Feature-flag-gated** — flipping `FEATURE_F6_EVENTCREATE=true` for a tenant flips the adapter; flipping back returns to stub (clean rollback path)

**Alternatives considered**:

- **F8 directly imports from F6 module**: rejected — violates Clean Architecture cross-module rule (F8 doesn't depend on F6's existence)
- **Permanent stub (F8 never sees real attendance)**: rejected — defeats the F8 at-risk-score's value when F6 is live
- **Inject adapter via a DI container**: rejected — Chamber-OS uses explicit composition roots, not a DI container; adding one for F6 is YAGNI

**Application-layer wrapper rationale (E1)**: the F6 implementation of F8's port lives at TWO layers — `src/modules/events/application/get-event-attendees-by-member.ts` (Application use-case) AND `src/modules/events/infrastructure/drizzle-event-attendees-by-member.ts` (Drizzle adapter). The Application-layer wrapper is **NOT** a thin pass-through; it exists to:

1. **Enforce `runInTenant` boundary**: F8 calls this from F8's tenant context. The wrapper validates the input `memberId` is a branded `MemberId` value-object and re-asserts the current `app.current_tenant` setting matches the member's tenant before issuing the Drizzle query.
2. **Map Drizzle types → Domain VOs**: the Drizzle adapter returns rows shaped by Drizzle's `InferSelectModel<typeof eventRegistrations>` (Infrastructure types). The Application wrapper maps these to the Domain `EventAttendanceRecord` VO (defined in `src/modules/events/domain/`), preserving the Constitution Principle III rule that Drizzle types never leak past Infrastructure.
3. **Stable port surface**: F8 imports `EventAttendeesPort` from its own module barrel; F8 does NOT import from F6. If F6 later changes its Drizzle schema (e.g., renames `event_id` to `external_event_id`), the Application wrapper absorbs the schema change so F8's consumer code is unaffected — the public port surface stays stable.

Without the Application-layer wrapper, F8 would either (a) import Drizzle types directly (violating Principle III) or (b) F6 Infrastructure would have to produce Domain VOs directly (mixing concerns). The wrapper is load-bearing, not ceremonial.

---

## R12 — Tenant onboarding wizard UX

**Decision**: The integration config page at `/admin/integrations/eventcreate` renders a single-page wizard with three phases:

1. **Generate secret** (initial state) — one button "Generate webhook URL + secret". On click: server action generates a fresh 32-byte secret, persists to `tenant_webhook_configs`, displays the secret in a one-time-reveal panel (per FR-024) with copy-to-clipboard control and a "I've saved this in a password manager" confirmation checkbox that gates step 2.
2. **Zapier walkthrough** — once the checkbox is confirmed, the page reveals an inline 8-step walkthrough with screenshots (committed as static assets under `public/walkthroughs/eventcreate-zapier/`) of the Zapier UI showing: (a) connect EventCreate account, (b) choose "New Attendees Registered" trigger, (c) add "Webhooks by Zapier" action set to POST, (d) paste tenant webhook URL, (e) configure headers (`X-Chamber-Signature` formula = HMAC of `{{timestamp}}.{{body}}`, `X-Chamber-Timestamp` formula = `now in epoch seconds`, `X-Request-ID` = Zapier-provided trigger event ID), (f) configure body (attendee + event fields mapped per the documented contract), (g) test step, (h) publish.
3. **Test webhook** — once the walkthrough is acknowledged (single "I've configured the Zap" checkbox), the page shows the "Test webhook" button + a recent-deliveries panel below. Clicking the test button sends a synthetic, signed payload to the tenant's own endpoint and polls the recent-deliveries panel for the test event to appear within 30 seconds; success state turns the panel green; failure displays the specific error category.

After initial setup, returning visits to the page render directly in state 3 with the secret masked and the wizard collapsed.

**Rationale**:

1. **Single-page wizard, not multi-route flow** — admin onboarding is high-cognitive-load already (they're switching between Chamber-OS and Zapier); a single scrollable page with progressive disclosure is easier than 3-route navigation
2. **One-time secret reveal + checkbox gate** — FR-024 mandates the one-time-reveal; the checkbox enforces that the admin acknowledged it before continuing (prevents the "I lost my secret" support ticket)
3. **Static screenshots, not embedded video** — screenshots load fast, are screen-readable for a11y. **Screenshots are EN-only** (per Session 2026-05-12 round 3 clarification) because Zapier's UI is English-only globally — TH/SV variants would not match what the admin actually sees in Zapier. Narration around the screenshots is fully localised (EN/TH/SV); a one-line "Zapier's interface is in English only" notice sits above the walkthrough section in TH/SV locales to set expectations honestly.
4. **Test-webhook is server-to-self** — bypasses the round-trip dependency on Zapier; verifies our verification logic + the secret was saved correctly + the tenant's URL is reachable

**Alternatives considered**:

- **Multi-step modal wizard**: rejected — modal-based wizards have a11y challenges (focus trap, keyboard escape) and are harder to localise; in-page progressive disclosure is simpler
- **Video walkthrough**: rejected — high bandwidth, harder to maintain, harder to localise, accessibility issues
- **Auto-generate Zap on tenant's behalf via Zapier Partner API**: rejected — requires Zapier-side OAuth integration setup (out of scope; tenant owns their Zapier account)

**Walkthrough screenshot staleness policy (P9)**: Zapier redesigns its UI on a ~6–12 month cadence, which would invalidate the committed screenshots. Mitigation policy:

- Screenshots are committed under `public/walkthroughs/eventcreate-zapier/` with filenames including a date stamp (e.g., `step-04-trigger-event-2026-05.png`).
- A 6-month review is added to the maintainer's quarterly checklist (mirrors F1's `docs/operational-procedures.md` quarterly tasks): on every Q1/Q3 review, the maintainer opens Zapier UI, walks the steps, and updates screenshots if the UI has changed materially.
- If screenshots are stale by ≥ 1 major Zapier redesign (e.g., the labels have changed or a step has moved), the integration config page MUST display a "Last verified against Zapier UI: <date>" banner so the admin knows whether to trust the walkthrough — this banner is wired to a `WALKTHROUGH_LAST_VERIFIED_AT` build-time constant updated by the maintainer at each review.
- Fallback: the walkthrough narration (Markdown body text in `i18n/messages/{en,th,sv}.json`) lists the step actions textually so an admin can follow even if a screenshot is stale.

This trade-off is acceptable for F6 v1; if maintenance proves excessive (e.g., Zapier redesigns more frequently than expected), the next refactor is a fully text-only walkthrough with no screenshots, accepting somewhat reduced ergonomics.

---

## R13 — Audit event taxonomy (~35 events)

**Decision**: F6 emits ~35 named audit event types via `pino-audit-port.ts`, conforming to the `payload jsonb` schema used by F2/F3/F4/F5/F7/F8. The canonical list (with retention years column):

**Webhook ingest** (8):
1. `webhook_receipt_verified` — signature ok + processing complete (5y)
2. `webhook_signature_rejected` — HMAC mismatch (5y)
3. `webhook_replay_rejected` — timestamp skew >5min (5y)
4. `webhook_duplicate_rejected` — idempotency hit on X-Request-ID (5y)
5. `webhook_malformed_rejected` — zod validation failure on required fields (5y)
6. `webhook_rolled_back` — primary tx failed, recorded post-rollback (5y)
7. `webhook_secret_grace_used` — verified on deprecated grace key (5y)
8. `webhook_test_invoked` — admin pressed "Test webhook" button (5y)

**Match resolution** (5):
9. `attendee_matched_member_contact` (5y)
10. `attendee_matched_member_domain` (5y)
11. `attendee_matched_member_fuzzy` (5y)
12. `attendee_non_member` (5y)
13. `attendee_unmatched` — ambiguous fuzzy match (5y)

**Quota effects** (4):
14. `quota_partnership_decremented` (5y)
15. `quota_cultural_decremented` (5y)
16. `quota_credit_back_refund` (5y)
17. `quota_credit_back_archive` (5y)
18. `quota_over_quota_warning` — registration persisted but quota exhausted (5y)

**Admin actions** (10):
19. `registration_relinked` (5y)
20. `event_archived` (5y)
21. `event_partner_benefit_toggled` (5y)
22. `event_cultural_event_toggled` (5y)
23. `webhook_secret_generated` — first-time generation (5y)
24. `webhook_secret_rotated` — explicit rotation (5y)
25. `ingest_disabled_super_admin` (5y)
26. `ingest_disabled_tenant_admin` (5y)
27. `csv_import_completed` (5y)
28. `csv_import_row_failed` (5y)

**Privacy + compliance** (4):
29. `pii_erasure_requested` (5y)
30. `pii_erasure_completed` (5y)
31. `pii_pseudonymised` (5y)
32. `pii_pseudonymisation_sweep_run` (5y)

**Security** (3):
33. `cross_tenant_probe` — payload signed for tenant A POSTed to tenant B URL (5y, high severity)
34. `role_violation_blocked` — FR-035 manager/member tried mutation (5y, medium severity)
35. `webhook_rate_limit_exceeded` — FR-005 60 req/min cap hit (5y, informational)

**Rationale**:

1. **5-year retention uniformly** — F6 has no tax-document overlap (no F4-style 10-year retention); 5y matches the audit baseline + statute-of-limitations for civil claims under Thai/EU regimes
2. **All events tenant-scoped** — every payload includes `tenant_id` for cross-tenant analysis blockers (and high-severity flagging on `cross_tenant_probe`)
3. **Generic + specific outcome events** — `webhook_receipt_verified` covers the happy path with a `processing_outcome` payload field, but `webhook_signature_rejected` is separate so signature-rejection-burst alerts can fire on a precise event type (not a label filter)

**Alternatives considered**:

- **Fewer event types, more payload-discriminator fields**: rejected — alert rules and audit replays are clearer with discrete event names; F4/F5/F7/F8 all chose discrete types
- **One mega-event with rich payload**: rejected — same as above; loses indexability on event_type
- **Per-route event types**: rejected — admin actions span multiple routes (e.g., archive can be triggered from list page or detail page); per-action types are cleaner

---

## R14 — Out-of-scope deferrals (re-stated from spec § Out of scope)

The following are explicitly OUT of F6 v1 (per spec § Out of scope + plan-time deliberation):

- Native event CRUD (EventCreate is authoritative)
- Public landing pages / ticketing / payment processing / check-in / QR scanning (EventCreate / F5)
- Calendar sync (ICS, Google/Outlook attach) — Smart Feature backlog
- Per-event email invites (F7 handles broadcast comms; per-event invites stay in EventCreate)
- Multi-source ingestion (Eventbrite, etc.) — `events.source` column is reserved
- >5,000-attendee single-event support — F6.1 backlog
- Real-time push delivery (WebSocket / SSE) — Zapier 15-min polling is sufficient
- ML-based attendee matching — rule-based 4-rule cascade is sufficient + auditable
- Auto-import of EventCreate's "test event" data filtering — admin uses archive action
- Reconciliation cron for EventCreate-side deletions — Chamber-OS owns its representation per Q1.4
