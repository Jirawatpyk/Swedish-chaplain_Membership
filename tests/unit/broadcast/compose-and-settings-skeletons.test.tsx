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
 *   - brand settings: the two lines that render on a FIRST visit — the
 *     default-colour hint and the missing-address warning — are reserved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import PortalComposeLoading from '@/app/(member)/portal/broadcasts/new/loading';
import AdminComposeLoading from '@/app/(staff)/admin/broadcasts/new/loading';
import TemplatesLoading from '@/app/(staff)/admin/broadcasts/templates/loading';
import BrandLoading from '@/app/(staff)/admin/settings/broadcasts/brand/loading';

afterEach(cleanup);

/** The editor toolbar's controls with the image flag on (`tiptap-toolbar.tsx`): 11 + image + banner. */
const TOOLBAR_CONTROLS = 13;

function expectComposeShape(container: HTMLElement): void {
  const toolbar = container.querySelectorAll('[data-skeleton="toolbar-control"]');
  expect(toolbar).toHaveLength(TOOLBAR_CONTROLS);
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
    expect(container.querySelector('[data-slot="page-header-actions"] [data-slot="skeleton-block"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton-block"].h-9')).toHaveLength(1 + 3);
    expect(container.querySelectorAll('[data-skeleton="template-filter-pill"]')).toHaveLength(3);
  });

  it('brand settings: the first-visit default-colour hint and missing-address warning are reserved', async () => {
    const { container } = render((await BrandLoading()) as React.ReactElement);
    expect(container.querySelector('[data-skeleton="colour-default-hint"]')).not.toBeNull();
    expect(container.querySelector('[data-skeleton="address-missing"]')).not.toBeNull();
  });
});
