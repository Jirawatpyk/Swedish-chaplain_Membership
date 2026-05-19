/**
 * T027 (F7.1a US2) — Drizzle `ImageAllowlistPort` adapter.
 *
 * Real implementation per Phase 4 T072 use-case wave. Tenant scoping
 * relies on `runInTenant()` being active at the call site so RLS+FORCE
 * (migration 0166) is the storage-layer guard.
 *
 * Defaults invariant (FR-010): `is_default=TRUE` rows are refused by
 * `remove()` — `cannot_remove_default` discriminant returned to the
 * use-case so the API surface can map to HTTP 403 + i18n message.
 *
 * Idempotent seed (`seedDefaults`): runs `ON CONFLICT DO NOTHING` on
 * the `(tenant_id, hostname)` unique index. The Phase 4 T072 use-case
 * calls this lazily on first admin visit / first member compose with
 * image, with the platform-mandated seed hostnames (chamber asset
 * domain + Resend CDN).
 */
import { db } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import type {
  AllowlistAddError,
  AllowlistEntry,
  AllowlistRemoveError,
  Hostname,
  ImageAllowlistPort,
} from '../application/ports/image-allowlist-port';
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { tenantImageSourceAllowlist } from './schema';

export function makeDrizzleImageAllowlistRepo(): ImageAllowlistPort {
  return {
    async findByTenantId(
      tenantId: TenantSlug,
    ): Promise<readonly AllowlistEntry[]> {
      const rows = await db
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

    async seedDefaults(
      tenantId: TenantSlug,
      hostnames: readonly Hostname[],
    ): Promise<void> {
      if (hostnames.length === 0) return;
      await db
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

    async add(
      tenantId: TenantSlug,
      hostname: Hostname,
      actorUserId: string,
    ): Promise<Result<void, AllowlistAddError>> {
      try {
        const result = await db
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
        if (result.length === 0) {
          return err({ kind: 'duplicate' });
        }
        return ok(undefined);
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'unknown';
        return err({ kind: 'storage_error', detail });
      }
    },

    async remove(
      tenantId: TenantSlug,
      hostname: Hostname,
    ): Promise<Result<void, AllowlistRemoveError>> {
      try {
        // Filter `is_default=false` so admin can only remove non-default
        // rows. We then probe whether the row exists at all to
        // disambiguate not_found vs cannot_remove_default for the
        // caller's audit / UI error mapping.
        const removed = await db
          .delete(tenantImageSourceAllowlist)
          .where(
            and(
              eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
              eq(tenantImageSourceAllowlist.hostname, hostname as string),
              eq(tenantImageSourceAllowlist.isDefault, false),
            ),
          )
          .returning({ id: tenantImageSourceAllowlist.id });

        if (removed.length === 0) {
          const exists = await db
            .select({ isDefault: tenantImageSourceAllowlist.isDefault })
            .from(tenantImageSourceAllowlist)
            .where(
              and(
                eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
                eq(tenantImageSourceAllowlist.hostname, hostname as string),
              ),
            )
            .limit(1);
          if (exists.length === 0) return err({ kind: 'not_found' });
          if (exists[0]?.isDefault === true) {
            return err({ kind: 'cannot_remove_default' });
          }
        }
        return ok(undefined);
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'unknown';
        return err({ kind: 'storage_error', detail });
      }
    },
  };
}
