/**
 * F114 — the portal edit page's read of the caller's OWN pending change
 * request (round 5, silent-failure #1). A fault used to read as "no pending
 * request": the form then prefilled from the LIVE record and the member's
 * next submit REPLACED their pending proposal (withdrawn as `replaced`, its
 * staff row closed as `request_superseded`) without anyone noticing. A fault
 * is a fault — the page renders its load error.
 */
import { runInTenant } from '@/lib/db';
import { errKind } from '@/lib/log-id';
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ChangeRequestRepo } from '@/modules/members/application/ports/change-request-repo';
import type { ChangeRequest } from '@/modules/members/domain/change-request/change-request';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';

export type OwnPendingReadError = { readonly type: 'read_failed'; readonly code: string };

export async function readOwnPendingRequest(
  repo: Pick<ChangeRequestRepo, 'findPendingBySubmitterInTx'>,
  tenant: TenantContext,
  userId: UserId,
): Promise<Result<ChangeRequest | null, OwnPendingReadError>> {
  try {
    const result = await runInTenant(tenant, (tx) => repo.findPendingBySubmitterInTx(tx, userId));
    if (!result.ok) return err({ type: 'read_failed', code: result.error.code });
    return ok(result.value);
  } catch (e) {
    return err({ type: 'read_failed', code: errKind(e) });
  }
}
