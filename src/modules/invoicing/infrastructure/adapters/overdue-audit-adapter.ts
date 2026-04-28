/**
 * T109 — `overdueAuditAdapter` — INSERT … ON CONFLICT DO NOTHING
 * against the partial unique index `audit_log_overdue_once_per_day`
 * (migration 0021).
 *
 * Runs on the `db` singleton (auto-commit). Overdue detection is a
 * read-path opportunistic emit; wrapping in `runInTenant` would
 * couple audit success to the reader's tenant context AND surface
 * RLS semantics (audit_log is platform-scoped, not RLS-gated at the
 * app service role). Keeping it auto-commit mirrors the audit-port
 * fallback pattern for cross-tenant probes.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type {
  OverdueAuditPort,
  OverdueDetectedEvent,
} from '../../application/ports/overdue-audit-port';

export const overdueAuditAdapter: OverdueAuditPort = {
  async emitOverdueOnce(event: OverdueDetectedEvent): Promise<boolean> {
    const payload = {
      invoice_id: event.invoiceId,
      member_id: event.memberId,
      document_number: event.documentNumber,
      due_date: event.dueDate,
      detected_bangkok_date: event.bangkokLocalDate,
    };
    const requestId = event.requestId ?? 'no-request-id';
    const summary = `Invoice ${event.documentNumber ?? event.invoiceId} detected overdue on ${event.bangkokLocalDate}`;

    try {
      // The partial unique index `audit_log_overdue_once_per_day`
      // (tenant_id, payload->>'invoice_id', ((timestamp AT TIME ZONE
      // 'Asia/Bangkok')::date)) guarantees at-most-once per day. ON
      // CONFLICT targets it by column list + WHERE predicate (the
      // index is partial, so Postgres requires the predicate to
      // disambiguate from a hypothetical non-partial sibling). RETURNING
      // lets us distinguish "new row" from "duplicate swallowed".
      // T135 fix (2026-04-27): set retention_years=5 explicitly per F4
      // mapping (data-model 009 § 7.2 — operational, not tax-document).
      const rows = await db.execute<{ inserted: number }>(sql`
        INSERT INTO audit_log
          (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
        VALUES
          ('invoice_overdue_detected'::audit_event_type,
           ${event.actorUserId},
           ${summary},
           ${requestId},
           ${JSON.stringify(payload)}::jsonb,
           ${event.tenantId},
           5)
        ON CONFLICT (
          tenant_id,
          (payload->>'invoice_id'),
          ((timestamp AT TIME ZONE 'Asia/Bangkok')::date)
        )
        WHERE event_type = 'invoice_overdue_detected'
        DO NOTHING
        RETURNING 1 AS inserted
      `);
      return rows.length === 1;
    } catch (error) {
      // Defensive: adapter swallows genuine infra failures so the
      // read path never 500s on best-effort audit. Pino captures the
      // stack for post-hoc forensics.
      logger.warn(
        {
          err: error,
          tenantId: event.tenantId,
          invoiceId: event.invoiceId,
        },
        'overdue-audit emit failed — read path continues',
      );
      return false;
    }
  },
};
