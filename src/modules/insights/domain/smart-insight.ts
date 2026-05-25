/**
 * F9 Smart-Insight catalogue (US1 / FR-004 / research R9 / data-model § 2).
 *
 * A FIXED starter catalogue of ≥3 rule-derived insight types — NOT a general
 * rule engine (deferred). Each insight is dismissible; a dismissal suppresses
 * it for one CYCLE (per-insight granularity, critique L3):
 *   - quota-based insights (`unused_eblast_quota`, `underused_event_tickets`)
 *     use the MEMBERSHIP YEAR (calendar year, tenant TZ);
 *   - the recurring `at_risk_followup` insight uses the ISO WEEK.
 *
 * The `INSIGHT_KEYS` tuple is the single source of truth — it MUST stay in
 * lockstep with the `smart_insight_dismissals_insight_key_check` CHECK in
 * migration 0186 (guarded by the catalogue unit test).
 *
 * Pure Domain — no framework/ORM imports.
 */

export const INSIGHT_KEYS = [
  'unused_eblast_quota',
  'underused_event_tickets',
  'at_risk_followup',
] as const;

export type InsightKey = (typeof INSIGHT_KEYS)[number];

/** Suppression-window granularity per insight (drives `cycle_key`). */
export type InsightCycleGranularity = 'membership_year' | 'iso_week';

export const INSIGHT_CATALOGUE: Record<InsightKey, InsightCycleGranularity> = {
  unused_eblast_quota: 'membership_year',
  underused_event_tickets: 'membership_year',
  at_risk_followup: 'iso_week',
};

/**
 * A surfaced insight on the dashboard (post-dismissal-filter). `count` is the
 * number of members the insight applies to (e.g. "5 members have unused
 * E-Blast quota"); `scopeRef` is an optional member/segment ref carried into
 * the dismissal idempotency key. The localised message is resolved in the
 * presentation layer from `key` + `count` (FR-034) — never stored as a string.
 */
export interface SmartInsight {
  readonly key: InsightKey;
  readonly count: number;
  readonly scopeRef?: string;
}

export function isInsightKey(value: string): value is InsightKey {
  return (INSIGHT_KEYS as readonly string[]).includes(value);
}
