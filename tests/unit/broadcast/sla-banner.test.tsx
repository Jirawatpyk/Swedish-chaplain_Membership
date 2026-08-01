/**
 * Task 2 (2026-08-01-broadcast-review-queue-pr1) — `SlaBanner` semantic
 * tokens + compact variant.
 *
 * `SlaBanner` is an async Server Component, so it cannot be rendered
 * directly by `render()` — resolve it first (`await SlaBanner({...})`)
 * and render the returned element, mirroring the established pattern in
 * tests/unit/app/admin/members/benefits-page-suspended-badge.test.tsx:19-30
 * (echo `getTranslations` mock). This test asserts CSS token classes +
 * compact structure, not copy, so an echo `t` is sufficient.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    return (key: string, params?: Record<string, unknown>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key;
  }),
}));

import { SlaBanner, type SlaStats } from '@/components/broadcast/admin/sla-banner';

const green: SlaStats = {
  targetSlaHours: 48,
  medianTimeToDecisionHours: 5,
  p95TimeToDecisionHours: 20,
  decisionCount: 9,
  bannerSeverity: 'green',
};
const red: SlaStats = { ...green, p95TimeToDecisionHours: 60, bannerSeverity: 'red' };
const amber: SlaStats = { ...green, p95TimeToDecisionHours: 42, bannerSeverity: 'amber' };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SlaBanner', () => {
  it('green severity uses the semantic success token, not raw emerald', async () => {
    const ui = await SlaBanner({ stats: green });
    const { container } = render(ui);
    const el = container.querySelector('[class*="success"]');
    expect(el).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/emerald-/);
  });

  it('red severity keeps the destructive token + role=alert', async () => {
    const ui = await SlaBanner({ stats: red });
    const { container } = render(ui);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.innerHTML).toContain('destructive');
  });

  it('amber severity uses the semantic warning token, not raw amber', async () => {
    const ui = await SlaBanner({ stats: amber });
    const { container } = render(ui);
    expect(container.innerHTML).toMatch(/bg-warning-surface/);
    expect(container.innerHTML).toMatch(/text-warning/);
    expect(container.innerHTML).not.toMatch(/amber-/);
  });

  it('compact renders an inline stat, not a full coloured banner (no region role, no severity bg)', async () => {
    const ui = await SlaBanner({ stats: green, compact: true });
    const { container } = render(ui);
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(
      /bg-success-surface|bg-warning-surface|bg-destructive-surface/,
    );
  });
});
