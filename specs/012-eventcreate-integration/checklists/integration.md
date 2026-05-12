# Integration Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **external-integration + cross-module + schema-versioning + supply-chain requirements** in spec.md, plan.md, research.md, data-model.md, and contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: EventCreate webhook contract, schema versioning, CSV-webhook equivalence, F8 EventAttendeesPort wiring, Zapier supply-chain risk, multi-tenant onboarding, cross-module port discipline.

## EventCreate Webhook Contract

- [ ] CHK001 - Is the JSON payload contract specified with required vs. optional field discrimination at every nesting level? [Completeness, contracts/webhook-eventcreate-api.md + data-model.md § 10]
- [ ] CHK002 - Are the three security headers explicitly enumerated (`X-Chamber-Signature`, `X-Chamber-Timestamp`, `X-Request-ID`) with format + validation requirements? [Clarity, contracts/webhook-eventcreate-api.md]
- [ ] CHK003 - Is the HTTPS-only constraint explicit in FR-001 + contracts (no plain HTTP fallback)? [Coverage, Spec §FR-001]
- [ ] CHK004 - Is the URL path scheme requirement specified as source-specific (`/api/webhooks/eventcreate/v1/{tenant}`) with the rationale (Stripe/GitHub/Slack/Resend precedent) documented? [Clarity, Session 2026-05-12 round 3 Q2]
- [ ] CHK005 - Are the v1 → v2 schema-version transition requirements specified (new endpoint path, not in-place mutation)? [Coverage, Spec §FR-001]
- [ ] CHK006 - Are the HTTP response shapes for every outcome (200 / 400 / 401 / 409 / 415 / 429 / 503 / 5xx) specified with body schema + audit-event mapping? [Completeness, contracts/webhook-eventcreate-api.md]

## Schema Versioning + Forward-Compat (FR-011a)

- [ ] CHK007 - Is the strict-on-required + permissive-on-unknown contract specified for the zod payload validator? [Clarity, Spec §FR-011a]
- [ ] CHK008 - Are the `events.metadata` + `event_registrations.metadata` JSONB columns specified as the forward-compat carriers for unknown payload fields? [Completeness, data-model.md § 1.1 + § 1.2]
- [ ] CHK009 - Is the canonical-column-collision rule specified (canonical column names take precedence over same-named keys in `metadata`)? [Clarity, Spec §FR-011a]
- [ ] CHK010 - Are the rules for handling a previously-set field that disappears in a later delivery specified (preserve-in-metadata vs. NULL-out)? [Edge Case, Spec §FR-011a]

## CSV-Webhook Equivalence (FR-027 + SC-006)

- [ ] CHK011 - Is the byte-equivalence guarantee between CSV path and webhook path quantified with explicit excluded-columns (modulo timestamps + UUIDs)? [Measurability, contracts/csv-import-api.md round-2 E15]
- [ ] CHK012 - Is the requirement that CSV-import uses the **same match logic** as the webhook handler specified (single use-case `match-attendee-to-member.ts`)? [Clarity, Spec §FR-027]
- [ ] CHK013 - Is the requirement that CSV-import uses the **same quota logic** as the webhook handler specified (single use-case `apply-quota-effect.ts`)? [Clarity, Spec §FR-027]
- [ ] CHK014 - Are the requirements for the equivalence integration test specified (`tests/integration/events/csv-webhook-equivalence.test.ts`) with assertion strategy? [Coverage, plan.md Testing § round-1 E15]
- [ ] CHK015 - Is the CSV format strictness specified (supported variants enumerated, unsupported variants explicitly rejected with reasons)? [Clarity, research.md R8 round-1 E20]
- [ ] CHK016 - Are the requirements for handling re-uploaded CSV (idempotency + `rowsAlreadyImported` count) specified? [Edge Case, Spec §FR-027 + contracts/csv-import-api.md round-2 R3]

## F8 `EventAttendeesPort` Adapter Wiring

- [ ] CHK017 - Is the canonical method name (`getEventAttendeesByMember`) specified consistently across F6 plan.md + research.md R11 + quickstart.md + contracts? [Consistency, round-1 E16 + round-3 Z1]
- [ ] CHK018 - Is the composition-root adapter-swap requirement specified (feature-flag gated on `FEATURE_F6_EVENTCREATE`)? [Clarity, quickstart.md § 2.2]
- [ ] CHK019 - Are the F8-port-wired-correctly integration test requirements specified (verify F8 sees real data when flag is on, stub when flag is off)? [Coverage, plan.md Testing § round-1 X3]
- [ ] CHK020 - Is the Clean Architecture Principle III boundary specified — F8 imports `EventAttendeesPort` from F8's own barrel only, never directly from F6? [Coverage, research.md R11]
- [ ] CHK021 - Is the rationale for the Application-layer wrapper (`get-event-attendees-by-member.ts`) over a direct Infrastructure adapter documented? [Clarity, research.md R11 round-2 E1]

## Zapier Supply-Chain + Contingency

- [ ] CHK022 - Is the Zapier-as-only-integration-surface dependency documented explicitly (no public EventCreate API)? [Completeness, research.md R1]
- [ ] CHK023 - Is the 3-layer graceful-degradation strategy specified (Zapier → n8n/Make.com middleware-swap → CSV ultimate fallback)? [Coverage, research.md R1 round-3 Q5]
- [ ] CHK024 - Are the requirements for the 6-month Zapier-UI screenshot review cycle documented (maintenance against UI drift)? [Coverage, research.md R12 round-1 P9]
- [ ] CHK025 - Is the requirement for a `docs/runbooks/eventcreate-zapier-deprecation-response.md` runbook (authored only if deprecation announced) specified? [Coverage, research.md R1]
- [ ] CHK026 - Are Zapier free-tier (15-min polling) vs. paid-tier (~1-min polling) assumptions documented with rate-limit headroom math (FR-005's 10 req/min/tenant = 150× free / 10× paid)? [Clarity, Spec §FR-005]

## Multi-Tenant Onboarding (US3)

- [ ] CHK027 - Is the tenant-onboarding wizard flow specified end-to-end (generate secret → save → Zapier setup → test webhook → confirmation)? [Completeness, Spec §US3, research.md R12]
- [ ] CHK028 - Is the SC-001 15-minute end-to-end onboarding target measurable with a defined start/end-point protocol? [Measurability, Spec §SC-001]
- [ ] CHK029 - Are the requirements for the in-product Zapier walkthrough specified (8 steps with EN-only screenshots + TH/SV narration)? [Clarity, research.md R12 + Session 2026-05-12 round 3 Q3]
- [ ] CHK030 - Is the "Test webhook" round-trip scope specified as signature-only short-circuit (sentinel external_id) rather than full ingest? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 P8]
- [ ] CHK031 - Is the integration-config-page nav-visibility requirement for CSV-only tenants specified (hidden by default; reachable via URL/empty-state)? [Coverage, contracts/admin-integration-eventcreate-api.md round-2 R1]

## Cross-Module Boundary Discipline

- [ ] CHK032 - Are the F2 + F3 read-only consumer requirements explicit (no F6 write-path into F2 plans or F3 members beyond quota counter)? [Coverage, data-model.md § 8]
- [ ] CHK033 - Is the F2 barrel function `getMemberPlanForBucket(memberId)` (introduced by F8) explicitly named as F6's only access to plan data? [Clarity, data-model.md § 8 + research.md R5]
- [ ] CHK034 - Is the F5 `processor_events` table explicitly **NOT** reused (F6 has its own `eventcreate_idempotency_receipts`) with rationale documented? [Clarity, research.md R3 round-3 Z1]
- [ ] CHK035 - Are the future-generalisation-path requirements specified for a shared `webhook_idempotency_receipts` table (if a 4th integration arrives)? [Coverage, research.md R3]

## Notes

- This checklist is the canonical integration review gate for F6 per Constitution Principle III (Clean Architecture).
- All "[Gap]" items require resolution before `/speckit.implement`.
- F8 port wiring is a load-bearing seam — staff-review MUST verify before merge.
