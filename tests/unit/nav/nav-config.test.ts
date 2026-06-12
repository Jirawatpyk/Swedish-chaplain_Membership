import { describe, expect, it } from 'vitest';

import {
  isNavGroup,
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
  staffNavConfig,
  type NavGroup,
  type NavItem,
} from '@/config/nav';

describe('staffNavConfig', () => {
  it('has exactly 6 sections: Overview, Membership, Finance, Engagement, System, Settings', () => {
    expect(staffNavConfig.sections).toHaveLength(6);
  });

  it('section 0 (Overview) has no header and only Dashboard', () => {
    const overview = staffNavConfig.sections[0]!;
    expect(overview.titleKey).toBeUndefined();
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]!.titleKey).toBe('nav.staff.dashboard');
    expect((overview.items[0]! as NavItem).href).toBe('/admin');
  });

  it('section 1 (Membership) groups Members, Plans, Renewals, Directory', () => {
    const membership = staffNavConfig.sections[1]!;
    expect(membership.titleKey).toBe('nav.staff.sections.membership');
    expect(membership.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.members',
      'nav.staff.plans',
      'nav.staff.renewals',
      'nav.staff.directory',
    ]);
  });

  it('section 2 (Finance) holds Invoices, Credit Notes', () => {
    const finance = staffNavConfig.sections[2]!;
    expect(finance.titleKey).toBe('nav.staff.sections.finance');
    expect(finance.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.invoices',
      'nav.staff.creditNotes',
    ]);
    expect((finance.items[0]! as NavItem).href).toBe('/admin/invoices');
    expect((finance.items[1]! as NavItem).href).toBe('/admin/credit-notes');
  });

  it('section 3 (Engagement) groups Broadcasts, Events', () => {
    const engagement = staffNavConfig.sections[3]!;
    expect(engagement.titleKey).toBe('nav.staff.sections.engagement');
    expect(engagement.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.broadcasts',
      'nav.staff.events',
    ]);
    expect((engagement.items[1]! as NavItem).href).toBe('/admin/events');
  });

  it('section 4 (System) groups Users, Audit', () => {
    const system = staffNavConfig.sections[4]!;
    expect(system.titleKey).toBe('nav.staff.sections.system');
    expect(system.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.users',
      'nav.staff.audit',
    ]);
  });

  it('section 5 is Settings with Invoice + RenewalSchedules + BroadcastSettings + EventCreate', () => {
    // R7 consolidation removed the Fee Configuration page (VAT + currency
    // + registration fee live in Invoice Settings). F8 added Reminder
    // schedules; F6 added the EventCreate setup wizard; F7.1a US2 added
    // Broadcast settings (image-source allowlist) at /admin/settings/
    // broadcasts. The Settings header is unchanged by the 5-group regroup.
    const settingsSection = staffNavConfig.sections[5]!;
    expect(settingsSection.titleKey).toBe('nav.staff.sections.settings');
    expect(settingsSection.items).toHaveLength(4);
    expect(settingsSection.items[0]!.titleKey).toBe('nav.staff.settingsInvoices');
    const invoiceSettingsItem = settingsSection.items[0]! as NavItem;
    expect(invoiceSettingsItem.href).toBe('/admin/settings/invoicing');
    expect(settingsSection.items[1]!.titleKey).toBe(
      'nav.staff.settingsRenewalSchedules',
    );
    const renewalSchedulesItem = settingsSection.items[1]! as NavItem;
    expect(renewalSchedulesItem.href).toBe(
      '/admin/settings/renewals/schedules',
    );
    // F7.1a US2 — broadcast settings (image-source allowlist).
    expect(settingsSection.items[2]!.titleKey).toBe(
      'nav.staff.settingsBroadcasts',
    );
    const broadcastSettingsItem = settingsSection.items[2]! as NavItem;
    expect(broadcastSettingsItem.href).toBe('/admin/settings/broadcasts');

    // Structural sibling — survives nav reordering. If a future commit
    // inserts a new Settings entry above broadcasts, the positional
    // asserts above fail loudly while this one keeps verifying the
    // entry itself still exists with the right href + titleKey contract.
    const broadcastsByHref = settingsSection.items.find(
      (item): item is NavItem =>
        !isNavGroup(item) &&
        (item as NavItem).href === '/admin/settings/broadcasts',
    );
    expect(broadcastsByHref?.titleKey).toBe('nav.staff.settingsBroadcasts');

    // F6 Phase 5 — integration setup wizard entry.
    expect(settingsSection.items[3]!.titleKey).toBe(
      'nav.staff.settingsIntegrationEventcreate',
    );
    const integrationItem = settingsSection.items[3]! as NavItem;
    expect(integrationItem.href).toBe(
      '/admin/settings/integrations/eventcreate',
    );
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

describe('memberNavConfig (057 — 4 desktop top-nav destinations)', () => {
  it('has exactly 1 section with 4 items: Dashboard, Profile, Invoices, Benefits', () => {
    expect(memberNavConfig.sections).toHaveLength(1);
    const section = memberNavConfig.sections[0]!;
    expect(section.items).toHaveLength(4);
    expect(section.items[0]!.titleKey).toBe('nav.member.dashboard');
    expect(section.items[1]!.titleKey).toBe('nav.member.profile');
    expect(section.items[2]!.titleKey).toBe('nav.member.invoices');
    expect(section.items[3]!.titleKey).toBe('nav.member.benefits');
  });

  it('drops Broadcasts/Timeline/RenewalPrefs/Account from the desktop top-nav', () => {
    const keys = memberNavConfig.sections[0]!.items.map((i) => i.titleKey);
    expect(keys).not.toContain('nav.member.broadcasts');
    expect(keys).not.toContain('nav.member.timeline');
    expect(keys).not.toContain('nav.member.renewalPrefs');
    expect(keys).not.toContain('nav.member.account');
  });

  it('no NavGroups in member config', () => {
    for (const section of memberNavConfig.sections) {
      for (const item of section.items) {
        expect(isNavGroup(item)).toBe(false);
      }
    }
  });

  it('Benefits item keeps active state on /portal/benefits AND /portal/broadcasts/** (review M-2)', () => {
    const benefits = memberNavConfig.sections[0]!.items[3]! as NavItem;
    expect(isNavItemActive('/portal/benefits', benefits.activePattern)).toBe(true);
    expect(isNavItemActive('/portal/benefits/e-blasts', benefits.activePattern)).toBe(true);
    expect(isNavItemActive('/portal/broadcasts/new', benefits.activePattern)).toBe(true);
    expect(isNavItemActive('/portal/broadcasts/abc123', benefits.activePattern)).toBe(true);
    // Negative: must NOT light up on unrelated routes.
    expect(isNavItemActive('/portal/profile', benefits.activePattern)).toBe(false);
  });
});

describe('memberBottomTabItems (057 — 5 mobile tabs)', () => {
  it('has exactly 5 tabs: Dashboard, Profile, Invoices, Benefits, Account', () => {
    expect(memberBottomTabItems).toHaveLength(5);
    expect(memberBottomTabItems.map((t) => t.titleKey)).toEqual([
      'nav.member.dashboard',
      'nav.member.profile',
      'nav.member.invoices',
      'nav.member.benefits',
      'nav.member.account',
    ]);
  });

  it('every tab has titleKey, icon, href, activePattern', () => {
    for (const tab of memberBottomTabItems) {
      expect(tab.titleKey).toBeTruthy();
      expect(tab.icon).toBeTruthy();
      expect(tab.href).toBeTruthy();
      expect(tab.activePattern).toBeTruthy();
    }
  });

  it('overflow-prone tabs (Benefits, Account) carry a shortTitleKey for the TH label', () => {
    const benefits = memberBottomTabItems[3]!;
    const account = memberBottomTabItems[4]!;
    expect(benefits.shortTitleKey).toBe('nav.member.benefitsShort');
    expect(account.shortTitleKey).toBe('nav.member.accountShort');
  });

  it('Benefits tab also keeps active on /portal/broadcasts/** (mobile parity)', () => {
    const benefits = memberBottomTabItems[3]!;
    expect(isNavItemActive('/portal/broadcasts/new', benefits.activePattern)).toBe(true);
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
