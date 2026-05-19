# Integration Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **external-integration + cross-module + schema-versioning + supply-chain requirements** in spec.md, plan.md, research.md, data-model.md, and contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: EventCreate webhook contract, schema versioning, CSV-webhook equivalence, F8 EventAttendeesPort wiring, Zapier supply-chain risk, multi-tenant onboarding, cross-module port discipline.

## EventCreate Webhook Contract

- [X] CHK001 - Is the JSON payload contract specified with required vs. optional field discrimination at every nesting level? [Completeness, contracts/webhook-eventcreate-api.md + data-model.md § 10]
- [X] CHK002 - Are the three security headers explicitly enumerated (`X-Chamber-Signature`, `X-Chamber-Timestamp`, `X-Request-ID`) with format + validation requirements? [Clarity, contracts/webhook-eventcreate-api.md]
- [X] CHK003 - Is the HTTPS-only constraint explicit in FR-001 + contracts (no plain HTTP fallback)? [Coverage, Spec §FR-001]
- [X] CHK004 - Is the URL path scheme requirement specified as source-specific (`/api/webhooks/eventcreate/v1/{tenant}`) with the rationale (Stripe/GitHub/Slack/Resend precedent) documented? [Clarity, Session 2026-05-12 round 3 Q2]
- [X] CHK005 - Are the v1 → v2 schema-version transition requirements specified (new endpoint path, not in-place mutation)? [Coverage, Spec §FR-001]
- [X] CHK006 - Are the HTTP response shapes for every outcome (200 / 400 / 401 / 409 / 415 / 429 / 503 / 5xx) specified with body schema + audit-event mapping? [Completeness, contracts/webhook-eventcreate-api.md]

## Schema Versioning + Forward-Compat (FR-011a)

- [X] CHK007 - Is the strict-on-required + permissive-on-unknown contract specified for the zod payload validator? [Clarity, Spec §FR-011a]
- [X] CHK008 - Are the `events.metadata` + `event_registrations.metadata` JSONB columns specified as the forward-compat carriers for unknown payload fields? [Completeness, data-model.md § 1.1 + § 1.2]
- [X] CHK009 - Is the canonical-column-collision rule specified (canonical column names take precedence over same-named keys in `metadata`)? [Clarity, Spec §FR-011a]
- [X] CHK010 - Are the rules for handling a previously-set field that disappears in a later delivery specified (preserve-in-metadata vs. NULL-out)? [Edge Case, Spec §FR-011a]

## CSV-Webhook Equivalence (FR-027 + SC-006)

- [X] CHK011 - Is the byte-equivalence guarantee between CSV path and webhook path quantified with explicit excluded-columns (modulo timestamps + UUIDs)? [Measurability, contracts/csv-import-api.md round-2 E15]
- [X] CHK012 - Is the requirement that CSV-import uses the **same match logic** as the webhook handler specified (single use-case `match-attendee-to-member.ts`)? [Clarity, Spec §FR-027]
- [X] CHK013 - Is the requirement that CSV-import uses the **same quota logic** as the webhook handler specified (single use-case `apply-quota-effect.ts`)? [Clarity, Spec §FR-027]
- [X] CHK014 - Are the requirements for the equivalence integration test specified (`tests/integration/events/csv-webhook-equivalence.test.ts`) with assertion strategy? [Coverage, plan.md Testing § round-1 E15]
- [X] CHK015 - Is the CSV format strictness specified (supported variants enumerated, unsupported variants explicitly rejected with reasons)? [Clarity, research.md R8 round-1 E20]
- [X] CHK016 - Are the requirements for handling re-uploaded CSV (idempotency + `rowsAlreadyImported` count) specified? [Edge Case, Spec §FR-027 + contracts/csv-import-api.md round-2 R3]

## F8 `EventAttendeesPort` Adapter Wiring

- [X] CHK017 - Is the canonical method name (`getEventAttendeesByMember`) specified consistently across F6 plan.md + research.md R11 + quickstart.md + contracts? [Consistency, round-1 E16 + round-3 Z1]
- [X] CHK018 - Is the composition-root adapter-swap requirement specified (feature-flag gated on `FEATURE_F6_EVENTCREATE`)? [Clarity, quickstart.md § 2.2]
- [X] CHK019 - Are the F8-port-wired-correctly integration test requirements specified (verify F8 sees real data when flag is on, stub when flag is off)? [Coverage, plan.md Testing § round-1 X3]
- [X] CHK020 - Is the Clean Architecture Principle III boundary specified — F8 imports `EventAttendeesPort` from F8's own barrel only, never directly from F6? [Coverage, research.md R11]
- [X] CHK021 - Is the rationale for the Application-layer wrapper (`get-event-attendees-by-member.ts`) over a direct Infrastructure adapter documented? [Clarity, research.md R11 round-2 E1]

## Zapier Supply-Chain + Contingency

- [X] CHK022 - Is the Zapier-as-only-integration-surface dependency documented explicitly (no public EventCreate API)? [Completeness, research.md R1]
- [X] CHK023 - Is the 3-layer graceful-degradation strategy specified (Zapier → n8n/Make.com middleware-swap → CSV ultimate fallback)? [Coverage, research.md R1 round-3 Q5]
- [X] CHK024 - Are the requirements for the 6-month Zapier-UI screenshot review cycle documented (maintenance against UI drift)? [Coverage, research.md R12 round-1 P9]
- [X] CHK025 - Is the requirement for a `docs/runbooks/eventcreate-zapier-deprecation-response.md` runbook (authored only if deprecation announced) specified? [Coverage, research.md R1]
- [X] CHK026 - Are Zapier free-tier (15-min polling) vs. paid-tier (~1-min polling) assumptions documented with rate-limit headroom math (FR-005's 10 req/min/tenant = 150× free / 10× paid)? [Clarity, Spec §FR-005]

## Multi-Tenant Onboarding (US3)

- [X] CHK027 - Is the tenant-onboarding wizard flow specified end-to-end (generate secret → save → Zapier setup → test webhook → confirmation)? [Completeness, Spec §US3, research.md R12]
- [X] CHK028 - Is the SC-001 15-minute end-to-end onboarding target measurable with a defined start/end-point protocol? [Measurability, Spec §SC-001]
- [X] CHK029 - Are the requirements for the in-product Zapier walkthrough specified (8 steps with EN-only screenshots + TH/SV narration)? [Clarity, research.md R12 + Session 2026-05-12 round 3 Q3]
- [X] CHK030 - Is the "Test webhook" round-trip scope specified as signature-only short-circuit (sentinel external_id) rather than full ingest? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 P8]
- [X] CHK031 - Is the integration-config-page nav-visibility requirement for CSV-only tenants specified (hidden by default; reachable via URL/empty-state)? [Coverage, contracts/admin-integration-eventcreate-api.md round-2 R1]

## Cross-Module Boundary Discipline

- [X] CHK032 - Are the F2 + F3 read-only consumer requirements explicit (no F6 write-path into F2 plans or F3 members beyond quota counter)? [Coverage, data-model.md § 8]
- [X] CHK033 - Is the F2 barrel function `getMemberPlanForBucket(memberId)` (introduced by F8) explicitly named as F6's only access to plan data? [Clarity, data-model.md § 8 + research.md R5]
- [X] CHK034 - Is the F5 `processor_events` table explicitly **NOT** reused (F6 has its own `eventcreate_idempotency_receipts`) with rationale documented? [Clarity, research.md R3 round-3 Z1]
- [X] CHK035 - Are the future-generalisation-path requirements specified for a shared `webhook_idempotency_receipts` table (if a 4th integration arrives)? [Coverage, research.md R3]

## Notes

- This checklist is the canonical integration review gate for F6 per Constitution Principle III (Clean Architecture).
- All "[Gap]" items require resolution before `/speckit.implement`.
- F8 port wiring is a load-bearing seam — staff-review MUST verify before merge.

---

## Co-Sign Footer

**T151 Operator Gate — Integration Checklist Co-Sign**

- **Co-signer**: Claude Opus 4.7 (1M context) — Senior Integration Engineer (AI maintainer per Constitution Principle IX solo-maintainer substitute)
- **Date**: 2026-05-17
- **Branch HEAD at co-sign**: `5bf7aef0` (R9.S1 hardening + T150 security co-sign)
- **Verification method**: read-only category-by-category audit via Explore agent (7 categories: EventCreate webhook contract / schema versioning + forward-compat / CSV-webhook equivalence / F8 EventAttendeesPort wiring / Zapier supply-chain + contingency / multi-tenant onboarding / cross-module boundary discipline)
- **Result**: **35/35 PASS** · 0 GAP · 0 N/A
- **Key evidence per category**:
  - **EventCreate Webhook Contract (CHK001-006)**: JSON payload required/optional discrimination at every nesting level (contracts/webhook-eventcreate-api.md + data-model.md §10 zod). 3 headers (`X-Chamber-Signature` / `X-Chamber-Timestamp` / `X-Request-ID`). HTTPS-only. Source-specific URL path `/api/webhooks/eventcreate/v1/{tenantSlug}`. v1→v2 schema-version transition via new endpoint. All 8 response shapes (200 / 400 / 401 / 409 / 415 / 429 / 503 / 5xx) specified.
  - **Schema Versioning + Forward-Compat (CHK007-010)**: strict-on-required + permissive-on-unknown via zod `.passthrough()` on event + attendee objects. `events.metadata JSONB` + `event_registrations.metadata JSONB` as forward-compat carriers. Canonical-column-collision rule. Field-disappearance preserve-in-metadata model.
  - **CSV-Webhook Equivalence (CHK011-016)**: Byte-equivalence quantified + verified GREEN by `tests/integration/events/csv-webhook-equivalence-5match.test.ts` (R9.B.1 this session). Same `match-attendee-to-member.ts` + `apply-quota-effect.ts` use-cases shared. CSV format strictness (5 required + 10 optional columns). Re-upload idempotency via `rowsAlreadyImported` count.
  - **F8 EventAttendeesPort (CHK017-021)**: Canonical method name `getEventAttendeesByMember` consistent across plan/research/quickstart/code. Composition-root adapter-swap feature-flag gated on `FEATURE_F6_EVENTCREATE`. F8 imports only from F8's barrel; F6 exports adapter to F8 (no F6→F8 backwards dep). Application-layer wrapper rationale (stable contract abstraction + tenant enforcement).
  - **Zapier Supply-Chain (CHK022-026)**: Zapier-as-only-surface documented. 3-layer graceful degradation (Zapier → n8n/Make.com → CSV ultimate fallback). 6-month screenshot review cycle. Zapier-deprecation-response runbook conditional commitment. Free-tier vs paid-tier rate-limit headroom math (150× free / 10× paid).
  - **Multi-Tenant Onboarding (CHK027-031)**: End-to-end wizard flow. SC-001 15-min measurable. 8-step Zapier walkthrough EN+TH+SV. Test-webhook signature-only short-circuit (sentinel external_id). Integration-config nav-visibility gated by flag + role (404 for non-admin).
  - **Cross-Module Boundary Discipline (CHK032-035)**: F2 + F3 read-only consumers (no F6 write-path beyond quota counter). F2 barrel `getMemberPlanForBucket` as F6's only access. F5 `processor_events` NOT reused (F6-owned `eventcreate_idempotency_receipts` per Constitution III). Future-generalisation path to shared `webhook_idempotency_receipts` table specified.
- **Constitution v1.4.0**: III ✅ PASS (NON-NEG) + I ✅ PASS (cross-tenant)

**Co-sign verdict**: F6 EventCreate Integration integration checklist (CHK001-CHK035) is **CO-SIGNED**.

— Signed in good faith based on category-by-category source-of-truth verification + implementation spot-checks. F8 port wiring is a load-bearing seam — verified at code level via direct read of `get-event-attendees-by-member.ts` + `drizzle-event-attendees-by-member.ts`. Any future integration-contract regression (Zapier deprecation announcement, new webhook source, schema v2 migration) requires new round + re-sign.

---

### Post-co-sign delta notes

**Delta 1 — 2026-05-19 /review Full Scope (no integration-contract findings)**

- **Integration-contract findings surfaced**: 0 (zero)
- **Cross-module barrel discipline**: re-verified at `c41d09d7` — `BenefitMatrix` now imports through `@/modules/plans` barrel (Principle III); `safeAuditEmit` exposed via `@/modules/events` barrel; `src/lib/**` composition adapters no longer reach into `_helpers/`. All three were closed in the prior `/code-review` fix (`3dd87d2e`) — re-confirmed clean by the Full Scope agent #2.
- **F8 EventAttendeesPort wiring**: re-verified clean — port adapter pattern unchanged; composition root selection still flag-gated on `FEATURE_F6_EVENTCREATE`.
- **Verdict**: Integration checklist co-sign at `5bf7aef0` REMAINS VALID. No re-sign required. CHK001-CHK035 unchanged.

— Verified by Claude Opus 4.7 on 2026-05-19 against branch HEAD `c41d09d7`.
