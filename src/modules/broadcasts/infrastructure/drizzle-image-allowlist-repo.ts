/**
 * T027 (F7.1a US2) — Drizzle `ImageAllowlistPort` adapter skeleton.
 *
 * Real implementation lands in Phase 4 T072 `manage-image-allowlist.ts`
 * use case wave — this Phase 2 skeleton:
 *   - Imports the port interface + Drizzle schema for type-binding
 *   - Provides a factory `makeDrizzleImageAllowlistRepo()` matching F7
 *     MVP composition-root convention
 *   - Stubs each method with `notImplemented()` so callers fail loud
 *     if the production path is wired prematurely
 *
 * The skeleton is exported from this file but NOT from the public
 * barrel `src/modules/broadcasts/index.ts` (Constitution Principle III
 * — Infrastructure adapters never cross the barrel; composition root
 * `broadcasts-deps.ts` wires them inline). When Phase 4 implements the
 * real adapter, replace each method body — no changes to call sites.
 *
 * Tenant scoping pattern (will land in Phase 4): every read/write
 * runs inside `runInTenant(asTenantContext(tenantId), async (tx) =>
 * { ... })`. RLS+FORCE (migration 0166) provides storage-layer
 * tenant isolation as a belt-and-braces guard.
 */

import { db } from '@/lib/db';
import type {
  AllowlistEntry,
  AllowlistAddError,
  AllowlistRemoveError,
  Hostname,
  ImageAllowlistPort,
} from '../application/ports/image-allowlist-port';
import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { tenantImageSourceAllowlist } from './schema';

function notImplemented(label: string): never {
  throw new Error(
    `[drizzle-image-allowlist-repo] ${label} not implemented — real impl lands in Phase 4 T072 manage-image-allowlist.ts`,
  );
}

export function makeDrizzleImageAllowlistRepo(): ImageAllowlistPort {
  // `db` + `tenantImageSourceAllowlist` are imported here so the
  // skeleton compiles with the same dependency graph the real impl
  // will use. Marked void to suppress unused-imports lint while in
  // skeleton state.
  void db;
  void tenantImageSourceAllowlist;

  return {
    async findByTenantId(_tenantId: TenantSlug): Promise<readonly AllowlistEntry[]> {
      notImplemented('findByTenantId');
    },
    async add(
      _tenantId: TenantSlug,
      _hostname: Hostname,
      _actorUserId: string,
    ): Promise<Result<void, AllowlistAddError>> {
      notImplemented('add');
    },
    async remove(
      _tenantId: TenantSlug,
      _hostname: Hostname,
    ): Promise<Result<void, AllowlistRemoveError>> {
      notImplemented('remove');
    },
  };
}
