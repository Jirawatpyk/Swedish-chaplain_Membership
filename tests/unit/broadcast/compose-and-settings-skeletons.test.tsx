// @vitest-environment jsdom
/**
 * F119 U12 (quickstart § 3.1) — the four loading skeletons that drifted from
 * their pages, closed in #400 PR-B. Each assertion names a region the page
 * renders and the skeleton used to omit or mis-shape, so the swap from
 * skeleton to content does not move the layout:
 *   - member compose: the quota card is a four-counter grid (it reserved one
 *     line), and the editor toolbar is a wrap of 44 px controls (it reserved
 *     one h-9 bar);
 *   - staff compose: the editor sits beside the 600 px preview (it reserved
 *     one full-width card), with the same toolbar;
 *   - templates: the New-template button lives in the page header (the
 *     skeleton drew a button row the page does not have) and the three filter
 *     pills sit above the table (it drew none);
 *   - brand settings: reserves the SAVED state — every visit after the first
 *     save is a returning one, so the two first-visit-only lines (the
 *     default-colour hint, the missing-address warning) are not reserved
 *     (#400 U5).
 *
 * #400 U3 — no fixed-width help line may overflow a 320 px column; U4 — the
 * toolbar reserves 13 controls with `FEATURE_F71A_US2_IMAGES` off, 15 on (8 on a phone).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const flags = vi.hoisted(() => ({ images: true }));
vi.mock('@/lib/env', () => ({
  env: {
    get features() {
      return { f71aUs2Images: flags.images };
    },
  },
}));

import PortalComposeLoading from '@/app/(member)/portal/broadcasts/new/loading';
import AdminComposeLoading from '@/app/(staff)/admin/broadcasts/new/loading';
import TemplatesLoading from '@/app/(staff)/admin/broadcasts/templates/loading';
import BrandLoading from '@/app/(staff)/admin/settings/broadcasts/brand/loading';
import NewTemplateLoading from '@/app/(staff)/admin/broadcasts/templates/new/loading';
import EditTemplateLoading from '@/app/(staff)/admin/broadcasts/templates/[id]/edit/loading';

afterEach(() => {
  cleanup();
  flags.images = true;
});

/** The editor toolbar's controls with the image flag on (`tiptap-toolbar.tsx`): 13 + image + banner (Undo and Redo included). */
const TOOLBAR_CONTROLS = 15;
/** On a phone the toolbar is the boards' row: B, I, U, Link, two menus, Undo, Redo (spec 122, 26 Oct 2026). */
const PHONE_CONTROLS = 8;

function expectComposeShape(container: HTMLElement, controls = TOOLBAR_CONTROLS): void {
  const toolbar = container.querySelectorAll('[data-skeleton="toolbar-control"]');
  expect(toolbar).toHaveLength(controls);
  const onPhone = Array.from(toolbar).filter((c) => !c.className.includes('max-sm:hidden'));
  expect(onPhone).toHaveLength(PHONE_CONTROLS);
  for (const control of toolbar) expect(control.className).toContain('h-11');
  const grid = container.querySelector('[data-skeleton="compose-grid"]');
  expect(grid).not.toBeNull();
  expect(grid!.className).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]');
  expect(grid!.querySelector('[data-skeleton="preview-pane"]')).not.toBeNull();
}

describe('U12 — the compose, templates and brand skeletons match their pages', () => {
  it('member compose: a four-counter quota card, and the wrapped 44 px toolbar', async () => {
    const { container } = render(PortalComposeLoading());
    expect(container.querySelectorAll('[data-skeleton="quota-counter"]')).toHaveLength(4);
    expectComposeShape(container);
  });

  it('staff compose: the editor beside the 600 px preview, the member picker first, the same toolbar', async () => {
    const { container } = render((await AdminComposeLoading()) as React.ReactElement);
    expectComposeShape(container);
    expect(container.querySelector('[data-skeleton="member-picker"]')).not.toBeNull();
    // No member is picked on arrival, so no quota card yet (proxy-compose-form).
    expect(container.querySelector('[data-skeleton="quota-counter"]')).toBeNull();
  });

  it('templates: the button in the header, the three filter pills above the table', async () => {
    const { container } = render((await TemplatesLoading()) as React.ReactElement);
    expect(container.querySelector('[data-slot="page-header"] .aura-page-header__actions [data-slot="skeleton-block"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton-block"].h-9')).toHaveLength(1 + 3);
    expect(container.querySelectorAll('[data-skeleton="template-filter-pill"]')).toHaveLength(3);
  });

  it('templates (UX M1): phones get five card blocks, the table rows show from sm up', async () => {
    const { container } = render((await TemplatesLoading()) as React.ReactElement);
    const cards = container.querySelectorAll('[data-skeleton="template-card"]');
    expect(cards).toHaveLength(5);
    for (const card of cards) expect(card.parentElement).toHaveClass('sm:hidden');
    expect(container.querySelector('[data-skeleton="template-rows"]')).toHaveClass('max-sm:hidden');
    // Board parity: the outer card frame drops away on phones, as on the page.
    expect(container.querySelector('.aura-card')).toHaveClass('aura-card--flush-below-sm');
  });

  it('UX L8: the new-template card does not repeat the page title or subtitle', async () => {
    const { container } = render((await NewTemplateLoading()) as React.ReactElement);
    expect(container.querySelectorAll('h2')).toHaveLength(0);
    expect(container.textContent?.match(/newPageDescription/g)).toHaveLength(1);
  });

  it('UX L8: the edit-template card keeps the name block but not a second subtitle', async () => {
    const { container } = render((await EditTemplateLoading()) as React.ReactElement);
    expect(container.textContent?.match(/editPageDescription/g)).toHaveLength(1);
  });

  it('brand settings (#400 U5): the SAVED state — no first-visit-only rows reserved', async () => {
    const { container } = render((await BrandLoading()) as React.ReactElement);
    expect(container.querySelector('[data-skeleton="colour-default-hint"]')).toBeNull();
    expect(container.querySelector('[data-skeleton="address-missing"]')).toBeNull();
  });

  it('#400 U4: with FEATURE_F71A_US2_IMAGES off both compose skeletons reserve the 13 controls the toolbar renders', async () => {
    flags.images = false;
    expectComposeShape(render(PortalComposeLoading()).container, 13);
    cleanup();
    expectComposeShape(render((await AdminComposeLoading()) as React.ReactElement).container, 13);
  });

  it('#400 U3: no fixed-width line wider than a 320 px column (w-64 / w-72 / w-80 are bounded by w-full)', async () => {
    for (const { container } of [
      render(PortalComposeLoading()),
      render((await AdminComposeLoading()) as React.ReactElement),
    ]) {
      const grid = container.querySelector('[data-skeleton="compose-grid"]')!.parentElement!;
      for (const el of grid.querySelectorAll('[class]')) {
        const classes = el.getAttribute('class')!.split(/\s+/);
        if (['w-64', 'w-72', 'w-80'].some((w) => classes.includes(w))) {
          throw new Error(`unbounded fixed width: ${el.getAttribute('class')}`);
        }
      }
    }
  });
});
