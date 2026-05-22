# Research: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Branch**: `014-email-broadcast-advance` | **Date**: 2026-05-17 (split to F7.1a 2026-05-18)
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Backlog**: [f71b-backlog.md](./f71b-backlog.md)

This document resolves every design-shaping decision for F7.1a (US1+US2+US7) with the **Decision / Rationale / Alternatives Considered** format. The 6 design decisions documented here are the F7.1a-applicable subset of the original F7.1 8-US bundle's 10 decisions; the 4 decisions relevant only to deferred user stories (US3, US4, US5, US6, US8) are preserved in `f71b-backlog.md` for re-use when those user stories are promoted.

---

## 1. ClamAV deployment topology (US2 — implements Clarifications Q2)

**Decision**: Self-hosted ClamAV `clamd` daemon deployed as a **Fly.io persistent micro-VM** in `sin` region (Singapore — matches platform `sin1`), running the official `clamav/clamav:stable` Docker image. The Chamber-OS Vercel Functions reach the scanner over TCP (Fly.io private networking + WireGuard, or public-but-firewalled with a shared secret). Signature database self-refreshes via `freshclam` inside the container (daily, default ClamAV behavior). The platform owns one tiny new piece of infrastructure (`fly.toml` + 1 container) but preserves the "self-hosted, zero per-scan cost" intent of Clarifications Q2.

**Why this revises the original "Vercel Function sidecar" answer (audit finding C2)**: The initial F7.1 plan claimed ClamAV could run as an "in-process Vercel Function sidecar", but `clamd` is a **persistent daemon** holding ~150 MB of signature data in memory — Vercel Functions are stateless and request-scoped (cannot host a daemon), and bundling the binary + 150 MB signature DB into a function would blow past Vercel's 250 MB function-size limit and inflate cold-start time. The `clamscan` Node binding can use binary mode (no daemon), but at 3-5× the latency + per-invocation 150 MB load cost — incompatible with the FR-013 ≤500ms p95 SLO. Fly.io persistent VM is the simplest deployment model that actually works.

**Rationale**:
- **Persistent daemon is the correct ClamAV deployment pattern**: `clamd` keeps signature DB resident in memory; each scan is a cheap socket call (~50-200ms p95 for files ≤2 MB).
- **Fly.io `sin` region** = Singapore, same continent as Vercel `sin1` + Neon `ap-southeast-1` → cross-region latency ~5-15ms; no GDPR/PDPA cross-border concern.
- **Cost**: Fly.io `shared-cpu-1x` 256 MB VM is **$1.94/month** (or free on the hobby tier with 3 free shared-cpu-1x machines). At SweCham + 2-3 future tenants F7.1a-ship+12mo, fits free tier with headroom.
- **Signature freshness owned by the container**: `freshclam` inside the same container refreshes signatures every 24h by default. No cron-job.org coordinator needed.
- **Wraps cleanly as Application port**: `VirusScannerPort` in `src/modules/broadcasts/application/ports/virus-scanner-port.ts` is a 1-method interface. Test doubles trivially mockable.
- **Dev/prod parity**: `docker run -d clamav/clamav:stable` in dev = same image as Fly.io prod. Same protocol, same client code path.

**Alternatives considered**:
- **Managed third-party API (VirusTotal, Cloudmersive, Bitdefender)** — rejected per Q2 clarify: per-scan cost + bandwidth surcharge scales adversely with tenant count; vendor downtime = platform downtime; sending member-uploaded content to a third party adds compliance surface.
- **Email-provider built-in scanning (Resend)** — rejected: Resend does not expose a customer-accessible scanning API; would also lock the platform to a single vendor for both delivery + scanning.
- **`clamscan` binary mode bundled into Vercel Function** — rejected: 3-5× slower than daemon mode breaks FR-013 SLO; 150 MB signature DB doesn't fit Vercel function size limit; cold-start penalty for upload-heavy spikes.
- **Cloud Run / Container Apps on hyperscaler (GCP, AWS, Azure)** — rejected: adds a third cloud vendor beyond Vercel + Neon.
- **Self-hosted on a Neon-region VPS (Hetzner, DigitalOcean SG)** — rejected: less DX than Fly.io.
- **Original "Vercel Function sidecar" claim** — rejected post-audit (finding C2): technically incompatible with `clamd` daemon model + signature DB size + Vercel cold-start budget.

---

## 2. Per-batch concurrency cap + advisory-lock namespace (US1 — implements Clarifications Q1)

**Decision**: Concurrency cap = **4 simultaneous batches** per broadcast (default), tenant-configurable in 1–8 range via `tenant_broadcast_settings.dispatch_concurrency_cap`. Two new advisory-lock namespaces:
- **`broadcasts-batch:`** scoped to `(tenantId, broadcastId, batchIndex)` — disjoint from F7 MVP `broadcasts:` namespace AND from F4 `invoicing:` AND from F5 `payments:`. Per-batch TOCTOU guard.
- **`broadcasts-retry:`** scoped to `(tenantId, broadcastId)` — disjoint from both above. Serialises concurrent admin retry attempts per FR-008d (added per critique E4).

**Lock acquisition pattern**:
```
-- Per-batch dispatch (TOCTOU guard)
pg_advisory_xact_lock(hashtextextended('broadcasts-batch:'||tenantId||':'||broadcastId||':'||batchIndex, 0))

-- Per-broadcast retry serialisation
pg_advisory_xact_lock(hashtextextended('broadcasts-retry:'||tenantId||':'||broadcastId, 0))
```

**Rationale**:
- **Concurrency cap of 4**: SC-002 budget = 45 min for 50k recipients = 5 batches × 10k = ~9 min/batch sequential = 45 min total. Parallel × 4 = 5 batches / 4 lanes = 1.5 cycles × ~9 min = ~14 min → 3× headroom under SC-002 budget. Cap of 8 risks Resend account-level rate-limit incidents (~10 req/sec) when 8 batches all hit the API simultaneously. Cap of 2 wastes the headroom. Cap of 4 is the Goldilocks zone validated by F8's analogous dispatch-cron pattern.
- **Tenant-configurable 1–8** so a tenant on an elevated Resend account can opt up to 8 while a tenant on a free Resend account can opt down to 1.
- **`broadcasts-batch:` namespace disjoint from `broadcasts:`**: a per-batch retry does NOT contend with the per-broadcast operations from F7 MVP. Disjoint namespaces = no false contention.
- **`broadcasts-retry:` namespace per critique E4**: prevents the "two admin tabs both click Retry → both increment manual_retry_count to 2 → budget exhausted in one action" race. First retry wins; second returns `ALREADY_RETRYING_IN_PROGRESS` without budget consumption.

**Alternatives considered**:
- **Sequential dispatch (concurrency cap = 1)** — rejected per Q1: 50k recipients × ~3-5 min/batch serial = 25 min, tight against SC-002 45-min budget.
- **Per-recipient `emails.send`** — rejected per Q1: abandons F7 MVP Broadcasts audience model.
- **Unbounded parallelism (no concurrency cap)** — rejected: would burst-hit Resend's account-level rate limit.
- **Token-bucket rate-limiter instead of concurrency cap** — rejected: more complex; concurrency cap is the simpler invariant.

---

## 3. Per-batch state machine for `partially_sent` recovery (US1 — implements Clarifications Q3)

**Decision**: Broadcast state machine extends with non-terminal `partially_sent` and transient `retrying`. Admin "Retry failed batches" action transitions `partially_sent → retrying`, re-dispatches only failed batches with original frozen recipient sets, then transitions back to either `sent` (all batches now success) or `partially_sent` (still some failures). After 3 manual retries OR admin "Accept partial delivery" action, `partially_sent` becomes terminal.

**State diagram**:
```
draft → submitted → approved → scheduled? → sending
                                              ↓
                                              ├─ all batches success → sent (terminal)
                                              └─ ≥1 batch failed → partially_sent (NEW non-terminal, retries-remaining=3)
                                                                  ↓
                                                                  ├─ admin: Retry failed batches → retrying (NEW transient)
                                                                  │                                  ↓
                                                                  │                                  ├─ all success → sent
                                                                  │                                  └─ still failed → partially_sent (manual_retry_count++)
                                                                  ├─ admin: Accept partial delivery → partial_delivery_accepted (NEW terminal)
                                                                  └─ retries-remaining=0 + admin idle → admin alerted via UI banner; same state
  ↓ admin or member: cancel → cancelled (terminal)
```

**State invariants**:
- `manual_retry_count ∈ [0, 3]` enforced by CHECK constraint
- `partially_sent` is non-terminal iff `manual_retry_count < 3 AND partial_delivery_accepted_at IS NULL`
- `retrying` is transient — exists in the Application-layer state machine but does NOT persist to `broadcasts.status` enum (the broadcast row stays in `partially_sent` for the duration of the retry; transitions back to `sent` or `partially_sent` on retry completion). Per critique M1 (open finding) — this clarification removes the "is `retrying` a DB status?" ambiguity.
- Concurrent retry attempts blocked by `broadcasts-retry:` advisory lock per FR-008d.
- Transitions enforced by the broadcast aggregate's `transitionTo()` method (Domain layer).

**Rationale**:
- **Non-terminal `partially_sent`** preserves recipient-set fidelity. Segment drift between "create a new broadcast targeting only affected recipients" attempts is the entire source of duplicate-or-miss send bugs in marketing platforms.
- **Cap at 3 manual retries** bounds the audit-trail size + operator workload. After 3 retries against a stuck batch (e.g., Resend account-level suspension), the retry budget is exhausted and the admin must Accept Partial Delivery.
- **`retrying` transient — application state only, NOT DB enum**: simpler schema; broadcast row's `status` column tracks only persisted states (`sent`, `partially_sent`, `partial_delivery_accepted`, `cancelled`, `failed`). The retry operation is bracketed by transaction boundaries; observers see only the before-state (`partially_sent`) and after-state (`sent` or `partially_sent`).
- **No auto-retry on cron tick**: silent retries consume the retry budget without operator awareness.

**Alternatives considered**:
- **Terminal `partially_sent`** — rejected per Q3.
- **Auto-retry on `reconcile-stuck-sending` cron tick** — rejected per Q3.
- **Unbounded manual retries** — rejected: a stuck batch could accumulate 100 retry audit rows over weeks.
- **`retrying` as a persisted DB enum** — rejected per critique M1 clarification: adds DB complexity without observability benefit (transient by definition; transaction commits hide it from observers).

---

## 4. Image-source allowlist defaults (US2 — implements FR-010)

**Decision**: On tenant provisioning, the `tenant_image_source_allowlist` table is seeded with exactly TWO default entries that the tenant CANNOT remove (they can ADD additional entries but the defaults stick):
1. The chamber's own asset domain (resolved from `tenants.asset_domain` column — added in a sibling migration if not already present; for SweCham this is `assets.swecham.zyncdata.app`)
2. The email provider's CDN (Resend) — `https://email-assets.resend.com` (verified URL; pinned as a constant in `src/modules/broadcasts/domain/value-objects/image-source-allowlist.ts` — changes via spec amendment)

**Rationale**:
- **Cannot remove defaults** to prevent the "admin accidentally allowlist-empties and breaks ALL existing draft images" failure mode.
- **Exact hostname matching only** (no wildcards, no path matching) — per FR-010. Prevents subdomain-takeover allowlist bypass.
- **Per-tenant tables** (not global) so each tenant's allowlist reflects their own asset domain. Cross-tenant probe test verifies tenant A cannot see/modify tenant B's allowlist.

**Alternatives considered**:
- **Single global allowlist** — rejected: couples tenants to platform-level configuration.
- **Wildcards allowed** (e.g., `*.swecham.zyncdata.app`) — rejected per FR-010: subdomain takeover risk.
- **Allowlist auto-populated from MX/SPF records** — rejected: clever but fragile.

---

## 5. Feature-flag matrix + ship-day sequencing (US1 + US2 cross-cutting)

**Decision**: F7.1a ships **dark by default** under a master flag `FEATURE_F71A_BROADCAST_ADVANCED=false`. Each US is additionally gated by its own flag for surgical rollback:

| Flag | Default | US | Gates |
|------|---------|----|----|
| `FEATURE_F71A_BROADCAST_ADVANCED` | OFF | master | All F7.1a routes + use-cases |
| `FEATURE_F71A_US1_PAGINATION` | OFF | US1 | Batch dispatcher; 5k cap upgrade to 50k |
| `FEATURE_F71A_US2_IMAGES` | OFF | US2 | Tiptap image extension; upload route; allowlist UI; ClamAV scan |
| `FEATURE_F71A_US7_TEMPLATES` | OFF | US7 | Template library admin route; compose picker; snapshot use-case |

**Ship-day sequencing** (planned):
1. `FEATURE_F71A_BROADCAST_ADVANCED=true` (master ON; per-US flags still OFF — admin can see /admin/broadcasts/settings + /admin/broadcasts/templates pages but features unavailable)
2. `FEATURE_F71A_US7_TEMPLATES=true` (lowest-risk; UI-additive; 5 starter templates already seeded in DB)
3. `FEATURE_F71A_US2_IMAGES=true` (lower-risk; depends on Fly.io ClamAV being healthy)
4. `FEATURE_F71A_US1_PAGINATION=true` (highest risk; do last; one tenant at a time; verify 10k → 50k progression)

**Rollback drills** (pre-ship): simulate flag flips per US to ensure the surface gracefully degrades when its flag is OFF (e.g., flipping `FEATURE_F71A_US2_IMAGES=false` mid-flight should not break already-composed drafts containing `<img>` tags — sanitiser falls back to the F7 MVP no-`<img>` allowlist and the member sees previously-allowed images as alt-text in existing draft preview).

**Kill-switch thresholds**: see `plan.md § Rollback Strategy`.

**Rationale**: 4 flags = 2^4 = 16 combinations, all testable in <2h per critique E14. The original F7.1 had 9 flags = 512 combinations, untestable in finite time. Strategy B's scope reduction reduces flag matrix complexity by 32× (vs 64× when US7 was deferred — still acceptable margin).

---

## 6. Template snapshot semantics + starter-template seed strategy (US7 — promoted from F7.1b)

**Decision**: Templates use **snapshot semantics at draft-start time**: when a member picks a template, the template's `subject` + `body_html` are COPIED into the new draft at the moment of selection. Subsequent admin edits to the template do NOT propagate to drafts already started. Migration `0134_f71a_default_template_seed.sql` seeds **5 starter templates × 3 locales = 15 rows per tenant** with maintainer-authored content (see `starter-templates.md`); the seed step skips templates whose name already exists (idempotent re-run safe).

**Starter template names** (FR-020):
1. Monthly Newsletter
2. Event Invitation
3. Member Spotlight
4. Urgent Announcement
5. Sponsorship Thank-You

Each ships in EN + TH + SV with locale-appropriate greeting, tone, and structure.

**Rationale**:
- **Snapshot semantics** removes the "admin edits template → in-flight drafts shift under members' feet" failure mode. Members compose at their own pace; their draft is theirs.
- **Idempotent seed (skip-on-existing-name)** preserves the F7.1a re-run safety invariant. If migration 0134 runs twice (e.g., dev environment refresh) it does NOT duplicate templates. Existing tenants who somehow already have "Monthly Newsletter" template keep their version.
- **15 rows per tenant ≈ trivial storage** (~5 KB body × 15 = 75 KB per tenant) — no scale concern even at 100-tenant horizon.
- **Maintainer-authored content** sidesteps the "compliance liaison content-review bottleneck" surfaced in critique X2. Admin refines post-ship as part of normal template-CRUD UX (FR-016).
- **Per-locale seeding (3 rows per template)** ensures every locale gets a hand-authored starter, not a machine-translated fallback. Members in TH/SV see proper script + greeting from day 1.

**Alternatives considered**:
- **Reference semantics (template edit propagates to drafts)** — rejected: violates member's authoring contract; introduces non-determinism in compose UX.
- **Member-authored templates** — rejected per FR-016: no moderation surface in F7.1a; member-authored templates require admin approval workflow which is F7.1b+ scope.
- **Single starter template per tenant** (matches F7 MVP) — rejected per critique X2: empty-feeling library; admin must author 4+ more templates before members benefit; high adoption friction.
- **Lazy seed on first admin visit to template page** — rejected: introduces a "first visit is slow" UX cliff; migration seed is one-time cost amortised over tenant lifetime.
- **Compliance-liaison-authored starter content** (require human content review before seeding) — rejected: blocks F7.1a ship on coordination; maintainer-authored content + post-ship admin refinement achieves the same end state at lower coordination cost.

---

## 7. Performance budgets (cross-cutting)

| Surface | Budget | Source | Verification |
|---------|--------|--------|--------------|
| ClamAV image scan latency | ≤500ms p95 for files ≤2 MB | SC-005 / FR-013 | Vitest integration bench against live ClamAV (Docker in dev, Fly.io in staging) |
| 10k-recipient broadcast end-to-end dispatch | ≤10 min | SC-001 | Playwright e2e bench (non-env-gated CI smoke at 7500 recipients per critique E11) |
| 50k-recipient broadcast end-to-end dispatch | ≤45 min | SC-002 | Playwright e2e bench (env-gated, full-fixture seed) |
| Per-batch dispatch (10k recipients to Resend) | ≤180s | derived from SC-002 budget | Integration bench |
| Admin batch breakdown UI render | ≤300ms TTFB | derived from existing compose TTFB budget | Playwright trace |
| Image upload + scan | ≤2s p95 for 5 MB image | derived from SC-005 + Vercel Blob upload latency | Integration bench |

**Resource budget**:
- Vercel Function memory per dispatch handler: 1024 MB (existing F7 MVP)
- Vercel Function timeout per dispatch handler: 300s (Vercel post-2025 default)
- Postgres connection pool per request: 1 (Drizzle singleton)
- ClamAV instance RAM headroom: ~256 MB Fly.io shared-cpu-1x (matches container's typical footprint)

---

## 8. Audit event taxonomy (F7.1a-only)

F7.1a adds **10 new audit event types** to the existing F7 MVP 43 + F8 64 + F1+F2+F3+F4+F5+F6 baseline. All 10 ship at the 5-year default retention class.

| # | Event type | Emitted by | US | Severity |
|---|-----------|-----------|----|----------|
| 1 | `broadcast_dispatched_in_batches` | dispatch-broadcast-batch use-case | US1 | INFO |
| 2 | `broadcast_retry_initiated` | retry-failed-batches use-case | US1 | INFO |
| 3 | `broadcast_retry_completed` | retry-failed-batches use-case | US1 | INFO |
| 4 | `broadcast_partial_delivery_accepted` | accept-partial-delivery use-case | US1 | INFO |
| 5 | `broadcast_body_image_source_unsafe` | validate-image-source-allowlist | US2 | WARN |
| 6 | `broadcast_image_too_large` | upload-inline-image | US2 | INFO |
| 7 | `broadcast_image_allowlist_updated` | manage-image-allowlist | US2 | INFO |
| 8 | `broadcast_template_created` | create-broadcast-template use-case | US7 | INFO |
| 9 | `broadcast_template_updated` | update-broadcast-template use-case | US7 | INFO |
| 10 | `broadcast_template_deleted` | delete-broadcast-template use-case | US7 | INFO |
| — | `broadcast_template_seed_skipped_existing_name` | migration 0134 (operator-level signal, not runtime use-case) | US7 | INFO |

(Original F7.1 had 23 audit event types across 8 USs; F7.1a's 10 events are the US1+US2+US7 subset. The remaining 13 events are preserved in `f71b-backlog.md` for re-spec.)

**Audit-event grants migration** (`0133_f71a_audit_event_grants.sql`) inserts a row into `audit_event_grants` for each of the 10 new event types with `retention_years = 5` and the appropriate severity class.

---

## Summary

All 6 design decisions documented above are F7.1a-applicable. Zero open decisions remain for F7.1a. The plan is ready for `/speckit.tasks`.

**File map of design decisions → source FRs**:
- Decision 1 (ClamAV topology) → FR-013 + Clarifications Q2
- Decision 2 (concurrency cap + lock namespaces) → FR-002 + FR-008d + Clarifications Q1 + critique E4
- Decision 3 (state machine) → FR-008a..d + Clarifications Q3 + critique M1
- Decision 4 (allowlist defaults) → FR-010
- Decision 5 (feature flags) → cross-cutting + critique X5/E14
- Decision 6 (template snapshot + seed strategy) → FR-016..023 + critique X2

**Deferred to `f71b-backlog.md`** (was 4 decisions in original F7.1 research — US7 promoted BACK into F7.1a per maintainer decision):
- F3 schema migration strategy (US3)
- PII detector pattern library structure (US8)
- Engagement event 90-day retention sweeper (US5)
- Attachment retention co-termination (US4)
- Saved-segment filter JSON schema (US6)
