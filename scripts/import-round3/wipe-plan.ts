/**
 * Round-3 wipe — PURE deletion plan (Part 3 of the Round-3 import;
 * docs/import/ROUND3_PLAN.md § Wipe).
 *
 * This module is deliberately free of DB / env imports so the ordering
 * invariants can be unit-tested without touching '@/lib/db'
 * (tests/unit/scripts/wipe-tenant-business-data-plan.test.ts). The
 * executable half lives in ./wipe-core.ts.
 *
 * ORDERING SOURCE OF TRUTH — scripts/clear-test-data.ts (the proven FK-safe
 * template) + the Round-3 ops research:
 *
 *   1. renewals children (reminder events / escalation tasks / scheduled
 *      plan changes) → renewal_cycles. Cycles FK-reference invoices via
 *      linked_invoice_id + anchor_invoice_id (mig 0238; composite FK is
 *      effectively RESTRICT) + auto_draft_invoice_id (mig 0259) AND
 *      credit_notes via linked_credit_note_id (mig 0087), so cycles MUST be
 *      deleted BEFORE invoices AND before credit_notes.
 *   2. F4/F5 money cascade — `refunds ↔ credit_notes` is a genuine FK CYCLE
 *      (refunds.credit_note_id → credit_notes ON DELETE RESTRICT, mig 0034;
 *      credit_notes.source_refund_id → refunds ON DELETE RESTRICT, mig 0038),
 *      so NO pure delete ordering can succeed once a refund-origin credit
 *      note exists. Pre-step (REFUND_CREDIT_NOTE_UNLINK_STEP): UPDATE refunds
 *      SET credit_note_id = NULL, breaking the refunds→credit_notes edge —
 *      with a transient waiver stamp, because the 0268
 *      `refunds_succeeded_iff_documented` CHECK forbids a bare NULL on a
 *      succeeded refund (the rows are deleted two steps later in the SAME
 *      tx, so the stamp never escapes). The reverse edge is NOT breakable:
 *      the 0273 redaction-lock trigger forbids touching
 *      credit_notes.source_refund_id on every write path. Delete order is
 *      therefore credit_notes → refunds → payments → invoice_lines →
 *      invoices. payments also FK members.
 *   3. Remaining member/tenant leaves: directory_listings (FK members),
 *      dashboard_metrics_cache (F9 derived per-tenant cache — stale after a
 *      wipe, safe to rebuild), csv_import_records + event_registrations
 *      (tenant-scoped; likely 0 rows — included for completeness; the F6
 *      `events` table itself is KEPT), email_change_tokens +
 *      notifications_outbox (tenant rows).
 *   4. Member-PORTAL users: resolved via contacts BEFORE contacts are
 *      deleted (read-before-scrub), children first — sessions →
 *      password_reset_tokens → invitations (invitee rows only; admin
 *      invitations untouched) → users. System actors (id '00000000-%')
 *      and role='admin' rows are ALWAYS excluded.
 *   5. contacts → members.
 *   6. Numbering resets LAST (a reset while guarded rows survive would
 *      collide on invoices_tenant_fiscal_seq_unique /
 *      members_tenant_member_number_uniq): DELETE tenant_document_sequences
 *      rows (allocator self-bootstraps at 1 — never pre-seed), and zero
 *      tenant_member_sequences.last_number (row KEPT; the SCCM prefix row in
 *      tenant_member_settings is also kept).
 */

/**
 * FK-cycle-breaker pre-step (see header § 2): runs BEFORE the table deletes.
 * `UPDATE refunds SET credit_note_id = NULL …` for the target tenant — the
 * only way to open the refunds ↔ credit_notes RESTRICT cycle. Reported under
 * this label in the wipe report (dry-run counts the rows that would unlink).
 */
export const REFUND_CREDIT_NOTE_UNLINK_STEP = 'refunds.credit_note_id_unlink';

/** Tenant-scoped tables deleted (in order) BEFORE the member-user pass. */
export const TENANT_TABLES_BEFORE_USERS = [
  'renewal_reminder_events',
  'renewal_escalation_tasks',
  'tier_upgrade_suggestions',
  'at_risk_outreach',
  'consumed_link_tokens',
  'scheduled_plan_changes',
  'renewal_cycles',
  // credit_notes FIRST — deletable only because the unlink pre-step nulled
  // every refunds.credit_note_id (the RESTRICT edge that blocks this delete).
  // refunds SECOND — deletable only because the credit_notes rows holding
  // source_refund_id references are now gone (that edge is trigger-locked
  // and can never be nulled). payments THIRD (refunds.payment_id RESTRICT).
  'credit_notes',
  'refunds',
  'payments',
  'invoice_lines',
  'invoices',
  'directory_listings',
  'dashboard_metrics_cache',
  'csv_import_records',
  'event_registrations',
  'email_change_tokens',
  'notifications_outbox',
] as const;

/**
 * Member-portal user pass (custom predicates, not tenant_id columns):
 * children of the resolved member-user id set, then the users themselves.
 */
export const MEMBER_USER_STEPS = [
  'sessions',
  'password_reset_tokens',
  'invitations',
  'users',
] as const;

/** Tenant-scoped tables deleted AFTER the member-user pass. */
export const TENANT_TABLES_AFTER_USERS = ['contacts', 'members'] as const;

/**
 * Numbering resets — run LAST. tenant_document_sequences rows are DELETED
 * (per-FY streams restart at 1); tenant_member_sequences.last_number is
 * zeroed via UPDATE (row kept).
 */
export const SEQUENCE_RESET_STEPS = [
  'tenant_document_sequences',
  'tenant_member_sequences',
] as const;

/** Full ordered step list (unit-tested precedence). */
export const WIPE_STEP_ORDER = [
  ...TENANT_TABLES_BEFORE_USERS,
  ...MEMBER_USER_STEPS,
  ...TENANT_TABLES_AFTER_USERS,
  ...SEQUENCE_RESET_STEPS,
] as const;

export type WipeStep = (typeof WIPE_STEP_ORDER)[number];

/**
 * NEVER touched by the wipe:
 *   - audit_log — append-only per Constitution Principle VIII.
 *   - processor_events — RLS `USING (false)` forbids DELETE (mig 0036);
 *     append-only posture by design.
 *   - admin users + system actors ('00000000-%') — excluded from the user
 *     pass; deleting system actors breaks every webhook/cron write
 *     (docs/runbooks/prod-data-wipe.md incident 2026-06-24→07-06).
 *   - membership_plans + every tenant_* config table — restored state, not
 *     business data.
 *   - broadcasts surfaces — F7 quota/consent history is retained.
 *   - events / webhook config — F6 event catalogue is retained (only the
 *     tenant's registrations/import records are business data).
 */
export const PROTECTED_TABLES = [
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
  'marketing_unsubscribes',
  'broadcast_segment_definitions',
  'broadcast_templates',
  'broadcast_batch_manifests',
  'broadcast_batch_delivery_events',
  'tenant_image_source_allowlist',
  'tenant_broadcast_settings',
  'events',
  'tenant_webhook_configs',
  'eventcreate_idempotency_receipts',
] as const;

/**
 * Commit guard — `--commit` additionally requires the env var
 * `CONFIRM_WIPE=<tenantId>` to match EXACTLY. Throws loudly otherwise.
 */
export function assertCommitConfirmed(
  tenantId: string,
  confirmEnv: string | undefined,
): void {
  if (confirmEnv !== tenantId) {
    throw new Error(
      `REFUSING --commit: env CONFIRM_WIPE must equal the target tenant id ` +
        `EXACTLY (expected CONFIRM_WIPE=${JSON.stringify(tenantId)}, got ` +
        `${confirmEnv === undefined ? 'unset' : JSON.stringify(confirmEnv)}). ` +
        `This guard exists because the wipe deletes ALL business data for the ` +
        `tenant. Re-run with CONFIRM_WIPE=${tenantId} only inside the ` +
        `ROUND3_PLAN operational window (F8 crons dark + Neon PITR point taken).`,
    );
  }
}
