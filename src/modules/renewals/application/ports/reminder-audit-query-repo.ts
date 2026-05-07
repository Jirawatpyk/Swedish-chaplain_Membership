/**
 * `ReminderAuditQueryPort` — read-only query into `audit_log` to
 * support T138's reminder-ladder catch-up after a cron-skip.
 *
 * Why: the reconcile cron uses equality checks (`daysPending ===
 * REMINDER_T_N`) to fire each reminder. If the cron skips a day (e.g.
 * a Vercel deploy reboot or Upstash 401 outage), the reminder is
 * silently dropped. This port lets the cron answer "have we already
 * fired T-7 / T-3 / T-1 for this cycle?" so a day-25 invocation that
 * sees no T-7 audit row still fires the reminder.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

/**
 * The three reminder-ladder audit event types tracked by the cron's
 * catch-up logic. Mirrors the literal types in
 * `renewal-audit-emitter.ts` F8_AUDIT_EVENT_TYPES.
 */
export type ReminderLadderAuditType =
  | 'lapsed_member_admin_reactivation_reminder_t-7'
  | 'lapsed_member_admin_reactivation_reminder_t-3'
  | 'lapsed_member_admin_reactivation_reminder_t-1';

export const REMINDER_LADDER_AUDIT_TYPES: ReadonlyArray<ReminderLadderAuditType> = [
  'lapsed_member_admin_reactivation_reminder_t-7',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-1',
];

export interface ReminderAuditQueryPort {
  /**
   * Returns the set of reminder-ladder audit event types that have
   * already been emitted for the given cycle. The cron uses the
   * complement of this set (`REMINDER_LADDER_AUDIT_TYPES \ result`)
   * to decide which reminders to emit on the current run.
   *
   * Index path: `audit_log_event_type_idx` + `audit_log_tenant_id_idx`
   * combined; cardinality is bounded (< 100 lapsed members per tenant
   * at MVP, so a single-tenant query touches < 300 rows total).
   */
  findReminderAuditsForCycle(
    tenantId: string,
    cycleId: string,
  ): Promise<ReadonlySet<ReminderLadderAuditType>>;
}
