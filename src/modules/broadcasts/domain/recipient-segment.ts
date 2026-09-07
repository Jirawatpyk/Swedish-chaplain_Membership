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
 * Review 2026-09-07 round 2 (C1/C2) — a persisted `tier` row whose
 * `segment_params` carries no usable codes. A PERMANENT data defect (DB
 * drift, a partial write, a manual fix), never a transient read failure.
 */
export type MalformedSegmentError = {
  readonly kind: 'malformed_segment';
  readonly segmentType: BroadcastSegmentType;
  readonly reason: 'tier_without_codes';
};

/**
 * Review 2026-09-07 round 2 (C1/C2 — six reviewers converged) — the ONE
 * place a persisted `broadcasts` row becomes a `RecipientSegment` again.
 *
 * Three private `buildSegmentFromBroadcast` copies (dispatch-scheduled,
 * dispatch-batches, split-large-broadcasts) used to manufacture
 * `{ kind: 'tier', tierCodes: [] }` from a malformed `segment_params` with
 * `?? []`. Downstream, the primary_only read dropped its tier predicate and
 * addressed EVERY active member, while the all_contacts read threw and the
 * throw was laundered into a transient `resolve.server_error` — retried every
 * tick forever. Both legs now agree because neither is ever asked: a tier
 * row without codes is refused HERE, typed, so the callers can fail the
 * broadcast terminally with an honest reason.
 */
export function recipientSegmentFromPersisted(row: {
  readonly segmentType: BroadcastSegmentType;
  readonly segmentParams: Record<string, unknown> | null;
  readonly customRecipientEmails: ReadonlyArray<string> | null;
}): Result<RecipientSegment, MalformedSegmentError> {
  switch (row.segmentType) {
    case 'all_members':
      return ok({ kind: 'all_members' });
    case 'tier': {
      const raw = row.segmentParams?.['tierCodes'];
      const tierCodes =
        Array.isArray(raw) && raw.every((c) => typeof c === 'string' && c.length > 0)
          ? (raw as string[])
          : [];
      if (tierCodes.length === 0) {
        return err({ kind: 'malformed_segment', segmentType: 'tier', reason: 'tier_without_codes' });
      }
      return ok({ kind: 'tier', tierCodes });
    }
    case 'event_attendees_last_90d':
      return ok({ kind: 'event_attendees_last_90d' });
    case 'custom':
      return ok({ kind: 'custom', emails: row.customRecipientEmails ?? [] });
  }
}

/**
 * Round 5 review type-design fix — bound segment-definition params to
 * the same DU shape as `RecipientSegment` rather than `Record<string,
 * unknown>`. This catches mis-typed param keys at compile time and
 * removes the `as { tierCodes?: string[] } | null` casts that were
 * appearing in `dispatch-scheduled-broadcast.ts buildSegmentFromBroadcast`
 * and `Broadcast.segmentParams` consumers.
 *
 * Why a separate type rather than reusing `RecipientSegment` directly:
 * the persisted definition row has no `kind` discriminant column —
 * `segmentType` enum already plays that role at the row level. The
 * `params` JSON column carries ONLY the payload fields, no kind tag.
 * Omitting `kind` keeps DB serialisation backward-compatible with the
 * pre-Round 5 schema (no migration needed).
 */
export type BroadcastSegmentDefinitionParams =
  | null
  | { readonly tierCodes: ReadonlyArray<string> }
  | { readonly emails: ReadonlyArray<string> };

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
  readonly params: BroadcastSegmentDefinitionParams;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
