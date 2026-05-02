/**
 * F3 use-case — write `members.preferred_locale` (R4 verify-fix
 * Types-#6 admin + member-self-service write path).
 *
 * Idempotency: when the next value equals the current value, the
 * use-case short-circuits with `unchanged` outcome (no UPDATE, no
 * audit emit) — admin clicks the same option twice + no spurious
 * audit rows.
 *
 * Atomic: load + UPDATE + audit emit happen inside a single
 * `runInTenant` transaction. Member-not-found → typed `not_found`
 * outcome (no audit, no error).
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { AuditPort } from '../ports/audit-port';
import type { MemberRepo } from '../ports/member-repo';

// R5 verify-fix Types-#H8 (2026-05-02): alias canonical Locale instead
// of duplicating the union literal. Adding a 4th locale in
// `src/i18n/config.ts` now propagates here automatically.
export type LocaleLiteral = import('@/i18n/config').Locale;

export type SetMemberPreferredLocaleActor =
  | { readonly kind: 'admin'; readonly userId: string }
  | { readonly kind: 'member_self_service'; readonly userId: string };

export type SetMemberPreferredLocaleOutcome =
  | { readonly kind: 'updated'; readonly previousValue: LocaleLiteral | null; readonly nextValue: LocaleLiteral | null }
  | { readonly kind: 'unchanged'; readonly currentValue: LocaleLiteral | null }
  | { readonly kind: 'not_found' };

export type SetMemberPreferredLocaleError =
  | { readonly kind: 'repo_error'; readonly cause: unknown };

export interface SetMemberPreferredLocaleDeps {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
  readonly audit: AuditPort;
}

export interface SetMemberPreferredLocaleInput {
  readonly memberId: MemberId;
  readonly nextValue: LocaleLiteral | null;
  readonly actor: SetMemberPreferredLocaleActor;
  readonly requestId: string | null;
}

export async function setMemberPreferredLocale(
  deps: SetMemberPreferredLocaleDeps,
  input: SetMemberPreferredLocaleInput,
): Promise<Result<SetMemberPreferredLocaleOutcome, SetMemberPreferredLocaleError>> {
  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const currentResult = await deps.memberRepo.findPreferredLocaleInTx(
        tx,
        input.memberId,
      );
      if (!currentResult.ok) {
        return err({ kind: 'repo_error', cause: currentResult.error });
      }
      const currentValue = currentResult.value;

      if (currentValue === input.nextValue) {
        return ok({ kind: 'unchanged', currentValue });
      }

      const updateResult = await deps.memberRepo.updatePreferredLocaleInTx(
        tx,
        input.memberId,
        input.nextValue,
      );
      if (!updateResult.ok) {
        return err({ kind: 'repo_error', cause: updateResult.error });
      }
      if (updateResult.value.affected === 0) {
        return ok({ kind: 'not_found' });
      }

      await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_preferred_locale_changed',
        actorUserId: input.actor.userId,
        requestId: input.requestId ?? '',
        summary: `Member ${input.memberId} preferred_locale ${currentValue ?? 'null'} → ${input.nextValue ?? 'null'} by ${input.actor.kind}`,
        payload: {
          memberId: input.memberId as string,
          previousValue: currentValue,
          nextValue: input.nextValue,
          actorRole:
            input.actor.kind === 'admin' ? 'admin' : 'member_self_service',
        },
      });

      return ok({
        kind: 'updated',
        previousValue: currentValue,
        nextValue: input.nextValue,
      });
    });
  } catch (e) {
    // R5 verify-fix Errors-H4 (2026-05-02): log at error before
    // returning structured result. Defends against callers that wrap
    // the use-case without logging at their own boundary (e.g. CLI
    // scripts, future cron). The HTTP routes also log on `!result.ok`
    // — duplicate is acceptable; missing log is not.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        memberId: input.memberId,
      },
      'members.set_preferred_locale.unexpected',
    );
    return err({ kind: 'repo_error', cause: e });
  }
}
