import { describe, expect, it } from 'vitest';

import { staffNavAllowedHrefs } from '@/lib/nav-permissions';
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

/**
 * 016 T063 / PR 5 — the allow-list comes from the REAL resolver; the per-role
 * EXPECTATIONS below stay hand-pinned literals (design § 4.1), so the pair is
 * not circular: if a nav guard key or a bundle drifts, the hand-pinned sets
 * stop matching. The OFF-leg variants of these suites died with the legacy
 * leg. Marketing's sidebar is asserted in `nav-permission-parity.test.ts`.
 */
const ALLOWED = (role: Parameters<typeof staffNavAllowedHrefs>[0]) =>
  new Set(staffNavAllowedHrefs(role));

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

  it('section 3 (Engagement) groups Broadcasts, Events, Marketing audience', () => {
    const engagement = staffNavConfig.sections[3]!;
    expect(engagement.titleKey).toBe('nav.staff.sections.engagement');
    expect(engagement.items.map((i) => i.titleKey)).toEqual([
      'nav.staff.broadcasts',
      'nav.staff.events',
      // 108 PR-D — the E-Blast recipients page; hidden with the section when
      // broadcasts are off (see the both-OFF case below).
      'nav.staff.marketingAudience',
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
    // Administrator-only ACCESS — the page notFound()s for manager + member
    // (no distinct DPO role; the administrator acts as DPO). Hidden from the
    // manager sidebar.
    //
    // 016 T063 — the hand-maintained `roles: ['admin','super_admin']` array is
    // gone; the entry now declares the SAME key its page guards on, and the
    // parity suite proves the two agree by reading both sources. Asserting the
    // pair here would only restate that suite, so this pins what remains
    // local: that the Compliance entry is permissioned at all, and with the
    // administrator-only legacy row that keeps the OFF leg unchanged.
    expect(erasureLog.guard?.key).toBe('members.erasure_log_read');
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

  it('super_admin sees every staff entry incl. the D4 surfaces + the Compliance erasure log', () => {
    // The Broadcasts/Events top-level items carry a visibilityFlag, so the
    // "sees everything" case passes the feature flags ON (the normal runtime
    // state when F6/F7 are enabled).
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: true, eventsEnabled: true },
      ALLOWED('super_admin'),
    );
    expect(filtered.sections).toHaveLength(7);
    const all = hrefs(filtered);
    expect(all).toContain('/admin/users');
    expect(all).toContain('/admin/audit');
    expect(all).toContain('/admin/settings/invoicing');
    expect(all).toContain('/admin/compliance/erasure-log');
    expect(all).toContain('/admin/settings/broadcasts');
    expect(all).toContain('/admin/settings/integrations/eventcreate');
  });

  it('plain admin drops exactly the D4 surfaces: System + Compliance sections and Invoice Settings', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: true, eventsEnabled: true },
      ALLOWED('admin'),
    );
    // users.manage + audit.read empty the System section; the erasure log
    // empties Compliance → 5 sections remain.
    expect(filtered.sections).toHaveLength(5);
    const all = hrefs(filtered);
    expect(all).not.toContain('/admin/users');
    expect(all).not.toContain('/admin/audit');
    expect(all).not.toContain('/admin/compliance/erasure-log');
    expect(all).not.toContain('/admin/settings/invoicing');
    // Everything non-D4 stays, including the admin-writable settings.
    expect(all).toContain('/admin/invoices');
    expect(all).toContain('/admin/settings/renewals/schedules');
    expect(all).toContain('/admin/settings/broadcasts');
    expect(all).toContain('/admin/settings/integrations/eventcreate');
  });

  it('manager keeps the read surfaces and loses System, Compliance and ALL of Settings', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: true, eventsEnabled: true },
      ALLOWED('manager'),
    );
    // Manager holds no settings.* key (declared narrowing, design § 10), no
    // users.manage, no audit.read, no erasure-log read → three whole sections
    // empty out: Overview, Membership, Finance, Engagement remain.
    expect(filtered.sections).toHaveLength(4);
    const all = hrefs(filtered);
    // CWE-285 — the erasure-evidence log must NEVER appear in a manager
    // sidebar (it would 404 server-side AND the link hints the surface exists).
    expect(all).not.toContain('/admin/compliance/erasure-log');
    expect(all).not.toContain('/admin/users');
    expect(all).not.toContain('/admin/audit');
    expect(all).not.toContain('/admin/settings/invoicing');
    expect(all).not.toContain('/admin/settings/renewals/schedules');
    // Read-only-but-visible surfaces stay.
    expect(all).toContain('/admin/invoices');
    expect(all).toContain('/admin/credit-notes');
    expect(all).toContain('/admin/members');
    expect(all).toContain('/admin/renewals');
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
    filterNavConfig(staffNavConfig, flags, ALLOWED('admin')).sections.flatMap((s) =>
      s.items.map((i) => (i as NavItem).href),
    );

  it('both flags ON → Broadcasts + Events top-nav AND their Settings entries present', () => {
    const all = staffHrefs({ broadcastsEnabled: true, eventsEnabled: true });
    expect(all).toContain('/admin/broadcasts');
    expect(all).toContain('/admin/events');
    expect(all).toContain('/admin/settings/broadcasts');
    expect(all).toContain('/admin/settings/integrations/eventcreate');
  });

  it('F7 OFF → Broadcasts top-nav AND Broadcast Settings hidden; Events untouched', () => {
    const all = staffHrefs({ broadcastsEnabled: false, eventsEnabled: true });
    expect(all).not.toContain('/admin/broadcasts');
    expect(all).not.toContain('/admin/settings/broadcasts');
    expect(all).toContain('/admin/events');
    expect(all).toContain('/admin/settings/integrations/eventcreate');
  });

  it('F6 OFF → Events top-nav AND EventCreate Integration settings hidden; Broadcasts untouched', () => {
    const all = staffHrefs({ broadcastsEnabled: true, eventsEnabled: false });
    expect(all).not.toContain('/admin/events');
    expect(all).not.toContain('/admin/settings/integrations/eventcreate');
    expect(all).toContain('/admin/broadcasts');
    expect(all).toContain('/admin/settings/broadcasts');
  });

  it('both OFF → the Engagement section drops entirely; Settings keeps its non-F6/F7 entries', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: false, eventsEnabled: false },
      ALLOWED('admin'),
    );
    expect(filtered.sections.map((s) => s.titleKey)).not.toContain(
      'nav.staff.sections.engagement',
    );
    // Engagement drops, and a plain admin already lost System + Compliance to
    // D4 → 4 sections. Settings survives via Renewal Schedules.
    expect(filtered.sections).toHaveLength(4);
    const settings = filtered.sections.find(
      (s) => s.titleKey === 'nav.staff.sections.settings',
    );
    const settingsHrefs = settings!.items.map((i) => (i as NavItem).href);
    expect(settingsHrefs).toContain('/admin/settings/renewals/schedules');
    expect(settingsHrefs).not.toContain('/admin/settings/broadcasts');
    expect(settingsHrefs).not.toContain(
      '/admin/settings/integrations/eventcreate',
    );
  });

  it('absent flags default to HIDDEN (closed-union safety) — top-nav AND settings entries', () => {
    const all = staffHrefs({});
    expect(all).not.toContain('/admin/broadcasts');
    expect(all).not.toContain('/admin/events');
    expect(all).not.toContain('/admin/settings/broadcasts');
    expect(all).not.toContain('/admin/settings/integrations/eventcreate');
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
    const off = filterNavConfig(config, {});
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
    const on = filterNavConfig(config, { eventcreateConfigured: true });
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
    const filtered = filterNavConfig(config, {});
    expect(filtered.sections).toHaveLength(1);
    expect(filtered.sections[0]!.titleKey).toBe('survivor');
  });

  it('recurses into a NavGroup: a guarded child outside the allow-list is hidden', () => {
    // PR 5 deleted the `roles` allow-list; the mechanism under test is now the
    // guard + allowedHrefs pair, which is also what production runs.
    const group: NavGroup = {
      titleKey: 'group',
      icon: ICON,
      activePattern: '/group',
      children: [
        item('/group/shared'),
        item('/group/guarded', { guard: { key: 'users.manage' } }),
      ],
    };
    const config: NavConfig = {
      sections: [{ titleKey: 'sec', items: [group] }],
    };

    // Allow-list without the guarded href: the child drops, the group stays.
    const narrow = filterNavConfig(config, {}, new Set(['/group/shared']));
    const narrowGroup = narrow.sections[0]!.items[0]! as NavGroup;
    expect(isNavGroup(narrowGroup)).toBe(true);
    expect(narrowGroup.children.map((c) => c.href)).toEqual(['/group/shared']);

    // Allow-list with both: both children survive (proves the drop above was
    // permission-driven, not structural).
    const wide = filterNavConfig(config, {}, new Set(['/group/shared', '/group/guarded']));
    const wideGroup = wide.sections[0]!.items[0]! as NavGroup;
    expect(wideGroup.children.map((c) => c.href)).toEqual([
      '/group/shared',
      '/group/guarded',
    ]);
  });

  it('drops a NavGroup (and its now-empty section) when filtering leaves it with no children', () => {
    const group: NavGroup = {
      titleKey: 'group',
      icon: ICON,
      activePattern: '/group',
      children: [item('/group/guarded', { guard: { key: 'users.manage' } })],
    };
    const config: NavConfig = {
      sections: [{ titleKey: 'sec', items: [group] }],
    };
    // Empty allow-list: the only child is guarded → group has 0 visible
    // children → group dropped → section emptied → zero sections. This is the
    // fail-closed default when a caller forgets the allow-list entirely.
    const filtered = filterNavConfig(config, {}, new Set());
    expect(filtered.sections).toHaveLength(0);
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
