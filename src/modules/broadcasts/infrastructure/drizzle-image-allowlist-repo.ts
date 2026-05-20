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
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
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

/**
 * Tx-thread helper — runs the callback either inside the caller's
 * provided tx (atomic-tx threading per PR-review CR-H1) OR inside a
 * fresh `runInTenant` scope when tx is null/undefined. Centralises
 * the conditional so all 4 port methods share the same idiom.
 */
async function withTenantTx<T>(
  tenantId: TenantSlug,
  tx: ImageAllowlistTx | null | undefined,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (tx) {
    return fn(tx as TenantTx);
  }
  return runInTenant(
    asTenantContext(tenantId as unknown as string),
    async (innerTx) => fn(innerTx),
  );
}

/**
 * Surface the underlying PG error code when present (Drizzle wraps in
 * its own error type but the postgres-js cause carries `code` like
 * 42501 (insufficient_privilege / RLS) or 42P01 (undefined_table) for
 * misconfig diagnostics). Used by both add() and remove() catch blocks.
 */
function describeStorageError(e: unknown): string {
  const err_ = e as {
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const detail = err_?.cause?.message ?? err_?.message ?? 'unknown';
  const code = err_?.cause?.code ? ` [${err_.cause.code}]` : '';
  return `${detail}${code}`;
}

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
    ): Promise<readonly AllowlistEntry[]> {
      return runInTenant(
        asTenantContext(tenantId as unknown as string),
        async (tx) => {
          const rows = await tx
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
        },
      );
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
