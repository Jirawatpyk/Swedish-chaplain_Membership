/**
 * T025 (US1) — SmartInsight catalogue tests.
 *
 * Guards the fixed ≥3-insight catalogue + its per-insight cycle granularity,
 * and asserts the Domain `INSIGHT_KEYS` stay in lockstep with the
 * `smart_insight_dismissals_insight_key_check` CHECK in migration 0186 (drift
 * between the two would let a dismissal write a key the DB rejects, or vice-versa).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INSIGHT_CATALOGUE,
  INSIGHT_KEYS,
  isInsightKey,
} from '@/modules/insights/domain/smart-insight';

describe('SmartInsight catalogue', () => {
  it('has the fixed starter set of ≥3 insight keys', () => {
    expect(INSIGHT_KEYS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(INSIGHT_KEYS)).toEqual(
      new Set(['unused_eblast_quota', 'underused_event_tickets', 'at_risk_followup']),
    );
  });

  it('declares a cycle granularity for every key', () => {
    for (const key of INSIGHT_KEYS) {
      expect(INSIGHT_CATALOGUE[key]).toMatch(/^(membership_year|iso_week)$/);
    }
  });

  it('uses membership_year for quota insights and iso_week for at-risk follow-up', () => {
    expect(INSIGHT_CATALOGUE.unused_eblast_quota).toBe('membership_year');
    expect(INSIGHT_CATALOGUE.underused_event_tickets).toBe('membership_year');
    expect(INSIGHT_CATALOGUE.at_risk_followup).toBe('iso_week');
  });

  it('isInsightKey narrows valid + rejects unknown', () => {
    expect(isInsightKey('unused_eblast_quota')).toBe(true);
    expect(isInsightKey('nope')).toBe(false);
  });

  it('stays in lockstep with the migration 0186 CHECK constraint keys', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'drizzle/migrations/0186_f9_smart_insight_dismissals.sql'),
      'utf8',
    );
    const checkBlock = sql.match(/insight_key"?\s+IN\s*\(([^)]+)\)/i)?.[1] ?? '';
    const dbKeys = new Set((checkBlock.match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, '')));
    expect(dbKeys).toEqual(new Set(INSIGHT_KEYS));
  });
});
