/**
 * EventCreate Integration public barrel.
 *
 * Module bootstrapped at `/speckit.implement` Phase 1 (T003) and
 * extended at Phase 2 (T035) with the full Domain + Application port
 * surface. All cross-module access from outside `src/modules/events/`
 * MUST go through this barrel (enforced by `eslint.config.mjs`
 * `no-restricted-imports` rule per Constitution Principle III).
 *
 * Surface organisation:
 * 1. Domain value objects + branded types
 * 2. Domain aggregates (Event / EventRegistration / TenantWebhookConfig)
 * 3. Domain pure helpers (normaliseCompanyName / levenshtein /
 * personal-email-deny-list / payload zod schemas)
 * 4. Application port interfaces (10 ports)
 *
 * Use-case exports are added per phase as they land:
 * - Phase 3 (US1): ingestWebhookAttendee, verifyWebhookSignature,
 * matchAttendeeToMember
 * - Phase 4 (US2): listEvents, loadEventDetail
 * - Phase 5 (US3): generateWebhookSecret, rotateWebhookSecret,
 * runTestWebhook
 * - Phase 6 (US4): applyQuotaEffect, toggleEventCategory
 * - Phase 7 (US5): importCsv
 * - Phase 9 (US6): relinkRegistration
 * - Phase 10: archiveEvent, eraseAttendeePii,
 * pseudonymiseStaleNonMemberPii, getEventAttendeesByMember (F8 port impl)
 *
 * barrel guard rules (L4 ):
 *
 * • RAW Infrastructure adapters (schema.ts Drizzle tables,
 * drizzle-*-repository factories, pino-audit-port, crypto signature
 * verifier instance) MUST NOT be re-exported. Routes and tests
 * consume them indirectly via the composition factories below.
 *
 * • COMPOSITION FACTORIES (`makeStandaloneAuditDeps`,
 * `makeIngestWebhookAttendeeDeps`) ARE intentionally re-exported.
 * They are the documented Presentation→Application seam for F6
 * route handlers; consuming them does NOT leak Drizzle/crypto
 * internals because each factory returns Application-port-shaped
 * dependencies. F5's `stripe-webhook-deps.ts` follows the same
 * pattern at a different layer.
 *
 * • `cryptoWebhookSignatureVerifier` is exported as an Application
 * port impl (the verifier itself is pure-function over the Domain
 * `WebhookSignatureVerifier` port — no Drizzle/Next/React import).
 * Acceptable seam.
 *
 * If a future Phase needs to consume an Infrastructure adapter
 * directly, route the access through a NEW composition factory in
 * `src/modules/events/infrastructure/di.ts` rather than widening this
 * barrel. The factories are the contract; the adapters are details.
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
  QUOTA_COUNTED_STATUSES,
  isPaymentStatus,
  isQuotaCountedStatus,
  type PaymentStatus,
  type QuotaCountedStatus,
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
  asEventIdUnchecked,
  tryEventId,
  tryEventIdUnchecked,
  asRegistrationId,
  asRegistrationIdUnchecked,
  tryRegistrationId,
  tryRegistrationIdUnchecked,
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
  asGraceState,
  GraceStateInvariantError,
  type GraceState,
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

export {
  asLockKey,
  InvalidLockKeyError,
} from './application/ports/advisory-lock-acquirer';
export type {
  AdvisoryLockAcquirer,
  LockKey,
} from './application/ports/advisory-lock-acquirer';

export type {
  EventsRepository,
  UpsertEventInput,
  UpsertEventResult,
  ListEventsInput,
  ListEventsResult,
  EventsListEmptyContext,
  EventMatchCounts,
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

// --- 5. Phase 3 use-case exports --------------------------------------------

export {
  verifyWebhookSignature,
  type VerifyWebhookSignatureInput,
} from './application/use-cases/verify-webhook-signature';

export {
  ingestWebhookAttendee,
  MATCH_TYPE_TO_PROCESSING_OUTCOME,
  type IngestWebhookAttendeeInput,
  type IngestWebhookAttendeeDeps,
  type IngestSuccess,
  type IngestError,
  type FailureStage,
  type TxScopedPorts,
} from './application/use-cases/ingest-webhook-attendee';

export {
  matchAttendeeToMember,
  type MatchAttendeeToMemberDeps,
} from './application/use-cases/match-attendee-to-member';

// --- 5b. Phase 6 use-case exports (US4 benefit quota accounting) ----------

export {
  applyQuotaEffect,
  buildQuotaLockKey,
  NEUTRAL_QUOTA_EFFECT,
  type ApplyQuotaEffectInput,
  type ApplyQuotaEffectOutput,
  type ApplyQuotaEffectError,
  type ApplyQuotaEffectDeps,
} from './application/use-cases/apply-quota-effect';

export {
  toggleEventCategory,
  type ToggleEventCategoryInput,
  type ToggleEventCategoryOutput,
  type ToggleEventCategoryError,
  type ToggleEventCategoryDeps,
  type ToggleFlag,
} from './application/use-cases/toggle-event-category';

export {
  archiveEvent,
  type ArchiveEventInput,
  type ArchiveEventOutput,
  type ArchiveEventError,
  type ArchiveEventDeps,
} from './application/use-cases/archive-event';

export {
  relinkRegistration,
  type RelinkRegistrationInput,
  type RelinkRegistrationOutput,
  type RelinkRegistrationError,
  type RelinkRegistrationDeps,
  type RelinkQuotaImpact,
} from './application/use-cases/relink-registration';

export {
  forceExpireGraceSecret,
  type ForceExpireGraceSecretInput,
  type ForceExpireGraceSecretOutput,
  type ForceExpireGraceSecretError,
  type ForceExpireGraceSecretDeps,
} from './application/use-cases/force-expire-grace-secret';

// --- 6. Phase 4 use-case exports (US2 admin events list+detail) -------------

export {
  listEvents,
  type ListEventsInput as ListEventsUseCaseInput,
  type ListEventsOutput,
  type ListEventsError,
  type ListEventsItem,
  type ListEventsPagination,
  type ListEventsEmptyStateContext,
  type ListEventsDeps,
} from './application/use-cases/list-events';

export {
  loadEventDetail,
  type LoadEventDetailInput,
  type LoadEventDetailOutput,
  type LoadEventDetailError,
  type LoadEventDetailDeps,
  type EventDetailItem,
  type EventDetailRegistration,
  type EventDetailPagination,
} from './application/use-cases/load-event-detail';

// --- 6b. Phase 5 admin wizard use-case exports (US3) ----------------------
// Round-6 verify-fix 2026-05-13 — re-exported via the F6 public barrel
// so cross-module consumers (UI components, API route handlers,
// composition adapter) can import them without tripping the
// `no-restricted-imports` ESLint rule that enforces Principle III.

export {
  generateWebhookSecret,
  type GenerateWebhookSecretInput,
  type GenerateWebhookSecretOutput,
  type GenerateWebhookSecretError,
  type GenerateWebhookSecretDeps,
} from './application/use-cases/generate-webhook-secret';

export {
  rotateWebhookSecret,
  type RotateWebhookSecretInput,
  type RotateWebhookSecretOutput,
  type RotateWebhookSecretError,
  type RotateWebhookSecretDeps,
} from './application/use-cases/rotate-webhook-secret';

export {
  runTestWebhook,
  type RunTestWebhookInput,
  type RunTestWebhookOutcome,
  type RunTestWebhookError,
  type RunTestWebhookDeps,
  type FailureCategory as RunTestWebhookFailureCategory,
  type ProcessingOutcomeLabel as RunTestWebhookProcessingOutcome,
  type SignRequestFn as RunTestWebhookSignRequestFn,
  type HttpFetchFn as RunTestWebhookHttpFetchFn,
} from './application/use-cases/run-test-webhook';

export {
  asSecretLastFour,
  type SecretLastFour,
} from './domain/secret-last-four';

// --- 6d. Phase 10 T120 — F8 EventAttendees bridge -----------------------

export {
  getEventAttendeesByMember,
  type EventAttendanceRecord,
  type ListAttendancesOpts,
  type EventAttendeesQueryPort,
  type GetEventAttendeesByMemberDeps,
} from './application/use-cases/get-event-attendees-by-member';

export {
  drizzleEventAttendeesQuery,
  drizzleEventAttendeesAdapter,
} from './infrastructure/drizzle-event-attendees-by-member';

// --- 6e. Phase 10 T113+T115 — Retention sweeps -----------------------

export {
  pseudonymiseStaleNonMemberPii,
  type PseudonymiseStaleNonMemberPiiInput,
  type PseudonymiseStaleNonMemberPiiOutput,
  type PseudonymiseStaleNonMemberPiiError,
  type PseudonymiseStaleNonMemberPiiDeps,
  type PseudonymisationHasher,
} from './application/use-cases/pseudonymise-stale-non-member-pii';

export {
  sweepStaleIdempotencyReceipts,
  type SweepStaleIdempotencyReceiptsInput,
  type SweepStaleIdempotencyReceiptsOutput,
  type SweepStaleIdempotencyReceiptsError,
  type SweepStaleIdempotencyReceiptsDeps,
  type IdempotencyReceiptsSweepPort,
} from './application/use-cases/sweep-stale-idempotency-receipts';

export { makeDrizzleIdempotencySweepPort } from './infrastructure/drizzle-idempotency-sweep';

// Composition factory — assembles raw Infrastructure deps for the
// pseudonymise-stale-non-member-pii use-case behind the barrel so
// Routes don't reach into `./infrastructure/*` directly (Principle III
// — Clean Architecture barrel rule, enforced by
// tests/unit/architecture/events-barrel.test.ts). The factory takes
// a TenantTx (composed by the caller via `runInTenant`) plus a hasher
// (caller-supplied because the salt lives in env) and returns the
// fully-wired deps object the use-case expects.
import type { TenantTx } from '@/lib/db';
import { makeDrizzleRegistrationsRepository as _makeRegRepo } from './infrastructure/drizzle-registrations-repository';
import { makePinoAuditPort as _makePinoAudit } from './infrastructure/pino-audit-port';
import type {
  PseudonymisationHasher,
  PseudonymiseStaleNonMemberPiiDeps,
} from './application/use-cases/pseudonymise-stale-non-member-pii';

export function makePseudonymiseStaleNonMemberPiiDeps(
  tx: TenantTx,
  hasher: PseudonymisationHasher,
): PseudonymiseStaleNonMemberPiiDeps {
  return {
    registrationsRepo: _makeRegRepo(tx),
    audit: _makePinoAudit(tx),
    hasher,
  };
}

/**
 * Composition factory for the F6 audit port bound to a caller-supplied
 * TenantTx. Replaces the prior practice of `src/lib/events-*-deps.ts`
 * deep-importing `pino-audit-port` from `./infrastructure/pino-audit-port`
 * — those files are ESLint-exempt for the barrel guard, but the
 * deep-import contradicted the barrel JSDoc's stated intent. Lib
 * composition adapters should import this factory instead.
 */
export function makeAuditPortForTenant(
  tx: TenantTx,
): ReturnType<typeof _makePinoAudit> {
  return _makePinoAudit(tx);
}

// --- 7. Infrastructure composition factories (DI surface) -------------------

export {
  makeIngestWebhookAttendeeDeps,
  makeStandaloneAuditDeps,
  makeImportCsvDeps,
  type StandaloneAuditDeps,
} from './infrastructure/di';
export {
  cryptoWebhookSignatureVerifier,
  signWebhookRequest,
} from './infrastructure/crypto-webhook-signature-verifier';

// Phase 7 T094 — CSV import use-case + result surface. Use-case
// reuses the `processAttendeeInTx` shared helper so webhook ↔ CSV
// equivalence (FR-027) is by construction.
export { importCsv } from './application/use-cases/import-csv';
export type {
  ImportCsvDeps,
  ImportCsvInput,
  ImportCsvOutcome,
  ImportCsvTxScopedPorts,
  ImportSummary,
  ImportSummaryErrorRow,
  SelectedEventForImport,
} from './application/use-cases/import-csv';

// F6.1 (Feature 013 · Phase 5 US5) — history listing + signed-URL
// download + TTL sweep use-cases. The route + composition layers in
// `src/lib/events-csv-import-deps.ts` consume these via this barrel.

export {
  asCsvImportRecordId,
  tryCsvImportRecordId,
  type CsvImportRecordId,
} from './domain/csv-import-record-id';

export { listCsvImportRecords } from './application/use-cases/list-csv-import-records';
export type {
  ListCsvImportRecordsInput,
  ListCsvImportRecordsOutput,
  ListCsvImportRecordsRowView,
  ListCsvImportRecordsError,
  ListCsvImportRecordsDeps,
} from './application/use-cases/list-csv-import-records';

export { generateErrorCsvSignedUrl } from './application/use-cases/generate-error-csv-signed-url';
export type {
  GenerateErrorCsvSignedUrlInput,
  GenerateErrorCsvSignedUrlOutcome,
  GenerateErrorCsvSignedUrlDeps,
} from './application/use-cases/generate-error-csv-signed-url';

export { sweepExpiredErrorCsvBlobs } from './application/use-cases/sweep-expired-error-csv-blobs';
export type {
  SweepExpiredErrorCsvBlobsInput,
  SweepExpiredErrorCsvBlobsOutput,
  SweepExpiredErrorCsvBlobsDeps,
} from './application/use-cases/sweep-expired-error-csv-blobs';

export type {
  CsvImportRecordsRepository,
  CsvImportRecordsAdminRepository,
  CsvImportRecordsRepoError,
  CsvImportRecordSummary,
  ListByTenantInput,
  ListByTenantResult,
  PriorImportMatch,
  ExpiredBlobRow,
  InsertCsvImportRecordInput,
  UpdateOutcomeInput,
  SetErrorCsvBlobInput,
  FindByFingerprintInput,
} from './application/ports/csv-import-records-repo';

export type {
  ErrorCsvStore,
  ErrorCsvStoreError,
} from './application/ports/error-csv-store';

// F6.1 Phase 5 US5 — Drizzle + Vercel-Blob adapter factories. Exposed
// at the barrel so `src/lib/events-csv-import-deps.ts` composition
// layer can wire them without reaching directly into infrastructure
// (per Constitution Principle III; `src/lib/**` is the documented
// composition seam).
export {
  makeDrizzleCsvImportRecordsRepository,
  makeDrizzleCsvImportRecordsAdminRepository,
} from './infrastructure/drizzle-csv-import-records-repo';
export { vercelBlobErrorCsvStore } from './infrastructure/vercel-blob-error-csv-store';

// F6.1 (Feature 013 · T026 full impl) — admin-manual event creation.
// Closes the "no way to seed events" gap that EventCreate API-gating
// opened (project_eventcreate_api_gated memory).
export { createEvent } from './application/use-cases/create-event';
export type {
  CreateEventInput,
  CreateEventOutput,
  CreateEventOutcome,
  CreateEventDeps,
  CreateEventTxScopedPorts,
} from './application/use-cases/create-event';

// Re-export auth helpers that composition adapters need without
// reaching deep into the auth barrel.
export { asUserId, type UserId } from '@/modules/auth';
export { asTenantId } from '@/modules/members';

// Phase 5 review-fix S-06 (2026-05-13) — surface the Phase 5
// composition factories through the barrel so
// `src/lib/events-admin-integration-deps.ts` no longer reaches
// directly into `@/modules/events/infrastructure/*` for them. The
// `src/lib/**` ESLint exemption permitted those deep imports, but
// barrel discipline keeps a single import surface (Principle III) +
// makes future adapter swaps (e.g. an alternate Drizzle repo for
// MTA tenant-per-DB) a one-line barrel re-wire instead of an N-line
// grep through every adapter file.
export { makeDrizzleTenantWebhookConfigRepository } from './infrastructure/drizzle-tenant-webhook-config-repository';

// /code-review (2026-05-19 post-ship) — surface the R4-I1
// `safeAuditEmit` Result-helper through the barrel so composition
// adapters in `src/lib/**` (e.g. `events-admin-integration-deps.ts`)
// route raw `audit.emit()` throws through the canonical F6 silent-
// failure guard without reaching into `_helpers/`. Pure Application
// helper — no framework imports (Constitution Principle III).
export { safeAuditEmit } from './application/use-cases/_helpers/safe-audit-emit';
