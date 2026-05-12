/**
 * F6 — EventCreate Integration public barrel.
 *
 * Module bootstrapped at `/speckit.implement` Phase 1 (T003) and
 * extended at Phase 2 (T035) with the full Domain + Application port
 * surface. All cross-module access from outside `src/modules/events/`
 * MUST go through this barrel (enforced by `eslint.config.mjs`
 * `no-restricted-imports` rule per Constitution Principle III).
 *
 * Surface organisation:
 *   1. Domain value objects + branded types
 *   2. Domain aggregates (Event / EventRegistration / TenantWebhookConfig)
 *   3. Domain pure helpers (normaliseCompanyName / levenshtein /
 *      personal-email-deny-list / payload zod schemas)
 *   4. Application port interfaces (10 ports)
 *
 * Use-case exports are added per phase as they land:
 *   - Phase 3 (US1): ingestWebhookAttendee, verifyWebhookSignature,
 *     matchAttendeeToMember
 *   - Phase 4 (US2): listEvents, loadEventDetail
 *   - Phase 5 (US3): generateWebhookSecret, rotateWebhookSecret,
 *     runTestWebhook
 *   - Phase 6 (US4): applyQuotaEffect, toggleEventCategory
 *   - Phase 7 (US5): importCsv
 *   - Phase 9 (US6): relinkRegistration
 *   - Phase 10: archiveEvent, eraseAttendeePii,
 *     pseudonymiseStaleNonMemberPii, getEventAttendeesByMember (F8 port impl)
 *
 * IMPORTANT — barrel guard: Infrastructure modules (schema.ts, Drizzle
 * adapters, crypto adapters) MUST NOT be re-exported from this barrel.
 * Infrastructure is the leaf layer; Application ports are the seam.
 */

// --- 1. Domain value objects + branded types ---------------------------------

export {
  MATCH_TYPES,
  NON_QUOTA_MATCH_TYPES,
  isMatchType,
  isNonQuotaMatchType,
  type MatchType,
  type NonQuotaMatchType,
} from './domain/value-objects/match-type';

export {
  PAYMENT_STATUSES,
  isPaymentStatus,
  type PaymentStatus,
} from './domain/value-objects/payment-status';

export {
  SOURCES,
  IDEMPOTENCY_SOURCES,
  isSource,
  isIdempotencySource,
  type Source,
  type IdempotencySource,
} from './domain/value-objects/source';

export {
  PROCESSING_OUTCOMES,
  isProcessingOutcome,
  type ProcessingOutcome,
  type WebhookOutcome,
  type WebhookOutcomeKind,
} from './domain/value-objects/webhook-outcome';

export {
  asEventId,
  tryEventId,
  asRegistrationId,
  tryRegistrationId,
  asExternalEventId,
  tryExternalEventId,
  asExternalAttendeeId,
  tryExternalAttendeeId,
  asAttendeeEmail,
  tryAttendeeEmail,
  asWebhookSecret,
  tryWebhookSecret,
  asRequestId,
  tryRequestId,
  type EventId,
  type RegistrationId,
  type ExternalEventId,
  type ExternalAttendeeId,
  type AttendeeEmail,
  type WebhookSecret,
  type RequestId,
} from './domain/branded-types';

// --- 2. Domain aggregates ---------------------------------------------------

export { isArchived, type EventAggregate } from './domain/event';

export {
  isPseudonymised,
  type EventRegistrationAggregate,
  type Attendee,
  type MatchResolution,
  type Ticket,
  type QuotaEffect,
} from './domain/event-registration';

export {
  GRACE_WINDOW_MS,
  isGraceSecretActive,
  type TenantWebhookConfigAggregate,
} from './domain/tenant-webhook-config';

// --- 3. Domain pure helpers + zod schemas -----------------------------------

export {
  EventCreatePayloadV1,
  CsvRowSchema,
  EVENT_CANONICAL_KEYS,
  ATTENDEE_CANONICAL_KEYS,
  extractMetadata,
  type CsvRow,
} from './domain/eventcreate-payload';

export { normaliseCompanyName } from './domain/normalise-company-name';

export { levenshtein } from './domain/levenshtein';

export {
  PERSONAL_EMAIL_DOMAINS,
  defaultPersonalEmailDenyList,
  isPersonalEmail,
  type PersonalEmailDenyList,
} from './domain/personal-email-deny-list';

// --- 4. Application port interfaces -----------------------------------------

export type {
  WebhookSignatureVerifier,
  VerifyInput,
  VerifyOutcome,
  VerifySuccess,
  VerifyFailure,
  VerifyFailureKind,
} from './application/ports/webhook-signature-verifier';

export type {
  IdempotencyStore,
  TryInsertReceiptInput,
  TryInsertReceiptResult,
  IdempotencyStoreError,
} from './application/ports/idempotency-store';

export {
  isContactMatch,
} from './application/ports/attendee-matcher';
export type {
  AttendeeMatcher,
  MatchAttendeeInput,
  MatchAttendeeOutput,
  AttendeeMatcherError,
} from './application/ports/attendee-matcher';

export type {
  QuotaAccountingPort,
  PlanAllotments,
  ConsumedQuota,
  QueryAllotmentsInput,
  QuotaAccountingError,
} from './application/ports/quota-accounting-port';

export type {
  EventsRepository,
  UpsertEventInput,
  UpsertEventResult,
  ListEventsInput,
  ListEventsResult,
  EventsListEmptyContext,
  EventsRepositoryError,
} from './application/ports/events-repository';

export type {
  RegistrationsRepository,
  InsertRegistrationInput,
  InsertRegistrationResult,
  ListRegistrationsByEventInput,
  ListRegistrationsByEventResult,
  CountConsumedByMemberInput,
  RegistrationsRepositoryError,
} from './application/ports/registrations-repository';

export type {
  TenantWebhookConfigRepository,
  InsertConfigInput,
  RotateSecretInput,
  TenantWebhookConfigRepositoryError,
} from './application/ports/tenant-webhook-config-repository';

export {
  F6_AUDIT_EVENT_TYPES,
  isF6AuditEventType,
} from './application/ports/audit-port';
export type {
  F6AuditPort,
  F6AuditEventType,
  F6AuditEntry,
  AuditPayloads,
  AuditPayloadFor,
  ActorType,
  AuditEmitError,
  Severity,
} from './application/ports/audit-port';

export type {
  CsvImporter,
  CsvParseInput,
  ParsedRow,
  CsvImporterError,
} from './application/ports/csv-importer';

export type {
  RetentionSweeper,
  PseudonymiseStaleNonMemberInput,
  PseudonymiseStaleNonMemberResult,
  SweepIdempotencyReceiptsInput,
  SweepIdempotencyReceiptsResult,
  RetentionSweeperError,
} from './application/ports/retention-sweeper';
