/**
 * WP7 (BP5 item 6) — `BundleChangeWarningDialog` resolved-label rendering.
 *
 * A resolved label renders (and the raw slug is hidden); a null label falls
 * back to the font-mono id + title; both-null renders the localised "None"
 * (never a bare em-dash that reads as missing data).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  BundleChangeWarningDialog,
  type BundleChangePayload,
} from '@/components/members/bundle-change-warning-dialog';

const BASE: BundleChangePayload = {
  oldBundleCorporatePlanId: 'corp-old-uuid',
  newBundleCorporatePlanId: 'corp-new-uuid',
  oldPlanId: 'p1',
  oldPlanYear: 2026,
};

function renderDialog(payload: BundleChangePayload) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BundleChangeWarningDialog
        open
        onOpenChange={() => {}}
        payload={payload}
        onConfirm={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BundleChangeWarningDialog — resolved labels', () => {
  it('renders resolved plan names and hides the raw slug', () => {
    renderDialog({
      ...BASE,
      oldBundleLabel: 'Corporate A — 2026',
      newBundleLabel: 'Corporate B — 2026',
    });
    expect(screen.getByText('Corporate A — 2026')).toBeInTheDocument();
    expect(screen.getByText('Corporate B — 2026')).toBeInTheDocument();
    expect(screen.queryByText('corp-old-uuid')).toBeNull();
    expect(screen.queryByText('corp-new-uuid')).toBeNull();
  });

  it('falls back to the font-mono id (with a title) when a label is unresolved', () => {
    renderDialog({ ...BASE, oldBundleLabel: null, newBundleLabel: null });
    const oldId = screen.getByText('corp-old-uuid');
    expect(oldId).toBeInTheDocument();
    expect(oldId).toHaveAttribute('title', 'corp-old-uuid');
  });

  it('renders the localised "None" (never a bare em-dash) when a bundle is absent', () => {
    renderDialog({
      ...BASE,
      oldBundleCorporatePlanId: null,
      newBundleCorporatePlanId: null,
      oldBundleLabel: null,
      newBundleLabel: null,
    });
    expect(
      screen.getAllByText(
        enMessages.admin.members.bundleChangeWarning.noBundle,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('—')).toBeNull();
  });
});
