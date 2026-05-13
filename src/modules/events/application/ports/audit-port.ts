/**
 * `F6AuditPort` Application port (F6).
 *
 * Closed TypeScript union over the 35 F6 audit event types (canonical
 * taxonomy in data-model.md § 4 + contracts/audit-port.md). The discriminated
 * `AuditPayloads` mapped type gives compile-time enforcement that
 * callers pass the correct payload shape for the event they emit —
 * mismatch is a type error.
 *
 * All F6 events default to **5-year retention**. F6 has no tax-document
 * overlap (F4's 10y retention does not apply). The Drizzle adapter
 * (Phase 3 T051) writes to the existing `audit_log` table:
 * - `event_type`     ← `eventType` (enum extended by migration 0132)
 * - `tenant_id`      ← `tenantId`
 * - `actor_user_id`  ← real UUID for human roles; sentinel for
 * system/zapier_webhook/csv_import/cron
 * - `timestamp`      ← `occurredAt`
 * - `retention_years`← 5 (F6 default)
 * - `summary`        ← `summary` (≤500 chars human-readable synopsis)
 * - `payload jsonb`  ← `payload` (canonical structured carrier; severity
 * lives inside the payload object per contract § 0)
 *
 * `emitRolledBack` is a separate-tx emit for FR-037 strict-transactional
 * compliance — invoked AFTER the primary ACID unit rolled back so the
 * audit row commits even when the main work fails. Dual-write fallback:
 * on AuditEmitError, the implementation ALSO writes a `pino.fatal(...)`
 * line to stderr with `audit_secondary_tx_failure: true` so the
 * rollback is never invisible (Vercel Fluid Compute captures stderr
 * even when the DB is unreachable).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { AuditEventId, UserId } from '@/modules/auth';
import type { TenantId, MemberId, ContactId } from '@/modules/members';
import type {
  EventId,
  RegistrationId,
  AttendeeEmail,
} from '../../domain/branded-types';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { ProcessingOutcome } from '../../domain/value-objects/webhook-outcome';
import type { SecretLastFour } from '../../domain/secret-last-four';
import type { RequestId } from '../../domain/branded-types';

// --- Canonical event-type list (35 events, mirrors migration 0132) ---------

export const F6_AUDIT_EVENT_TYPES = [
  // Webhook ingest (8)
  'webhook_receipt_verified',
  'webhook_signature_rejected',
  'webhook_replay_rejected',
  'webhook_duplicate_rejected',
  'webhook_malformed_rejected',
  'webhook_rolled_back',
  'webhook_secret_grace_used',
  'webhook_test_invoked',
  // Match resolution (5)
  'attendee_matched_member_contact',
  'attendee_matched_member_domain',
  'attendee_matched_member_fuzzy',
  'attendee_non_member',
  'attendee_unmatched',
  // Quota effects (5)
  'quota_partnership_decremented',
  'quota_cultural_decremented',
  'quota_credit_back_refund',
  'quota_credit_back_archive',
  'quota_over_quota_warning',
  // Admin actions (10)
  'registration_relinked',
  'event_archived',
  'event_partner_benefit_toggled',
  'event_cultural_event_toggled',
  'webhook_secret_generated',
  'webhook_secret_rotated',
  'webhook_secret_force_expired',
  'ingest_disabled_super_admin',
  'ingest_disabled_tenant_admin',
  'csv_import_completed',
  'csv_import_row_failed',
  // Privacy + compliance (4)
  'pii_erasure_requested',
  'pii_erasure_completed',
  'pii_pseudonymised',
  'pii_pseudonymisation_sweep_run',
  // Security (3)
  'cross_tenant_probe',
  'role_violation_blocked',
  'webhook_rate_limit_exceeded',
  // R6-W5 staff-review fix (2026-05-13): dedicated event type for
  // pre-tx config-load failures so the `webhook_rolled_back` taxonomy
  // stays clean (it now genuinely means "primary tx began then rolled
  // back"). SREs filter on either independently; previously a Neon
  // connection blip during config-load was dumped into the
  // rollback bucket, polluting incident triage. Backed by migration
  // 0137 enum extension.
  'webhook_ingest_precondition_failed',
  // Phase 5 review-fix W-05 reverted (2026-05-13) — reserved-but-
  // unused enum value. Migration 0138 already added this name to the
  // Postgres `audit_event_type` enum; Postgres enum values cannot be
  // dropped without an offline rebuild, so the value remains in the
  // type system + DB schema. The original PDPA §39 / GDPR Art. 30
  // record-of-processing audit was deemed unnecessary in maintainer
  // review (the privacy-notice template + DPIA + W-06 ZAPIER_DPA_
  // EXECUTED boot guard already satisfy the legal record-keeping
  // duty). If a future feature wants to record per-tenant template
  // acknowledgements, the enum slot is available and the AuditPayloads
  // entry below documents the originally-intended shape.
  'wizard_privacy_notice_acknowledged',
] as const;

export type F6AuditEventType = (typeof F6_AUDIT_EVENT_TYPES)[number];

export function isF6AuditEventType(value: unknown): value is F6AuditEventType {
  return (
    typeof value === 'string' &&
    (F6_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

// --- Shared payload primitives ---------------------------------------------

export type Severity = 'info' | 'warn' | 'error' | 'critical';

type FuzzyMatchDetail = {
  readonly attendeeCompanyOriginal: string;
  readonly matchedMemberCompanyNormalised: string;
  readonly levenshteinDistance: number;
};

type QuotaImpact = {
  readonly creditedBackFor: MemberId | null;
  readonly decrementedFor: MemberId | null;
  readonly scopes: ReadonlyArray<'partnership' | 'cultural'>;
};

// --- Discriminated payload map (compile-time shape enforcement) -----------

export interface AuditPayloads {
  // --- Webhook ingest (8) -----------------------------------------------
  webhook_receipt_verified: {
    readonly severity: Severity;
    readonly requestId: string;
    readonly source: 'eventcreate' | 'eventcreate_csv';
    readonly eventExternalId: string;
    readonly attendeeExternalId: string;
    readonly processingOutcome: ProcessingOutcome;
    readonly matchedMemberId: MemberId | null;
    readonly registrationId: RegistrationId;
    readonly eventCreated: boolean;
    readonly ingestLatencyMs: number;
    readonly graceSecretUsed: boolean;
  };
  webhook_signature_rejected: {
    readonly severity: Severity;
    readonly requestId: string | null;
    readonly sourceIp: string;
    readonly signatureLastFour: string | null;
    readonly timestampSkewSeconds: number | null;
    readonly bodyLengthBytes: number;
  };
  webhook_replay_rejected: {
    readonly severity: Severity;
    readonly requestId: string | null;
    readonly sourceIp: string;
    readonly receivedTimestamp: number;
    readonly serverTimestamp: number;
    readonly skewSeconds: number;
  };
  webhook_duplicate_rejected: {
    readonly severity: Severity;
    readonly requestId: string;
    readonly originalProcessedAt: string; // ISO timestamp
    readonly sourceIp: string;
  };
  webhook_malformed_rejected: {
    readonly severity: Severity;
    readonly requestId: string;
    readonly sourceIp: string;
    readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  };
  webhook_rolled_back: {
    readonly severity: Severity;
    readonly requestId: string;
    readonly source: 'eventcreate' | 'eventcreate_csv';
    readonly failureStage:
      | 'event_upsert'
      | 'registration_insert'
      | 'idempotency_receipt'
      | 'quota_decrement'
      | 'audit_emit'
      | 'unknown';
    readonly errorMessage: string;
    readonly errorStack: string | null;
    readonly audit_secondary_tx_failure?: boolean;
  };
  webhook_secret_grace_used: {
    readonly severity: Severity;
    readonly requestId: string;
    readonly graceSecretAgeHours: number;
  };
  webhook_test_invoked: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    /**
     * The synthetic request ID generated by `runTestWebhook` and
     * passed as the `X-Request-ID` header. Round-6 verify-fix
     * 2026-05-13 (type-design C2) — renamed from the bespoke
     * `testRequestId` field to `requestId` so the entire F6 webhook
     * audit family shares one field-name convention; uses the branded
     * `RequestId` type for compile-time safety against accidental
     * widening.
     */
    readonly requestId: RequestId;
    readonly durationMs: number;
    /**
     * Phase 5 review-fix S-05 (2026-05-13) — originator attribution.
     * The audit envelope's `actorType: 'system'` + `actorUserId:
     * 'system:f6-test-webhook'` accurately describe the emitter
     * (receiver-side system context); these two fields surface the
     * tenant admin who dispatched the test. Plumbed via the synthetic
     * payload's `chamberTestMetadata` block — the synthetic payload
     * is HMAC-signed by the admin route only, so a forged
     * `dispatchedByActorRole` would fail signature verification
     * before reaching the short-circuit branch. Drift detection: an
     * audit row with `dispatchedByActorRole !== 'admin'` flags a
     * role-enforcement loosening at the admin route.
     *
     * Both fields default to `null` when the synthetic payload omits
     * `chamberTestMetadata` (legacy payloads from clients pre-S-05).
     */
    readonly dispatchedByActorUserId: UserId | null;
    readonly dispatchedByActorRole: 'admin' | null;
  };

  // --- Match resolution (5) ---------------------------------------------
  attendee_matched_member_contact: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly matchedMemberId: MemberId;
    readonly matchedContactId: ContactId;
    readonly matchedOnEmail: AttendeeEmail;
  };
  attendee_matched_member_domain: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly matchedMemberId: MemberId;
    readonly emailDomain: string;
  };
  attendee_matched_member_fuzzy: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly matchedMemberId: MemberId;
  } & FuzzyMatchDetail;
  attendee_non_member: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly attendeeEmail: AttendeeEmail;
  };
  attendee_unmatched: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly attendeeCompanyOriginal: string;
    readonly candidateMemberIds: ReadonlyArray<MemberId>;
    readonly candidateLevenshteinDistances: ReadonlyArray<number>;
  };

  // --- Quota events (5) -------------------------------------------------
  quota_partnership_decremented: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly eventId: EventId;
    readonly perEventAllotmentBefore: number;
    readonly perEventAllotmentAfter: number;
  };
  quota_cultural_decremented: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly eventId: EventId;
    readonly fiscalYear: number;
    readonly annualAllotmentBefore: number;
    readonly annualAllotmentAfter: number;
  };
  quota_credit_back_refund: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly scope: 'partnership' | 'cultural';
    readonly allotmentAfter: number;
  };
  quota_credit_back_archive: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly scope: 'partnership' | 'cultural';
    readonly allotmentAfter: number;
  };
  quota_over_quota_warning: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly eventId: EventId;
    readonly scope: 'partnership' | 'cultural';
    readonly allotmentAtIngest: 0;
  };

  // --- Admin actions (10) -----------------------------------------------
  registration_relinked: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly registrationId: RegistrationId;
    readonly previousMatchedMemberId: MemberId | null;
    readonly newMatchedMemberId: MemberId | null;
    readonly previousMatchType: MatchType;
    readonly newMatchType: MatchType;
    readonly quotaImpact: QuotaImpact;
  };
  event_archived: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly eventId: EventId;
    readonly registrationsAffected: number;
    readonly quotaReversals: {
      readonly partnership: number;
      readonly cultural: number;
    };
  };
  event_partner_benefit_toggled: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly eventId: EventId;
    readonly flagName: 'is_partner_benefit';
    readonly flagBefore: boolean;
    readonly flagAfter: boolean;
    readonly registrationsReevaluated: number;
  };
  event_cultural_event_toggled: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly eventId: EventId;
    readonly flagName: 'is_cultural_event';
    readonly flagBefore: boolean;
    readonly flagAfter: boolean;
    readonly registrationsReevaluated: number;
  };
  webhook_secret_generated: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    // Round-6 verify-fix 2026-05-13 (type-design C8) — branded
    // `SecretLastFour` enforces `length === 4` at construction. The
    // smart-constructor lives in `domain/secret-last-four.ts`.
    readonly secretLastFour: SecretLastFour;
  };
  webhook_secret_rotated: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    // The `'none'` literal handles the post-fresh-rotation case where
    // there was no prior grace secret (Phase 5 covers this).
    readonly previousSecretLastFour: SecretLastFour | 'none';
    readonly newSecretLastFour: SecretLastFour;
    readonly graceActiveUntil: string; // ISO timestamp
  };
  webhook_secret_force_expired: {
    readonly severity: Severity;
    /**
     * Caller — either a human admin (Phase 5 UI) or `null` for manual
     * ops-script invocations until the UI ships.
     */
    readonly actorUserId: UserId | null;
    /** Number of grace rows cleared (0 if nothing to expire; 1 on success). */
    readonly rowsCleared: number;
    /** Reason captured from the admin UI (Phase 5) or runbook entry. */
    readonly reason: string;
  };
  ingest_disabled_super_admin: {
    readonly severity: Severity;
    readonly actorUserId: UserId | null;
    readonly enabledBefore: boolean;
    readonly enabledAfter: boolean;
    readonly reason: string;
  };
  ingest_disabled_tenant_admin: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly enabledBefore: boolean;
    readonly enabledAfter: boolean;
    readonly reason: string;
  };
  csv_import_completed: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly rowsProcessed: number;
    readonly rowsAlreadyImported: number;
    readonly eventsCreated: number;
    readonly eventsUpdated: number;
    readonly matchCounts: Readonly<Record<MatchType, number>>;
    readonly errorRowCount: number;
    readonly durationMs: number;
  };
  csv_import_row_failed: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly rowNumber: number;
    readonly reason: string;
    readonly rawRowExcerpt: string;
  };

  // --- Privacy + compliance (4) -----------------------------------------
  pii_erasure_requested: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly registrationId: RegistrationId;
    readonly reasonText: string;
    readonly attendeeEmailLastFour: string;
  };
  pii_erasure_completed: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly registrationId: RegistrationId;
    readonly quotaReversals: {
      readonly partnership: number;
      readonly cultural: number;
    };
    readonly completedWithinSecondsOfRequest: number;
  };
  pii_pseudonymised: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly matchTypeAtPseudonymisation: 'non_member' | 'unmatched';
    readonly ageAtSweepDays: number;
    readonly registeredAt: string; // ISO timestamp
  };
  pii_pseudonymisation_sweep_run: {
    readonly severity: Severity;
    readonly rowsScanned: number;
    readonly rowsPseudonymised: number;
    readonly durationMs: number;
    readonly passDate: string; // DD
  };

  // --- Security (3) -----------------------------------------------------
  cross_tenant_probe: {
    readonly severity: Severity;
    readonly probedTenantId: TenantId;
    readonly signedTenantId: TenantId;
    readonly sourceIp: string;
    readonly requestId: string | null;
    readonly attemptedRoute: string;
  };
  role_violation_blocked: {
    readonly severity: Severity;
    /**
     * Nullable to avoid the sentinel all-zeros UUID confusion. When
     * the actor cannot be identified (anonymous session decoded but
     * no user-row resolved), emit `null` instead of
     * `00000000-0000-0000-0000-000000000000` which could be confusable
     * with a real all-zeros UUID in queries.
     */
    readonly actorUserId: UserId | null;
    readonly actorRole: 'manager' | 'member';
    readonly attemptedRoute: string;
    readonly attemptedAction: string;
    readonly blockedAt: 'app_layer' | 'middleware';
  };
  webhook_rate_limit_exceeded: {
    readonly severity: Severity;
    readonly requestId: string | null;
    readonly sourceIp: string;
    readonly currentRpmObserved: number;
    readonly retryAfterSeconds: number;
  };
  /**
   * R6-W5 staff-review fix (2026-05-13). Distinct from `webhook_rolled_back`:
   *   - `webhook_rolled_back` = primary tx began then was rolled back
   *     by a stage failure (FR-037 strict-tx semantics)
   *   - `webhook_ingest_precondition_failed` = a check BEFORE the tx
   *     opened failed — config load DB error, tenant resolution
   *     anomaly, etc. No state change to roll back; documenting the
   *     event separately keeps SRE filtering accurate.
   */
  webhook_ingest_precondition_failed: {
    readonly severity: Severity;
    readonly requestId: string | null;
    readonly sourceIp: string;
    /**
     * Which precondition failed. `config_load_failed` is the only
     * currently-emitting cause; the union is open to future additions
     * (e.g., `tenant_resolution_failed`).
     */
    readonly stage: 'config_load_failed';
    readonly errorName: string;
  };

  /**
   * Phase 5 review-fix W-05 reverted (2026-05-13) — payload shape
   * preserved for documentation + future revival. Audit event is
   * defined in the enum but no emitter ships; consumers should
   * ignore this entry today. See the enum entry above for the full
   * revert rationale.
   */
  wizard_privacy_notice_acknowledged: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly privacyNoticeVersion: string;
    readonly acknowledgedAt: string;
  };
}

export type AuditPayloadFor<T extends F6AuditEventType> = AuditPayloads[T];

// --- Envelope shape --------------------------------------------------------

export type ActorType =
  | 'system'
  | 'admin'
  | 'manager'
  | 'member'
  | 'zapier_webhook'
  | 'csv_import'
  | 'cron';

export interface F6AuditEntry<
  T extends F6AuditEventType = F6AuditEventType,
> {
  readonly eventType: T;
  readonly tenantId: TenantId;
  readonly actorType: ActorType;
  readonly actorUserId: UserId | null;
  readonly occurredAt: Date;
  readonly summary: string; // ≤500 chars human-readable synopsis
  readonly payload: AuditPayloadFor<T>;
}

// --- Port interface --------------------------------------------------------

export type AuditEmitError =
  | { readonly kind: 'db_error'; readonly message: string }
  | {
      readonly kind: 'enum_value_unknown';
      readonly eventType: string;
    };

export interface F6AuditPort {
  /**
   * Emit a single audit row INSIDE the calling tx. Use for normal
   * happy-path + non-rolled-back failure audits (signature rejected,
   * duplicate, malformed, match resolutions, quota events, admin
   * actions, privacy events, security events).
   */
  emit<T extends F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ): Promise<Result<AuditEventId, AuditEmitError>>;

  /**
   * Emit `webhook_rolled_back` in a SEPARATE tx — invoked AFTER the
   * primary ACID unit (FR-037) has rolled back so the audit row
   * commits even though the main work failed. Dual-write fallback:
   * on AuditEmitError, the implementation ALSO writes a `pino.fatal(...)`
   * line to stderr with `audit_secondary_tx_failure: true` so the
   * rollback is never invisible at the observability layer (Vercel
   * Fluid Compute captures stderr even when the DB is unreachable).
   * The pino call is wrapped in try/catch — a stderr write failure
   * does not crash the handler.
   */
  emitRolledBack(
    entry: F6AuditEntry<'webhook_rolled_back'>,
  ): Promise<Result<AuditEventId, AuditEmitError>>;

  /**
   * Generic standalone-tx emit for audit events that are NOT part of
   * a use-case transactional boundary. The route handler uses this
   * for `webhook_signature_rejected` (signature failure short-circuits
   * BEFORE the strict-tx unit starts; we still want a durable
   * forensic trail for the R10 credential-stuffing alert) and for
   * `webhook_rolled_back` from the config-load-failed branch.
   *
   * Implementation pattern: uses its own `db.transaction(...)` like
   * `emitRolledBack` but accepts ANY F6 event type (not narrowed to
   * `webhook_rolled_back`). Same dual-write fallback semantics: on DB
   * failure, emits `pino.fatal(...)` to stdout with
   * `audit_secondary_tx_failure: true` marker.
   */
  emitStandalone<T extends F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ): Promise<Result<AuditEventId, AuditEmitError>>;
}
