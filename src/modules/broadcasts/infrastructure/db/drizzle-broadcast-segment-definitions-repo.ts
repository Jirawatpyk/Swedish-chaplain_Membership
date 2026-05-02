/**
 * T063 — Drizzle `BroadcastSegmentDefinitionsRepo` adapter (F7).
 *
 * Read-only adapter over the seeded `broadcast_segment_definitions`
 * table (migration 0068). MVP only reads — admins can extend in F7.1
 * via an upsert method added later.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  asBroadcastSegmentDefinitionId,
  type BroadcastSegmentDefinition,
  type BroadcastSegmentDefinitionId,
  type BroadcastSegmentDefinitionParams,
} from '../../domain/recipient-segment';

/**
 * Round 5 review type-design — narrow Drizzle's `unknown`/JSONB params
 * shape to the bounded `BroadcastSegmentDefinitionParams` DU. Foreign
 * keys / runtime drift fall into `null` rather than mistyped object
 * casts. The schema seeds only `tier` (with `tierCodes`) and `custom`
 * (with `emails`) so any other shape is treated as legacy and ignored.
 */
function parseSegmentDefinitionParams(
  raw: unknown,
): BroadcastSegmentDefinitionParams {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['tierCodes'])) {
    return {
      tierCodes: (obj['tierCodes'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      ),
    };
  }
  if (Array.isArray(obj['emails'])) {
    return {
      emails: (obj['emails'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      ),
    };
  }
  return null;
}
import type { BroadcastSegmentDefinitionsRepo } from '../../application/ports/broadcast-segment-definitions-repo';
import {
  broadcastSegmentDefinitions,
  type BroadcastSegmentDefinitionRow,
} from '../schema';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function rowToDefinition(
  row: BroadcastSegmentDefinitionRow,
): BroadcastSegmentDefinition {
  return {
    tenantId: row.tenantId,
    definitionId: asBroadcastSegmentDefinitionId(row.definitionId),
    segmentType: row.segmentType,
    displayLabelI18nKey: row.displayLabelI18nKey,
    params: parseSegmentDefinitionParams(row.params),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeDrizzleBroadcastSegmentDefinitionsRepo(
  tenantId: string,
): BroadcastSegmentDefinitionsRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async listByTenant(
      tenantIdArg: string,
    ): Promise<ReadonlyArray<BroadcastSegmentDefinition>> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcastSegmentDefinitions)
          .where(
            and(
              eq(broadcastSegmentDefinitions.tenantId, tenantIdArg),
              eq(broadcastSegmentDefinitions.enabled, true),
            ),
          )
          .orderBy(
            asc(broadcastSegmentDefinitions.segmentType),
            asc(broadcastSegmentDefinitions.definitionId),
          );
        return rows.map((r) => rowToDefinition(r as BroadcastSegmentDefinitionRow));
      });
    },

    async findByDefinitionId(
      tenantIdArg: string,
      definitionId: BroadcastSegmentDefinitionId,
    ): Promise<BroadcastSegmentDefinition | null> {
      return runInTenant(ctx, async (tx) => {
        const [row] = await tx
          .select()
          .from(broadcastSegmentDefinitions)
          .where(
            and(
              eq(broadcastSegmentDefinitions.tenantId, tenantIdArg),
              eq(broadcastSegmentDefinitions.definitionId, definitionId),
            ),
          )
          .limit(1);
        return row === undefined
          ? null
          : rowToDefinition(row as BroadcastSegmentDefinitionRow);
      });
    },
  };
}
