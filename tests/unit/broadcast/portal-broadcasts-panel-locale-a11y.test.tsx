// @vitest-environment jsdom
/**
 * F119 portal live walk U30 + U31 — the member quota surface
 * (`/portal/benefits?tab=broadcasts`).
 *
 * **U30** — measured live in `th`: the card header read
 * "โควตา E-Blast (2026)", the exhausted line read "…ของปี 2026 ถูกใช้หมดแล้ว",
 * and directly beneath them the reset line read "รีเซ็ตโควตา 1 มกราคม 2570"
 * with the history table's ส่งเมื่อ column reading "22 ก.ย. 2569" — three
 * calendars on one screen, 544 years apart. Every `{year}` was interpolated as
 * a raw CE integer while every `{date}` went through a locale formatter.
 * Storage is untouched and correct: this is display only (CLAUDE.md
 * § Conventions — Buddhist Era is display-only on `th-TH` surfaces).
 *
 * **U31** — the history `<table>` carries no `<caption>`, no `aria-label` and
 * no `aria-labelledby`. The shared `Table` primitive pulls the caller's
 * `aria-label` off and puts it on the scroll REGION, so a screen-reader user
 * listing the tables on the page finds an anonymous one (SC 1.3.1) — the same
 * class as the F7.1a US1 missing-caption blocker.
 *
 * The panel is an async Server Component: its translator, locale and every
 * infrastructure call are stubbed, then it is awaited and its element handed
 * to `render` (the client `QuotaDisplay` inside it needs a client provider, so
 * the output is wrapped in one at the matching locale).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

const activeLocale = vi.hoisted(() => ({ current: 'en' }));

function makeRealTranslator(ns: string) {
  const messages = activeLocale.current === 'th' ? thMessages : enMessages;
  const fn = (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(messages as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
  fn.has = (key: string): boolean =>
    typeof getPath(getPath(messages as unknown, ns), key) === 'string';
  return fn;
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn(async () => activeLocale.current),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({
  env: { tenant: { timezone: 'Asia/Bangkok' } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({
  errKind: () => 'err',
  hashId: () => 'hash',
  rootCause: (e: unknown) => e,
}));

const findLastPlanChangedAt = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, value: null })),
);
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findLastPlanChangedAt } }),
}));

const computeQuotaCounter = vi.hoisted(() => vi.fn());
const listMemberBroadcasts = vi.hoisted(() => vi.fn());
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps: () => ({}),
  makeListMemberBroadcastsDeps: () => ({}),
  // `quota-banner.ts` re-exports it at module scope, so the barrel double has
  // to carry it or the panel's import chain throws on collect.
  nextResetAtFor: () => '2027-01-01T00:00:00.000Z',
}));

import { BroadcastsPanel } from '@/app/(member)/portal/benefits/_components/broadcasts-panel';

/** `remaining: 0` so the exhausted line AND the disabled-compose tooltip render. */
function setQuota(remaining: number): void {
  computeQuotaCounter.mockResolvedValue({
    ok: true,
    value: {
      counter: { used: 3 - remaining, reserved: 0, remaining, cap: 3 },
      quotaYear: 2026,
      nextResetAt: '2027-01-01T00:00:00.000Z',
      tenantTimezone: 'Asia/Bangkok',
    },
  });
}

function setHistory(): void {
  listMemberBroadcasts.mockResolvedValue({
    page: 1,
    totalPages: 1,
    total: 1,
    rows: [
      {
        broadcastId: 'b-1',
        subject: 'Spring mixer',
        status: 'sent',
        submittedAt: new Date('2026-09-22T13:57:00Z'),
        sentAt: new Date('2026-09-22T14:10:00Z'),
        estimatedRecipientCount: 42,
      },
    ],
  });
}

async function renderPanel(locale: 'en' | 'th'): Promise<void> {
  activeLocale.current = locale;
  const ui = await BroadcastsPanel({
    requestedPage: 1,
    memberId: 'm-1' as never,
  });
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Bangkok"
      messages={locale === 'th' ? thMessages : enMessages}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  setQuota(0);
  setHistory();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('U30 — the Thai quota surface shows ONE calendar', () => {
  it('prints no Gregorian quota year anywhere under th', async () => {
    await renderPanel('th');

    const text = document.body.textContent ?? '';
    // 2026 CE is 2569 BE. The reset date is 1 Jan 2027 CE = 2570 BE, which is
    // a DIFFERENT year in the SAME calendar — that pair is correct.
    expect(text).toContain('2569');
    expect(text).not.toContain('2026');
  });

  // `textContent` cannot see an attribute: the disabled Compose button carries
  // its `{year}` only inside `aria-label` (the tooltip is not rendered while
  // closed), so a raw CE year there would pass the test above.
  it('the disabled Compose button is NAMED with the Buddhist year under th', async () => {
    await renderPanel('th');

    const compose = screen.getByRole('button', { name: /2569/ });
    expect(compose).toHaveAttribute('aria-disabled', 'true');
    expect(compose.getAttribute('aria-label')).not.toContain('2026');
  });

  it('English is unchanged — the Gregorian year still reads 2026', async () => {
    await renderPanel('en');

    const text = document.body.textContent ?? '';
    expect(text).toContain('2026');
    expect(text).not.toContain('2569');
  });
});

describe('U31 — the history table has an accessible name', () => {
  it('the <table> itself is named, not only its scroll region', async () => {
    await renderPanel('en');

    const table = screen.getByRole('table', { name: /my broadcasts/i });
    expect(within(table).getByText('Spring mixer')).toBeInTheDocument();
  });
});
