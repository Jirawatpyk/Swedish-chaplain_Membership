// @vitest-environment jsdom
/**
 * Portal error states #2 — a failed E-Blast history load is not "no E-Blasts".
 *
 * `broadcasts-panel.tsx` logged `broadcasts.benefits_page.list_history_failed`
 * and left `history = []`, so the member read "No broadcasts yet" beside a
 * "Compose your first E-Blast" CTA — a false statement about their own
 * account. The approved state (AURA canvas "E-Blasts — empty variants" B) says
 * the load failed, that the fault is ours, and offers Try again.
 *
 * The panel is an async Server Component: translator, locale and every
 * infrastructure call are stubbed, it is awaited, and its element is rendered
 * inside a client provider (the QuotaDisplay and the retry are client parts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

function makeTranslator(ns: string) {
  const fn = (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(enMessages as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
  fn.has = (key: string): boolean =>
    typeof getPath(getPath(enMessages as unknown, ns), key) === 'string';
  return fn;
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => makeTranslator(ns)),
  getLocale: vi.fn(async () => 'en'),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({
  env: { tenant: { timezone: 'Asia/Bangkok' } },
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/log-id', () => ({
  errKind: () => 'err',
  hashId: () => 'hash',
  rootCause: (e: unknown) => e,
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findLastPlanChangedAt: async () => ({ ok: true, value: null }) },
  }),
}));

const computeQuotaCounter = vi.hoisted(() => vi.fn());
const listMemberBroadcasts = vi.hoisted(() => vi.fn());
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps: () => ({}),
  makeListMemberBroadcastsDeps: () => ({}),
  nextResetAtFor: () => '2027-01-01T00:00:00.000Z',
}));

import { BroadcastsPanel } from '@/app/(member)/portal/benefits/_components/broadcasts-panel';

async function renderPanel(): Promise<void> {
  const ui = await BroadcastsPanel({ requestedPage: 1, memberId: 'm-1' as never });
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Bangkok" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  computeQuotaCounter.mockResolvedValue({
    ok: true,
    value: {
      counter: { used: 1, reserved: 0, remaining: 2, cap: 3 },
      quotaYear: 2026,
      nextResetAt: '2027-01-01T00:00:00.000Z',
      tenantTimezone: 'Asia/Bangkok',
    },
  });
  listMemberBroadcasts.mockRejectedValue(new Error('connection reset'));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the history query fails', () => {
  it('renders the load-error state, not the empty state', async () => {
    await renderPanel();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Your E-Blasts couldn't be loaded.");
    expect(alert).toHaveTextContent(
      'This is a problem on our side, not with your broadcasts. Try again in a moment.',
    );
    expect(screen.queryByTestId('broadcast-empty-state')).toBeNull();
    expect(screen.queryByText('No broadcasts yet')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Compose your first E-Blast' })).toBeNull();
  });

  it('"Try again" re-runs the server component', async () => {
    await renderPanel();

    screen.getByRole('button', { name: 'Try again' }).click();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('still logs the failure and keeps the quota card', async () => {
    await renderPanel();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errKind: 'err' }),
      'broadcasts.benefits_page.list_history_failed',
    );
    expect(screen.getByRole('link', { name: 'Compose E-Blast' })).toBeInTheDocument();
  });
});
