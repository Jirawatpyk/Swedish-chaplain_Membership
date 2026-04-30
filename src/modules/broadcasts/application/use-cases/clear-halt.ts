/**
 * T114 — `clear-halt.ts` Application use-case (F7 US2 / Q14 + R3-NEW-3).
 *
 * Admin clear-halt action when a member's
 * `broadcasts_halted_until_admin_review = true` flag is set (auto-halt
 * triggered by webhook on >5% complaint rate per single broadcast).
 *
 * Calls F3 `MembersBridgePort.setMemberHalt(memberId, false)` then
 * emits `broadcast_member_dispatch_resumed` audit (F7-owned event;
 * F3 use-case mutates the flag column only — F3 audit-port doesn't
 * include cross-module event types per Batch C architectural deviation).
 *
 * Manager role denied at route layer; use-case stays admin-callable
 * for unit testing without route boundary.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';

export type ClearHaltError =
  | { readonly kind: 'member_not_found'; readonly memberId: string }
  | { readonly kind: 'forbidden'; readonly reason: string }
  | { readonly kind: 'clear_halt.server_error'; readonly message: string };

export interface ClearHaltDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface ClearHaltInput {
  readonly memberId: string;
  /** Acting admin user id — recorded in audit. */
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface ClearHaltOutput {
  readonly memberId: string;
  readonly clearedAt: Date;
}

export async function clearHalt(
  deps: ClearHaltDeps,
  input: ClearHaltInput,
): Promise<Result<ClearHaltOutput, ClearHaltError>> {
  const now = deps.clock.now();
  try {
    const result = await deps.membersBridge.setMemberHalt(
      deps.tenant,
      input.memberId,
      false,
    );
    if (!result.ok) {
      if (result.error.kind === 'member_halt.member_not_found') {
        return err({ kind: 'member_not_found', memberId: input.memberId });
      }
      return err({
        kind: 'forbidden',
        reason: result.error.kind,
      });
    }

    try {
      await deps.audit.emit(null, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_member_dispatch_resumed',
        actorUserId: input.actorUserId,
        summary: `Halt cleared for member ${input.memberId} by admin ${input.actorUserId}`,
        payload: {
          memberId: input.memberId,
          clearedByUserId: input.actorUserId,
          clearedAt: now.toISOString(),
        },
        requestId: input.requestId,
      });
    } catch (auditErr) {
      // Round-4 HIGH-A — never 5xx the request because audit failed,
      // BUT never silently lose the GDPR / forensic record. Log at
      // error severity so ops can re-emit by hand from the column
      // timestamp if needed (`setMemberHalt(false)` already succeeded).
      logger.error(
        {
          err: auditErr instanceof Error ? auditErr.message : String(auditErr),
          tenantId: deps.tenant.slug,
          memberId: input.memberId,
          actorUserId: input.actorUserId,
        },
        'broadcasts.clear_halt.audit_emit_failed',
      );
    }

    return ok({ memberId: input.memberId, clearedAt: now });
  } catch (e) {
    return err({
      kind: 'clear_halt.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
