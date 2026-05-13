/**
 * `role_violation_blocked` audit emitter for
 * `/api/admin/integrations/eventcreate/**` route handlers (FR-035
 * surface-disclosure pattern).
 *
 * Parallel to `src/app/api/admin/events/_lib/role-violation-audit.ts`
 * with the same behavioural contract:
 *   1. `resolveTenantFromRequest` outside the audit-emit try so a
 *      host-header / tenant-validation failure surfaces under a
 *      distinct discriminator instead of being mislabelled as
 *      `f6_audit_emit_failed`.
 *   2. Audit emit failure NEVER blocks the 404 response.
 *   3. `actorUserId` is nullable — never the sentinel UUID.
 *   4. `actorRole` typed as the narrowed Role union so a future role
 *      addition surfaces as a COMPILE error at the call site.
 */
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { makeStandaloneAuditDeps } from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';

export interface EmitIntegrationRoleViolationInput {
  readonly actorUserId: string | null;
  readonly actorRole: 'member' | 'manager';
  readonly attemptedRoute: string;
  /** Short action identifier (e.g. `'generate_webhook_secret'`). */
  readonly attemptedAction: string;
}

export async function emitIntegrationRoleViolation(
  request: NextRequest,
  input: EmitIntegrationRoleViolationInput,
): Promise<void> {
  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'tenant_resolve_failed_during_role_violation_audit',
        err: e instanceof Error ? e.message : String(e),
        attemptedRoute: input.attemptedRoute,
      },
      '[F6] tenant resolution failed during role_violation_blocked emit — 404 still served',
    );
    return;
  }

  const summary = `${input.actorRole} attempted POST ${input.attemptedRoute} (${input.attemptedAction})`;
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

/**
 * Common admin-only guard for the 5 integration endpoints. Returns
 * `null` when the actor is admin (caller proceeds); returns a 404
 * Response otherwise (caller returns immediately). Emits the
 * `role_violation_blocked` audit on every manager/member attempt;
 * silent on no-session (no actor to attribute).
 *
 * Signature mirrors `getCurrentSession` semantics: caller receives the
 * admin user when allowed.
 */
export async function adminOnlyGuard(
  request: NextRequest,
  input: { readonly attemptedRoute: string; readonly attemptedAction: string },
): Promise<
  | { kind: 'allow'; actorUserId: string }
  | { kind: 'deny'; response: Response }
> {
  // Lazy-import getCurrentSession to keep the helper free of session
  // type imports at module top-level (test mocks vi.mock the
  // auth-session module at test load time).
  const { getCurrentSession } = await import('@/lib/auth-session');
  const session = await getCurrentSession();
  if (!session) {
    return { kind: 'deny', response: new Response(null, { status: 404 }) };
  }
  const role = session.user.role;
  if (role !== 'admin') {
    await emitIntegrationRoleViolation(request, {
      actorUserId: session.user.id,
      actorRole: role,
      attemptedRoute: input.attemptedRoute,
      attemptedAction: input.attemptedAction,
    });
    return { kind: 'deny', response: new Response(null, { status: 404 }) };
  }
  return { kind: 'allow', actorUserId: session.user.id };
}

/**
 * Derive the webhook base URL (origin + scheme) from the incoming
 * request URL. Used so test-webhook + GET-config can compose the full
 * webhook URL without hardcoding the production hostname.
 */
export function deriveWebhookBaseUrl(request: NextRequest): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
