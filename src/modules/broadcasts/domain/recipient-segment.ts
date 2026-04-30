/**
 * T027 — `RecipientSegment` discriminated union + `BroadcastSegmentDefinition`
 * aggregate (F7).
 *
 * `RecipientSegment` is the in-memory domain shape that the Application
 * layer uses to resolve a target list (FR-015). The 4 variants align
 * 1:1 with `BroadcastSegmentType` enum.
 *
 * `BroadcastSegmentDefinition` is the persisted read-model snapshot of
 * available segments per tenant (data-model § 1.4). Mostly populated
 * by seed migration 0068; admins MAY add custom-named segments in F7.1.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { BroadcastSegmentType } from './value-objects/segment-type';

declare const BroadcastSegmentDefinitionIdBrand: unique symbol;
export type BroadcastSegmentDefinitionId = string & {
  readonly [BroadcastSegmentDefinitionIdBrand]: true;
};

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BroadcastSegmentDefinitionIdError = {
  readonly kind: 'invalid_broadcast_segment_definition_id';
  readonly raw: string;
};

export function asBroadcastSegmentDefinitionId(
  raw: string,
): BroadcastSegmentDefinitionId {
  return raw as BroadcastSegmentDefinitionId;
}

export function parseBroadcastSegmentDefinitionId(
  raw: string,
): Result<BroadcastSegmentDefinitionId, BroadcastSegmentDefinitionIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_broadcast_segment_definition_id', raw });
  }
  return ok(raw as BroadcastSegmentDefinitionId);
}

/**
 * In-memory recipient segment with parameter shape per variant.
 *
 * Resolved by Application use-case `resolve-segment-recipients.ts`
 * (Phase 3) into a concrete email list using F2/F3/F6 bridges.
 *
 *   - `all_members` — tenant-wide blast (FR-015)
 *   - `tier` — subset on specific membership plan tiers (FR-015)
 *   - `event_attendees_last_90d` — F6 stub-port returning [] until F6
 *     ships (FR-015a). The shape is forward-compat ready for F6 swap-in.
 *   - `custom` — bring-your-own list ≤100 entries, validated against
 *     tenant graph by `EmailValidatorPort` + `MembersBridgePort.lookup*`
 *     (FR-015d / Q9)
 */
export type RecipientSegment =
  | { readonly kind: 'all_members' }
  | {
      readonly kind: 'tier';
      readonly tierCodes: ReadonlyArray<string>;
    }
  | { readonly kind: 'event_attendees_last_90d' }
  | {
      readonly kind: 'custom';
      readonly emails: ReadonlyArray<string>;
    };

/**
 * Persisted segment metadata (`broadcast_segment_definitions` table).
 * Used by the admin queue UI ("which segment was this targeting?")
 * and the compose surface segment-picker dropdown.
 */
export interface BroadcastSegmentDefinition {
  readonly tenantId: string;
  readonly definitionId: BroadcastSegmentDefinitionId;
  readonly segmentType: BroadcastSegmentType;
  readonly displayLabelI18nKey: string;
  readonly params: Record<string, unknown> | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
