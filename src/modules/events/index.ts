/**
 * F6 — EventCreate Integration public barrel.
 *
 * Module bootstrapped at `/speckit.implement` Phase 1 (T003).
 * All cross-module access from outside `src/modules/events/` MUST go
 * through this barrel (enforced by `eslint.config.mjs`
 * `no-restricted-imports` rule per Constitution Principle III).
 *
 * Surface shipped here is intentionally empty — placeholder only — and
 * grows incrementally as Phase 2 (Foundational) and Phase 3-10 user
 * stories land their Domain types, Application ports, and use-case
 * exports per `specs/012-eventcreate-integration/plan.md § Project
 * Structure`:
 *
 *   Domain types (Phase 2 T015-T026):
 *     - EventAggregate, EventRegistrationAggregate
 *     - TenantWebhookConfigAggregate
 *     - MatchResolution, QuotaEffect, Attendee, Ticket
 *     - WebhookOutcome, ProcessingOutcome
 *     - MatchType, PaymentStatus, Source
 *     - Branded ID types (EventId, RegistrationId, ExternalEventId,
 *       ExternalAttendeeId, AttendeeEmail, WebhookSecret)
 *
 *   Application ports (Phase 2 T027-T034):
 *     - WebhookSignatureVerifier, IdempotencyStore, AttendeeMatcher
 *     - QuotaAccountingPort
 *     - EventsRepository, RegistrationsRepository,
 *       TenantWebhookConfigRepository
 *     - F6AuditPort, CsvImporter, RetentionSweeper
 *
 *   Use-case exports (Phase 3-10 — added per user-story phase):
 *     - ingestWebhookAttendee (Phase 3 T047)
 *     - archiveEvent (Phase 10 T107)
 *     - relinkRegistration (Phase 9 T104)
 *     - togglePartnerBenefit, toggleCulturalEvent (Phase 6 T087)
 *     - eraseAttendeePii (Phase 10 T110)
 *     - importCsv (Phase 7 T094)
 *     - rotateWebhookSecret (Phase 5 T071)
 *     - runTestWebhook (Phase 5 T072)
 *     - pseudonymiseStaleNonMemberPii (Phase 10 T113)
 *     - getEventAttendeesByMember (Phase 10 T120 — F8 port impl)
 */
export {};
