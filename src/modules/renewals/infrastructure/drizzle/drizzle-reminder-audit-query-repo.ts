/**
 * Drizzle adapter for `ReminderAuditQueryPort`.
 *
 * Reads `audit_log` filtered by tenant + reminder-ladder event_type +
 * `payload->>'cycle_id'`. The audit_log RLS policy is permissive
 * (cross-tenant visibility for super-admin compliance), so we still
 * apply a `WHERE tenant_id = ?` predicate explicitly.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  REMINDER_LADDER_AUDIT_TYPES,
  type ReminderAuditQueryPort,
  type ReminderLadderAuditType,
  type RenewalLapsedAuditInfo,
} from '../../application/ports/reminder-audit-query-repo';

export const drizzleReminderAuditQueryRepo: ReminderAuditQueryPort = {
  async findReminderAuditsForCycle(
    tenantId: string,
    cycleId: string,
  ): Promise<ReadonlySet<ReminderLadderAuditType>> {
    // Use a raw `IN (…)` against the enum column — drizzle's `inArray`
    // helper narrows to the audit_event_type literal union at TS level
    // and refuses string[] inputs even though the values match. The
    // raw SQL preserves both safety (still parameterised) and type
    // ergonomics for a port that lives in the application layer.
    const rows = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          sql`${auditLog.eventType} = ANY(ARRAY[${sql.join(
            REMINDER_LADDER_AUDIT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )}]::audit_event_type[])`,
          sql`${auditLog.payload}->>'cycle_id' = ${cycleId}`,
        ),
      );
    const out = new Set<ReminderLadderAuditType>();
    for (const r of rows) {
      out.add(r.eventType as ReminderLadderAuditType);
    }
    return out;
  },

  async findRenewalLapsedForCycle(
    tenantId: string,
    cycleId: string,
  ): Promise<RenewalLapsedAuditInfo | null> {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          sql`${auditLog.eventType} = 'renewal_lapsed'::audit_event_type`,
          sql`${auditLog.payload}->>'cycle_id' = ${cycleId}`,
        ),
      )
      .orderBy(sql`${auditLog.timestamp} DESC`)
      .limit(1);
    const payload = rows[0]?.payload as
      | { termination_basis?: unknown; due_date?: unknown }
      | undefined;
    if (!payload) return null;
    const tb = payload.termination_basis;
    return {
      terminationBasis:
        tb === 'due_plus_60' || tb === 'no_invoice_backstop' ? tb : null,
      dueDate: typeof payload.due_date === 'string' ? payload.due_date : null,
    };
  },
};
