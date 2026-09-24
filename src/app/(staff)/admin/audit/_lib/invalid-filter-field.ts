/**
 * Which audit-viewer filter is invalid — so the "Invalid filter" state can
 * point at the offending field instead of a generic "check the date range and
 * filters" (admin design review).
 *
 * `invalidAuditFilterField` runs BEFORE the read, over the raw URL params: a
 * malformed date, a non-UUID target, an unknown event type, or a From after To.
 * Anything it passes is shape-valid, so an `invalid_range` from `auditQuery`
 * afterwards can only be the opaque page cursor (stale/tampered link) —
 * `invalidRangeField` names that. Pure; the page owns the copy.
 */
import { isValidEventTypeFilter, isValidTargetRef } from '@/lib/audit-filter-validation';
import { isYmd } from '@/lib/tenant-day-range';

export type AuditInvalidFilterField = 'from' | 'to' | 'range' | 'target' | 'eventType' | 'cursor';

export interface AuditFilterParams {
  readonly from: string;
  readonly to: string;
  readonly targetRef: string;
  readonly eventType: string;
  readonly cursor: string;
}

export function invalidAuditFilterField(
  params: AuditFilterParams,
  knownEventTypes: readonly string[],
): AuditInvalidFilterField | null {
  if (params.from !== '' && !isYmd(params.from)) return 'from';
  if (params.to !== '' && !isYmd(params.to)) return 'to';
  // Both are validated `YYYY-MM-DD` here, so a lexicographic compare is a
  // calendar compare — and a tenant-day start/end pair preserves that order.
  if (params.from !== '' && params.to !== '' && params.from > params.to) return 'range';
  if (!isValidTargetRef(params.targetRef)) return 'target';
  if (!isValidEventTypeFilter(params.eventType, knownEventTypes)) return 'eventType';
  return null;
}

/**
 * The field behind an `invalid_range` returned AFTER `invalidAuditFilterField`
 * passed. `null` = not attributable (render the generic body).
 */
export function invalidRangeField(params: AuditFilterParams): AuditInvalidFilterField | null {
  return params.cursor !== '' ? 'cursor' : null;
}
