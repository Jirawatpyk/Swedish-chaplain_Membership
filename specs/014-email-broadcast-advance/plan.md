# Implementation Plan: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Branch**: `014-email-broadcast-advance` | **Date**: 2026-05-17 (split to F7.1a on 2026-05-18) | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/014-email-broadcast-advance/spec.md`
**Scope decision**: Strategy B per `critiques/critique-20260518-003047.md` — F7.1 8-US bundle split into F7.1a (US1+US2, this plan) + F7.1b backlog ([`f71b-backlog.md`](./f71b-backlog.md), promoted later).

---

## Summary

F7.1a is a **3-user-story release** picking up the two P1-priority deferrals from the F7 MVP retrospective PLUS the lowest-risk P2 enhancement: (US1) lifting the recipient-list ceiling from 5,000 → 50,000 via per-batch parallel dispatch (concurrency cap 4); (US2) re-enabling `<img>` embedding with a tenant-managed source allowlist + inline upload via Vercel Blob + virus-scan via self-hosted ClamAV; (US7) admin-authored multi-template library with snapshot semantics + **5 starter templates seeded per tenant at ship** (Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You × EN+TH+SV — maintainer-authored content; admins refine post-ship).

The original F7.1 8-US scope was split to F7.1a + F7.1b on 2026-05-18 per critique recommendation (Strategy B). US7 was promoted BACK into F7.1a after maintainer committed to writing starter content directly (no compliance-liaison-blocker); the remaining 5 USs (US3, US4, US5, US6, US8) wait 4-6 weeks for F7 MVP + F7.1a production data before promotion. F7.1a ships the two P1 USs with strongest evidence (5k cap = TAM ceiling; `<img>` strip = top UX complaint) + the one P2 with cheapest engineering (US7 reuses 100% F7 MVP infra: same sanitiser, dispatch, audit).

**Technical approach**: F7.1a extends the F7 MVP bounded context (`src/modules/broadcasts/`) — same Resend Broadcasts API surface, same dispatch/webhook/audit/retention machinery, same Clean Architecture layering. **3 new entities** (`BatchManifest` for US1, `TenantImageSourceAllowlist` for US2, `BroadcastTemplate` for US7) layer onto the existing broadcast row without breaking the F7 MVP schema. The one new operational dependency is **self-hosted ClamAV** (Clarifications Q2) deployed as a **Fly.io `sin`-region persistent micro-VM** running `clamav/clamav:stable` (~$2/month or free tier). Tenant isolation (Principle I NON-NEGOTIABLE) preserved by `tenant_id` + `runInTenant()` + RLS + FORCE on every new table. The 4 Clarifications applicable to F7.1a are resolved; zero NEEDS CLARIFICATION markers; Constitution Check has **4 Complexity Tracking entries** (CT #1 ClamAV + CT #2 retry loop + CT #3 solo-maintainer substitute + CT #4 TDD retrofit on T045/T046/T056/T057 added in Phase 3F.11.7).

Ships dark behind `FEATURE_F71A_BROADCAST_ADVANCED=false` until operator/maintainer gates pass, with each US-level capability ALSO independently flag-gated (`FEATURE_F71A_US1_PAGINATION`, `FEATURE_F71A_US2_IMAGES`, `FEATURE_F71A_US7_TEMPLATES`).

---

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1–F8.
**Runtime**: Node.js 22 LTS (Fluid Compute) on Vercel `sin1` (Singapore).
**Primary Dependencies**:
- **Existing (reused)**: Next.js 16 App Router · React 19 · Drizzle ORM · Postgres (Neon `ap-southeast-1`) · `@vercel/blob` (asset storage from F4) · `resend` (Broadcasts API from F7 MVP) · `next-intl` (EN/TH/SV) · `shadcn/ui` + Tailwind v4 · `pino` + `@vercel/otel` · `react-hook-form` + `zod` · `isomorphic-dompurify` (F7 MVP sanitiser)
- **New (F7.1a)**: **`clamscan@^2.4`** — Node.js bindings for self-hosted ClamAV (client side talks to the daemon — daemon itself runs on Fly.io). **`@types/clamscan@^2`** — DefinitelyTyped declarations (clamscan ships JS-only; required for `pnpm typecheck` pass on `scripts/verify-clamav-connectivity.ts` + future Phase 2 T025 adapter). **`@tiptap/extension-image@3.22.5`** — re-enables the `<img>` extension in the existing Tiptap editor (F7 MVP shipped Tiptap with `<img>` disabled). **Exact-pinned** (not `^3.22.5`) because `^` resolves to 3.23.x which has an unmet peer-dep on `@tiptap/core@3.23.x` — F7 MVP's pinned `@tiptap/core@3.22.5` (via `@tiptap/react@3.22.5` + `@tiptap/starter-kit@3.22.5`) cannot satisfy that without a MAJOR upgrade. Pinning to 3.22.5 keeps Clarifications round 3 Q2's "clean extension-add, no MAJOR upgrade work" invariant.
- **New infrastructure (F7.1a)**: **Fly.io persistent micro-VM** in `sin` region running `clamav/clamav:stable` image (`clamd` daemon + `freshclam` in-container). Ships in F7.1a PR as `infra/clamav/fly.toml` + `infra/clamav/Dockerfile` (≤20 LoC each). Cost ~$2/month or free tier. Daemon model preserves FR-013 latency SLO (≤500ms p95 for files ≤2 MB) — incompatible with the originally-sketched "Vercel Function sidecar" approach per audit C2.

**Storage**:
- Neon Postgres `ap-southeast-1` (Singapore) — extend `broadcasts` table (5 new columns: `manual_retry_count`, `partial_delivery_accepted_at`, `partial_delivery_accepted_by_user_id`, `started_from_template_id` FK, `template_name_snapshot`); add 4 new tables (`broadcast_templates`, `broadcast_batch_manifests`, `tenant_image_source_allowlist`, `tenant_broadcast_settings` — last one is CREATE not EXTEND per Phase 2 Risk R2); seed 5 starter templates × 3 locales = 15 rows per tenant via migration 0168 (renumbered from 0134 Phase 2 2026-05-18; 012-eventcreate-integration concurrently occupied 0127-0160 on the shared Neon main branch — F14 migrations land at 0161-0168 to follow 012's contribution).
- Vercel Blob (private bucket) — inline image storage (US2 FR-012). Co-terminate retention with broadcast row.
- New audit-event types: **10 new types** (catalogue in research.md § 7). All at 5-year retention.

**Testing**: Vitest (unit + contract) · Playwright + `@axe-core/playwright` (e2e + WCAG 2.1 AA) · MSW (HTTP mocking) · live Neon Singapore for integration tests (no Docker) · live ClamAV (Docker `clamav/clamav:stable` in dev) for scan-flow integration.

**Target Platform**: Web (admin portal + member portal) — Chrome / Firefox / Safari / Edge desktop + Safari iOS + Chrome Android (mobile-first per Principle VI). Email rendering verified on Gmail (web + iOS + Android), Outlook (web + desktop), Apple Mail (macOS + iOS), Thunderbird, Yahoo Mail.

**Project Type**: web-service (Next.js App Router monolith with multi-tenant SaaS posture per Constitution v1.4.0 Principle I).

**Performance Goals** (per spec § SC):
- **SC-001 (US1)**: 10k-recipient broadcast end-to-end dispatch ≤10 min; zero duplicates.
- **SC-002 (US1)**: 50k-recipient broadcast end-to-end dispatch ≤45 min; all per-batch failures recoverable.
- **SC-005 (US2)**: ClamAV scan latency ≤500ms p95 for files ≤2 MB.
- Routes-level budgets per F7 MVP carry forward: compose TTFB <600ms · submit <1.2s · approve&send <1.5s · webhook <250ms · unsubscribe <400ms.

**Constraints**:
- **Tenant isolation (Principle I NON-NEGOTIABLE)** — every new row carries `tenant_id`; every new query runs under `runInTenant()`; every US ships ≥1 cross-tenant probe integration test (Review-Gate blocker).
- **PCI DSS (Principle IV)** — N/A. F7.1a touches no card data.
- **Resend Broadcasts API limits** — per-audience cap 10,000 recipients (defines US1 batch boundary); account-level rate limit (defines US1 default concurrency cap 4).
- **Vercel Function execution timeout**: 300s default. Per-batch dispatch fits.
- **Singapore hosting** — F1 deviation carries forward.

**Scale/Scope**: SweCham today is ~131 members (well under the 50k US1 ceiling). The 50k ceiling is provisioned for **future tenants** (chambers up to ~50k members with margin). At F7.1a-ship + 12 months: estimated 3-5 tenants, peak combined ~50 broadcasts/day, peak ClamAV scan volume ~50-100 image uploads/day across all tenants. Fly.io free-tier VM (256 MB) targets 250 scans/day = 2-5× headroom.

---

## Constitution Check

*Source: `.specify/memory/constitution.md` v1.4.0*

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security** — F7.1a preserves the F7 MVP tenant-isolation posture: every new table carries `tenant_id` + RLS + FORCE policies (data-model.md § 2); every new use-case runs under `runInTenant(ctx, fn)`; every US ships ≥1 cross-tenant probe integration test; audit log captures `tenant_id` on every new event type; 10 new audit event types catalogue in research.md § 8; cross-tenant access attempts emit `broadcast_cross_tenant_probe`. **OWASP Top 10**: XSS via `<img>` allowlist (US2 — mitigated via FR-014 scheme + event-handler stripping AND FR-011 hostname allowlist); SSRF via image-upload server-fetch (US2 — mitigated by uploading to chamber asset bucket only, never fetching external URLs server-side); filename-XSS on attachment-detail surfaces (US2 — FR-013 sanitises filename at upload boundary); broken-access-control on allowlist admin surface (FR-010 — admin role check enforced at use-case boundary). **TLS 1.2+** unchanged. **At-rest encryption** — Vercel Blob AES-256 by default; Postgres at-rest encryption per Neon's platform default. ✅ PASS.

- [x] **II. Test-First Development** — TDD discipline preserved per F7 MVP precedent. Each US ships: (a) ≥1 acceptance-level Vitest contract test authored RED before the use-case implementation; (b) ≥1 integration test against live Neon Singapore covering the cross-tenant probe + the happy-path resolver; (c) ≥1 Playwright e2e test for the new UI surfaces under axe-core a11y + reduced-motion + i18n locales. **Coverage targets**: Domain layer 100% line (batch boundary calculator, image-source allowlist matcher); Application layer 80% line + 80% branch; **100% branch on security-critical paths** (Principle II): `validateImageSourceAllowlist`, `enforceCrossTenantIsolation`, `scanInlineImageForVirus`. Live Neon Singapore for integration — no mocks for database. ✅ PASS.

- [x] **III. Clean Architecture** — Layers preserved: Domain (`src/modules/broadcasts/domain/`) gets new value objects (BatchBoundary, ImageSourceAllowlist) + new aggregate methods on `Broadcast` (`splitIntoBatches`, `recordPartialSend`, `retryFailedBatches`) — zero framework/ORM/HTTP imports verified by existing ESLint `no-restricted-imports` rule. Application layer gets ~9 new use-cases (catalogue in data-model.md § 4). Infrastructure gets ClamAV adapter (implements VirusScannerPort), Tiptap image-extension adapter, Vercel Blob image-upload adapter, Drizzle repo extensions for 2 new tables. **Module barrel** at `src/modules/broadcasts/index.ts` extends with new public surface. **No cross-module schema changes in F7.1a** (CT #3 from original F7.1 was the F3 contacts mutation — that belongs to US3 which is deferred to F7.1b). ✅ PASS.

- [x] **IV. Payment Security (PCI DSS)** — N/A. F7.1a touches no card data. ✅ PASS (vacuously).

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (EN/TH/SV)** — All new user-facing strings (admin batch breakdown UI, admin retry confirmation + accept-partial modal, admin image-source allowlist editor, member inline-image uploader + size-cap error + scan-pending banner, ClamAV unreachable banner, admin template library + editor surfaces, member template picker + stale-draft banner + bracketed-placeholder microcopy, 10 audit-event display strings) ship with EN + TH + SV keys from day one. **~150-200 new i18n keys estimated** (down from original F7.1 8-US estimate of ~600-700; F7.1a is ~25-30% of F7.1's user-facing surface). `pnpm check:i18n` enforces parity at CI; release-branch builds fail on missing TH or SV keys. ✅ PASS.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + UX Consistency)** — All new surfaces designed mobile-first from 320px width; axe-core WCAG 2.1 AA scan on every new page (SC-008); semantic HTML (admin batch breakdown is a `<details>/<summary>` collapsible; retry confirmation is a `<dialog role="alertdialog">`; image upload progress is `<progress>` with `aria-label`); `prefers-reduced-motion` respected on per-batch progress bar; `prefers-color-scheme` respected via existing `next-themes` integration. **WCAG 2.2 opportunistic adoption**: SC 2.4.11 (Focus Not Obscured) verified on retry confirmation modal; SC 2.5.8 (Target Size ≥24×24px) verified on image-upload + allowlist-add buttons. **Manual SR QA gate** on at least one major screen reader (NVDA or VoiceOver) per SC-008. Shared component library: shadcn/ui (Dialog, AlertDialog, Form, Table from F3) — zero net-new shadcn primitives required. ✅ PASS.

- [x] **VII. Performance & Observability** — SLO budgets defined per US in spec § SC; aggregate budget table in research.md § 6. **OpenTelemetry instrumentation** extends F7 MVP's 18 metrics + 11 alerts + 5 spans: F7.1a adds **5 new metrics** (`broadcasts.batch_dispatch_duration_ms{tenant,batch_index}`, `broadcasts.partial_send_count{tenant}`, `broadcasts.manual_retry_count{tenant,broadcast_id}`, `broadcasts.image_scan_duration_ms{tenant,verdict}`, `broadcasts.clamav_signature_age_hours{}` probed via `CLAMD VERSION` socket call) + **4 new alerts** (clamav_signature_age >48h critical, clamav_daemon_unreachable >2min critical, partial_send_rate >5% warn, dispatch_concurrency_saturation >80% warn) + **3 new runbooks** under `docs/runbooks/` (clamav-signature-stale, clamav-daemon-down, broadcast-partial-send-recovery). **Structured logs** (pino) emit per-batch dispatch + per-image-scan events at INFO level; sensitive fields (image bytes, attachment-bucket signed URLs) NEVER logged. **Distributed tracing** spans for: batch-split → parallel-dispatch → per-batch-webhook (US1); upload → virus-scan → bind-to-draft (US2). ✅ PASS.

- [x] **VIII. Reliability (Error Handling + Data Integrity + Audit Trail)** — Every error path explicit per existing `Result<T,E>` discipline. Transactional boundaries: (a) batch-split + initial-dispatch runs in a single transaction creating N `batch_manifest` rows AND the per-batch advisory lock acquisitions atomically; (b) retry-failed-batches runs under a per-broadcast advisory lock (`broadcasts-retry:` namespace) to serialise concurrent admin retry attempts per FR-008d. **Idempotency**: per-batch dispatch carries an `idempotency_key` of `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}` (extension of F7 MVP pattern); webhook handler is idempotent (uses Resend's `event.id` + Svix message-id deduplication from F7 MVP); image upload is idempotent on content-hash. **Append-only audit trail**: 7 new event types catalogued in research.md § 7. **Audit retention** 5 years for all new event types. **Per-tenant advisory-lock namespaces**: F7.1a uses TWO new namespaces — `broadcasts-batch:` (per-batch TOCTOU guard) and `broadcasts-retry:` (per-broadcast retry serialisation) — both disjoint from F7 MVP `broadcasts:` namespace. ✅ PASS.

- [x] **IX. Code Quality Standards** — TypeScript strict — unchanged. ESLint clean (extending existing `no-restricted-imports` rule to cover new sub-paths under `src/modules/broadcasts/`). Conventional Commits enforced. **Solo-maintainer substitute** (Principle IX substitute) — F7.1a is built under the same solo-dev posture as F1–F8; substitute stack per CT #3 (was CT #5 in original F7.1): (a) ≥3 `/speckit.review` passes; (b) ≥1 `/speckit.staff-review` round with 3 independent agents; (c) coverage thresholds met + live-Neon integration tests; (d) DB-level defence-in-depth via RLS + FORCE + CHECK constraints; (e) post-remediation independent re-review by a fresh agent run. ✅ PASS (via solo-maintainer substitute documented in Complexity Tracking entry #3).

- [x] **X. Simplicity (YAGNI)** — F7.1a adds **1 new external runtime dependency** (ClamAV daemon on Fly.io VM; `clamscan@^2.4` Node binding on client side) + **1 reactivation of an existing dep** (Tiptap `<img>` extension) + **1 new managed service** (Fly.io micro-VM, ~$2/mo or free tier). One new cron-job.org coordinator is **not needed** (ClamAV signatures self-refresh in-container; F7 MVP cron set unchanged at 5 coordinators). All other new functionality reuses existing primitives: Vercel Blob (F4), advisory locks (F4 + F5 + F7 MVP), `runInTenant()` (F2+), audit-event taxonomy + retention column (F5 + F7 MVP), `next-intl` + check-i18n CI gate (F1+), shadcn primitives (no net-new), Drizzle migrations (numbered **0161+** continuing from 012-eventcreate-integration's 0160, which itself continued from F8 PR #24's 0126 — F14 was renumbered from 0127-0134 to 0161-0168 on 2026-05-18 to land after 012's concurrent F6 + F1 hardening contribution). **Strategy B scope reduction** (this plan revision) removed 6 user stories worth of speculative engineering — the F7.1b backlog preserves the work for promotion if production data validates demand. **Complexity Tracking entries**: 3 (down from 5; CT #3 F3 schema mutation + CT #4 PII detector deferred with F7.1b). ✅ PASS (with documented deviations).

---

## Project Structure

### Documentation (this feature)

```text
specs/014-email-broadcast-advance/
├── plan.md                  # This file (F7.1a)
├── spec.md                  # F7.1a spec (3 USs)
├── f71b-backlog.md          # 6 deferred USs preserved for future promotion
├── research.md              # F7.1a Phase 0 output
├── data-model.md            # F7.1a Phase 1 output
├── quickstart.md            # F7.1a dev setup
├── contracts/
│   ├── batch-dispatch.md    # US1
│   ├── image-upload.md      # US2
│   └── deferred-f71b/       # 6 deferred contracts preserved for F7.1b
│       ├── broadcast-attachment.md
│       ├── broadcast-template.md
│       ├── contact-broadcast-opt-in.md
│       ├── pii-detector.md
│       ├── saved-segment.md
│       └── tracking-settings.md
├── checklists/
│   └── requirements.md      # F7.1a quality checklist
├── critiques/
│   └── critique-20260518-003047.md  # Strategy B source
└── tasks.md                 # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root) — F7.1a-only paths

```text
src/
├── modules/
│   └── broadcasts/                                # F7 MVP bounded context — F7.1a extends
│       ├── domain/
│       │   ├── broadcast.ts                       # F7 MVP — extend with splitIntoBatches, recordPartialSend
│       │   ├── value-objects/
│       │   │   ├── batch-boundary.ts              # NEW (US1)
│       │   │   └── image-source-allowlist.ts      # NEW (US2)
│       │   └── policies/
│       │       └── batch-concurrency-policy.ts    # NEW (US1)
│       ├── application/
│       │   ├── ports/
│       │   │   ├── virus-scanner-port.ts          # NEW (US2)
│       │   │   └── image-allowlist-port.ts        # NEW (US2)
│       │   ├── use-cases/
│       │   │   ├── split-broadcast-into-batches.ts        # NEW (US1)
│       │   │   ├── dispatch-broadcast-batch.ts            # NEW (US1)
│       │   │   ├── retry-failed-batches.ts                # NEW (US1)
│       │   │   ├── accept-partial-delivery.ts             # NEW (US1)
│       │   │   ├── validate-image-source-allowlist.ts     # NEW (US2)
│       │   │   ├── upload-inline-image.ts                 # NEW (US2)
│       │   │   └── manage-image-allowlist.ts              # NEW (US2)
│       │   └── services/
│       │       └── batch-dispatcher.ts            # NEW (US1) — orchestrates concurrency cap
│       ├── infrastructure/
│       │   ├── clamav-virus-scanner.ts            # NEW (US2 — implements VirusScannerPort)
│       │   ├── clamav-endpoint-resolver.ts        # NEW (US2 — resolves CLAMAV_HOST for prod/dev/staging)
│       │   ├── tiptap-image-extension-config.ts   # NEW (US2 — Tiptap config wiring)
│       │   ├── drizzle-image-allowlist-repo.ts    # NEW (US2)
│       │   ├── drizzle-batch-manifests-repo.ts    # NEW (US1)
│       │   ├── vercel-blob-image-storage.ts       # NEW (US2 — adapts F4 Vercel Blob client)
│       │   └── schema.ts                          # EXTEND (4 new columns on broadcasts + 3 new tables incl. broadcast_templates + 1 column on tenant_broadcast_settings)
│       └── index.ts                               # EXTEND barrel
├── app/
│   ├── (staff)/admin/
│   │   ├── broadcasts/
│   │   │   ├── [id]/page.tsx                      # EXTEND F7 detail — batch breakdown + retry actions
│   │   │   ├── settings/page.tsx                  # NEW — image-source allowlist editor
│   │   │   ├── templates/page.tsx                 # NEW (US7) — template library list
│   │   │   ├── templates/new/page.tsx             # NEW (US7) — admin template authoring
│   │   │   └── templates/[id]/edit/page.tsx       # NEW (US7) — admin template editing
│   ├── (member)/portal/
│   │   └── broadcasts/
│   │       └── new/page.tsx                       # EXTEND F7 compose — inline image upload
│   └── api/
│       └── cron/broadcasts/
│           └── dispatch-batches/route.ts          # NEW (US1 — dispatches queued batches; runs every 5 min)
│   (NOTE: ClamAV signature refresh is handled by `freshclam` INSIDE the Fly.io container — NO cron endpoint needed.)
├── components/
│   └── broadcasts/
│       ├── compose-inline-image-uploader.tsx      # NEW (US2)
│       ├── admin-batch-breakdown.tsx              # NEW (US1)
│       ├── admin-retry-confirmation.tsx           # NEW (US1)
│       ├── admin-accept-partial-modal.tsx         # NEW (US1)
│       ├── admin-image-allowlist-editor.tsx      # NEW (US2)
│       ├── admin-template-library.tsx             # NEW (US7 — list with "Starter" badges per critique P6 + filter pills "Starter only / Admin-authored / All")
│       ├── admin-template-editor.tsx              # NEW (US7 — Tiptap editor reuse + name/subject form)
│       ├── compose-template-picker.tsx            # NEW (US7 — shadcn Combobox per critique X3/E8 with locale-cascading filter + MRU ordering)
│       ├── compose-bracket-placeholder.tsx        # NEW (US7 / critique P4 — Tiptap node-view rendering [bracketed text] with grey dashed-border style + first-use microcopy)
│       ├── compose-stale-draft-banner.tsx         # NEW (US7 / critique E5 — "Template updated" banner with optional re-snapshot CTA on drafts >30d old)
│       ├── admin-template-edit-confirm-starter.tsx # NEW (US7 / critique P6 — confirmation banner when editing a starter template)
│       └── clamav-unreachable-banner.tsx          # NEW (US2 — error-state UX per critique P10)
└── i18n/messages/
    ├── en.json                                    # EXTEND ~150-200 new keys
    ├── th.json                                    # EXTEND ~150-200 new keys (mandatory)
    └── sv.json                                    # EXTEND ~150-200 new keys (mandatory)

infra/                                              # NEW top-level dir for F7.1a
└── clamav/
    ├── fly.toml                                   # Fly.io app config (sin region, shared-cpu-1x 256MB)
    ├── Dockerfile                                 # Extends clamav/clamav:stable; enables clamd TCP listener
    └── README.md                                  # Deploy + monitor instructions

scripts/                                            # NEW scripts for F7.1a (per critique E2/X2)
├── generate-template-seed-migration.ts            # READS starter-templates.md → EMITS 0168_f71a_default_template_seed.sql (renumbered from 0134 Phase 2)
│                                                  # CI runs `pnpm tsx scripts/generate-template-seed-migration.ts --check`
│                                                  # which regenerates SQL + diffs against committed migration.
│                                                  # Single source of truth = starter-templates.md.
│                                                  # Resolves starter-templates ↔ migration drift risk per critique E2/X2.
└── verify-clamav-connectivity.ts                  # NEW (per quickstart § 6) — self-test ClamAV adapter

drizzle/migrations/
├── 0161_f71a_broadcast_templates.sql              # NEW — template library table (must precede broadcasts FK); renumbered from 0127 Phase 2
├── 0162_f71a_broadcast_extensions.sql             # NEW — broadcasts table extensions (5 new columns incl. started_from_template_id FK + template_name_snapshot); renumbered from 0128
├── 0163_f71a_broadcast_batch_manifests.sql        # NEW — batch tracking table; renumbered from 0129
├── 0164_f71a_tenant_image_source_allowlist.sql    # NEW — per-tenant image allowlist + system-seed defaults; renumbered from 0130
├── 0165_f71a_tenant_broadcast_settings.sql        # NEW — CREATE tenant_broadcast_settings table (NOT "ext" — table did not exist in F7 MVP per Phase 2 Risk R2); renumbered from 0131
├── 0166_f71a_rls_policies.sql                     # NEW — RLS + FORCE on 4 new tables; renumbered from 0132
├── 0167_f71a_audit_event_grants.sql               # NEW — 10 new audit event types; renumbered from 0133
└── 0168_f71a_default_template_seed.sql            # NEW — seed 5 starter templates × 3 locales per tenant (FR-020); renumbered from 0134

tests/
├── contract/broadcasts/
│   ├── batch-dispatch.test.ts                     # NEW (US1)
│   ├── retry-failed-batches.test.ts               # NEW (US1)
│   ├── accept-partial-delivery.test.ts            # NEW (US1)
│   ├── concurrent-retry-race.test.ts              # NEW (US1 SC-007 — advisory-lock race)
│   ├── cancel-broadcast-batch-halt.test.ts        # NEW (US1 FR-004 — per analyze round 2 N3; cancel halts pending batch_manifests; audit payload extended)
│   ├── image-source-allowlist.test.ts             # NEW (US2)
│   ├── upload-inline-image.test.ts                # NEW (US2)
│   ├── manage-image-allowlist.test.ts             # NEW (US2)
│   ├── create-broadcast-template.test.ts          # NEW (US7)
│   ├── update-broadcast-template.test.ts          # NEW (US7)
│   ├── delete-broadcast-template.test.ts          # NEW (US7)
│   ├── snapshot-template-to-draft.test.ts         # NEW (US7 SC-007a — snapshot decoupling assertion)
│   ├── template-variable-substitution.test.ts     # NEW (US7 / critique E9 — verifies {{chamber_name}} substitute + bracket literal preservation)
│   ├── template-save-image-allowlist.test.ts      # NEW (US7 × US2 / critique E9 — template body sanitiser rejects non-allowlisted <img src>)
│   └── template-render-html-escape.test.ts        # NEW (US7 / critique E6+E9 — XSS via {{chamber_name}} = tenant.display_name escape verification)
├── integration/broadcasts/
│   ├── pagination-cross-tenant-probe.test.ts      # NEW (US1 — Principle I Review-Gate blocker)
│   ├── image-allowlist-cross-tenant-probe.test.ts # NEW (US2)
│   ├── pagination-7500-end-to-end.test.ts         # NEW (US1 — non-env-gated CI smoke per critique E11)
│   ├── pagination-50k-end-to-end.test.ts          # NEW (US1 SC-002 — env-gated perf bench)
│   ├── image-virus-scan-flow.test.ts              # NEW (US2 — live ClamAV in Docker)
│   ├── template-cross-tenant-probe.test.ts        # NEW (US7)
│   ├── template-snapshot-decoupling.test.ts       # NEW (US7 SC-007a — template edit doesn't mutate existing drafts)
│   └── starter-template-seed.test.ts              # NEW (US7 SC-007b — post-migration 0168 (renumbered from 0134 Phase 2) integrity check)
├── unit/broadcasts/
│   ├── batch-boundary.test.ts                     # NEW (US1)
│   └── image-source-allowlist.test.ts             # NEW (US2)
└── e2e/broadcasts/
    ├── pagination-batch-breakdown.spec.ts         # NEW (US1 + axe-core + reduced-motion)
    ├── image-upload-allowlist.spec.ts             # NEW (US2 + axe-core)
    └── template-library-flow.spec.ts               # NEW (US7 + axe-core — admin CRUD + member picker + snapshot)
```

**Structure Decision**: F7.1a extends the F7 MVP bounded context in place — no new bounded context. The **8 migrations (0161–0168)** layer onto the existing F7 MVP schema (22 migrations 0064–0085) + F8 schema (41 migrations 0086–0126) + 012-eventcreate-integration's F6+F1 hardening contribution (0127-0160) without conflict. The original F7.1 plan had 12 migrations (0127–0138); 6 are deferred with F7.1b. **Renumber rationale (Phase 2 2026-05-18)**: F14 was branched from main at a point where the next available number was 0127, but 012-eventcreate-integration concurrently shipped F6 (CSV import) + F1 post-ship hardening occupying 0127-0160 on the shared Neon main branch. F14 renumbered 0127-0134 → 0161-0168 to land cleanly after 012's contribution; ship-time rebase onto post-012-ship main will not encounter migration-number conflicts. ClamAV runs as a Fly.io `sin`-region persistent micro-VM. No new cron-job.org coordinator (engagement-event purge was F7.1b US5, deferred).

---

## Complexity Tracking

> 5 deviations from Principles. All justified; rejected simpler alternatives documented.

| # | Violation | Why Needed | Simpler Alternative Rejected Because |
|---|-----------|------------|-------------------------------------|
| **5** | **Domain→Application import inversion at `src/modules/broadcasts/domain/value-objects/image-source-allowlist.ts:27`** (Principle III — Clean Architecture, NON-NEGOTIABLE) | The `Hostname` brand type was first declared in `src/modules/broadcasts/application/ports/image-allowlist-port.ts` during Phase 2 (port-first scaffolding) BEFORE the Phase 4 Domain VO was authored. The Domain VO at `image-source-allowlist.ts:27` `import type { AllowlistEntry, Hostname } from '../../application/ports/image-allowlist-port'` reverses the Clean Arch direction (Domain SHOULD NOT import from Application). The import carries ONLY a type alias (`Hostname = string & { __brand: 'Hostname' }`) with zero framework content — the runtime purity invariant holds. R002 Round 2 staff-review identified this as a 🟡 Warning. | **Block Phase 2 ship until Phase 4 Domain VO lands first.** Rejected because Phase 2 + Phase 4 user stories ship independently per Spec Kit MVP-first sequencing — circular dependency would have blocked BOTH USs. **Duplicate `Hostname` brand in both files.** Rejected because brand-type identity is nominal — two declarations create two incompatible brand types + breaks type-flow through the port boundary. **Inline string at port boundary (no brand).** Rejected because the brand is the load-bearing XSS defence — losing it at the port layer means downstream consumers can pass unbranded strings. **F7.1b remediation**: extract `Hostname` to a new `src/modules/broadcasts/domain/value-objects/branded-types.ts` shared file; both Domain VO + Application port import from there. Tracked as F7.1b backlog item per `retrospective.md § Architectural debt`. |
| **1** | **New external runtime dependency: ClamAV daemon on Fly.io persistent micro-VM** (Principle X — Simplicity) | US2 requires virus scanning before persisting member-uploaded inline images. Without a virus scanner, F7.1a fan-out (≤50k recipients per US1) means a single malware-bearing image is an existential incident. Clarifications Q2 selected self-hosted ClamAV after explicit rejection of managed alternatives. Audit finding C2 replaced the original muddled "Vercel Function sidecar" answer with a **Fly.io `sin`-region persistent micro-VM** running `clamav/clamav:stable`. Cost ~$2/month (free tier at SweCham scale). Operational surface: 1 `fly.toml` + 1 `Dockerfile` + 1 SLO (`clamav_signature_age_hours <48h`) + 1 runbook. Signature refresh is `freshclam` in-container (no external cron needed). | **Reject inline image uploads entirely** (no virus scanner needed). Rejected because the F7 retrospective stakeholder review named this as the single largest UX complaint; shipping F7.1a without it undermines US2's value proposition. **Bundle `clamscan` binary mode into Vercel Function** rejected: 3-5× slower than daemon mode breaks the FR-013 SLO; 150 MB signature DB doesn't fit Vercel's 250 MB function-size limit. **Managed third-party scanning API** rejected per Q2: per-scan cost + bandwidth surcharge scale adversely; sending member-uploaded content to a third party adds compliance surface. Fly.io persistent VM is the boring, well-documented daemon-shaped choice. |
| **2** | **Per-batch state machine + 3-retry admin loop** (Principle X — Simplicity) | US1 + Clarifications Q3 selected non-terminal `partially_sent` with explicit admin retry capped at 3 attempts. This introduces 3 new audit event types, a `retrying` transient state, a `manual_retry_count` column, per-batch idempotency keys + advisory locks, AND a per-broadcast `broadcasts-retry:` advisory-lock namespace to serialise concurrent retry attempts (FR-008d per critique E4). | **Terminal `partially_sent` state** (admin recreates broadcast to retry). Rejected because segment-drift between attempts causes duplicate-or-miss sends. The 3-retry cap bounds operator workload + audit-trail size; admins still have the "Accept partial delivery" escape hatch for cases where retries exhaust without resolution. |
| **3** | **Solo-maintainer review substitute** (Principle IX — ≥2 reviewers default) | F7.1a is built under the same solo-dev posture as F1–F8. No second human reviewer is available. Per Principle IX substitute clause, security-sensitive changes (US2 image upload + scan, F7.1a admin allowlist surface) require the 5-check automated stack. | **Wait for a second maintainer to join the project before shipping F7.1a.** Rejected because F1-F8 precedent has demonstrated the substitute's 5-check stack delivers higher signal:noise than typical human PR reviews. The substitute is reversible. **Concrete substitute checks for F7.1a (5/5)**: (1) ≥3 `/speckit.review` rounds; (2) ≥1 `/speckit.staff-review` with chamber-os-architect + security-threat-modeler + senior-tester agents; (3) Domain 100% line + Application 80% line/branch + 100% branch on security-critical use-cases (validate-image-source-allowlist, scan-inline-image-for-virus, enforce-cross-tenant-isolation); (4) RLS+FORCE policies + CHECK constraints (tenant_id NOT NULL, dispatch_concurrency_cap BETWEEN 1 AND 8, manual_retry_count BETWEEN 0 AND 3, hostname format CHECK, partial unique index on batch idempotency key); (5) post-remediation independent re-review via fresh agent run. Maintainer co-signs the security checklist alongside the staff-review agent. |
| **4** | **TDD retrofit on T045 (`dispatchBroadcastBatch`) + T046 (`batch-dispatcher`) + T056 (`autoRetryFailedBatch`) + T057 (`applyBatchWebhookEvent`)** (Principle II — Test-First, NON-NEGOTIABLE) | **NOT a new project norm — F7.1a-specific deviation.** Future features SHOULD follow canonical TDD order (failing test → commit red → implement → commit green); this entry documents why F7.1a deviated, not a blanket dispensation. — Phase 3 Cluster B/C implementations shipped before their dedicated contract tests; the contract tests landed in Phase 3F.5 + Phase 3F.10 + Phase 3F.11.5 (commits `f63fb79d`, `db4aeb07`, `5f514579`). Round 2 pr-test-analyzer surfaced this as G-7 (process violation, not a code defect). Acknowledged in this Complexity Tracking entry per Constitution § Development Workflow & Quality Gates. **Mitigating evidence**: (a) the 4 use cases had **integration-test coverage** via T037 lean-end-to-end on live Neon Singapore (~7500 recipients, 2 batches, cap=4) from Phase 3 ship — the contract tests retrofit the unit/contract-layer coverage but the production-equivalent path was always green; (b) Phase 3F.5 + 3F.10 + 3F.11.5 added **~50 new contract tests** with documented closure of 8 of 14 Round 1 test-analyzer findings + 3 Round 2 G-* gaps; (c) the contract tests caught real regressions during the Phase 3F.1-3F.11 fix-pass loop (F-04 idempotency rotation contract assertion + C4 audit-throw-on-success contract assertion both fired RED before the impl fix was applied). Principle II's TDD ordering was technically violated at Phase 3 Cluster B/C; the project-wide convention of "integration-test-FIRST at the live-Neon boundary, contract-test retrofit on review-loop catch-up" is documented here so future contributors don't replicate the violation as the new norm. | **Block Phase 3 ship until every use case has a contract test authored before its implementation.** Rejected because the integration-test-first path delivered comparable real-world confidence within the same calendar week as the contract-test-first path would have; the retrofit cost was ~3 hours total across Phase 3F.5+3F.10+3F.11.5 vs ~5+ hours of synchronous test-then-impl context-switching at Phase 3 ship time. **Halt the F7.1a stream entirely** rejected per the same Principle IX substitute calculus — F7.1a is the longest single-feature stream (~150 tasks across 10 phases) and Round 2 found ZERO logic regressions caused by the TDD-retrofit ordering. |

---

## Phase 0 — Outline & Research

**Status**: ✅ Complete — `research.md` generated for F7.1a scope.

All Clarifications applicable to F7.1a's US1+US2 scope are resolved (4 of 4); the 6 deferred-to-F7.1b clarifications are preserved verbatim in `f71b-backlog.md`. Research.md documents the decision + rationale + rejected alternatives for each of the 5 F7.1a design-shaping choices.

---

## Phase 1 — Design & Contracts

**Status**: ✅ Complete — `data-model.md`, `contracts/{batch-dispatch,image-upload}.md`, `quickstart.md` generated; agent-context updated.

- **data-model.md** — 5 entities (4 NEW: BroadcastTemplate + BroadcastBatchManifest + TenantImageSourceAllowlist + TenantBroadcastSettings — the last was mis-labelled "EXTEND" in data-model § 2.5 but did not exist in F7 MVP per Phase 2 Risk R2; 1 EXTENDED: Broadcast with 5 new columns + state-machine additions); 8 migration SQL statements (renumbered 0127-0134 → 0161-0168 Phase 2 — see Migrations § 3 below); complete RLS+FORCE+CHECK constraint catalogue; 10 new audit event types with retention class (all 5y); 5 starter templates × 3 locales seeded per tenant via migration 0168.
- **contracts/** — 2 active contract files (batch-dispatch.md + image-upload.md) + 6 deferred contract files preserved under `contracts/deferred-f71b/` for direct re-use when F7.1b user stories are promoted.
- **quickstart.md** — local dev setup including ClamAV install (Docker recommended), env vars, migration ordering.
- **agent-context update** — `update-agent-context.ps1 -AgentType claude` invoked to extend worktree `CLAUDE.md` § Active Technologies.

---

## Rollback Strategy (per critique X5 / P12 / E14)

### Kill-switch criteria per feature flag

Flip flag OFF immediately if any of these thresholds are crossed:

| Flag | Threshold | Action |
|------|-----------|--------|
| `FEATURE_F71A_US1_PAGINATION` | partial-send rate >10% on 10k+ broadcasts OR Resend account-level rate-limit incidents >3/week | Flip OFF; falls back to F7 MVP 5k cap |
| `FEATURE_F71A_US2_IMAGES` | image scan failure rate >5% OR ClamAV daemon unavailable >1h OR XSS detected in admin review surface | Flip OFF; falls back to F7 MVP no-`<img>` sanitiser |
| `FEATURE_F71A_US7_TEMPLATES` | template snapshot latency p95 >2s OR ≥1 template-content issue surfaced by admin | Flip OFF; falls back to F7 MVP "Blank only" compose UX (seeded templates remain in DB, dormant) |
| `FEATURE_F71A_BROADCAST_ADVANCED` (master) | Any F7.1a surface causes incident affecting F7 MVP critical path | Flip OFF; F7 MVP fully restored |

### Schema rollback (per critique E15 + E11 round 2)

F7.1a schema additions are NON-REVERSIBLE without data loss:
- `broadcasts` table column additions (manual_retry_count, partial_delivery_*, started_from_template_id, template_name_snapshot) — preserve on rollback; disable F7.1a reads via flag
- New tables (`broadcast_batch_manifests`, `tenant_image_source_allowlist`, `broadcast_templates`) — preserve on rollback; tables become unreferenced if flag is OFF
- `tenant_broadcast_settings.dispatch_concurrency_cap` — preserve on rollback; reverts to default 4
- **Seeded templates (15 rows × N tenants)** — preserve on rollback; templates remain in DB but become invisible to UI when `FEATURE_F71A_US7_TEMPLATES=false` (admin route 404, member compose dropdown shows only "Blank"). Re-enabling flag = templates instantly visible again (zero data loss). Admin-authored templates preserve content + audit trail equally.

**Rollback principle**: NEVER DROP F7.1a columns/tables/rows. Disable feature via flag → schema stays + accumulates no new data → becomes useful again on re-deploy.

### Ship-day flag-matrix test plan (per critique E14 + round-2 US7 addition)

**16 combinations** (2^4 flag matrix) to test pre-ship, **broken into 12 priority + 4 boundary scenarios**:

**Master-on baseline matrix (8 combinations)**:
1. Master OFF, US1 OFF, US2 OFF, US7 OFF (baseline F7 MVP)
2. Master ON, US1 OFF, US2 OFF, US7 OFF (F7.1a UI surfaces enabled but features dark)
3. Master ON, US7 ON only (template library only)
4. Master ON, US2 ON only (images only)
5. Master ON, US1 ON only (pagination only)
6. Master ON, US7 ON + US2 ON (templates + images — common F7.1a state)
7. Master ON, US7 ON + US1 ON (templates + pagination)
8. Master ON, US7 ON + US2 ON + US1 ON (full F7.1a)

**Emergency rollback scenarios (4)**:
9. Flip US1 OFF mid-flight (broadcast dispatch falls back to 5k cap; pending batches abort gracefully)
10. Flip US2 OFF mid-flight (Tiptap image extension disables; existing draft `<img>` tags fail submit allowlist re-check)
11. Flip US7 OFF mid-flight (template picker disappears from compose; in-flight drafts started from templates remain editable — snapshot is the source of truth)
12. Flip master OFF (F7.1a fully reverts to F7 MVP; SeQuelize templates remain in DB dormant)

**Boundary conditions (4)**:
13. 4999 / 5000 / 5001 recipients (pre-F7.1a cap boundary)
14. 9999 / 10000 / 10001 recipients (per-batch boundary)
15. 49999 / 50000 / 50001 recipients (F7.1a cap boundary)
16. Template-snapshot of 200KB-body template (size cap boundary; FR-017 enforcement)

### Risk notes (per `/speckit.analyze` D1+D2 findings 2026-05-18)

**D1 — Variable substitution rules described in 3 places** (spec FR-019 + contracts § 5 + research § 6). Currently consistent ✓. **Canonical source**: `contracts/broadcast-template.md § 5`. Any future change to variable resolution MUST update contracts § 5 FIRST + propagate to spec FR-019 + research § 6 in same PR. If drift detected during code review, contracts § 5 wins.

**D2 — ClamAV scan requirements overlap between F7.1a FR-013 (images) and F7.1b FR-027 (attachments, deferred)**. When F7.1b promotes attachments, extract shared scanner contract into a common section (e.g., `contracts/_shared/virus-scanner.md`) referenced by both FRs to prevent drift. F7.1a-only impact: T151 polish task already documents the 5-min timeout parity expectation.

---

### CI gate (per critique E2/X2 — added 2026-05-18 round 2)

Pre-merge CI MUST run:

```bash
pnpm tsx scripts/generate-template-seed-migration.ts --check
```

This regenerates `0168_f71a_default_template_seed.sql` (renumbered from 0134 Phase 2) from `starter-templates.md` and asserts the result matches the committed migration byte-for-byte. **Drift = build break**. Maintainer cannot edit starter content without re-running the generator (manual step before commit). Single source of truth = `starter-templates.md`; migration is a derived artefact.

### Migration 0168 atomicity strategy (renumbered from 0134 Phase 2 — per critique E4)

Migration 0168 seeds 15 rows per tenant (5 templates × 3 locales). To prevent one bad row from blocking all 100-tenant seed:

- **Per-tenant `BEGIN/COMMIT`** (NOT global transaction): each tenant's 15-row seed is atomic; failure rolls back THAT tenant only
- **Per-row `INSERT … ON CONFLICT DO NOTHING`** within the tenant transaction: per-template idempotency
- **Catch + audit + continue**: on per-tenant exception, log `broadcast_template_seed_tenant_failed` (data-model.md § 7) with tenant_id + failure reason; continue to next tenant
- **Pre-merge CI gate** (per critique E4): `pnpm tsx scripts/generate-template-seed-migration.ts --validate` runs body-length CHECK + sanitiser dry-run on each starter template; rejects PR if any row would violate constraints at migration time

### Re-seed safety (per critique E7)

Future re-seed migrations (e.g., `0140_f72_default_template_seed_v2.sql` adding new starter names) MUST use `ON CONFLICT (tenant_id, name, locale) DO NOTHING` (never `DO UPDATE`). Admin-edited templates are sacrosanct — re-seed never overwrites. If a starter content update is desired, it ships under a NEW name (e.g., "Monthly Newsletter v2") so existing admin customisations persist alongside.

### Ship-day operator checklist additions (per critique P1)

Before flipping `FEATURE_F71A_BROADCAST_ADVANCED=true` in production, operator MUST:

1. **F7 MVP baseline snapshot** (per critique P1 — round 1 partial-remediation): query F7 MVP usage and write to `docs/observability/f7-mvp-baseline-2026-05-18.md` covering:
   - Tenant count + broadcasts/week/tenant
   - Segment distribution (which segment-kinds are most used?)
   - Max recipient count seen (did anyone approach 5k cap?)
   - Draft-abandonment rate (% drafts created → never submitted)
   - Suppression-list growth rate
2. **Update F7.1b promotion criteria** in `f71b-backlog.md` to reference the baseline numbers (instead of hand-waved assumptions)
3. **Run 16-combination flag-matrix test plan** (above) on staging tenant
4. **Verify Fly.io ClamAV health** via `fly status -a clamav-swecham`
5. **Run pre-merge CI auto-gen check** locally: `pnpm tsx scripts/generate-template-seed-migration.ts --check` should pass
6. **Run starter-template-seed integration test** on staging Neon DB: assert 15 rows × N tenants seeded correctly

---

## Open Considerations (per critique round 2 — 4 unresolved questions)

These items require operator/maintainer judgement and cannot be fully resolved in spec/plan. Surface them at the next ship-day review or `/speckit.analyze` gate:

| ID | Category | Question | Action proposed |
|----|----------|----------|-----------------|
| ~~**P2**~~ | ~~Problem Validation~~ | ~~3-US scope realistic for solo-dev 2-3 week timeline?~~ | ✅ **RESOLVED Clarifications Session 2026-05-18 Q1**: decide at `/speckit.tasks` gate via task-count threshold (>200 = defer US7 back to F7.1b; ≤200 = ship all 3). |
| **P7** | Storage choice | starter-templates.md → migration 0168 sync mechanism: auto-gen script (chosen, see CI gate above) vs JSON intermediate format vs frozen-markdown? | **Decision: Auto-gen script** per `scripts/generate-template-seed-migration.ts`. JSON intermediate (option c) deferred as F7.1b polish — current script keeps markdown as canonical source. |
| ~~**E3**~~ | ~~Architecture~~ | ~~Cross-locale template authoring policy~~ | ✅ **RESOLVED Clarifications Session 2026-05-18 Q3**: permissive — no warning, no block. Admins author any locale freely; picker filter handles member-side display. |
| ~~**E12**~~ | ~~Dependencies~~ | ~~`@tiptap/extension-image@^3.22` compatibility with F7 MVP Tiptap base version~~ | ✅ **RESOLVED Clarifications Session 2026-05-18 Q2**: verified F7 MVP is on Tiptap 3.22.5 (same MAJOR). Clean extension-add; no upgrade task; no F7 MVP regression risk. |

---

## Phase 2 — Hand-off to `/speckit.tasks`

This plan ends after Phase 1. The next command is **`/speckit.tasks`**, which will:
- Read `spec.md` + `plan.md` + `data-model.md` + `contracts/*` + `quickstart.md`
- Decompose the 3 user stories into TDD-ordered task chains
- Group tasks by user story for independent deliverability
- Mark parallelizable `[P]` tasks

**Estimated task volume**: ~140-180 tasks (US7 promote-back added ~40 tasks for template CRUD + seed + UI; still down from original F7.1 8-US estimate of ~250). US1, US2, US7 are mostly independent — could ship in parallel branches if desired. **Per Clarifications round 3 Q1**: if `/speckit.tasks` produces >200 items, re-defer US7 back to F7.1b.

---

## Constitution Check — Post-Design Re-Evaluation

After Phase 1 design completion + Strategy B scope reduction, re-evaluating against all 10 principles:

- [x] **I. Data Privacy & Security (NON-NEGOTIABLE)** — Re-confirmed PASS. RLS+FORCE on all 3 new tables (batch manifests + image allowlist + templates); 3 cross-tenant probe tests planned (one per US); OWASP coverage explicit (XSS via allowlist, SSRF via bucket-only upload, filename-XSS sanitisation, admin-only template authoring per FR-016). ✅
- [x] **II. Test-First Development (NON-NEGOTIABLE)** — Re-confirmed PASS. 7 contract + 5 integration + 2 unit + 2 e2e test files. ✅
- [x] **III. Clean Architecture (NON-NEGOTIABLE)** — Re-confirmed PASS. Source tree shows clean Domain/Application/Infrastructure separation; barrel extended; **no cross-module schema changes in F7.1a** (the F3 contacts mutation that drove CT #3 in original F7.1 is deferred with US3 to F7.1b). ✅
- [x] **IV. Payment Security (PCI DSS) (NON-NEGOTIABLE)** — N/A — F7.1a touches no card data. ✅
- [x] **V. Internationalization** — Re-confirmed PASS. ~150-200 new EN+TH+SV keys, `pnpm check:i18n` gate. ✅
- [x] **VI. Inclusive UX** — Re-confirmed PASS. Mobile-first + WCAG 2.1 AA + axe-core e2e + manual SR QA on 5 surfaces. ✅
- [x] **VII. Performance & Observability** — Re-confirmed PASS. 5 new metrics + 4 alerts + 3 runbooks catalogued; SLO budgets per US in spec § SC. ✅
- [x] **VIII. Reliability** — Re-confirmed PASS. Transaction boundaries enumerated; idempotency keys defined; 7 audit event types; advisory-lock namespaces `broadcasts-batch:` + `broadcasts-retry:` both disjoint from existing `broadcasts:`. ✅
- [x] **IX. Code Quality Standards** — Re-confirmed PASS via solo-maintainer substitute (CT #3). ✅
- [x] **X. Simplicity (YAGNI)** — Re-confirmed PASS. **Strategy B reduced scope from 8 USs → 3 USs** (US1 + US2 + US7 — US7 promoted back after maintainer committed to writing 5 starter templates × 3 locales directly), deferring 5 USs worth of speculative engineering; 4 Complexity Tracking entries (CT #4 added in Phase 3F.11.7 for the TDD retrofit on T045/T046/T056/T057). ✅

**Final gate verdict**: ✅ PASS — ready for `/speckit.tasks`.

---

## Phase 6 Polish Closures (T150-T162) — Checklist Gap Anchors

Phase 6 polish (per `tasks.md` Phase 6 § Checklist-driven polish tasks) closes 13 ❌/⚠️ items identified in the 2026-05-18 manual checklist walkthrough. The closures below anchor each requirement to its source `checklists/*.md` ID and provide the policy text for downstream artefacts (UI tasks, e2e suites, audit gates).

### Constitution Check I — additional invariant (T150, CHK006 closure)

**Cross-member-within-tenant guard invariant (preserved for F7.1b promotion)**: F7.1a admin surfaces (allowlist editor, batch breakdown, retry/accept-partial dialogs) authenticate via `requireAdminContext` which enforces tenant scope but does NOT further partition by member. F7.1a does not expose a route where an admin can act on another member's broadcast outside the legitimate moderation surfaces. This invariant matters at F7.1b promotion time (US3 contact opt-in, US4 attachments) because those surfaces COULD introduce cross-member-within-tenant access patterns (e.g., admin editing another member's per-contact opt-in). Future F7.1b spec MUST re-evaluate this invariant when introducing such surfaces; F7.1a explicitly carries it forward as a Constitution I clause-3 sub-invariant for traceability.

### Constitution Check VI — strengthening on a11y + i18n (T155, T156, T158, T159, T161, T162)

The following requirements extend the WCAG 2.1 AA + i18n posture for new F7.1a surfaces. They are policy statements verified by automated and manual QA at the `/speckit.verify` gate:

- **(T155, CHK004) — Color contrast**: all 11 new F7.1a surfaces MUST achieve ≥4.5:1 contrast for body text and ≥3:1 for large text (WCAG 2.1 SC 1.4.3). Inherits F4 design tokens; verified by axe-core `color-contrast` rule on every e2e spec.
- **(T156, CHK012 + CHK014) — Focus-management on modal/dialog components**: T053 (retry confirmation), T054 (accept-partial modal) — shadcn `AlertDialog` already provides (a) focus-trap during open, (b) focus-restoration to triggering button on close, (c) universal focus ring via F4 design system tokens. T081 (ClamAV unreachable banner) is non-modal — focus-ring requirement applies to its Dismiss button; focus-trap is N/A.
- **(T158, CHK019) — Label association on T080 image upload**: the file-picker component MUST associate `<label for>` with the underlying `<input type="file">` element; accessible name MUST come from an i18n key (not a hard-coded string). Icon-only file-picker buttons are forbidden — visible text label OR visually-hidden but SR-discoverable label required.
- **(T159, CHK028) — Playwright viewport-matrix**: every new F7.1a e2e spec under `tests/e2e/broadcasts/` MUST run at 4 viewports: **320×568** (mobile-min), **768×1024** (tablet), **1280×800** (desktop), **1920×1080** (desktop-wide). Critical interaction paths verified at all 4; full axe-core scan at the canonical 1280×800.
- **(T161, CHK033) — i18n-keyed aria-label policy**: JSX `aria-*` attributes on user-facing components MUST resolve their string value via `t('namespace.key')` calls — not string literals. Same rule applies to `role`-relative labels (e.g., `aria-labelledby` targets). Enforcement: a future `scripts/check-i18n-coverage.ts --strict-aria` flag (deferred TODO — F7.1b scope) will AST-scan TSX files for violations. F7.1a closes the policy gap; the AST scanner is the enforcement gap and is tracked as a follow-up. Reviewer responsibility for F7.1a ship: manual sweep of the 11 new surfaces during `/speckit.review`.
- **(T162, CHK037 + CHK038) — axe-core scan threshold + remediation policy**: zero violations on critical surfaces (admin batch breakdown, image upload, template picker); warnings logged and reviewed at Polish phase; **block-merge on `color-contrast` + `label` axe-rule failures only** (other a11y findings logged for tracking but not gate-blocking). Critical-surface scans are pinned in the e2e spec; non-critical surfaces are scanned but pass on warnings.

### Spec FR-013 + SC-008 strengthening (T151, T152, T155)

The substantive policy text lands in `spec.md`:
- FR-013 now carries the **5-minute ClamAV scan timeout** (verdict=`error` on timeout) per **T151** (CHK020).
- FR-013 now carries the **pipeline-order invariant** ("Image bytes MUST NOT reach Vercel Blob persistence layer BEFORE scan verdict='clean' is recorded") per **T152** (CHK023).
- SC-008 now carries the **explicit ≥4.5:1 color contrast** requirement per **T155** (CHK004).

### DPIA addendum (T153, CHK036)

Authored at `specs/014-email-broadcast-advance/dpia-addendum.md` per **T153**. Covers: (a) US2 member-content processing surface (image upload + ClamAV scan as sub-processor), (b) US7 admin-content authoring surface (templates with platform-controlled content + tenant-scoped RLS), (c) GDPR Art. 13 lawful-basis enumeration for the 10 new audit event types, (d) ROPA additions.

### Deferred items (documented in checklists; NOT new F7.1a tasks)

The following gaps from the `checklists/` walkthrough are intentionally deferred:
- `security CHK030` — consent-withdrawability invariant (F7.1b US3 contact opt-in deferred).
- `performance CHK006` — Constitution VII budget traceability (docs polish; low priority).
- `performance CHK018` — template-picker scale fixture (F7.1a low priority — SweCham 131 members < threshold).
- `performance CHK028` — ClamAV-down policy explicit (implicit via CHK022 banner UX + auto-retry).
- `a11y CHK035` — text-spacing for TH/SV expansion (inherited from F7 MVP baseline; no F7.1a-specific risk).

---

*Generated by `/speckit.plan` on 2026-05-17; split to F7.1a on 2026-05-18 per critique Strategy B. Original 8-US scope preserved in `f71b-backlog.md`. Phase 6 polish closures appended 2026-05-21 per `tasks.md` T150-T162.*
