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
 *      TRIPWIRE CURRENTLY SUPPRESSED: 016 PR 1 added `super_admin` +
 *      `marketing` to `Role` and silenced this compile error with an
 *      `as 'manager' | 'member'` cast at the call site (marked `016 PR1`).
 *      016 PR 2 sweeps these F6 routes onto the permission evaluator and
 *      widens `EmitIntegrationRoleViolationInput.actorRole` to the full
 *      staff-role union — remove the cast and this note together.
 */
import type { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { getCurrentSession } from '@/lib/auth-session';
import { canPerform } from '@/lib/rbac';
import { legacyF6Guard } from '@/modules/auth/domain/permissions/legacy-shim';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  assertCanonicalBaseUrl,
  assertCanonicalBaseUrlFromHeaders,
} from '@/lib/canonical-base-url';
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
 * Common admin-only guard for the integration endpoints (plus the two
 * import-history/error-csv readers). ADMISSION goes through the evaluator
 * (016 T029): OFF leg = the pre-016 admin-only check with D16 totalisation
 * (super_admin → admin passes — the literal `role !== 'admin'` used to 404
 * every promoted super_admin after Migration C; marketing/unknown denied);
 * ON leg = whoever holds the route's `permissionKey`. Denial SHAPE stays the
 * D9 404-for-all contract. Emits the `role_violation_blocked` audit on every
 * manager/member attempt; other denied roles get a warn log instead until
 * T033 widens the audit port's actor enum; silent on no-session (no actor to
 * attribute).
 *
 * Signature mirrors `getCurrentSession` semantics: caller receives the
 * allowed user's id.
 */
export async function adminOnlyGuard(
  request: NextRequest,
  input: {
    readonly permissionKey: PermissionKey;
    readonly attemptedRoute: string;
    readonly attemptedAction: string;
  },
): Promise<
  | { kind: 'allow'; actorUserId: string }
  | { kind: 'deny'; response: Response }
> {
  // Round-6 verify-fix 2026-05-13 (code #9) — replaced lazy dynamic
  // `await import('@/lib/auth-session')` with the top-level static
  // import. The lazy form added per-request overhead, obscured the
  // dep graph from bundler analysis, and was unnecessary for the
  // `vi.mock('@/lib/auth-session', …)` pattern (which intercepts at
  // module-resolution time regardless of import style; same precedent
  // as F5/F4 admin route helpers).
  const session = await getCurrentSession();
  if (!session) {
    return { kind: 'deny', response: new Response(null, { status: 404 }) };
  }
  const role = session.user.role;
  if (!canPerform(role, input.permissionKey, legacyF6Guard)) {
    if (role === 'manager' || role === 'member') {
      await emitIntegrationRoleViolation(request, {
        actorUserId: session.user.id,
        actorRole: role,
        attemptedRoute: input.attemptedRoute,
        attemptedAction: input.attemptedAction,
      });
    } else {
      // The audit port's actor enum only accepts 'manager' | 'member' until
      // T033 widens it — surface the denial in logs so it is observable.
      logger.warn(
        {
          event: 'f6_integration_guard_role_denied_unattributable',
          role,
          attemptedRoute: input.attemptedRoute,
        },
        '[F6] integration guard denied a role the audit port cannot attribute — 404 served',
      );
    }
    return { kind: 'deny', response: new Response(null, { status: 404 }) };
  }
  return { kind: 'allow', actorUserId: session.user.id };
}

/**
 * Derive the webhook base URL (origin + scheme) from the incoming
 * request URL. Used so test-webhook + GET-config can compose the full
 * webhook URL without hardcoding the production hostname.
 *
 * Round 2 (2026-05-13) — the host-allowlist logic was extracted to
 * `src/lib/canonical-base-url.ts` for testability + DB-import
 * isolation (T-Gap2 unit-test suite).
 */
export function deriveWebhookBaseUrl(request: NextRequest): string {
  return assertCanonicalBaseUrl(new URL(request.url).origin, '/api');
}

/**
 * Header-driven variant for RSC server components (no `NextRequest`
 * available). Same allowlist semantics — see
 * `assertCanonicalBaseUrlFromHeaders` for behaviour.
 */
export function deriveWebhookBaseUrlFromHeaders(
  proto: string | null,
  host: string | null,
): string {
  return assertCanonicalBaseUrlFromHeaders(proto, host);
}
