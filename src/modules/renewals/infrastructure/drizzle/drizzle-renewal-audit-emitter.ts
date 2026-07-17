/**
 * Drizzle adapter for F8 `RenewalAuditEmitter`.
 *
 * Persists F8 events to F1's `audit_log` for event types present in
 * the `audit_event_type` pgEnum (see `F8_ENUM_SHIPPED` below — the
 * canonical runtime list, kept in sync with enum-extension migrations).
 * Events outside that set fall through to pino-logging via
 * `pinoFallback` and loud-fail in production so a misconfigured emit
 * site never silently drops audit data.
 *
 * Behaviour:
 *   - `emit(event, ctx)`: own runInTenant tx; never throws to caller
 *     (fire-and-forget; probe audits depend on this contract).
 *   - `emitInTx(tx, event, ctx)`: writes inside supplied tx so state
 *     + audit commit atomically (Constitution Principle VIII).
 *
 * NULL `retention_years` lets the DB trigger apply the F8 default of
 * 5 years — we don't override.
 */
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import {
  isF8AuditEventType,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditEventType,
  type RenewalAuditEmitter,
} from '../../application/ports/renewal-audit-emitter';
import type { AuditLogInsert } from '@/modules/auth/infrastructure/db/schema';

/**
 * F8 event types whose pgEnum value exists today. Each entry MUST
 * have a corresponding `ALTER TYPE "audit_event_type" ADD VALUE` in a
 * shipped migration. Events not in this set fall through to pino-
 * logging (loud-fail in production).
 *
 * Migration 0099 ships the 4 events emitted by Phase 3 use-cases:
 *   - `renewal_cycle_cancelled`            (cancel-cycle.ts)
 *   - `renewal_cycle_completed_offline`    (mark-paid-offline.ts)
 *   - `renewal_cross_tenant_probe`         (3 use-cases probe path)
 *   - `f8_role_violation_blocked`          (renewals-route-helpers)
 *   - `renewal_schedule_policy_updated`    (update-schedule-policy.ts —
 *                                           Phase 4 Wave I1a, migration 0101)
 *   - `escalation_task_completed`          (reset-email-unverified.ts —
 *                                           Phase 4 Wave I2b, migration 0102;
 *                                           also emitted by Wave I8+ admin
 *                                           task-queue UI)
 *   - 8 dispatcher events                   (dispatch-one-cycle.ts —
 *                                           Phase 4 Wave I2c, migration 0103):
 *       - `renewal_reminder_sent`
 *       - `renewal_reminder_skipped`
 *       - `renewal_reminder_send_failed`
 *       - `renewal_reminder_send_failed_permanent`
 *       - `renewal_reminder_retried` (emitted by `retry-failed-reminders.ts`)
 *       - `renewal_reminder_deferred_read_only`
 *       - `renewal_skipped_no_joined_at`
 *       - `escalation_task_created` (also second emit site = task channel)
 *
 * `renewal_cycle_created` SHIPPED in F8-completion slice 1 — emitted
 * by the shared `createCycleInTx` helper (consumed by the on-paid
 * next-cycle callback, the member import, and the create-member
 * onboarding listener). It was a WHITELIST MOVE (deferred→shipped) — no
 * ADD VALUE migration was needed because the pgEnum value already
 * existed from migration 0109.
 */
const F8_ENUM_SHIPPED_TUPLE = [
  // --- 059-membership-suspension Task 8 — lapsed-portal-scope forensic
  // events. Migration ships the 2 pgEnum values alongside the real emit
  // sites in `src/lib/lapsed-portal-scope.ts` `checkPortalAccess` (the
  // suspended-block branch + the fail-open branch), so both are SHIPPED
  // from day one — no deferred window.
  'membership_suspended_action_blocked',
  'membership_access_fail_open',
  // --- 059-membership-suspension Task 13 (migration 0247) — F8 →F4
  // `InvoiceDueBridge` credit-window guard. The real emit site lands in
  // this same commit (`lapse-cycles-on-grace-expiry.ts` `processOne`),
  // so SHIPPED from day one — no deferred window.
  'renewal_lapse_deferred_invoice_not_due',
  // --- F8-completion slice 2 — T-0 payability flip emit site -----------
  // Migration 0215 adds the pgEnum value. Emit sites:
  //   - enter-awaiting-payment-on-expiry.ts (T-0 cron, source:'cron')
  //   - confirm-renewal.ts (lazy self-transition, slice 2.5, source:'confirm')
  // Shipped (not deferred) because the slice-2 cron emits it today.
  'renewal_entered_awaiting_payment',
  // --- F8-completion slice 1 — shared createCycleInTx emit site --------
  'renewal_cycle_created',
  'renewal_cycle_cancelled',
  'renewal_cycle_completed_offline',
  'renewal_cross_tenant_probe',
  'f8_role_violation_blocked',
  'renewal_schedule_policy_updated',
  'escalation_task_completed',
  'renewal_reminder_sent',
  'renewal_reminder_skipped',
  'renewal_reminder_send_failed',
  'renewal_reminder_send_failed_permanent',
  'renewal_reminder_retried',
  'renewal_reminder_deferred_read_only',
  'renewal_skipped_no_joined_at',
  'escalation_task_created',
  // --- Wave I2d (migration 0104) ----------------------------------------
  'member_email_unverified_threshold_crossed',
  // --- Wave I5 (migration 0107) -----------------------------------------
  'cron_dispatch_orchestrated',
  // --- Phase 5 Wave A.5 US3 emit sites (T120) ----------------------------
  // Migration 0109 adds 21 enum values to the DB so future Phase 5 tasks
  // can emit without a per-task migration. F8_ENUM_SHIPPED only lists
  // values whose emit site EXISTS in code today.
  'renewal_token_invalid',
  'renewal_token_clicked_on_completed_cycle',
  'renewal_self_service_initiated',
  // --- Phase 5 Wave A US3 emit sites (T135 + T136) -----------------------
  // T135 block/unblock-auto-reactivation use-cases emit on actual flag
  // change (idempotent re-toggle skips the audit row). T136 emits on
  // pending → completed admin approval transition.
  'member_auto_reactivation_blocked',
  'member_auto_reactivation_unblocked',
  'lapsed_member_admin_reactivated',
  // --- Phase 5 Wave A.5 US3 emit sites (T137) ---------------------------
  // T137 admin-reject-reactivation transitions pending → cancelled with
  // closed_reason='admin_rejected_with_refund' + cascades F5 refund +
  // F4 credit-note via the F5RefundBridge port. Audit payload carries
  // the credit-note ID for forensic chain (null when no payment to
  // refund). Companion T138 reuses the same emit site for cron-driven
  // 30-day auto-timeout cancellations (different actor=cron / null userId).
  'lapsed_member_admin_reactivation_rejected',
  // --- Phase 5 Wave B US3 emit sites (T123 + T138) ----------------------
  // T123 markCycleCompleteFromInvoicePaid emits `renewal_completed`
  // (default auto-complete) or `renewal_completed_post_lapse` (admin-
  // blocked → held in pending_admin_reactivation). T138 cron emits the
  // 3 reminder ladder events + the timed_out cancel event.
  'renewal_completed',
  'renewal_completed_post_lapse',
  'lapsed_member_admin_reactivation_timed_out',
  'lapsed_member_admin_reactivation_reminder_t-7',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-1',
  // --- Phase 5 Wave B US3 emit sites (T122 confirm-renewal) -------------
  // confirm-renewal emits `renewal_invoice_created` on every successful
  // F4 invoice issue, plus `renewal_with_plan_change` +
  // `renewal_cycle_price_frozen` when the optional plan-change branch
  // fires (FR-021b atomic frozen-price update).
  'renewal_invoice_created',
  'renewal_with_plan_change',
  'renewal_cycle_price_frozen',
  // --- Phase 5 Wave K24 US3 emit site (T115a lapseCyclesOnGraceExpiry) ---
  // Daily cron transitions awaiting_payment → lapsed once
  // `expires_at + grace_period_days < now`. Decision branch picks
  // `closed_reason='grace_expired'` (zero F5 failed attempts) vs
  // `payment_failed` (>=1 F5 row with status='failed'). Typed payload
  // carries `closed_reason` discriminant + `failed_payment_attempts`
  // forensic count. pgEnum value 'renewal_lapsed' was added in F8 phase
  // setup migrations (Phase 1-2); no new ADD VALUE migration needed.
  'renewal_lapsed',
  // --- Phase 6 Wave F US4 emit sites (T154-T156, T161) -----------------
  // Migration 0111 adds these 6 enum values to the DB so the Phase 6
  // at-risk surfaces persist their audits instead of falling through
  // to pino. All 6 events were already in the F8_AUDIT_EVENT_TYPES
  // const tuple (count 59 unchanged) per Phase 2 Wave A2.
  'at_risk_score_recomputed',
  'at_risk_score_threshold_crossed',
  'at_risk_snoozed',
  'at_risk_outreach_recorded',
  'at_risk_skipped_below_min_tenure',
  'at_risk_compute_partial_failure',
  // --- Phase 6 review-round close (migration 0112) ----------------------
  // Emitted from 4 cron routes since Wave I5 / Phase 6 Wave C but the
  // pgEnum value was never added — every emit fell through to
  // pinoFallback, silently dropping the security audit.
  'cron_bearer_auth_rejected',
  // --- Phase 5 Wave A.5 / Round 4 whitelist close (migration 0109) ------
  // These 3 values were added to the pgEnum in migration 0109 (Phase 5
  // US3 batch) but were never added to F8_ENUM_SHIPPED. In production,
  // every emit of these event types fell through to pinoFallback which
  // throws (production guard), crashing the request and silently
  // dropping the audit row — a Constitution Principle I clause 4 and
  // Principle VIII compliance gap.
  //
  // `renewal_kill_switch_blocked` — emitted from
  //   `src/app/api/admin/renewals/route.ts:66` on FEATURE_F8_RENEWALS=false.
  //
  // `lapsed_member_action_blocked` — emitted from
  //   `src/lib/lapsed-portal-scope.ts` `emitBlockedAudit` on every
  //   lapsed-member portal-route block (FR-005a scope enforcement).
  //   Function-name reference (not line number) so the comment
  //   survives same-round insertions that shift the file.
  //
  // `renewal_cross_member_probe` — emitted from
  //   `confirm-renewal.ts:153` + `load-renewal-summary.ts:169` when
  //   the URL [memberId] does not match the session member_id
  //   (Constitution Principle I cross-member isolation).
  'renewal_kill_switch_blocked',
  'lapsed_member_action_blocked',
  'renewal_cross_member_probe',
  // --- F8 Phase 7 (migration 0116) — 11 tier-upgrade events for
  //     User Story 5 (Auto Tier-Upgrade Suggestions). Emit sites:
  //     T179 evaluate-tier-upgrade (cron) · T180 accept · T181 dismiss ·
  //     T183 apply-pending (F4 invoice-paid hook) · T184 supersede
  //     listener · T185 reconcile-pending-applications. Spec FR-037..
  //     FR-042 + research.md R7 pending lifecycle. ---
  'tier_upgrade_suggested',
  'tier_upgrade_accepted',
  'tier_upgrade_pending_member_notified',
  'tier_upgrade_pending_admin_verification_due',
  'tier_upgrade_applied_at_renewal',
  'tier_upgrade_pending_superseded_by_manual_change',
  'tier_upgrade_dismissed',
  'tier_upgrade_already_at_target',
  'tier_upgrade_tenant_disabled',
  'tier_upgrade_skipped_no_thresholds_configured',
  'tier_upgrade_pending_orphan_detected',
  // --- F8 Phase 7 T188a (migration 0118) — `renewal_schedule_rescheduled`
  //     emitted by F2 → F8 plan-change listener when tier-bucket diff
  //     causes a schedule change. ---
  'renewal_schedule_rescheduled',
  // --- F8 Phase 7 review-fix Round 1 (migration 0119) — 3 silent-skip
  //     events that close audit-chain gaps surfaced by /speckit.review.
  //     Emit sites: accept-tier-upgrade.ts (notify-skipped + notify-
  //     failed) + reschedule-on-plan-change.ts (reschedule-skipped). ---
  'tier_upgrade_pending_member_notify_skipped',
  'tier_upgrade_pending_member_notify_failed',
  'renewal_schedule_reschedule_skipped',
  // --- F8 Phase 7 review-fix Round 2 (migration 0120) — 2 silent-failure
  //     closure events. Emit sites: drizzle-plan-catalog.ts (catalogue-
  //     row-dropped) + renewals-deps.ts (apply-post-paid-failed).
  //     IMP-9 fix also moves `tier_upgrade_already_at_target` from the
  //     "deferred" intuition into actually-emitted by aligning evaluate-
  //     tier-upgrade with its JSDoc claim — that event was already
  //     declared in F8_ENUM_SHIPPED_TUPLE since Phase 7 baseline. ---
  'tier_upgrade_catalogue_row_dropped',
  'tier_upgrade_apply_post_invoice_paid_failed',
  // --- F8 Phase 8 T213 (migration 0121) — escalation-task lifecycle ----
  // Phase 4 (migration 0102) shipped `escalation_task_completed` for the
  // webhook-driven reset-email-unverified close path. Phase 8 ships the
  // admin Done/Skip/Reassign surfaces (T209/T210/T211 use-cases) so the
  // remaining 2 enum values graduate from `_F8_ENUM_DEFERRED` here.
  'escalation_task_skipped',
  'escalation_task_reassigned',
  // --- Renewal rolling-anchor refactor (migration 0238) -----------------
  // GRADUATED from `_F8_ENUM_DEFERRED` when the first emit sites shipped
  // (Task 5): `resolveUnlinkedMembershipPaymentInTx`'s heal_no_cycle +
  // first_payment branches. WHITELIST MOVE only — the pgEnum value shipped
  // in migration 0238 alongside the anchor columns.
  'renewal_cycle_reanchored',
  // --- 066-renewal-swecham-round2 §4.4(2) — SHIPPED from day one: the emit
  //     sites (resolve-unlinked terminal_only + mark-cycle-complete
  //     linked-terminal skip) land in the SAME branch (Task 9). ---
  'payment_on_terminated_member',
] as const satisfies ReadonlyArray<F8AuditEventType>;

const F8_ENUM_SHIPPED: ReadonlySet<F8AuditEventType> = new Set(
  F8_ENUM_SHIPPED_TUPLE,
);

/**
 * Round-4 review-finding C1 (compile-time exhaustiveness): every event
 * type in the catalogue (`F8_AUDIT_EVENT_TYPES`) must be EXPLICITLY
 * categorised as either shipped (in `F8_ENUM_SHIPPED` above) OR
 * deferred (in `F8_ENUM_DEFERRED` below). The exhaustiveness check at
 * the bottom errors at typecheck if a future event type is added to
 * the catalogue without categorisation here.
 *
 * Round-4 surfaced the failure mode this guards against: 3 event
 * types had pgEnum values + emit sites in production code but were
 * silently absent from the whitelist; every emit crashed the request
 * and dropped the audit row. The Set-of-strings shape used pre-round-4
 * had no compile-time signal — drift was only caught by integration
 * tests, which most of these emits did not have.
 */
// `_` prefix because the tuple is consumed only by the type-level
// exhaustiveness assertion below (`typeof _F8_ENUM_DEFERRED`); ESLint
// `no-unused-vars` ignores `_`-prefixed identifiers.
const _F8_ENUM_DEFERRED = [
  // `renewal_cycle_created` GRADUATED to F8_ENUM_SHIPPED_TUPLE in
  // F8-completion slice 1 (shared createCycleInTx emit site; whitelist
  // MOVE, no migration — pgEnum value already in migration 0109).
  // F8 Phase 7 tier-upgrade-suggestion event types — MOVED to
  // F8_ENUM_SHIPPED_TUPLE in Phase 7 (T179-T185). Migration 0116
  // adds the matching pgEnum values. The audit emit sites land in
  // the 8 use-cases under `src/modules/renewals/application/use-cases/`.
  // F8 Phase 8 T213 — `escalation_task_skipped` + `_reassigned`
  // graduated to F8_ENUM_SHIPPED_TUPLE (migration 0121) when the
  // admin Done/Skip/Reassign surfaces shipped (T209/T210/T211 use-
  // cases). Forward-compat hold removed.
  // Reserved for the `renewal_payment_failed` audit on F5 webhook
  // payment_intent.payment_failed → mark_paid_offline cancel path
  // (Phase 5 Wave B follow-up; current path emits at the F4 layer).
  // `renewal_schedule_rescheduled` graduated to F8_ENUM_SHIPPED_TUPLE
  // at Phase 7 verify-fix (migration 0118).
  // `renewal_cycle_reanchored` GRADUATED to F8_ENUM_SHIPPED_TUPLE when
  // its first emit sites shipped (rolling-anchor Task 5 —
  // `resolveUnlinkedMembershipPaymentInTx`); pgEnum value from
  // migration 0238.
  'renewal_payment_failed',
] as const satisfies ReadonlyArray<F8AuditEventType>;

// Compile-time exhaustiveness: every catalogue entry must be in EITHER
// the shipped or deferred tuple. If a future commit adds an event type
// to F8_AUDIT_EVENT_TYPES without categorising it here, this assignment
// errors at typecheck — the developer is forced to make an explicit
// shipped-vs-deferred decision (the same drift mode that round-4 found).
type _F8ShippedOrDeferred =
  | (typeof F8_ENUM_SHIPPED_TUPLE)[number]
  | (typeof _F8_ENUM_DEFERRED)[number];
// Both directions to catch typos in either tuple:
//   - `_AssertEveryEventCategorised` errors if catalogue has an
//     event type missing from shipped+deferred (the ROUND-4 BUG).
//   - `_AssertNoStrayCategorisation` errors if shipped+deferred has
//     an event type not in the catalogue (TYPO in this file).
type _AssertEveryEventCategorised =
  Exclude<F8AuditEventType, _F8ShippedOrDeferred> extends never
    ? true
    : ['F8 audit event type missing from F8_ENUM_SHIPPED OR F8_ENUM_DEFERRED:', Exclude<F8AuditEventType, _F8ShippedOrDeferred>];
type _AssertNoStrayCategorisation =
  Exclude<_F8ShippedOrDeferred, F8AuditEventType> extends never
    ? true
    : ['Stray entry in F8_ENUM_SHIPPED or F8_ENUM_DEFERRED not in F8_AUDIT_EVENT_TYPES:', Exclude<_F8ShippedOrDeferred, F8AuditEventType>];
const _f8ShippedOrDeferredAssertion: _AssertEveryEventCategorised = true;
const _f8NoStrayCategorisationAssertion: _AssertNoStrayCategorisation = true;
void _f8ShippedOrDeferredAssertion;
void _f8NoStrayCategorisationAssertion;

function buildSummary<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): string {
  const base = ctx.summary?.trim();
  if (base && base.length > 0) {
    return base.slice(0, 500);
  }
  // Default summary mirrors F4 audit-adapter convention.
  return `F8 ${event.type} (tenant=${ctx.tenantId})`.slice(0, 500);
}

/**
 * Defensive `Object.keys` for audit payloads. `Object.keys(null)` and
 * `Object.keys(undefined)` throw TypeError; the audit-emit catch path
 * MUST NOT throw inside its own diagnostic logging or it masks the
 * original signal. Returns `[]` for null/undefined/non-object payloads.
 */
function payloadKeysOf(payload: unknown): readonly string[] {
  if (payload == null || typeof payload !== 'object') return [];
  return Object.keys(payload as Record<string, unknown>);
}

function pinoFallback<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
  reason: 'not_in_pgenum' | 'unknown_event_type',
): void {
  // Production guard — same property the stub asserts. F8 ships dark
  // behind FEATURE_F8_RENEWALS=false until MVP-wide go-live; if we ever
  // emit a non-enum event in production the audit-trail invariant
  // (Principle VIII) silently breaks.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `F8 audit emit fell through to pino in production (event=${event.type}, reason=${reason}). ` +
        'Add the event to the audit_event_type pgEnum migration before flipping FEATURE_F8_RENEWALS=true.',
    );
  }
  // Emit at WARN so CI / staging log-based alerts trip on emit-site drift
  // (an INFO log would blend into normal traffic). Log payload KEYS only
  // — never values — so a future PII-bearing event never leaks raw.
  logger.warn(
    {
      f8AuditFallthrough: true,
      reason,
      eventType: event.type,
      tenantId: ctx.tenantId,
      actorRole: ctx.actorRole,
      correlationId: ctx.correlationId,
      payloadKeys: payloadKeysOf(event.payload),
    },
    'F8 audit emit fell back to pino — event type not in pgEnum yet',
  );
}

function buildInsertValues<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): AuditLogInsert {
  return {
    // event.type narrows to the F8AuditEventType union; the
    // auditEventTypeEnum union in the Drizzle schema includes these
    // values after migration 0099. Cast through the canonical enum
    // type for safety.
    eventType: event.type as AuditLogInsert['eventType'],
    actorUserId: ctx.actorUserId ?? `system:${ctx.actorRole}`,
    summary: buildSummary(event, ctx),
    requestId: ctx.requestId ?? ctx.correlationId,
    tenantId: ctx.tenantId,
    payload: event.payload,
    // timestamp + id default at DB layer (defaultRandom + defaultNow).
  };
}

export function makeDrizzleRenewalAuditEmitter(
  tenant: TenantContext,
): RenewalAuditEmitter {
  return {
    async emit<E extends F8AuditEventType>(
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // Pre-flight enum checks run OUTSIDE the try/catch so the
      // production-mode loud-fail in `pinoFallback` propagates to the
      // caller — that throw exists specifically to detect emit-site
      // drift before flag-flip and MUST NOT be swallowed.
      // The fire-and-forget contract still applies to runtime DB faults
      // (RLS misconfig, infra outage), which are caught + logged below.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        return;
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        return;
      }
      try {
        await runInTenant(tenant, async (tx) => {
          await tx.insert(auditLog).values(buildInsertValues(event, ctx));
        });
      } catch (e) {
        // Forensic log — fire-and-forget contract swallows the throw,
        // but the log line is the ONLY signal that audit data was lost,
        // so capture full diagnostic context (Sentry triage 6 months
        // later depends on it). Never include raw event.payload here —
        // payload keys only.
        logger.error(
          {
            err: e,
            errCode:
              e instanceof Error && 'code' in e
                ? (e as { code?: string }).code
                : undefined,
            eventType: event.type,
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            payloadKeys: payloadKeysOf(event.payload),
          },
          'F8 audit emit DB insert failed (fire-and-forget swallowed)',
        );
      }
    },

    async emitInTx<E extends F8AuditEventType>(
      tx: unknown,
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // emitInTx MUST throw on any failure mode — caller relies on the
      // throw to roll back the surrounding state mutation (Principle VIII).
      // Both pre-flight enum checks throw explicitly here (NOT just via
      // pinoFallback's prod-only throw) so a misconfigured emit site
      // also rolls back atomically — the alternative (pinoFallback;
      // return) would silently commit the state mutation without an
      // audit row in dev/staging where pinoFallback warns rather than
      // throws, breaking the state↔audit invariant.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        throw new Error(
          `emitInTx: event type '${event.type}' is not a known F8 audit event — refusing to commit state mutation without atomic audit row`,
        );
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        throw new Error(
          `emitInTx: event type '${event.type}' is not yet in the audit_event_type pgEnum — ship its migration before atomic emit`,
        );
      }
      const txDb = tx as typeof db;
      await txDb.insert(auditLog).values(buildInsertValues(event, ctx));
    },

    /**
     * Phase 6 Wave G T159b — bulk-emit N events in one INSERT round-
     * trip. Pre-flight checks each event's type against the F8 enum;
     * throws on any unknown event so the caller's tx rolls back. Uses
     * Drizzle's `.values([…])` array form which Postgres collapses
     * into a single multi-row INSERT.
     */
    async bulkEmitInTx(
      tx: unknown,
      events: ReadonlyArray<F8AuditEvent<F8AuditEventType>>,
      baseCtx: AuditContext,
    ): Promise<void> {
      if (events.length === 0) return;
      for (const event of events) {
        if (!isF8AuditEventType(event.type)) {
          pinoFallback(event, baseCtx, 'unknown_event_type');
          throw new Error(
            `bulkEmitInTx: event type '${event.type}' is not a known F8 audit event — refusing to commit state mutation without atomic audit rows`,
          );
        }
        if (!F8_ENUM_SHIPPED.has(event.type)) {
          pinoFallback(event, baseCtx, 'not_in_pgenum');
          throw new Error(
            `bulkEmitInTx: event type '${event.type}' is not yet in the audit_event_type pgEnum — ship its migration before atomic emit`,
          );
        }
      }
      const txDb = tx as typeof db;
      const rows = events.map((event) => buildInsertValues(event, baseCtx));
      await txDb.insert(auditLog).values(rows);
    },
  };
}

