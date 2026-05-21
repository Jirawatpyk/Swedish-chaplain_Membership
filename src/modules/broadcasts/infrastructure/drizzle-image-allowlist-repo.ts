/**
 * T027 (F7.1a US2) — Drizzle `ImageAllowlistPort` adapter.
 *
 * Tenant scoping: every read/write goes through `runInTenant(ctx, fn)`
 * INSIDE the repo method (mirror of F7 MVP `drizzle-broadcasts-repo`
 * pattern — see lines 273, 388, 587, 657, 732, etc). This guarantees
 * the underlying postgres-js connection has `SET LOCAL ROLE chamber_app`
 * + `SET LOCAL app.current_tenant = <slug>` applied, so RLS+FORCE
 * (migration 0166) is the storage-layer guard.
 *
 * **CRITICAL fix (verify-run 2026-05-20)**: an earlier revision used
 * the global `db` client directly inside repo methods, which acquired
 * a fresh pool connection running as the BYPASSRLS owner role. That
 * silently disabled tenant isolation for all 4 methods — caught by
 * the T065 cross-tenant probe failing on UPDATE/DELETE assertions
 * (rows leaked across tenants). The fix wraps every method in
 * `runInTenant(asTenantContext(tenantId), async (tx) => …)` and uses
 * `tx` for every query.
 *
 * Defaults invariant (FR-010): `is_default=TRUE` rows are refused by
 * `remove()` — `cannot_remove_default` discriminant returned to the
 * use-case so the API surface can map to HTTP 403 + i18n message.
 *
 * Idempotent seed (`seedDefaults`): runs `ON CONFLICT DO NOTHING` on
 * the `(tenant_id, hostname)` unique index. The Phase 4 use-cases
 * call this lazily (admin settings page + uploadInlineImage + the
 * `seedPlatformDefaults` helper inside `manageImageAllowlist`) so a
 * fresh tenant's allowlist is never empty when the surface is first
 * touched.
 */
import { and, eq } from 'drizzle-orm';
import { runInTenant, withTenantTxOrOpen } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { describeStorageError } from '@/lib/db-errors';
import type {
  AllowlistAddError,
  AllowlistEntry,
  AllowlistRemoveError,
  Hostname,
  ImageAllowlistPort,
  ImageAllowlistTx,
} from '../application/ports/image-allowlist-port';
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { tenantImageSourceAllowlist } from './schema';

// `withTenantTx` lifted to `@/lib/db.withTenantTxOrOpen` 2026-05-21
// (review finding simplifier H4 — was byte-identical to the helper in
// `drizzle-broadcast-templates-repo.ts`). Local alias preserves the
// shorter name + ImageAllowlistTx-branded signature at the call sites
// below without forcing a type-cast at every consumer.
async function withTenantTx<T>(
  tenantId: TenantSlug,
  tx: ImageAllowlistTx | null | undefined,
  fn: (tx: import('@/lib/db').TenantTx) => Promise<T>,
): Promise<T> {
  // M5 Round 2 fix 2026-05-21: lib helper now accepts `TenantSlug` directly,
  // no `as unknown as string` cast needed.
  return withTenantTxOrOpen(tenantId, tx, fn);
}

// `describeStorageError` lifted to `@/lib/db-errors` 2026-05-21
// (review finding simplifier H3). Re-export not needed — direct import
// at the top of this file.

export function makeDrizzleImageAllowlistRepo(): ImageAllowlistPort {
  return {
    async withTx<T>(
      tenantId: TenantSlug,
      fn: (tx: ImageAllowlistTx) => Promise<T>,
    ): Promise<T> {
      return runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => fn(tx),
      );
    },

    async findByTenantId(
      tenantId: TenantSlug,
      tx?: ImageAllowlistTx | null,
    ): Promise<readonly AllowlistEntry[]> {
      // 2026-05-22 (post-/code-review borderline #2): when called from
      // within an active `withTx` (manage-image-allowlist `after`
      // snapshot read), thread the existing `tx` so the read joins the
      // atomicity boundary instead of opening a nested SAVEPOINT via
      // `runInTenant`. When `tx` is null/undefined (sanitiser hot path,
      // admin settings page read), `withTenantTx` opens its own
      // `runInTenant` for RLS binding. Either way the read runs under
      // `app.current_tenant` (RLS+FORCE migration 0166).
      return withTenantTx(tenantId, tx ?? null, async (innerTx) => {
        const rows = await innerTx
          .select({
            hostname: tenantImageSourceAllowlist.hostname,
            isDefault: tenantImageSourceAllowlist.isDefault,
          })
          .from(tenantImageSourceAllowlist)
          .where(eq(tenantImageSourceAllowlist.tenantId, tenantId as string));
        return rows.map((r) => ({
          hostname: r.hostname as Hostname,
          isDefault: r.isDefault,
        }));
      });
    },

    async seedDefaults(
      tenantId: TenantSlug,
      hostnames: readonly Hostname[],
    ): Promise<void> {
      if (hostnames.length === 0) return;
      await runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => {
          await tx
            .insert(tenantImageSourceAllowlist)
            .values(
              hostnames.map((h) => ({
                tenantId: tenantId as string,
                hostname: h as string,
                isDefault: true,
                createdByUserId: null,
              })),
            )
            .onConflictDoNothing({
              target: [
                tenantImageSourceAllowlist.tenantId,
                tenantImageSourceAllowlist.hostname,
              ],
            });
        },
      );
    },

    async add(
      tenantId: TenantSlug,
      hostname: Hostname,
      actorUserId: string,
      callerTx?: ImageAllowlistTx | null,
    ): Promise<Result<void, AllowlistAddError>> {
      try {
        const result = await withTenantTx(tenantId, callerTx, async (tx) => {
          return tx
            .insert(tenantImageSourceAllowlist)
            .values({
              tenantId: tenantId as string,
              hostname: hostname as string,
              isDefault: false,
              createdByUserId: actorUserId,
            })
            .onConflictDoNothing({
              target: [
                tenantImageSourceAllowlist.tenantId,
                tenantImageSourceAllowlist.hostname,
              ],
            })
            .returning({ id: tenantImageSourceAllowlist.id });
        });
        if (result.length === 0) {
          return err({ kind: 'duplicate' });
        }
        return ok(undefined);
      } catch (e) {
        return err({ kind: 'storage_error', detail: describeStorageError(e) });
      }
    },

    async remove(
      tenantId: TenantSlug,
      hostname: Hostname,
      callerTx?: ImageAllowlistTx | null,
    ): Promise<Result<void, AllowlistRemoveError>> {
      try {
        const { removed, defaultMarker } = await withTenantTx(
          tenantId,
          callerTx,
          async (tx) => {
            // Filter `is_default=false` so admin can only remove non-
            // default rows. Then probe whether the row exists at all to
            // disambiguate not_found vs cannot_remove_default for the
            // caller's audit / UI error mapping.
            const removed_ = await tx
              .delete(tenantImageSourceAllowlist)
              .where(
                and(
                  eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
                  eq(tenantImageSourceAllowlist.hostname, hostname as string),
                  eq(tenantImageSourceAllowlist.isDefault, false),
                ),
              )
              .returning({ id: tenantImageSourceAllowlist.id });

            if (removed_.length > 0) {
              return { removed: true as const, defaultMarker: null };
            }

            const exists = await tx
              .select({ isDefault: tenantImageSourceAllowlist.isDefault })
              .from(tenantImageSourceAllowlist)
              .where(
                and(
                  eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
                  eq(tenantImageSourceAllowlist.hostname, hostname as string),
                ),
              )
              .limit(1);
            return {
              removed: false as const,
              defaultMarker: exists[0]?.isDefault ?? null,
            };
          },
        );

        if (removed) return ok(undefined);
        if (defaultMarker === null) return err({ kind: 'not_found' });
        if (defaultMarker) return err({ kind: 'cannot_remove_default' });
        // Row exists but isDefault=false and DELETE didn't catch it —
        // shouldn't happen under RLS but defensively report not_found.
        return err({ kind: 'not_found' });
      } catch (e) {
        return err({ kind: 'storage_error', detail: describeStorageError(e) });
      }
    },
  };
}
