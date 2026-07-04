/**
 * 088 US8 UX-B2 (T061f) — `pruneOrphanedZeroRateCerts` Application use-case.
 *
 * Daily TTL sweep that prunes ABANDONED / SUPERSEDED §80/1(5) MFA zero-rate
 * certificate SCAN blobs — files uploaded via the UX-B1 upload route
 * (`upload-zero-rate-cert`) onto a DRAFT invoice that was then never issued
 * (dialog cancelled, flipped to standard VAT, or superseded by a re-upload).
 * Such a scan is written to a server-derived key
 * `invoicing/<tenantId>/zero-rate-certs/<invoiceId>_<uploadedAtMs>.<ext>` but is
 * only PINNED onto `invoices.zero_rate_cert_blob_key` at ISSUE. A draft that is
 * never issued leaves the blob orphaned; Vercel Blob has no TTL, so this cron
 * is the only reclaim path — the invoicing analogue of the F6 error-CSV blob
 * TTL sweep.
 *
 * ── Orphan rule (the safety-critical part) ─────────────────────────────────
 * For each cert blob key:
 *   KEEP  iff SOME invoice (ANY status) in the key's tenant pins it. A pinned
 *         cert is 10-year-retained legal evidence — NEVER swept, even on a
 *         voided / credited invoice.
 *   Else, DELETE only when its age exceeds a GENEROUS grace window
 *         ({@link ORPHAN_CERT_GRACE_MS} = 48h). The grace protects an in-flight
 *         mid-issue upload: the cert may sit un-pinned for the seconds/minutes
 *         between upload and issue. Age is derived from the `<uploadedAtMs>`
 *         embedded in the key, compared against an injected {@link ClockPort}
 *         (never `Date.now()`).
 *   MALFORMED key (no parseable ms) → SKIP, never delete (we cannot compute an
 *         age, so we must not risk deleting a pinned/legit blob).
 *
 * ── Fail-safe (never lose a pinned cert) ───────────────────────────────────
 * Deletion happens ONLY after a POSITIVE confirmation the blob is un-pinned AND
 * past grace. If the pin probe THROWS (DB/RLS outage), the blob is KEPT
 * (skipped, retried next tick) — an unconfirmed orphan is treated as pinned.
 * A per-tenant `blob.list` failure skips that tenant and continues the rest.
 * Only a tenant-LIST failure aborts the whole sweep (`kind:'scan_failed'` →
 * route 500). Idempotent: an already-gone blob (`delete` resolves as a no-op,
 * or throws not-found) counts as a successful sweep; a re-listed key never
 * double-counts because `list` no longer returns a deleted key.
 *
 * ── No new audit / metric (Constitution X) ─────────────────────────────────
 * Mirrors the F6 error-CSV sweep: NO new audit event type (the F6 sweep emits
 * none — orphan cleanup is not a regulated state change; the cert lifecycle is
 * already audited at issue via `invoice_issued`). Observability is structured
 * pino logs (injected) + the `scan_failed` → 500 alerting anchor.
 *
 * Pure Application logic — no framework imports (Constitution Principle III).
 */
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { ClockPort } from '../ports/clock-port';
import type { ZeroRateCertPruneRepo } from '../ports/zero-rate-cert-prune-repo';

/**
 * GENEROUS grace: a cert blob younger than this is KEPT even when un-pinned,
 * protecting a mid-issue upload (uploaded, issue not yet committed). 48h is far
 * beyond any real upload→issue gap; orphans are rare (cancelled/superseded
 * dialogs), so a slightly delayed reclaim is harmless.
 */
export const ORPHAN_CERT_GRACE_MS = 48 * 60 * 60 * 1000;

/** Per-tenant blob-list page cap; matches the F6 sweep's 1000 clamp ceiling. */
const CERT_LIST_LIMIT_DEFAULT = 1000;
const CERT_LIST_LIMIT_MAX = 1000;

/** The path segment every cert-scan key carries, below the per-tenant folder. */
const CERT_KEY_SEGMENT = '/zero-rate-certs/';

export interface ParsedZeroRateCertKey {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly uploadedAtMs: number;
}

/**
 * Parse `invoicing/<tenantId>/zero-rate-certs/<invoiceId>_<ms>.<ext>`.
 * Returns `null` for any key that is not a cert key OR whose `<ms>` suffix is
 * not a positive safe integer — the caller treats `null` as "skip, never
 * delete". Exported for direct unit coverage of the malformed-key branch.
 */
export function parseZeroRateCertKey(key: string): ParsedZeroRateCertKey | null {
  const match =
    /^invoicing\/([^/]+)\/zero-rate-certs\/(.+)_(\d+)\.[a-z0-9]+$/i.exec(key);
  if (match === null) return null;
  const tenantId = match[1]!;
  const invoiceId = match[2]!;
  const uploadedAtMs = Number(match[3]!);
  if (!Number.isSafeInteger(uploadedAtMs) || uploadedAtMs <= 0) return null;
  return { tenantId, invoiceId, uploadedAtMs };
}

/** A blob `delete` rejection that means "already gone" — idempotent success. */
function isBlobNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not[\s_-]?found|404|does not exist|no such/i.test(msg);
}

export interface PruneOrphanedZeroRateCertsInput {
  /** Per-tenant blob-list page cap (default + max 1000; floored at 1). */
  readonly limit?: number;
}

export interface PruneOrphanedZeroRateCertsDeps {
  /** Only `list` + `delete` are needed (narrowed for easy mocking). */
  readonly blob: Pick<BlobStoragePort, 'list' | 'delete'>;
  /** Injected clock — now-time for the grace comparison (never Date.now()). */
  readonly clock: ClockPort;
  /**
   * Cross-tenant enumeration of every tenant that could own cert blobs (the
   * composition root wires this to `SELECT tenant_id FROM tenant_invoice_settings`
   * on the RLS-bypassing owner connection). A throw here aborts the sweep
   * (`kind:'scan_failed'`).
   */
  readonly listCertTenantIds: () => Promise<readonly string[]>;
  /**
   * Per-tenant tx scope: opens `runInTenant(asTenantContext(tenantId), …)` and
   * invokes `fn` with a tenant-scoped {@link ZeroRateCertPruneRepo}, so the pin
   * probe runs under RLS for that tenant. Mirrors the F6 sweep's `withTenantScope`.
   */
  readonly withTenantScope: <T>(
    tenantId: string,
    fn: (repo: ZeroRateCertPruneRepo) => Promise<T>,
  ) => Promise<T>;
  readonly logger?: {
    info(meta: Record<string, unknown>, msg: string): void;
    warn(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Discriminated outcome (mirrors the F6 sweep). `scan_failed` makes "tenant
 * list failed ⇒ nothing swept" unrepresentable and drives the route's 500.
 */
export type PruneOrphanedZeroRateCertsOutput =
  | {
      readonly kind: 'ok';
      /** Cert blobs examined across all tenants this tick. */
      readonly scanned: number;
      /** Blobs deleted (incl. idempotent already-gone). */
      readonly swept: number;
      /** Blobs kept (pinned / within grace / malformed / probe or delete failure). */
      readonly skipped: number;
      /** Age threshold: a blob uploaded before this instant is grace-eligible. */
      readonly cutoff: Date;
    }
  | { readonly kind: 'scan_failed'; readonly cutoff: Date };

export async function pruneOrphanedZeroRateCerts(
  input: PruneOrphanedZeroRateCertsInput,
  deps: PruneOrphanedZeroRateCertsDeps,
): Promise<PruneOrphanedZeroRateCertsOutput> {
  const limit = Math.max(
    1,
    Math.min(CERT_LIST_LIMIT_MAX, input.limit ?? CERT_LIST_LIMIT_DEFAULT),
  );
  const nowMs = new Date(deps.clock.nowIso()).getTime();
  const cutoff = new Date(nowMs - ORPHAN_CERT_GRACE_MS);
  const logger = deps.logger;

  // --- Step 1: enumerate tenants (admin-bypass). A failure aborts the sweep. --
  let tenantIds: readonly string[];
  try {
    tenantIds = await deps.listCertTenantIds();
  } catch (e) {
    logger?.error(
      {
        event: 'zero_rate_cert_prune_scan_failed',
        cutoff: cutoff.toISOString(),
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      '[088 US8] cert-prune cron: tenant-list step failed; route will return 500',
    );
    return { kind: 'scan_failed', cutoff };
  }

  let scanned = 0;
  let swept = 0;
  let skipped = 0;

  for (const tenantId of tenantIds) {
    let keys: readonly string[];
    try {
      keys = await deps.blob.list(`invoicing/${tenantId}/zero-rate-certs/`, limit);
    } catch (e) {
      // Per-tenant list failure must not abort the rest (best-effort sweep).
      logger?.warn(
        {
          event: 'zero_rate_cert_prune_list_failed',
          tenantId,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        '[088 US8] cert-prune cron: blob.list failed for tenant; skipping (retry next tick)',
      );
      continue;
    }

    for (const key of keys) {
      // `list` is prefix-scoped, but guard defensively against any non-cert key.
      if (!key.includes(CERT_KEY_SEGMENT)) continue;
      scanned += 1;
      const outcome = await sweepOneCert(key, tenantId, nowMs, deps, logger);
      if (outcome === 'swept') swept += 1;
      else skipped += 1;
    }
  }

  logger?.info(
    {
      event: 'zero_rate_cert_prune_completed',
      cutoff: cutoff.toISOString(),
      scanned,
      swept,
      skipped,
    },
    `[088 US8] cert-prune cron complete: ${swept}/${scanned} orphaned cert blobs deleted`,
  );

  return { kind: 'ok', scanned, swept, skipped, cutoff };
}

/** Returns 'swept' when the blob was deleted (or already gone), else 'skipped'. */
async function sweepOneCert(
  key: string,
  tenantId: string,
  nowMs: number,
  deps: PruneOrphanedZeroRateCertsDeps,
  logger: PruneOrphanedZeroRateCertsDeps['logger'],
): Promise<'swept' | 'skipped'> {
  // (d) Malformed key → cannot compute age → KEEP (never delete).
  const parsed = parseZeroRateCertKey(key);
  if (parsed === null) {
    logger?.warn(
      { event: 'zero_rate_cert_prune_malformed_key', tenantId },
      '[088 US8] cert-prune cron: unparseable cert key — skipped (never deleted)',
    );
    return 'skipped';
  }

  // (a) KEEP if pinned. Fail-safe: an errored probe is treated as PINNED (KEEP)
  // so we never delete a cert we could not confirm is an orphan.
  let pinned: boolean;
  try {
    pinned = await deps.withTenantScope(tenantId, (repo) =>
      repo.existsInvoiceWithCertBlobKey(tenantId, key),
    );
  } catch (e) {
    logger?.error(
      {
        event: 'zero_rate_cert_prune_pin_probe_failed',
        tenantId,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      '[088 US8] cert-prune cron: pin probe FAILED — KEEP (fail-safe, retry next tick)',
    );
    return 'skipped';
  }
  if (pinned) return 'skipped';

  // (c) Within the grace window → KEEP (protects an in-flight mid-issue upload).
  if (nowMs - parsed.uploadedAtMs <= ORPHAN_CERT_GRACE_MS) return 'skipped';

  // (b) Un-pinned + past grace → delete. (e) idempotent: already-gone = success.
  try {
    await deps.blob.delete(key);
    return 'swept';
  } catch (e) {
    if (isBlobNotFound(e)) return 'swept';
    logger?.warn(
      {
        event: 'zero_rate_cert_prune_delete_failed',
        tenantId,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      '[088 US8] cert-prune cron: blob delete failed — skipped (retry next tick)',
    );
    return 'skipped';
  }
}
