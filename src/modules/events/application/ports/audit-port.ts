/**
 * `F6AuditPort` Application port (F6).
 *
 * Closed TypeScript union over the **43 F6 audit event types**
 * (canonical taxonomy in data-model.md § 4 + contracts/audit-port.md;
 * enum extended by migrations 0132 + 0137 + 0141 + 0144 + 0150;
 * migration 0138 added a `wizard_privacy_notice_acknowledged` Postgres
 * value that was subsequently removed from the TS surface during
 * round-10 staff review — the DB slot is harmlessly retained, no
 * application code can write to it). The discriminated `AuditPayloads` mapped type
 * gives compile-time enforcement that callers pass the correct
 * payload shape for the event they emit — mismatch is a type error.
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
} from '../../domain/branded-types';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { ProcessingOutcome } from '../../domain/value-objects/webhook-outcome';
import type { SecretLastFour } from '../../domain/secret-last-four';
import type { RequestId } from '../../domain/branded-types';
// /review Full Scope 2026-05-19 — hoisted from the prior inline
// `import('../../domain/value-objects/payment-status').PaymentStatus`
// in the `csv_import_row_state_changed` payload type. The original
// inline-import rationale (avoid pulling domain into port) was a
// false economy: `MatchType` / `ProcessingOutcome` / `SecretLastFour`
// are already imported above, and `PaymentStatus` is a `type` alias
// with zero runtime footprint — top-of-file `import type` is the
// project-wide convention and erased entirely by TS during compile.
import type { PaymentStatus } from '../../domain/value-objects/payment-status';

/**
 * Failure-stage taxonomy emitted as the `failureStage` payload field on
 * `webhook_rolled_back` + `csv_import_row_failed` audits. Canonical source
 * for both audit payloads AND `process-attendee-in-tx.TxStageError.stage`
 * — single declaration prevents drift when a 7th stage is added.
 *
 * `match_attendee` failures roll up to `event_upsert` rather than getting
 * a dedicated stage — match is read-only against F3 and conceptually part
 * of the same atomic ingest boundary as the upsert.
 *
 * `'unknown'` reserved for non-TxStageError throws + batch-tx-abort
 * fan-out where the stage is opaque to the catch site.
 */
export type FailureStage =
  | 'event_upsert'
  | 'registration_insert'
  | 'idempotency_receipt'
  | 'quota_decrement'
  | 'audit_emit'
  | 'unknown';

// --- Canonical event-type list (43 events; migrations 0132 + 0137 + ---
//     0141 + 0144 + 0150; 0138 added `wizard_privacy_notice_acknowledged`
//     enum value retired from TS during round-10 staff review,
//     retained harmlessly in Postgres)

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
  // Admin actions (10) — /review Full Scope 2026-05-19 count fix:
  // the planned `ingest_disabled_super_admin` was dropped at the type-
  // surface tuple (lines 106-109 comment) so the count is 10, not 11.
  'registration_relinked',
  'event_archived',
  'event_partner_benefit_toggled',
  'event_cultural_event_toggled',
  'webhook_secret_generated',
  'webhook_secret_rotated',
  'webhook_secret_force_expired',
  // `ingest_disabled_super_admin` was a planned but never-implemented
  // FR-033 super-admin variant. Per Principle X simplicity, the dead
  // type literal is removed; the Postgres enum value remains in
  // migration 0132 as harmless dead state (no rows reference it).
  'ingest_disabled_tenant_admin',
  'csv_import_completed',
  'csv_import_row_failed',
  // Privacy + compliance (4)
  'pii_erasure_requested',
  'pii_erasure_completed',
  'pii_pseudonymised',
  'pii_pseudonymisation_sweep_run',
  // Security (5) — /review Full Scope 2026-05-19 count fix: section
  // grew to 5 when `webhook_ingest_precondition_failed` was added in
  // R6-W5 (migration 0137), and `event_detail_not_found_probe` in
  // Phase B B2 (migration 0157).
  'cross_tenant_probe',
  // Phase B B2: discriminated event type for legitimate 404 lookups on
  // soft-deleted/archived events, separated from `cross_tenant_probe`
  // so alert rules on the latter don't fire on routine admin traffic.
  // Severity downgraded to 'info' (per payload). Migration 0157 enum.
  'event_detail_not_found_probe',
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
  // F6.1 (Feature 013 · T008) — CSV-import audit event types added in
  // migration 0141. `csv_import_error_csv_downloaded` is wired by the
  // signed-URL route in US5. `csv_import_cross_tenant_probe` is
  // critical-severity per Constitution Principle I clause 4 — emitted
  // by the timing-safe event lookup in route.ts when `event_id`
  // belongs to another tenant + by the signed-URL route's
  // cross-tenant probe path.
  // `csv_import_event_mismatch_overridden` is WARN — emitted by
  // `importCsv` when admin re-submits with `force_proceed=true` to
  // bypass the FR-019b safety net (gives operators visibility into how
  // often the safety net fires + how often admin overrides).
  'csv_import_error_csv_downloaded',
  'csv_import_cross_tenant_probe',
  'csv_import_event_mismatch_overridden',
  // First-time Cancellation row skipped (no prior registration to
  // refund). Severity: 'info' — informational forensic event so
  // support can reconstruct why a row appears in `rowsSkipped`. NOT a
  // security or availability signal; non-blocking on emit failure.
  'csv_import_row_cancelled_no_prior',
  // Per-row state-change audit. Severity: 'info' — admin re-uploaded
  // with a modified Notes column that flipped payment_status; the row
  // was UPDATEd in place. Required for PDPA Art. 30 + GDPR Art. 30
  // traceable processing records on payment-status mutations.
  'csv_import_row_state_changed',
  // F6.1 (Feature 013 · T026 full impl) — admin-manual event creation
  // event. Emitted by `createEvent` use-case when an admin uses the
  // inline-create modal on /admin/events/import. Backed by migration
  // 0144 enum extension (I7 Round 1 fix — was incorrectly cited as
  // 0143 which is the unrelated F4 receipt_pdf_downloaded migration).
  // Severity: 'info' — accountability trail for
  // who seeded which event manually (webhook ingest cannot fire this
  // because the upsert path emits no such event — manual creation is
  // the ONLY surface that fires `event_created`).
  'event_created',
  // NB: migration `0138_f6_wizard_privacy_notice_acknowledged_audit.sql`
  // added a `wizard_privacy_notice_acknowledged` value to the Postgres
  // `audit_event_type` enum during round 9. The TS surface for that
  // event was removed in round 10 staff review (W-R10-02) after the
  // W-05 use-case was reverted — the privacy-notice template +
  // DPIA + W-06 `ZAPIER_DPA_EXECUTED` boot guard already cover the
  // PDPA §39 / GDPR Art. 30 record-keeping duty. Postgres enum
  // values cannot be dropped without an offline rebuild so the DB
  // keeps the slot harmlessly; no application code can write to it
  // (TS enum type no longer includes the variant).
  // 059-membership-suspension Task 17 — alert-only observability event.
  // Emitted when the CSV importer records attendance for a matched
  // member whose F8 benefit-access is suspended/terminated. Never
  // blocks the import. Migration 0248 enum extension.
  'event_attendance_by_suspended_member',
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
    readonly failureStage: FailureStage;
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
    // PDPA/GDPR data-minimisation (S1-P1-11): store the email DOMAIN only, not
    // the raw attendee email. Domain is enough to confirm match type.
    readonly matchedOnEmailDomain: string;
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
    // PDPA/GDPR data-minimisation (S1-P0-1): store a SHA-256 hex prefix (16
    // chars) of the attendee email, NOT the raw address. PII-safe correlator
    // across events; no raw email ever lands in the audit_log payload.
    readonly attendeeEmailHash: string;
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
    /**
     * R6 PERF-05 closure — F2 plan tier slug for OTel counter
     * `plan_tier` label. Nullable; legacy data or non-tiered plans
     * emit null and the counter falls back to `plan_tier='unknown'`.
     */
    readonly planTier?: string | null;
  };
  quota_cultural_decremented: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly memberId: MemberId;
    readonly eventId: EventId;
    readonly fiscalYear: number;
    readonly annualAllotmentBefore: number;
    readonly annualAllotmentAfter: number;
    /** R6 PERF-05 closure — see `quota_partnership_decremented.planTier`. */
    readonly planTier?: string | null;
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
    /**
     * Staff-review H-1 (2026-05-16): subset of `rowsProcessed`
     * whose state actually changed on a re-upload (Notes-driven
     * payment flip, Attending→Cancelled, etc.). Optional for
     * backward-compatibility with pre-H-1 audit rows (interpret
     * absent as 0 in analytics queries).
     */
    readonly rowsStateChanged?: number;
    readonly eventsCreated: number;
    readonly eventsUpdated: number;
    readonly matchCounts: Readonly<Record<MatchType, number>>;
    readonly errorRowCount: number;
    readonly durationMs: number;
    /**
     * True when the import returned `{kind:'timeout'}` — partial commit
     * was preserved (idempotency makes re-upload safe) but the budget
     * tripped before all batches drained. Counters reflect only the
     * partial work. Default false on full-completion imports keeps the
     * field optional in the existing audit log so existing rows are
     * forward-compatible.
     */
    readonly timedOut?: boolean;
    /**
     * F6.1 (Feature 013 · Q5/R2) — adapter detection result. Optional
     * for backward-compatibility with Phase 7 audit rows (interpreted as
     * `generic_csv` for analytics purposes when absent — Phase 7 did
     * not have an EventCreate adapter).
     */
    readonly sourceFormat?: 'eventcreate_csv' | 'generic_csv';
  };
  csv_import_row_failed: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly rowNumber: number;
    readonly reason: string;
    readonly rawRowExcerpt: string;
    /**
     * Failure-stage taxonomy from `processAttendeeInTx` — same canonical
     * union as `webhook_rolled_back.failureStage`. SRE dashboards alert
     * on `audit_emit` failures (security-critical forensic gap)
     * separately from routine validation paths.
     */
    readonly failureStage: FailureStage;
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

  // --- Security (5) ----------------------------------------------------
  // /review Full Scope 2026-05-19 count fix — matches the tuple-side
  // section header above (line 118).
  cross_tenant_probe: {
    readonly severity: Severity;
    readonly probedTenantId: TenantId;
    readonly signedTenantId: TenantId;
    readonly sourceIp: string;
    readonly requestId: string | null;
    readonly attemptedRoute: string;
  };
  /**
   * Phase B B2 — discriminated form of the legitimate-404 case. The
   * admin event-detail route emits this instead of `cross_tenant_probe`
   * when an event isn't found in the caller's tenant scope. Severity
   * 'info' since soft-deleted/archived event lookups are routine; SRE
   * alerts continue to fire only on the high-severity
   * `cross_tenant_probe` for confirmed cross-tenant signal.
   */
  event_detail_not_found_probe: {
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

  // --- F6.1 (Feature 013) CSV-import audit events (6) -------------------
  //
  // Source-of-truth contract: specs/013-csv-import-eventcreate-format/
  // contracts/audit-port.md. Postgres enum extended in migrations:
  //   0141 — csv_import_error_csv_downloaded + csv_import_cross_tenant_probe
  //          + csv_import_event_mismatch_overridden (3 originals)
  //   0144 — event_created (admin-manual seed via inline-create modal)
  //   0150 — csv_import_row_state_changed + csv_import_row_cancelled_no_prior
  // All 6 use the F6 default 5-year retention (no tax-document overlap).

  /**
   * Emitted on every successful signed-URL generation in
   * `GET /api/admin/events/import/{recordId}/error-csv` (US5 route).
   * PDPA / GDPR audit trail for any PII access —
   * the error CSV contains attendee emails + names + companies, even
   * though admin already had access via the original upload. The
   * re-download is a discrete access event auditors expect to see.
   *
   * Severity: `info` — logged for accountability, not alerting.
   */
  csv_import_error_csv_downloaded: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly recordId: string;
    readonly downloadedAt: Date;
    /** First hop from X-Forwarded-For. */
    readonly sourceIp: string;
  };

  /**
   * Emitted when an admin probes a `csv_import_records.record_id` or an
   * `events.event_id` that belongs to a different tenant. Constitution
   * Principle I clause 4 — HIGH-severity security event. SRE alerts on
   * `rate > 0`. The audit row enables the security team to trace which
   * admin / which IP / which timestamps, basis for further investigation
   * if a pattern emerges.
   *
   * Two probe surfaces share this event type:
   *   - POST /api/admin/events/import — `event_id` form field belongs
   *     to another tenant (route handler T023 emits via standalone tx).
   *   - GET /api/admin/events/import/{recordId}/error-csv — `recordId`
   *     belongs to another tenant (US5).
   */
  csv_import_cross_tenant_probe: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    /**
     * The probed identifier that belongs to another tenant. May be
     * either a `record_id` (signed-URL surface) or an `event_id`
     * (import surface) depending on which probe path fired.
     */
    readonly probedId: string;
    /** Which surface caught the probe — for SRE dashboard filtering. */
    readonly probeSurface: 'import_event_id' | 'error_csv_record_id';
    readonly sourceIp: string;
    readonly probedAt: Date;
  };

  /**
   * Emitted when an admin overrides the FR-019b event-mismatch warning
   * by re-submitting the upload form with `force_proceed=true`. Provides
   * forensic trail for the case where the safety net was triggered but
   * the admin proceeded anyway. Feeds the tuning decision on whether to
   * tighten the 30-day window, raise warning prominence, or relax.
   *
   * Severity: `warn` — admin override of a safety prompt, not a
   * security event but worth elevated visibility for post-launch tuning.
   */
  csv_import_event_mismatch_overridden: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    /** The new import record just committed after override. */
    readonly recordId: string;
    /** Event the admin chose to import to. */
    readonly currentEventId: EventId;
    /** Prior matching imports that triggered the warning. */
    readonly priorRecordIds: ReadonlyArray<string>;
    /** Events those prior imports targeted (parallel to priorRecordIds). */
    readonly priorEventIds: ReadonlyArray<EventId>;
    readonly overriddenAt: Date;
  };

  /**
   * F6.1 (Feature 013 · T026 full impl) — admin manually created an
   * event via the /admin/events/import inline-create modal. Closes the
   * "no way to seed events" gap that EventCreate API-gating opened
   * (project_eventcreate_api_gated memory).
   *
   * Severity: 'info' — operational accountability, not security.
   * Emitted AFTER `eventsRepo.upsert` returns eventCreated=true.
   */
  event_created: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly eventId: EventId;
    readonly externalId: string;
    readonly source: 'admin_manual';
    readonly name: string;
    readonly startDate: Date;
    readonly category: string | null;
  };

  /**
   * First-time Cancellation row skipped
   * (no prior registration to refund). Severity: 'info'. Lets
   * support reconstruct WHY rows appear in `rowsSkipped` without the
   * EventCreate Status-filter pretext (which uses a different "Skipped:
   * Status=..." reason string in the errorRows summary).
   */
  csv_import_row_cancelled_no_prior: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly rowNumber: number;
    /** SHA-256 hex prefix of attendee_email_lower (≤16 chars) — PII-safe correlator. */
    readonly attendeeEmailHash: string;
  };

  /**
   * Per-row
   * state-change audit. Emitted by `maybeApplyStateChange` when a
   * re-uploaded receipt-duplicate row's Notes column flipped the
   * payment_status enum. PDPA Art. 30 + GDPR Art. 30 traceable
   * processing-records requirement for personal-data mutations on
   * existing registrations.
   *
   * Severity: 'info' — accountability log, not alerting.
   */
  csv_import_row_state_changed: {
    readonly severity: Severity;
    readonly actorUserId: UserId;
    readonly rowNumber: number;
    readonly registrationId: RegistrationId;
    /**
     * Typed `PaymentStatus` brand instead of raw `string` so the
     * closed-set guarantee survives audit consumers (dashboard
     * renderers, GDPR exports). `PaymentStatus` is hoisted to the
     * top-of-file `import type` block per /review Full Scope
     * 2026-05-19 — consistent with `MatchType` / `ProcessingOutcome` /
     * `SecretLastFour` already imported there. `import type` is
     * fully erased by TS so there is no runtime cost.
     */
    readonly previousPaymentStatus: PaymentStatus;
    readonly newPaymentStatus: PaymentStatus;
    readonly rowHash: string;
  };

  /**
   * 059-membership-suspension Task 17 — alert-only observability event.
   * Emitted when the CSV importer matches an attendee row to a member
   * whose F8 benefit-access state (`deriveMembershipAccess`) is
   * `suspended` or `terminated`. The attendance row is recorded NORMALLY
   * regardless — F6 never blocks on membership state (the event already
   * happened by the time an admin uploads the CSV, and F6 event
   * benefits are fulfilled externally, so there is nothing to gate
   * here). This event exists purely so staff can see, after the fact,
   * that a non-full-access member attended.
   *
   * Severity: `warn` — worth staff attention, not a security/availability
   * signal. Emitted from inside the row's SAVEPOINT via `ports.audit.emit`
   * on a best-effort basis: a failure here is logged but never rolls back
   * the already-committed registration (the import-result
   * `suspendedMemberWarnings` chip is the primary signal; this audit row
   * is a secondary forensic trail, same tier as
   * `csv_import_row_cancelled_no_prior`).
   */
  event_attendance_by_suspended_member: {
    readonly severity: Severity;
    readonly registrationId: RegistrationId;
    readonly matchedMemberId: MemberId;
    readonly accessState: 'suspended' | 'terminated';
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

  /**
   * Phase 10 T110 — idempotency probe for the `eraseAttendeePii` use-case.
   *
   * Returns `true` if a `pii_erasure_completed` audit row exists for
   * the given `(tenantId, registrationId)` pair. The use-case calls this
   * when `findById(registrationId)` returns null, distinguishing
   * "registration was previously erased" (return `Result.ok({alreadyErased:
   * true})`) from "registration never existed" (return `Result.err({kind:
   * 'registration_not_found'})`).
   *
   * Query shape:
   *   SELECT 1 FROM audit_log
   *   WHERE tenant_id = $1
   *     AND event_type = 'pii_erasure_completed'
   *     AND payload->>'registrationId' = $2
   *   LIMIT 1
   *
   * Uses the same `AuditEmitError` discriminator for return-error symmetry
   * with the emit methods — wraps Postgres-level read failures into the
   * `db_error` variant. The use-case treats this as a hard error (rolls
   * back the tx + returns `audit_emit_failed`) per the strict-tx ACID
   * invariant of FR-037.
   */
  findPriorErasureCompletion(
    tenantId: TenantId,
    registrationId: RegistrationId,
  ): Promise<Result<boolean, AuditEmitError>>;
}
