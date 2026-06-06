/**
 * Pass A · Section 1 — `loadMemberRenewalStatus`.
 *
 * Admin-facing narrow read backing the member-detail "Renewal & Health"
 * card. Returns the member's MOST-RECENT renewal cycle of ANY status
 * (active / awaiting_payment / pending_admin_reactivation / lapsed /
 * completed / cancelled), or `null` when the member has no cycle yet.
 *
 * Why a dedicated read (not `loadRenewalSummary`): `loadRenewalSummary`
 * resolves a cycle from a known `cycleId` (the public renewal page already
 * has it from a verified token). The admin detail page only has a
 * `memberId`, so it needs a memberId→latest-cycle lookup. This wraps the
 * existing `cyclesRepo.list` port — the exact `({ memberIdFilter,
 * pageSize: 1, sort: 'created_at_desc' })` query the 3-lens review cited —
 * so no new repo method is introduced.
 *
 * Tenant isolation: the `cyclesRepo.list` Drizzle adapter wraps its query
 * in `runInTenant(ctx, …)` (Postgres RLS+FORCE, `SET LOCAL
 * app.current_tenant`) — never the raw `db` singleton. This use-case never
 * touches a DB client directly (Constitution Principle I two-layer
 * isolation; Principle III port discipline).
 *
 * Reads only — emits no audit + never mutates. A repo throw degrades to
 * `server_error` so the section can render an em-dash rather than crash
 * the parent member-detail page.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { RenewalCycle } from '../../domain/renewal-cycle';

export interface LoadMemberRenewalStatusInput {
  readonly tenantId: string;
  readonly memberId: string;
}

export interface LoadMemberRenewalStatusOutput {
  /** Most-recent cycle of any status, or null when the member has none. */
  readonly cycle: RenewalCycle | null;
}

export type LoadMemberRenewalStatusError = {
  readonly kind: 'server_error';
};

export async function loadMemberRenewalStatus(
  deps: Pick<RenewalsDeps, 'cyclesRepo'>,
  input: LoadMemberRenewalStatusInput,
): Promise<
  Result<LoadMemberRenewalStatusOutput, LoadMemberRenewalStatusError>
> {
  try {
    const page = await deps.cyclesRepo.list(input.tenantId, {
      memberIdFilter: input.memberId,
      pageSize: 1,
      sort: 'created_at_desc',
    });
    return ok({ cycle: page.items[0] ?? null });
  } catch (e) {
    logger.warn(
      {
        // errKind logs only the error class name — never e.message
        // (Postgres errors carry SQL params / table names in message).
        errKind: errKind(e),
        tenantId: input.tenantId,
        memberId: input.memberId,
      },
      '[load-member-renewal-status] cyclesRepo.list threw — degrading to server_error',
    );
    return err({ kind: 'server_error' });
  }
}
