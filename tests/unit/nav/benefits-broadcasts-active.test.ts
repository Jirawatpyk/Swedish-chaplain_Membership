import { beforeAll, describe, expect, it } from 'vitest';
import {
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
} from '@/config/nav';

/** The Benefits nav item (top-nav) — looked up by href so a label change
 *  doesn't break the test. Typed `… | undefined`; the `beforeAll` below
 *  asserts both are defined so a missing nav item produces a clean Vitest
 *  failure (with a diff) instead of an uncaught module-level throw that
 *  would crash the whole file at import time. The `!` at use-sites is
 *  safe because `beforeAll` runs before any `it(...)`. */
const benefitsItem = memberNavConfig.sections
  .flatMap((s) => s.items)
  .find((i) => 'href' in i && i.href === '/portal/benefits');

const benefitsTab = memberBottomTabItems.find((i) => i.href === '/portal/benefits');

describe('Benefits nav active-state on /portal/broadcasts/** (058 G1, review M-2)', () => {
  beforeAll(() => {
    // Guard moved out of module scope (review #6): a module-level throw
    // crashes the entire test FILE at import time (opaque error). Asserting
    // here yields a clean per-test failure if nav.ts drops the item.
    expect(
      benefitsItem,
      'Benefits top-nav item missing (href /portal/benefits) — update nav.ts or this test',
    ).toBeDefined();
    expect(
      benefitsTab,
      'Benefits bottom-tab item missing (href /portal/benefits) — update nav.ts or this test',
    ).toBeDefined();
  });

  it('top-nav Benefits item exists with an any: multi-prefix pattern', () => {
    expect(benefitsItem).toBeDefined();
    expect(benefitsItem!.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
  });

  it('is active on /portal/benefits', () => {
    expect(isNavItemActive('/portal/benefits', benefitsItem!.activePattern)).toBe(true);
  });

  it('stays active on the /portal/benefits/e-blasts child route (redirect target)', () => {
    // isNavItemActive matches the pathname only; the caller strips the query
    // string (?tab=broadcasts), so it never affects active-state. The e-blasts
    // child path must still light Benefits via the plain-prefix arm.
    expect(isNavItemActive('/portal/benefits/e-blasts', benefitsItem!.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/new (compose route preserved)', () => {
    expect(isNavItemActive('/portal/broadcasts/new', benefitsItem!.activePattern)).toBe(true);
  });

  it('stays active on /portal/broadcasts/<id> (detail route preserved)', () => {
    expect(
      isNavItemActive('/portal/broadcasts/3f1a-uuid', benefitsItem!.activePattern),
    ).toBe(true);
  });

  it('is NOT active on /portal/invoices', () => {
    expect(isNavItemActive('/portal/invoices', benefitsItem!.activePattern)).toBe(false);
  });

  it('is NOT active on /portal/benefitsX (prefix-boundary guard)', () => {
    expect(isNavItemActive('/portal/benefitsX', benefitsItem!.activePattern)).toBe(false);
  });

  it('mobile bottom-tab Benefits mirrors the same pattern', () => {
    expect(benefitsTab!.activePattern).toBe('any:/portal/benefits|/portal/broadcasts');
    expect(isNavItemActive('/portal/broadcasts/new', benefitsTab!.activePattern)).toBe(true);
  });
});
