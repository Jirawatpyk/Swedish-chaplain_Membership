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
  it('contains 55 unique event types (K6: +cron_bearer_auth_rejected)', () => {
    // K6: 54 → 55 (added cron_bearer_auth_rejected per spec.md line 365
    // taxonomy + verifyCronBearer 401 path now emits this audit).
    expect(F8_AUDIT_EVENT_TYPES.length).toBe(55);
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

  it('contains the lifecycle anchor events (data-model.md § 4)', () => {
    const lifecycle = [
      'renewal_cycle_created',
      'renewal_cycle_cancelled',
      'renewal_lapsed',
      'renewal_completed',
      'renewal_completed_post_lapse',
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
    expect(
      (F8_AUDIT_EVENT_TYPES as readonly string[]).filter((e) =>
        e.startsWith('tier_upgrade_'),
      ).length,
    ).toBe(11);
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
