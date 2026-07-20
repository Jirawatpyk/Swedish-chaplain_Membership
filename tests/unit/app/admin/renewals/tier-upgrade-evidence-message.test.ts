/**
 * WP6 — `buildEvidenceMessage` (exhaustive evidence-line copy).
 *
 * Rendered against the REAL en.json so a renamed/missing `evidence.*` key or
 * an ICU placeholder the builder forgets to supply fails HERE rather than
 * surfacing a raw `{turnover}` at runtime. `formatThb` receives the raw MAJOR
 * baht figure (the currency shape is the client formatter's job).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { buildEvidenceMessage } from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/evidence-message';
import type { TierUpgradeEvidenceView } from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/tier-upgrade-queue-item';

const t = createTranslator({
  locale: 'en',
  messages: enMessages,
  namespace: 'admin.renewals.tier_upgrades',
} as unknown as Parameters<typeof createTranslator>[0]) as unknown as (
  key: string,
  values?: Record<string, string | number>,
) => string;

const thb = (n: number) => `฿${n.toLocaleString('en-US')}`;

describe('buildEvidenceMessage', () => {
  it('formats a declared-turnover line with the raw baht figure + date', () => {
    const view: TierUpgradeEvidenceView = {
      reasonCode: 'declared_turnover_above_threshold',
      turnoverThb: 5_000_000,
      thresholdMetAtLabel: '1 Jul 2026',
    };
    const spy = vi.fn(thb);
    const msg = buildEvidenceMessage(t, view, spy);
    expect(spy).toHaveBeenCalledWith(5_000_000); // raw major baht
    expect(msg).toContain('฿5,000,000');
    expect(msg).toContain('1 Jul 2026');
    // No unresolved ICU placeholder survived.
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('formats a paid-invoice-volume line', () => {
    const view: TierUpgradeEvidenceView = {
      reasonCode: 'paid_invoice_volume_above_threshold',
      invoiceVolumeThb: 3_200_000,
      thresholdMetAtLabel: '1 Jul 2026',
    };
    const msg = buildEvidenceMessage(t, view, thb);
    expect(msg).toContain('฿3,200,000');
    expect(msg).toContain('1 Jul 2026');
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('formats a multi-signal line with both figures', () => {
    const view: TierUpgradeEvidenceView = {
      reasonCode: 'multi_signal',
      turnoverThb: 8_000_000,
      invoiceVolumeThb: 3_200_000,
      thresholdMetAtLabel: '1 Jul 2026',
    };
    const msg = buildEvidenceMessage(t, view, thb);
    expect(msg).toContain('฿8,000,000');
    expect(msg).toContain('฿3,200,000');
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
