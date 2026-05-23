/**
 * F3 audit adapter — writes AuditPort events to the shared audit_log table.
 *
 * The F1+F2 audit_log append-only trigger forbids UPDATE/DELETE; this adapter
 * only inserts. The AFTER INSERT trigger from migration 0009 bumps
 * members.last_activity_at when payload carries member_id.
 */

import { ok, err } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { AuditPort } from '../../application/ports/audit-port';

export const drizzleAuditAdapter: AuditPort = {
  async record(ctx, event) {
    // Standalone (non-tx) audit write. Routed through `runInTenant` — NOT the
    // global `db` singleton — so the insert runs under the tenant-scoped
    // `chamber_app` role with `app.current_tenant` set. This keeps the
    // `audit_log` RLS `WITH CHECK` (migration 0007) as a DB-layer backstop
    // against a forged `tenant_id`, matching the mandatory tenant-scoped-write
    // pattern. `recordInTx` is the variant for callers already inside a tx.
    try {
      await runInTenant(ctx, (tx) =>
        tx.insert(auditLog).values({
          eventType: event.type,
          actorUserId: event.actorUserId,
          ...(event.targetUserId !== undefined && {
            targetUserId: event.targetUserId,
          }),
          summary: event.summary,
          requestId: event.requestId,
          tenantId: ctx.slug,
          payload: event.payload,
        }),
      );
      return ok(undefined);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async recordInTx(tx, ctx, event) {
    try {
      await tx.insert(auditLog).values({
        eventType: event.type,
        actorUserId: event.actorUserId,
        ...(event.targetUserId !== undefined && {
          targetUserId: event.targetUserId,
        }),
        summary: event.summary,
        requestId: event.requestId,
        tenantId: ctx.slug,
        payload: event.payload,
      });
      return ok(undefined);
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
