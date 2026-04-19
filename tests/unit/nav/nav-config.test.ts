import { describe, expect, it } from 'vitest';

import {
  isNavGroup,
  memberNavConfig,
  staffNavConfig,
  type NavGroup,
  type NavItem,
} from '@/config/nav';

describe('staffNavConfig', () => {
  it('has exactly 2 sections', () => {
    expect(staffNavConfig.sections).toHaveLength(2);
  });

  it('first section has 5 items: Dashboard, Plans, Members, Invoices, Users', () => {
    const mainSection = staffNavConfig.sections[0]!;
    expect(mainSection.items).toHaveLength(5);
    expect(mainSection.items[0]!.titleKey).toBe('nav.staff.dashboard');
    expect(mainSection.items[1]!.titleKey).toBe('nav.staff.plans');
    expect(mainSection.items[2]!.titleKey).toBe('nav.staff.members');
    expect(mainSection.items[3]!.titleKey).toBe('nav.staff.invoices');
    expect(mainSection.items[4]!.titleKey).toBe('nav.staff.users');
  });

  it('second section is Settings with Fees + InvoiceSettings flat items (R7-B2)', () => {
    // Previously wrapped in a 1-child NavGroup whose single-child-
    // flatten path collapsed it to a flat link. After R7-B2 added a
    // 2nd child, the NavGroup wrapper was removed to avoid a
    // visually-duplicated header ("Settings" section + "Settings"
    // group). Items now render directly under the section header.
    const settingsSection = staffNavConfig.sections[1]!;
    expect(settingsSection.titleKey).toBe('nav.staff.sections.settings');
    expect(settingsSection.items).toHaveLength(2);
    expect(settingsSection.items[0]!.titleKey).toBe('nav.staff.settingsFees');
    expect(settingsSection.items[1]!.titleKey).toBe('nav.staff.settingsInvoices');
    const invoiceSettingsItem = settingsSection.items[1]! as NavItem;
    expect(invoiceSettingsItem.href).toBe('/admin/settings/invoicing');
  });

  it('every NavItem has required fields: titleKey, icon, href, activePattern', () => {
    for (const section of staffNavConfig.sections) {
      for (const item of section.items) {
        expect(item.titleKey).toBeTruthy();
        expect(item.icon).toBeTruthy();
        expect(item.activePattern).toBeTruthy();

        if (isNavGroup(item)) {
          for (const child of item.children) {
            expect(child.titleKey).toBeTruthy();
            expect(child.icon).toBeTruthy();
            expect(child.href).toBeTruthy();
            expect(child.activePattern).toBeTruthy();
          }
        } else {
          expect((item as NavItem).href).toBeTruthy();
        }
      }
    }
  });
});

describe('memberNavConfig', () => {
  it('has exactly 1 section with 3 items: Dashboard, Profile, Account', () => {
    expect(memberNavConfig.sections).toHaveLength(1);
    const section = memberNavConfig.sections[0]!;
    expect(section.items).toHaveLength(3);
    expect(section.items[0]!.titleKey).toBe('nav.member.dashboard');
    expect(section.items[1]!.titleKey).toBe('nav.member.profile');
    expect(section.items[2]!.titleKey).toBe('nav.member.account');
  });

  it('no NavGroups in member config', () => {
    for (const section of memberNavConfig.sections) {
      for (const item of section.items) {
        expect(isNavGroup(item)).toBe(false);
      }
    }
  });
});

describe('isNavGroup type guard', () => {
  it('returns true for items with children', () => {
    const group: NavGroup = {
      titleKey: 'test',
      icon: {} as never,
      activePattern: '/test',
      children: [],
    };
    expect(isNavGroup(group)).toBe(true);
  });

  it('returns false for items without children', () => {
    const item: NavItem = {
      titleKey: 'test',
      icon: {} as never,
      href: '/test',
      activePattern: '/test',
    };
    expect(isNavGroup(item)).toBe(false);
  });
});

// The previous "single-child NavGroup flatten" describe block exercised
// the 1-child Settings NavGroup. After R7-B2 the Settings section was
// flattened to 2 direct items (no NavGroup wrapper), so the flatten
// path in nav-item.tsx is no longer triggered by the staff config.
// The flatten logic still exists in `components/layout/nav-item.tsx`
// for any future 1-child group; its unit coverage can be added back
// against a synthetic config when such a group re-emerges.
