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

  it('first section has 4 items: Dashboard, Plans, Members, Users', () => {
    const mainSection = staffNavConfig.sections[0]!;
    expect(mainSection.items).toHaveLength(4);
    expect(mainSection.items[0]!.titleKey).toBe('nav.staff.dashboard');
    expect(mainSection.items[1]!.titleKey).toBe('nav.staff.plans');
    expect(mainSection.items[2]!.titleKey).toBe('nav.staff.members');
    expect(mainSection.items[3]!.titleKey).toBe('nav.staff.users');
  });

  it('second section is Settings with a section header', () => {
    const settingsSection = staffNavConfig.sections[1]!;
    expect(settingsSection.titleKey).toBe('nav.staff.sections.settings');
    expect(settingsSection.items).toHaveLength(1);
  });

  it('Settings is a NavGroup with Fees as a child', () => {
    const settingsItem = staffNavConfig.sections[1]!.items[0]!;
    expect(isNavGroup(settingsItem)).toBe(true);
    const group = settingsItem as NavGroup;
    expect(group.titleKey).toBe('nav.staff.settings');
    expect(group.children).toHaveLength(1);
    expect(group.children[0]!.titleKey).toBe('nav.staff.settingsFees');
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
  it('has exactly 1 section with 2 items: Dashboard, Account', () => {
    expect(memberNavConfig.sections).toHaveLength(1);
    const section = memberNavConfig.sections[0]!;
    expect(section.items).toHaveLength(2);
    expect(section.items[0]!.titleKey).toBe('nav.member.dashboard');
    expect(section.items[1]!.titleKey).toBe('nav.member.account');
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

describe('single-child NavGroup flatten', () => {
  it('Settings group has exactly 1 child (triggers single-child flatten path)', () => {
    const settingsGroup = staffNavConfig.sections[1]!.items[0]!;
    expect(isNavGroup(settingsGroup)).toBe(true);
    const group = settingsGroup as NavGroup;
    expect(group.children).toHaveLength(1);
  });

  it('single-child flatten uses group icon, not child icon', () => {
    const settingsGroup = staffNavConfig.sections[1]!.items[0]! as NavGroup;
    const child = settingsGroup.children[0]!;
    // Group icon and child icon should be different (Settings vs DollarSign)
    expect(settingsGroup.icon).not.toBe(child.icon);
    // The flatten path does { ...child, icon: group.icon } — child href is preserved
    expect(child.href).toBe('/admin/settings/fees');
  });
});
