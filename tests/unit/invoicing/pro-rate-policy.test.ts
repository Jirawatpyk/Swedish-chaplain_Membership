import { describe, expect, it } from 'vitest';
import { calculateProRateFactor } from '@/modules/invoicing/domain/policies/calculate-pro-rate-factor';

describe('calculateProRateFactor', () => {
  describe("policy 'none'", () => {
    it('always returns 1.0000', () => {
      expect(
        calculateProRateFactor({
          policy: 'none',
          issueDate: '2026-06-15',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('1.0000');
    });
  });

  describe("policy 'monthly'", () => {
    it('issue on FY start → 12/12 = 1.0000', () => {
      expect(
        calculateProRateFactor({
          policy: 'monthly',
          issueDate: '2026-01-01',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('1.0000');
    });

    it('issue on FY start + 6 months (July) → 6/12 = 0.5000', () => {
      expect(
        calculateProRateFactor({
          policy: 'monthly',
          issueDate: '2026-07-01',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('0.5000');
    });

    it('issue in last month (December) → 1/12 = 0.0833', () => {
      expect(
        calculateProRateFactor({
          policy: 'monthly',
          issueDate: '2026-12-15',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('0.0833');
    });
  });

  describe("policy 'daily'", () => {
    it('issue on FY start → 365/365 = 1.0000', () => {
      expect(
        calculateProRateFactor({
          policy: 'daily',
          issueDate: '2026-01-01',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('1.0000');
    });

    it('issue on FY end → 1/365 = 0.0027', () => {
      expect(
        calculateProRateFactor({
          policy: 'daily',
          issueDate: '2026-12-31',
          fyStartDate: '2026-01-01',
          fyEndDate: '2026-12-31',
        }),
      ).toBe('0.0027');
    });

    it('issue mid-year on July 1 → 184/365 ≈ 0.5041', () => {
      const f = calculateProRateFactor({
        policy: 'daily',
        issueDate: '2026-07-01',
        fyStartDate: '2026-01-01',
        fyEndDate: '2026-12-31',
      });
      // July 1 → Dec 31 = 184 days inclusive
      expect(f).toBe('0.5041');
    });

    it('leap year — 366 days', () => {
      const f = calculateProRateFactor({
        policy: 'daily',
        issueDate: '2024-01-01',
        fyStartDate: '2024-01-01',
        fyEndDate: '2024-12-31',
      });
      expect(f).toBe('1.0000');
    });
  });
});
