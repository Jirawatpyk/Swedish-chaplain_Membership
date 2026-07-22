/**
 * WP6 — `parseTierUpgradeEvidenceView` (presentation-boundary evidence parse).
 *
 * Pins: raw `thresholdMetAt` ISO is replaced by a server-formatted
 * `thresholdMetAtLabel`; unknown keys are stripped; a malformed shape or a
 * reason-code mismatch degrades to `null` (→ client renders "unavailable");
 * the date formatter is invoked exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseTierUpgradeEvidenceView } from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/tier-upgrade-queue-item';

const ISO = '2026-07-01T00:00:00.000Z';
const fmt = (iso: string) => `formatted:${iso}`;

describe('parseTierUpgradeEvidenceView', () => {
  it('formats the threshold date into a label and keeps the raw turnover figure', () => {
    const spy = vi.fn(fmt);
    const view = parseTierUpgradeEvidenceView(
      'declared_turnover_above_threshold',
      {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 5_000_000,
        thresholdMetAt: ISO,
      },
      spy,
    );
    expect(view).toEqual({
      reasonCode: 'declared_turnover_above_threshold',
      turnoverThb: 5_000_000,
      thresholdMetAtLabel: `formatted:${ISO}`,
    });
    // The raw ISO instant never survives to the client view.
    expect(view).not.toHaveProperty('thresholdMetAt');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('carries both metrics for a multi_signal arm', () => {
    const view = parseTierUpgradeEvidenceView(
      'multi_signal',
      {
        reasonCode: 'multi_signal',
        turnoverThb: 8_000_000,
        invoiceVolumeThb: 3_200_000,
        thresholdMetAt: ISO,
      },
      fmt,
    );
    expect(view).toEqual({
      reasonCode: 'multi_signal',
      turnoverThb: 8_000_000,
      invoiceVolumeThb: 3_200_000,
      thresholdMetAtLabel: `formatted:${ISO}`,
    });
  });

  it('strips unknown keys the JSONB may carry', () => {
    const view = parseTierUpgradeEvidenceView(
      'paid_invoice_volume_above_threshold',
      {
        reasonCode: 'paid_invoice_volume_above_threshold',
        invoiceVolumeThb: 1_000_000,
        thresholdMetAt: ISO,
        // A future emit-site field must not leak into the client view.
        internalNote: 'debug',
      },
      fmt,
    );
    expect(view).not.toHaveProperty('internalNote');
    expect(view).toEqual({
      reasonCode: 'paid_invoice_volume_above_threshold',
      invoiceVolumeThb: 1_000_000,
      thresholdMetAtLabel: `formatted:${ISO}`,
    });
  });

  it('returns null (and does not format) for a malformed evidence shape', () => {
    const spy = vi.fn(fmt);
    const view = parseTierUpgradeEvidenceView(
      'declared_turnover_above_threshold',
      // Missing `turnoverThb`.
      { reasonCode: 'declared_turnover_above_threshold', thresholdMetAt: ISO },
      spy,
    );
    expect(view).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null on a reason-code mismatch (forensic drift)', () => {
    const view = parseTierUpgradeEvidenceView(
      'multi_signal',
      // Well-formed turnover arm, but the suggestion says multi_signal.
      {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 5_000_000,
        thresholdMetAt: ISO,
      },
      fmt,
    );
    expect(view).toBeNull();
  });

  it('returns null for a non-object evidence value', () => {
    expect(
      parseTierUpgradeEvidenceView('multi_signal', null, fmt),
    ).toBeNull();
    expect(
      parseTierUpgradeEvidenceView('multi_signal', 'nope', fmt),
    ).toBeNull();
  });
});
