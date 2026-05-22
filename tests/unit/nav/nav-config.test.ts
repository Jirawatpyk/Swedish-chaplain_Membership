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

  it('first section has 8 items: Dashboard, Plans, Members, Invoices, Broadcasts, Events, Renewals, Users (F6 Events nav entry added)', () => {
    const mainSection = staffNavConfig.sections[0]!;
    expect(mainSection.items).toHaveLength(8);
    expect(mainSection.items[0]!.titleKey).toBe('nav.staff.dashboard');
    expect(mainSection.items[1]!.titleKey).toBe('nav.staff.plans');
    expect(mainSection.items[2]!.titleKey).toBe('nav.staff.members');
    expect(mainSection.items[3]!.titleKey).toBe('nav.staff.invoices');
    expect(mainSection.items[4]!.titleKey).toBe('nav.staff.broadcasts');
    // F6 Phase 4/5 — Events entry inserted between Broadcasts and
    // Renewals to keep ops-facing surfaces (Broadcasts → Events) above
    // member-lifecycle surfaces (Renewals → Users).
    expect(mainSection.items[5]!.titleKey).toBe('nav.staff.events');
    const eventsItem = mainSection.items[5]! as NavItem;
    expect(eventsItem.href).toBe('/admin/events');
    expect(mainSection.items[6]!.titleKey).toBe('nav.staff.renewals');
    expect(mainSection.items[7]!.titleKey).toBe('nav.staff.users');
  });

  it('second section is Settings with Invoice + RenewalSchedules + BroadcastSettings + EventCreate (F7.1a US2 entry added)', () => {
    // R7 consolidation removed the Fee Configuration page. VAT +
    // currency + registration fee all live in Invoice Settings now
    // (tenant_invoice_settings is the authoritative source). F8 added
    // Reminder schedules at /admin/settings/renewals/schedules. F6
    // Phase 5 added EventCreate integration setup wizard. F7.1a US2
    // added Broadcast settings (image-source allowlist) at
    // /admin/settings/broadcasts (relocated from /admin/broadcasts/
    // settings to align with centralised-settings IA + auto-derived
    // breadcrumb).
    const settingsSection = staffNavConfig.sections[1]!;
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

describe('memberNavConfig', () => {
  it('has exactly 1 section with 5 items: Dashboard, Profile, Invoices, Broadcasts, Account (F7 e-blasts added)', () => {
    expect(memberNavConfig.sections).toHaveLength(1);
    const section = memberNavConfig.sections[0]!;
    expect(section.items).toHaveLength(5);
    expect(section.items[0]!.titleKey).toBe('nav.member.dashboard');
    expect(section.items[1]!.titleKey).toBe('nav.member.profile');
    // R7-B3 — US3 member invoice self-service inserted between
    // Profile and Account to group "company information" (Profile +
    // Invoices) before "personal settings" (Account).
    expect(section.items[2]!.titleKey).toBe('nav.member.invoices');
    // F7 — E-Blast benefit dashboard entry point.
    expect(section.items[3]!.titleKey).toBe('nav.member.broadcasts');
    expect(section.items[4]!.titleKey).toBe('nav.member.account');
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
