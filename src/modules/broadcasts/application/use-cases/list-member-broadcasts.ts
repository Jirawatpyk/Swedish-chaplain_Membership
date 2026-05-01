/**
 * F7 US3 — `list-member-broadcasts.ts` Application use-case.
 *
 * Thin wrapper over `BroadcastsRepo.listForMemberPaginated` so the
 * page server-component can stay inside the F7 public barrel
 * (Constitution Principle III). No business logic — just
 * port-routed pagination.
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { Broadcast } from '../../domain/broadcast';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

export interface ListMemberBroadcastsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
}

export interface ListMemberBroadcastsInput {
  readonly memberId: MemberId;
  readonly page: number;
  readonly perPage: number;
}

export interface ListMemberBroadcastsOutput {
  readonly rows: ReadonlyArray<Broadcast>;
  readonly total: number;
  readonly totalPages: number;
  readonly page: number;
}

export async function listMemberBroadcasts(
  deps: ListMemberBroadcastsDeps,
  input: ListMemberBroadcastsInput,
): Promise<ListMemberBroadcastsOutput> {
  return deps.broadcastsRepo.listForMemberPaginated(
    deps.tenant.slug,
    input.memberId,
    { page: input.page, perPage: input.perPage },
  );
}
