import { describe, expect, it } from 'vitest';

import {
  filterNavConfig,
  isNavGroup,
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
  staffNavConfig,
  type NavConfig,
  type NavGroup,
  type NavItem,
} from '@/config/nav';

describe('staffNavConfig', () => {
  it('has exactly 7 sections: Overview, Membership, Finance, Engagement, System, Compliance, Settings', () => {
    expect(staffNavConfig.sections).toHaveLength(7);
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

  it('section 5 (Compliance) holds the admin-only Erasure Log (COMP-1 US3-D)', () => {
    const compliance = staffNavConfig.sections[5]!;
    expect(compliance.titleKey).toBe('nav.staff.sections.compliance');
    expect(compliance.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.erasureLog',
    ]);
    const erasureLog = compliance.items[0]! as NavItem;
    expect(erasureLog.href).toBe('/admin/compliance/erasure-log');
    // Admin-only ACCESS — the page notFound()s for manager + member (no
    // distinct DPO role; admin acts as DPO). Hidden from the manager sidebar.
    expect(erasureLog.roles).toEqual(['admin']);
  });

  it('section 6 is Settings with Invoice + RenewalSchedules + BroadcastSettings + EventCreate', () => {
    // R7 consolidation removed the Fee Configuration page (VAT + currency
    // + registration fee live in Invoice Settings). F8 added Reminder
    // schedules; F6 added the EventCreate setup wizard; F7.1a US2 added
    // Broadcast settings (image-source allowlist) at /admin/settings/
    // broadcasts. The Settings header is unchanged by the 5-group regroup.
    const settingsSection = staffNavConfig.sections[6]!;
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

describe('filterNavConfig (role + visibility-flag filtering)', () => {
  const hrefs = (cfg: NavConfig) =>
    cfg.sections.flatMap((s) => s.items.map((i) => (i as NavItem).href));

  it('admin sees every staff entry incl. both admin-only Settings pages + the Compliance erasure log', () => {
    // 016 — the Broadcasts/Events top-level items now carry a visibilityFlag,
    // so the "sees everything" case passes the feature flags ON (the normal
    // runtime state when F6/F7 are enabled); otherwise those items + the whole
    // Engagement section would drop.
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: true, eventsEnabled: true },
      'admin',
    );
    // 7 sections survive — the Compliance section has an admin-visible item.
    expect(filtered.sections).toHaveLength(7);
    const all = hrefs(filtered);
    expect(all).toContain('/admin/broadcasts');
    expect(all).toContain('/admin/events');
    expect(all).toContain('/admin/settings/broadcasts');
    expect(all).toContain('/admin/settings/integrations/eventcreate');
    expect(all).toContain('/admin/compliance/erasure-log');
  });

  it('manager drops the 2 admin-only Settings pages + the whole Compliance section, keeps everything else', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: true, eventsEnabled: true },
      'manager',
    );
    // The Compliance section's only item is admin-only → the section empties →
    // it is dropped. Settings survives (Invoice Settings + Renewal Schedules
    // stay manager-readable, rendered read-only), so 6 sections remain and
    // Settings is the last surviving section (index 5 after Compliance drops).
    expect(filtered.sections).toHaveLength(6);
    expect(filtered.sections[5]!.items.map((i) => (i as NavItem).href)).toEqual([
      '/admin/settings/invoicing',
      '/admin/settings/renewals/schedules',
    ]);
    const all = hrefs(filtered);
    expect(all).not.toContain('/admin/settings/broadcasts');
    expect(all).not.toContain('/admin/settings/integrations/eventcreate');
    // CWE-285 — the erasure-evidence log must NEVER appear in a manager sidebar
    // (it would 404 server-side AND the link itself hints the surface exists).
    expect(all).not.toContain('/admin/compliance/erasure-log');
    // Read-only-but-visible surfaces stay (manager reads them; the page
    // disables writes, the nav entry is NOT hidden).
    expect(all).toContain('/admin/users');
    expect(all).toContain('/admin/invoices');
    expect(all).toContain('/admin/credit-notes');
    expect(all).toContain('/admin/audit');
  });
});

// ---------------------------------------------------------------------------
// 016 — F6 (Events) / F7 (Broadcasts) feature-flag nav gating. The staff
// layout resolves `broadcastsEnabled` / `eventsEnabled` from
// `env.features.f7Broadcasts` / `f6EventCreate` and passes them here. When a
// feature kill-switch is OFF, its top-level nav item must disappear so the
// sidebar never shows a link that 503s (F7 proxy) / 404s (F6 `notFound()`) on
// click. Exercised against the LIVE staffNavConfig (not a synthetic one).
// ---------------------------------------------------------------------------
describe('filterNavConfig — F6/F7 feature-flag nav gating (016, live config)', () => {
  const staffHrefs = (flags: Parameters<typeof filterNavConfig>[1]) =>
    filterNavConfig(staffNavConfig, flags, 'admin').sections.flatMap((s) =>
      s.items.map((i) => (i as NavItem).href),
    );

  it('both flags ON → Broadcasts + Events nav items present', () => {
    const all = staffHrefs({ broadcastsEnabled: true, eventsEnabled: true });
    expect(all).toContain('/admin/broadcasts');
    expect(all).toContain('/admin/events');
  });

  it('F7 OFF → Broadcasts hidden, Events still shown', () => {
    const all = staffHrefs({ broadcastsEnabled: false, eventsEnabled: true });
    expect(all).not.toContain('/admin/broadcasts');
    expect(all).toContain('/admin/events');
  });

  it('F6 OFF → Events hidden, Broadcasts still shown', () => {
    const all = staffHrefs({ broadcastsEnabled: true, eventsEnabled: false });
    expect(all).not.toContain('/admin/events');
    expect(all).toContain('/admin/broadcasts');
  });

  it('both OFF → the Engagement section drops entirely (no orphan header), 7→6 sections', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: false, eventsEnabled: false },
      'admin',
    );
    expect(filtered.sections.map((s) => s.titleKey)).not.toContain(
      'nav.staff.sections.engagement',
    );
    expect(filtered.sections).toHaveLength(6);
  });

  it('absent flags default to HIDDEN (closed-union safety — a layout that forgets to pass them never leaks a dead link)', () => {
    const all = staffHrefs({});
    expect(all).not.toContain('/admin/broadcasts');
    expect(all).not.toContain('/admin/events');
  });
});

// ---------------------------------------------------------------------------
// S16 (067 speckit-review) — the live staffNavConfig today has NO flagged item
// and NO NavGroup, so `filterNavConfig`'s `visibilityFlag` branch and the new
// NavGroup-children recursion (S17) are unexercised by the config-shape tests
// above. These synthetic-config tests pin both code paths directly so a
// regression (flag ignored, or an admin-only child leaking to a manager
// through a group) fails loudly. Synthetic items follow the same `{} as never`
// icon shape used by the isNavGroup type-guard tests below — filterNavConfig is
// pure and never renders the icon.
// ---------------------------------------------------------------------------
describe('filterNavConfig — synthetic visibilityFlag + NavGroup recursion (S16)', () => {
  const ICON = {} as never;

  function item(href: string, extra?: Partial<NavItem>): NavItem {
    return {
      titleKey: `key.${href}`,
      icon: ICON,
      href,
      activePattern: href as NavItem['activePattern'],
      ...extra,
    };
  }

  it('drops a flagged item when its visibilityFlag is OFF, keeps an always-on sibling', () => {
    const config: NavConfig = {
      sections: [
        {
          titleKey: 'sec',
          items: [
            item('/always'),
            item('/flagged', { visibilityFlag: 'eventcreateConfigured' }),
          ],
        },
      ],
    };
    // Flag absent (→ false): the flagged item is dropped, the sibling stays.
    const off = filterNavConfig(config, {}, 'admin');
    const offHrefs = off.sections[0]!.items.map((i) => (i as NavItem).href);
    expect(offHrefs).toEqual(['/always']);
  });

  it('keeps a flagged item when its visibilityFlag is ON', () => {
    const config: NavConfig = {
      sections: [
        {
          titleKey: 'sec',
          items: [item('/flagged', { visibilityFlag: 'eventcreateConfigured' })],
        },
      ],
    };
    const on = filterNavConfig(config, { eventcreateConfigured: true }, 'admin');
    expect(on.sections).toHaveLength(1);
    expect((on.sections[0]!.items[0]! as NavItem).href).toBe('/flagged');
  });

  it('drops a section that is emptied by filtering (no orphan header)', () => {
    const config: NavConfig = {
      sections: [
        {
          titleKey: 'flagged-only',
          items: [item('/flagged', { visibilityFlag: 'eventcreateConfigured' })],
        },
        { titleKey: 'survivor', items: [item('/keep')] },
      ],
    };
    // Flag off → the first section empties → it is removed; only 'survivor' left.
    const filtered = filterNavConfig(config, {}, 'admin');
    expect(filtered.sections).toHaveLength(1);
    expect(filtered.sections[0]!.titleKey).toBe('survivor');
  });

  it('recurses into a NavGroup: an admin-only child is hidden from the manager role', () => {
    const group: NavGroup = {
      titleKey: 'group',
      icon: ICON,
      activePattern: '/group',
      children: [
        item('/group/shared'),
        item('/group/admin-only', { roles: ['admin'] }),
      ],
    };
    const config: NavConfig = {
      sections: [{ titleKey: 'sec', items: [group] }],
    };

    // Manager: the admin-only child is dropped, the shared child survives, and
    // the group itself stays (it still has ≥1 visible child).
    const forManager = filterNavConfig(config, {}, 'manager');
    const mgrGroup = forManager.sections[0]!.items[0]! as NavGroup;
    expect(isNavGroup(mgrGroup)).toBe(true);
    expect(mgrGroup.children.map((c) => c.href)).toEqual(['/group/shared']);

    // Admin: sees both children (proves the manager drop was role-driven).
    const forAdmin = filterNavConfig(config, {}, 'admin');
    const adminGroup = forAdmin.sections[0]!.items[0]! as NavGroup;
    expect(adminGroup.children.map((c) => c.href)).toEqual([
      '/group/shared',
      '/group/admin-only',
    ]);
  });

  it('drops a NavGroup (and its now-empty section) when filtering leaves it with no children', () => {
    const group: NavGroup = {
      titleKey: 'group',
      icon: ICON,
      activePattern: '/group',
      children: [item('/group/admin-only', { roles: ['admin'] })],
    };
    const config: NavConfig = {
      sections: [{ titleKey: 'sec', items: [group] }],
    };
    // Manager: the only child is admin-only → group has 0 visible children →
    // group dropped → section emptied → section dropped → zero sections.
    const forManager = filterNavConfig(config, {}, 'manager');
    expect(forManager.sections).toHaveLength(0);
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
