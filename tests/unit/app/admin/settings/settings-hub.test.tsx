/**
 * Spec 122 US10c (T1021; board `Admin-settings`, `-mobile`,
 * `Admin-state-settings-none`) — the settings hub on AURA: one AURA card per
 * visible category, the whole card a single link named by its title (icon
 * tile, title, description, chevron), and the empty state in a card when the
 * viewer holds no settings surface. The visibility rules themselves are
 * pinned by settings-index-permissions.test.ts.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (same approach as audit-page-frame).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined), obj);
}

const { roleRef } = vi.hoisted(() => ({ roleRef: { role: 'super_admin' } }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => {
    const val = getPath(getPath(en as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  }),
}));

// Visibility is settings-index-permissions.test.ts's job: here a super admin
// sees every card and a member none.
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockImplementation(async () => ({ user: { id: 'u1', role: roleRef.role } })),
  canPerform: (role: string) => role === 'super_admin',
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f7Broadcasts: true, f6EventCreate: true, memberChangeApproval: true } },
}));

import SettingsIndexPage from '@/app/(staff)/admin/settings/page';

const t = en.admin.settings.index;

async function renderHub(): Promise<HTMLElement> {
  const html = renderToStaticMarkup((await SettingsIndexPage()) as ReactElement);
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

beforeEach(() => {
  roleRef.role = 'super_admin';
});

describe('settings hub on AURA', () => {
  it('draws one AURA card per visible category, each one link named by its title', async () => {
    const root = await renderHub();
    const cards = root.querySelectorAll('.aura-card');
    expect(cards).toHaveLength(6);
    const invoicing = [...root.querySelectorAll('a')].find((a) => a.textContent?.trim() === t.categories.invoicing.title);
    expect(invoicing).toBeDefined();
    expect(invoicing!.getAttribute('href')).toBe('/admin/settings/invoicing');
    // One link per card — the whole card is a single tab stop.
    for (const card of cards) expect(card.querySelectorAll('a')).toHaveLength(1);
  });

  it('shows each category description in its card', async () => {
    const root = await renderHub();
    expect(root.textContent).toContain(t.categories.memberChanges.description);
    expect(root.textContent).toContain(t.categories.integrationsEventcreate.description);
  });

  it('stretches the title link over the whole card (board: the card is the target)', async () => {
    const root = await renderHub();
    const link = root.querySelector('.aura-card a')!;
    expect(link.className).toMatch(/after:absolute/);
    expect(link.className).toMatch(/after:inset-0/);
    expect(link.closest('.aura-card')!.className).toMatch(/relative/);
  });

  it('lays the cards out two up from md and one column below', async () => {
    const root = await renderHub();
    const grid = root.querySelector('.aura-card')!.parentElement!;
    expect(grid.className).toMatch(/grid/);
    expect(grid.className).toMatch(/md:grid-cols-2/);
  });

  it('with no settings surface, the empty state sits in an AURA card', async () => {
    roleRef.role = 'member';
    const root = await renderHub();
    expect(root.querySelectorAll('a')).toHaveLength(0);
    const card = root.querySelector('.aura-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(t.empty);
  });
});
