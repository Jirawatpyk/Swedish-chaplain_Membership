import { describe, expect, it } from 'vitest';
import {
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
} from '@/config/nav';

/** The Benefits nav item (top-nav) — looked up by href so a label change
 *  doesn't break the test. */
const benefitsItem = memberNavConfig.sections
  .flatMap((s) => s.items)
  .find((i) => 'href' in i && i.href === '/portal/benefits')!;

const benefitsTab = memberBottomTabItems.find((i) => i.href === '/portal/benefits')!;

describe('Benefits nav active-state on /portal/broadcasts/** (058 G1, review M-2)', () => {
  it('top-nav Benefits item exists with an any: multi-prefix pattern', () => {
    expect(benefitsItem).toBeDefined();
    expect(benefitsItem.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
  });

  it('is active on /portal/benefits', () => {
    expect(isNavItemActive('/portal/benefits', benefitsItem.activePattern)).toBe(true);
  });

  it('is active on /portal/benefits?tab=broadcasts base path', () => {
    expect(isNavItemActive('/portal/benefits', benefitsItem.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/new (compose route preserved)', () => {
    expect(isNavItemActive('/portal/broadcasts/new', benefitsItem.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/<id> (detail route preserved)', () => {
    expect(
      isNavItemActive('/portal/broadcasts/3f1a-uuid', benefitsItem.activePattern),
    ).toBe(true);
  });

  it('is NOT active on /portal/invoices', () => {
    expect(isNavItemActive('/portal/invoices', benefitsItem.activePattern)).toBe(false);
  });

  it('mobile bottom-tab Benefits mirrors the same pattern', () => {
    expect(benefitsTab.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
    expect(isNavItemActive('/portal/broadcasts/new', benefitsTab.activePattern)).toBe(true);
  });
});
