# Changelog

All notable changes to the SweCham / TSCC Membership System are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release is a Spec Kit feature (`F1`, `F2`, …) shipped as a single PR
against `main`. Release notes summarise the user-facing change; the full
spec / plan / tasks / review / retrospective for each release lives under
`specs/{nnn-feature}/`.

---

## [F7.1a] Email Broadcast Advanced — 2026-05-21

Pre-merge release notes for branch `014-email-broadcast-advance` → main.
Ships dark behind `FEATURE_F71A_BROADCAST_ADVANCED=false` (+ 3 sub-flags
`FEATURE_F71A_US1_PAGINATION` + `FEATURE_F71A_US2_IMAGES` +
`FEATURE_F71A_US7_TEMPLATES`). Production flag-flip is an operator
workflow per `specs/014-email-broadcast-advance/qa/ship-day-checklist.md`.

### Added

**US1 — Recipient pagination (5,000 → 50,000 recipients)**
- Per-batch dispatch state machine: split into 5 × 10,000 batches when
  recipient count exceeds Resend per-audience cap (FR-001 + FR-002)
- 3-attempt admin manual-retry budget with `broadcast_retry_initiated`
  / `_completed` audit events (FR-008a)
- 5-attempt auto-retry on transient gateway failures (FR-005)
- Accept-partial-delivery terminal state (FR-008c) for unrecoverable
  partial sends — admin marks broadcast complete with optional reason
- Per-(tenant, broadcast) `pg_advisory_xact_lock` serializes concurrent
  admin retries (`broadcasts-retry:` namespace, disjoint from F4/F5/F7)
- 4-layer dispatch race-window defence (cron tick + FOR UPDATE SKIP
  LOCKED + idempotency unique + row-state guard) — row-state guard is
  LOAD-BEARING (`updateStatus WHERE status=fromStatus + .returning()`)
- Admin batch-breakdown collapsible UI on broadcast detail page

**US2 — Image embedding + allowlist + ClamAV virus scan**
- Inline `<img>` upload with per-tenant hostname allowlist (FR-010,
  FR-011) — admin-managed via `/admin/settings/broadcasts`
- ClamAV virus scan with pipeline-order invariant (FR-013): bytes
  never reach storage before clean verdict, fail-closed on timeout
- Submit-time allowlist enforcement on hostnames extracted from body
  HTML (single + double-quoted `src` attrs)
- 5 MB upload size cap (FR-012) + content-hash dedup via Vercel Blob
- ClamAV daemon on Fly.io `sin` region (~$2/mo or free tier)
- ClamAV-unreachable banner on member compose surface (degraded mode)
- Signature-age SLO alert at 48h (`clamav_signature_age_hours_critical`)

**US7 — Multi-template library**
- Admin authoring CRUD: `/admin/broadcasts/templates` + `/new` + `/[id]/edit`
- Sanitiser + allowlist gating at save time (FR-017) — prevents bad
  templates from reaching members
- Member-side picker on compose surface with locale cascade (member
  locale > tenant default > EN fallback) + MRU ordering (FR-018)
- Snapshot-to-draft semantics (FR-019): pick a template → server pre-
  populates draft subject + body with `{{chamber_name}}` substitution
- `ChamberSubstitutedBody` Domain brand prevents un-substituted body
  from reaching the repo writer (XSS-prevented at compile boundary)
- `escapeHtml` applied to chamber name before substitution (XSS defence
  in depth)
- 5 starter templates × 3 locales seeded per tenant (FR-020 / SC-007b)
- Snapshot decoupling (FR-023 / SC-007a): template edits do NOT mutate
  drafts created from prior versions; `started_from_template_id` +
  `template_name_snapshot` columns capture the point-in-time provenance

**Cross-cutting**
- 4 new DB tables (`broadcast_batch_manifests`, `broadcast_templates`,
  `tenant_image_source_allowlist`, `tenant_broadcast_settings`)
- 22 migrations 0161-0179 (incl. 0179 XOR CHECK constraint on
  template-provenance for DB-level integrity)
- 17 new audit event types (`broadcast_batch_*`, `broadcast_image_*`,
  `broadcast_template_*`) with 5y retention
- 5 OTel metrics (`broadcasts_batch_dispatch_duration_ms`,
  `broadcasts_partial_send_count`, `broadcasts_manual_retry_count`,
  `broadcasts_image_scan_duration_ms`,
  `broadcasts_clamav_signature_age_hours`)
- 4 SRE alerts + 3 runbooks (clamav-signature-stale,
  clamav-daemon-down, broadcast-partial-send-recovery)
- 3 cron-job.org coordinators (dispatch-batches + split-large-broadcasts
  + stale-pending-count gauge — every 5 min)
- DPIA addendum (image bytes = new PII class; Vercel Blob URL = capability
  token residual; 17-event ROPA addition)
- 5 new client-side helpers + 11 new UI surfaces
- 3 new E2E specs (`template-library-flow` + `image-upload-allowlist` +
  `pagination-batch-breakdown`) — 11 tests total

### Changed

- **F7 MVP carryover (verify non-regression at T164)**: F7.1a does NOT
  alter the F7 MVP dispatch path when `FEATURE_F71A_BROADCAST_ADVANCED=false`.
  All F7 MVP behaviour preserved (single-audience dispatch for recipient
  counts ≤ 10,000; no batch-manifest rows created).
- **Shared `Table` primitive** (`src/components/ui/table.tsx`): added
  `tabindex=0` + `role="region"` + `aria-label="Data table"` fallback
  for WCAG 2.1 SC 2.1.1 (Keyboard) compliance on scrollable regions.
  Operators SHOULD override `aria-label` per Table instance via prop.
- **`compose-form.tsx` `Save as draft` flow**: captures `broadcastId`
  from POST response + updates local `currentDraftId` state so inline-
  image uploader becomes available after first save (was: hidden
  indefinitely until manual refresh — caught by E2E).

### Fixed

- **Production bug**: `compose-form.tsx` Save Draft API returned
  `{broadcastId}` but form dropped it — inline-image uploader stayed
  hidden indefinitely for first-time members (caught by E2E `runAxeScan`
  + `pageerror` fixture).
- **Production bug**: `Table` primitive missing tabindex/role/aria-label
  → axe-core `scrollable-region-focusable` violation on every Table
  surface in the app (admin members directory, invoices, plans, broadcasts).
- **Production bug**: ComposeForm `useState(initialSubject)` did not
  re-init on prop change; template selection via `router.push(?template=)`
  preserved stale form state. Fixed with `key={selectedTemplateId}`
  remount.
- **Architecture debt**: `Hostname` brand extracted to Domain layer
  (closes Plan.md Complexity Tracking #5).
- **Architecture debt**: 14 deep imports moved through `@/modules/broadcasts`
  barrel across 2 cron routes (`broadcasts-barrel.test.ts` KNOWN_BACKLOG
  shrunk 40 → 26).
- **Code quality**: `f7AuditAdapter:` string-prefix error matching
  replaced with tagged `AuditPortInvariantError` class (back-compat
  fallback preserved).

### Technical Notes

- **Constitution v1.4.0 compliance**: All 10 principles PASS. 5 Complexity
  Tracking entries justified in `plan.md`; CT #5 closed by F7.1b B1.
- **Bounded context**: `src/modules/broadcasts/` extends F7 MVP — same
  Resend Broadcasts API surface, same dispatch/webhook/audit machinery.
- **Solo-maintainer review substitute** (Principle IX): 7 review rounds
  (R1 narrow → R2 7-agent → R3 Phase 6 polish → R4 "ไม่ defer" simplifier
  → R5 Round-2 findings → R5+ LOW polish → R6 staff-review 3-agent
  APPROVED WITH CONDITIONS → R7 F7.1b backlog closure). ~87 task
  closures across 7 rounds.
- **Test discipline**: 938/938 broadcasts contract+unit + 172/182
  integration (10 staging-gated operator skips) + 20/20 cross-tenant
  probe on live Neon Singapore + 11/11 F7.1a broadcasts E2E on chromium.
  Coverage: Domain 100% line · Application 80% line+branch · 100% branch
  on security-critical paths.
- **Ship-day operator gates** (DO NOT MERGE UNTIL ALL DONE): T135/T136
  manual SR + quickstart · T139 Fly.io ClamAV deploy · T140 Vercel env
  vars · T141 cron-job.org coordinators · T142 16-flag-matrix · T143-T146
  production flag-flip sequence · T149 final commit tag · T164 F7 MVP
  non-regression. Full procedures in
  `specs/014-email-broadcast-advance/qa/ship-day-checklist.md`.
- **F7.1b deferred** (out of MVP scope): B4 live-Blob erasure cascade
  test (staging Vercel Blob token) · B10 disposable Neon branch (CI
  infra, ~4h) · B7 remaining 17+ E2E specs (F7.2 a11y-hardening sweep).
- **Zero new npm dependencies** in Round 5-7 (Constitution X). Reuses
  existing primitives: Vercel Blob (F4), advisory locks (F4+F5), Tiptap
  + DOMPurify (F7 MVP), `runInTenant()` (F2+), `next-intl` (F1+),
  shadcn primitives.

---

## [F6] EventCreate Integration — 2026-05-19

**Spec**: [`specs/012-eventcreate-integration/spec.md`](specs/012-eventcreate-integration/spec.md)
**Plan**: [`specs/012-eventcreate-integration/plan.md`](specs/012-eventcreate-integration/plan.md)
**Final review**: R4 fix-all `cb00ed1a` — ✅ APPROVED (R1 → R2 atomicity → R3 audit-emit boundary → R4 27-caller migration)
**Review history**: 12 review reports + 4 cumulative fix-all close-outs (R1 base / R2 / R3 / R4)
**Spec adherence**: 7 user stories (US1–US7) all closed in-session; 6 operator gates (T150–T154a) deferred to ship-day-checklist.md
**Test baseline**: 4852 / 4852 unit + 204 / 204 F6 integration + 271 / 271 F8/audit cross-module on live Neon `ap-southeast-1` · 2924 i18n keys × EN/TH/SV · typecheck + lint clean · 4 / 4 cross-tenant search probes GREEN (Principle I Review-Gate)

### Added

- **US1 Webhook ingest** — per-tenant signed HTTPS POST at `/api/webhooks/eventcreate/v1/{tenantSlug}` with HMAC-SHA256 timing-safe verify + 5-min replay protection + 7-day idempotency receipts + 10 req/min rate limit + HTTP 503 super-admin kill switch + cross-tenant probe rejection (Principle I sub-clause 1).
- **US2 Events list + detail** — `/admin/events` paginated list (sort by date desc) + filter chips (partner-benefit / cultural / archived / category) + free-text search + payment-status filter; `/admin/events/{eventId}` detail with match-rate header + paginated attendee table + "Show unmatched only" toggle + Clear filters CTA with focus return.
- **US3 Zapier setup wizard** — `/admin/integrations/eventcreate` with one-time secret reveal + masked-after-rotation display + "Test webhook" round-trip + inline Zapier walkthrough (EN screenshots, TH/SV narration).
- **US4 Quota accounting** — Partnership tier per-event ticket allotment + Corporate tier annual cultural quota; counted_against flags + over-quota informational badge + refund credit-back.
- **US5 CSV import** — `/admin/events/import` drag-drop or file-picker with 10-row preview + column-mapping suggestions + EventCreate-format auto-detection (Option B+ strict allowlist status mapping). Same matching + quota + audit pipeline as webhook (FR-027 by construction). 1,000-row p95 <60s (SC-006).
- **US6 Manual relink** — admin re-links non-member or mis-matched registrations to correct member; quota effects recomputed + credit-back of prior member's quota; restricted on pseudonymised PII rows (FR-014 round-2 R4 invariant).
- **US7 Secret rotation** — admin-initiated rotation with 24-hour grace window (old secret continues to verify, audit-tagged as deprecated-grace); cron-job.org `force-expire-grace-secret` invalidates after 25h.
- **PDPA / GDPR data subject erasure** — admin-only tool at `/admin/events/{eventId}/registrations/{registrationId}/erase` deletes PII + reverses counted quota + audit-logs erasure with admin actor + reason text (satisfies PDPA §30 / GDPR Art. 17 within 30-day statutory deadline).
- **Admin-archive lifecycle** — `archived_at` soft-delete + reverses `counted_against_*` flags on event's registrations + audit-logs each reversal + hides from default list (accessible via "Include archived" filter).
- **Differentiated PII retention** — member-linked attendees 5y, non-member attendees 2y + pseudonymise via deterministic salted hash. `pseudonymise-eventcreate` cron sweeps daily.
- **Strict ACID-tx atomicity (FR-037)** — single tx for event upsert + registration insert + idempotency receipt + quota decrement. Atomicity invariant locked under R2-1 (re-throw all TxStageError stages) + R3-C1 (raw-throw → TxStageError at emitOrThrow boundary) + R4-I1 (27-caller safeAuditEmit migration).
- **5 admin surfaces** + **1 webhook surface** + **3 cron coordinators** (pseudonymise-eventcreate daily / sweep-eventcreate-idempotency daily / recompute-match-rate hourly).
- **New bounded context** `src/modules/events/` (Domain / Application / Infrastructure) with public barrel + ESLint `no-restricted-imports` per Principle III.
- **35+ F6 audit event types** under `audit_event_type` pgEnum (5y default retention per F6 scope; no Thai-tax 10y retention applies).
- **~11 OTel metrics + ~6 alerts + 3 runbooks** matching F7 / F8 ship-readiness bar per docs/observability.md § 14.
- **2 new DB tables** — `events`, `event_registrations` — plus `tenant_webhook_configs` + `eventcreate_idempotency_receipts` + `csv_import_records`. RLS + FORCE on every tenant-scoped row.
- **Kill-switch** — `FEATURE_F6_EVENTCREATE=false` contains F6 end-to-end (routes + cron + outbox + UI).

### Changed

- **No behavioral changes** to F2 (Plans), F3 (Members), F4 (Invoicing), F5 (Payments), F7 (Broadcasts), or F8 (Renewals). F6 reads members + plans + tenant_invoice_settings via cross-context ports.
- **R2 atomicity invariant** (`f59782f8`) — `maybeApplyStateChange` outer catch re-throws every `TxStageError` stage so savepoint rolls back atomically. Pre-R2 silently swallowed `quota_decrement` failures, committing partial state.
- **R3 emitOrThrow raw-throw wrap** (`7671fb94`) — `audit.emit()` raw throws (pool exhaust panic, sub-adapter regression) now convert to `TxStageError('audit_emit')` at the helper boundary instead of leaking up as plain `Error`.
- **R4 27-caller safeAuditEmit migration** (`cb00ed1a`) — every direct `audit.emit()` callsite across 12 F6 files migrated to `safeAuditEmit` helper; raw throws correctly classify as `audit_emit` in SRE alerts instead of `unknown`.

### Fixed

- **R2-2 toolbar a11y** — `useEffect` prop-sync to `initialSearch` + lifted `<output role="status">` live-region announcing result count (WCAG SC 4.1.3).
- **R2-7 observability split** — `!eventLookup.ok` branch separated from "non-eligible event" with dedicated `csvImportEventLookupFailed` metric + structured WARN log.
- **R3-D1 stale citations** — 5 cross-file line-number references replaced with grep-stable identifier references.
- **R4-C1 useEffect infinite-loop risk** — switched dep from `[searchParams]` (object identity, changes every render) to `[rawPaymentStatus]` (scalar value, stable); added try/catch around `router.replace` with console.warn fallback so navigation rejection doesn't stack toasts.
- **R4-C2 + R4-C3** — stale line citations re-introduced in R3 swept again (`pino-audit-port.ts:457` + `events-list-search-toolbar.tsx:5-6`).
- **R4-I4 disjointness check** — `Exclude<string, PaymentStatus>` was a TS no-op; replaced with proper `Extract<typeof X, Y> extends never ? true : false` assertion so future `PaymentStatus` addition matching `'__all__'` sentinel fails the build.
- **R4-N1** SV i18n `"Skicka ett testevenemang"` → `"Skicka en testhändelse"` — aligns with sibling phaseC.test.sendTest compound; `testhändelse` (test occurrence) is the technical-correct term for webhook payload.
- **R4-N2** TH i18n `"ไม่รู้จัก..."` → `"ไม่สามารถระบุ..."` — system-neutral register instead of colloquial.

### Technical Notes

- **Concurrency model**: per-(tenant, member, event) `eventcreate-quota:` advisory-lock namespace (disjoint from F4 `invoicing:` and F5 `payments:` namespaces).
- **Strict transactional reliability (FR-037)**: webhook handler treats each delivery as a single ACID unit; failure rolls back entire tx + emits `webhook_rolled_back` audit in SEPARATE post-rollback tx (observability never lost, Constitution Principle VIII upheld).
- **Two-mode ingest parity (FR-027)**: webhook + CSV share `processAttendeeInTx` helper so identical inputs produce identical persisted state regardless of ingest path.
- **R3-T1 fault-injection seam** at `pino-audit-port.ts` (NODE_ENV-gated) exercises the R3-C1 wrap on live Neon — proven via integration test capturing the `f6_csv_state_change_savepoint_rollback` audit on a forced raw-throw.
- **Constitution Principle I Review-Gate**: 4/4 cross-tenant search probes GREEN + 2-layer (application guard + Postgres RLS+FORCE) enforcement on every `tenant_id`-scoped read/write.
- **Compile-time exhaustiveness helpers**: `assertExhaustive(value: never): void` (pure compile-time, R3-F2) + `assertExhaustiveThrowing(value: never, context?): never` (R4-I5) consolidate 5 prior `const _exhaustive: never = x` sites.
- **Pre-flag-flip operator gates (6 outstanding)**: T150 security checklist co-sign / T151 reliability + UX + observability + integration checklists / T152 staging /speckit.qa.run with FEATURE_F6_EVENTCREATE=true / T153 SC-005 baseline measurement / T154 cron-job.org coordinator setup / T154a F8 port adapter live-wired verification.

---

## [F4] Invoicing & Thai-Tax Receipts (MVP slice) — 2026-04-19

**Spec**: [`specs/007-invoices-receipts/spec.md`](specs/007-invoices-receipts/spec.md)
**Plan**: [`specs/007-invoices-receipts/plan.md`](specs/007-invoices-receipts/plan.md)
**Final review**: [`specs/007-invoices-receipts/reviews/review-20260419-220541.md`](specs/007-invoices-receipts/reviews/review-20260419-220541.md) — ✅ APPROVED (R10 verified)
**Review history**: R1–R10 rounds; R10 closed 2 Blockers + 9 Warnings in commit `0eb49de`
**Spec adherence (MVP slice)**: US1 + US2 + US3 + US4 + kill-switch complete; US5/US6/US7 + Phase 10 polish deferred to follow-up PRs (CP-4.7 go/no-go decision)
**Test baseline**: 420 / 420 unit + 369 / 375 integration (5 skip + 1 intentional `test.todo`) on live Neon `ap-southeast-1` · 117 F4 i18n keys × EN/TH/SV · typecheck + lint clean · tenant-isolation Review-Gate blocker 17/17 green

### Added

- **US1 Issue Thai-tax-compliant invoice** — admin issues a bilingual (TH/EN) PDF invoice carrying legal identity snapshot + VAT calculation + Asia/Bangkok fiscal-year §87 sequential document number. Advisory-lock per `(tenant, document_type, fiscal_year)` + transactional atomicity guarantee no-gaps numbering under concurrent load.
- **US2 Record payment + receipt** — admin records payment, receipt PDF auto-generated with the frozen invoice snapshot. `payment_date` column persists the admin-entered date (not wall-clock).
- **US3 Member portal read** — member downloads own invoices + receipts from `/portal/invoices` with RLS + member-context ownership guard. PDF served byte-streamed with `Content-Disposition: attachment`.
- **US4 Tenant invoice settings** — admin configures legal identity + VAT rate + numbering prefixes + receipt numbering mode + fiscal-year start month + pro-rate policy + auto-email toggle + logo via `/admin/settings/invoicing`. Logo upload pipeline: sharp EXIF-strip + MIME whitelist + dimension bounds (200–2000 × 100–500) + pixel-bomb guard.
- **Kill-switch** — `FEATURE_F4_INVOICING=false` contains F4 end-to-end (routes + cron + outbox + UI).
- **5 new DB tables** — `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`. RLS + FORCE on every tenant-scoped row; immutability triggers on both `invoices` + `credit_notes`.
- **16 F4 audit event types** — draft/issue/pay/void lifecycle + cross-tenant probes + tenant-settings updates + PDF resends + delivery failures. All mutation use-cases emit in-transaction (Constitution Principle I clause 4).
- **Sarabun TTF font** committed under `public/fonts/sarabun/` — embedded into PDFs at render time for deterministic Thai rendering (SC-003 byte-identical re-renders).
- **Rate limiting** — `f4:issue:*` 20/5min, `f4:pay:*` 20/5min, `f4:settings:*` 30/min, `f4:settings:logo:*` 15/min per (tenant, actor).
- **Bounded context** `src/modules/invoicing/` with public barrel + `no-restricted-imports` enforcement per Principle III.

### Changed

- **R9 consolidation** — `tenant_fee_config` DROPPED; `tenant_invoice_settings` is now the single authoritative source for `currency_code` + `vat_rate` + `registration_fee_satang` + legal identity. Plans module reads VAT / currency via `getTenantTaxPolicy` facade. 27 test files migrated to the new seed helper (`seedTenantFiscal`).
- **List-plans VAT math** — replaced float `Math.round(fee * (1 + Number(rate)))` with integer `bigint` arithmetic (half-up rounding) so non-binary-clean VAT rates (8.5 %, 10 %, 13.5 %) produce satang-exact totals (FR-002 / FR-005).
- **Invoice settings form** — matches F3 member-form pattern with `<fieldset>` + `<legend>` card grouping per section (Currency, Identity, Tax, Numbering, Defaults, Logo); loading skeleton updated symmetrically to prevent CLS.
- **Bootstrap UX** — `/admin/invoices` now renders a "Configure Invoicing" empty-state CTA when `tenant_invoice_settings` is missing (FR-010).

### Fixed

- **N1 audit-tx gap** — `updateTenantInvoiceSettings` now wraps `upsert` + `audit.emit` in a single `withTx` so an audit failure rolls back the settings row (was separated across two queries).
- **N2 float VAT in list-plans** — see above.
- **N3 logo pixel-bomb + format confusion** — sharp `limitInputPixels` + detected-format (not client `declaredMime`) drives the encoder branch + upload `Content-Type`.
- **N4 loose zod at PATCH boundary** — strict regex + length caps mirror the use-case schema; PATCH body now validated at the HTTP boundary.
- **N5 missing rate limits** — added per-route rate-limiting to settings PATCH + logo POST.
- **N7 cross-tenant `logo_blob_key`** — server-side regex + explicit tenantId-prefix assertion prevents one tenant from embedding another's logo asset.
- **N11 locale-dependent `formatSatang`** — pinned to `'en-US'` across 4 sites (admin detail, admin list, admin form, portal list) to prevent C/POSIX server runtimes from emitting unseparated integers.
- **R7 blockers (all closed)** — PDF route streams bytes + `Content-Disposition: attachment` (B1); admin settings UI + logo pipeline (B2); portal invoice surfaces (B3); kill-switch containment (B4); bootstrap empty-state (B5); domain-helper VAT on draft preview (B6).

### Technical Notes

- **@js-joda/core + @js-joda/timezone** correctly resolve `Asia/Bangkok` fiscal-year boundaries regardless of server TZ — avoids the off-by-UTC-offset class of bug on Dec 31 23:30 invoices.
- **Blob storage** uses `access: 'public'` with UUID-keyed paths (`@vercel/blob` has no per-request signed URL API yet). Route layer byte-streams through the handler (no 307 redirect) to keep the URL from escaping the application. Residual documented in `security.md § T-05` with a tracked follow-up.
- **Expand-and-contract** schema migration pattern: `currency_code` added to `tenant_invoice_settings` first (R7 C1), readers migrated (C2–C4), then `tenant_fee_config` dropped in R9. Backfill migration guarantees every tenant with a pre-existing row got the new column.
- **Property-based testing** via `fast-check` (dev dep) — planned for credit-note VAT sum invariants in US6 (Phase 6).
- **Solo-maintainer substitute (Principle IX)** may be invoked for the security.md § 5 co-sign given the SweCham-only deployment context.

### Deferred to follow-up PRs

- **US5** void invoice + cancellation notice (Phase 9)
- **US6** credit notes (Phase 6) — `credit_notes` table + immutability trigger shipped; issuance flow deferred
- **US7** timeline integration with F3 member page (Phase 7)
- **Phase 10** auto-email dispatcher (T106), overdue derivation (T109), perf benchmarks (T110/T111/T111a), retention test (T112), manual SR/cross-browser/staging/reduced-motion passes (T114–T114c), docs (T115 quickstart update, T115a release notes), CI reproduction (T116), security co-sign (T117), review-rounds log (T118), retrospective (T119)
- **Carry-forward suggestions** T120–T124 — Host-header MTA dual-bind, CR/LF strip in `asciiSafe`, behavioral audit coverage for 3 event types, C4 end-to-end VAT chain test, fieldset-card a11y SR QA



**Spec**: [`specs/005-members-contacts/spec.md`](specs/005-members-contacts/spec.md)
**Plan**: [`specs/005-members-contacts/plan.md`](specs/005-members-contacts/plan.md)
**Final review**: [`specs/005-members-contacts/reviews/staff-review-20260417-190106-full-round4.md`](specs/005-members-contacts/reviews/staff-review-20260417-190106-full-round4.md) — ✅ APPROVED
**Final QA**: [`specs/005-members-contacts/qa/qa-20260417-191145.md`](specs/005-members-contacts/qa/qa-20260417-191145.md) — ✅ 473/473 tests pass
**Spec adherence**: 163/164 tasks (T158 staging perf is human-gated post-ship)
**Test baseline**: 244 unit + 123 integration (live Neon `ap-southeast-1`) + 106 contract + 13 E2E specs · 722 i18n keys × EN/TH/SV · typecheck + lint clean

### Added

- **Member CRUD (US1–US3)** — company legal-entity records with 20+ fields
  (tax ID with per-country Thai 13-digit + Luhn-8 + generic checksum validators,
  turnover/age/startup-duration policy gates, soft-delete with 90-day undelete
  window). Admin directory with TanStack Table v8 (server-side pagination,
  substring search via pg_trgm GIN, multi-column filter + sort, URL-synced
  query state, bulk actions ≤100 rows with rate limit 10-per-10-min per actor).
- **Contact CRUD with primary-contact invariant** — exactly one primary per
  member enforced by Postgres partial unique index + atomic demote-before-
  promote use case. Up to 5 additional secondary contacts.
- **US3.b email-change flow** — 6-step atomic Postgres transaction: update
  contact email + flip user `email_verified=false` + revoke all sessions +
  insert verification token + insert revert token + enqueue two outbox emails.
  Dual-channel revert-notification to the old address gives 48h takeover
  recovery window. Revert token resets password + re-verifies email.
- **Member invitation + portal access (US4)** — admin invites existing contact
  via F1 invitation flow, outbox dispatcher delivers email, F1 redeem binds
  `users.id` to `contacts.linked_user_id`. Secondary contacts can invite
  colleagues (US4 AS4 — primary-only gate).
- **Member self-service portal (US5)** — signed-in member sees own company +
  editable contact profile. Whitelist-enforced patch (firstName, lastName,
  phone, preferredLanguage only — any attempt to touch plan, status,
  `tenant_id`, `company_name`, etc. emits `member_self_update_forbidden`
  audit event + 403 response).
- **Member plan change (US6)** — admin-only `POST /api/members/[id]/change-plan`
  with turnover + startup-duration re-validation against the NEW plan,
  override-reason bypass for mid-year adjustments, bundle-change confirmation
  flow (Partnership tier → different corporate bundle requires explicit
  `confirm_bundle_change: true` after fetching affected count).
- **Archive + undelete with session/invitation cascade (US7)** — soft-delete
  with 90-day undelete window. Archive cascade atomically revokes all F1
  sessions of linked users + soft-consumes pending invitations (column-level
  SELECT grant on `invitations.id` prevents raw token exposure per R001).
  Deduped `user_sessions_revoked` audit per unique linked user (R002).
- **Timeline** — per-member event feed (joins `audit_log` + F1 `users` via
  tenant-scoped adapter), paginated.
- **Smart features** — command palette (extends F2 cmdk), inline + bulk edit,
  at-risk detection via `members.last_activity_at` (SECURITY DEFINER trigger
  bumps on every audit event with `member_id` in payload).
- **23 new F3 audit event types** (see `data-model.md § 4`).
- **Proactive outbox health observability (L1–L3)**:
  - **L1 metrics** — new `outboxMetrics.permanentFailure(notificationType)`
    emitted by the cron dispatcher on every `permanently_failed` flip
    (both `no_template_handler` + send-failure paths). Counters for alerting.
  - **L2 stuck-rows check** — inline in the same cron tick, queries
    `pending` rows whose `next_retry_at` is > 30 min past and emits
    `outboxMetrics.stuckRows(count)` + `logger.error('cron.outbox_dispatch.stuck_rows_detected')`.
    Catches "cron is down / CRON_SECRET rotated" class of outage.
  - **L3 `<OutboxHealthBadge>`** — async Server Component in the admin
    header (wrapped in `<Suspense fallback={null}>`). Amber alert icon +
    i18n tooltip (EN/TH/SV, 5 new keys) when `permanently_failed > 0`
    (last 24 h) or `stuck_pending > 0`. Renders nothing when healthy
    (zero noise). Gives admins visibility of email-delivery issues without
    requiring operator log-grep.

### Changed

- **T049 F1 invitation email flow** — migrated from synchronous Resend send
  inside `createUser` to outbox-backed async dispatch via
  `notifications_outbox` + `/api/cron/outbox-dispatch` (60s tick, 5 retries
  with exponential backoff 60s/5m/30m/3h/12h per FR-012c). Eliminates the
  "admin invite succeeds, email delivery fails silently" class of bug.
  Compensating `users.deletePending` rolls back the pending user row if
  invitation-row insert fails, so admin can retry with the same email.
- **F3 audit ownership consolidated in Application layer** — all 6
  previously-Infrastructure `tx.insert(auditLog)` sites in
  `drizzle-member-repo.ts` + `drizzle-contact-repo.ts` moved to their calling
  use cases via `AuditPort.recordInTx`. Repo ports are now pure CRUD;
  Application owns audit emission via `throw new UseCaseAbort` pattern for
  atomic state + audit rollback (Principle VIII).
- **`invite-colleague` atomicity upgrade** — add + linkUser + audit now in
  ONE tenant-scoped tx (previously 3 separate txs → orphan contact risk if
  linkUser failed after add committed).

### Fixed

- **Principle III violations in 4 Application files** — `change-contact-email`,
  `revert-contact-email`, `resend-verification-email`, `archive-member`
  previously imported Drizzle schemas directly from `@/modules/auth/infrastructure`.
  Now all route through ports (`AuditPort.recordInTx`,
  `ContactRepo.listLinkedUserIdsForMemberInTx`,
  `InvitationCascadePort.softConsumePendingForUsersInTx`).
- **W1 audit atomicity regression** — `runInTenant` callbacks used
  `return err(...)` on sub-step failures, which commits the tx in Drizzle
  instead of rolling back. Pattern unified to `throw new UseCaseAbort` +
  outer try/catch across `contact-crud`, `create-member`, `invite-colleague`,
  `member-self-update`. 9 regression guards locked in via
  `w1-tx-rollback.test.ts`.
- **Round-3 outbox hardening** — retry backoff parity between
  `no_template_handler` and send-failure paths (both now use
  `RETRY_BACKOFF_SECONDS[]` table, not hardcoded 300s). Null-tenant audit
  rows now land in the append-only table (was log-only). Dead `sql` import
  removed. Dev-mode unauthenticated drain now emits loud warn log.
- **Clear-test-data script FK handling** — explicit `DELETE FROM invitations
  WHERE user_id IN (...) OR invited_by_user_id IN (...)` before user delete
  (fixes `ON DELETE restrict` FK failure on `invitations_invited_by_user_id`).
- **E2E suite stability** — locale detection in `i18n/request.ts`, logger
  worker safety on Playwright boot, reduced-motion + target-size assertions,
  title-race fixes across 4 spec files.

### Technical Notes

- **2 new DB tables** (`members`, `contacts`) + migrations 0009–0017 (including
  RLS+FORCE policies, `pg_trgm` GIN index on `company_name` for SC-002 p95
  = 258 ms < 500 ms @ 5 k rows, `SECURITY DEFINER` trigger bumping
  `members.last_activity_at` from any audit event carrying `member_id` in
  payload, invitations column-level SELECT grant tightening for R001).
- **Constitution v1.4.0 Principle I Review-Gate** — 14/14 cross-tenant
  integration tests green (`tenant-isolation.test.ts`). Two-layer isolation:
  `runInTenant(ctx, fn)` application-layer wrapper + `SET LOCAL app.current_tenant`
  + `SET LOCAL ROLE chamber_app` (NOBYPASSRLS) + FORCE RLS policies on
  every tenant-scoped table.
- **New bounded-context module** `src/modules/members/` with Domain (entities,
  value objects, policies), Application (19 use cases, 10 ports), Infrastructure
  (Drizzle repos, Resend + outbox adapters, audit adapter, timeline repo).
  Public barrel `src/modules/members/index.ts` re-exports types + use cases.
- **New ports added this feature**: `ContactRepo` (6 InTx methods after S1),
  `AuditPort` (F3 event union of 23 types + `targetUserId` opt-in),
  `PlanLookupPort`, `EmailPort` (outbox-enqueue variant), `EmailChangeTokenPort`,
  `UserEmailPort`, `SessionRevocationPort`, `InvitationCascadePort`,
  `TimelinePort`, `ClockPort`.
- **WCAG 2.2 opportunistic adoption** — SC 2.4.11 (Focus Not Obscured) + SC
  2.5.8 (Target Size ≥24×24px) asserted via E2E specs. Button height raised
  32→36 px project-wide as part of F4 prerequisite.
- **Observability** — 12 new F3 metrics (members API latency, search latency,
  bulk rows-per-action, cross-tenant-probe counter, self-update-forbidden
  counter, email-change lifecycle counter, bundle-warning latency, outbox
  dispatch latency/failures, invite count, archive cascade cardinality) + 6
  new F3 SLOs + 3 runbooks (R-M01 member-data leak, R-M02 outbox poison-pill,
  R-M03 admin-compromise scenario) documented in `docs/observability.md § 14`.
- **Post-F3 backlog** — `auth_invitation_enqueue_failed_total` dashboard +
  alert wiring deferred until Grafana Cloud provisioned (F2+ roadmap),
  documented in `docs/observability.md § 15`.

---

## [F4] Page Layout Enterprise Standardization — 2026-04-13

**Spec**: [`specs/004-page-layout-standard/spec.md`](specs/004-page-layout-standard/spec.md)
**Plan**: [`specs/004-page-layout-standard/plan.md`](specs/004-page-layout-standard/plan.md)
**Retrospective**: [`specs/004-page-layout-standard/retrospective.md`](specs/004-page-layout-standard/retrospective.md)
**Spec adherence**: 100% (23/23 FRs + 14/14 SCs verified or scaffolded)
**Test baseline**: 578/578 unit+contract passing · 337 i18n keys × 3 locales · 15 E2E specs authored (execution in Ship pre-flight)

### Added

- **Three layout primitives** — `<PageHeader>` (title/subtitle/actions/badge, CSS logical properties),
  `<ContentContainer>` (admin 72rem / portal 64rem), `<BreadcrumbNav>` with `<BreadcrumbProvider>`
  (depth≥3 rule, mobile truncation, i18n labels, percent-encoded URL round-trip).
- **Route-level skeleton system** — 11 `loading.tsx` files + 6 shared skeleton primitives
  (`SkeletonBlock`, `CardSkeleton`, `FormSkeleton`, `TableSkeleton`, `DetailSkeleton`,
  `PageSkeletonShell`) + colocated `<ChangePasswordFormSkeleton>`. Single `role="status"` live
  region per page; shimmer CSS utility with automatic `prefers-reduced-motion` fallback.
- **Error boundaries** — `admin/error.tsx` + `portal/error.tsx` catch server-component
  failures, log via `error.digest`, render inside shell chrome, recoverable via `reset()`.
- **~30 CSS design tokens** — content max-widths, page padding, top-bar height, typography
  scale (h1–h4 + body + caption + `--line-height-th`), form-field / table / card / modal
  dimensions. Zero magic numbers in `src/components/layout`.
- **Semantic typography classes** — `.text-h1`–`.text-h4`, `.text-body`, `.text-caption`
  with `[lang="th"]` line-height override (Thai diacritic clearance).
- **Universal focus ring** — `@layer base *:focus-visible` fallback for unclassed elements;
  component-level `focus-visible:ring-*` owns the canonical ring on shadcn primitives.
- **ESLint FR-003 enforcement** — `no-restricted-syntax` rule blocks ad-hoc
  `max-w-*`/`mx-auto`/`container`/`p-*`/heading `text-*` classes on `page.tsx` root elements.

### Changed

- **Button `size="default"`**: 32px → 36px + `cursor-pointer` + `disabled:cursor-not-allowed`.
  Aligns with Input `--input-height` and WCAG 2.5.5 touch target.
- **11 admin + portal pages** migrated to the page-shell composition.
- **Suspense strategy**: internal `<Suspense>` removed from `/admin/plans/page.tsx` and
  `/admin/users/page.tsx`. Route-level `loading.tsx` is the sole boundary (load once,
  shimmer once — previous double-wrapping caused visible two-pass shimmer).
- **`/admin/users` data fetch** split into async `UsersDataSection` child with `Promise.all`
  parallel fetch (list + count).
- **FeeConfigForm save button** — full-width `size="lg"` to match `ChangePasswordForm` pattern.
- **shadcn/ui primitives** — `table.tsx` (sticky thead, focus-within mirrors hover, Thai
  line-clamp opt-in), `card.tsx` (tokens + dark-mode `--card-shadow` override),
  `dialog/alert-dialog/sheet.tsx` (modal tokens). Catalogued in `docs/shadcn-customizations.md`.

### Fixed

- **Hydration error**: PageHeader subtitle wrapper `<p>` → `<div>` (`ReactNode` may be a div).
- **Focus-ring corner flash**: removed `border-radius: 2px` override from `*:focus-visible`.
- **Focus-ring double-ring bug**: global rule moved to `@layer base` so component utilities
  win the cascade (sidebar / Button / Input no longer stack outline + ring).
- **Error boundary crash**: `t('retry')` was on the wrong namespace — now reads
  `buttons.retry` via a second translator.
- **Nested live regions**: only outer `<PageSkeletonShell>` carries `role="status"`;
  skeleton primitives just set `aria-busy`.
- **Breadcrumb URL round-trip**: raw segments drive `href`, decoded segments drive label
  lookup; query strings defensively stripped.
- **Plan detail typography**: 3 section `<h2 text-sm>` → `<h2 text-caption>` to match FR-017.

### Technical Notes

- **Clean Architecture (Principle III)**: Presentation-layer only. Zero touches to Domain,
  Application, or Infrastructure. `BreadcrumbProvider` is the sole client island.
- **Performance**: layout primitives are React Server Components — zero client JS added.
- **i18n**: +16 new keys since F3 → 337 keys × 3 locales.
- **Governance**: 4 staff-review rounds (25 findings resolved) + CLI QA (33/37 verified;
  14 deferred to Ship pre-flight) + constitution compliance check.
- **Deferred to Ship pre-flight** (retrospective L3): 32 E2E execution + visual-regression
  audits needing seeded test DB + `E2E_ADMIN_*` env. Matches F3 solo-maintainer pattern.

---

## [F2] Membership Plans — 2026-04-12

**Spec**: [`specs/002-membership-plans/spec.md`](specs/002-membership-plans/spec.md)
**Plan**: [`specs/002-membership-plans/plan.md`](specs/002-membership-plans/plan.md)
**Retrospective**: [`specs/002-membership-plans/retrospective.md`](specs/002-membership-plans/retrospective.md)
**Spec adherence**: 100% (21/21 functional requirements implemented)
**Test baseline**: 500/500 unit+contract + 165/165 integration (live Neon Singapore) + 296 i18n keys x 3 locales

### Added

- **Membership plan catalogue** — full CRUD admin surface at `/admin/plans`
  with 9 seeded SweCham 2026 plans (6 corporate + 3 partnership tiers).
  Filterable by category, year, active state, and free-text search. Shimmer
  skeleton in the exact table shape for CLS 0. Plan detail view with full
  benefit matrix grouped by Brand Visibility / Events / Additional / Partnership.
- **Year versioning + clone** — plans carry an explicit year attribute with
  composite PK `(tenant_id, plan_id, plan_year)`. "Clone 2026 to 2027" copies
  all active plans to a new year in one transaction. Idempotent — refuses if
  target year already has plans. Historical plans remain untouched.
- **4-step create wizard** — Basics, Fees, Benefits, Review with per-step
  zod validation. Partnership plan category automatically shows/hides the
  partnership benefits block and requires `includes_corporate_plan_id`.
- **Plan edit with prior-year lock** — current-year plans fully editable;
  prior-year plans enforce a partial lock (cosmetic fields editable, pricing /
  eligibility / benefits / scope frozen) with persistent banner + lock icons.
  Triple-layered enforcement: Domain + Application + Infrastructure defence-in-depth.
- **Activate / deactivate / soft-delete / undelete** — state machine
  `active <-> inactive -> soft_deleted -> (undelete) -> inactive`. Member
  attachment check prevents deleting plans with active members (F2 stub;
  F3 real implementation). "Show deleted" toggle reveals soft-deleted rows.
- **Per-tenant fee configuration** — currency code (THB), VAT rate (7%),
  registration fee (1,000 THB) editable at `/admin/settings/fees`. Currency
  code is immutable once plans exist (422 `currency_code_immutable_in_f2`
  with plan count). Manager read-only access.
- **Command palette** — `Cmd+K` / `Ctrl+K` opens a `cmdk`-based palette
  with plan search (3+ chars), grouped results (Plans / Actions / Navigate),
  keyboard navigation, role-filtered actions (admin-only items hidden from
  manager), lazy-load on first open (not mount), `preconnect` hint for
  cold-start mitigation. < 100ms warm open.
- **Multi-tenant infrastructure** — `src/modules/tenants/` cross-cutting
  Domain-only module with branded `TenantContext` type. `runInTenant(ctx, fn)`
  wraps every tenant-scoped transaction with `SET LOCAL app.current_tenant`.
  Postgres RLS on `membership_plans`, `tenant_fee_config`, and `audit_log`.
  `DEBUG_RLS_STATE` dev assertion catches "forgot runInTenant" bugs.
  10-assertion cross-tenant integration test (Review-Gate blocker).
- **10 new audit event types** — `plan_created`, `plan_updated`, `plan_cloned`,
  `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`,
  `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`. All carry
  structured `payload` JSONB with field-level before/after diffs.
- **Idempotency middleware** — `Idempotency-Key` header required on all
  mutations. 24h TTL in Upstash Redis. Replay on same key+body; 409 on
  same key + different body. Fail-open on Redis outage.
- **Benefit matrix editor** — grouped UI matching the PDF structure with
  7 Select dropdowns, 5 boolean switches, 3 numeric inputs, and a
  partnership-only section that auto-shows/hides based on plan category.
- **i18n** — 296 keys in EN + TH + SV. All Select option labels translated.
  Plan display names stored as structured `{en, th, sv}` locale map with
  missing-translation indicator for admin.
- **Keyboard-only E2E suite** — 6-spec Playwright test that covers the
  entire F2 admin surface using only `page.keyboard.press` (zero `.click()`
  or `.hover()` calls enforced by self-lint).

### Changed

- **Repository constitution v1.3.1 -> v1.4.0** (MINOR). SaaS pivot adds
  explicit tenant-isolation clause to Principle I (NON-NEGOTIABLE) with 5
  sub-clauses: application-layer, database-layer, integration test,
  audit, super-admin impersonation.
- **F1 RBAC policies** extended with `plan` + `fee_config` resources and
  `clone` action.
- **UI primitives** — `cursor-pointer` added to Button, Switch, SelectTrigger
  base classes.

### Fixed

- **Client bundle env leak** — `get-plan.ts` imported `@/lib/logger` which
  chain-pulled `@/lib/env.ts` (server-only) into the client bundle via barrel
  re-exports. Removed logger import; audit adapter logs internally.
- **Button-in-button hydration error** — `LockWrapper` was using a Radix
  `<Tooltip>` (renders `<button>`) around form controls (also `<button>`).
  Replaced with native `title` attribute tooltip.
- **Select label display** — Base UI Select requires `items` prop on
  `<Select.Root>` for `<SelectValue>` to show label instead of raw enum
  value. Added to all 11 Select components.

### Technical Notes

- **New modules**: `src/modules/tenants/` (Domain-only, branded TenantContext)
  + `src/modules/plans/` (full Clean Architecture bounded context with public
  barrel + ESLint boundary rule).
- **New DB tables**: `membership_plans` (composite PK), `tenant_fee_config`.
  Migrations 0006 (tables + RLS) + 0007 (audit_log extension) + 0008 (bigint).
- **Money storage**: integer minor units per field + single `currency_code`
  on `tenant_fee_config` (no per-plan currency — YAGNI per critique P3).
- **Deferred to F3**: US7 Inline Edit + Bulk Actions (critique X1c), US3 AS4
  partnership bundle-change warning (depends on F3 members table).

---

## [F1] Auth & RBAC — 2026-04-11

**Spec**: [`specs/001-auth-rbac/spec.md`](specs/001-auth-rbac/spec.md)
**Plan**: [`specs/001-auth-rbac/plan.md`](specs/001-auth-rbac/plan.md)
**Retrospective**: [`specs/001-auth-rbac/retrospective.md`](specs/001-auth-rbac/retrospective.md)
**Spec adherence**: 100% (47/47 requirements verified)
**Test baseline**: 480/480 green (288 unit+contract + 82 integration vs live Neon + 113/117 E2E across 3 browsers)

### Added

- **Email + password authentication** with two portals — staff (`/admin/sign-in`)
  for admin and manager roles, member (`/portal/sign-in`) for member role.
  Wrong-portal attempts return generic `invalid-credentials` for enumeration
  defence (FR-001, FR-004, T-03 mitigation).
- **Role-Based Access Control** with 3 roles (admin / manager / member) as a
  Postgres enum. Manager is read-only on every staff resource. Every protected
  route enforces RBAC at the proxy layer + a layout guard + an API guard
  (defence in depth) (FR-002, FR-003).
- **Self-service forgot-password flow** with single-use email tokens (1 h TTL),
  always-200 response (no enumeration), and a per-IP + per-email rate limit.
  Reset emails go through Resend with retry + webhook bounce detection
  (FR-005, FR-016, FR-025, T-04 mitigation).
- **Admin invitation workflow** — admins create new accounts via emailed
  invitation links (7 d TTL, single-use). Invitee sets their own password;
  admins never see it (FR-009).
- **Account lifecycle UI** — admins can disable / enable / change-role from
  `/admin/users` with confirmation dialogs. The DB-level
  `users_last_admin_protection` trigger guarantees the system never reaches
  zero active admins, even under concurrent writes (FR-010, FR-011, SC-009).
- **Self-change password** while signed in — current session continues
  uninterrupted, all OTHER sessions for the same user are revoked (FR-019,
  SC-021).
- **Password policy** — 12-character minimum + HaveIBeenPwned k-anonymity
  breach check; no plaintext storage anywhere (argon2id via `@node-rs/argon2`).
  ESLint rule blocks `===` on password variables (FR-006, FR-007, SC-018).
- **Lockout + brute-force defence** — 5 failed sign-ins per account in 15 min
  triggers a 15-min lockout. Per-IP and per-email rate limits via Upstash
  Redis with in-memory fail-open fallback (FR-013, SC-010).
- **17-event append-only audit trail** with DB-trigger immutability (UPDATE
  and DELETE blocked at the Postgres layer). 5-year retention. Captures all
  authentication events including invitation flows, password changes, role
  changes, lockout events, and webhook delivery (FR-012, SC-004, SC-011).
- **Session management** — 30 min idle timeout + 12 h absolute lifetime,
  HttpOnly + Secure + SameSite=Lax cookies, instant revocation on disable /
  password change / role change (FR-008, T-05 + T-06 mitigation).
- **Idle-warning modal** — fires 1 minute before the idle timeout with a
  live countdown and "Stay signed in" / "Sign out now" actions. The "Stay
  signed in" action heartbeats the server without a page reload (FR-022,
  SC-013).
- **Persistent user menu + sign-out** in every authenticated shell (staff +
  member portal) with display name, role badge, and theme toggle.
- **Tri-locale i18n** (English + Thai + Swedish) for every user-facing
  string on auth screens. Missing English fails the build; missing Thai or
  Swedish blocks release builds via `pnpm check:i18n` (FR-014, SC-007).
- **Enterprise UX standards** — skeleton shimmers with reduced-motion
  fallback, sonner toasts for success/error feedback, alert-dialog
  confirmation for destructive actions, designed empty + error states with
  request-ID for support correlation, full keyboard operability + skip-to-
  content link (FR-020, FR-021, FR-023, FR-024, SC-012, SC-014, SC-015,
  SC-016, SC-022).
- **Return-after-signin** preserves the originally-requested URL across the
  forced redirect (FR-017, SC-020).
- **PDPA + GDPR data model** supporting all 6 GDPR data subject rights and
  PDPA equivalents (FR-018). Operator-facing implementation tracked for a
  later admin feature; the data model + APIs do not foreclose any right.
- **CSRF protection** via Origin header allow-list on every state-changing
  POST / PUT / PATCH / DELETE under `/api/**`. SameSite=Lax cookies are
  defence-in-depth (T-07 mitigation).
- **Public auth module barrel** (`src/modules/auth/index.ts`) + ESLint
  `no-restricted-imports` rule blocking deep imports from outside the
  module. Constitution Principle III (NON-NEGOTIABLE Clean Architecture)
  is now enforced at commit time, not just at review time.
- **Operations runbook** — `docs/runbook/auth.md` (268 lines) covers the
  emergency kill-switch (`READ_ONLY_MODE`), lockout cleanup, audit-log
  forensics, and rollback procedure. `docs/runbook/gdpr-rights-verification.md`
  documents the data subject rights audit playbook.

### Changed

- **Repository constitution v1.2.0 → v1.3.0** (MINOR). Three additions
  driven by F1 lessons-learned (see Sync Impact Report at the top of
  `.specify/memory/constitution.md`):
  - Principle III (Clean Architecture) now requires every `src/modules/*`
    bounded context to ship a public barrel + ESLint boundary rule.
  - Principle IX (Code Quality) + Gate 9 (Review Gate) gain an explicit
    **solo-maintainer substitute clause** — when no second human reviewer
    is available, projects MAY substitute 5 independent automated checks
    (multiple `/speckit.review` passes, `/speckit.staff-review`
    triangulation, test coverage targets, DB-level defence-in-depth,
    post-remediation verification). Per-feature, reversible.
  - § Governance Amendment procedure gains a matching solo-maintainer
    substitute so single-maintainer projects are not locked out of
    amending their own governance rules.

### Fixed

(F1 is the first feature, so "Fixed" entries cover round-2 staff review
remediations rather than regressions against an earlier release.)

- **B-01 Clean Architecture violation** — `forgot-password.ts` was importing
  `buildResetPasswordEmail` as a value from Infrastructure, violating
  Principle III. Refactored to inject the function via `ForgotPasswordDeps`
  (type-only import) following the same pattern as `create-user.ts`.
- **B-02 Upstash fail-open had no test coverage** — added
  `tests/unit/auth/rate-limit/upstash-fail-open.test.ts` mocking
  `@upstash/ratelimit` to throw and asserting the in-memory cap +
  `redisFallback` metric. Closes `security.md § 5` item 12.
- **W-01 reset-password set-then-consume race** — `reset-password.ts` now
  marks the token consumed BEFORE writing the new password hash, closing
  a narrow replay window on process crash between the two writes.
- **W-02 last-admin race window** — added DB triggers `users_last_admin_protection`
  (migration 0003) and the `RETURN OLD` fix (migration 0004) to enforce
  the at-least-one-active-admin invariant at the Postgres layer,
  independent of any application bug. The application-layer guard
  remains in place as a first line of defence.
- **W-03 forgot-password rate-limit bypass** — `forgot-password.ts`
  now normalises the email via `asEmailAddress()` BEFORE computing the
  rate-limit bucket key, preventing whitespace / case bypass of the
  per-email bucket.
- **next-intl static rendering** — `RootLayout` now passes all four
  request props (`locale`, `messages`, `now`, `timeZone`) to
  `NextIntlClientProvider` so descendant client components see the
  context from the first render pass. Without this, dev mode threw
  `useTranslations context not found` warnings on every page load even
  though the page eventually rendered correctly on the client.
- **Resend hardcoded sender** — `resend-client.ts` extracted the
  `DEFAULT_FROM` value to a `RESEND_FROM_EMAIL` env var (with hardcoded
  fallback for backwards compatibility). Production now points at the
  verified `noreply@zyncdata.app` sender; future deployments can switch
  domains without code changes.

### Technical Notes

- **Stack**: Next.js 16 (App Router + Cache Components + Turbopack) on
  Node 22 LTS. TypeScript 5.7+ strict (`strict: true`,
  `noUncheckedIndexedAccess: true`). Drizzle ORM on Neon Postgres
  Singapore. Upstash Redis Singapore for rate limiting. Resend for
  transactional email. argon2id via `@node-rs/argon2`. shadcn/ui +
  Tailwind v4 + lucide-react. next-intl for SV / EN / TH. Vitest +
  Playwright + axe-core for tests. pino + `@vercel/otel` for
  observability.
- **Hosting**: Vercel `sin1` (Singapore) — documented deviation from
  Constitution "Thailand primary" because no major cloud provider has a
  Thailand region. PDPA Section 28 cross-border transfer rules cover the
  Singapore residency. See `specs/001-auth-rbac/plan.md` § Complexity
  Tracking deviation #1.
- **Test strategy**: integration tests run against live Neon Singapore
  (not a Docker container). The earlier Docker workflow in
  `quickstart.md § 5.2` was retired in favour of higher-fidelity tests
  against the same DB the dev server uses. See `plan.md` § Complexity
  Tracking deviation #2.
- **Solo-dev review substitute** (Constitution v1.3.0 Principle IX):
  the standard "≥2 reviewers on auth surfaces" rule was substituted with
  5 automated checks for F1 because SweCham is currently a single-
  maintainer project. The substitute is documented in `plan.md` §
  Complexity Tracking deviation #3 and signed off by the staff-review
  agent + solo maintainer in `security.md § 5`. The substitute is
  reversible — F2+ with a second maintainer reverts to the default rule.

### Deferred to release QA / future features

- **T167** — dedicated `tests/e2e/skeleton-cls.spec.ts` is **superseded**
  by `lighthouserc.json` Lighthouse CI which enforces the same `CLS = 0`
  budget on every PR (a stronger guarantee than a single Playwright
  assertion).
- **T181** — Vercel Analytics dashboard panel creation is a manual click-
  through against the Vercel Observability UI; the metric queries are
  documented in `docs/runbook/auth.md § 2.1-2.5` and
  `docs/observability.md § 7.1`. Operator follows that playbook during
  release QA.
- **T187** — `pnpm quickstart validation` end-to-end on a staging Vercel
  preview deploy; covered by the post-deploy smoke test in this release
  workflow.

---
