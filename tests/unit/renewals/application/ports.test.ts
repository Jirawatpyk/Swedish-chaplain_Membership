/**
 * F8 Phase 2 Wave E — Application port runtime sanity (T041-T051).
 *
 * Application ports are pure interfaces — no runtime to test. This
 * file pins the runtime EXPORTS that are non-interface (constants +
 * Error subclasses + helper functions) so the barrel surface can't
 * silently drop a symbol between Wave E and Wave G adapter wiring.
 *
 * Per F7 audit-port test pattern (`tests/unit/broadcasts/application/
 * audit-port-types.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  F8_AUDIT_EVENT_TYPES,
  F8_AUDIT_RETENTION_YEARS,
  isF8AuditEventType,
} from '@/modules/renewals/application/ports/renewal-audit-emitter';
import { SKIP_REASONS } from '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { ReminderEventNotFoundError } from '@/modules/renewals/application/ports/renewal-reminder-event-repo';
import {
  TierUpgradeOpenConflictError,
  TierUpgradeSuggestionNotFoundError,
} from '@/modules/renewals/application/ports/tier-upgrade-suggestion-repo';
import { EscalationTaskNotFoundError } from '@/modules/renewals/application/ports/renewal-escalation-task-repo';

describe('F8_AUDIT_EVENT_TYPES catalogue (T051)', () => {
  it('contains 69 unique event types (059-membership-suspension Task 13: +1)', () => {
    // 059-membership-suspension Task 13: 68 → 69 (added
    // `renewal_lapse_deferred_invoice_not_due` — the InvoiceDueBridge
    // credit-window guard's forensic event; see
    // `lapse-cycles-on-grace-expiry.ts` `processOne`).
    // 059-membership-suspension Task 8: 66 → 68 (added
    // `membership_suspended_action_blocked` + `membership_access_fail_open`
    // — the two lapsed-portal-scope forensic events; see
    // `src/lib/lapsed-portal-scope.ts` `checkPortalAccess`).
    // Renewal rolling-anchor refactor (design 2026-07-08, migration 0238):
    // 65 → 66 (added `renewal_cycle_reanchored` — emitted when the shared
    // payment classifier re-anchors a first-payment cycle instead of
    // completing it; see docs/superpowers/specs/2026-07-08-renewal-
    // rolling-anchor-design.md § 5).
    // F8-completion slice 2: 64 → 65 (added the T-0 payability-flip audit
    // `renewal_entered_awaiting_payment` with a `source: 'cron' | 'confirm'`
    // discriminator — migration 0215. Emitted by the enter-awaiting-payment
    // cron and the lazy confirm-renewal self-transition).
    // Phase 7 review-fix Round 2: 62 → 64 (added 2 silent-failure audits
    // surfaced by Round 2 IMP-6 + SUG-6:
    // tier_upgrade_catalogue_row_dropped (TierBucket parse failure),
    // tier_upgrade_apply_post_invoice_paid_failed (F4 committed; F8 threw)
    // — migration 0120).
    // Phase 7 review-fix Round 1: 59 → 62 (added 3 silent-skip audits:
    // tier_upgrade_pending_member_notify_skipped,
    // tier_upgrade_pending_member_notify_failed,
    // renewal_schedule_reschedule_skipped — migration 0119).
    // Phase 5 Wave A (T120/T138): 55 → 59 (added the CHK033 race-window
    // forensic event `renewal_token_clicked_on_completed_cycle` plus the
    // 3 lapsed-pending reminder-ladder events `_t-7` / `_t-3` / `_t-1`).
    // K6 (prior): 54 → 55 (added cron_bearer_auth_rejected per spec.md
    // line 365 taxonomy + verifyCronBearer 401 path now emits this audit).
    expect(F8_AUDIT_EVENT_TYPES.length).toBe(69);
    const set = new Set(F8_AUDIT_EVENT_TYPES);
    expect(set.size).toBe(F8_AUDIT_EVENT_TYPES.length);
  });

  it('5y retention default for all F8 events (no tax-doc overlap)', () => {
    expect(F8_AUDIT_RETENTION_YEARS).toBe(5);
  });

  it('isF8AuditEventType — narrows for canonical strings', () => {
    expect(isF8AuditEventType('renewal_cycle_created')).toBe(true);
    expect(isF8AuditEventType('at_risk_score_recomputed')).toBe(true);
    expect(isF8AuditEventType('tier_upgrade_applied_at_renewal')).toBe(true);
  });

  it('isF8AuditEventType — false for unknown / non-string', () => {
    expect(isF8AuditEventType('not_an_f8_event')).toBe(false);
    expect(isF8AuditEventType(42)).toBe(false);
    expect(isF8AuditEventType(undefined)).toBe(false);
    expect(isF8AuditEventType(null)).toBe(false);
  });

  // `renewal_cycle_reanchored` postdates specs/011-renewal-reminders/
  // data-model.md § 4 — it ships with the rolling-anchor refactor
  // (docs/superpowers/specs/2026-07-08-renewal-rolling-anchor-design.md,
  // migration 0238); the rest of the lifecycle set is data-model.md § 4.
  it('contains the lifecycle anchor events (data-model.md § 4 + rolling-anchor spec)', () => {
    const lifecycle = [
      'renewal_cycle_created',
      'renewal_cycle_cancelled',
      'renewal_lapsed',
      'renewal_completed',
      'renewal_completed_post_lapse',
      'renewal_cycle_reanchored',
      'renewal_cross_tenant_probe',
    ];
    for (const e of lifecycle) {
      expect((F8_AUDIT_EVENT_TYPES as readonly string[]).includes(e)).toBe(true);
    }
  });

  it('contains the at-risk + tier-upgrade event clusters', () => {
    expect(
      (F8_AUDIT_EVENT_TYPES as readonly string[]).filter((e) => e.startsWith('at_risk_')).length,
    ).toBe(6);
    // Phase 7 review-fix Round 1: 11 → 13 (+2 silent-skip audits
    // tier_upgrade_pending_member_notify_skipped + _failed).
    // Phase 7 review-fix Round 2: 13 → 15 (+2 silent-failure audits
    // tier_upgrade_catalogue_row_dropped +
    // tier_upgrade_apply_post_invoice_paid_failed). The
    // `renewal_schedule_reschedule_skipped` audit is in the renewal_*
    // cluster, not tier_upgrade_*.
    expect(
      (F8_AUDIT_EVENT_TYPES as readonly string[]).filter((e) =>
        e.startsWith('tier_upgrade_'),
      ).length,
    ).toBe(15);
  });
});

describe('SKIP_REASONS catalogue', () => {
  it('K12-S (TST-K-5): contains 14 unique skip reasons (runtime complement to compile-time _AssertSkipReasonCount)', () => {
    // The compile-time `_AssertSkipReasonCount extends 14` in
    // dispatch-one-cycle.ts is the primary pin, but a single-commit
    // change that flips both the literal `14` AND the tuple in lock-
    // step would compile silently. This runtime check duplicates
    // the safeguard so each commit has a chance to surface drift.
    // Mirrors the dual-coverage already in place for
    // F8_AUDIT_EVENT_TYPES (compile-time _AssertF8AuditEventCount +
    // runtime `expect(F8_AUDIT_EVENT_TYPES.length).toBe(N)` above).
    // Rolling-anchor rev 2 (2026-07-08 §4) added
    // `unreconciled_paid_membership_invoice` (13 → 14).
    expect(SKIP_REASONS.length).toBe(14);
    const set = new Set(SKIP_REASONS);
    expect(set.size).toBe(SKIP_REASONS.length);
  });
});

describe('Error classes (T041-T044)', () => {
  it('CycleNotFoundError carries cycleId', () => {
    const e = new CycleNotFoundError('c1');
    expect(e.cycleId).toBe('c1');
    expect(e.name).toBe('CycleNotFoundError');
    expect(e.message).toContain('c1');
    expect(e instanceof Error).toBe(true);
  });

  it('CycleTransitionConflictError carries from/actual', () => {
    const e = new CycleTransitionConflictError('c1', 'upcoming', 'completed');
    expect(e.expectedFrom).toBe('upcoming');
    expect(e.actualStatus).toBe('completed');
    expect(e.cycleId).toBe('c1');
  });

  it('ReminderEventNotFoundError carries reminderEventId', () => {
    const e = new ReminderEventNotFoundError('rev-1');
    expect(e.reminderEventId).toBe('rev-1');
  });

  it('TierUpgradeOpenConflictError carries memberId', () => {
    const e = new TierUpgradeOpenConflictError('m-1');
    expect(e.memberId).toBe('m-1');
  });

  it('TierUpgradeSuggestionNotFoundError carries suggestionId', () => {
    const e = new TierUpgradeSuggestionNotFoundError('s-1');
    expect(e.suggestionId).toBe('s-1');
  });

  it('EscalationTaskNotFoundError carries taskId', () => {
    const e = new EscalationTaskNotFoundError('t-1');
    expect(e.taskId).toBe('t-1');
  });
});
