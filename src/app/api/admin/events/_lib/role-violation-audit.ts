/**
 * Shared `role_violation_blocked` audit emitter for `/api/admin/events/**`
 * route handlers (FR-035 surface-disclosure pattern).
 *
 * Extracts the duplicated 50-line try/catch shell that was previously
 * inlined in both `route.ts` + `[eventId]/route.ts`. The only divergence
 * across consumers is the (attemptedRoute, attemptedAction, summary)
 * triple, so they become explicit parameters.
 *
 * Behavioural contract preserved from the prior inline versions:
 *   1. `resolveTenantFromRequest` is called OUTSIDE the audit-emit try so
 *      a host-header / tenant-validation failure surfaces under the
 *      distinct `tenant_resolve_failed_during_role_violation_audit`
 *      discriminator instead of being mislabelled as
 *      `f6_audit_emit_failed` (E5 round-1 hardening).
 *   2. Audit emit failure NEVER blocks the 404 response (F1 round-1) —
 *      caught + logged at `error` level with `event: 'f6_audit_emit_failed'`.
 *   3. `actorUserId` is properly nullable (L-C round-3) — no sentinel UUID.
 *   4. `actorRole` is typed as the narrowed Role union (`'member' | 'manager'`)
 *      so a future role addition surfaces as a COMPILE error at the call
 *      site, not a silent audit mis-labelling (HIGH-1 round-3).
 */
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { makeStandaloneAuditDeps } from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';

export interface EmitEventsRoleViolationInput {
  readonly actorUserId: string | null;
  readonly actorRole: 'member' | 'manager';
  /** Route path (without protocol/host) for the audit payload. */
  readonly attemptedRoute: string;
  /** Short action identifier (e.g. `'list_events'`, `'load_event_detail'`). */
  readonly attemptedAction: string;
  /**
   * Optional eventId for the detail-route variant — appended to the
   * human-readable `summary` field and used in the discriminator log
   * if tenant resolution throws. Caller passes `null` on the list route.
   */
  readonly eventId: string | null;
}

export async function emitEventsRoleViolation(
  request: NextRequest,
  input: EmitEventsRoleViolationInput,
): Promise<void> {
  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'tenant_resolve_failed_during_role_violation_audit',
        err: e instanceof Error ? e.message : String(e),
        ...(input.eventId !== null ? { eventId: input.eventId } : {}),
      },
      '[F6] tenant resolution failed during role_violation_blocked emit — 404 still served',
    );
    return;
  }
  // R006 (staff-review fix 2026-05-13): differentiate the detail-route
  // branch by appending the eventId — the previous ternary's two arms
  // were byte-identical, which was the original interface lie that
  // the doc-comment + `eventId` parameter implied this helper would
  // surface in the summary. The detail-route eventId is now guaranteed
  // length-capped (≤200 chars) by the R002 fix in [eventId]/route.ts,
  // so appending cannot bloat the audit row.
  const summary =
    input.eventId !== null
      ? `${input.actorRole} attempted GET ${input.attemptedRoute} (${input.attemptedAction}) for event ${input.eventId}`
      : `${input.actorRole} attempted GET ${input.attemptedRoute} (${input.attemptedAction})`;
  try {
    const deps = makeStandaloneAuditDeps();
    await deps.emitStandalone({
      eventType: 'role_violation_blocked',
      tenantId: asTenantId(tenantSlug),
      actorType: input.actorRole,
      actorUserId: input.actorUserId ? asUserId(input.actorUserId) : null,
      occurredAt: new Date(),
      summary,
      payload: {
        severity: 'warn',
        actorUserId: input.actorUserId ? asUserId(input.actorUserId) : null,
        actorRole: input.actorRole,
        attemptedRoute: input.attemptedRoute,
        attemptedAction: input.attemptedAction,
        blockedAt: 'app_layer',
      },
    });
  } catch (e) {
    logger.error(
      { event: 'f6_audit_emit_failed', err: e instanceof Error ? e.message : String(e) },
      '[F6] role_violation_blocked audit emit failed — 404 response still served',
    );
  }
}
