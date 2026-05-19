/**
 * T029 (F7.1a US1) — Drizzle `BatchManifestsPort` adapter skeleton.
 *
 * Real implementation lands in Phase 3 T044-T048 (split / dispatch /
 * retry / accept-partial use cases) — this Phase 2 skeleton:
 *   - Imports the port interface + `broadcastBatchManifests` Drizzle
 *     schema
 *   - Provides factory `makeDrizzleBatchManifestsRepo()`
 *   - Stubs methods with `notImplemented()`
 *
 * IMPORTANT — advisory-lock contract (data-model § 4):
 * `pg_advisory_xact_lock('broadcasts-batch:' || tenantId || ':' ||
 * broadcastId || ':' || batchIndex)` is acquired by the USE CASE
 * (Phase 3 T045 `dispatchBroadcastBatch`), NOT inside this repo —
 * transaction boundaries must align with the lock lifetime. The repo
 * methods run inside the use case's tx via `runInTenant`.
 *
 * Tenant scoping (Phase 3): same pattern as other F7 repos —
 * `runInTenant(asTenantContext(tenantId), tx => …)`. RLS+FORCE
 * (migration 0166) provides storage-layer guard. The composite FK to
 * broadcasts (Phase 2 0163) cascades on broadcast delete.
 *
 * Not in barrel — Infrastructure adapter; composition root wires
 * inline at Phase 3.
 */

import { db } from '@/lib/db';
import type { BroadcastId } from '../domain/broadcast';
import type {
  BatchInsertError,
  BatchManifest,
  BatchManifestsPort,
  BatchStatusUpdate,
  BatchUpdateError,
  NewBatchManifestInput,
} from '../application/ports/batch-manifests-port';
import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { broadcastBatchManifests } from './schema';

function notImplemented(label: string): never {
  throw new Error(
    `[drizzle-batch-manifests-repo] ${label} not implemented — real impl lands in Phase 3 T044-T048`,
  );
}

export function makeDrizzleBatchManifestsRepo(): BatchManifestsPort {
  void db;
  void broadcastBatchManifests;

  return {
    async findByBroadcast(
      _tenantId: TenantSlug,
      _broadcastId: BroadcastId,
    ): Promise<readonly BatchManifest[]> {
      notImplemented('findByBroadcast');
    },
    async findPendingByBroadcast(
      _tenantId: TenantSlug,
      _broadcastId: BroadcastId,
    ): Promise<readonly BatchManifest[]> {
      notImplemented('findPendingByBroadcast');
    },
    async bulkInsert(
      _tenantId: TenantSlug,
      _inputs: readonly NewBatchManifestInput[],
    ): Promise<Result<readonly BatchManifest[], BatchInsertError>> {
      notImplemented('bulkInsert');
    },
    async updateStatus(
      _tenantId: TenantSlug,
      _batchManifestId: string,
      _update: BatchStatusUpdate,
    ): Promise<Result<BatchManifest, BatchUpdateError>> {
      notImplemented('updateStatus');
    },
    async markCancelled(
      _tenantId: TenantSlug,
      _batchManifestIds: readonly string[],
    ): Promise<number> {
      notImplemented('markCancelled');
    },
  };
}
