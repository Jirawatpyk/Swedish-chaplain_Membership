# Implementation Plan: F7 — Email Broadcast (E-Blast)

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-email-broadcast/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessors**: F1 Auth & RBAC (PR #1), F2 Plans (`002-membership-plans`), F3 Members & Contacts (`005-members-contacts`), F4 Invoices & Receipts (`007-invoices-receipts`, PR #12), F5 Online Payment (`009-online-payment`, PR #16)
**Co-shipping with**: F6 EventCreate Integration (`008-event-integration`, planned) — F7 ships an `EventAttendeesRepository` stub-port (FR-015a) that F6 swaps for the real implementation; both features release together in the Phase 2 batch per `docs/phases-plan.md` § Phase 2 ordering and Clarifications Q5.

## Summary

F7 delivers Chamber-OS's **sixth business feature** and closes the largest paid-benefit gap in the SweCham 2026 Membership Package PDF: the contractually purchased annual quota of **E-Blasts** (1–15 per year across 6 paying tiers) is finally deliverable. F7 turns the tier promise into a working self-service flow — members compose and submit, an admin reviews, the system delivers to a tenant-scoped recipient list via Resend Broadcasts, and the quota counter on the Smart Feature #1 Benefit Dashboard moves from "promised" to "used".

F7 carries **⚠ PII** sensitivity (recipient lists derived from member contact data) and **⚠ Marketing-consent** compliance scope (PDPA Section 24 + GDPR Article 21 + ePrivacy unsubscribe obligation). Principle IV (PCI DSS) is **N/A** — F7 has no payment surface; the Phase 2 PCI feature is F5 (already shipped on `009-online-payment`). Review gate requires **≥2 reviewers** (or the Constitution § IX.5-stack solo-maintainer substitute when no second human reviewer is available).

**Scope confirmed from spec** (19 clarifications resolved across 6 sessions + 4 critique-remediation rounds — see audit-report-2026-04-29.md + 4 critique reports under `critiques/` for full provenance): 6 user stories (US1–US6; US1+US2 both **P1**), **48 functional requirements** (FR-001…FR-042 + 6 amendments FR-002a HTML sanitiser + FR-004a cancellation rules + FR-015a EventAttendees stub-port + FR-015c primary-contact resolver + FR-015d custom-list validator + FR-016a recipient cap), 11 success criteria (SC-001…SC-011 — SC-011 added by Clarifications Q13 SaaS-foundation framing), 37 named audit events (full catalogue in data-model.md § 5; +1 by Round 2 critique R2-NEW-3 — `broadcast_resend_resource_missing`; +3 by Clarifications session 5 Q14+Q15 — `broadcast_complaint_rate_per_broadcast_breach` + `broadcast_member_dispatch_resumed` + `member_acknowledged_broadcasts_terms`; +1 by Critique Round 3 R3-NEW-1 — `broadcast_member_halted_pending_review` for FR-002 precondition `k`), 4 new DB tables + 2 new columns on F3 `members` (`broadcasts_halted_until_admin_review` per Q14 + `broadcasts_acknowledged_at` per Q15) + 1 new bounded context + 4 new npm dependencies + 8 migrations (0064–0071), and 1 forward-compat seam (F6 stub port + per-contact `receive_broadcasts` flag deferred to F7.1).

**Technical approach**: Reuse the F1+F2+F3+F4+F5 stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + Postgres RLS via `runInTenant(ctx, fn)` + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright + pino + @vercel/otel + Resend (the existing F1 transactional client, extended with the **Resend Broadcasts API** for marketing-volume sends — separate Resend product, separate suppression list, separate reputation pool from F1 transactional). Add **one new bounded context** `src/modules/broadcasts/` housing `Broadcast` + `BroadcastDelivery` + `MarketingUnsubscribe` + `RecipientSegment` aggregates plus the `BroadcastsGateway` + `WebhookVerifier` + `EventAttendeesRepository` (stub) + `HtmlSanitizer` ports. Add **four new npm dependencies**: `@tiptap/react` + `@tiptap/starter-kit` (rich-text editor), `isomorphic-dompurify` (server-safe HTML sanitiser for FR-002a), and `email-validator` (custom-segment entry validation per FR-015d). Add **one new API route family**: `/api/broadcasts/*` (member-initiated), `/api/admin/broadcasts/*` (admin-initiated review/approve/reject/proxy), `/api/webhooks/resend-broadcasts` (Resend-initiated delivery events), `/unsubscribe/[token]` (recipient-initiated public route, no auth). Compose UX is a dedicated `/portal/broadcasts/new` route with the Tiptap editor + preview pane + segment picker; admin queue UX is `/admin/broadcasts` (TanStack Table v8 — reuse F4 invoice-list pattern). F7 extends F3's public barrel with `getMembersBySegment`, `getMemberPrimaryContact`, `lookupContactEmailInTenant`, `lookupMemberPrimaryContactEmailInTenant` (FR-015c + FR-015d resolvers). Enterprise UX per `docs/ux-standards.md`; WCAG 2.1 AA on every surface; SV+EN+TH at release; ≥5-year audit retention (no F4 tax-document overlap).

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4+F5
**Runtime**: Node.js 22 LTS (Vercel Fluid Compute) — unchanged. **Webhook endpoint is pinned to Node.js runtime** (not Edge) because Resend signature verification (HMAC-SHA256 over the raw request body via the `Svix` signing scheme that Resend uses for webhook security) requires raw request body access, which Edge runtime does not reliably expose across framework versions — same constraint as F5 Stripe webhook.
**Framework**: Next.js 16 App Router + Cache Components + Turbopack — unchanged

**Primary Dependencies** (new in F7 unless marked):

- **from F1+F2+F3+F4+F5** (unchanged versions): `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `cmdk` (F7 extends palette with Compose-broadcast + Review-queue commands), `@tanstack/react-table@^8` (F7 reuses the F3+F4 pattern for admin queue), `@vercel/otel` + `@opentelemetry/api`, `pino`, `vitest`, `playwright`, `@axe-core/playwright`, `resend` (F7 extends with the Broadcasts API surface; the `resend` SDK already covers both transactional and Broadcasts products on a single API key).
- **new in F7**:
  - **`@tiptap/react@^3`** + **`@tiptap/starter-kit@^3`** (latest stable as of 2026-04-29) — headless rich-text editor for the compose surface (Clarifications Q4 / Assumptions). Used exclusively in Presentation (`src/app/(member)/portal/broadcasts/new/_components/editor/**`). Tiptap chosen over Lexical (smaller community), BlockNote (Notion-style is overkill for E-Blast use case), Quill (legacy ecosystem). Starter-kit covers paragraphs, headings, lists, bold/italic/underline, links, blockquote, hr — exactly the FR-002a allowlist. Custom extensions for image insertion deferred to F7.1.
  - **`isomorphic-dompurify@^2`** (latest stable as of 2026-04-29) — DOMPurify wrapper that runs in Node + browser. Used in Application layer for FR-002a strict-allowlist sanitisation: `body_html` is sanitised on every submit before persistence; the unsanitised raw editor output is NEVER stored. Chosen over `sanitize-html` (less actively maintained) and `xss` (heavier API surface). Configured with explicit `ALLOWED_TAGS` + `ALLOWED_ATTR` + `FORBID_ATTR` (`on*` event handlers + `style`) + `ALLOWED_URI_REGEXP` matching `^(https?:|mailto:)`. Deterministic output (snapshot-tested in unit tests per FR-002a).
  - **`email-validator@^2`** (latest stable as of 2026-04-29) — RFC-5321 email format validator for the `custom` segment (FR-015d). Used in Application layer for the per-entry format check before the tenant-graph resolution query. Chosen over a hand-rolled regex (RFC complexity is real and famously misimplemented) and over zod's `email()` validator alone (zod's check is permissive — accepts `a@b` with no TLD).
  - **No new editor extension lib** — Tiptap's starter-kit covers FR-002a's allowlist 1:1; no need for `@tiptap/extension-*` add-ons in MVP.
  - **No new email-template lib** — F1+F4's React Email setup handles the broadcast HTML wrapping (chamber-branded header + footer + unsubscribe link).
  - **No new QR / image / PDF lib** — F7 has no PDF surface; Tiptap-emitted `<img>` tags pass through to Resend Broadcasts as-is.
- **rejected** (YAGNI / constitutional):
  - **Mailchimp / Brevo / Sendinblue** — pre-locked against by `docs/email-broadcast-analysis.md` § 3 (Resend Broadcasts is the chosen platform). Switching would double the integration surface (two providers, two sender identities, two webhook conventions, per-tenant API-key sprawl).
  - **Custom self-hosted SMTP / SES** — rejected by Constitution Principle X (Simplicity) — no benefit over Resend Broadcasts at SweCham scale.
  - **Drag-and-drop email builder** (e.g., Unlayer, MJML editor) — out of MVP scope per `docs/email-broadcast-analysis.md` § 13. Tiptap rich-text suffices.
  - **A/B testing of subject / body** — out of MVP per spec § Out of Scope.
  - **Drip campaigns / automated sequences** — out of MVP; F8 renewal reminders use F1 transactional (NOT F7 Broadcasts).
  - **Open / click tracking** — explicitly OFF per spec Assumptions / analysis Q5 / Constitution Principle I (privacy-conscious default).
  - **External-invitee broadcasts** (custom list with non-tenant-graph emails) — out of MVP per Clarifications Q9 / FR-015d.
  - **Per-contact `receive_broadcasts` opt-in flag in F3** — deferred to F7.1 per Clarifications Q8 / FR-015c rationale.
  - **Per-tenant Resend BYOK** — deferred to F12 (white-label) per spec Assumptions.
  - **Pay-per-send beyond quota** — F11 SaaS billing scope per spec Assumptions.

**Storage**:

- Primary: PostgreSQL via Neon `ap-southeast-1` Singapore — unchanged. Adds **four new tables**: `broadcasts`, `broadcast_deliveries`, `marketing_unsubscribes`, `broadcast_segment_definitions` (read-model snapshot for audit + admin display). Extensions to `audit_log` (new event types only — reuses F2/F3/F4/F5 `payload jsonb` + `tenant_id` + `retention_years` columns).
- Postgres RLS: every F7-introduced table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy, identical to F2+F3+F4+F5 pattern. `runInTenant(ctx, fn)` reused unchanged. `DEBUG_RLS_STATE=1` dev-mode safety net inherited. **Exception**: `marketing_unsubscribes` insert from the public unsubscribe route runs under a narrow bypass context (the recipient is unauthenticated and the tenant is resolved from the signed token payload, not from a user session); immediately after token verification the tx re-binds `app.current_tenant` via `runInTenant` for the upsert. Same pattern as F5's webhook pre-tenant bypass — narrowest possible window.
- Indexes (all `CREATE INDEX CONCURRENTLY` outside migration tx — same F4+F5 pattern):
  - `broadcasts(tenant_id, status, requested_by_member_id)` — member portal history + admin queue filter
  - `broadcasts(tenant_id, status, scheduled_for) WHERE status = 'approved' AND scheduled_for IS NOT NULL` — partial index for cron handler dispatch query (US6)
  - `broadcasts(tenant_id, submitted_at DESC) WHERE status = 'submitted'` — partial index for admin queue oldest-first sort
  - `broadcasts(resend_broadcast_id) UNIQUE` — webhook → row lookup on delivery events
  - `broadcast_deliveries(tenant_id, broadcast_id, status)` — per-broadcast delivery summary
  - `broadcast_deliveries(tenant_id, resend_event_id) UNIQUE` — webhook idempotency primitive (FR-025)
  - `broadcast_deliveries(tenant_id, recipient_email_lower)` — recipient lookup for member detail timeline
  - `marketing_unsubscribes(tenant_id, email_lower) PRIMARY KEY` — natural composite PK; suppression-filter join key
  - `broadcast_segment_definitions(tenant_id, definition_id) PRIMARY KEY`
- **No new Blob storage** — F7 does not persist PDFs or attachments (attachments deferred to F7.1 per Clarifications Q4 / Assumptions).
- Session / rate-limit cache: Upstash Redis (Singapore) — unchanged. F7 adds **four new token buckets**:
  - `POST /api/broadcasts/submit` — **10 submissions / rolling 24h per `(tenant_id, requested_by_member_id)`** (FR-002d — daily flooding guard)
  - `POST /api/broadcasts/draft` — **60 draft saves / 5 min per `(tenant_id, actor_user_id)`** (loose; protects against runaway autosave bugs in the editor)
  - `POST /api/admin/broadcasts/[id]/approve` + `reject` + `cancel` — **30 actions / 5 min per `(tenant_id, actor_user_id)`** (admin-only; loose)
  - `POST /api/webhooks/resend-broadcasts` — **600 events / min per source IP** (generous upper bound; SweCham's expected traffic is < 10 events/min; limit exists to protect against webhook-replay abuse from a compromised secret). Bypass for signature-verified requests.
  - `GET /unsubscribe/[token]` — **20 hits / 5 min per source IP** (prevents token-brute-force attempts; legitimate user clicks once or twice).

**Testing**:

- `vitest` — unit + Application tests. Coverage thresholds: Domain 100% line; Application ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases**:
  - `submit-broadcast.ts` (every FR-002 precondition `a`–`k` + sanitiser invocation + reservation insert atomicity + rate-limit check + halt-flag check per Critique Round 3 R3-NEW-1)
  - `sanitize-html.ts` (FR-002a — every forbidden tag + every URI scheme + every `on*` attribute + size cap; deterministic output snapshot tests)
  - `validate-custom-recipients.ts` (FR-015d — every resolution branch: members.primary_contact_email, contacts.email, event_attendees.email; case-insensitive + trim normalisation; rejection error shape)
  - `process-webhook-event.ts` (signature verify + event-id dedupe + tenant resolution + bounce-to-suppression cascade + complaint-to-suppression cascade + late-event handling)
  - `cancel-broadcast.ts` (FR-004a — every state-machine transition target: submitted/approved → cancelled; reject from sending/sent/cancelled/rejected/failed_to_dispatch with `broadcast_cancel_too_late`)
  - `unsubscribe-recipient.ts` (FR-029–FR-032 — token verify + idempotency + tenant scoping + member resolution by email)
  - `enforce-tenant-context-on-broadcast.ts` (cross-tenant probe refusal + `broadcast_cross_tenant_probe` audit)
  - `enforce-tenant-context-on-unsubscribe.ts` (cross-tenant suppression isolation — Clarifications Q8 invariant)
- `playwright` — E2E with existing F1+F2+F3+F4+F5 setup. New specs:
  - `tests/e2e/broadcast-compose-and-submit.spec.ts` (US1 AS1 + AS7 + AS8 + AS9 — happy path + sanitiser rejection + size cap + admin proxy)
  - `tests/e2e/broadcast-quota-block.spec.ts` (US1 AS2 — quota exhausted + tier-not-in-plan)
  - `tests/e2e/broadcast-draft-restore.spec.ts` (US1 AS3 — close tab + return)
  - `tests/e2e/broadcast-empty-segment.spec.ts` (US1 AS4 — all-suppressed segment refusal)
  - `tests/e2e/broadcast-rate-limit.spec.ts` (US1 AS5 — 11th submission in 24h)
  - `tests/e2e/admin-review-queue.spec.ts` (US2 AS1–AS6 — approve / reject / schedule / manager-read-only / concurrent-action)
  - `tests/e2e/member-quota-history.spec.ts` (US3 — quota counters + history pagination + cross-member 404)
  - `tests/e2e/recipient-unsubscribe.spec.ts` (US4 AS1–AS5 — happy unsubscribe + idempotent + invalid token + suppression filter)
  - `tests/e2e/scheduled-send-cron.spec.ts` (US6 AS1–AS5 — cron dispatch + retry + concurrent cron + cancel-before-scheduled + expired-plan)
  - `tests/e2e/broadcast-cancel-too-late.spec.ts` (US6 AS6 — `sending` cancel attempt rejection)
  - `tests/e2e/broadcast-a11y.spec.ts` (axe-core on compose, queue, history, unsubscribe)
  - `tests/e2e/broadcast-i18n.spec.ts` (TH + EN + SV coverage on every F7 surface)
- `@axe-core/playwright` — WCAG 2.1 AA on every new screen (compose editor + segment picker + scheduling picker + admin queue + broadcast detail + public unsubscribe page).
- **New cross-tenant integration test for F7** (Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker): `tests/integration/broadcasts/tenant-isolation.test.ts` — creates two tenants, seeds members + plans + broadcasts + suppressions + segment-definitions for each, asserts zero cross-tenant visibility on SELECT / INSERT / UPDATE / DELETE across all four F7 tables, plus emission of `broadcast_cross_tenant_probe` on every probe attempt from both directions.
- **New webhook-idempotency integration test** (FR-025): `tests/integration/broadcasts/webhook-idempotency.test.ts` — delivers the same `email.delivered` event twice + verifies (a) second delivery returns 200 without side effects, (b) only one `broadcast_deliveries` row inserted, (c) only one quota-consumption transition (FR-028), (d) only one `broadcast_quota_consumed` audit event.
- **New webhook-signature integration test** (FR-024): `tests/integration/broadcasts/webhook-signature.test.ts` — 4 scenarios: valid → 200; missing `Resend-Signature` header → 401; malformed signature → 401; tampered body → 401. All non-200 paths complete pre-body-parse and emit `broadcast_webhook_signature_rejected`.
- **New sanitiser integration test** (FR-002a): `tests/integration/broadcasts/html-sanitiser.test.ts` — 30+ payloads covering every allowlisted tag (passthrough), every forbidden tag/attribute (strip), every URL scheme (allow http/https/mailto, reject javascript/data/file/vbscript), `on*` event handlers, inline `style`, mixed-allowlist combinations, deeply-nested `<script>`, comment-injected payloads. Snapshot-tested for determinism.
- **New custom-list-validation integration test** (FR-015d / Clarifications Q9): `tests/integration/broadcasts/custom-recipient-validation.test.ts` — populates 3 members (primary contacts) + 5 contacts + 0 event attendees → submits a custom list with mixed valid + invalid entries → asserts each branch hits the right resolver, unresolved entries listed in error response.
- **New cancellation-cutoff integration test** (FR-004a / Clarifications Q10): `tests/integration/broadcasts/cancellation-cutoff.test.ts` — for each terminal state (sending, sent, cancelled, rejected, failed_to_dispatch) attempts a cancel from both member and admin → asserts 409 + `broadcast_cancel_too_late` audit + no state mutation.
- **New unsubscribe-token integration test** (FR-029–FR-032): `tests/integration/broadcasts/unsubscribe-token.test.ts` — happy path + replayed → idempotent + tampered → reject + cross-tenant token → reject. Verifies suppression upsert is tenant-scoped.
- **New scheduled-cron-idempotency integration test** (US6 AS3): `tests/integration/broadcasts/cron-dispatch-idempotency.test.ts` — two simulated concurrent cron invocations on the same `approved` row → asserts exactly one Resend dispatch + one `sending` transition via `SELECT … FOR UPDATE` + per-`(tenant_id, broadcast_id)` advisory lock.
- **New stub-port-substitution integration test** (FR-015a / Clarifications Q5): `tests/integration/broadcasts/event-attendees-stub.test.ts` — F7's stub returns `[]` → segment resolves empty → submission rejected with `broadcast_empty_segment_blocked`. F6 swap test (run when F6 lands): substitute the real F6 implementation → segment resolves to populated list → submission accepted.
- **New audience-cap integration test** (FR-016a / Clarifications Q7): `tests/integration/broadcasts/audience-cap.test.ts` — seed >5,000 in-segment recipients → submit → reject with `broadcast_audience_too_large` + audit emitted. Same boundary check at dispatch time (mid-flight membership growth scenario).
- **New JCC-test tenant fixture** (Q18 / SC-011 per-release multi-tenant readiness invariant; Critique Round 3 R3-NEW-6 + Round 4 R4-NEW-5): `tests/integration/broadcasts/jcc-test-tenant-fixture.test.ts` — CI nightly job that creates a fresh test-tenant ("JCC-test"), seeds default segments via migration 0068, configures a Resend test-mode account stub, submits + approves + dispatches a synthetic broadcast (single test recipient), verifies cross-tenant suppression isolation + tenant-scoped audit log + tenant-scoped metrics, and tears down. Total runtime budget < 5 minutes. Failure of any sub-criterion = F7 ship blocker per SC-011. Asserts data-only configuration: zero diff in `src/modules/broadcasts/**` between baseline and post-fixture-run (no F7 code change required to onboard a new tenant). Run nightly via the CI workflow `.github/workflows/multi-tenant-readiness.yml` (NEW — references this test file + posts a status badge).
- **New halt-flag-precondition integration test** (FR-002 precondition `k` / Clarifications Q14 + Round 3 R3-NEW-1): `tests/integration/broadcasts/halt-flag-precondition.test.ts` — seeds a member with `broadcasts_halted_until_admin_review = true`; member attempts to submit a broadcast → asserts 422 `broadcast_member_halted_pending_review` + audit event of same name + no broadcast row created + no quota reservation. Then admin clears the halt via `clear-halt-dialog.tsx` flow → member re-submits successfully. Closes the test-coverage gap from R4-NEW-1.
- **New RLS coverage cross-cutting test extension**: extend `tests/integration/rls-coverage.test.ts` to include `broadcasts`, `broadcast_deliveries`, `marketing_unsubscribes`, `broadcast_segment_definitions` — any tenant-scoped F7 table without RLS + FORCE + policy = automatic red CI.
- **New kill-switch integration test** (`FEATURE_F7_BROADCASTS=false`): `tests/integration/broadcasts/kill-switch.test.ts` — flag off → compose surface returns 503 + member sees fallback UI; flag on → normal flow.
- **Red test suite on `main` = stop-the-line** — same as F1+F2+F3+F4+F5.

**Target Platform**: Web browsers (mobile Safari, Chrome Android, Chrome, Firefox, Safari, Edge — last 2 versions). Deployed on Vercel `sin1` + Neon `ap-southeast-1` + Upstash Redis (Singapore) + Resend (global — same account as F1; Broadcasts product enabled) + cron-job.org for scheduled-send dispatch (Vercel Hobby plan compatible — same pattern as F5 stale-pending-count gauge). Unchanged stack plus Resend Broadcasts surface + Tiptap client-side editor.

**Project Type**: Web application (Next.js full-stack, single repo, single deploy) — unchanged.

**Performance Goals** (Clarifications Q6 / SC-010 — F7 commits to per-surface p95 budgets):

- **SC-010 / FR-040 (compose page TTFB)**: p95 **< 600ms** — server-rendered shell + Tiptap dynamic-import on click.
- **SC-010 (submit endpoint)**: p95 **< 1.2s** — sanitiser + segment resolution + reservation insert dominate; mirrors F5 initiate budget.
- **SC-010 (admin queue list)**: p95 **< 500ms** — server-rendered TanStack Table @ ≤1k pending rows; mirrors F4 invoice-list budget.
- **SC-010 (admin approve & send-now)**: p95 **< 1.5s** — Resend Broadcasts API round-trip dominates (Singapore → Resend Ireland ≈ 200–400ms RTT).
- **SC-010 (webhook handler)**: p95 **< 250ms** — signature verify + delivery row upsert + idempotency check.
- **SC-010 (public unsubscribe page)**: p95 **< 400ms** — server-rendered, no auth, no JS dependency for completion.
- **Constitution Principle VI**: LCP < 2.5s, INP < 200ms, CLS < 0.1 on mid-range mobile over 4G (every new screen).
- **Constitution Principle VII**: API p95 < 400ms default. Two **documented exceptions** (in Complexity Tracking): (a) submit endpoint p95 < 1.2s (sanitiser cost on member-supplied HTML up to 200 KB + segment resolution query), (b) approve & send-now p95 < 1.5s (Resend dispatch RTT). Both are inherently network-bound, not code-optimisable.
- **SC-008 (approval → inbox latency)**: p95 < 30 minutes from `broadcast_approved` audit timestamp to median `email.delivered` event timestamp. Resend's own delivery SLA dominates this.

**Constraints**:

- **Marketing-consent compliance** (PDPA Section 24 + GDPR Article 21 + ePrivacy): every broadcast email MUST include a one-click unsubscribe link in the footer; the `/unsubscribe/[token]` route MUST be public, server-rendered, idempotent, and work without client-side JS (FR-029, FR-030).
- **Tenant isolation at BOTH application and database layers** (Constitution v1.4.0 Principle I): cross-tenant probe returns 404 (FR-037) and emits `broadcast_cross_tenant_probe`. Suppression list scoped per-tenant (FR-018 / Clarifications Q8 invariant — same person unsubscribed in tenant A is still deliverable in tenant B).
- **HTML sanitisation NON-NEGOTIABLE** (FR-002a / Clarifications Q4): the unsanitised raw editor output MUST NEVER reach the database; sanitisation runs at the Application layer; Tiptap client-side filtering is best-effort only.
- **Audit retention ≥5 years** per Constitution Principle VIII; F7 events are NOT tax-document events so the default 5-year retention applies (no overlap with F4's 10-year tax-document retention).
- **Forbidden fields in logs** (extends F1+F3+F4+F5 pino redact list): full recipient email addresses, raw email body content, raw subject lines, `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET` (or `AUTH_COOKIE_SIGNING_SECRET` if reused per research.md), full webhook payload bodies (redacted to event-id + event-type + resend-broadcast-id + recipient-email-hash only), session-bearing cookies. Cross-request correlation via member id + broadcast id + sha256 email hash.
- **Webhook endpoint Node.js runtime** (deviation from Vercel Fluid Compute / Edge default for interactive endpoints): required because Resend signature verification demands raw request body access. Documented in Complexity Tracking. Same constraint as F5.
- **Env var schema update** (`src/lib/env.ts`): adds `RESEND_BROADCASTS_API_KEY` (MAY equal `RESEND_API_KEY` per FR-023 — same Resend account supports both products on one key; separate env var for rotation flexibility), `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET` (NEW — choice resolved in research.md § 4 to a dedicated secret for separation from session cookies), `FEATURE_F7_BROADCASTS` (kill switch). zod-validated at boot. Secrets NEVER logged.
- **HSTS + TLS 1.2+** — inherited unchanged.
- **CSP additions** for Tiptap inline styles (Tiptap injects via React-managed inline styles; we use the `nonce` mechanism so inline styles are CSP-safe per F1's existing pattern). No external script CDN required.
- All timestamps ISO 8601 UTC; quota year boundary in Asia/Bangkok (FR-006). BE display deferred to presentation layer where culturally expected (TH locale; matches F4 invoice convention).
- Append-only audit log extended (not restructured) — 37 new event types reuse the existing `payload jsonb` column (count grew from initial 27 across Clarifications Q14 + Q15 + Critique Round 2 R2-NEW-3 + Critique Round 3 R3-NEW-1).

**Scale/Scope**:

- Today: 1 live tenant (SweCham), ~131 members. Quota purchased per tier: Premium 6/yr × ~10 = 60, Large 3/yr × ~20 = 60, Regular 1/yr × ~30 = 30, Diamond 15/yr × ~5 = 75, Platinum 10/yr × ~10 = 100, Gold 6/yr × ~15 = 90 → **~415 broadcasts/year possible**, ~8 broadcasts/week peak.
- Each broadcast averages ~131 recipients (all_members) → ~ 50,000 delivery events/year, ~1,000/week. Resend account quota: well within free-tier broadcast limits (3k/month free, 100k/month at $20/mo).
- Webhook events: each broadcast produces 4 events per recipient (`email.sent`, `email.delivered`, `email.bounced`, `email.complained`). 131 × 4 = ~500 events per broadcast = ~ 4,000 events/week. Trivial for Postgres.
- 5-year SaaS target: ~15-20 tenants × ~1,000 members × 6 broadcasts/year × 1,000 recipients × 4 events = ~ 360M events/year. At this scale `broadcast_deliveries` partitioning would be needed; F7 MVP includes a comment noting partition strategy as a future migration but does NOT implement (YAGNI per Principle X).
- Concurrent admin actions (two admins click Approve at the same time): row-level lock on `broadcasts(broadcast_id)` via `SELECT … FOR UPDATE` serialises (FR-004 + US2 AS6).
- Concurrent cron workers: per-`(tenant_id, broadcast_id)` `pg_advisory_xact_lock` serialises dispatch (US6 AS3); same pattern as F5 webhook idempotency.
- Compose-screen autosave: debounced 1 saves/2s = ≤30/min, far below the 60/5min rate-limit bucket.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security — including v1.4.0 Tenant Isolation clauses**
  - **PII surfaces introduced**: `broadcasts` row stores subject + body_html + reply-to email + estimated recipient count + originating member id + originating user id (the latter three are existing F1+F3 PII); body_html may contain member-authored prose (admin reviews this prose before approval — Clarifications Q3 + Q4). `broadcast_deliveries` row stores recipient_email (lowercased), recipient_member_id (nullable, resolved by lookup). `marketing_unsubscribes` row stores email_lower + member_id (nullable) + optional free-text reason.
  - **Lawful basis**: PDPA §24 contractual ("paid benefit delivery") for member-broadcast requests; GDPR Art. 6(1)(b) (contract performance) for member-side; Art. 6(1)(c) (legal obligation under PDPA §39 audit requirements) for the audit_log retention; Art. 21 (right to object) operationalised as the unsubscribe surface (FR-029–FR-032). **Marketing-consent layer**: PDPA §24 + GDPR/ePrivacy require explicit unsubscribe option on every marketing email — covered by FR-029 one-click unsubscribe + tenant-scoped suppression. Retention 5 years (default) — F7 events are not tax documents.
  - **Purpose limitation**: F7 data used ONLY for broadcast dispatch + delivery tracking + suppression management + admin moderation + audit. NOT used for marketing analytics (open/click tracking explicitly OFF per Assumptions), cross-tenant features, or third-party data sharing.
  - **RBAC**: `member` = compose / submit / cancel / view own broadcasts on `requested_by_member_id = self.member_id`; `admin` = full review queue + approve/reject/cancel + admin proxy submission per Clarifications Q12 + tenant settings; `manager` = read-only on review queue + broadcast detail (FR-014). Enforced by extending F1 `rbac-guard.ts` with `broadcasts:*`, `marketing-unsubscribes:*` resource families.
  - **Tenant Isolation — two-layer defence-in-depth (Constitution v1.4.0 Principle I clauses 1–5):**
    1. **Application layer (clause 1):** every broadcasts use case in `src/modules/broadcasts/application/**` takes a `TenantContext` as an explicit dependency parameter. Forgetting to pass it is a TypeScript compile error. `TenantContext` imported from `@/modules/tenants` — F7 does NOT redefine.
    2. **Database layer (clause 2):** all four F7 tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + the standard `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy. `runInTenant(tenantCtx, fn)` reused unchanged. **Webhook + unsubscribe-page exceptions**: signature verification + token verification run under bypass context because `tenant_id` is not known until parse; immediately after parse the tx re-binds `app.current_tenant` for downstream writes. Narrowest possible windows. Documented in Complexity Tracking.
    3. **Test enforcement (clause 3):** `tests/integration/broadcasts/tenant-isolation.test.ts` — Review-Gate blocker, fails the gate if missing or red. Covers all 4 tables + all 4 mutating verbs from both tenant directions.
    4. **Audit (clause 4):** Cross-tenant probes return 404 (never 403/401) and emit `broadcast_cross_tenant_probe` immediately at high severity. Alert threshold: 1 event / 5 min (alarm), 5 events / hour (incident).
    5. **Super-admin impersonation (clause 5):** not applicable — no super-admin console yet (F13). When F13 lands, super-admin proxied broadcast initiation MUST be explicit + audit-logged with the super-admin identity (same pattern as F4 + F5).
  - **OWASP Top 10 coverage** (delta vs F1+F2+F3+F4+F5 for the F7 surface):
    - **A01 Broken Access Control** — RBAC + RLS + member-to-member ownership check on `POST /api/broadcasts/submit` + admin-only on approve/reject/proxy + webhook signature is the sole authz for `POST /api/webhooks/resend-broadcasts` + signed token is the sole authz for `GET /unsubscribe/[token]`.
    - **A02 Cryptographic Failures** — at-rest AES-256 (Neon) + TLS 1.2+ + `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET` in Vercel env only + Resend webhook HMAC verification via Resend SDK; unsubscribe token HMAC-SHA256 with `UNSUBSCRIBE_TOKEN_SECRET` (timing-attack-resistant `crypto.timingSafeEqual` per F1 pattern).
    - **A03 Injection** — Drizzle parameterised queries; zod on every API boundary; **DOMPurify strict-allowlist sanitisation** is the primary OWASP A03 mitigation for member-authored HTML (FR-002a — without it, every recipient inbox is an XSS vector); Resend event payload parsed by SDK; no dynamic SQL in webhook handler.
    - **A04 Insecure Design** — Cancel-cutoff invariant (Clarifications Q10) + reservation/consumption split (Clarifications Q1) + admin-review gate (FR-011 + spec Assumption) + sanitiser-at-Application-layer + tenant-scoped suppression (FR-018) are deliberate design choices.
    - **A05 Security Misconfiguration** — `FEATURE_F7_BROADCASTS` env flag gates every route; Resend test-vs-live keys in disjoint env vars; CSP nonce mechanism reused.
    - **A06 Vulnerable & Outdated Components** — Tiptap + DOMPurify + email-validator pinned (`@tiptap/react@^3`, `isomorphic-dompurify@^2`, `email-validator@^2`) + Renovate/Dependabot + CI fails on `pnpm audit` HIGH/CRITICAL findings. **Sanitiser is a security-critical component** — version bumps go through extra reviewer scrutiny.
    - **A07 Identification & Authentication Failures** — webhook signature is the only authN for webhook route; signature verification refuses before body parse; failure emits `broadcast_webhook_signature_rejected`. Unsubscribe token is the only authN for `/unsubscribe/[token]`; tampered/expired tokens fall through to a fallback page (NOT silently fail) with `broadcast_unsubscribe_token_invalid` audit.
    - **A08 Software & Data Integrity** — append-only audit log extended (37 new event types); broadcast_deliveries upsert with `ON CONFLICT DO NOTHING` for webhook idempotency.
    - **A09 Logging Failures** — `broadcast_cross_tenant_probe`, `broadcast_webhook_signature_rejected`, `broadcast_unsubscribe_token_invalid`, `broadcast_body_unsafe_html`, `broadcast_audience_too_large`, `broadcast_custom_recipient_unknown` are high-severity audit events with alert routing.
    - **A10 SSRF** — no outbound HTTP from user input. Resend SDK is the only outbound client; endpoint URLs are pinned to `api.resend.com` by the SDK.
  - **TLS 1.2+** + **at-rest AES-256** — inherited unchanged.
  - **Privacy compliance & DSR coverage** (Privacy checklist CHK004 / CHK014 / CHK016 / CHK019 / CHK029 / CHK031 / CHK034 / CHK054 / CHK055):
    - **Cross-border transfer lawful basis** (CHK004 / CHK029 / CHK031): F7 introduces NO new processor — Resend is an existing F1 processor with its product surface extended to Broadcasts. Cross-border transfer compliance therefore inherits F1's existing legal framework: Resend's Data Processing Addendum (DPA) incorporates Standard Contractual Clauses (SCCs) per GDPR Art. 46; Vercel `sin1` + Neon `ap-southeast-1` + Upstash Singapore inherit F1's documented SCC coverage; PDPA §28 cross-border transfer notice to data subjects is covered by SweCham's existing privacy notice (verified by F1 launch). **Re-attestation owner**: legal counsel at /speckit.ship pre-launch review — confirm F7 Broadcasts product surface inherits the F1 Resend DPA without amendment, OR if Resend requires a separate Broadcasts DPA, sign + file before first prod ship.
    - **Data subject rights surface map** (CHK014 / CHK016): F7's contribution to DSR endpoints — (a) **Art. 15 right of access**: members view their own broadcasts via `/portal/broadcasts/[id]` (US3) + their own delivery summaries; broader audit-log read-access is F9 scope, (b) **Art. 17 right to erasure**: cascade documented in `data-model.md` § GDPR Art. 17 erasure cascade (member row delete → F7 audit fields SET NULL while preserving rows for legal-obligation retention), (c) **Art. 20 right to portability**: F9 GDPR-export endpoint will surface F7 data as JSON (broadcasts authored + delivery summaries + suppression entries + acknowledgement timestamp); F7 ships the underlying schema, F9 ships the export endpoint. Manual escape valve (member emails compliance officer) is the gap-filler until F9 ships.
    - **Audit-log access controls** (CHK034): inherits F1 RBAC — `admin` role can read F7 audit events via the F9 audit-viewer surface (deferred to F9 scope); `member` role sees only their own broadcast audit trail via the portal; `manager` role read-only same as admin. Compliance-officer separate role is F13 super-admin scope. F7 itself does NOT introduce a new audit-access RBAC — it consumes F1's pattern.
    - **DPIA + Record-of-Processing** (CHK054 / CHK055): F7 is a sensitive feature (⚠ PII + ⚠ Marketing-consent) that warrants a Data Protection Impact Assessment per Constitution § Compliance: Data Protection. **DPIA owner**: compliance officer at /speckit.ship pre-launch checklist. **DPIA template**: `docs/compliance/dpia-template.md` (post-MVP — F7 ship gate uses an interim assessment co-signed by chamber admin + staff-review agent under solo-maintainer substitute). **Record-of-Processing entry** (PDPA §39 + GDPR Art. 30): populated in `docs/compliance/processing-records.md` § F7 before first prod deploy.
    - **Breach notification workflow** (CHK019): high-severity F7 audit events (`broadcast_cross_tenant_probe`, `broadcast_webhook_signature_rejected`, `broadcast_complaint_rate_per_broadcast_breach`, `broadcast_unsubscribe_token_invalid` rate-limit-exceeded) trigger compliance-officer notification per `docs/runbooks/breach-notification.md` (NEW stub authored at F7 ship; PDPA §37 24-hour notification + GDPR Art. 33 72-hour notification rules; cross-cutting runbook covering F1 + F4 + F5 + F7 events). Alert wiring already in plan § VII alerts #1, #2, #3, #11.

- [x] **II. Test-First Development**
  - **TDD ordering**: every user story (US1–US6) has at least one acceptance test authored red and committed before the matching use-case implementation lands. `tenant-isolation.test.ts`, `webhook-signature.test.ts`, `webhook-idempotency.test.ts`, `html-sanitiser.test.ts`, `custom-recipient-validation.test.ts`, `cancellation-cutoff.test.ts`, and `unsubscribe-token.test.ts` are authored red at the very start of the implementation phase.
  - **Coverage thresholds** (extending F1+F2+F3+F4+F5 `vitest.config.ts`):
    - Domain layer (`src/modules/broadcasts/domain/**`): 100% line — `Broadcast` state machine (`draft → submitted → approved → sending → sent` + side branches), `BroadcastDelivery` aggregate, `MarketingUnsubscribe` value object, `RecipientSegment` policy object, `Quota` value object (used + reserved + remaining + cap), `EmailLower` VO (lowercase + trim normalisation), invariants (`one-active-broadcast-state-at-a-time`, `quota-counter-non-negative`, `dispatch-only-from-approved`, `cancel-only-from-submitted-or-approved`, `suppression-tenant-scoped`).
    - Application layer (`src/modules/broadcasts/application/**`): ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases** listed above.
  - **Contract tests** (`tests/contract/broadcasts/`): one file per REST endpoint + one file per webhook event type (`email.sent`, `email.delivered`, `email.bounced`, `email.complained`), asserting request/response shapes against shared zod schemas.
  - **Integration tests** (`tests/integration/broadcasts/`): hit live Neon Singapore + a real Resend test account (secrets in CI env). Scenarios listed above.
  - **Red test suite on `main` = stop-the-line** — same as F1+F2+F3+F4+F5.

- [x] **III. Clean Architecture**
  - **One new bounded context**: `src/modules/broadcasts/` (full four-layer Domain → Application → Infrastructure + Presentation via `src/app/`). Public barrel (`index.ts`); ESLint `no-restricted-imports` extended to forbid deep imports into `broadcasts/{domain,application,infrastructure}` from outside the module.
  - **Domain layer has zero framework imports** — no `next`, `drizzle-orm`, `resend`, `@tiptap/*`, `isomorphic-dompurify`, `react`. Holds `Broadcast` aggregate root, `BroadcastDelivery` root, `MarketingUnsubscribe` VO, `RecipientSegment` policy, `BroadcastStatus`, `DeliveryStatus`, `SegmentType` sum type, `EmailLower` VO, `QuotaCounter` VO (immutable; total-ordering on consumed/reserved/remaining), invariants. `TenantContext` imported from `@/modules/tenants`.
  - **Application layer orchestrates Domain via ports** — `BroadcastsRepo`, `BroadcastDeliveriesRepo`, `MarketingUnsubscribesRepo`, `BroadcastSegmentDefinitionsRepo`, `BroadcastsGatewayPort` (wraps Resend SDK Broadcasts API surface — `audiences.create`, `audiences.contacts.create`, `broadcasts.create`, `broadcasts.send`, `webhooks.constructEvent`-equivalent), `WebhookVerifierPort` (wraps Resend's HMAC verification), `HtmlSanitizerPort` (wraps `isomorphic-dompurify` with explicit allowlist config), `EmailValidatorPort` (wraps `email-validator`), `MembersBridgePort` (wraps F3 barrel — `getMembersBySegment`, `getMemberPrimaryContact`, `lookupContactEmailInTenant`, `lookupMemberPrimaryContactEmailInTenant`), `EventAttendeesRepository` **(stub-port — returns `[]` until F6 swap; FR-015a / Clarifications Q5)**, `AuditPort`, `ClockPort`, `RateLimiterPort` (F1 Upstash adapter), `EmailTransactionalPort` (wraps F1+F4 Resend transactional client for admin/member notifications about broadcasts — distinct from Broadcasts product). All use cases return `Result<T, E>` (reusing `src/lib/result.ts`).
  - **Infrastructure layer** owns Drizzle schema, migrations, repo implementations, the Resend Broadcasts SDK adapter, the webhook signature verifier, the DOMPurify sanitiser adapter, the email-validator adapter, the F3 bridge adapter, the EventAttendeesRepository stub (returns `[]`), the audit adapter, the rate-limiter adapter. Drizzle-inferred types do NOT leak into Application.
  - **Presentation layer** (`src/app/(member)/portal/broadcasts/**`, `src/app/(member)/portal/benefits/e-blasts/**`, `src/app/(staff)/admin/broadcasts/**`, `src/app/api/broadcasts/**`, `src/app/api/admin/broadcasts/**`, `src/app/api/webhooks/resend-broadcasts/route.ts`, `src/app/unsubscribe/[token]/**`) calls public barrels only.
  - **Cross-module imports**:
    - `broadcasts` → `auth` (session, RBAC) via public barrel.
    - `broadcasts` → `tenants` (`TenantContext`) via public barrel.
    - `broadcasts` → `members` (4 new exports for FR-015c + FR-015d resolvers) via public barrel. Unidirectional `broadcasts → members`; F3 does NOT depend on F7.
    - `broadcasts` → `plans` (read-only `getPlanForMember` for `eblast_per_year` lookup; FR-002 precondition `a` + FR-009) via public barrel.
    - F3 public barrel will be extended with four new exports dedicated to the F7 contract: `getMembersBySegment(tenantCtx, segmentType, params)`, `getMemberPrimaryContact(tenantCtx, memberId)`, `lookupContactEmailInTenant(tenantCtx, emailLower)`, `lookupMemberPrimaryContactEmailInTenant(tenantCtx, emailLower)`. These extensions land on F7's branch (not retroactively on F3's shipped branch) — same pattern as F5 extending F4's barrel.

- [N/A] **IV. Payment Security (PCI DSS) — NON-NEGOTIABLE**
  - **F7 has no payment surface.** No card capture, no PaymentIntent, no charge, no refund, no money movement. Payment-touching flows are exclusively F5 (already shipped on `009-online-payment` PR #16). F7's interaction with billing is purely upstream: the E-Blast benefit is a quota line on the member's annual membership invoice (F4), priced into the tier-level `annual_fee` (F2). Pay-per-send beyond quota is explicitly OUT of MVP scope (F11 SaaS Billing scope) per spec Assumptions.
  - PCI scope unchanged. SAQ-A eligibility unchanged (F5's responsibility). No new gate required.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV + EN + TH)** — UI uses `next-intl` messages keyed under `portal.broadcasts.*`, `portal.benefits.eblast.*`, `admin.broadcasts.*`, `admin.broadcastsReview.*`, `email.broadcastSubmitted.*`, `email.broadcastApproved.*`, `email.broadcastRejected.*`, `email.broadcastDelivered.*`, `email.broadcastFooter.*` (the broadcast-email FOOTER which contains the unsubscribe CTA — the body is member-authored and NOT translated per FR-041), `unsubscribe.*` (public route) in `messages/{en,th,sv}.json`. Missing EN keys fail the build; TH+SV enforced on release branches via `pnpm check:i18n`. Subject + body content authored by member is itself NOT translated by the system (FR-041) — system chrome around it (labels, errors, empty states, status badges, audit-log labels, confirmation emails) is locale-aware. Member compose surface respects `useLocale()` for the editor toolbar tooltips + segment picker labels. Unsubscribe page locale resolution: `lang` query param (signed in token) → Accept-Language → tenant-default → EN.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + Enterprise Standards)** — `docs/ux-standards.md` § 15 checklist is a merge blocker. Shimmer skeleton on compose page during draft restore + on admin queue during initial load (CLS 0). `sonner` toasts on every mutation (submit, approve, reject, cancel, unsubscribe). Confirmation dialog on reject (free-text reason required) + cancel (typed-phrase pattern for destructive actions per F4 convention). `aria-live` announces submission state transitions + admin queue updates + unsubscribe confirmation. `prefers-reduced-motion` swaps editor focus animations + queue list-update animations. Full keyboard nav on Tiptap (Ctrl+B/I/U/Z + Tab to focus toolbar — Tiptap ships keyboard-complete by default), segment picker, scheduling picker, admin queue, and unsubscribe page. Mobile-first compose surface (320px works; rich-text editor collapses toolbar to overflow menu on `< sm`). **Recipient/member self-service portal inherits identical standards** — no degraded UX for the member persona. A11y coverage extends to public unsubscribe page (server-rendered; no JS dependency for completion).

- [x] **VII. Performance & Observability** — `pino` JSON logs with `logger.child({ tenant, broadcast_id, member_id, resend_event_id })`. New redact keys: `recipient_email`, `recipient_emails`, `body_html`, `subject` (when logging broadcast contents — only event-id + counts logged), `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, `Resend-Signature`, `Authorization`, full webhook body (redacted to event-id + event-type + resend-broadcast-id + recipient-email-sha256 only). `@vercel/otel` traces span: `compose_load → editor_typed → submit_endpoint → sanitiser → segment_resolver → reservation_insert → admin_queue_visible → admin_approve → resend_dispatch → webhook_receive → webhook_verify → delivery_row_insert → quota_consumed` with `tenant.id`, `broadcast.id`, `member.id`, `segment.type`, `resend.broadcast_id`, `resend.event_id` attributes. Vercel Speed Insights + Lighthouse CI inherited.
  
  **SLOs** (per Clarifications Q6 / SC-010):
  - **SLO-F7-001 (compose page TTFB)**: p95 < 600ms
  - **SLO-F7-002 (submit endpoint)**: p95 < 1.2s
  - **SLO-F7-003 (admin queue list)**: p95 < 500ms @ 1k pending
  - **SLO-F7-004 (admin approve & send-now)**: p95 < 1.5s
  - **SLO-F7-005 (webhook handler)**: p95 < 250ms
  - **SLO-F7-006 (public unsubscribe page)**: p95 < 400ms
  - **SLO-F7-007 (approval → inbox)**: p95 < 30 minutes (FR-040 + SC-008; Resend SLA dominates)
  - **SLO-F7-008 (admin queue median time-to-decision)**: ≤ 24h, p95 ≤ 48h (SC-002; ops-managed not perf-managed)
  
  **Metrics** (16 new — backing SC-010):
  - `broadcasts.submitted_count{tenant}` (counter)
  - `broadcasts.approved_count{tenant}` (counter)
  - `broadcasts.rejected_count{tenant}` (counter)
  - `broadcasts.cancelled_count{tenant, actor_role}` (counter)
  - `broadcasts.sent_count{tenant}` (counter)
  - `broadcasts.delivered_recipients{tenant}` (counter)
  - `broadcasts.bounced_recipients{tenant, bounce_type}` (counter)
  - `broadcasts.complained_recipients{tenant}` (counter)
  - `broadcasts.unsubscribes{tenant}` (counter)
  - `broadcasts.queue_age_p95_seconds{tenant}` (histogram — submit→approve latency)
  - `broadcasts.dispatch_failures{tenant, retry_attempt}` (counter)
  - `broadcasts.compose_page_ttfb_seconds{tenant}` (histogram — SLO-F7-001)
  - `broadcasts.submit_endpoint_seconds{tenant}` (histogram — SLO-F7-002)
  - `broadcasts.admin_queue_list_seconds{tenant}` (histogram — SLO-F7-003)
  - `broadcasts.approve_send_now_endpoint_seconds{tenant}` (histogram — SLO-F7-004)
  - `broadcasts.webhook_handler_seconds{tenant}` (histogram — SLO-F7-005)
  - `broadcasts.unsubscribe_page_ttfb_seconds{tenant}` (histogram — SLO-F7-006)
  - `broadcasts.suppression_filter_count{tenant}` (counter — # of recipients filtered per dispatch)
  - `broadcasts.audit_emit_count{tenant, event_type}` (counter — for ops dashboard)
  
  **Alerts** (11 new — extending observability.md):
  1. 1 cross-tenant probe / 5 min (alarm)
  2. 1 webhook signature rejection / 5 min (alarm — possible abuse)
  3. 1 unsubscribe-token invalid / 5 min (alarm — possible enumeration)
  4. webhook handler p99 > 500ms (alarm — SLO-F7-005 ×2 budget)
  5. submit endpoint p99 > 2.4s (alarm — SLO-F7-002 ×2 budget)
  6. approve-send-now p99 > 3s (alarm — SLO-F7-004 ×2 budget)
  7. complaint rate > 0.5% over 1h (alarm — early-warning before either the per-broadcast spike #11 or the rolling-30d alarm #8 fires)
  8. bounce + complaint combined > 2% over 24h (page — SC-005 (a) rolling-30d invariant violation)
  9. `dispatch_failures` > 5 / 30min for any tenant (alarm — Resend outage indicator)
  10. `queue_age_p95_seconds` > 48h × 3600 = 172800 across rolling 30d (alarm — SC-002 violation; admin queue ops escalation)
  11. `broadcast_complaint_rate_per_broadcast_breach` audit event fires (page — SC-005 (b) per-broadcast spike per Clarifications Q14 + Critique Round 3 R3-NEW-4; high severity; member auto-halted via `broadcasts_halted_until_admin_review` flag; runbook link to `docs/runbooks/broadcast-deliverability-incident.md` § per-broadcast spike triage)
  
  Runbook additions: `docs/runbooks/broadcast-deliverability-incident.md` (NEW — covers complaint-rate spike + bounce-rate spike triage), `docs/runbooks/broadcast-cancel-too-late.md` (NEW — covers the rare case where dispatch happened but admin needs to follow up with recipients), `docs/runbooks/breach-notification.md` (NEW stub at F7 ship — Privacy checklist CHK019; cross-cutting PDPA §37 24h + GDPR Art. 33 72h notification workflow triggered by high-severity F1/F4/F5/F7 audit events including F7's `broadcast_cross_tenant_probe`, `broadcast_webhook_signature_rejected`, `broadcast_complaint_rate_per_broadcast_breach`, repeated `broadcast_unsubscribe_token_invalid`), `docs/observability.md` § F7 Email Broadcast (NEW section).

  **Vercel platform-layer log redaction verification** (Privacy checklist CHK048 / Round 1 critique E11): the F7 application-layer pino redact list (FR-042) covers application logs but Vercel's platform-layer access logs MUST also redact `/unsubscribe/[token]` URLs to prevent token leakage in the platform log retention window. **Verification task** at /speckit.tasks Phase 0: configure Vercel project's "log drains / log redaction" feature (or document the absence + accepted risk if Vercel does not yet expose this configuration) so the URL path component matching `/unsubscribe/v1\..*` is masked in the access logs UI + log-drain export. If Vercel does not support per-path redaction, the mitigation is to document the limited risk (token is HMAC-signed + replays are idempotent + token URL access requires both signing-secret compromise AND access to log retention) and add a quarterly secret-rotation cadence for `UNSUBSCRIBE_TOKEN_SECRET` to bound the breach window.

  **Secret-rotation procedure** (Security checklist CHK041 + Round 1 critique E19 — credential-compromise runbook): every F7-introduced secret MUST have a documented rotation procedure with operational steps. Cadence + zero-downtime rotation pattern per secret:

  | Secret | Cadence | Rotation procedure (zero-downtime) | Compromise response |
  |--------|---------|-------------------------------------|---------------------|
  | `RESEND_BROADCASTS_API_KEY` | quarterly (or on suspected compromise) | (1) generate new key in Resend dashboard, (2) `vercel env add` new value to all environments, (3) `vercel deploy` triggers rebuild with new key, (4) revoke old key in Resend dashboard after deploy succeeds + 24h soak. Application-side: SDK reads from env at boot — no in-flight broadcasts affected because send happens BEFORE webhook ingest. | Page on-call → run the runbook → rotate within 1h → audit Resend dashboard for unauthorized broadcasts in compromise window → notify recipients of unauthorized sends per breach-notification.md |
  | `RESEND_BROADCASTS_WEBHOOK_SECRET` | annually (or on suspected compromise) | (1) generate new secret in Resend dashboard, (2) configure dashboard to ALSO accept old secret during transition (Resend supports dual-secret mode for ~30s overlap), (3) `vercel env add` new value, (4) `vercel deploy`, (5) remove old secret from Resend dashboard. Inflight events: any event signed with old secret during the transition window is still verified. | Rotate within 1h → audit `broadcast_webhook_signature_rejected` events in compromise window → re-verify legitimate dispatches via Resend dashboard cross-reference |
  | `UNSUBSCRIBE_TOKEN_SECRET` | quarterly (per CHK048 fallback if Vercel platform redaction unavailable) | NOT zero-downtime — rotation invalidates ALL outstanding unsubscribe links. Pre-rotation: post a "We are upgrading our unsubscribe security" notice in the next broadcast footer with manual unsubscribe instructions (email support). Cadence: annual baseline + quarterly if R4-NEW-5 / CHK048 platform-layer redaction is unavailable. | Rotate within 24h (NOT 1h — coordinate with member communication) → audit recent unsubscribe traffic for anomalies → manually re-send unsubscribe links via support if requests arrive citing invalid tokens |
  | `CRON_SECRET` (reused F4/F5/F7) | annually (cross-feature) | (1) generate new value, (2) `vercel env add` new value, (3) update cron-job.org Bearer header in dashboard, (4) `vercel deploy`, (5) verify cron-job.org delivers within 5 min, (6) remove old value. Cross-cutting: F4 + F5 + F7 all use this; coordinate. | Rotate immediately + verify all 3 features' cron triggers resume within 5 min |

  All rotations MUST be logged via `secret_rotated` audit event (cross-cutting F1 audit catalogue addition; if not yet present, add at next F1 amendment cycle). The runbook lives at `docs/runbooks/credential-compromise.md` (NEW stub at F7 ship — Round 1 critique E19; cross-cutting F1+F4+F5+F7 secrets; covers all 4 secret families above + F1 + F4 + F5 keys with consistent procedure).

- [x] **VIII. Reliability (Error Handling + Data Integrity + Audit Trail)** — heavy principle for F7 given external service + member-authored content + recipient-list dispatch.
  - Every error path returns a typed `Result<T, E>`.
  - **Transactional boundaries** (each = one Postgres transaction):
    - **Save draft** (FR-001): authz → upsert `broadcasts(tenant_id, broadcast_id, status='draft')` with content fields → audit `broadcast_drafted` (one event per draft creation; subsequent edits do NOT re-audit per FR-004 — drafts are mutable, only the create-event is audited) → commit.
    - **Submit broadcast** (FR-002): authz check → preconditions a–j check (per FR-002 + FR-002a sanitiser + FR-015c/d + FR-016a) → reserve quota slot via `UPDATE broadcasts SET status='submitted'` (atomic) → resolve segment via `getMembersBySegment` (or `EventAttendeesRepository.findRecentAttendeeEmails` stub) → compute `estimated_recipient_count` → suppression filter → insert reservation invariant → audit `broadcast_submitted` with actor_role + member_id + segment + estimated_count → enqueue admin notification email via F1 transactional Resend (NOT Broadcasts) → commit. If sanitiser rejects, no row mutation; `broadcast_body_unsafe_html` audit + 422.
    - **Approve broadcast (send now)** (FR-011 + US2 AS2): authz (`admin`) → `SELECT … FOR UPDATE` on `broadcasts(broadcast_id)` → check current state ∈ {submitted} → call `BroadcastsGateway.createBroadcast` + `sendBroadcast` (Resend Broadcasts API) outside tx with **stable** idempotency-key `broadcast-{tenantId}-{broadcastId}` per FR-020 (Critique 2026-04-29 E2/X2 — no attempt counter; key stays stable across retries so Resend's idempotency primitive returns the same existing broadcast on a re-dispatch instead of creating a duplicate) → on success, `UPDATE status='approved' THEN 'sending'` (two transitions, both audited) + `resend_broadcast_id` stored → audit `broadcast_approved` (admin actor) + `broadcast_send_started` (system actor + resend id) → enqueue member notification via F1 transactional → commit. If Resend 5xx, retry per FR-021 with the SAME stable key. If Resend 4xx, transition to `failed_to_dispatch` per FR-022. **Cross-tx-failure recovery**: if the Resend call succeeds but the post-call DB update fails (network timeout on commit, etc.), the row remains in `approved` and the cron handler will pick it up; the next dispatch reuses the SAME stable idempotency key and Resend returns the existing broadcast without creating a duplicate. The handler then updates the row to `sending` and proceeds normally.
    - **Approve broadcast (schedule for future)** (FR-011 + US2 AS4): authz → state-check → `UPDATE status='approved', scheduled_for=$1` (no Resend call yet) → audit `broadcast_approved` with `scheduled_for` field → commit. Cron handler (US6) picks up later.
    - **Reject broadcast** (FR-012 + US2 AS3): authz → state-check `submitted` → require non-empty reason → `UPDATE status='rejected', rejection_reason=$1` → release quota reservation (derived from new state per FR-003) → audit `broadcast_rejected` with `rejection_reason_hash = sha256(reason)` (NOT raw reason in audit) → enqueue member notification with verbatim reason via F1 transactional → commit.
    - **Cancel broadcast** (FR-004a + Clarifications Q10): authz (member-self OR admin; manager-no) → state-check ∈ {submitted, approved} → `UPDATE status='cancelled', cancellation_reason=$1` → release reservation → audit `broadcast_cancelled` with actor_id + actor_role + optional reason → enqueue notification via F1 transactional → commit. Reject from {sending, sent, cancelled, rejected, failed_to_dispatch} with 409 + `broadcast_cancel_too_late` audit.
    - **Cron dispatch scheduled broadcasts** (US6 + FR-021): cron-job.org HTTP trigger every 5 min hits `/api/cron/broadcasts/dispatch-scheduled` (Bearer auth via `CRON_SECRET` reused from F4/F5) → `SELECT … FOR UPDATE SKIP LOCKED` on `broadcasts WHERE status='approved' AND scheduled_for <= now()` → for each row, acquire `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenant_id||':'||broadcast_id, 0))` (per-broadcast lock; namespace `broadcasts:` disjoint from F4 `invoicing:` and F5 `payments:`) → call Resend dispatch outside tx → `UPDATE status='sending', resend_broadcast_id=$1` → audit `broadcast_send_started` → commit. Per FR-021 retry on 5xx; per FR-022 fail-fast on 4xx.
    - **Stuck-`sending` reconciliation** (Critique 2026-04-29 R2-NEW-3): when the 24h timeout fires (FR-028) on a `sending` broadcast — i.e., the expected-vs-received-count check decides the broadcast must transition to `sent` because of timeout rather than full event arrival — BEFORE consuming quota, the timeout handler MUST query `BroadcastsGateway.retrieveBroadcast({ id: resend_broadcast_id })`. If Resend returns 404 (the broadcast was manually deleted via the Resend dashboard or never properly dispatched), transition to `failed_to_dispatch` instead of `sent`, release the quota reservation per FR-003, audit `broadcast_resend_resource_missing` (33rd entry in F7 audit catalogue), and alert admin. If Resend returns the broadcast normally, proceed with the standard `sent` transition (events were just delayed). Adds ~200ms to the rare 24h-timeout path; prevents the failure mode "quota consumed but recipients never received the broadcast." Mirror this check in the manual operational runbook for stuck-`sending` broadcasts.
    - **Process webhook event** (FR-024–FR-028): verify signature (throws on mismatch → 401 + audit `broadcast_webhook_signature_rejected`) → parse event → upsert `broadcast_deliveries(tenant_id, resend_event_id) ON CONFLICT DO NOTHING` (idempotency primitive per FR-025) → resolve broadcast via `resend_broadcast_id` lookup → enter `runInTenant(ctx, ...)` → branch on event type:
      - **`email.delivered`**: insert delivery row with status=delivered. After all expected events received OR 24h timeout, transition `sending → sent` + stamp `quota_consumed_at` + audit `broadcast_sent` + `broadcast_quota_consumed` + enqueue summary email via F1 transactional.
      - **`email.bounced`** (hard bounce): insert delivery row with status=bounced + auto-add to `marketing_unsubscribes` with reason=`hard_bounce` (FR-027) → audit `broadcast_suppression_applied`.
      - **`email.complained`**: insert delivery row with status=complained + auto-add to suppression with reason=`complaint` + admin alert (deliverability KPI) → audit `broadcast_complaint_received`.
    - **Public unsubscribe** (FR-029–FR-032): verify HMAC token using `UNSUBSCRIBE_TOKEN_SECRET` (timing-safe-equal) → on fail, render fallback page + audit `broadcast_unsubscribe_token_invalid` → on success, parse `(tenant_id, broadcast_id, recipient_email_lower)` → enter `runInTenant(ctx, ...)` → upsert `marketing_unsubscribes(tenant_id, email_lower) ON CONFLICT DO NOTHING` with `unsubscribed_at=now()`, `member_id=resolveMemberByEmail(email_lower)`, `source_token=sha256(token)`, optional `reason` if recipient typed feedback → audit `broadcast_unsubscribed` → render confirmation page → commit. Idempotent — replayed link shows "Already unsubscribed" with no duplicate row.
  - **Idempotency**:
    - `broadcast_deliveries(tenant_id, resend_event_id) UNIQUE` — webhook-event idempotency primitive (FR-025).
    - `broadcasts(resend_broadcast_id) UNIQUE` — Resend dispatch idempotency.
    - `marketing_unsubscribes(tenant_id, email_lower) PRIMARY KEY` — unsubscribe idempotency primitive (replays = no-op upsert).
    - Cron dispatch idempotency: `SELECT … FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock` per `(tenant_id, broadcast_id)` ensures exactly-once even with concurrent cron workers.
    - `POST /api/broadcasts/submit` accepts an optional `Idempotency-Key` header; if omitted, the body sha256 + tenant + member used.
  - **Audit-log entries**: 37 new event types enumerated in spec FR-033. Retention 5 years (default). Append-only.
  - **Failure modes catalogued** per the Resend `email.*` event surface (research.md § 3).

- [x] **IX. Code Quality Standards** — TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (already repo defaults). ESLint: new module ships with its own `no-restricted-imports` + shared rules unchanged. Conventional Commits enforced by `commit-msg` hook; `[Spec Kit]` prefix on gate-advancing commits. Review gate: **≥2 reviewers** (PII + marketing-consent sensitivity per Constitution Principle IX). If only one human reviewer is available, the Principle IX solo-maintainer substitute applies — documented in Complexity Tracking + retrospective; the substitute stack mandated for this branch is: (a) automated `/speckit.review` (≥3 passes with decreasing severity), (b) `/speckit.staff-review` (correctness + security + tests agents; second post-remediation round if any BLOCKER/CRITICAL), (c) `pdpa-gdpr-compliance-officer` agent pass (marketing-consent + unsubscribe surface review), (d) `security-threat-modeler` agent pass (HTML-sanitisation XSS surface + token-forgery surface), (e) DB-level RLS+FORCE defence + sanitiser-at-Application-layer defence-in-depth, (f) post-remediation verification via `/speckit.verify`. Evidence captured in `specs/010-email-broadcast/retrospective.md` on ship.

- [x] **X. Simplicity (YAGNI)** — F7 MVP scope is tightly bounded by construction: no per-tenant Resend BYOK (deferred F12), no pay-per-send (deferred F11), no attachments (deferred F7.1), no open/click tracking (privacy-OFF default), no drag-and-drop builder (Tiptap rich-text suffices), no A/B testing, no drip campaigns, no AI content generation, no send-time optimisation, no query-builder segments (deferred F7.1), no per-contact opt-in flag (deferred F7.1), no external-invitee broadcasts (deferred F7.1), no spam-score estimator, no PII content scanner, no in-app inbox / reply tracking, no social cross-posting. Any adoption of these features MUST come back through `/speckit.specify`. Deviations that survived the Constitution Check are itemised in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/010-email-broadcast/
├── plan.md                     # This file
├── research.md                 # Phase 0 output
├── data-model.md               # Phase 1 output
├── contracts/                  # Phase 1 output
│   ├── broadcasts-api.md       # /api/broadcasts/* + /api/admin/broadcasts/*
│   ├── resend-webhook.md       # /api/webhooks/resend-broadcasts + event handler contract
│   └── unsubscribe-public.md   # /unsubscribe/[token] public route
├── quickstart.md               # Phase 1 output — local Resend setup (Broadcasts API enable, webhook tunnel, audience seed, env vars)
├── checklists/
│   └── requirements.md         # Already exists (post-/speckit.clarify)
└── tasks.md                    # /speckit.tasks output — NOT created by /speckit.plan
```

### Source Code (repository root)

```text
src/
├── app/                                                # Presentation
│   ├── (member)/portal/
│   │   ├── _components/
│   │   │   └── marketing-acknowledgement-banner.tsx    # NEW — Q15/R3-NEW-2 GDPR Art. 7 banner; server-rendered; appears on every sign-in until acknowledged; per-tenant scope per Q19; tier-filter `eblast_per_year > 0 OR is_active`; "Acknowledge" CTA emits `member_acknowledged_broadcasts_terms` audit + sets `broadcasts_acknowledged_at`; "Remind me later" link dismisses for current page-load only
│   │   ├── benefits/
│   │   │   └── e-blasts/
│   │   │       └── page.tsx                            # NEW — US3 quota + history dashboard
│   │   └── broadcasts/
│   │       ├── new/
│   │       │   ├── page.tsx                            # NEW — US1 compose surface
│   │       │   ├── loading.tsx                         # NEW — shimmer skeleton
│   │       │   └── _components/
│   │       │       ├── compose-form.tsx                # NEW — react-hook-form + zod
│   │       │       ├── editor/
│   │       │       │   ├── tiptap-editor.tsx           # NEW — Tiptap dynamic-imported
│   │       │       │   ├── tiptap-toolbar.tsx          # NEW — bold/italic/list/link
│   │       │       │   └── editor-skeleton.tsx         # NEW — shimmer while Tiptap loads
│   │       │       ├── segment-picker.tsx              # NEW — fixed segments + custom-list paste
│   │       │       ├── custom-list-input.tsx           # NEW — 100-entry textarea + per-entry validation feedback
│   │       │       ├── schedule-picker.tsx             # NEW — optional future-send datepicker
│   │       │       ├── preview-pane.tsx                # NEW — split-pane email preview
│   │       │       ├── quota-display.tsx               # NEW — used / reserved / remaining counters
│   │       │       └── submit-button.tsx               # NEW — disabled when preconditions fail
│   │       └── [id]/
│   │           ├── page.tsx                            # NEW — US3 broadcast detail (member view)
│   │           └── loading.tsx                         # NEW — shimmer skeleton
│   ├── (staff)/admin/broadcasts/
│   │   ├── page.tsx                                    # NEW — US2 admin queue (TanStack Table)
│   │   ├── loading.tsx                                 # NEW — shimmer skeleton
│   │   ├── _components/
│   │   │   ├── queue-table.tsx                         # NEW — server-side sort/filter/pagination
│   │   │   ├── review-actions.tsx                      # NEW — Approve / Schedule / Reject buttons
│   │   │   ├── reject-dialog.tsx                       # NEW — required free-text reason
│   │   │   ├── proxy-submit-dialog.tsx                 # NEW — admin-on-behalf-of-member (Q12)
│   │   │   ├── halt-state-banner.tsx                   # NEW — Q14/R3-NEW-3 clear-halt UI; top-of-page list of halted members + per-row "Review + Clear halt" button
│   │   │   ├── clear-halt-dialog.tsx                   # NEW — typed-phrase confirmation for Clear halt action (matches F4 destructive-action convention)
│   │   │   └── manager-readonly-banner.tsx             # NEW — when manager role
│   │   └── [id]/
│   │       ├── page.tsx                                # NEW — admin broadcast detail with delivery breakdown
│   │       └── loading.tsx                             # NEW — shimmer skeleton
│   ├── unsubscribe/
│   │   └── [token]/
│   │       └── page.tsx                                # NEW — public route (no auth); FR-029–FR-032
│   ├── api/
│   │   ├── broadcasts/
│   │   │   ├── draft/route.ts                          # NEW — POST/PUT/DELETE draft
│   │   │   ├── submit/route.ts                         # NEW — POST submit (FR-002)
│   │   │   ├── [id]/route.ts                           # NEW — GET own broadcast
│   │   │   ├── [id]/cancel/route.ts                    # NEW — POST cancel (member)
│   │   │   └── quota/route.ts                          # NEW — GET own quota counters
│   │   ├── admin/broadcasts/
│   │   │   ├── route.ts                                # NEW — GET review queue (admin)
│   │   │   ├── sla-stats/route.ts                      # NEW — GET SLA banner data (FR-013 / N2 remediation)
│   │   │   ├── [id]/approve/route.ts                   # NEW — POST approve (now or schedule)
│   │   │   ├── [id]/reject/route.ts                    # NEW — POST reject with reason
│   │   │   ├── [id]/cancel/route.ts                    # NEW — POST cancel (admin)
│   │   │   └── proxy-submit/route.ts                   # NEW — POST admin-on-behalf-of-member (Q12)
│   │   ├── webhooks/
│   │   │   └── resend-broadcasts/route.ts              # NEW — POST webhook (Node runtime, raw body)
│   │   └── cron/
│   │       └── broadcasts/
│   │           ├── dispatch-scheduled/route.ts         # NEW — cron-job.org HTTP trigger every 5min
│   │           ├── reconcile-stuck-sending/route.ts    # NEW — cron-job.org HTTP trigger every 15min (R2-NEW-3 / perf.md CHK033)
│   │           └── prune-expired-drafts/route.ts       # NEW — cron-job.org HTTP trigger daily (FR-001a / A1 remediation)
│   └── middleware.ts                                   # EDITED — CSP nonce reused; no new directives
├── modules/broadcasts/                                 # NEW — F7 bounded context
│   ├── domain/
│   │   ├── broadcast.ts                                # aggregate root + state machine
│   │   ├── broadcast-delivery.ts                       # aggregate
│   │   ├── marketing-unsubscribe.ts                    # value object
│   │   ├── recipient-segment.ts                        # policy + sum type
│   │   ├── value-objects/
│   │   │   ├── email-lower.ts                          # lowercase + trim VO
│   │   │   ├── quota-counter.ts                        # used + reserved + remaining
│   │   │   ├── broadcast-status.ts                     # enum + transition map
│   │   │   ├── segment-type.ts                         # 'all_members' | 'tier' | 'event_attendees_last_90d' | 'custom'
│   │   │   └── delivery-status.ts                      # 'sent' | 'delivered' | 'bounced' | 'complained'
│   │   ├── invariants/
│   │   │   ├── quota-counter-non-negative.ts
│   │   │   ├── one-active-broadcast-state.ts
│   │   │   └── suppression-tenant-scoped.ts
│   │   └── policies/
│   │       ├── broadcast-status-transitions.ts         # FR-004 + FR-004a state machine
│   │       └── cancel-cutoff-policy.ts                 # Clarifications Q10
│   ├── application/
│   │   ├── ports/
│   │   │   ├── broadcasts-repo.ts
│   │   │   ├── broadcast-deliveries-repo.ts
│   │   │   ├── marketing-unsubscribes-repo.ts
│   │   │   ├── broadcast-segment-definitions-repo.ts
│   │   │   ├── broadcasts-gateway-port.ts              # Resend Broadcasts SDK abstraction
│   │   │   ├── webhook-verifier-port.ts                # signature verification abstraction
│   │   │   ├── html-sanitizer-port.ts                  # FR-002a contract
│   │   │   ├── email-validator-port.ts                 # FR-015d format check
│   │   │   ├── members-bridge-port.ts                  # F3 barrel — primary contact + segment resolvers
│   │   │   ├── plans-bridge-port.ts                    # F2 barrel — eblast_per_year lookup
│   │   │   ├── event-attendees-repository.ts           # FR-015a stub-port (Q5) — F6 swap target
│   │   │   ├── unsubscribe-token-port.ts               # HMAC sign + verify
│   │   │   ├── audit-port.ts
│   │   │   ├── clock-port.ts
│   │   │   ├── rate-limiter-port.ts                    # F1 Upstash
│   │   │   └── email-transactional-port.ts             # F1+F4 transactional Resend (NOT Broadcasts)
│   │   ├── save-draft.ts
│   │   ├── submit-broadcast.ts                         # US1 + FR-002 use case
│   │   ├── cancel-broadcast.ts                         # FR-004a + Q10
│   │   ├── approve-broadcast.ts                        # US2 + FR-011 (now or schedule)
│   │   ├── reject-broadcast.ts                         # US2 + FR-012
│   │   ├── proxy-submit-broadcast.ts                   # Q12 admin-on-behalf
│   │   ├── dispatch-scheduled-broadcast.ts             # US6 cron handler use case
│   │   ├── process-webhook-event.ts                    # root dispatcher (FR-024–FR-028)
│   │   ├── handle-delivered-event.ts                   # email.delivered branch
│   │   ├── handle-bounced-event.ts                     # email.bounced + auto-suppression (FR-027)
│   │   ├── handle-complained-event.ts                  # email.complained + alert (FR-027)
│   │   ├── unsubscribe-recipient.ts                    # FR-031 public route handler use case
│   │   ├── sanitize-html.ts                            # FR-002a — wraps HtmlSanitizerPort
│   │   ├── validate-custom-recipients.ts               # FR-015d — wraps EmailValidatorPort + MembersBridgePort
│   │   ├── resolve-segment-recipients.ts               # FR-015c + FR-015a + FR-016a + FR-017
│   │   ├── compute-quota-counter.ts                    # FR-003 derived view
│   │   └── enforce-tenant-context.ts                   # cross-tenant probe refusal helper
│   ├── infrastructure/
│   │   ├── schema.ts                                   # Drizzle tables + RLS
│   │   ├── db/
│   │   │   ├── broadcasts-repo.drizzle.ts
│   │   │   ├── broadcast-deliveries-repo.drizzle.ts
│   │   │   ├── marketing-unsubscribes-repo.drizzle.ts
│   │   │   └── broadcast-segment-definitions-repo.drizzle.ts
│   │   ├── resend/
│   │   │   ├── resend-broadcasts-gateway.ts            # BroadcastsGatewayPort impl
│   │   │   ├── resend-broadcasts-webhook-verifier.ts   # WebhookVerifierPort impl
│   │   │   └── resend-broadcasts-client.ts             # SDK singleton
│   │   ├── sanitizer/
│   │   │   └── dompurify-sanitizer.ts                  # HtmlSanitizerPort impl
│   │   ├── email-validator/
│   │   │   └── rfc5321-email-validator.ts              # EmailValidatorPort impl
│   │   ├── members-bridge.ts                           # MembersBridgePort impl — calls @/modules/members
│   │   ├── plans-bridge.ts                             # PlansBridgePort impl — calls @/modules/plans
│   │   ├── event-attendees-stub.ts                     # FR-015a stub — returns []
│   │   ├── unsubscribe-token/
│   │   │   ├── hmac-signer.ts                          # UnsubscribeTokenPort sign impl
│   │   │   └── hmac-verifier.ts                        # UnsubscribeTokenPort verify impl
│   │   └── audit/
│   │       └── broadcasts-audit.ts                     # emits broadcast_* events
│   └── index.ts                                        # Public barrel
├── modules/members/                                    # F3 existing — F7 EXTENDS barrel + EDITS schema (migrations 0070 + 0071 add 2 columns: `broadcasts_halted_until_admin_review` per Q14 + `broadcasts_acknowledged_at` per Q15). Cross-feature schema extension lands on F7's branch — same pattern as F4→F3 + F5→F4 barrel extensions.
│   └── index.ts                                        # EDITED — add 4 new exports for FR-015c + FR-015d resolvers
├── modules/plans/                                      # F2 existing — F7 extends barrel
│   └── index.ts                                        # EDITED — add `getPlanForMember` export for FR-002 precondition `a`
├── lib/
│   └── env.ts                                          # EDITED — add RESEND_BROADCASTS_*, UNSUBSCRIBE_TOKEN_SECRET, FEATURE_F7_BROADCASTS
├── i18n/messages/
│   ├── en.json                                         # EDITED — add broadcasts.* keys (~ 200 new keys)
│   ├── th.json                                         # EDITED — add broadcasts.* keys (~ 200 new keys)
│   └── sv.json                                         # EDITED — add broadcasts.* keys (~ 200 new keys)

drizzle/migrations/
├── 0064_create_broadcasts.sql
├── 0065_create_broadcast_deliveries.sql
├── 0066_create_marketing_unsubscribes.sql
├── 0067_create_broadcast_segment_definitions.sql
├── 0068_seed_default_segment_definitions.sql           # one-off seed: tenant gets default all_members + tier:* + event_attendees + custom
├── 0069_audit_log_extend_retention_default_trigger.sql # extend the v1.4.0 trigger to map new F7 event types to default 5y retention
├── 0070_alter_members_add_broadcasts_halted_until_admin_review.sql  # Q14 per-broadcast complaint auto-halt
├── 0071_alter_members_add_broadcasts_acknowledged_at.sql            # Q15 GDPR Art. 7 acknowledgement
└── 0072_alter_broadcast_actor_role_enum_add_system.sql              # N1 remediation post-/speckit.analyze: adds 'system' value to enum for T178a auto-cancel cascade

docs/runbooks/
├── broadcast-deliverability-incident.md                # NEW — bounce/complaint spike triage
├── broadcast-cancel-too-late.md                        # NEW — recipient already received but admin needs to follow up
├── breach-notification.md                              # NEW stub — Privacy checklist CHK019; PDPA §37 24h + GDPR Art. 33 72h notification workflow for high-severity audit events (cross-cutting F1/F4/F5/F7)
└── credential-compromise.md                            # NEW stub — Security checklist CHK041 + Round 1 critique E19; cross-cutting secret-rotation runbook for all F1/F4/F5/F7 secrets with zero-downtime rotation procedures + compromise response steps

tests/
├── contract/broadcasts/
│   ├── post-broadcasts-draft.contract.test.ts
│   ├── post-broadcasts-submit.contract.test.ts
│   ├── post-broadcasts-cancel.contract.test.ts
│   ├── get-broadcasts-quota.contract.test.ts
│   ├── post-admin-broadcasts-approve.contract.test.ts
│   ├── post-admin-broadcasts-reject.contract.test.ts
│   ├── post-admin-broadcasts-proxy-submit.contract.test.ts
│   ├── post-webhooks-resend-broadcasts-events.contract.test.ts  # one test per handled event type
│   └── get-unsubscribe-token.contract.test.ts
├── integration/broadcasts/
│   ├── tenant-isolation.test.ts                        # Review-Gate blocker
│   ├── webhook-idempotency.test.ts
│   ├── webhook-signature.test.ts
│   ├── html-sanitiser.test.ts                          # 30+ payloads
│   ├── custom-recipient-validation.test.ts             # FR-015d branches
│   ├── cancellation-cutoff.test.ts                     # FR-004a / Q10
│   ├── unsubscribe-token.test.ts
│   ├── cron-dispatch-idempotency.test.ts
│   ├── event-attendees-stub.test.ts                    # FR-015a / Q5
│   ├── audience-cap.test.ts                            # FR-016a / Q7
│   └── kill-switch.test.ts
├── unit/broadcasts/
│   ├── domain/
│   │   ├── broadcast-state-machine.test.ts
│   │   ├── quota-counter.test.ts
│   │   ├── email-lower.test.ts
│   │   ├── invariants.test.ts
│   │   └── cancel-cutoff-policy.test.ts
│   └── application/
│       ├── submit-broadcast.test.ts
│       ├── sanitize-html.test.ts                       # snapshot determinism
│       ├── validate-custom-recipients.test.ts
│       ├── resolve-segment-recipients.test.ts
│       ├── approve-broadcast.test.ts
│       ├── reject-broadcast.test.ts
│       ├── cancel-broadcast.test.ts
│       ├── process-webhook-event.test.ts
│       ├── unsubscribe-recipient.test.ts
│       └── compute-quota-counter.test.ts
└── e2e/
    ├── broadcast-compose-and-submit.spec.ts
    ├── broadcast-quota-block.spec.ts
    ├── broadcast-draft-restore.spec.ts
    ├── broadcast-empty-segment.spec.ts
    ├── broadcast-rate-limit.spec.ts
    ├── admin-review-queue.spec.ts
    ├── member-quota-history.spec.ts
    ├── recipient-unsubscribe.spec.ts
    ├── scheduled-send-cron.spec.ts
    ├── broadcast-cancel-too-late.spec.ts
    ├── broadcast-a11y.spec.ts
    └── broadcast-i18n.spec.ts
```

**Structure Decision**: Web application (Next.js full-stack, single repo, single deploy) — same as F1–F5. One new bounded context `src/modules/broadcasts/` with standard 4-layer Clean Architecture. New presentation surfaces under `src/app/(member)/portal/broadcasts/**`, `src/app/(member)/portal/benefits/e-blasts/**`, `src/app/(staff)/admin/broadcasts/**`, public `src/app/unsubscribe/[token]/**`, plus 5 new API route families. F3 and F2 public barrels gain new exports landing on F7's branch (unidirectional dep from `broadcasts → members + plans`).

**Client-component boundary**: every component under `src/app/(member)/portal/broadcasts/new/_components/editor/**` and `**/segment-picker.tsx` + `**/custom-list-input.tsx` MUST carry the `'use client'` directive. The Tiptap editor uses `useEditor` (React hook), client-only state, and DOM manipulation. The compose page shell (`page.tsx`) MAY remain server-rendered; the boundary crosses at `tiptap-editor.tsx` via `next/dynamic` import with `ssr: false` (defers Tiptap chunk until member opens the compose page — saves ~80KB gzipped on the benefits dashboard which doesn't load Tiptap).

## UX Implementation Patterns

*Maps F7 surfaces to `docs/ux-standards.md` enterprise UX playbook. Every implementation task generated by `/speckit.tasks` MUST follow these patterns.*

### Container assignment

| Surface | Route | Container | Width | Notes |
|---------|-------|-----------|-------|-------|
| Member quota dashboard | `/portal/benefits/e-blasts` | `DetailContainer` | 72rem | Read-only summary + history table |
| Member compose | `/portal/broadcasts/new` | `FormContainer` | 42rem | Two-pane layout collapses on mobile |
| Member broadcast detail | `/portal/broadcasts/[id]` | `DetailContainer` | 72rem | Read-only post-submit |
| Admin queue | `/admin/broadcasts` | `TableContainer` | 96rem | Inherits F4 invoice-list pattern |
| Admin broadcast detail | `/admin/broadcasts/[id]` | `DetailContainer` | 72rem | Approve/Reject buttons + delivery breakdown |
| Public unsubscribe | `/unsubscribe/[token]` | (none — minimal centred card) | 28rem max | Server-rendered; no auth chrome |

`pnpm check:layout` enforces every page/loading file imports exactly one container per § 18.

### Skeleton shimmer placement matrix

| Surface | Shimmer | Trigger | Min display |
|---------|---------|---------|-------------|
| Compose page (Tiptap loading) | Editor area rectangle + toolbar row + button | dynamic-import while Tiptap chunk loads | 300ms |
| Compose page (draft restore) | Form fields shimmer | initial server-side draft fetch | 300ms |
| Admin queue (initial load) | TanStack table rows shimmer (F4 pattern) | server-render → client hydration | 300ms |
| Admin broadcast detail (delivery summary) | 4 stat-row skeletons | initial fetch | 300ms |
| Member quota dashboard (history) | 5 row skeletons | initial fetch | 300ms |
| Public unsubscribe page | (none — server-rendered, no shimmer) | N/A | N/A |

### Toast policy

| Trigger | Toast level | Duration | Action button |
|---------|-------------|----------|---------------|
| Draft saved (member) | `sonner.success` (subtle) | 2s | (no action) |
| Submission accepted (member) | `sonner.success` | 5s | "View status" → broadcast detail |
| Submission rejected by sanitiser/size cap (member) | `sonner.error` | persists | (inline error in form) |
| Approval (admin) | `sonner.success` | 5s | "View timeline" |
| Rejection (admin) | `sonner.success` | 3s | (no action) |
| Cancellation (member or admin) | `sonner.success` | 3s | (no action) |
| `broadcast_cancel_too_late` | `sonner.warning` | 5s | (inline error) |
| Unsubscribe confirmed (recipient public) | inline confirmation panel — NOT a toast | persists | (no action; idempotent re-load OK) |

### Reduced-motion coverage

| Animation | motion-safe | motion-reduce |
|-----------|-------------|---------------|
| Tiptap toolbar focus ring | 150ms scale-in | instant |
| Compose form field focus ring | 200ms ease-out | instant |
| Admin queue row hover highlight | 100ms bg-color transition | instant |
| Sheet/dialog modal fade (reject + proxy-submit) | 200ms ease-out | 100ms opacity |
| Skeleton shimmer | 1.5s linear gradient | `animate-pulse` |
| Sonner toast slide | 200ms ease-out translate-y | 100ms opacity fade |
| ARIA-live status announcements | (no animation) | (no animation) |

### Mobile responsiveness

| Viewport | Compose layout | Admin queue | Tap-target |
|----------|----------------|-------------|------------|
| `< sm` (< 640px) | Single column; preview as tab below editor; toolbar collapses to overflow `…` menu | TanStack mobile-card layout (one row per card) | 44 × 44 px |
| `sm`–`lg` | Single column; preview accessible via "Preview" button → dialog | Standard table | 44 × 44 px touch / 32 × 32 px pointer |
| `≥ lg` | Two-pane split (editor left 60% / preview right 40%) | Standard table | 32 × 32 px (mouse) / 44 × 44 px on touch input |

### WCAG 2.2 opportunistic adoption

| WCAG 2.2 SC | Application |
|-------------|-------------|
| 2.4.11 Focus Not Obscured | Compose form scroll-padding so editor stays visible above sticky save bar |
| 2.5.8 Target Size | All buttons ≥ 24 × 24 px desktop / 44 × 44 px mobile |
| 3.3.7 Redundant Entry | Member's previous segment + scheduled-for choices remembered between drafts |

### Accessibility deep-dive (a11y.md gaps closure 2026-04-29)

This subsection closes 6 a11y.md gap markers (CHK004 / CHK006 / CHK015 / CHK029 / CHK042 / CHK049) by making the implicit Constitution Principle VI requirements explicit.

#### Autocomplete attributes (a11y.md CHK004 — WCAG 2.1 AA SC 1.3.5 Identify Input Purpose)

F7 form fields with biographical-data semantic meaning MUST set the appropriate `autocomplete` HTML attribute so assistive tech + browser autofill can identify input purpose:

| F7 field | `autocomplete` value |
|----------|---------------------|
| Custom-list email input (compose surface) | `email` (single-line) — though typically a textarea; if multi-line, `autocomplete="off"` is acceptable since browser autofill cannot fill multiple emails |
| Reject reason / Cancel reason / Clear-halt reason | `off` — free-text reasons are not biographical |
| Search input on admin queue (member name search) | `name` |
| Subject + body Tiptap editor | not applicable (rich-text editor; `autocomplete` does not apply to `contenteditable`) |

Most F7 form fields are NOT biographical; the autocomplete obligation applies primarily to the admin queue's member-search input. Member-side compose form does not collect biographical data. **F7 does NOT require new fields with biographical autocomplete semantics**, satisfying SC 1.3.5 by absence of opportunity.

#### Zoom to 200% — Tiptap usability (a11y.md CHK006 — WCAG 2.1 AA SC 1.4.4 Resize Text)

The compose surface MUST remain usable at **browser zoom 200%** without loss of content or functionality:
- Tiptap editor MUST reflow text content (no horizontal scroll within the editor at 200% zoom + 1280px viewport).
- Toolbar overflow menu (already specified for `< sm` breakpoint) activates the same overflow behaviour at 200% zoom even on wider viewports — verified by `tests/e2e/broadcast-a11y.spec.ts` zoom-200% test.
- Preview pane collapses to single-column at zoom 200% on `lg` viewport (mirrors `< sm` mobile multi-step wizard collapse).
- All buttons + form inputs remain reachable + tap-target-compliant at 200% zoom.

Verified by Playwright a11y spec: `await page.setViewportSize({ width: 1280, height: 800 }); await page.evaluate(() => document.body.style.zoom = '2.0'); /* assertions */`.

#### Pointer gestures + drag-and-drop (a11y.md CHK015 — WCAG 2.1 AA SC 2.5.1 Pointer Gestures)

**F7 MVP uses NO drag-and-drop or path-based pointer gestures** anywhere — explicit confirmation:
- No drag-to-reorder for segment list.
- No drag-to-schedule for broadcasts.
- No drag-to-attach for files (attachments deferred to F7.1 per spec § Out of Scope).
- No swipe-to-delete on mobile broadcast list (uses tap-and-confirm dialog instead).

This satisfies SC 2.5.1 by absence of opportunity. If F7.1 introduces drag-and-drop (e.g., reorderable segment definitions), every drag interaction MUST have a single-pointer alternative (Up/Down arrow buttons) per SC 2.5.1.

#### Tiptap editor state screen-reader announcements (a11y.md CHK029 — WCAG 2.1 AA SC 4.1.3 Status Messages)

The Tiptap editor MUST expose state changes to assistive tech via an `aria-live="polite"` region adjacent to the editor:

| State change | Announcement |
|--------------|--------------|
| Bold toggled on/off | "Bold on" / "Bold off" |
| Italic toggled on/off | "Italic on" / "Italic off" |
| Heading level changed | "Heading level 2" / "Body text" |
| List mode entered/exited | "Bullet list" / "Numbered list" / "Exited list" |
| Link inserted | "Link inserted: `<URL host>`" (host only, not full URL — privacy + brevity) |
| Sanitiser strip warning (Round 2 R2-NEW-2) | "Forbidden tag removed: `<tag-name>`" — announced when paste handler strips |
| Editor ready (post Tiptap dynamic-import) | "Editor ready" — announced when `aria-busy` flips false |

The aria-live region uses `aria-atomic="false"` so only the changed state is announced (not the entire region content). All announcements MUST be bilingual via next-intl (EN/TH/SV) — i18n keys under `portal.broadcasts.compose.editor.announcements.*`.

#### Banner dismissal focus return (a11y.md CHK042)

When a banner (acknowledgement / halt-state / manager-readonly) is dismissed:
- **Marketing acknowledgement banner**: focus returns to the page's H1 heading (or the first interactive element after H1 if H1 is decorative).
- **Halt-state banner**: focus returns to the admin queue's first row's "Review" action (the next logical action after dismissal).
- **Manager-readonly banner**: NOT dismissable — always visible while manager role active (no focus-return concern).

Implementation pattern: each banner component accepts an `onDismiss` callback that calls `document.getElementById('main-content-anchor')?.focus({ preventScroll: false })` after fade-out animation completes. Verified by `tests/e2e/broadcast-a11y.spec.ts` keyboard-only walkthrough.

#### Vestibular-disorder mitigation (a11y.md CHK049)

F7 surfaces MUST NOT contain motion patterns triggering vestibular disorders:
- **No parallax scrolling**.
- **No auto-playing video / GIF**.
- **No repeated motion >5 seconds duration** (skeleton shimmer is ≤1.5s loop; sonner toast slide is 200ms once).
- **All animations respect `prefers-reduced-motion: reduce`** per the 7-row matrix already specified in the Reduced-motion coverage section above.

Explicit statement: this F7 invariant complements the Reduced-motion matrix and aligns with WCAG 2.1 SC 2.3.3 Animation from Interactions (AAA — adopted opportunistically per F1+F4 pattern).

### Empty-state catalog

| Empty surface | Icon | Title | Description | CTA |
|---------------|------|-------|-------------|-----|
| Member zero broadcasts ever | `<Mail />` | "Your first E-Blast" | "Turn your news into chamber-wide reach. Compose your first E-Blast to use your annual quota." | "Compose new E-Blast" → `/portal/broadcasts/new` |
| Tier with `eblast_per_year=0` (FR-009) | `<MailX />` (composite) | "E-Blast not in your plan" | "Your current plan does not include the E-Blast benefit. Upgrade to a tier with annual E-Blasts." | "View tiers" → external chamber site |
| Admin queue zero pending | `<Inbox />` | "All clear" | "No broadcasts pending review. New submissions appear here." | (no CTA) |
| Member quota exhausted (FR-002b) | `<Calendar />` | "Annual quota used" | "You've used all `<eblast_per_year>` E-Blasts for `<year>`. Quota resets `<next_reset_date>`." | "View history" |

### Banner scope and stacking (UX checklist CHK024)

F7 introduces 3 distinct banner components. **Each banner is role-scoped + page-scoped, so banners are mutually exclusive on any single page** — no stacking concern under MVP scope:

| Banner | Component | Page scope | Role scope | Trigger |
|--------|-----------|------------|------------|---------|
| **Marketing acknowledgement banner** (Q15 / R3-NEW-2) | `marketing-acknowledgement-banner.tsx` | `/portal/*` (member self-service) | `member` only | `members.broadcasts_acknowledged_at IS NULL` + tier eligibility |
| **Halt-state banner** (Q14 / R3-NEW-3) | `halt-state-banner.tsx` | `/admin/broadcasts` (admin queue) only | `admin` only — manager sees badges in F3 list but no banner | ≥1 member in tenant has `broadcasts_halted_until_admin_review = true` |
| **Manager-readonly banner** | `manager-readonly-banner.tsx` | `/admin/*` (any staff portal page) | `manager` only | Always visible while `manager` role is active |

Edge cases verified mutually exclusive:
- A user with `manager` role cannot also be on `/portal/*` simultaneously (single role at a time per F1 session).
- An `admin` user with halted members on `/portal/*` (admin-as-member context) sees the marketing banner but NOT the halt-state banner (halt-state is admin queue page only).
- A user who is both `admin` in tenant A AND `member` in tenant B sees role-appropriate banners per their active tenant context (FR-018 tenant isolation isolates `broadcasts_acknowledged_at`).

Multi-banner stacking is therefore **not a design concern for F7 MVP**. If a future feature introduces overlapping banner scopes, add a stacking-priority rule then.

### shadcn primitive inheritance (UX checklist CHK067)

F7 reuses or extends F4's existing shadcn customisations and introduces NO new shadcn primitive customisations. Component inventory:

| F7 Component | Underlying shadcn primitive | Customisation source |
|--------------|----------------------------|---------------------|
| `pay-sheet/**` (compose drawer at mobile breakpoint) | `Sheet` | **Inherited from F4** — full-screen variant at `< sm` per F4's existing customisation; no new modifications |
| `reject-dialog.tsx` / `clear-halt-dialog.tsx` (typed-phrase confirmation) | `Dialog` + `Input` | **Inherited from F4** — typed-phrase destructive-action pattern from F4 invoice-void / F4 credit-note-issue; F7 adds new dialog INSTANCES but no primitive modifications |
| `proxy-submit-dialog.tsx` | `Dialog` | Standard shadcn `Dialog` (no customisation) — new component instance only |
| `queue-table.tsx` | `Table` (TanStack Table v8 wrapper) | **Inherited from F3 + F4** — server-side sort/filter/pagination pattern; new column definitions only |
| `halt-state-banner.tsx` / `marketing-acknowledgement-banner.tsx` / `manager-readonly-banner.tsx` | `Alert` or `Card` | Standard shadcn primitives (no customisation) — new component instances only |
| `tiptap-editor.tsx` | NOT a shadcn primitive — `@tiptap/react` integration | New dependency wrapper — see Plan § Constraints + § Project Structure for Tiptap config |

**Result**: `docs/shadcn-customizations.md` requires NO updates for F7 MVP. F7 ships 7+ new component INSTANCES on top of unmodified F4-customised primitives + standard shadcn primitives. Any future F7.1 / F7.2 component that customises a primitive (e.g., banner with custom positioning + animation pattern) MUST update `docs/shadcn-customizations.md` per the project convention.

### Internationalisation deep-dive (i18n.md gaps closure 2026-04-29)

This subsection closes the 10 i18n.md gap markers (CHK021 / CHK030 / CHK032 / CHK053 / CHK054 / CHK056 / CHK057 / CHK059 / CHK064 / CHK065) by adding concrete F7 i18n requirements that complement the existing FR-039 + FR-041 narrative + Constitution Principle V mandate. These requirements apply across every F7 surface (compose, queue, banners, email templates, public unsubscribe) and inherit from F1+F4 conventions where established.

#### Numeric digit form (CHK021 — TH locale)

All numeric values (quota counters, recipient counts, complaint percentages, broadcast IDs in audit display, retry counts) MUST render as **Arabic digits (0–9)** across EN, TH, and SV — NOT Thai digits (๐–๙) for the TH locale. Rationale: Arabic digits are the de-facto convention for Thai digital UIs (banking, e-commerce, government portals all use 0–9), member-portal users expect them, and Thai digits would create cognitive overhead when reading recipient counts ("๑,๒๓๔ ผู้รับ" vs "1,234 ผู้รับ"). Thai digits remain a F7.1+ tenant-config opt-in if a future tenant requires them for cultural-fit reasons. Number formatting (thousands-separator) follows CLDR per locale via `Intl.NumberFormat(locale)` — EN: "1,234"; TH: "1,234"; SV: "1 234" (non-breaking space).

#### Subject character-counter — grapheme clusters (CHK030 — Q4 200-char limit)

The 200-character subject limit (FR-002 precondition d + Q4) MUST be measured in **grapheme clusters** (user-perceived characters via `Intl.Segmenter('grapheme')`) — NOT code points or UTF-16 code units. Rationale: TH script uses combining marks extensively (e.g., "กิน" = 3 base chars + 0 combining = 3 grapheme clusters = 3 code points; "ก่อน" = 4 base + 0 combining = 4 grapheme clusters = 4 code points; emoji like 👨‍👩‍👧 = 1 grapheme cluster but 5 code points + 4 ZWJ). Counting code points would make the same visual subject "longer" depending on how many emoji or combining marks it contains, which surprises members. The compose-page character counter uses the same `Intl.Segmenter` instance for display + validation. Server-side validation also uses `Intl.Segmenter` to keep client + server character-count semantics identical (FR-002 precondition d enforced at Application layer).

#### RFC 2047 / UTF-8 email-header encoding (CHK032 — TH subjects + From-name)

Resend Broadcasts API accepts UTF-8 strings directly in `subject` + `from.name` + `reply_to.name` fields and handles RFC 2047 / RFC 6532 encoded-word / SMTPUTF8 internalisation transparently per their SDK contract. F7 dispatch path passes subject + from-name as plain UTF-8 strings — no manual `=?UTF-8?B?...?=` encoding required. Playwright dispatch test in `tests/e2e/broadcast-i18n.spec.ts` MUST verify a TH-only subject ("ขอเชิญร่วมงานประจำปี 2026 ของหอการค้าฯ") survives the dispatch round-trip with no character corruption (intercepts the Resend webhook payload + asserts the recipient-side rendered subject matches). The test MUST also cover bidirectional content (mixed TH+EN subject) and an emoji-bearing subject.

#### Static-key invariant — no dynamic i18n keys (CHK053)

`t()` calls in F7 source MUST use **static string literals only** — no template literals, no variable interpolation in the key path. Forbidden patterns:
- ❌ `t(\`error.${errorCode}\`)`
- ❌ `t('error.' + errorCode)`
- ❌ `t(errorCodeKey)`

Allowed patterns:
- ✅ `t('admin.broadcasts.queue.empty.title')`
- ✅ `t('error.broadcast_audience_too_large', { max: 5000 })` (params via second arg, key remains literal)

Enforcement: ESLint rule (extending `next-intl/no-dynamic-keys` or equivalent custom rule under `eslint.config.mjs`) blocks merges. CI fails on any dynamic-key pattern in `src/modules/broadcasts/**` or `src/app/**` paths touching F7 surfaces. Rationale: static analysis is the ONLY way `pnpm check:i18n` can verify every key referenced in code exists in every locale; dynamic keys silently bypass the EN/TH/SV coverage guarantee. Mapping pattern for error codes uses a static dictionary instead:

```typescript
// ✅ Static-key-safe pattern for error mapping
const ERROR_KEY_MAP = {
  broadcast_audience_too_large: 'error.broadcast_audience_too_large',
  broadcast_subject_too_long: 'error.broadcast_subject_too_long',
  // ... 33 more
} as const satisfies Record<BroadcastErrorCode, MessageKey>;
const message = t(ERROR_KEY_MAP[errorCode]);
```

#### Key-orphan detection (CHK054)

`pnpm check:i18n --orphans` MUST scan all keys in `src/i18n/messages/{en,th,sv}.json` and report keys not referenced anywhere in `src/**/*.{ts,tsx}`. Orphan keys are a **WARNING** (not blocking) on regular branches, **ERROR** on release branches (matching the missing-key policy from CLAUDE.md). Rationale: prevents `*.json` files from accumulating dead translations over feature lifetimes (especially after F7.1+ refactors); release-gate enforcement keeps the EN canonical bundle clean for translator hand-off (chamber TH/SV liaison reviews only the keys that ship). Implementation: extend existing `scripts/check-i18n-coverage.ts` with `--orphans` flag.

#### String-length expansion buffer (CHK056)

UI design rule for F7 surfaces: layout MUST not break or clip at the longest locale's text length. Empirical buffers from F1+F4 measurements:
- **TH**: typically **~30% longer** than EN (combining marks + non-elastic word boundaries make breaking conservative)
- **SV**: typically **~10–15% longer** than EN (compound nouns + accented characters)
- **EN**: baseline

Concrete rules:
- Buttons + table-row actions: target text fits at TH+30% expansion without truncation in the standard ButtonContainer ≤ `max-w-md` width
- Empty-state titles: 1-line max even at TH+30% (truncate with ellipsis is unacceptable for hero copy — rephrase shorter)
- Card titles + dialog headings: 2-line max at TH+30%; 3-line cap before considering rephrase
- Status badges + chips: 1-line, no wrap, fixed-width tolerated up to TH+30% via padding-flex (≤ `px-3 py-1`)

Playwright assertion in `tests/e2e/broadcast-i18n.spec.ts > localised-layout-survives-th-expansion`: switches to TH locale, navigates each F7 surface, asserts no overflow + no horizontal scroll at 320px + 1280px viewports.

#### LTR-only boundary (CHK057)

F7 explicitly supports **LTR (left-to-right) languages only**: EN, TH, SV are all LTR scripts. RTL languages (Arabic, Hebrew, Persian, Urdu) are explicitly **out-of-scope for F7 MVP** and tracked under **F12 white-label tenant onboarding** as a future enabler. Forward-compat preparation already in place:
- All F7 CSS uses **logical properties** where the F1+F4 token system supports them (`margin-inline-start` over `margin-left`; `padding-block-end` over `padding-bottom`; `text-align: start` over `text-align: left`). Tailwind v4 logical-property utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`) preferred over directional ones (`ml-*`, `mr-*`).
- Tiptap config does NOT lock text direction (no `dir="ltr"` hard-coded in `ProseMirror` schema); future RTL-aware tenant inherits browser-default text direction inferred from content.
- No bidi-isolation primitives needed in MVP since all 3 supported locales are LTR.

When F12 onboards a RTL tenant, the migration cost is bounded to: (a) verify `dir="rtl"` cascades correctly on `<html dir>` per resolved tenant locale, (b) confirm logical-property usage covers all directional CSS, (c) update Playwright test matrix.

#### Tiptap IME compatibility — TH vowel + tone marks (CHK059)

Tiptap config in `src/modules/broadcasts/infrastructure/tiptap-config.ts` MUST preserve native IME composition events (`compositionstart` / `compositionupdate` / `compositionend`) so the TH input method (which composes vowels + tone marks atop a base consonant before committing) does NOT lose keystrokes mid-composition. Reuses the same pattern proven in F3 member-name input (which already handles TH IME correctly). Implementation contract:
- Tiptap StarterKit includes the underlying ProseMirror IME handling out-of-the-box; F7 MUST NOT add any `keydown` interceptors that bypass `isComposing` checks
- Custom keyboard shortcuts (Cmd+B / Cmd+I / Cmd+U) MUST guard with `if (event.isComposing || event.keyCode === 229) return false` to skip during active IME composition
- Playwright test `tests/e2e/broadcast-i18n.spec.ts > tiptap-th-ime-composition` simulates a TH IME sequence ("กา" = ก + า → composed "กา") via `page.keyboard.type('ka')` with Thai keyboard layout active; asserts editor content equals "กา" without partial-character corruption
- Manual QA pass on `/speckit.verify` includes a TH native typist composing 1 paragraph using TH IME on macOS + Windows; logged in test report

#### External translator integration (CHK064)

F7 MVP translations are **sourced internally**: maintainer + chamber's TH liaison + chamber's SV liaison review keys at the `/speckit.ship` gate. External translation-management platforms (Crowdin, Lokalise, Phrase, LingoStudio) are explicitly **out-of-scope for F7 MVP** and tracked under **F7.2 / Phase 4** as an option once translation volume exceeds maintainer capacity. Rationale: with ~200 F7 keys + chamber liaison availability, manual review is the lowest-friction path; introducing a TMS adds CI surface (sync hooks, conflict resolution, role auth) that is YAGNI at MVP scale per Constitution Principle X. Translation hand-off uses a simple JSON-diff workflow: maintainer adds new EN keys + placeholder TH/SV → liaison reviews via PR comment → liaison or maintainer commits the final TH/SV strings before /speckit.ship.

#### WCAG 3.1.1 + 3.1.2 — Language of Page + Language of Parts (CHK065)

`<html lang="...">` MUST be set per resolved page locale on every F7 surface (signed-in admin + portal + public unsubscribe page) — already specified in a11y.md CHK052 + Contracts § unsubscribe-public.md § 7. F7 adds two refinements:

**SC 3.1.1 (Language of Page)**: the `<html lang>` attribute resolves to the user's *active* locale (signed-in: user's selected; unsubscribe: query param → Accept-Language → tenant-default → EN per CHK010). Server-side rendering ensures the attribute is correct on first byte (not a hydration update).

**SC 3.1.2 (Language of Parts)**: when admin views an audit-log entry whose payload includes member-authored content (e.g., a member's TH-language broadcast subject in an admin queue row), F7 wraps the inline member-content in a span with `lang="auto"` (or omits the attribute entirely if `auto` is not supported) so screen-readers do NOT mispronounce the embedded TH text using the surrounding EN locale's phoneme table. Rationale: F7 surfaces frequently mix system-chrome (admin's locale, e.g., EN) with member-authored content (any language) — without per-part lang attribution, screen-readers reading "Subject: ขอเชิญร่วมงานประจำปี" in EN-phoneme mode produce unintelligible output. The `lang="auto"` hint defers to the screen-reader's own language detector, which is more accurate than the surrounding chrome's locale assumption.

Playwright assertion: `tests/e2e/broadcast-a11y.spec.ts > html-lang-attribute-correct-per-resolved-locale` verifies `<html lang>` matches the active session locale; manual SR pass at /speckit.verify includes mixed-locale member-content in admin queue (admin signed in as EN viewing a TH-subject broadcast).

### Performance & Capacity deep-dive (perf.md gaps closure 2026-04-29)

This subsection closes the 26 perf.md gap markers (CHK005, CHK007, CHK015, CHK017, CHK020, CHK024, CHK025, CHK026, CHK027, CHK028, CHK029, CHK030, CHK032, CHK033, CHK036, CHK038, CHK039, CHK042, CHK045, CHK047, CHK049, CHK051, CHK052, CHK053, CHK055, CHK056, CHK057, CHK058, CHK059, CHK065) by adding concrete F7 performance + capacity + observability requirements that complement Spec § SC-010 (per-surface budgets) + Q6 (budget framing) + Q7 (5k recipient cap). All numerics are MEASURABLE and asserted via CI synthetic load + RUM windows.

#### Budget framing — single-tier (prod) + dev-relaxed (CHK005, CHK007)

**Single-tier production budgets per SC-010** apply at scale (≤5k members per tenant, ≤1k pending broadcasts, ≤100k broadcasts/year). Dev/test environments may exceed budgets by up to **1.5×** without blocking PR merges (matching F4 dev-relaxed convention) but all SC-010 budgets MUST hold in production RUM windows.

**Excluded from p95 budget**:
- **External Resend Broadcasts API RTT** (CHK017) — measured separately as `broadcasts.resend_api_rtt_seconds` histogram. Not deducted from F7's submit/dispatch budgets because Resend is a vendor SLO, not F7 code.
- **Vercel network egress / browser-side network latency** — measured via Vercel Speed Insights TTFB but excluded from the application-layer histogram (`broadcasts.submit_duration_seconds`).
- **Cold-start time** for serverless functions — included in p95 (cold-start is a real user experience cost; Function warm path is the lower-latency happy path).

**Included in p95 budget**:
- Server compute (sanitiser, segment resolver, advisory lock acquisition) + DB query time + audit-emit + response serialisation.

#### CI regression detection (CHK065)

Every PR runs a **CI synthetic load script** (`scripts/synthetic-load-broadcasts.ts`) that exercises 5 critical paths: compose page TTFB, submit endpoint, queue list at 1k row scale, approve & send-now, webhook handler. Asserts p95 budget per route. **PR fails if p95 exceeds SC-010 budget by >10%** for any route. Nightly job runs the same script against staging Neon Singapore at full 5k member fixture for early detection. RUM windows (Vercel Speed Insights) cover production p95 over rolling 7-day + monthly enforcement window per SC-010.

#### Capacity ceilings & throughput (CHK015, CHK020, CHK051, CHK052)

**Per-tenant aggregate capacity ceilings**:
- **Annual broadcast volume per tenant**: max **75,000 broadcasts/year** (5k members × max 15/yr Diamond tier). Exceeding this requires F11 SaaS-billing scope expansion and is OUT-OF-SCOPE F7 MVP.
- **Per-tenant per-day**: soft cap **5,000 broadcasts/day** (matches Resend account tier; if a tenant exceeds, the cron dispatcher applies per-tenant fairness — see CHK055).
- **Cross-tenant total**: bounded by Resend account tier (typically 10,000/day at Pro tier). Multi-tenant scaling beyond this requires per-tenant Resend BYOK (F12 white-label scope).

**Resend rate-limit response (CHK020, CHK051)**:
- **Transient 429 from Resend** → exponential backoff with jitter: `1s → 2s → 4s → 8s → 16s` (5 retries max), each retry logged as `broadcast_dispatch_retry` audit. After 5 failed retries, broadcast row stays in `approved` status and the cron dispatcher tries again next 5-min cycle. Sustained 429 across **24 hours** transitions to `failed_to_dispatch` with `broadcast_failed_to_dispatch` audit + admin page.
- **5xx from Resend** → same backoff policy as 429 but emits `broadcast_resend_resource_missing` (R2-NEW-3) on 4th retry for early-warning observability.
- **Connection timeout / DNS failure** → fail fast (no retry within the cron cycle); next 5-min cycle picks up. Treated as transient unless `> 1h` sustained, then `Resend account-level outage` runbook fires.

**Queue overflow (CHK052)**:
- **At 10× SC-010 assumption (10k pending broadcasts in admin queue)**: submit endpoint surfaces `503 broadcast_queue_full` with bilingual message "Submission queue is full — try again in 15 minutes." Admin queue header shows red banner "Queue overflow — N broadcasts pending review (cap: 10k)" with deep-link to bulk-approve flow. This is a **safety valve**, not normal operation; alert fires at 8k pending.

**Per-tenant noisy-neighbour mitigation (CHK055)**:
- Cron dispatcher uses **per-tenant fairness**: each cron run processes broadcasts in **round-robin tenant order** (sorts by `tenant_id ASC, scheduled_for ASC`). One tenant submitting 1,000 broadcasts/hour CANNOT starve other tenants because the per-(tenant, broadcast) advisory lock + round-robin traversal naturally bounds parallel dispatch to 1 broadcast per tenant per cron worker run. Multi-worker scaling (post-MVP) preserves the property via consistent-hash-by-tenant.

#### Database query performance (CHK024, CHK025, CHK026, CHK027, CHK028, CHK029, CHK030, CHK058, CHK059)

**RLS overhead bound (CHK024)**:
- Per-query RLS overhead **MUST be ≤5ms p95** (F3 baseline). Achieved by ensuring every composite index carries `tenant_id` as the leading column (matches F3 + F4 RLS pattern). Verified via `EXPLAIN ANALYZE` in integration tests for the 5 hottest F7 queries.

**Segment resolver indexing (CHK025)**:
- `members` table indexes: `(tenant_id, plan_id) INCLUDE (primary_contact_email, member_id)` for fast `all_members` + `tier:<code>` resolution.
- Suppression filter implemented as **single anti-join**: `WHERE primary_contact_email NOT IN (SELECT email_lower FROM marketing_unsubscribes WHERE tenant_id = $1)`. PG planner uses semi-anti-join with hash on suppression set.
- Worst-case query plan at 5k members + 5k suppressions: **single sequential scan + 1 hash join, < 50ms p95** on Neon Singapore.

**Quota counter view (CHK026, CHK059)**:
- View is computed (not materialised) until tenant exceeds **100,000 sent broadcasts/year**. At that threshold, view is converted to a **materialised view with 5-min refresh** (deferred to **F7.1** as noted in Spec § Key Entities). For F7 MVP scale (SweCham 131 members × 6/yr = 786/yr), computed view is sub-10ms.
- Alternative caching: `member_id → quota_remaining` Redis cache with 60s TTL is **F7.1 optimisation**, not MVP.

**Advisory lock contention (CHK027)**:
- `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenantId||':'||broadcastId, 0))` is per-(tenant, broadcast) — collision probability is `1 / 2^64`, effectively zero. Worst-case contention: **single tenant with 1,000 simultaneous dispatch attempts** serialises through the lock; cron 5-min cadence + per-tenant fairness ensures this is bounded to <100 broadcasts per cycle in practice.
- Lock acquisition timeout: **5 seconds** (vs F4's 30s — F7 broadcasts are not order-sensitive like §87 numbering; if lock unavailable, retry next cron cycle).

**Suppression lookup batching (CHK028, CHK058)**:
- At dispatch time, suppression check is **single batch query** per dispatch run: `SELECT email_lower FROM marketing_unsubscribes WHERE tenant_id = $1 AND email_lower = ANY($2::text[])` where `$2` is the resolved recipient list. Worst case: 5,000 emails × 1 query = **1 query** (not N+1). Index `(tenant_id, email_lower)` ensures sub-20ms execution.

**Custom-list validation batching (CHK029)**:
- FR-015d resolution batched into **single CTE** that UNIONs the 3 source tables and LEFT JOINs against the input array:
  ```sql
  WITH input AS (SELECT unnest($2::text[]) AS email_lower),
  candidates AS (
    SELECT email_lower FROM members WHERE tenant_id = $1 AND primary_contact_email IS NOT NULL
    UNION SELECT email_lower FROM contacts WHERE tenant_id = $1
    UNION SELECT email_lower FROM event_attendees WHERE tenant_id = $1
  )
  SELECT i.email_lower, (c.email_lower IS NOT NULL) AS is_known
  FROM input i LEFT JOIN candidates c USING (email_lower);
  ```
- Worst case: 100 entries × 1 query = **1 query**, sub-30ms p95.

**broadcast_deliveries growth & retention (CHK030)**:
- Worst-case row count at 10-tenant SaaS scale: 10 tenants × 75,000 broadcasts/yr × 5,000 recipients × 5-yr retention = **18.75 billion rows**. Mitigations:
  - **5-year retention enforced via nightly prune cron** (data-model.md § broadcast_deliveries retention rule). Deletes rows where `created_at < NOW() - INTERVAL '5 years'`.
  - **Partitioning by `(tenant_id, EXTRACT(YEAR FROM sent_at))`** introduced when **first tenant exceeds 10M rows** (F7.1+). MVP runs as single-table; PG handles up to ~10M rows comfortably with proper indexing.
  - Index strategy: `(tenant_id, broadcast_id, status)` for per-broadcast delivery rollups; `(tenant_id, created_at DESC)` for retention prune; `(tenant_id, recipient_email_lower, sent_at DESC)` for recipient-history queries.

#### Cron dispatch performance & retry policy (CHK032, CHK033, CHK036)

**Cron handler runtime budget (CHK032)**:
- Single cron run MUST complete in **≤4 minutes** (5-min cadence with 1-min safety margin against cron-job.org's HTTP timeout). Worker processes due-broadcasts in batches of **10 per run**; remainder picked up next cycle. With per-tenant fairness, 10 batched broadcasts × ~3s each (Resend RTT + DB writes) = ~30s per cycle, well within budget.

**Stuck-`sending` detection (CHK033)**:
- A broadcast row in `sending` status with `dispatched_at > 5 minutes ago` is considered **stuck**. Separate reconciliation cron (15-min cadence) emits `broadcast_resend_resource_missing` for observability + admin page. After **24 hours sustained stuck**, transitions to `failed_to_dispatch` with audit. Mirrors F5 stale-pending-count pattern.

**Cron retry policy (CHK036)**:
- Transient failures (Resend 429/5xx, network timeout) → exponential backoff per CHK020 above. **Max 24-hour retry window** before final `broadcast_failed_to_dispatch` audit + admin page + member-facing transactional email "Your broadcast could not be dispatched — please contact admin." No dead-letter queue in MVP (24h window + admin paging is sufficient).

#### Frontend performance (CHK038, CHK039, CHK053)

**JS bundle budget per route (CHK038)**:
- **Compose page** (`/portal/broadcasts/new`): ≤180 KB gzipped (Tiptap + StarterKit lazy-loaded via `next/dynamic`; SSR shell ≤30 KB)
- **Admin queue list** (`/admin/broadcasts`): ≤120 KB gzipped (TanStack Table + columns; virtualization lazy)
- **Broadcast detail** (`/admin/broadcasts/[id]`): ≤100 KB gzipped (read-only views + audit timeline)
- **Member benefits page** (`/portal/benefits`): ≤80 KB gzipped (quota-counter widget)
- **Public unsubscribe page** (`/unsubscribe/[token]`): ≤30 KB gzipped (server-only, no JS)
- Inherited from F1+F4 baseline of 150 KB gz; budgets enforced via `next-bundle-analyzer` CI step.

**Server-component rendering at scale (CHK039)**:
- Admin queue list uses **TanStack Table v8 with `@tanstack/react-virtual`** virtualization, enabled when row count >100 (F3+F4 pattern). At 1k rows, virtualization keeps DOM nodes ≤30 visible rows; SSR initial render ≤100 row stub for SEO + first-paint.

**Member-facing latency display (CHK053)**:
- "Submitting…" spinner timeout: **8 seconds** (covers p99 + Resend RTT spike). On timeout → toast "Taking longer than expected — your broadcast may still be processing. Refresh the page in a moment to check status." Toast uses `aria-live="polite"` for screen-reader. Submit button stays disabled until server response or 12s hard timeout (forms re-enables for retry).

#### Cold-start, caching, & memoisation (CHK042, CHK056, CHK057)

**Cold-start budget (CHK042)**:
- **Webhook handler** 250ms p95 budget includes **100ms cold-start tolerance** (warm path target ~150ms). Vercel Functions cold-start typically 200–400ms, so cold invocation EXCEEDS budget — accepted as occasional miss because (a) Resend retries webhooks, (b) signature verification is short-lived (single hash), (c) downstream audit-emit is async.
- **Cron handler**: cold-start typically 300–500ms; 4-min runtime budget absorbs comfortably.
- **No warm-keeping ping**: F7 does NOT use a keep-warm cron because (a) SC-008 is 30-min not seconds, (b) cost-per-month for keep-warm exceeds occasional cold-start cost at MVP scale. Revisit at F7.1+ if RUM shows >5% webhooks miss budget.

**Cache Components strategy (CHK056)**:
- **Admin queue list**: Next.js 16 Cache Components with `revalidate: 30s` per-tenant cache key. Stale-while-revalidate ensures sub-100ms TTFB even on cache miss.
- **Member benefits page**: Cache Components with `revalidate: 60s` per-(tenant, member) cache key.
- **Broadcast detail page**: NO caching (audit timeline must be fresh; admin actions reflect immediately).
- **Public unsubscribe page**: NO caching (idempotent but token-bound; cache adds no value).

**Recipient-count memoisation (CHK057)**:
- `estimated_recipient_count` is computed at **submit time** and cached on the `broadcasts` row in column `estimated_recipient_count integer NOT NULL`. Compose-page preview re-computes on segment change (no cache). At dispatch time, if `submitted_at < NOW() - INTERVAL '24 hours'`, recipient list is **re-resolved fresh** to catch member churn (new joins, departures, suppression updates); otherwise the cached count is trusted (>95% of broadcasts dispatch within 24h).

#### Observability — metrics, traces, alerts, sample rates (CHK045, CHK047, CHK049)

**Alert rules catalogue (CHK045)** — added to `docs/observability.md` § 14 at /speckit.tasks time:

| # | Alert | Threshold | Severity | Runbook |
|---|-------|-----------|----------|---------|
| 1 | `broadcasts.stuck_sending_count > 0` for 5 min | P1 | page on-call admin | `runbooks/broadcasts-stuck-sending.md` |
| 2 | `broadcasts.complaint_rate_per_broadcast > 5%` (Q14 SC-005 (b)) | P1 | page + auto-halt member | `runbooks/broadcasts-deliverability.md` |
| 3 | `broadcasts.dispatch_failure_rate > 10%` in 1h | P2 | page admin | `runbooks/broadcasts-dispatch-failure.md` |
| 4 | `broadcasts.webhook_signature_rejection_count > 5/min` | P1 (security) | page on-call security | `runbooks/broadcasts-webhook-attack.md` |
| 5 | `broadcasts.dispatch_latency_seconds_p95 > 1.5s` for 30 min | P3 | Slack alert (no page) | `runbooks/broadcasts-perf-regression.md` |
| 6 | `broadcasts.queue_pending_count > 8000` (queue overflow early-warning) | P2 | page admin | `runbooks/broadcasts-queue-overflow.md` |
| 7 | `broadcasts.bounce_complaint_rolling_30d_rate > 2%` (SC-005 (a)) | P2 | page + block next release | `runbooks/broadcasts-deliverability.md` |
| 8 | `broadcasts.member_halt_count > 0` (any halted member) | P3 | Slack alert | `runbooks/broadcasts-halt-clear.md` |

**Distributed trace span set (CHK047)** — full span catalogue:

```text
member_compose_page_load
  └── render-compose-shell
  └── lazy-import-tiptap
member_submit_broadcast
  ├── sanitise-html
  ├── resolve-segment
  │   ├── members-query
  │   └── suppression-anti-join
  ├── reserve-quota-slot
  ├── advisory-lock-acquire
  ├── insert-broadcast-row
  └── audit-emit-broadcast_submitted
admin_approve_send_now
  ├── load-broadcast-row
  ├── resolve-segment-fresh (if >24h)
  ├── transition-to-sending
  ├── resend-api-call (external span)
  ├── audit-emit-broadcast_sent
  └── audit-emit-broadcast_quota_consumed
cron_dispatch_scheduled
  ├── select-due-broadcasts
  ├── per-tenant-round-robin
  └── (per broadcast) approve_send_now spans
webhook_receive_resend
  ├── verify-svix-signature
  ├── upsert-processor-event
  ├── upsert-broadcast-delivery
  └── audit-emit-broadcast_delivered (or bounced/complained)
public_unsubscribe
  ├── verify-token
  ├── upsert-marketing-unsubscribe
  └── audit-emit-broadcast_unsubscribed
```

**Sample rates (CHK049)**:
- **Metrics**: 100% (lifecycle events are low-volume — max ~75k broadcasts/yr/tenant × ~10 metric emissions = 750k/yr ≈ 0.024 per second; OTel cost negligible).
- **Webhook events**: 100% (per-recipient delivery events at 5k/broadcast × few broadcasts/day = ~25k/day per tenant peak; still affordable).
- **Trace sampling**: **10% in production** + **100% in dev/staging**. Errors + slow-path requests (>1s) sampled at 100% via OTel `parentbased_traceidratio` + tail-sampler. Bug investigations can request 100% temporarily via env-var override.

#### Log redaction (CHK048 cross-reference to security.md)

- Recipient emails NEVER logged in raw form. Hashed (SHA-256 truncated to 12 chars) for cross-request correlation: `recipient_hash = "ab12cd34ef56"`.
- Recipient lists logged as count + first-3-hashes: `recipients: { count: 4321, sample_hashes: ["ab12...", "cd34...", "ef56..."] }`.
- Subject + body NEVER logged (PII + may contain confidential info).
- Audit log table is the single source of truth for full-fidelity records; pino logs are observability-only.

### Smart-feature hooks — Cmdk integration

F7 extends the existing F2+ command palette with two new commands:

| Command | Trigger | Scope | Action |
|---------|---------|-------|--------|
| **Compose E-Blast** | Cmd+K → "compose" | `member` role only | Navigate to `/portal/broadcasts/new` |
| **Review queue** | Cmd+K → "review" or "queue" | `admin` role only | Navigate to `/admin/broadcasts?status=submitted` with focus on top row |

Bilingual command labels EN+TH+SV. Searchable by member name + subject keyword.

### Acceptance criteria checklist — F7 surfaces

Every UI PR MUST tick:

- [ ] Renders at 320 × 568 px without horizontal scroll
- [ ] Renders at 1920 × 1080 px without ugly stretching
- [ ] Passes `@axe-core/playwright` WCAG 2.1 AA + 2.2 opportunistic scan
- [ ] All user-visible strings have EN + TH + SV translations
- [ ] Skeleton shimmer per matrix above
- [ ] Empty state per § 3.1 if applicable
- [ ] Error states designed per § 4.1 / 4.2 / 4.3
- [ ] Toast on success per policy table
- [ ] Confirmation dialog for reject (with required reason) + cancel (typed-phrase)
- [ ] Auto-focus on dialog open + first form field on page load
- [ ] Enter submits when form valid; Escape cancels
- [ ] Focus-visible ring on every interactive element
- [ ] Dark mode renders correctly (Tiptap themes via Tailwind tokens)
- [ ] Screen reader: ARIA-live announces submission state transitions
- [ ] `prefers-reduced-motion` honoured per matrix above
- [ ] Tap targets ≥ 44 × 44 px on mobile

## Complexity Tracking

The following deviations survived the Constitution Check and are justified below. No unjustified violation exists; the Constitution Check is GREEN.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **Webhook endpoint runs on Node.js runtime (not Edge/Fluid default)** — Principle VII prefers edge for interactive endpoints | Resend signature verification requires raw request body bytes (HMAC-SHA256 over body). Edge runtime historically mangles raw bodies across framework upgrades; Node.js runtime is the documented recommendation. Single endpoint impact; latency hit ≤ 100ms cold start (Fluid Compute warm pool mitigates). Same as F5. | Edge runtime with manual `arrayBuffer()` read: works today but fragile across framework versions; constantly required re-verification on every Next.js minor bump. |
| **Submit endpoint p95 < 1.2s (not < 400ms)** — Principle VII default budget is p95 < 400ms | Sanitiser cost on member-supplied HTML up to 200 KB (DOMPurify O(n) on input size; ~50–200ms for max-size input) + segment resolution query (joins `members` + `contacts` + suppression — ~100–300ms @ tenant size 1k members) + audit emit dominate. Network is local (Singapore → Singapore Neon) so RTT is not the bottleneck. Spec's SC-010 commits the budget. | Pre-sanitise on draft save: shifts cost earlier but doesn't reduce total work; member edits the body multiple times before submit so we'd sanitise on every keystroke (~30 saves per compose). Defer sanitiser to background job: breaks the FR-002 server-side guarantee that `body_unsafe_html` rejection is synchronous and visible to the editor. |
| **Approve & send-now endpoint p95 < 1.5s (not < 400ms)** — Principle VII default budget | Resend Broadcasts API round-trip dominates (Singapore → Resend Ireland ≈ 200–400ms RTT). The budget is still well within UX expectations (admin clicks Approve, sees a "sending in progress" toast within 1.5s — the actual delivery happens asynchronously over minutes). | Asynchronous approve via background job: reduces the immediate p95 but loses the synchronous "I clicked Approve and the broadcast is now sending" feedback loop. Inferior UX for admin. |
| **Webhook pre-tenant RLS bypass + unsubscribe pre-tenant RLS bypass** — Principle I normally mandates RLS enforced on every read/write | Webhook endpoint cannot know `tenant_id` until it parses the event and resolves via `resend_broadcast_id` lookup. Public unsubscribe page cannot know `tenant_id` until it verifies the signed token. Both bypasses are narrowest-possible: signature/token verification + a single idempotency-keyed insert on a tenant-scoped table that immediately re-binds `app.current_tenant`. Same pattern as F5 webhook. | Tenant-scoped webhook URLs (e.g., `/api/webhooks/resend-broadcasts/[tenantId]`): inverts the threat model (URL becomes tenant-enumeration oracle). Tenant-scoped unsubscribe URLs: would force tenant slug into the public link, leaking tenant identity across recipients. |
| **Resend external service on the broadcast hot path** — Principle VIII prefers in-repo control | Resend is the chosen email infrastructure for the platform (F1 transactional already; F7 extends to Broadcasts). Self-hosted SMTP / SES is rejected by Constitution Principle X (Simplicity) — no benefit at SweCham scale. Resend's deliverability + signed webhooks + idempotency primitives + free-tier broadcast quota cover the reliability envelope. | Self-hosted email infrastructure: complex, lower deliverability, no free-tier benefit. Switching providers (Mailchimp/Brevo): doubles integration surface for no benefit. |
| **Tiptap (new client-side dependency)** — Principle X (Simplicity) prefers existing tools | The compose surface needs a structured rich-text editor that emits sanitisable HTML (FR-002a allowlist). Plain `<textarea>` would force members into raw HTML or markdown only (UX regression vs commercial alternatives). React Email (existing F1+F4 dep) is template-rendering, not authoring. Tiptap is the lightest mature React rich-text editor (~80KB gzipped) and its starter-kit covers the FR-002a allowlist 1:1. | `<textarea>` only: members write raw HTML or markdown — UX regression; chamber admins are not engineers. Build custom contenteditable: re-implements decades of caret-handling + paste-from-Word edge cases. Lexical / BlockNote / Quill: smaller community / overkill / legacy ecosystem respectively. |
| **isomorphic-dompurify (new sanitiser dependency)** — Principle X | XSS-prevention via strict allowlist sanitisation is NON-NEGOTIABLE for member-authored HTML (FR-002a; OWASP A03 mitigation). DOMPurify is the industry standard; isomorphic-dompurify wraps it for Node + browser. Size cost (~30KB) is amortised across the F7 compose surface only. | `sanitize-html`: less actively maintained, smaller ecosystem. `xss`: heavier API surface. Hand-rolled regex-based stripping: actively dangerous (impossible to enumerate all XSS vectors). |
| **email-validator (new validator dependency)** — Principle X | RFC-5321 email format check for FR-015d custom-list entries. Hand-rolled regex would miss valid addresses (RFC complexity). Zod's `email()` is permissive (accepts `a@b`). Tiny library, zero deps. | zod alone: too permissive; would let `a@b` through to FR-015d's tenant-graph resolver where it'd fail anyway with worse error UX. |
| **F7 consumes F3+F2 via barrel extensions landing on F7's branch** — Principle III normally keeps modules additively extended on their own branches | Same pattern as F5 → F4. Unidirectional dependency `broadcasts → members + plans`. F3 and F2 do NOT depend on F7. The four new F3 exports (`getMembersBySegment`, `getMemberPrimaryContact`, `lookupContactEmailInTenant`, `lookupMemberPrimaryContactEmailInTenant`) and one new F2 export (`getPlanForMember`) land on F7's branch — not retroactively on F3/F2's shipped branches. | Re-open F3 + F2 to pre-export F7's needs: ships unused code in shipped features; introduces hindsight bias. Best to land the exports alongside the consuming module. |
| **F6 EventCreate stub-port pattern (FR-015a)** — Principle III + Principle X — F7 ships a stub implementation of a port whose real implementation lives in F6 | Clarifications Q5: the project ships Phase 2 as a single batch release. F7 dev starts before F6 dev per `docs/phases-plan.md` ordering. The stub-port (returning `[]`) lets F7 build the segment resolver code path now; F6's `/speckit.implement` swaps in the real Drizzle-backed implementation. At big-bang release time both features land together — segment "just works" without spec amendment, schema migration, or feature flag. | Drop segment from MVP: forces re-amend at release. Feature flag: permanent maintenance overhead for a flag removed at ship. Block F7 ship until F6: doesn't matter for batch release but blocks dev order. |
| **`UNSUBSCRIBE_TOKEN_SECRET` separate env var (not reuse `AUTH_COOKIE_SIGNING_SECRET`)** — Principle X | Research.md § 4 decision. Separate secret because (a) rotating session cookies should not invalidate every outstanding unsubscribe link in members' inboxes (months-old unsubscribes are still valid), (b) compromise of one does not expose the other, (c) different lifetimes (session secrets rotate quarterly; unsubscribe tokens are valid forever per FR-030 idempotency). | Reuse `AUTH_COOKIE_SIGNING_SECRET`: rotation forced when session cycle says so → invalidates outstanding unsubscribes → recipients see "invalid token" → regulatory finding (GDPR Art. 21 "right to object" must be honoured indefinitely). |
| **Cron-job.org HTTP trigger for scheduled-send dispatch** (US6 + FR-021) — Principle VII prefers Vercel native crons | Vercel Hobby plan limits native crons to once-per-day. F7 needs 5-min cadence to honour US6 acceptance scenario AS1 ("cron handler runs at T0 + 2min"). Same cron-job.org pattern as F5 stale-pending-count gauge — `Authorization: Bearer ${CRON_SECRET}` (reused). Keeps Hobby plan + preserves resolution. | Vercel Pro plan upgrade: $20/mo just for one extra cron — wasteful at SweCham scale. Native cron on Hobby: 24h cadence breaks US6 acceptance. Background polling from a Fluid Compute function: same problem (Fluid is request-driven, not scheduler-driven). |
| **Solo-maintainer substitute for Review Gate** — Principle IX default is ≥2 human reviewers | Applies if a second human reviewer is unavailable. Substitute stack mandated above (Principle IX bullet): 6-stack automated review (`/speckit.review` ≥3 passes, `/speckit.staff-review` correctness+security+tests, `pdpa-gdpr-compliance-officer`, `security-threat-modeler`, DB-level RLS+FORCE + sanitiser-at-Application defence-in-depth, post-remediation `/speckit.verify`). Documented in Complexity Tracking + retrospective per Principle IX v1.3.0. | Block PR: project is solo-maintained; would pause phases-plan. |
| **T003 — skip `src/lib/env.example.ts` mirror** (recorded 2026-04-29 during T001–T010 implementation) — `tasks.md` T003 instructed updating an env.example.ts mirror | The file does not exist in the repo. F1–F5 each ship env-var documentation as inline doc comments inside `src/lib/env.ts` only — there is no parallel TS schema mirror file. Creating one for F7 alone would add a sync-burden and break convention. Inline doc comments above the four new F7 vars (lines added in `src/lib/env.ts` § F7 block) are the canonical project documentation. User-confirmed deviation. | Author `env.example.ts`: introduces a sync burden (every env-var addition would need 2 files updated + a CI check); breaks F1–F5 convention; provides no documentation value over inline JSDoc. |
| **T005 — skip `vercel.json` cron entry, document in `docs/runbooks/cron-jobs.md` only** (recorded 2026-04-29 during T001–T010 implementation) — `tasks.md` T005 instructed adding a "commented-out / disabled" cron entry to `vercel.json` | (a) JSON syntax does not support comments — a "commented-out" entry is impossible without inline pre-processing; (b) Vercel Hobby plan rate-limits native crons to once-per-day, incompatible with the 5-minute cadence required for `dispatch-scheduled` (US6 acceptance scenario AS1); (c) An active entry would either be silently rate-limited (degraded UX) or activate unwantedly on future Pro upgrade with no operational test. The F5 `payments.stale_pending_count` cron-job.org pattern is the established F-stack convention — `docs/runbooks/cron-jobs.md` documents the external trigger setup, Bearer auth (shared `CRON_SECRET`), secret-rotation procedure, and Pro-plan migration path. User-confirmed deviation. | Add inactive `vercel.json` entry: not possible without comments; would silently rate-limit on Hobby (1×/day vs needed 5-min) or activate unwantedly on Pro upgrade with no operational test. Switch to Vercel Pro now: $20/mo recurring cost for one cron when cron-job.org free tier covers the use case identically. |
| **T029 — F3 use-cases NOT emitting cross-module audit events; F7's caller emits via F7's own audit-port** (recorded 2026-04-30 during T029 Batch C implementation) — original tasks.md T029 specified F3's `setMemberHalt` emits `broadcast_member_dispatch_resumed` and `markBroadcastsAcknowledged` emits `member_acknowledged_broadcasts_terms` audit events directly via F3's `AuditPort.recordInTx` | F3's existing `audit_event_type` Postgres enum (data-model 005 § audit grants) does NOT include the 2 F7-owned event-type literals. Adding them via F3's audit-port type union surfaced a Drizzle insert error — the literal strings are not valid `audit_event_type` enum values without a separate `ALTER TYPE` migration. Adding them would (a) require a new F3-side migration to extend the enum with F7-specific literals (inverting the F7→F3 dependency direction); (b) couple F3's audit emission to F7-feature-specific event names. **Resolution**: F3 use-cases mutate the flag column ONLY (atomically inside `runInTenant` tx); F7's caller (Phase 3+ T060 bridge adapter) emits the audit event via F7's own `AuditPort` + adapter. F7's audit-port + adapter writes to the same `audit_log` table but using F7's own `F7_AUDIT_EVENT_TYPES` registry — keeping F3's enum writes free of F7 literals + preserving the F7→F3 dependency direction per Constitution Principle III. F3's `audit-port.ts` carries a comment block at the `F3AuditEventType` union boundary documenting this design. F3-side commit emit-side-effect ordering: `markBroadcastsAcknowledged` returns `previouslyNull: boolean` so caller decides idempotent emit (no double emit on already-acked). User-confirmed deviation. | (a) Add F7 literals to F3's `audit_event_type` DB enum: requires new F3 migration that extends the enum with feature-specific values — inverts dependency direction (F3 imports F7 event-type registry concept) and pollutes F3's audit-event taxonomy with non-F3 events. (b) Use raw-string casting in F3 audit-adapter: bypasses Drizzle's type safety — would silently accept malformed event-type strings + lose the static guarantee that emitted event_types are valid DB enum values. (c) Add a separate `F7Audit` adapter inside F3 module: still couples F3 to F7-specific concerns; cleaner to keep all F7 audit emission inside F7's own module per single-responsibility. |
| ~~**E2E suite ships chromium-only at `--workers=1`**~~ **RESOLVED 2026-05-01** — F7 now ships full 3-project E2E coverage (chromium + mobile-chrome + mobile-safari) at `--workers=1`. Original entry was made on the assumption that mobile-safari (WebKit) would require investment to stabilise; in practice it was 2 narrow fixes (regex + signIn focus race) totalling ~15 min. **Resolution commit**: `cf25cff`. **Coverage**: 87/87 tests pass across the 3 default Playwright projects. The `--workers=1` constraint persists per maintainer's workstation memo (`MEMORY.md`). | n/a — workaround removed |
| **isomorphic-dompurify ESM/CJS interop — 4-layer defence-in-depth workaround** (recorded 2026-04-30 during round-2 review remediation) — Principle X (Simplicity) prefers single-mechanism dependencies | `isomorphic-dompurify@2.36.0` requires `jsdom@^28.0.0`; jsdom@28's transitive deps include `whatwg-url@^16` and `html-encoding-sniffer@^6` which both depend on ESM-only `@exodus/bytes`. Node 20.18 LTS (current production runtime) cannot `require()` ESM modules without `--experimental-require-module` (Node 22+). Turbopack + Next.js 16 dev-server SSR pre-render therefore crashes with `ERR_REQUIRE_ESM` on any route or client component that imports `isomorphic-dompurify` directly OR transitively via the broadcasts barrel. **4-layer workaround** (no single layer is sufficient): (1) `preview-pane.tsx` uses `await import('isomorphic-dompurify')` inside `useEffect` so SSR never touches it; (2) `broadcasts-deps.ts` lazy-`require()`s the dompurify-backed sanitizer adapter so read-only routes (admin queue, broadcast detail) don't pull the chain; (3) `pnpm.overrides` in `package.json` pins `jsdom@25.0.1` + `whatwg-url@14.2.0` + `html-encoding-sniffer@4.0.0` (CJS-clean transitive graph) for the whole workspace — same versions vitest already uses for tests; (4) `next.config.ts` `serverExternalPackages: ['isomorphic-dompurify', 'jsdom', 'html-encoding-sniffer', '@exodus/bytes']` marks them as Node externals so Next.js leaves them out of the SSR bundle. **Removal criteria** (any one): Node 22 LTS adoption + `--experimental-require-module` enabled; OR isomorphic-dompurify ships ESM-clean upstream; OR jsdom@29+ reverts to CJS-clean dependency graph. Documented in `docs/runbooks/f7-dompurify-esm-workaround.md`. User-confirmed deviation. | (a) Single dynamic-import in preview-pane only: insufficient — admin/portal SSR routes still pull the chain via the barrel. (b) `serverExternalPackages` only: insufficient — pnpm transitive resolution still pulls jsdom@28 by default. (c) `pnpm.overrides` only: insufficient — Turbopack still bundles them as CJS externals that Node `require()`s at runtime. (d) Wait for Node 22 production runtime: blocks F7 ship by months. (e) Replace with `sanitize-html`: less actively maintained, smaller security review surface; we'd lose DOMPurify's hardening against future XSS bypass classes. |
| **FR-029 body-link uses Resend's `{{{RESEND_UNSUBSCRIBE_URL}}}` merge tag (not our `/unsubscribe/{token}` route)** (recorded 2026-05-01 during verify-fix C1) — FR-029 prescribes the body link target as `https://<tenant-host>/unsubscribe/{token}` | Resend Broadcasts API (`broadcasts.create`) ships ONE shared HTML body for the entire audience and accepts only fixed parameters (`audienceId`/`from`/`subject`/`html`/`name`/`replyTo`/`previewText`). It does NOT support per-contact arbitrary merge fields or custom HTTP headers. Per-recipient signed URL embedding via `emails.send` would mix marketing-volume traffic into the F1 transactional Resend product, violating FR-019 (separate API key, suppression list, reputation pool). The body footer therefore renders Resend's built-in `{{{RESEND_UNSUBSCRIBE_URL}}}` merge tag (substituted per-recipient at send time → Resend hosted page → audience contact `unsubscribed=true` → audience filter at next dispatch). The signed `/unsubscribe/{token}` route remains the canonical surface for: (a) the RFC 8058 `List-Unsubscribe` header (`buildListUnsubscribeHeaders` exported from `email-template.ts`); (b) admin "share unsubscribe link" affordance for direct GDPR Art. 21 requests; (c) future per-recipient send paths once Resend Broadcasts API gains per-contact merge field support. Both surfaces converge: Resend filters at audience-edge AND our `marketing_unsubscribes` table filters at dispatch boundary (`resolve-segment-recipients.ts → marketingUnsubscribes.lookupBatch`). FR-017/SC-004 zero-leak invariant holds in both paths. spec.md FR-029 amended 2026-05-01 with full implementation note. **Removal criteria**: Resend Broadcasts API exposes per-contact merge fields OR audience-contact pagination at scale → switch body footer to per-recipient signed URL; OR Resend Broadcasts API exposes a custom-`headers` parameter → wire `List-Unsubscribe` header through Broadcasts surface. | (a) Switch dispatch to per-recipient `emails.send` loop: violates FR-019 (mixes Broadcasts + transactional reputation pools); regresses deliverability; loses Resend Audiences abstraction; doubles webhook plumbing. (b) Embed shared (non-recipient-specific) signed URL in body: token would unsubscribe arbitrary recipients given any leaked link; defeats per-recipient HMAC purpose. (c) Defer FR-029 strict reading to "F7.1": user explicitly rejected per "ทำจบใน 7" direction. (d) Drop FR-029 strict reading entirely: regulatory finding (PDPA §24 + GDPR Art. 21 require functional unsubscribe — but the convergent architecture above DOES provide it; (a) is the requirement, not the literal URL string). |
| **`/unsubscribe/[token]` rate-limit best-effort fail-open** (recorded 2026-05-01 during verify-fix E1) — Principle VII would prefer fail-closed on unavailable rate-limit oracle | The 20 hits / 5 min per-IP cap is anti-enumeration defence. If Upstash is unreachable, we have two choices: (a) fail-closed → block the unsubscribe → recipient sees "Link is invalid" → GDPR Art. 21 right-to-object effectively denied during the outage window, (b) fail-open → log + proceed → recipient unsubscribe succeeds. We choose (b) per the GDPR Art. 21 principle "right to object MUST be honoured" — the regulatory invariant outweighs the anti-enumeration window. Outages are observable via the `unsubscribe_rate_limit_check_failed` log line + Upstash service-level monitoring. | Fail-closed: would convert an Upstash outage into a GDPR compliance incident — every recipient who clicks during the outage cannot unsubscribe + sees a "Link is invalid" page they have no way to recover from. Fail-open keeps the regulatory floor intact at the cost of a temporary anti-enumeration gap. |

## Phase 0 — Outline & Research

**Status**: → see [`research.md`](./research.md) (generated as Phase 0 output of this command).

Open questions resolved by research:

1. **Resend Broadcasts API surface** — endpoints, audience lifecycle (one-per-broadcast vs persistent), webhook event taxonomy, signature scheme (Svix vs custom), free-tier vs paid-tier broadcast quota.
2. **Tiptap configuration** — minimal extension set matching FR-002a allowlist; SSR-safety; `next/dynamic` boundary; theme-token integration.
3. **DOMPurify allowlist** — exact `ALLOWED_TAGS` + `ALLOWED_ATTR` + URL scheme whitelist; deterministic-output verification approach.
4. **Unsubscribe token signing-secret naming** — dedicated `UNSUBSCRIBE_TOKEN_SECRET` vs reusing `AUTH_COOKIE_SIGNING_SECRET` (decided: dedicated).
5. **Quota-year boundary handling for Asia/Bangkok** — implementation pattern matching F4's fiscal-year handling (`@js-joda/timezone` reuse).
6. **Cron dispatch idempotency** — `SELECT FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenantId||':'||broadcastId, 0))` pattern. Lock namespace `broadcasts:` disjoint from F4 `invoicing:` and F5 `payments:`.
7. **Reply-to header construction** — `<member.display_name> via <tenant.display_name>` for from-name; `<member.primary_contact_email>` for reply-to (FR-002 precondition `j` per Q11).
8. **F1 transactional vs F7 Broadcasts on the same Resend account** — single API key supports both products; separate webhook endpoints + suppression lists per Resend product (audited at research time).
9. **Recipient-list dispatch payload** — Resend Broadcasts API takes an `audience_id` not a flat email list; we either create one persistent audience per segment-definition or one fresh audience per broadcast. Decision pending in research (likely fresh-per-broadcast for MVP simplicity; persistent-per-segment as F7.1 optimisation).

## Phase 1 — Design & Contracts

**Status**: → outputs at [`data-model.md`](./data-model.md), [`contracts/`](./contracts/), [`quickstart.md`](./quickstart.md). Generated as Phase 1 output of this command.

After Phase 1 artefacts exist, the agent context file (`CLAUDE.md`) is updated via `.specify/scripts/powershell/update-agent-context.ps1 -AgentType claude` to surface F7 in the "Active Technologies" + "Recent Changes" sections.

## Phase 2 — Hand-off to `/speckit.tasks`

This command stops after Phase 1. `/speckit.tasks` is the next gate — it consumes spec.md + plan.md + research.md + data-model.md + contracts/ + quickstart.md to generate the TDD-ordered task list grouped by user story, with parallelizable `[P]` markers.

**Key task-generation hints for `/speckit.tasks`** (NOT prescriptive — `/speckit.tasks` decides ordering):

1. Phase 0 setup — npm deps install, env var schema, F3+F2 barrel extensions, F1 redact-list extension, ESLint rule for new module.
2. Phase 1 RED — every Domain invariant test, every Application use-case test, every contract test (one per endpoint), every integration test listed in Technical Context > Testing. **All red before any implementation lands.**
3. Phase 2 Domain — pure types, VOs, state machine, invariants, policies. No framework imports.
4. Phase 3 Application — use cases. Stub ports inject; real implementations come in Phase 4.
5. Phase 4 Infrastructure — Drizzle schema + migrations 0064–0069 + repo impls + Resend Broadcasts adapter + sanitiser adapter + email-validator adapter + bridge adapters + EventAttendees stub + audit + rate-limiter.
6. Phase 5 Presentation — API routes, member compose surface (Tiptap dynamic-import), member quota dashboard, admin queue + detail, public unsubscribe page, cron handler.
7. Phase 6 Polish — i18n keys (EN+TH+SV ~ 200 keys × 3 locales), a11y QA, SR pass, performance benchmarks per SC-010, security threat-model audit, PDPA/GDPR compliance audit, retrospective.
8. Phase 7 Cross-cutting — observability (16 metrics + 10 alerts + 3 runbooks), kill-switch verification, Review-Gate blockers (cross-tenant test green, security checklist co-signed).

**Spec drift to watch during `/speckit.implement`**:
- Any new clarification that surfaces during implementation MUST go through `/speckit.clarify` 5th session, not be silently absorbed into code.
- F6 stub-port substitution at F6 ship time is an EXPLICIT contract — F6's tasks.md must include "swap EventAttendeesRepository stub for Drizzle-backed implementation in F7's barrel" as a task.
- Quota-counter computation MUST be a derived view (not a stored aggregate) per FR-003 + FR-006 — any temptation to denormalise is a deviation requiring Complexity Tracking entry.
