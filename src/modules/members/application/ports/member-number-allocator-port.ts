/**
 * Application port — per-tenant human-readable member-number allocator
 * (055-member-number, §5).
 *
 * Protocol (design §5): advisory xact lock on `members:{tenantId}` +
 * `INSERT … ON CONFLICT DO NOTHING` seed + `UPDATE … RETURNING` of the
 * incremented counter. The advisory lock alone serialises every writer,
 * so — unlike the F4 sequence allocator — there is NO `SELECT … FOR
 * UPDATE`. Implementation: `infrastructure/repos/drizzle-member-number-allocator.ts`.
 *
 * MUST be called as the FIRST statement inside the `createMember`
 * `runInTenant(tenant, async (tx) => …)` lambda, before
 * `createWithPrimaryContactInTx`. Running outside that tx uses a
 * pool-fresh connection without `SET LOCAL app.current_tenant` and
 * silently bypasses RLS (F7.1a US2 incident class — CLAUDE.md § Gotchas).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantId } from '../../domain/member';
import type { MemberNumber } from '../../domain/value-objects/member-number';

export interface MemberNumberAllocatorPort {
  /**
   * Allocate the next member number for `tenantId` INSIDE the caller's
   * tenant-scoped transaction. Seeds the per-tenant counter row on first
   * use. Returns the freshly allocated (post-increment) value as a
   * branded `MemberNumber`. Gaps are acceptable (a `createMember`
   * rollback unwinds the member row but leaves the counter incremented).
   */
  allocate(tx: TenantTx, tenantId: TenantId): Promise<MemberNumber>;
}
