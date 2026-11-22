/**
 * PR B (#707 follow-up) — read the tenant's renewal reminder Reply-To for the
 * admin settings page. Nulls when the tenant has no settings row yet.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errClassWithCode, errKind } from '@/lib/log-id';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export interface RenewalReplyTo {
  readonly email: string | null;
  readonly displayName: string | null;
}

export type LoadRenewalReplyToError = { readonly kind: 'server_error'; readonly message: string };

export async function loadRenewalReplyTo(
  deps: Pick<RenewalsDeps, 'tenantRenewalSettingsRepo'>,
  tenantId: string,
): Promise<Result<RenewalReplyTo, LoadRenewalReplyToError>> {
  try {
    const settings = await deps.tenantRenewalSettingsRepo.findByTenant(tenantId);
    return ok({
      email: settings?.replyToEmail ?? null,
      displayName: settings?.replyToDisplayName ?? null,
    });
  } catch (e) {
    logger.error({ err: errKind(e), tenantId }, 'loadRenewalReplyTo: read failed');
    return err({ kind: 'server_error', message: errClassWithCode(e) });
  }
}
