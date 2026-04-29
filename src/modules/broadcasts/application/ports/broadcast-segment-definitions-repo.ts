/**
 * T028 — `BroadcastSegmentDefinitionsRepo` Application port (F7).
 *
 * Read-only repository for the per-tenant segment metadata table
 * (`broadcast_segment_definitions`). Mostly populated by seed
 * migration 0068 (`all_members`, `tier:premium`, `tier:large`, etc.);
 * admins MAY add custom segments in F7.1.
 *
 * No write methods in MVP — the seed migration covers it. F7.1's
 * admin-segment-management UI will introduce `upsert` + `disable`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  BroadcastSegmentDefinition,
  BroadcastSegmentDefinitionId,
} from '../../domain/recipient-segment';

export interface BroadcastSegmentDefinitionsRepo {
  /**
   * List all enabled segment definitions for the tenant. Ordered by
   * a deterministic key (e.g. segment_type ASC, definition_id ASC)
   * so the compose-surface dropdown is stable across renders.
   */
  listByTenant(
    tenantId: string,
  ): Promise<ReadonlyArray<BroadcastSegmentDefinition>>;

  findByDefinitionId(
    tenantId: string,
    definitionId: BroadcastSegmentDefinitionId,
  ): Promise<BroadcastSegmentDefinition | null>;
}
