/**
 * T028 (F7.1a US7) — Drizzle `BroadcastTemplatesPort` adapter skeleton.
 *
 * Real implementation lands in Phase 5 T099-T103 (create/update/delete/
 * snapshot use cases) — this Phase 2 skeleton:
 *   - Imports the port interface + `broadcastTemplates` Drizzle schema
 *   - Provides factory `makeDrizzleBroadcastTemplatesRepo()`
 *   - Stubs methods with `notImplemented()`
 *
 * Tenant scoping pattern (Phase 5): every read/write runs inside
 * `runInTenant(asTenantContext(tenantId), tx => …)`. RLS+FORCE
 * (migration 0166) provides storage-layer guard. Migration 0168
 * seeds 5 starter templates × 3 locales per production tenant —
 * `findByTenantId` filters `deletedAt IS NULL` by default and orders
 * by `updatedAt DESC` (uses the partial index installed in 0161).
 *
 * Not in barrel — Infrastructure adapter; composition root
 * (`broadcasts-deps.ts`) wires it inline at Phase 5.
 */

import { db } from '@/lib/db';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
  BroadcastTemplatesTx,
  CreateTemplateInput,
  ListTemplatesOpts,
  TemplateCreateError,
  TemplateDeleteError,
  TemplateUpdateError,
  UpdateTemplateInput,
} from '../application/ports/broadcast-templates-port';
import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { broadcastTemplates } from './schema';

function notImplemented(label: string): never {
  throw new Error(
    `[drizzle-broadcast-templates-repo] ${label} not implemented — real impl lands in Phase 5 T099-T103`,
  );
}

export function makeDrizzleBroadcastTemplatesRepo(): BroadcastTemplatesPort {
  void db;
  void broadcastTemplates;

  return {
    async withTx<T>(
      _tenantId: TenantSlug,
      _callback: (tx: BroadcastTemplatesTx) => Promise<T>,
    ): Promise<T> {
      notImplemented('withTx');
    },
    async findById(
      _tenantId: TenantSlug,
      _id: string,
    ): Promise<BroadcastTemplate | null> {
      notImplemented('findById');
    },
    async findByTenantId(
      _tenantId: TenantSlug,
      _opts?: ListTemplatesOpts,
    ): Promise<readonly BroadcastTemplate[]> {
      notImplemented('findByTenantId');
    },
    async create(
      _tenantId: TenantSlug,
      _input: CreateTemplateInput,
      _tx?: BroadcastTemplatesTx,
    ): Promise<Result<BroadcastTemplate, TemplateCreateError>> {
      notImplemented('create');
    },
    async update(
      _tenantId: TenantSlug,
      _id: string,
      _input: UpdateTemplateInput,
      _tx?: BroadcastTemplatesTx,
    ): Promise<Result<BroadcastTemplate, TemplateUpdateError>> {
      notImplemented('update');
    },
    async softDelete(
      _tenantId: TenantSlug,
      _id: string,
      _tx?: BroadcastTemplatesTx,
    ): Promise<Result<void, TemplateDeleteError>> {
      notImplemented('softDelete');
    },
    async incrementStartedFromCount(
      _tenantId: TenantSlug,
      _id: string,
      _tx?: BroadcastTemplatesTx,
    ): Promise<void> {
      notImplemented('incrementStartedFromCount');
    },
  };
}
