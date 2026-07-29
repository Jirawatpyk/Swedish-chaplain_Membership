/**
 * Round-3 wipe — pure deletion-plan unit tests (Part 3 of the Round-3
 * import; docs/import/ROUND3_PLAN.md § Wipe).
 *
 * The FK-precedence pairs pinned here are the hard-won ordering rules from
 * scripts/clear-test-data.ts + the Round-3 ops research:
 *   - renewal_cycles FK-references invoices via linked_invoice_id /
 *     anchor_invoice_id / auto_draft_invoice_id → cycles BEFORE invoices,
 *     and credit_notes via linked_credit_note_id (0087) → cycles BEFORE
 *     credit_notes.
 *   - refunds ↔ credit_notes is a MUTUAL ON DELETE RESTRICT cycle (0034 +
 *     0038): the core first nulls refunds.credit_note_id (the only writable
 *     edge — 0273 trigger-locks source_refund_id), then deletes
 *     credit_notes BEFORE refunds BEFORE payments.
 *   - invoice_lines → invoices (F4 cascade).
 *   - every member FK child (contacts, invoices, payments, cycles,
 *     at_risk_outreach, tier_upgrade_suggestions, renewal_escalation_tasks,
 *     directory_listings) BEFORE members.
 *   - sequence resets AFTER the rows they guard are gone (unique-index
 *     collision otherwise: invoices_tenant_fiscal_seq_unique /
 *     members_tenant_member_number_uniq).
 *
 * A mutation that reorders WIPE_STEP_ORDER past any of these pairs turns the
 * prod wipe into an FK-violation abort mid-run — this suite is the guard.
 */
import { describe, expect, it } from 'vitest';
import {
  MEMBER_USER_STEPS,
  PROTECTED_TABLES,
  SEQUENCE_RESET_STEPS,
  TENANT_TABLES_AFTER_USERS,
  TENANT_TABLES_BEFORE_USERS,
  WIPE_STEP_ORDER,
  assertCommitConfirmed,
} from '@/../scripts/import-round3/wipe-plan';

describe('WIPE_STEP_ORDER — FK-safe deletion precedence', () => {
  const idx = (step: string): number => WIPE_STEP_ORDER.indexOf(step as never);

  /** [child, parent] — the child (or referencing) step MUST run first. */
  const PRECEDENCE_PAIRS: ReadonlyArray<readonly [string, string]> = [
    // renewals children before cycles
    ['renewal_reminder_events', 'renewal_cycles'],
    ['renewal_escalation_tasks', 'renewal_cycles'],
    ['scheduled_plan_changes', 'renewal_cycles'],
    // cycles reference invoices (linked/anchor/auto_draft FKs) — MUST precede
    ['renewal_cycles', 'invoices'],
    // cycles also reference credit_notes (linked_credit_note_id, mig 0087)
    ['renewal_cycles', 'credit_notes'],
    // refunds ↔ credit_notes FK CYCLE (0034 + 0038): after the
    // refunds.credit_note_id unlink pre-step, credit_notes MUST go first —
    // the credit_notes.source_refund_id → refunds edge is trigger-locked
    // (0273) and can only be cleared by deleting the credit-note rows.
    ['credit_notes', 'refunds'],
    ['refunds', 'payments'],
    ['payments', 'invoices'],
    // F4 cascade
    ['credit_notes', 'invoices'],
    ['invoice_lines', 'invoices'],
    // every member FK child before members
    ['contacts', 'members'],
    ['invoices', 'members'],
    ['payments', 'members'],
    ['renewal_cycles', 'members'],
    ['at_risk_outreach', 'members'],
    ['tier_upgrade_suggestions', 'members'],
    ['renewal_escalation_tasks', 'members'],
    ['directory_listings', 'members'],
    // member-portal user steps: children before the users delete
    ['sessions', 'users'],
    ['password_reset_tokens', 'users'],
    ['invitations', 'users'],
    // brief-mandated placement: users before contacts (ids resolved via
    // contacts.linked_user_id BEFORE any delete — read-before-scrub)
    ['users', 'contacts'],
    // numbering resets only after the guarded rows are gone
    ['invoices', 'tenant_document_sequences'],
    ['members', 'tenant_member_sequences'],
  ];

  it('contains every step exactly once', () => {
    const all = [
      ...TENANT_TABLES_BEFORE_USERS,
      ...MEMBER_USER_STEPS,
      ...TENANT_TABLES_AFTER_USERS,
      ...SEQUENCE_RESET_STEPS,
    ];
    expect([...WIPE_STEP_ORDER]).toEqual(all);
    expect(new Set(WIPE_STEP_ORDER).size).toBe(WIPE_STEP_ORDER.length);
  });

  it.each(PRECEDENCE_PAIRS)('%s runs before %s', (child, parent) => {
    expect(idx(child), `${child} missing from WIPE_STEP_ORDER`).toBeGreaterThanOrEqual(0);
    expect(idx(parent), `${parent} missing from WIPE_STEP_ORDER`).toBeGreaterThanOrEqual(0);
    expect(idx(child), `${child} must run before ${parent}`).toBeLessThan(idx(parent));
  });

  it('wipes the F9 dashboard cache (stale after a wipe — R3-8)', () => {
    expect(idx('dashboard_metrics_cache')).toBeGreaterThanOrEqual(0);
  });

  it('never touches a protected table', () => {
    for (const step of WIPE_STEP_ORDER) {
      expect(
        (PROTECTED_TABLES as readonly string[]).includes(step),
        `${step} is protected and must not appear in the wipe order`,
      ).toBe(false);
    }
  });

  it('protects the append-only / config / broadcast surfaces', () => {
    for (const t of [
      'audit_log',
      'processor_events',
      'membership_plans',
      'tenant_invoice_settings',
      'tenant_member_settings',
      'tenant_renewal_settings',
      'tenant_renewal_schedule_policies',
      'tenant_payment_settings',
      'broadcasts',
      'broadcast_deliveries',
      'events',
    ]) {
      expect(
        (PROTECTED_TABLES as readonly string[]).includes(t),
        `${t} must be in PROTECTED_TABLES`,
      ).toBe(true);
    }
  });
});

describe('assertCommitConfirmed — CONFIRM_WIPE guard', () => {
  it('passes only on an exact tenant-id match', () => {
    expect(() => assertCommitConfirmed('swecham', 'swecham')).not.toThrow();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['wrong value', 'swecham-prod'],
    ['case mismatch', 'SWECHAM'],
    ['trailing space', 'swecham '],
  ])('refuses when CONFIRM_WIPE is %s', (_label, value) => {
    expect(() => assertCommitConfirmed('swecham', value)).toThrow(/CONFIRM_WIPE/);
  });

  it('refuses a confirm value for a DIFFERENT tenant', () => {
    expect(() => assertCommitConfirmed('test-tenant-abc', 'swecham')).toThrow(/CONFIRM_WIPE/);
  });
});
