/**
 * Spec 122 US3 — every portal page lights the tab it belongs to, as the
 * boards draw it: the profile's sub-pages (edit, change requests, invite a
 * colleague) light Profile, and the activity timeline lights Dashboard.
 * Before, those four pages lit no tab at all, on the phone bar or the desktop
 * nav.
 */
import { describe, expect, it } from 'vitest';
import { isNavItemActive, memberBottomTabItems, memberNavConfig } from '@/config/nav';

const topNav = memberNavConfig.sections.flatMap((s) => s.items).filter((i) => 'href' in i);
const surfaces = { 'top nav': topNav, 'bottom tabs': memberBottomTabItems } as const;

function activeHrefs(items: ReadonlyArray<{ href: string; activePattern: string }>, pathname: string): string[] {
  return items.filter((i) => isNavItemActive(pathname, i.activePattern)).map((i) => i.href);
}

describe.each(Object.entries(surfaces))('portal %s: the parent tab of each page', (_name, items) => {
  it.each([
    ['/portal/edit', '/portal/profile'],
    ['/portal/change-requests', '/portal/profile'],
    ['/portal/contacts/invite', '/portal/profile'],
    ['/portal/profile/directory', '/portal/profile'],
    ['/portal/timeline', '/portal'],
    ['/portal', '/portal'],
  ])('%s lights %s and nothing else', (pathname, href) => {
    expect(activeHrefs(items, pathname)).toEqual([href]);
  });
});

describe('isNavItemActive: an exact entry inside an any: list', () => {
  it('matches that path exactly, not its children', () => {
    expect(isNavItemActive('/portal', 'any:exact:/portal|/portal/timeline')).toBe(true);
    expect(isNavItemActive('/portal/timeline', 'any:exact:/portal|/portal/timeline')).toBe(true);
    expect(isNavItemActive('/portal/invoices', 'any:exact:/portal|/portal/timeline')).toBe(false);
  });
});
