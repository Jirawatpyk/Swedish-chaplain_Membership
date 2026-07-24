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
import {
  buildAcceptDialogMessage,
  buildEvidenceMessage,
} from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/evidence-message';
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

describe('buildAcceptDialogMessage (plan-change UX C2)', () => {
  const TURNOVER: TierUpgradeEvidenceView = {
    reasonCode: 'declared_turnover_above_threshold',
    turnoverThb: 5_000_000,
    thresholdMetAtLabel: '1 Jul 2026',
  };

  it('restates the old→new annual FEES (minor units) alongside the plan names', () => {
    const spy = vi.fn(thb);
    const msg = buildAcceptDialogMessage(
      t,
      {
        evidence: TURNOVER,
        fromPlanLabel: 'Regular — 2026',
        toPlanLabel: 'Premium — 2026',
        fromFeeMinorUnits: 3_600_000, // ฿36,000
        toFeeMinorUnits: 6_000_000, // ฿60,000
      },
      spy,
    );
    // Fees are converted MINOR → MAJOR before formatting.
    expect(spy).toHaveBeenCalledWith(36_000);
    expect(spy).toHaveBeenCalledWith(60_000);
    expect(msg).toContain('฿36,000');
    expect(msg).toContain('฿60,000');
    expect(msg).toContain('Regular — 2026');
    expect(msg).toContain('Premium — 2026');
    // Evidence figure is still restated.
    expect(msg).toContain('฿5,000,000');
    // No unresolved ICU placeholder survived (fromFee/toFee wired).
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('renders the localised fee_unknown token when a fee is absent (archived plan)', () => {
    const msg = buildAcceptDialogMessage(
      t,
      {
        evidence: TURNOVER,
        fromPlanLabel: 'Regular — 2026',
        toPlanLabel: 'Premium — 2026',
        // fromFee present, toFee absent → the to-slot degrades to the token.
        fromFeeMinorUnits: 3_600_000,
      },
      thb,
    );
    expect(msg).toContain('฿36,000');
    expect(msg).toContain(
      enMessages.admin.renewals.tier_upgrades.actions.accept.fee_unknown,
    );
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('falls back to the evidence.unavailable line when evidence is null', () => {
    const msg = buildAcceptDialogMessage(
      t,
      {
        evidence: null,
        fromPlanLabel: 'Regular — 2026',
        toPlanLabel: 'Premium — 2026',
        fromFeeMinorUnits: 3_600_000,
        toFeeMinorUnits: 6_000_000,
      },
      thb,
    );
    expect(msg).toContain(
      enMessages.admin.renewals.tier_upgrades.evidence.unavailable,
    );
    expect(msg).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
