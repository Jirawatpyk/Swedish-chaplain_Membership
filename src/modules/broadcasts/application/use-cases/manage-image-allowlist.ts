/**
 * T072 (F7.1a US2) — `manageImageAllowlist` Application use-case.
 *
 * Admin add/remove of a tenant's image-source allowlist (FR-010 +
 * FR-015). Emits `broadcast_image_allowlist_updated` audit with
 * before/after count + actor. Idempotent — duplicate add does NOT
 * emit audit (no-op).
 *
 * Pure Application logic — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { asHostname } from '../../domain/value-objects/image-source-allowlist';
import type {
  AllowlistEntry,
  ImageAllowlistPort,
  AllowlistAddError,
  AllowlistRemoveError,
} from '../ports/image-allowlist-port';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

/**
 * Platform-mandated default allowlist entries seeded on first contact
 * with the surface (admin settings page or member upload). Per spec
 * FR-010 these MUST NOT be removable by admins. Implementation seeds
 * `is_default=TRUE` via `ImageAllowlistPort.seedDefaults` which is
 * idempotent (`ON CONFLICT DO NOTHING`).
 *
 *   - `resend.com`: the email provider's CDN — referenced in dispatched
 *     emails for tracking pixels / unsubscribe links. Cannot be removed
 *     without breaking Resend integration.
 *
 * The tenant's OWN Vercel Blob hostname is added automatically by
 * `uploadInlineImage` on first successful upload (the Blob store ID
 * is randomised per-deployment, so we cannot hardcode it here).
 *
 * Multi-tenant note: when the SaaS provisioning surface lands (F10+),
 * this list will be extended with the tenant's own asset domain from
 * the tenants table. For single-tenant SweCham, the platform-controlled
 * Blob host serves the same role.
 */
const PLATFORM_DEFAULT_HOSTS = ['resend.com'] as const;

async function seedPlatformDefaults(
  port: ImageAllowlistPort,
  tenantId: TenantSlug,
): Promise<void> {
  const hosts = PLATFORM_DEFAULT_HOSTS.map((h) => asHostname(h))
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    .map((r) => r.value);
  if (hosts.length === 0) return;
  try {
    await port.seedDefaults(tenantId, hosts);
  } catch (e) {
    // Best-effort seed — log and continue. Subsequent calls re-attempt
    // (idempotent via ON CONFLICT DO NOTHING at the storage layer).
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId,
      },
      'broadcasts.manageImageAllowlist.platform_default_seed_failed',
    );
  }
}

export { seedPlatformDefaults };

export interface ManageImageAllowlistDeps {
  readonly port: ImageAllowlistPort;
  readonly audit: AuditPort;
}

export interface ManageImageAllowlistInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly action: 'add' | 'remove';
  readonly hostname: string;
  readonly requestId: string;
}

export type ManageImageAllowlistError =
  | { readonly kind: 'invalid_hostname'; readonly detail: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'cannot_remove_default' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface ManageImageAllowlistOutput {
  readonly allowlist: readonly AllowlistEntry[];
}

export async function manageImageAllowlist(
  deps: ManageImageAllowlistDeps,
  input: ManageImageAllowlistInput,
): Promise<
  Result<ManageImageAllowlistOutput, ManageImageAllowlistError>
> {
  const hRes = asHostname(input.hostname);
  if (!hRes.ok) {
    return err({ kind: 'invalid_hostname', detail: hRes.error.detail });
  }
  const hostname = hRes.value;

  // C1 fix (verify-run 2026-05-20) — ensure platform default hosts
  // (resend.com etc.) are seeded BEFORE returning the snapshot, so the
  // admin settings page never shows an empty default-row set on first
  // visit. Idempotent at storage layer. Runs OUTSIDE the atomic
  // mutation tx so a transient seed failure does not roll back the
  // admin's intended mutation (best-effort vs hard-fail tradeoff
  // documented in seedPlatformDefaults).
  await seedPlatformDefaults(deps.port, input.tenantId);

  const before = await deps.port.findByTenantId(input.tenantId);
  const beforeCount = before.length;

  // PR-review fix 2026-05-20 CR-H1 — port mutation + audit emit run
  // in ONE tx so a transient audit-storage failure rolls back the
  // allowlist mutation rather than leaving a regulator-visible audit
  // gap (Constitution Principle I clause 3 atomicity + spec FR-015
  // "audit log MUST record image-source-allowlist mutations").
  //
  // The audit.emit is RAW (not safeAuditEmit) here because the audit
  // row is the load-bearing forensic record for the mutation — a
  // failed emit MUST tear down the mutation. The use-case caller
  // (admin route) receives the exception → maps to 500 → admin
  // retries → both succeed or fail together. Compare safeAuditEmit
  // in security-reject paths (upload-inline-image / validate-image-
  // source-allowlist) where there is no mutation to roll back.
  //
  // `port.withTx` mirrors F7 MVP `BroadcastsRepo.withTx` — contract
  // tests mock by invoking the callback with `null` so use-case logic
  // exercises the port mocks without needing a real DB connection.
  //
  // R4-H1 follow-up (PR-review round 4 2026-05-21) — production call
  // stack is route→runInTenant → use-case→port.withTx (runInTenant)
  // → seedPlatformDefaults (runInTenant). Postgres-js maps the nested
  // db.transaction calls to SAVEPOINTs, NOT distinct top-level txs.
  // The atomicity guarantee still holds: an exception in the inner
  // `audit.emit(tx, ...)` rolls back the inner SAVEPOINT, which rolls
  // back the port mutation (same SAVEPOINT). The outer route-level tx
  // remains open with its GUC bindings and commits empty on success.
  // The "ONE tx" phrasing above refers to the atomicity-unit
  // (audit+mutation share one rollback boundary), not literal
  // tx-nesting depth.
  return deps.port.withTx(input.tenantId, async (tx) => {
    if (input.action === 'add') {
      const r = await deps.port.add(
        input.tenantId,
        hostname,
        input.actorUserId,
        tx,
      );
      if (!r.ok) return err(r.error as AllowlistAddError);
    } else {
      const r = await deps.port.remove(input.tenantId, hostname, tx);
      if (!r.ok) return err(r.error as AllowlistRemoveError);
    }

    const after = await deps.port.findByTenantId(input.tenantId);

    await deps.audit.emit(tx, {
      eventType: 'broadcast_image_allowlist_updated',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Allowlist ${input.action}: ${hostname}`,
      payload: {
        action: input.action,
        hostname,
        beforeCount,
        afterCount: after.length,
      },
      requestId: input.requestId,
    });

    return ok({ allowlist: after });
  });
}
