/**
 * T021 (US1) — `projectEngagementScore` unit tests.
 *
 * Engagement Score = the positive-framed inverse of the F8 at-risk score
 * (data-model § 6, FR-007a). Pure projection — staff-facing only.
 *   score = clamp(100 − riskScore, 0, 100); null riskScore → null score.
 *   band  = invert(riskScoreBand): critical→critical, at-risk→warning,
 *           warning→moderate, healthy→healthy; null → null.
 *
 * Security-critical projection → 100% branch coverage (plan Constitution II).
 */
import { describe, expect, it } from 'vitest';
import { projectEngagementScore } from '@/modules/insights/domain/engagement-score';

describe('projectEngagementScore', () => {
  describe('score', () => {
    it('inverts a mid-range risk score (40 → 60)', () => {
      expect(projectEngagementScore({ riskScore: 40, riskScoreBand: 'warning' }).score).toBe(60);
    });

    it('maps risk 0 → engagement 100 (healthiest)', () => {
      expect(projectEngagementScore({ riskScore: 0, riskScoreBand: 'healthy' }).score).toBe(100);
    });

    it('maps risk 100 → engagement 0 (most critical)', () => {
      expect(projectEngagementScore({ riskScore: 100, riskScoreBand: 'critical' }).score).toBe(0);
    });

    it('clamps a >100 risk score to engagement 0', () => {
      expect(projectEngagementScore({ riskScore: 130, riskScoreBand: 'critical' }).score).toBe(0);
    });

    it('clamps a negative risk score to engagement 100', () => {
      expect(projectEngagementScore({ riskScore: -10, riskScoreBand: 'healthy' }).score).toBe(100);
    });

    it('returns null score when riskScore is null', () => {
      expect(projectEngagementScore({ riskScore: null, riskScoreBand: 'healthy' }).score).toBeNull();
    });
  });

  describe('band inversion', () => {
    it.each([
      ['critical', 'critical'],
      ['at-risk', 'warning'],
      ['warning', 'moderate'],
      ['healthy', 'healthy'],
    ] as const)('inverts riskScoreBand %s → engagement band %s', (riskBand, expected) => {
      expect(
        projectEngagementScore({ riskScore: 50, riskScoreBand: riskBand }).band,
      ).toBe(expected);
    });

    it('returns null band when riskScoreBand is null', () => {
      expect(projectEngagementScore({ riskScore: 50, riskScoreBand: null }).band).toBeNull();
    });
  });

  it('handles a fully un-scored member (both null) → both null', () => {
    expect(projectEngagementScore({ riskScore: null, riskScoreBand: null })).toEqual({
      score: null,
      band: null,
    });
  });
});
