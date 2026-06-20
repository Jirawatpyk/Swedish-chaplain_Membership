# Feature Specification: F6 — EventCreate Integration

**Feature Branch**: `012-eventcreate-integration`
**Created**: 2026-05-12
**Status**: Draft
**Input**: User description: "F6-EventCreate Integration docs\event-integration-analysis.md"

## Overview

Chamber tenants already run their events on **EventCreate** (external SaaS — landing pages, ticketing, registration, check-in). Today, the chamber admin exports attendees to Excel after each event and copy-pastes that data into internal records. That manual loop is error-prone, slow, and prevents the chamber from tracking event attendance against member benefit quotas (Partnership tier ticket allotments + Corporate cultural-event quotas).

F6 replaces the manual export with an **automated, member-centric import**:

1. EventCreate triggers fire when an attendee registers or completes a purchase.
2. Zapier (the only available EventCreate integration path — no public REST or native webhooks) polls the trigger and posts the attendee + event payload to a per-tenant webhook URL on Chamber-OS.
3. Chamber-OS verifies the request signature, matches the attendee to an existing member (by contact email → company email domain → fuzzy company name → "non-member"), persists an event row + a registration row, and decrements the matching member's benefit quota counter when the event qualifies.
4. Admins see all imported events, attendee-to-member match rates, and quota effects on a read-only events surface, with a manual relink action for ambiguous or wrong matches, plus a CSV fallback for historical backfill and Zapier outages.

We are **not** building event CRUD, landing pages, ticketing, payment, check-in, or calendar sync. EventCreate (or whichever event SaaS the tenant uses) remains the source of truth for those; F6 is read-only import of event outcomes into the membership system for benefit tracking and reporting.

**Two ingest modes** (both ship in v1):

1. **Zapier-mediated webhook** — for tenants on EventCreate. Real-time-ish (15-min Zapier polling) automated ingest.
2. **CSV upload** — for tenants on Eventbrite / Meetup / Cvent / spreadsheet workflows (primary ingest mode) AND for EventCreate tenants needing backfill or outage recovery.

Both modes pass through the same matching + quota + audit pipeline. Future native integrations with other event SaaS providers are reserved by the `events.source` column extensibility but are explicitly F6.1 scope.

## Clarifications

### Session 2026-05-12

- Q: Role-based access for F6 admin surfaces (admin vs. manager differentiation) → A: Manager has read-only access to `/admin/events` + event detail view; Admin-only on `/admin/settings/integrations/eventcreate` (secret reveal + rotation), manual relink, partner/cultural override toggle, CSV import, and super-admin kill switch. Mirrors the F4 finance-read-only Manager pattern.
- Q: Per-tenant production scale envelope for F6 (drives indexing, pagination, perf-test target) → A: Medium-chamber target — ~100 events/yr × ~500 attendees/event = ~50,000 registrations/yr/tenant; webhook sustained 60 req/min burst; SC-003 (p95 <300ms) and SC-006 (1k CSV rows <60s) measured against this scale.
- Q: Observability SLO scope for F6 (metrics + alerts + runbooks commitment) → A: Baseline matching F7/F8 precedent — ~10 OTel metrics, ~5 alerts, 3 runbooks; conforms to `docs/observability.md` § 14 and satisfies Constitution Principle VII at the same ship-readiness bar as F7/F8.
- Q: Event row lifecycle (archival vs. immutable) → A: Admin-archivable soft-delete — events carry an `archived_at` timestamp; archived events are hidden from the default events list (accessible via filter); quota effects of all registrations on an archived event are reversed at archive-time and audit-logged; EventCreate upstream deletion does NOT cascade (Chamber-OS owns its membership-side representation). No "unarchive" action in v1 (admin can re-import via webhook if needed).
- Q: Compliance posture for attendee PII (PDPA/GDPR lawful basis, retention, erasure) → A: Differentiated retention — member-linked attendees retained 5 years; non-member attendees retained 2 years then pseudonymised (PII replaced with deterministic hash, quota + aggregate stats preserved). Lawful basis = legitimate interest, with tenant-asserted EventCreate-side consent capture documented during onboarding. Admin-facing erasure tool fulfils PDPA §30 / GDPR Art. 17 requests by deleting attendee PII + registration row(s) with cascade and audit trail. Matches F7 DPIA + data-minimisation precedent.
- Q: Webhook handler transactional / reliability semantics on partial failure → A: Strict transactional — event upsert + registration insert + idempotency receipt + quota decrement all commit in ONE database transaction. Any error (DB unavailability, constraint violation, downstream port failure) rolls back the entire transaction and returns HTTP 5xx so Zapier retries via its standard backoff. Idempotency receipt is included in the transaction, so a replay after recovery is correctly recognised. Audit-log entry for the failed delivery is emitted in a SEPARATE post-rollback transaction so observability is never lost even when the primary transaction fails.
- Q: EventCreate payload schema-drift / versioning policy → A: Strict on required + permissive on unknown — zod validates the documented required fields; unknown keys are preserved in a `registrations.metadata` JSONB column for forward-compatibility and future analytics; missing-required → HTTP 400 + audit. Schema is implicitly v1; breaking schema changes require a new endpoint version path (`/api/webhooks/eventcreate/v2/{tenantSlug}`) rather than in-place mutation. Matches Stripe + GitHub webhook precedent and protects ingest from EventCreate's release cadence.

### Session 2026-05-12 (round 3 — deferred questions sweep)

- Q: Non-EventCreate tenant scope (Eventbrite / Meetup / Cvent / spreadsheet-workflow tenants) → A: **CSV-as-first-class repositioning.** US5 (CSV import) is now positioned as the **primary ingest path for non-EventCreate tenants** AND the backfill / outage-recovery path for EventCreate tenants. Same code path, same matching + quota logic, same audit events. No additional implementation cost. F6 v1 supports two ingest modes: (1) Zapier-mediated webhook for EventCreate tenants, (2) CSV upload for non-EventCreate tenants or backfill. Multi-source native webhook integrations (Eventbrite native, Meetup native, etc.) remain F6.1 scope per the `events.source` column extensibility.
- Q: Webhook URL naming — source-specific (`/api/webhooks/eventcreate/v1/{tenant}`) vs. source-agnostic (`/api/webhooks/events/v1/{tenant}`) → A: **Source-specific path retained** (FR-001 unchanged). Matches Stripe / GitHub / Slack / Resend webhook URL conventions; cleaner audit log + Vercel route handler debugging (URL alone tells you the integration); future native integrations (Eventbrite, Meetup) get their own path (e.g., `/api/webhooks/eventbrite/v1/{tenant}`) which is the industry-standard pattern. Source-agnostic would couple the route handler to payload-inspection-for-dispatch and obscure the integration in logs.
- Q: TH/SV walkthrough screenshots — Zapier's UI is EN-only globally; is mixing EN screenshots with TH/SV narration an acceptable UX boundary? → A: **Yes — accepted as the v1 UX boundary.** The walkthrough renders TH/SV narration text (instructions, button-label translations, contextual explanation) alongside EN screenshots (because Zapier's UI is the EN version regardless of admin's locale). A one-line localised notice at the top of the walkthrough section reads: "Note: Zapier's interface is in English only — the screenshots below match what you will see in Zapier." This is honest about the UX limitation, sets correct expectations, and avoids the maintenance burden of bilingual screenshot annotations (3 variants × 8 steps = 24 files). If a future tenant explicitly requests Thai/Swedish-annotated screenshots, that becomes an F6.1 backlog item.
- Q: SC-005 admin time-per-event measurement plan (who, when, how?) → A: **Maintainer self-observes on first 3 SweCham events post-flag-flip + records minutes/event in `retrospective.md`; baseline captured once pre-flag-flip on 1 event.** Concrete committed retrospective task — not a vague "the retrospective will check". Captured under the same 30-day window as SC-002 (both criteria measured at flag-flip + 30 days). The maintainer's measurement protocol: (1) before flipping `FEATURE_F6_EVENTCREATE=true`, pick one upcoming SweCham event with anticipated ≥10 attendees; (2) after the event, time the current manual Excel re-keying workflow with a stopwatch and record `baseline_minutes` in retrospective; (3) flip the flag; (4) on each of the next 3 events, time the F6-assisted workflow (review auto-matched results + handle unmatched / over-quota); (5) compute `time_saving_pct = 1 - mean(new_minutes) / baseline_minutes`; (6) pass = `time_saving_pct ≥ 0.85`. If failure, file follow-up to investigate root cause (e.g., bad match rate, slow review surface).
- Q: Zapier deprecation contingency — F6 hard-depends on Zapier for EventCreate webhook ingest; what's the plan if Zapier retires the EventCreate trigger? → A: **Three-layer graceful degradation strategy** documented in research.md R1: (1) **primary**: Zapier → F6 webhook (today); (2) **middleware-swap fallback**: tenant reconfigures the equivalent automation in n8n (self-hosted) or Make.com — the webhook contract (HMAC-SHA256-signed POST with `X-Chamber-Signature` / `X-Chamber-Timestamp` / `X-Request-ID` headers) is industry-standard and supported by all leading workflow-middleware tools; **zero F6 code change required**; (3) **ultimate fallback**: CSV upload (US5) — now first-class per Session 2026-05-12 round 3 Q1 so tenant can switch ingest mode without losing the membership-side automation. Native EventCreate scraping rejected (no public API; fragile; ToS risk); pressuring EventCreate to add native webhooks is out of our control. The dependency is documented openly in research.md R1 so future maintainers understand the supply-chain risk.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automated attendee import via Zapier webhook (Priority: P1)

As a chamber admin, after I have set up a Zap that connects my EventCreate account to my Chamber-OS tenant, every new attendee registration on EventCreate appears in Chamber-OS within ~15 minutes (Zapier free-tier polling cadence) with no manual action from me. Each registration is automatically matched to one of my chamber members (or flagged "non-member") and shows up under the relevant event in `/admin/events`.

**Why this priority**: This is the core value of F6 — eliminating manual Excel re-keying. Without this, no other F6 user story has any data to operate on. It is the only path that produces real production data flow.

**Independent Test**: Configure a tenant Zap that posts a synthetic attendee payload to the tenant webhook URL. Within seconds (real Zapier flight time aside), verify the event row, registration row, and matched member appear under `/admin/events/{eventId}`. Verify the audit log records the webhook receipt with signature-verified + matched outcome.

**Acceptance Scenarios**:

1. **Given** a tenant's EventCreate Zap is active and configured with the correct webhook URL and shared secret, **When** a new attendee registers on EventCreate and Zapier forwards the payload, **Then** Chamber-OS verifies the HMAC signature, inserts an event row (if first attendee for that event) + an event-registration row, matches the attendee to a member via the contact-email rule, and returns HTTP 200 with `matched: "member"` and a registration ID.
2. **Given** a payload with a valid signature but an attendee whose email and email domain do not appear in any member's contacts or company domain, **When** Chamber-OS receives the webhook, **Then** the registration row is still persisted with `match_type = "non_member"`, no quota is decremented, and the audit log entry records the non-member outcome.
3. **Given** the same webhook delivery (same `X-Request-ID`) is sent twice (e.g., Zapier retried after a network blip), **When** the second delivery arrives, **Then** Chamber-OS returns HTTP 409 with a duplicate-event error body and performs no side effects (the existing registration row is unchanged, no quota is double-decremented, the audit log records only one ingestion).
4. **Given** a payload arrives with an invalid HMAC signature (wrong secret or tampered body), **When** Chamber-OS receives it, **Then** the system returns HTTP 401, does not persist any event/registration data, and emits an audit event tagged as signature-rejected with the source IP.
5. **Given** a payload arrives with an `X-Chamber-Timestamp` more than 5 minutes from the server clock, **When** Chamber-OS receives it, **Then** the system rejects the request with HTTP 401 (replay protection) regardless of whether the signature would otherwise have verified.

---

### User Story 2 - Events list + event detail with match-rate visibility (Priority: P1)

As a chamber admin, I want to see every event imported from EventCreate as a row in `/admin/events`, sortable by date, with at-a-glance signals for the registration count and the match rate (what percentage of attendees were successfully linked to a member). When I click an event, I see the full attendee list with each match status, the quota effect (counted against partnership / cultural / not counted), and a deep link back to the EventCreate landing page.

**Why this priority**: Once data is flowing (US1), the admin needs a usable surface to see it, or US1 is invisible. This is the primary daily-driver UX for F6 and is essential before any operational decisions (relink, quota review, reporting) can be made.

**Independent Test**: Seed two events with mixed matched/unmatched attendees. Render `/admin/events` and verify the rows show correct counts and match-rate percentages. Click into one event and verify the attendee list, match-status badges, and quota-effect column reflect the seeded state. Verify the deep-link button opens the correct EventCreate URL.

**Acceptance Scenarios**:

1. **Given** five events have been imported with varying registration counts, **When** an admin visits `/admin/events`, **Then** they see a paginated table sorted by event start date (most recent first) with columns: Date, Name, Category, Registrations, Partner Benefit (badge), Match Rate (%).
2. **Given** an event with 20 registrations of which 18 are matched to members, **When** the admin clicks into the event detail page, **Then** they see "Match rate: 90% (18 of 20)" in the header and an attendee table where each row shows: attendee name, email, company, match status, ticket type, price paid, quota effect.
3. **Given** an event was imported from EventCreate, **When** the admin views the event detail page, **Then** a "View on EventCreate" button is present and links to the original `eventCreateUrl`.
4. **Given** an event with 60 unmatched registrations out of 1,000 attendees, **When** the admin opens the event detail page, **Then** unmatched rows are visually distinct (badge + sort-to-top option) AND a "Show unmatched only" filter button is present in the attendee table toolbar; clicking it filters the table to only `match_type IN ('unmatched','non_member')` rows so the admin can review them without scrolling 1,000 rows.
5. **Given** the tenant has no events imported yet (fresh tenant pre-flag-flip OR webhook configured but no deliveries received), **When** the admin opens `/admin/events`, **Then** the page renders an empty-state with three context-aware variants: (a) **no integration configured** — shows "No events yet. Set up your EventCreate integration to start importing attendees." with a primary CTA button linking to `/admin/settings/integrations/eventcreate`; (b) **integration configured but zero deliveries** — shows "Waiting for first event. Your Zap should deliver new attendee data within ~15 minutes after their EventCreate registration." with a secondary "Send test webhook" CTA; (c) **all events archived** — shows "All events are archived." with a toggle "Show archived events" that flips `includeArchived=true` on the list query. All three variants are fully localised (EN+TH+SV) and meet WCAG 2.1 AA (focusable CTA, sufficient contrast on muted-foreground helper text).

---

### User Story 3 - Tenant onboarding wizard for EventCreate Zap setup (Priority: P1)

As an admin of a newly onboarded chamber tenant, I want a guided wizard at `/admin/settings/integrations/eventcreate` that gives me my unique webhook URL, my one-time-reveal shared secret (with a copy button and a strong recommendation to store it in a password manager), the exact step-by-step Zapier configuration, and a "Test webhook" button I can press to verify the round-trip works before going live.

**Why this priority**: Without this, every new tenant has to be onboarded by manual support work that does not scale. The wizard is what makes Chamber-OS a true SaaS product (per `docs/saas-architecture.md`) and bounds onboarding to ~15 minutes for a competent admin.

**Independent Test**: As a fresh tenant admin, open `/admin/settings/integrations/eventcreate`, complete the wizard steps, paste the URL + secret into Zapier per the on-screen instructions, click "Test webhook" in Chamber-OS, and verify a green confirmation appears within 30 seconds with the synthetic registration listed in the recent-deliveries panel.

**Acceptance Scenarios**:

1. **Given** a tenant has never used the EventCreate integration, **When** an admin opens `/admin/settings/integrations/eventcreate`, **Then** the system generates a fresh `webhook_secret` (visible exactly once), displays the tenant-specific webhook URL, and renders an in-page Zapier setup walkthrough.
2. **Given** the admin has stored the secret and configured the Zap, **When** they press "Test webhook", **Then** Chamber-OS sends a synthetic payload to its own endpoint signed with the tenant's secret, verifies the round trip, displays a success state with timestamp, and records the test in the recent-deliveries panel.
3. **Given** the admin has already saved the secret and reloads the page later, **When** the page renders, **Then** the secret is masked (e.g., `whsec_••••••••1234`) with a "Rotate secret" button instead of the one-time reveal value.

---

### User Story 4 - Benefit quota accounting on attendance (Priority: P2)

As a chamber admin, when an event is flagged as a partner benefit (e.g., Diamond/Platinum/Gold-included tickets) or as a cultural event (Premium/Large annual quota), I want the matched member's quota counter to decrement automatically on successful registration import — and credit back when a registration is refunded — so my benefits records stay accurate without manual quota bookkeeping.

**Why this priority**: This is the strategic value-add of F6 over manual Excel re-keying (which it could never do reliably). It connects F6 to F2 (plans + quotas) and unlocks downstream renewal / value-realised analytics. Lower than P1 because the chamber can survive without it short-term (manual quota tracking continues), but with it F6 becomes meaningfully better than the spreadsheet world.

**Independent Test**: Pre-set a Diamond Partnership member with 6 tickets available for "Event X" and a Premium Corporate member with 2 cultural tickets for the year. Import 6 registrations from the Partnership member's company → all 6 should be `counted_against_partnership = true` and the partnership quota for Event X is 0. Import a 7th from the same company → it should land as `counted_against_partnership = false`. Import a cultural-flagged event registration for the Premium member → cultural-year quota drops from 2 to 1. Refund the registration → quota returns to 2.

**Acceptance Scenarios**:

1. **Given** a Diamond Partnership member with 6 tickets remaining for a partner-benefit event, **When** 6 registrations from that member's company are imported, **Then** all 6 registrations are flagged `counted_against_partnership = true`, the event's partnership-quota counter for that member drops to 0, and each decrement is audit-logged.
2. **Given** the same member has 0 tickets remaining for the event, **When** a 7th registration from the same company is imported, **Then** the registration is still persisted but with `counted_against_partnership = false`, the partnership counter stays at 0, and the event detail UI shows the registration with an "over quota" warning badge.
3. **Given** a Premium Corporate member with 2 cultural tickets remaining for the current calendar year, **When** a registration is imported for a cultural-flagged event, **Then** the registration is flagged `counted_against_cultural_quota = true` and the member's annual cultural quota drops to 1.
4. **Given** a previously counted registration is sent again with `payment_status = "refunded"`, **When** the refund delivery is processed, **Then** the registration row is updated to `payment_status = "refunded"`, the corresponding quota counter increments back by 1, and an audit entry records the reversal.

---

### User Story 5 - CSV import (primary path for non-EventCreate tenants + backfill for EventCreate tenants) (Priority: P2)

As a chamber admin, I want to upload a CSV of attendee data — either because (a) my chamber uses Eventbrite / Meetup / Cvent / spreadsheet workflows and CSV is my primary ingest mode (no Zapier webhook), or (b) my chamber uses EventCreate but I need to backfill historical events that pre-date F6 OR recover from a Zapier outage. The same matching + quota logic as the webhook path applies; the result report tells me how many rows were processed and which need attention.

**Why this priority**: This is the **primary ingest path for non-EventCreate tenants** (CSV-as-first-class per Session 2026-05-12 round 3 clarification) AND the backfill/recovery tool for EventCreate tenants. Without it, F6 is limited to EventCreate-only deployment and EventCreate tenants have no outage recovery. P2 because for EventCreate tenants the webhook (US1) is the daily-driver, and for non-EventCreate tenants the CSV path is the daily-driver — both groups need it but neither blocks MVP go-live the way US1/US2/US3 do.

**Independent Test**: Upload a CSV with 50 rows across 5 events including mixed matched/unmatched/refunded states. Verify the preview shows column mapping, the import job processes all 50 rows using identical match logic to the webhook, and the result page reports event/registration/match counts that exactly equal an equivalent set of webhook deliveries.

**Acceptance Scenarios**:

1. **Given** the admin opens `/admin/events/import`, **When** they drag-drop a CSV file, **Then** the system displays a preview of the first 10 rows with detected column-mapping suggestions for `event_external_id`, `event_name`, `event_start`, `event_category`, `attendee_email`, `attendee_name`, `ticket_type`.
2. **Given** a 1,000-row CSV has been mapped and submitted, **When** the import job runs, **Then** Chamber-OS processes all rows using the same match-and-quota logic as the webhook and completes the import within 60 seconds, then renders a result summary "1,000 rows processed → 12 events → 940 matched, 60 non-member".
3. **Given** a row in the CSV fails validation (malformed email, missing required column), **When** the import runs, **Then** that row is skipped, recorded in the error report with row number and reason, and the rest of the import continues.

---

### User Story 6 - Manual relink for unmatched or mis-matched attendees (Priority: P3)

As a chamber admin, when an attendee was matched to the wrong company (e.g., a personal `gmail.com` email or fuzzy-name collision) or was flagged "non-member" but I know they are actually a member, I want to manually re-link the registration to the correct member and have the quota effect recomputed.

**Why this priority**: Most matches will be correct (≥95% target — SC-002). The relink action exists for the residual long tail. P3 because the long tail is small and admins can survive a release cycle without it before manual cleanup pressure builds.

**Independent Test**: Seed one registration with `match_type = "non_member"` belonging in reality to Member A. Use the admin UI to relink to Member A. Verify the registration row updates `matchedMemberId`, the match_type becomes `member_contact`, and if the event qualifies, the quota decrements (or doesn't, if Member A's quota is exhausted) and the change is audit-logged.

**Acceptance Scenarios**:

1. **Given** a registration with `match_type = "non_member"`, **When** the admin opens the event detail page, presses "Relink" on that row, and selects a member from the searchable picker, **Then** the system updates `matched_member_id`, re-evaluates quota effects, and shows the new match status without a page reload.
2. **Given** a registration was previously counted against Member A's partnership quota, **When** the admin relinks it to Member B, **Then** Member A's quota for that event increments by 1 (credit-back), Member B's quota for that event is re-evaluated (decrement if quota remains), and both changes are audit-logged with the admin actor.

---

### User Story 7 - Webhook secret rotation with grace period (Priority: P2)

As a chamber admin, when I suspect or know my webhook secret has been exposed (e.g., committed to Git, shared in a screenshot), I want to rotate it from `/admin/settings/integrations/eventcreate` and have the old secret continue to verify incoming webhooks for 24 hours so I can update the Zap configuration without dropping any in-flight registrations.

**Why this priority**: Security hygiene that is essential after MVP go-live. Promoted from P3 to P2 because (a) implementation cost is small (3 fields in the webhook config table + grace-key lookup in verify), (b) security value is high (compromised secrets are a real risk worth designing for from day one), and (c) the 24h grace becomes valuable immediately when a second tenant onboards.

**Independent Test**: Rotate the secret at time T. Send one webhook signed with the old secret at T+12h (within grace) → should verify and persist. Send another signed with the old secret at T+25h → should be rejected with HTTP 401. Send a webhook signed with the new secret at any time after rotation → should verify.

**Acceptance Scenarios**:

1. **Given** an admin clicks "Rotate secret" and confirms in a dialog, **When** the rotation completes, **Then** a new secret is displayed one-time (with copy button) and the old secret is recorded with a `rotated_at` timestamp.
2. **Given** the old secret was rotated 12 hours ago, **When** a webhook arrives signed with the old secret, **Then** Chamber-OS verifies it successfully, processes the registration, and (in the audit log only) flags the receipt as having used the deprecated secret.
3. **Given** the old secret was rotated 25 hours ago, **When** a webhook arrives signed with the old secret, **Then** Chamber-OS rejects with HTTP 401 and records the receipt in the audit log as a signature-failure on the deprecated-grace key.

---

### Edge Cases

- **Personal email domains (gmail.com, yahoo.com, hotmail.com)**: Email-domain matching is not reliable; the system MUST fall back to fuzzy company name matching, and if still ambiguous, mark `match_type = "unmatched"` and surface to admin for manual relink. Personal-email domains are kept on a non-tenant-specific deny list to skip domain matching outright.
- **Same person registers under multiple member companies**: The contact-email rule (rule 1) resolves to the contact's parent member, which is the correct outcome even when the person works for multiple chamber members. The other companies are unaffected.
- **Newly registered member not yet in Chamber-OS**: Attendee imports as `unmatched`; admin is shown a "+1 unmatched" indicator on the event detail page and can manually relink once the member record is added in F3.
- **Member rebrands company name post-event**: Company-name fuzzy matching uses normalisation (strip "Co., Ltd.", "Pte", "AB", etc.) and Levenshtein ≤ 3; admin can manually relink if the rename is more aggressive than the heuristic.
- **Zapier offline / EventCreate downtime > 24h**: Webhooks queue on Zapier's side and replay when service is restored; the idempotency key on each delivery prevents double-processing. If the outage exceeds Zapier's retention, admin uses CSV fallback (US5).
- **Webhook delivered with skewed clock (timestamp ±5 min)**: Replay protection rejects with HTTP 401. Admin can re-run via CSV import if needed.
- **Duplicate registration delivery (same attendee external_id)**: Idempotency on attendee external_id + per-tenant scope; second delivery returns HTTP 409 with no side effects.
- **Refunded ticket arrives**: Quota is credited back (US4 scenario 4); registration row is retained with `payment_status = "refunded"` so historical reporting remains accurate.
- **Webhook with malformed JSON or missing required fields**: Returns HTTP 400 with field-level error detail; the failure is audit-logged. No event/registration row is persisted.
- **Event imported before any registrations**: Possible if EventCreate fires an event-only trigger (depending on Zap configuration); the event row is inserted and the registration count shows 0 in the events list.
- **Cross-tenant probe attempt**: A request signed with Tenant A's secret but targeting Tenant B's webhook URL fails signature verification (HTTP 401) AND is audit-logged with elevated severity. The handler MUST verify that the URL path's tenant matches the resolved tenant context (Constitution v1.4.0 Principle I sub-clause 1: application-layer tenant isolation).
- **Same email registered for multiple tickets to one event**: Each ticket is a separate registration row keyed by attendee `externalId`; quota decrements per registration (matching EventCreate's economic model — one paid ticket = one seat = one quota use).
- **Quota exhausted mid-event**: The 7th attendee from a Diamond-6 company is persisted with `counted_against_partnership = false` (US4 scenario 2). Admin sees an "over quota" warning so they can reconcile with the member if needed.
- **Super-admin kill switch**: A global flag (or per-tenant flag) disables webhook ingestion for compliance reasons; rejected requests return HTTP 503 with a `Retry-After` header.

## Requirements *(mandatory)*

### Functional Requirements

**Webhook ingestion + security**

- **FR-001**: System MUST expose a per-tenant HTTPS POST endpoint at `/api/webhooks/eventcreate/{tenantSlug}` (implicit schema v1) that accepts JSON payloads matching the documented attendee + event contract. Breaking schema changes (renamed/removed required fields, type changes) MUST be introduced under a new versioned path (`/api/webhooks/eventcreate/v2/{tenantSlug}`) rather than mutating v1 in place, so legacy Zaps continue to flow without admin reconfiguration during the migration window.
- **FR-002**: System MUST verify each request's HMAC-SHA256 signature against the tenant's stored shared secret using a timing-safe comparison, and reject with HTTP 401 + RFC 7807 error body on failure.
- **FR-003**: System MUST reject any request whose `X-Chamber-Timestamp` is more than 5 minutes from the server's UTC clock (replay protection) before evaluating the signature.
- **FR-004**: System MUST treat the `X-Request-ID` header as an idempotency key; duplicate deliveries within a 7-day retention window MUST return HTTP 409 with no side effects.
- **FR-005**: System MUST rate-limit incoming webhook requests to no more than **10 requests per minute per tenant** (returning HTTP 429 with `Retry-After` when exceeded). Rationale: Zapier's free-tier 15-min polling produces at most 4 deliveries/hour/Zap; Zapier paid-tier 1-min polling produces ~60/hour/Zap. 10/min gives 150× free-tier headroom and 10× paid-tier headroom — meaningful threshold for a rate-limit-burst alert (research.md R10 alert #4) without false positives under realistic Zapier load.
- **FR-006**: System MUST never trust the `tenantSlug` in the payload body; tenant context MUST be resolved exclusively from the URL path AND cross-checked against the tenant whose secret verified the signature.
- **FR-007**: System MUST scope all event + registration + webhook-config data by `tenant_id` and enforce two-layer isolation: application-layer use-case guards AND Postgres row-level security policies (Constitution v1.4.0 Principle I).
- **FR-008**: System MUST allow secret rotation with a 24-hour grace window during which both old and new secrets verify; the audit log MUST flag webhooks accepted on the deprecated grace key.
- **FR-009**: System MUST emit one audit log entry per webhook receipt recording: timestamp, source IP, tenant, request ID, signature outcome (verified / rejected / deprecated-grace), and processing outcome (matched / non-member / unmatched / duplicate / malformed).

**Event + registration data**

- **FR-010**: System MUST upsert an event row keyed by `(tenant_id, source, externalId)`; subsequent deliveries with the same external event ID MUST update mutable event metadata (name, dates, location, category) and set `last_updated_at`.
- **FR-011**: System MUST insert a new event-registration row keyed by `(tenant_id, eventId, externalId)` where `externalId` is the EventCreate attendee ID; same-attendee replays MUST return 409 (FR-004).
- **FR-011a**: System MUST validate webhook payloads under a strict-on-required + permissive-on-unknown contract:
   - Required fields (per the documented attendee + event contract) are validated by zod; a missing or wrong-typed required field returns HTTP 400 with field-level error detail + an audit-log entry tagged `malformed`.
   - Unknown fields anywhere in the payload (e.g., new EventCreate fields, Zapier-injected fields) MUST NOT cause rejection; they MUST be preserved verbatim in the `registrations.metadata` JSONB column (and, for event-level unknown fields, in an analogous `events.metadata` JSONB column).
   - Reserved field names for the canonical attendee + event contract take precedence over any same-named unknown field.
- **FR-012**: System MUST attempt attendee → member matching in this order: (1) exact match on `LOWER(contacts.email)`, (2) email-domain match against `members.email_domain` (skipped if email domain is on the personal-email deny list — see Assumptions), (3) fuzzy normalised company-name match (Levenshtein ≤ 3) against tenant members, (4) `match_type = "non_member"`. Ambiguous fuzzy matches MUST set `match_type = "unmatched"` for admin review.
- **FR-013**: System MUST persist non-member registrations with `match_type = "non_member"` and never decrement any quota for them.
- **FR-014**: System MUST allow the admin to manually relink a registration to a different member; the relink action MUST credit back the previously-decremented quota and re-evaluate the new member's quota effect, audit-logging both transitions with the admin's actor identifier. **Restriction**: relink is **disallowed on rows where `pii_pseudonymised_at IS NOT NULL`** — once an attendee's PII has been retention-purged (after the 2-year non-member retention threshold per FR-032), the original attendee identity is irrecoverable and contaminating the registration with a member link would create a record-level inconsistency. The UI MUST display "Cannot relink — attendee PII has been retention-purged. The original attendee identity is no longer recoverable. Manually re-import the registration via CSV if you have the original data." in lieu of the relink action on these rows.

**Benefit quota accounting**

- **FR-015**: System MUST decrement a per-event partnership ticket quota when (a) the event is flagged `is_partner_benefit = true`, (b) the matched member's plan is a Partnership tier with a non-zero per-event ticket allotment, and (c) that member has at least one ticket remaining for this event.
- **FR-016**: System MUST decrement an annual cultural-event quota when (a) the event is flagged `is_cultural_event = true`, (b) the matched member's plan is a Corporate tier with a non-zero annual cultural allotment, and (c) that member has remaining cultural quota for the calendar year of the event start date.
- **FR-017**: System MUST mark registrations that would otherwise consume quota but find the quota exhausted as `counted_against_partnership = false` (or cultural equivalent), persist them, and surface them with an "over quota" indicator in the admin event detail view.
- **FR-018**: System MUST credit back the relevant quota when a registration arrives (or is re-imported) with `payment_status = "refunded"`, recording the reversal in the audit log.
- **FR-019**: System MUST allow an admin to toggle `is_partner_benefit` and `is_cultural_event` on an event after import (overriding the EventCreate category mapping); the toggle MUST trigger a one-pass re-evaluation of all that event's registrations' quota effects, with each adjustment audit-logged.
- **FR-019a**: System MUST allow an `admin` to archive an event (admin-only action — not available to `manager`); archival sets `archived_at = NOW()`, reverses all `counted_against_partnership = true` and `counted_against_cultural_quota = true` flags on that event's registrations (crediting back the corresponding quotas), and audit-logs each reversal. Archived events are hidden from the default events list at `/admin/events` but accessible via an "Include archived" filter and remain accessible at `/admin/events/{eventId}` with an "Archived" badge. EventCreate upstream deletion does NOT auto-archive (Chamber-OS owns its representation); subsequent webhook deliveries for an archived event's `(source, externalId)` are persisted (new registrations) but the event remains archived and registrations remain quota-neutral until an admin reactivates the event by archiving a fresh import path (out of scope for v1 — no in-product "unarchive" action).

**Admin UI surfaces**

- **FR-020**: System MUST render an events list at `/admin/events` showing each imported event with date, name, category, total registrations, partner-benefit flag, and match-rate percentage; sortable by date (default: descending), paginated. The page MUST render a **context-aware empty state** when no rows are returned (per US2 AS5): three variants distinguishing (a) no integration configured (CTA → integration setup), (b) integration configured but zero deliveries (helper text + "Send test webhook" CTA), (c) all events archived (toggle "Show archived events"). Empty-state copy is fully i18n'd (EN+TH+SV) and meets WCAG 2.1 AA contrast + focus-management requirements.
- **FR-021**: System MUST render an event detail view at `/admin/events/{eventId}` showing event metadata (read-only, from EventCreate), a paginated/searchable attendee table with match status + quota effect per row, an aggregate match-rate indicator, and a deep link to `eventCreateUrl`.
- **FR-022**: System MUST render an integration config page at `/admin/settings/integrations/eventcreate` showing the current webhook URL, the masked secret, a "Rotate secret" action (with confirmation), the last-received webhook timestamp, and the last 10 webhook deliveries with verification + processing outcomes.
- **FR-023**: System MUST provide a "Test webhook" button on the integration config page that sends a synthetic, signed payload to its own endpoint, displays the round-trip outcome, and records the test in the recent-deliveries panel.
- **FR-024**: System MUST provide a one-time-reveal of the webhook secret immediately after generation/rotation, with a copy-to-clipboard control and a clear warning that the secret will not be shown again.
- **FR-025**: System MUST render an inline Zapier setup walkthrough on the integration config page covering: connect EventCreate to Zapier, choose the trigger, configure the Webhook POST action (URL, headers including `X-Chamber-Signature` and `X-Chamber-Timestamp`, body fields), test and publish.

**CSV fallback**

- **FR-026**: System MUST provide a CSV import workflow at `/admin/events/import` accepting drag-drop or file-picker upload, rendering a 10-row preview with automatic column-mapping suggestions for the canonical fields, and allowing the admin to confirm or remap before submission.
- **FR-027**: System MUST process CSV imports through the same matching + quota logic as the webhook handler, ensuring that the same input produces an identical persisted state regardless of ingestion path.
- **FR-028**: System MUST render a CSV import result summary showing: rows processed, events created/updated, registrations matched (by match type), error rows (with row number + reason).
- **FR-029**: System MUST skip CSV rows with invalid required fields and report them in the error report; valid rows in the same file MUST still be processed.

**Cross-cutting + operational**

- **FR-030**: System MUST localise all admin-facing UI strings, validation messages, and audit-event descriptions in EN + TH + SV.
- **FR-031**: System MUST meet WCAG 2.1 AA on all admin surfaces (events list, event detail, integration config, CSV import).
- **FR-032**: System MUST apply differentiated PII retention to attendee data per PDPA / GDPR data-minimisation:
   - **Member-linked attendees** (`match_type ∈ {member_contact, member_domain, member_fuzzy}`): full PII (name, email, company) retained for **5 years** from event start date, aligned with audit baseline.
   - **Non-member attendees** (`match_type ∈ {non_member, unmatched}`): full PII retained for **2 years** from event start date; thereafter the row is **pseudonymised** by replacing attendee email/name/company with a deterministic salted hash. Quota-accounting flags, ticket info, match-resolution metadata, and event linkage are preserved (so aggregate match-rate, attendance counts, and quota history remain valid).
   - **Webhook-receipt audit-log entries** (FR-009): retained 5 years independent of attendee retention path.
   - Lawful basis for processing under PDPA / GDPR is **legitimate interest** (chamber's record of who attended its events for membership-benefit accounting and historical reporting); the integration onboarding wizard MUST surface a check-the-box prompt for the tenant admin to assert that EventCreate-side registration captures equivalent attendee notice + (where applicable) consent.
- **FR-032a**: System MUST provide an Admin-only erasure tool at `/admin/events/{eventId}/registrations/{registrationId}/erase` (and an equivalent attendee-search-by-email surface for cross-event sweeps) that, on confirmation, deletes the attendee PII + registration row(s), reverses any quota counted against the attendee's matched member, and records the erasure in the audit log with the admin actor + reason text. The action satisfies PDPA §30 / GDPR Art. 17 data subject erasure requests.
- **FR-033**: System MUST allow a super-admin (or per-tenant operator) to disable EventCreate ingestion for a tenant; while disabled, the webhook endpoint returns HTTP 503 with `Retry-After` and rejected receipts are audit-logged.
- **FR-034**: System MUST ship behind a feature flag (`FEATURE_F6_EVENTCREATE`, default `false`) so it can be released dark and enabled per environment.
- **FR-035**: System MUST enforce role-based access on F6 admin surfaces per this matrix (consistent with F1 RBAC + F4 finance-read-only pattern). The status code differs between **action-level** (manager sees the surface but can't act → 403) and **surface-level** (manager can't see the surface at all → 404):
   - `admin`: full read + write across all F6 surfaces (events list, event detail, integration config + secret reveal/rotation, manual relink, partner/cultural override toggle, CSV import, super-admin kill switch).
   - `manager`: read-only on `/admin/events` (events list) and `/admin/events/{eventId}` (event detail). Write actions within `/admin/events/**` (relink, archive, partner/cultural toggle, CSV import, PII erasure) MUST return **403 Forbidden** + `role_violation_blocked` audit (action-level — manager sees the surface, just cannot perform the mutation). The entire `/admin/settings/integrations/eventcreate/**` route prefix MUST return **404 Not Found** for `manager` (surface-disclosure prevention — the existence of secret-bearing surfaces is itself sensitive information; manager should not be able to differentiate "endpoint exists but I'm forbidden" from "endpoint doesn't exist") + `role_violation_blocked` audit.
   - `member`: no access to any `/admin/events*` or `/admin/settings/integrations/eventcreate` route — **404** to avoid surface disclosure + `role_violation_blocked` audit.
- **FR-036**: System MUST emit a baseline observability surface conforming to `docs/observability.md` § 14, at the same ship-readiness bar as F7 and F8:
   - **~11 OTel metrics**: webhook receipts by outcome (verified / sig-rejected / replay-rejected / duplicate / malformed / matched / non-member / unmatched), webhook ingest p50 + p95 latency histogram, per-tenant match-rate gauge, CSV import job duration histogram, partnership-quota-decrement counter, cultural-quota-decrement counter, refund-credit-back counter, secret-rotation counter, ingest-disabled-tenant gauge, **idempotency-TTL-sweep rows-deleted counter** (per-tenant; signals sweep is running + bounds the table size — see research.md R10 AA1 addition).
   - **~6 alerts**: signature-rejection burst (>N/min sustained), per-tenant match-rate drop below SC-002 threshold, webhook p95 over SC-003 budget, CSV import failure-rate spike, ingest-disabled tenant detected, **idempotency-sweep silently-stalled** (`eventcreate_idempotency_sweep_rows_total` rate == 0 for ≥2 consecutive days while `eventcreate_idempotency_receipts` row count is growing).
   - **3 runbooks**: signature-failure investigation, match-rate degradation triage, secret-rotation operational procedure.
   - Metric naming follows the platform convention `eventcreate_*` (e.g., `eventcreate_webhook_receipts_total`, `eventcreate_match_rate_gauge`, `eventcreate_idempotency_sweep_rows_total`).
- **FR-037**: System MUST treat each webhook delivery as a strict ACID unit:
   - All primary state changes — event upsert (FR-010), event-registration insert (FR-011), idempotency receipt write (FR-004), partnership-quota decrement (FR-015), cultural-quota decrement (FR-016), refund-credit-back update (FR-018) — MUST commit in a **single database transaction** scoped to the request.
   - On any error within that transaction (DB unavailability, unique-constraint violation, port failure, timeout), the system MUST roll back the entire transaction and return HTTP 5xx so Zapier retries via its standard backoff schedule.
   - Because the idempotency receipt is part of the same transaction, a successful retry after recovery is correctly recognised on replay (no duplicate-side-effect risk).
   - The failed-delivery audit-log entry (FR-009) MUST be emitted in a SEPARATE post-rollback transaction with `processing_outcome = "rolled_back"`, preserving observability even when the primary transaction fails.
   - Quota-counter drift is impossible by construction under this model (no partial commits possible).

### Key Entities

- **Event**: An external event imported from a source SaaS (initially EventCreate, `source = "eventcreate"` with extensibility for future sources). Identified per tenant by `(source, externalId)`. Holds metadata (name, dates, location, category, deep-link URL), benefit-classification flags (`is_partner_benefit`, `is_cultural_event`), and an archive lifecycle marker (`archived_at` — null when active; non-null when soft-deleted per FR-019a). Upstream deletion in EventCreate does not cascade.
- **Event Registration**: A single attendee's registration for an Event. Identified per tenant by `(eventId, externalId)` where `externalId` is the EventCreate attendee ID. Holds attendee identity (email, name, company), the match resolution (`match_type` + optional `matched_member_id` / `matched_contact_id`), ticket info (type, price, payment status), quota-accounting flags, timestamps, and a `metadata` JSONB column carrying any unknown-but-preserved fields from the incoming payload (FR-011a, forward-compat).
- **Tenant Webhook Config**: Per-tenant, per-source webhook credentials. Holds the active shared secret, a (possibly null) deprecated grace secret with rotation timestamp, an enabled/disabled flag, and creation/rotation audit timestamps.
- **Idempotency Receipt**: Short-lived record of a processed webhook delivery's `X-Request-ID` (7-day TTL) used to detect duplicate deliveries.
- **Audit Log Entry**: An append-only record of each webhook receipt outcome, secret rotation, manual relink, override toggle, quota effect, CSV import action, event archival, and PII erasure action — scoped by tenant, retained ≥5 years regardless of underlying attendee retention path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh tenant admin can complete EventCreate integration setup end-to-end (open wizard → copy URL+secret → configure Zap → press "Test webhook" → see green confirmation) in **under 15 minutes**.
- **SC-002**: Across a representative sample of tenant attendee data with reasonably clean contact records, **≥95% of incoming attendees are auto-matched** to a member or correctly flagged `non_member` without manual relink. Verified via the `eventcreate_match_rate_gauge` OTel metric (research.md R10 / FR-036) in the first 30 days post-go-live for SweCham: pass when `gauge.value ≥ 0.95` over the rolling 30-day window with denominator ≥ 50 attendees.
- **SC-003**: Webhook ingestion p95 latency is **under 300 milliseconds** (from request received to HTTP 200 response sent), measured at the application boundary against a per-tenant load profile of 50,000 registrations/yr distributed across ~100 events with a sustained 60 req/min burst (see Assumptions › Scale envelope), so Zapier never retries due to handler timeout under normal load.
- **SC-004**: Across 100 sequential events of mixed types and quota states, the partnership + cultural quota counters are accurate with **zero accounting errors** — no double-decrement, no missed decrement, no leak across tenants, no missing credit-back on refund.
- **SC-005**: Time spent by an admin on attendance bookkeeping drops by **≥85% of the chamber's current baseline** as measured at integration go-live + 30 days. Measurement protocol (per Session 2026-05-12 round 3 Q4 commitment): maintainer self-observes one pre-flag-flip event for baseline + first three post-flag-flip events for the new figure; records minutes-per-event in `retrospective.md`; computes `time_saving_pct = 1 − mean(new_minutes) / baseline_minutes`; pass iff `time_saving_pct ≥ 0.85`. Pass-criterion is the **ratio** — accommodates baselines that turn out to be 5 min or 30 min equally.
- **SC-006**: The CSV fallback processes **1,000 rows in under 60 seconds** (one tenant's typical event-day batch — see Assumptions › Scale envelope) and produces an event/registration state equivalent to the same payloads delivered via the webhook path.
- **SC-007**: **100% of webhook deliveries** (verified, rejected, duplicate, malformed) are reflected in the audit log with the correct outcome categorisation.
- **SC-008**: Secret rotation succeeds without dropping any in-flight webhook delivery; old secret continues to verify successfully for **24 hours** after rotation and stops verifying on the 25th hour.
- **SC-009**: Cross-tenant probe attempts (request signed with Tenant A's secret hitting Tenant B's URL) **return HTTP 401 in 100% of cases** and are reflected in the audit log with elevated severity.
- **SC-010**: Admin UI surfaces (events list, event detail, integration config, CSV import) meet **WCAG 2.1 AA** at scan time across EN + TH + SV.
- **SC-011**: 100% of non-member attendee rows reaching the 2-year retention threshold are pseudonymised by the next scheduled retention sweep (≤7 days after threshold); 0 PII leaks past the sweep horizon in audit verification.
- **SC-012**: A PDPA / GDPR data subject erasure request reaches verified completion (admin confirms erasure tool output + audit log entry) within **30 days** of receipt, satisfying the statutory deadline for both regimes.

## Assumptions

**Source-of-truth + integration boundaries**

- EventCreate remains the system of record for event creation, ticketing, registration, payment, and check-in; Chamber-OS is the system of record for member-centric attendance accounting and is read-only against EventCreate's outputs.
- Each tenant owns and operates its own EventCreate and Zapier accounts; Chamber-OS does not embed or resell either.
- Zapier free-tier polling cadence (~15 minutes) is acceptable for chamber events. Tenants with high event throughput are expected to upgrade Zapier on their own.
- The EventCreate-side Zap is configured by the tenant admin using the on-screen walkthrough; one-time setup time of ~10–15 minutes is acceptable.

**Matching + quota**

- Personal-email domains (gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com, and a small extensible deny list) are skipped for domain-based matching to avoid false positives; matching falls through to fuzzy company name or `unmatched`.
- Fuzzy company-name matching uses normalisation (strip "Co., Ltd.", "Pte", "AB", "Ltd", "Inc", trailing punctuation, lowercase) plus Levenshtein distance ≤ 3 against tenant members; ambiguous results (multiple winners) are surfaced as `unmatched` for admin relink rather than auto-resolved.
- Partnership ticket quotas are **per-event** (Diamond 6, Platinum 4, Gold 2 tickets per event); the relevant per-event allotment is read from the matched member's active plan at the time of registration ingestion.
- Cultural-event quotas are **annual** (Premium 2/year, Large 1/year), reset on 1 January of the event's `startDate.year` (member's tenant timezone is used for the year boundary in future iterations; first release uses calendar year UTC).
- The **member discount rate** (members get reduced ticket price on all events) is handled inside EventCreate and is not separately tracked by Chamber-OS; F6 records `ticketPricePaid` but does not compute "savings".
- When a registration is imported with `payment_status = "refunded"`, the registration row is retained (with status updated) and any previously-decremented quota is credited back. Full deletion is not used; this preserves historical reporting and audit trail.
- Quota exhaustion (e.g., 7th attendee from a Diamond-6 company) does NOT cause the import to fail. The registration is persisted with `counted_against_partnership = false` and surfaced with an "over quota" warning so the admin can reconcile with the member separately. EventCreate is authoritative for whether the seat exists; Chamber-OS only tracks whether it counts against the benefit. The over-quota indicator is **informational only in v1** — no in-product remediation action (charge as paid ticket, split event, etc.) is provided; admin handles reconciliation offline (e.g., raise an invoice via F4 for the extra ticket). In-product remediation actions are an explicit F6.1 backlog item.
- Unmatched attendees are listed on the event detail page (with a count badge) and admins manually relink during routine event review; no daily-digest email is sent in this release (Smart Inbox / daily digest deferred to post-MVP, consistent with `docs/smart-chamber-features.md` post-MVP backlog).

**Scale envelope**

- Design target is **medium-chamber scale**: ~100 events/yr/tenant × ~500 attendees/event = ~50,000 registrations/yr/tenant, with a sustained 60 req/min webhook burst (matching FR-005 rate limit). All success criteria are validated against this profile.
- SweCham today (~131 members, ≲30 events/yr × ≲200 attendees) sits well below the design target, leaving ~5× headroom. The same target supports an additional 2–3 tenants of comparable size on shared infrastructure without re-architecture.
- Larger tenants (≥250 events/yr × ≥1,000 attendees = ≥250k registrations/yr) are explicitly outside the v1 envelope and trigger a re-validation of pagination + indexing strategy before onboarding.

**Tech + operational**

- F2 (Membership Plans) and F3 (Members & Contacts) are shipped and provide the quota-bearing plan fields + member/contact entities and email-domain attribute that F6 reads.
- Per-tenant webhook secrets are stored encrypted at rest under Constitution v1.4.0 Principle I (Data Privacy & Security) using existing platform secret-management primitives.
- Audit log entries for F6 events follow the existing audit-log schema with the standard 5-year retention default (no F4-style 10-year tax retention applies — these are not Thai tax documents).
- The webhook handler runs on the platform's standard Functions runtime (Node.js via Fluid Compute) — a sub-300ms p95 budget is achievable without dedicated infrastructure.
- The CSV import job uses the platform's background-job primitive (no new infrastructure); a 1,000-row import completes inline within a single function execution under the 60-second performance target (SC-006).
- F6 ships dark behind `FEATURE_F6_EVENTCREATE` (default `false`) with a per-environment + per-tenant on switch; the default-off posture allows operator-controlled rollout per Chamber-OS phased delivery norms.

**Privacy + compliance posture**

- The chamber's lawful basis for processing attendee PII (members + non-members) is **legitimate interest** under PDPA §24(5) and GDPR Art. 6(1)(f) — the chamber's record of who attended its events is core to membership-benefit accounting and historical reporting.
- Tenant admin asserts at integration onboarding that EventCreate-side registration provides attendees with equivalent notice (privacy notice + organiser identity + purpose), satisfying PDPA §23 collection-notice / GDPR Art. 13 transparency obligations upstream.
- Pseudonymisation of non-member attendees at 2 years uses a deterministic salted hash (per-tenant salt) so the same email continues to map to the same hash post-pseudonymisation; this preserves the ability to recompute aggregate match-rate / attendance metrics without retaining identifying data.
- A retention-sweep job runs daily (operational frequency confirmed during plan); SC-011 measures completion within 7 days of threshold to provide alarm headroom.
- Cross-border transfer of attendee PII (member + non-member) is covered by the same SCC / PDPA §28 instruments documented in the F1 hosting deviation (Vercel `sin1` + Neon `ap-southeast-1`); no additional cross-border instrument is needed for F6.

**Out of scope (re-stated for clarity)**

- Native event CRUD (creating/editing/deleting events inside Chamber-OS) — EventCreate handles this.
- Public landing pages, ticketing, payment processing, attendee check-in, QR scanning — EventCreate handles these (with F5 covering chamber-wide membership payments separately).
- Calendar sync (ICS export, Google/Outlook calendar attach) — deferred to a future Smart Feature backlog item.
- Email invitations to members for events — out of scope (F7 E-Blast handles broadcast comms; per-event invites stay in EventCreate or in tenant's own tools).
- Multi-source ingestion beyond EventCreate (e.g., Eventbrite, native Zapier-bridge to a different SaaS) — the `events.source` column is reserved for future expansion, but only EventCreate is supported in this feature.
