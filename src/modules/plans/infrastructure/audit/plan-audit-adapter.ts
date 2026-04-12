/**
 * `plan-audit-adapter.ts` — F2 `AuditPort` implementation.
 *
 * Writes F2 audit events into the F1 `audit_log` table (extended by
 * migration 0007 with nullable `payload jsonb` + `tenant_id text`
 * columns). The F1 `audit_log_immutable` trigger continues to enforce
 * append-only at the database layer — this adapter only calls
 * INSERT, never UPDATE or DELETE.
 *
 * RLS behaviour:
 *   - `audit_log` has a PERMISSIVE policy that accepts NULL tenant_id
 *     rows (F1 identity events) AND rows matching
 *     `current_setting('app.current_tenant')`.
 *   - F2 events always set `tenant_id` to the originating tenant slug,
 *     so `runInTenant(ctx, ...)` is sufficient to satisfy the WITH
 *     CHECK clause.
 *
 * Shape validation:
 *   - `record()` calls `auditPayloadSchema.safeParse(event)` before
 *     inserting. A malformed payload returns
 *     `err({type: 'invalid_payload'})` — the use case decides whether
 *     to log + abort or swallow. The contract tests round-trip every
 *     payload through the same schema to guarantee writer + tests
 *     cannot drift.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  auditPayloadSchema,
  type F2AuditEvent,
} from '../../domain/audit-event';
import type {
  AuditContext,
  AuditError,
  AuditPort,
} from '../../application/ports';

/**
 * Derive a human-readable summary from a structured audit event. Kept
 * under 500 chars to match F1's `audit_log.summary` length constraint.
 *
 * Summary lines are stable-ish machine-parseable strings — observability
 * queries in Vercel log-drain can grep them, but the authoritative
 * structured data lives in `payload jsonb` for programmatic analysis.
 */
function summariseEvent(event: F2AuditEvent): string {
  switch (event.event_type) {
    case 'plan_created':
      return `plan_created ${event.payload.plan_id}@${event.payload.plan_year} ${event.payload.category}/${event.payload.member_type_scope} fee=${event.payload.annual_fee_minor_units}`;
    case 'plan_updated': {
      const fields = Object.keys(event.payload.diff).join(',');
      return `plan_updated ${event.payload.plan_id}@${event.payload.plan_year} fields=[${fields}]`;
    }
    case 'plan_cloned':
      return `plan_cloned ${event.payload.source_year}→${event.payload.target_year} count=${event.payload.count}`;
    case 'plan_activated':
      return `plan_activated ${event.payload.plan_id}@${event.payload.plan_year}`;
    case 'plan_deactivated':
      return `plan_deactivated ${event.payload.plan_id}@${event.payload.plan_year}`;
    case 'plan_soft_deleted':
      return `plan_soft_deleted ${event.payload.plan_id}@${event.payload.plan_year}`;
    case 'plan_undeleted':
      return `plan_undeleted ${event.payload.plan_id}@${event.payload.plan_year}`;
    case 'plan_not_found':
      return `plan_not_found ${event.payload.requested_plan_id}@${event.payload.requested_year} ${event.payload.method} ${event.payload.route}`;
    case 'plan_cross_tenant_probe':
      return `plan_cross_tenant_probe ${event.payload.requested_plan_id} actor=${event.payload.actor_user_id} reason=${event.payload.escalation_reason}`;
    case 'fee_config_updated': {
      const fields = Object.keys(event.payload.diff).join(',');
      return `fee_config_updated fields=[${fields}]`;
    }
  }
}

export const planAuditAdapter: AuditPort = {
  async record(ctx: AuditContext, event: F2AuditEvent): Promise<Result<void, AuditError>> {
    // Defence-in-depth: validate payload shape against the normative
    // discriminated-union schema before writing. Prevents a typo in a
    // use case from silently corrupting the audit log with a malformed
    // diff shape.
    const parsed = auditPayloadSchema.safeParse(event);
    if (!parsed.success) {
      return err({
        type: 'invalid_payload',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    try {
      await runInTenant(ctx.tenant, async (tx) => {
        await tx.insert(auditLog).values({
          eventType: event.event_type,
          actorUserId: ctx.actorUserId,
          // targetUserId is F1-specific (sign-in target etc.) — F2 events
          // operate on plans, not users, so we leave it NULL.
          targetUserId: null,
          sourceIp: ctx.sourceIp,
          summary: summariseEvent(event).slice(0, 500),
          requestId: ctx.requestId,
          payload: event.payload,
          tenantId: ctx.tenant.slug,
        });
      });
      return ok(undefined);
    } catch (e) {
      return err({
        type: 'persist_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
