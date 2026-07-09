/**
 * F8 Phase 9 / T258 — F8 audit-port contract test.
 *
 * Pins the 65-event audit catalogue at runtime + asserts representative
 * canonical payloads against the typed shape map (`F8AuditPayloadShapes`).
 *
 * Companion to:
 *   - `_AssertF8AuditEventCount` compile-time count pin in
 *     `renewal-audit-emitter.ts` (catches a missing event-type at
 *     build time)
 *   - `F8_ENUM_SHIPPED` runtime guard in `drizzle-renewal-audit-
 *     emitter.ts` (catches a missing migration at production emit
 *     time — falls through to pino-log)
 *   - `tests/integration/renewals/rbac-defence-in-depth.test.ts`
 *     (Phase 9 / T230 — proves the persistence path works end-to-end
 *     for one critical event)
 *
 * What this contract pins:
 *
 *   1. **Catalogue size invariant** — `F8_AUDIT_EVENT_TYPES.length === 66`.
 *      Mirrors the compile-time assertion as a runtime smoke check so
 *      a future refactor that bypasses the compile-time pin (e.g. via
 *      `as readonly string[]`) still trips the test.
 *   2. **No-duplicates invariant** — every event-type appears at most
 *      once in the const tuple. A duplicate would let the
 *      `_AssertF8AuditEventCount` pin pass even with one event missing
 *      (the count stays right).
 *   3. **Canonical payload acceptance** — for high-value events with
 *      typed shapes (cross-tenant probe, role-violation, kill-switch,
 *      reminder dispatch), construct the canonical payload literal and
 *      assert the `F8AuditEvent<E>` type accepts it. This is a
 *      compile-time guarantee but the test makes it explicit so a
 *      future shape drift surfaces as a TS error in this file rather
 *      than at distant emit sites.
 *   4. **`isF8AuditEventType` runtime predicate** — the type-guard
 *      helper accepts every catalogue event AND rejects an unknown
 *      string. Runtime-callable consumers (drizzle adapter pre-flight,
 *      future webhook ingest) depend on this predicate's exact contract.
 *   5. **5-year retention default** — `F8_AUDIT_RETENTION_YEARS === 5`.
 *      Constitution v1.4.0 default for non-tax-document audit; F8 has
 *      no F4-style 10-year overlap. Test pins the constant so a future
 *      change requires explicit Spec Kit amendment.
 *
 * What this contract does NOT pin (out of scope for T258):
 *
 *   - Per-event owner task → audit emit site mapping (covered by the
 *     `audit-event-coverage.md` matrix in `specs/011-renewal-reminders/`)
 *   - Pino redact path coverage of PII fields in payloads (covered by
 *     `tests/unit/lib/logger-pii.test.ts` + `logger-redaction.test.ts`)
 *   - Persistence semantics (covered by `rbac-defence-in-depth.test.ts`
 *     + `audit-emit-rollback.test.ts`)
 */
import { describe, expect, it } from 'vitest';
import {
  F8_AUDIT_EVENT_TYPES,
  F8_AUDIT_RETENTION_YEARS,
  isF8AuditEventType,
  type F8AuditEvent,
  type F8AuditEventType,
} from '@/modules/renewals/application/ports/renewal-audit-emitter';

describe('F8 audit-port contract (T258)', () => {
  // ── Catalogue invariants ─────────────────────────────────────────────

  it('catalogue contains exactly 66 event types (matches compile-time _AssertF8AuditEventCount)', () => {
    // Renewal rolling-anchor refactor (migration 0238): 65 → 66, +1
    // `renewal_cycle_reanchored`.
    expect(F8_AUDIT_EVENT_TYPES).toHaveLength(66);
  });

  it('catalogue contains no duplicate event types', () => {
    const set = new Set<string>(F8_AUDIT_EVENT_TYPES);
    expect(set.size).toBe(F8_AUDIT_EVENT_TYPES.length);
  });

  it('every catalogue entry is a non-empty snake_case string', () => {
    for (const eventType of F8_AUDIT_EVENT_TYPES) {
      expect(typeof eventType).toBe('string');
      expect(eventType.length).toBeGreaterThan(0);
      // Phase 5 reminder ladder events use `t-7` / `t-3` / `t-1` which
      // contain a hyphen by design. Allow lower-case + digits + hyphen
      // + underscore — but no upper-case, spaces, or other separators.
      expect(eventType).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it('catalogue is sorted into the documented domain groups (renewal lifecycle / lapsed / at-risk / tier-upgrade / escalation / cron / silent-skip / silent-failure / phase-5)', () => {
    // Smoke-pin the documented group boundaries — if a future refactor
    // re-orders the const tuple it breaks the data-model.md § 4 bidi
    // mapping. Each group's first event must appear in the documented
    // order: renewal_cycle_created < lapsed_member_action_blocked <
    // at_risk_score_recomputed < tier_upgrade_suggested <
    // escalation_task_created < cron_dispatch_orchestrated.
    const cycleCreatedIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'renewal_cycle_created' as never,
    );
    const lapsedActionIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'lapsed_member_action_blocked' as never,
    );
    const atRiskIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'at_risk_score_recomputed' as never,
    );
    const tierUpgradeIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'tier_upgrade_suggested' as never,
    );
    const escalationIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'escalation_task_created' as never,
    );
    const cronIdx = F8_AUDIT_EVENT_TYPES.indexOf(
      'cron_dispatch_orchestrated' as never,
    );

    // Each domain marker must be present.
    expect(cycleCreatedIdx).toBeGreaterThanOrEqual(0);
    expect(lapsedActionIdx).toBeGreaterThanOrEqual(0);
    expect(atRiskIdx).toBeGreaterThanOrEqual(0);
    expect(tierUpgradeIdx).toBeGreaterThanOrEqual(0);
    expect(escalationIdx).toBeGreaterThanOrEqual(0);
    expect(cronIdx).toBeGreaterThanOrEqual(0);

    // Strict ordering — catches a drift where (e.g.) at-risk events
    // get accidentally moved before renewal-lifecycle events.
    expect(cycleCreatedIdx).toBeLessThan(lapsedActionIdx);
    expect(lapsedActionIdx).toBeLessThan(atRiskIdx);
    expect(atRiskIdx).toBeLessThan(tierUpgradeIdx);
    expect(tierUpgradeIdx).toBeLessThan(escalationIdx);
    expect(escalationIdx).toBeLessThan(cronIdx);
  });

  // ── isF8AuditEventType runtime predicate ────────────────────────────

  it('isF8AuditEventType accepts every catalogue entry', () => {
    for (const eventType of F8_AUDIT_EVENT_TYPES) {
      expect(isF8AuditEventType(eventType)).toBe(true);
    }
  });

  it('isF8AuditEventType rejects an unknown string', () => {
    expect(isF8AuditEventType('not_a_real_event_type')).toBe(false);
    expect(isF8AuditEventType('')).toBe(false);
    expect(isF8AuditEventType('renewal_FAKE')).toBe(false);
  });

  it('isF8AuditEventType rejects non-string inputs', () => {
    expect(isF8AuditEventType(undefined)).toBe(false);
    expect(isF8AuditEventType(null)).toBe(false);
    expect(isF8AuditEventType(42)).toBe(false);
    expect(isF8AuditEventType({ type: 'renewal_cycle_created' })).toBe(false);
  });

  // ── Retention default ────────────────────────────────────────────────

  it('F8_AUDIT_RETENTION_YEARS === 5 (Constitution v1.4.0 default for non-tax-document)', () => {
    expect(F8_AUDIT_RETENTION_YEARS).toBe(5);
  });

  // ── Canonical typed-shape acceptance ────────────────────────────────

  it('renewal_cross_tenant_probe — canonical payload accepted by F8AuditEvent type', () => {
    // Constitution Principle I clause 4 — every cross-tenant access
    // attempt MUST emit this audit. The payload shape pins what
    // dashboards depend on.
    const event: F8AuditEvent<'renewal_cross_tenant_probe'> = {
      type: 'renewal_cross_tenant_probe',
      payload: {
        attempted_cycle_id:
          '00000000-0000-0000-0000-000000000001' as never,
        route: 'cancel-cycle',
      },
    };
    // Compile-time check is the actual test; the runtime assertion
    // pins the construction so a future shape drift surfaces here.
    expect(event.type).toBe('renewal_cross_tenant_probe');
    expect(event.payload.route).toBe('cancel-cycle');
  });

  it('f8_role_violation_blocked — canonical payload accepted with all 3 action labels', () => {
    const writeEvent: F8AuditEvent<'f8_role_violation_blocked'> = {
      type: 'f8_role_violation_blocked',
      payload: {
        resource: 'renewal',
        action: 'write',
        attempted_role: 'manager',
        route: '/api/admin/renewals/abc/cancel',
      },
    };
    const readEvent: F8AuditEvent<'f8_role_violation_blocked'> = {
      type: 'f8_role_violation_blocked',
      payload: {
        resource: 'renewal',
        action: 'read',
        attempted_role: 'member',
        route: '/api/admin/renewals/at-risk',
      },
    };
    const exceptionEvent: F8AuditEvent<'f8_role_violation_blocked'> = {
      type: 'f8_role_violation_blocked',
      payload: {
        resource: 'renewal',
        action: 'manager_exception',
        attempted_role: 'member',
        route: '/api/admin/renewals/at-risk/abc/outreach',
      },
    };
    expect(writeEvent.payload.action).toBe('write');
    expect(readEvent.payload.action).toBe('read');
    expect(exceptionEvent.payload.action).toBe('manager_exception');
  });

  it('renewal_kill_switch_blocked — canonical payload accepted', () => {
    const event: F8AuditEvent<'renewal_kill_switch_blocked'> = {
      type: 'renewal_kill_switch_blocked',
      payload: {
        route: '/portal/renewal/abc',
      },
    };
    expect(event.payload.route).toBe('/portal/renewal/abc');
  });

  it('renewal_cycle_reanchored — canonical payload accepted (heal_no_cycle branch, nullable old_* + invoice_id)', () => {
    // Renewal rolling-anchor refactor (migration 0238) — the heal_no_cycle
    // classification has no prior period, so old_period_from/to are null.
    // invoice_id is nullable too (backfilled pre-system payments never
    // carry a forensic invoice reference).
    const event: F8AuditEvent<'renewal_cycle_reanchored'> = {
      type: 'renewal_cycle_reanchored',
      payload: {
        cycle_id: '00000000-0000-0000-0000-000000000002' as never,
        member_id: '00000000-0000-0000-0000-000000000003' as never,
        invoice_id: null,
        old_period_from: null,
        old_period_to: null,
        new_period_from: '2026-03-01T00:00:00.000Z',
        new_period_to: '2027-03-01T00:00:00.000Z',
        old_status: 'upcoming',
        refroze_plan_fields: false,
        reminder_events_reset: 0,
      },
    };
    expect(event.payload.old_period_from).toBeNull();
    expect(event.payload.new_period_from).toBe('2026-03-01T00:00:00.000Z');
  });

  it('renewal_token_invalid — canonical payload accepts every reason variant', () => {
    const reasons = [
      'malformed_token',
      'mac_mismatch',
      'expired',
      'replayed',
      'cross_tenant',
      'member_not_found_in_tenant',
    ] as const;
    for (const reason of reasons) {
      const event: F8AuditEvent<'renewal_token_invalid'> = {
        type: 'renewal_token_invalid',
        payload: { reason },
      };
      expect(event.payload.reason).toBe(reason);
    }
  });

  it('every catalogue event-type discriminant is a valid F8AuditEventType', () => {
    // Type-level smoke check that the const tuple ↔ union round-trips
    // cleanly. If the union ever drifts (e.g. by manual edit of the
    // exported `F8AuditEventType` type), `eventType satisfies
    // F8AuditEventType` would compile-error here.
    const eventTypes: readonly F8AuditEventType[] = F8_AUDIT_EVENT_TYPES;
    expect(eventTypes.length).toBe(F8_AUDIT_EVENT_TYPES.length);
  });

  // ── Domain coverage spot-checks ──────────────────────────────────────

  it('catalogue includes all FR-052 / FR-052a / FR-052b kill-switch + RBAC events', () => {
    const required = [
      'renewal_kill_switch_blocked',     // FR-052 (a) (c) — feature flag off
      'f8_role_violation_blocked',        // FR-052a — RBAC matrix
      'cron_bearer_auth_rejected',        // K6 / R17 — cron 401
    ] as const;
    for (const eventType of required) {
      expect(F8_AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });

  it('catalogue includes all FR-005 lapsed-portal + FR-005c reminder-ladder events', () => {
    const required = [
      'lapsed_member_action_blocked',
      'lapsed_member_admin_reactivated',
      'lapsed_member_admin_reactivation_rejected',
      'lapsed_member_admin_reactivation_timed_out',
      'lapsed_member_admin_reactivation_reminder_t-7',
      'lapsed_member_admin_reactivation_reminder_t-3',
      'lapsed_member_admin_reactivation_reminder_t-1',
    ] as const;
    for (const eventType of required) {
      expect(F8_AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });

  it('catalogue includes all 4 escalation-task lifecycle events (FR-043 + FR-044)', () => {
    expect(F8_AUDIT_EVENT_TYPES).toContain('escalation_task_created');
    expect(F8_AUDIT_EVENT_TYPES).toContain('escalation_task_completed');
    expect(F8_AUDIT_EVENT_TYPES).toContain('escalation_task_skipped');
    expect(F8_AUDIT_EVENT_TYPES).toContain('escalation_task_reassigned');
  });

  it('catalogue includes all tier-upgrade lifecycle events (FR-037 + FR-038 + FR-039)', () => {
    const required = [
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
    ] as const;
    for (const eventType of required) {
      expect(F8_AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });

  it('catalogue includes all at-risk lifecycle events (FR-028 + FR-029 + FR-030)', () => {
    const required = [
      'at_risk_score_recomputed',
      'at_risk_score_threshold_crossed',
      'at_risk_snoozed',
      'at_risk_outreach_recorded',
      'at_risk_skipped_below_min_tenure',
      'at_risk_compute_partial_failure',
    ] as const;
    for (const eventType of required) {
      expect(F8_AUDIT_EVENT_TYPES).toContain(eventType);
    }
  });
});
