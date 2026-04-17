/**
 * F3 audit adapter — writes AuditPort events to the shared audit_log table.
 *
 * The F1+F2 audit_log append-only trigger forbids UPDATE/DELETE; this adapter
 * only inserts. The AFTER INSERT trigger from migration 0009 bumps
 * members.last_activity_at when payload carries member_id.
 */

import { ok, err } from '@/lib/result';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { AuditPort } from '../../application/ports/audit-port';

export const drizzleAuditAdapter: AuditPort = {
  async record(ctx, event) {
    try {
      await db.insert(auditLog).values({
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
