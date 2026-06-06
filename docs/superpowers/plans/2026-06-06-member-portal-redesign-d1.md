# Member Portal Redesign — D1 (Nav + Dashboard + Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the pre-launch member-value deliverable (D1) of the portal redesign — a streamlined navigation (desktop top-nav + mobile bottom-tabs + avatar Account menu), an at-a-glance Dashboard, and a member-facing Profile.

**Architecture:** Presentation + IA only — reuses existing F3–F9 reads via module barrels (RLS-safe, `memberId` from session). Nav = the existing `memberNavConfig` restructured to 4 desktop top-nav items + a new `memberBottomTabItems` (5 mobile tabs) + the avatar via the existing `UserMenu` (shadcn `DropdownMenu`/Radix). Dashboard + Profile reuse `PageHeader`, `Card`, `Badge`, `DetailField`, `BenefitUsageCard`, `InvoicesSummaryCard`, `loadMemberRenewalStatus`, `computeBenefitUsage`, the localised date helper.

**Tech Stack:** Next.js 16 App Router (RSC) · React 19 · TypeScript strict · next-intl (EN/TH/SV; `th` = Buddhist-Era display-only) · shadcn/ui + Tailwind v4 + lucide-react · vitest + @testing-library/react · Playwright + @axe-core/playwright. pnpm. WCAG 2.1 AA.

**Spec:** `docs/superpowers/specs/2026-06-06-member-portal-redesign-design.md` (D1 deliverable; §-references inline). **Branch:** `057-member-portal-redesign` (cut from `056`; land `056`→main then rebase — spec §9).

**Conventions (every task):** TDD (failing test → red → implement → green → commit); exact paths; explicit `git add` (never `git add .`); conventional commits ≤100 chars; fresh non-masked typecheck before each commit (temp tsconfig excl `.next`); every new label needs EN/TH/SV keys (`pnpm check:i18n`). Each deliverable exit gate: `@axe-core/playwright` 0 violations + a cross-tenant integration test (member A never sees member B data — Principle I).

---

## File Structure

**G1 — Nav shell (top-nav + bottom-tabs + avatar Account menu)**

- `src/config/nav.ts` — _Modify (memberNavConfig ~244-312; add memberBottomTabItems + extend NavItem)_ — Restructure memberNavConfig to the 4 desktop top-nav destinations (Dashboard/Profile/Invoices/Benefits); add exported memberBottomTabItems (5 mobile tabs) + a shortTitleKey field on NavItem for tab labels; Benefits activePattern matches /portal/benefits AND /portal/broadcasts.
- `tests/unit/nav/nav-config.test.ts` — _Modify (rewrite the memberNavConfig describe block ~111-141)_ — Pin the 4 desktop items, the 5 bottom-tab items, Benefits active-state across /portal/benefits + /portal/broadcasts/new, and shortTitleKey presence on overflow-prone tabs.
- `src/components/layout/member-nav.tsx` — _Modify (full rewrite ~1-55)_ — Desktop top-nav: 4 items, VISIBLE text labels, aria-current=page on active, focus-visible, hidden < lg.
- `tests/unit/components/layout/member-nav.test.tsx` — _Create_ — Assert 4 visible-label links, aria-current=page on the active route incl. /portal/broadcasts keeping Benefits active, and the desktop-only (lg:flex / hidden) class.
- `src/components/layout/member-bottom-tabs.tsx` — _Create_ — Mobile bottom tab bar: 5 tabs, fixed bottom, <nav aria-label>, icon + visible short label, aria-current=page, ≥44px targets, env(safe-area-inset-bottom) padding, hidden ≥ lg.
- `tests/unit/components/layout/member-bottom-tabs.test.tsx` — _Create_ — Assert 5 tab links, visible short labels, aria-current=page on active, min-h-[44px]/min-w-[44px] targets, unique nav aria-label, mobile-only (lg:hidden).
- `src/components/shell/user-menu.tsx` — _Modify (extend the member branch of the DropdownMenu ~95-109)_ — Desktop avatar Account hub: dropdown links to /portal/account + #renewal-prefs + #data-privacy anchors, embedded theme toggle, existing sign-out — only for role member.
- `tests/unit/components/shell/user-menu.test.tsx` — _Create_ — Assert the member dropdown exposes Account-hub anchor links (/portal/account, #renewal-prefs, #data-privacy), theme items, and sign-out, all reachable via role=menu.
- `src/app/(member)/portal/layout.tsx` — _Modify (render MemberNav desktop-only + add MemberBottomTabs; add <main> pb ~58, 77)_ — Wrap MemberNav in lg-only container, render MemberBottomTabs after the shell, add bottom-tab-height padding-bottom to <main> on mobile so the bar never obscures content (WCAG 2.4.11).
- `src/app/layout.tsx` — _Modify (add a viewport export after metadata ~41)_ — Export Next.js viewport with viewportFit: 'cover' so env(safe-area-inset-bottom) resolves on iPhone home-bar.
- `src/i18n/messages/en.json` — _Modify (nav.member block ~3829-3839)_ — Add tab short-label keys: nav.member.benefitsShort, nav.member.accountShort, nav.member.bottomTabsAriaLabel.
- `src/i18n/messages/th.json` — _Modify (nav.member block ~3829-3839)_ — Add the same keys with short TH labels (สิทธิ์ / บัญชี) to avoid 320px tab overflow; full label stays as aria-label.
- `src/i18n/messages/sv.json` — _Modify (nav.member block ~3829-3839)_ — Add the same keys with SV labels (Förmåner / Konto).

**G2 — Shared component move + dashboard primitives**

- `src/components/portal/invoices-summary-card.tsx` — _Create (moved from src/app/(member)/portal/invoices/_components/invoices-summary-card.tsx)_ — Shared member-portal invoice-summary card (latest 3 + view-all), reused by the Invoices page AND the new Dashboard; relative imports rewritten to absolute @/ paths.
- `src/app/(member)/portal/invoices/_components/invoices-summary-card.tsx` — _Delete (after move)_ — Old location removed; consumers re-point to the shared component.
- `src/app/(member)/portal/page.tsx` — _Modify (line 17 import; line 77 usage unchanged)_ — Update the single importer to the new shared path @/components/portal/invoices-summary-card.
- `src/components/portal/dashboard/stat-card.tsx` — _Create_ — Presentational stat card (label + big value + sub) with non-colour-only variant (neutral|warning|destructive|ok) carrying text + icon.
- `src/components/portal/dashboard/quota-bar.tsx` — _Create_ — Labelled progress bar composing @/components/ui/progress: VISIBLE text value (2/5) + role=progressbar aria-valuenow/min/max (spec a11y-5).
- `src/components/portal/dashboard/quick-action.tsx` — _Create_ — Action link/button (icon + label, primary/secondary) with a guaranteed >=44px touch target (WCAG 2.5.8).
- `src/components/portal/dashboard/activity-feed.tsx` — _Create_ — Recent-activity list (icon + text + RelativeTime) with a localised empty state.
- `src/i18n/messages/en.json` — _Modify (insert portal.dashboard block after line 3881)_ — Canonical EN keys for the dashboard primitives (quota-bar SR labels, activity-feed empty state, quick-action group label).
- `src/i18n/messages/th.json` — _Modify (insert portal.dashboard block)_ — Thai translations of the dashboard primitive labels (no dates — BE display-only handled by RelativeTime).
- `src/i18n/messages/sv.json` — _Modify (insert portal.dashboard block)_ — Swedish translations of the dashboard primitive labels.
- `tests/unit/components/portal/invoices-summary-card-move.test.tsx` — _Create_ — Locks the move: asserts the shared module path exports InvoicesSummaryCard and the old path no longer does.
- `tests/unit/components/portal/dashboard/stat-card.test.tsx` — _Create_ — Renders label/value/sub; asserts variant text + icon present (non-colour-only).
- `tests/unit/components/portal/dashboard/quota-bar.test.tsx` — _Create_ — Asserts visible 2/5 text + progressbar role with aria-valuenow/min/max.
- `tests/unit/components/portal/dashboard/quick-action.test.tsx` — _Create_ — Asserts link role + href, min-h-11 (>=44px) target, primary/secondary class.
- `tests/unit/components/portal/dashboard/activity-feed.test.tsx` — _Create_ — Asserts list renders items with relative time + the localised empty state.

**G3 — Dashboard page (`/portal` at-a-glance hub)**

- `src/app/(member)/portal/_lib/dashboard-stats.ts` — _Create_ — Pure, framework-free derivation of the 3 stat-card view models (membership/outstanding/benefits) + the renew-due threshold predicate — the testable core of the dashboard with zero async/DB.
- `tests/unit/portal/dashboard/dashboard-stats.test.ts` — _Create_ — Unit test for every branch of the pure stat derivations (variant-by-status, under-use count, outstanding sum, renew-due threshold, empty/first-run).
- `src/app/(member)/portal/_components/stat-card.tsx` — _Create_ — Reusable presentational stat-card primitive (label + big value + sub + status-variant chip) used by all 3 dashboard stats; WCAG non-colour-only chip.
- `tests/unit/portal/dashboard/stat-card.test.tsx` — _Create_ — RTL unit test: renders label/value/sub, the variant chip text label, and the optional action link.
- `src/i18n/messages/en.json` — _Modify_ — Add the `portal.dashboard.*` namespace (header chips, 3 stat cards, quick actions, panels, recent-activity, empty/first-run) — EN canonical.
- `src/i18n/messages/th.json` — _Modify_ — Add `portal.dashboard.*` Thai translations with `.short` tab-safe variants; BE date display handled by the existing date helper (display-only).
- `src/i18n/messages/sv.json` — _Modify_ — Add `portal.dashboard.*` Swedish translations.
- `src/app/(member)/portal/_components/dashboard-reads.ts` — _Create_ — Per-request React cache() wrappers + RLS-safe session-memberId resolution for the renewal / benefits / invoice reads shared by the dashboard sections (and reusable by Profile).
- `src/app/(member)/portal/_components/membership-stat-section.tsx` — _Create_ — Async server section: membership/renewal stat via loadMemberRenewalStatus (session memberId) → StatCard, with Suspense skeleton.
- `src/app/(member)/portal/_components/outstanding-stat-section.tsx` — _Create_ — Async server section: outstanding-balance stat via invoice reads → StatCard, with Suspense skeleton.
- `src/app/(member)/portal/_components/benefits-stat-section.tsx` — _Create_ — Async server section: under-use-highlight Benefits stat via computeBenefitUsage → StatCard, with Suspense skeleton.
- `src/app/(member)/portal/_components/quick-actions.tsx` — _Create_ — Transactional quick-action grid (Pay / Benefits / Renew-conditional / Edit) — 2×2 on mobile, conditional Renew via the shared threshold.
- `src/app/(member)/portal/_components/recent-activity-section.tsx` — _Create_ — Async server section: timeline preview (3–4 member-permission events via the same timelineList member filter) + view-all link + empty state.
- `src/app/(member)/portal/page.tsx` — _Modify_ — Rebuild the dashboard: PageHeader (welcome + member#/plan/status chips, versionBadge REMOVED) + 3 stat sections + quick actions + 2-col (InvoicesSummaryCard | benefits quota) + recent activity; first-run empty states.
- `tests/integration/portal/dashboard-cross-tenant.test.ts` — _Create_ — Live-Neon cross-tenant integration test: member A's session never surfaces member B's renewal/benefit/invoice data (Principle I Review-Gate blocker).

**G4 — Profile page (`/portal/profile` member-facing redesign)**

- `src/i18n/messages/en.json` — _Modify_ — Add new portal.profile.* keys (section headings, member-status badge label, organisation/membership field labels, directory section) — EN canonical.
- `src/i18n/messages/th.json` — _Modify_ — TH translations for the new portal.profile.* keys (BE display-only for dates handled by the date helper, not the strings).
- `src/i18n/messages/sv.json` — _Modify_ — SV translations for the new portal.profile.* keys.
- `src/app/(member)/portal/profile/page.tsx` — _Modify_ — Rebuild as the member-facing member-detail: PageHeader (company + SCCM-NNNN + status badge) → real-<h2> Organisation card → Membership card → Contacts card → Directory listing section → Edit-profile action. Refactor inline <dt>/<dd> to DetailField; dates via formatLocalisedDate; export PortalProfileBody for unit testing.
- `tests/unit/app/portal/profile/portal-profile-body.test.tsx` — _Create_ — Unit test the RSC body: heading order (h1→h2, no skip, no CardTitle in section titles), DetailField usage, BE-aware localised date wiring, status badge label, and a cross-tenant note asserting memberId is resolved from session (findByLinkedUserId), never a URL param.


---

# G1 — Nav shell (top-nav + bottom-tabs + avatar Account menu)

### Task 1: Restructure memberNavConfig (4 desktop items) + add memberBottomTabItems + shortTitleKey

**Files:**
- Modify `src/config/nav.ts` — extend `NavItem` (interface ~28-45), replace `memberNavConfig` (~244-312), append `memberBottomTabItems`.
- Test `tests/unit/nav/nav-config.test.ts` — rewrite the `describe('memberNavConfig')` block (~111-141), add a new `describe('memberBottomTabItems')` block.

- [ ] **Step 1: Write the failing test** — replace the existing `describe('memberNavConfig', …)` block (lines 111-141) in `tests/unit/nav/nav-config.test.ts` with the two blocks below, and add `memberBottomTabItems` + `isNavItemActive` to the import from `@/config/nav` at the top of the file:

```ts
import {
  isNavGroup,
  isNavItemActive,
  memberNavConfig,
  memberBottomTabItems,
  staffNavConfig,
  type NavGroup,
  type NavItem,
} from '@/config/nav';

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
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/nav/nav-config.test.ts`
  Expected: FAIL — `memberBottomTabItems` does not exist (TS/import error), and `memberNavConfig` still has 8 items so the length + Benefits-broadcasts assertions fail.

- [ ] **Step 3: Implement** — in `src/config/nav.ts`: (a) add `BarChart3Icon` is not needed; ensure the icon imports `LayoutDashboardIcon, BuildingIcon, ReceiptIcon, GiftIcon, UserCircleIcon` are present (they already are). (b) Add `shortTitleKey` to the `NavItem` interface immediately after the `titleKey` field:

```ts
/** A single navigation link. */
export interface NavItem {
  readonly titleKey: string;
  /**
   * Optional shorter i18n key used by the mobile bottom-tab bar where the
   * full `titleKey` label overflows a 320px tab (e.g. TH "สิทธิประโยชน์").
   * The full `titleKey` is still used as the tab's `aria-label`.
   */
  readonly shortTitleKey?: string;
  readonly icon: LucideIcon;
  readonly href: string;
  /** URL prefix for active-state matching. Use `exact:` prefix for exact match. */
  readonly activePattern: string;
  /** If set, item is visible only to these roles. Type-only for now — filtering
   *  logic deferred until a role-differentiated nav item exists. */
  readonly roles?: ReadonlyArray<Role>;
  /**
   * If set, the item is rendered ONLY when the named flag is `true` in
   * the runtime visibility-flag map passed to the sidebar. Used by
   * F6 T081 to hide `/admin/integrations/eventcreate` from sidebars
   * of tenants that haven't configured the integration AND haven't
   * received a webhook delivery in 30 days (round-2 R1).
   */
  readonly visibilityFlag?: NavVisibilityFlag;
}
```

  (c) Replace the whole `memberNavConfig` constant (lines ~244-312) with the slimmed 4-item config, and append `memberBottomTabItems` directly after it:

```ts
// ---------------------------------------------------------------------------
// Member navigation (057 redesign)
// ---------------------------------------------------------------------------

/**
 * Desktop top-nav (≥ lg). Four destinations only — Account is reached via the
 * avatar dropdown (UserMenu), not the top-nav (spec §2/§2a, review M3).
 * Broadcasts/Timeline/Renewal-prefs were de-promoted from the top-nav: their
 * ROUTES are preserved (spec §3 route-preservation) — Broadcasts lives inside
 * the Benefits tab, Timeline on the Dashboard, Renewal-prefs in the Account hub.
 */
export const memberNavConfig: NavConfig = {
  sections: [
    {
      items: [
        {
          titleKey: 'nav.member.dashboard',
          icon: LayoutDashboardIcon,
          href: '/portal',
          activePattern: 'exact:/portal',
        },
        {
          titleKey: 'nav.member.profile',
          icon: BuildingIcon,
          href: '/portal/profile',
          activePattern: '/portal/profile',
        },
        {
          titleKey: 'nav.member.invoices',
          icon: ReceiptIcon,
          href: '/portal/invoices',
          activePattern: '/portal/invoices',
        },
        // Benefits (entitlements + Broadcasts tab). The active matcher must
        // ALSO cover /portal/broadcasts/** so the compose/detail routes keep
        // the Benefits tab highlighted (spec §3/§4.4, review M-2). We express
        // this with a leading "any:" multi-prefix pattern resolved by
        // isNavItemActive below — keeps NavItem.activePattern a single string.
        {
          titleKey: 'nav.member.benefits',
          icon: GiftIcon,
          href: '/portal/benefits',
          activePattern: 'any:/portal/benefits|/portal/broadcasts',
        },
      ],
    },
  ],
};

/**
 * Mobile bottom tab bar (< lg). Five tabs = the four desktop destinations +
 * Account (which is the avatar dropdown on desktop). `shortTitleKey` supplies
 * a compact label so TH strings don't overflow a 320px tab; the full
 * `titleKey` is the tab's accessible name (spec §6/§7, review SG-5).
 */
export const memberBottomTabItems: readonly NavItem[] = [
  {
    titleKey: 'nav.member.dashboard',
    icon: LayoutDashboardIcon,
    href: '/portal',
    activePattern: 'exact:/portal',
  },
  {
    titleKey: 'nav.member.profile',
    icon: BuildingIcon,
    href: '/portal/profile',
    activePattern: '/portal/profile',
  },
  {
    titleKey: 'nav.member.invoices',
    icon: ReceiptIcon,
    href: '/portal/invoices',
    activePattern: '/portal/invoices',
  },
  {
    titleKey: 'nav.member.benefits',
    shortTitleKey: 'nav.member.benefitsShort',
    icon: GiftIcon,
    href: '/portal/benefits',
    activePattern: 'any:/portal/benefits|/portal/broadcasts',
  },
  {
    titleKey: 'nav.member.account',
    shortTitleKey: 'nav.member.accountShort',
    icon: UserCircleIcon,
    href: '/portal/account',
    activePattern: '/portal/account',
  },
];
```

  (d) Teach `isNavItemActive` to resolve the `any:` multi-prefix form. Replace the function (lines ~328-333) with:

```ts
/** Prefix used for a pipe-separated OR list of prefix patterns. */
const ANY_PREFIX = 'any:' as const;

/**
 * Determine if a nav item is active for the given pathname.
 *
 * Supports three modes:
 * - `exact:/admin` — matches only the exact pathname `/admin`
 * - `any:/portal/benefits|/portal/broadcasts` — active if the pathname
 *   matches ANY of the pipe-separated prefixes (used so the Benefits tab
 *   stays lit on /portal/broadcasts/** — review M-2)
 * - `/admin/plans` — prefix match (pathname starts with the pattern)
 */
export function isNavItemActive(pathname: string, activePattern: string): boolean {
  if (activePattern.startsWith(EXACT_PREFIX)) {
    return pathname === activePattern.slice(EXACT_PREFIX.length);
  }
  if (activePattern.startsWith(ANY_PREFIX)) {
    return activePattern
      .slice(ANY_PREFIX.length)
      .split('|')
      .some((p) => pathname === p || pathname.startsWith(`${p}/`));
  }
  return pathname === activePattern || pathname.startsWith(`${activePattern}/`);
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/nav/nav-config.test.ts`
  Expected: PASS — all `memberNavConfig` (4 items) + `memberBottomTabItems` (5 tabs) + Benefits-on-broadcasts assertions green. (The `staffNavConfig` describe blocks above are untouched and stay green.)

- [ ] **Step 5: Commit** — `git add src/config/nav.ts tests/unit/nav/nav-config.test.ts`
  `git commit -m "feat(portal): nav.ts — 4 desktop dests + memberBottomTabItems + any: matcher"`

---

### Task 2: Add bottom-tab + short-label i18n keys (EN/TH/SV)

**Files:**
- Modify `src/i18n/messages/en.json` — `nav.member` block (~3829-3839).
- Modify `src/i18n/messages/th.json` — `nav.member` block (~3829-3839).
- Modify `src/i18n/messages/sv.json` — `nav.member` block (~3829-3839).
- Test: `pnpm check:i18n` (no new test file — the i18n coverage gate is the test).

- [ ] **Step 1: Write the failing test** — there is no `.test.ts` for raw message keys; the failing check is `pnpm check:i18n`, which fails the build on a missing EN key. First reference the new keys in code is Task 4/5; to make this task self-validating, assert the keys exist via a tiny test. Create `tests/unit/nav/member-tab-i18n.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

const NEW_KEYS = ['benefitsShort', 'accountShort', 'bottomTabsAriaLabel'] as const;

describe('nav.member bottom-tab i18n keys (057)', () => {
  it.each(['en', 'th', 'sv'] as const)('%s has all new nav.member tab keys', (loc) => {
    const messages = ({ en, th, sv } as const)[loc];
    const member = (messages as { nav: { member: Record<string, string> } }).nav.member;
    for (const key of NEW_KEYS) {
      expect(member[key], `${loc} nav.member.${key}`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/nav/member-tab-i18n.test.ts`
  Expected: FAIL — `nav.member.benefitsShort` / `accountShort` / `bottomTabsAriaLabel` are `undefined` in all three locales.

- [ ] **Step 3: Implement** — add the three keys to each `nav.member` block.

  In `src/i18n/messages/en.json`, replace the `nav.member` object (lines ~3829-3839) with:

```json
    "member": {
      "dashboard": "Dashboard",
      "profile": "Profile",
      "invoices": "Invoices",
      "broadcasts": "E-Blasts",
      "timeline": "Timeline",
      "account": "Account",
      "ariaLabel": "Member navigation",
      "benefits": "Benefits",
      "renewalPrefs": "Renewal reminders",
      "benefitsShort": "Benefits",
      "accountShort": "Account",
      "bottomTabsAriaLabel": "Member tab bar"
    }
```

  In `src/i18n/messages/th.json`, replace the `nav.member` object (lines ~3829-3839) with (note: short labels are deliberately compact to fit a 320px tab — the full `benefits`/`account` labels remain the `aria-label`):

```json
    "member": {
      "dashboard": "แดชบอร์ด",
      "profile": "โปรไฟล์",
      "invoices": "ใบแจ้งหนี้",
      "broadcasts": "E-Blast",
      "timeline": "ไทม์ไลน์",
      "account": "บัญชีของฉัน",
      "ariaLabel": "เมนูนำทางสำหรับสมาชิก",
      "benefits": "สิทธิประโยชน์",
      "renewalPrefs": "การแจ้งเตือนต่ออายุ",
      "benefitsShort": "สิทธิ์",
      "accountShort": "บัญชี",
      "bottomTabsAriaLabel": "แถบแท็บสมาชิก"
    }
```

  In `src/i18n/messages/sv.json`, replace the `nav.member` object (lines ~3829-3839) with:

```json
    "member": {
      "dashboard": "Instrumentpanel",
      "profile": "Profil",
      "invoices": "Fakturor",
      "broadcasts": "Utskick",
      "timeline": "Tidslinje",
      "account": "Mitt konto",
      "ariaLabel": "Medlemsnavigering",
      "benefits": "Förmåner",
      "renewalPrefs": "Förnyelsepåminnelser",
      "benefitsShort": "Förmåner",
      "accountShort": "Konto",
      "bottomTabsAriaLabel": "Medlemsflikar"
    }
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/nav/member-tab-i18n.test.ts && pnpm check:i18n`
  Expected: vitest PASS (all three locales have the keys); `pnpm check:i18n` reports 0 missing EN keys.

- [ ] **Step 5: Commit** — `git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/unit/nav/member-tab-i18n.test.ts`
  `git commit -m "feat(portal): add nav.member tab short-label + bottom-tab aria i18n keys"`

---

### Task 3: MemberNav → desktop top-nav (4 visible labels, aria-current, lg-only)

**Files:**
- Modify `src/components/layout/member-nav.tsx` — full rewrite (~1-55).
- Test `tests/unit/components/layout/member-nav.test.tsx` — Create.

- [ ] **Step 1: Write the failing test** — Create `tests/unit/components/layout/member-nav.test.tsx`:

```tsx
/**
 * 057 — <MemberNav> desktop top-nav. Pins: 4 visible-text links,
 * aria-current="page" on the active route (incl. Benefits staying active
 * on /portal/broadcasts/**), and the desktop-only (hidden < lg) wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberNav } from '@/components/layout/member-nav';

const mockPathname = vi.fn<() => string>(() => '/portal');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

function renderNav() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberNav />
    </NextIntlClientProvider>,
  );
}

describe('<MemberNav> (057 desktop top-nav)', () => {
  it('renders exactly 4 links with VISIBLE text labels', () => {
    mockPathname.mockReturnValue('/portal');
    renderNav();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benefits' })).toBeInTheDocument();
  });

  it('sets aria-current="page" on the active route only', () => {
    mockPathname.mockReturnValue('/portal/profile');
    renderNav();
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Benefits active on /portal/broadcasts/** (review M-2)', () => {
    mockPathname.mockReturnValue('/portal/broadcasts/new');
    renderNav();
    expect(screen.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });

  it('is desktop-only — the nav element carries the lg-visible / hidden classes', () => {
    mockPathname.mockReturnValue('/portal');
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Member navigation' });
    expect(nav.className).toContain('hidden');
    expect(nav.className).toContain('lg:flex');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/components/layout/member-nav.test.tsx`
  Expected: FAIL — current `MemberNav` renders 8 links with `sr-only` labels (no visible text), no `aria-current`, and no `hidden lg:flex` wrapper.

- [ ] **Step 3: Implement** — replace the entire contents of `src/components/layout/member-nav.tsx` with:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavGroup, isNavItemActive, memberNavConfig, type NavItem } from '@/config/nav';
import { cn } from '@/lib/utils';

/**
 * MemberNav — desktop top-nav (057 redesign).
 *
 * Four destinations (Dashboard / Profile / Invoices / Benefits) with VISIBLE
 * text labels (no sr-only — review a11y-3). Active item gets `aria-current="page"`
 * for AT + a visual `bg-accent` highlight. Desktop-only: hidden below `lg`,
 * where the mobile bottom-tab bar (`MemberBottomTabs`) takes over.
 */
export function MemberNav() {
  const pathname = usePathname();
  const t = useTranslations();

  const items = memberNavConfig.sections
    .flatMap((section) => section.items)
    .filter((item): item is NavItem => !isNavGroup(item));

  return (
    <nav
      aria-label={t('nav.member.ariaLabel')}
      className="hidden items-center gap-1 lg:flex"
    >
      {items.map((item) => {
        const active = isNavItemActive(pathname, item.activePattern);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{t(item.titleKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/components/layout/member-nav.test.tsx`
  Expected: PASS — 4 visible links, `aria-current="page"` on the active route incl. broadcasts→Benefits, `hidden lg:flex` present.

- [ ] **Step 5: Commit** — `git add src/components/layout/member-nav.tsx tests/unit/components/layout/member-nav.test.tsx`
  `git commit -m "feat(portal): MemberNav desktop top-nav — 4 labels, aria-current, lg-only"`

---

### Task 4: Create MemberBottomTabs (mobile bottom tab bar)

**Files:**
- Create `src/components/layout/member-bottom-tabs.tsx`.
- Test `tests/unit/components/layout/member-bottom-tabs.test.tsx` — Create.

- [ ] **Step 1: Write the failing test** — Create `tests/unit/components/layout/member-bottom-tabs.test.tsx`:

```tsx
/**
 * 057 — <MemberBottomTabs> mobile tab bar. Pins: 5 tabs, visible short labels,
 * aria-current="page" on active, ≥44px touch targets, unique nav aria-label,
 * and the mobile-only (lg:hidden) wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';

const mockPathname = vi.fn<() => string>(() => '/portal');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

function renderTabs() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberBottomTabs />
    </NextIntlClientProvider>,
  );
}

describe('<MemberBottomTabs> (057 mobile tab bar)', () => {
  it('renders 5 tab links inside a uniquely-labelled nav', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    const nav = screen.getByRole('navigation', { name: 'Member tab bar' });
    expect(nav).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('every tab exposes the full label as its accessible name', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benefits' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument();
  });

  it('shows the compact short label text for overflow-prone tabs', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    // Account tab's visible text uses the short label "Account" (en short == full),
    // and Benefits uses "Benefits"; assert the visible <span> text exists.
    const benefits = screen.getByRole('link', { name: 'Benefits' });
    expect(benefits.textContent).toContain('Benefits');
  });

  it('sets aria-current="page" on the active tab', () => {
    mockPathname.mockReturnValue('/portal/account');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Benefits active on /portal/broadcasts/** (review M-2)', () => {
    mockPathname.mockReturnValue('/portal/broadcasts/abc');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });

  it('each tab is a ≥44px touch target (WCAG 2.5.8)', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('min-h-[44px]');
    }
  });

  it('is mobile-only — the nav carries lg:hidden + safe-area padding', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    const nav = screen.getByRole('navigation', { name: 'Member tab bar' });
    expect(nav.className).toContain('lg:hidden');
    expect(nav.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/components/layout/member-bottom-tabs.test.tsx`
  Expected: FAIL — module `@/components/layout/member-bottom-tabs` does not exist.

- [ ] **Step 3: Implement** — Create `src/components/layout/member-bottom-tabs.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavItemActive, memberBottomTabItems } from '@/config/nav';
import { cn } from '@/lib/utils';

/**
 * MemberBottomTabs — mobile bottom tab bar (057 redesign, spec §2/§7).
 *
 * Five tabs (Dashboard / Profile / Invoices / Benefits / Account) fixed to the
 * bottom of the viewport on viewports below `lg`; hidden at `lg` and up where
 * the desktop top-nav (`MemberNav`) + avatar Account menu take over.
 *
 * a11y (spec §7):
 *  - unique `<nav aria-label>` landmark
 *  - icon + VISIBLE short text label per tab (not sr-only — review a11y-3);
 *    the FULL label is the link's `aria-label` so AT never gets a truncated name
 *  - `aria-current="page"` on the active tab
 *  - touch targets ≥44px (`min-h/min-w-[44px]` — WCAG 2.5.8)
 *  - `env(safe-area-inset-bottom)` padding for the iPhone home-bar (review a11y-1);
 *    pairs with `viewport-fit=cover` set in the root layout's viewport export
 */
export function MemberBottomTabs() {
  const pathname = usePathname();
  const t = useTranslations();

  return (
    <nav
      aria-label={t('nav.member.bottomTabsAriaLabel')}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background lg:hidden',
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="grid grid-cols-5">
        {memberBottomTabItems.map((item) => {
          const active = isNavItemActive(pathname, item.activePattern);
          const fullLabel = t(item.titleKey);
          const shortLabel = item.shortTitleKey ? t(item.shortTitleKey) : fullLabel;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-label={fullLabel}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  active ? 'text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                <item.icon className="size-5 shrink-0" aria-hidden />
                <span className="max-w-full truncate">{shortLabel}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/components/layout/member-bottom-tabs.test.tsx`
  Expected: PASS — 5 tabs, full label as accessible name, `aria-current="page"` on active incl. broadcasts→Benefits, `min-h-[44px]`, `lg:hidden` + safe-area padding.

- [ ] **Step 5: Commit** — `git add src/components/layout/member-bottom-tabs.tsx tests/unit/components/layout/member-bottom-tabs.test.tsx`
  `git commit -m "feat(portal): MemberBottomTabs — 5-tab mobile bar, 44px targets, safe-area"`

---

### Task 5: Extend UserMenu — desktop avatar Account hub (anchors + theme + sign-out)

**Files:**
- Modify `src/components/shell/user-menu.tsx` — member branch of the dropdown (~95-109) + theme import.
- Test `tests/unit/components/shell/user-menu.test.tsx` — Create.

- [ ] **Step 1: Write the failing test** — Create `tests/unit/components/shell/user-menu.test.tsx`:

```tsx
/**
 * 057 — <UserMenu> desktop avatar Account hub (member role). Pins the dropdown
 * exposes the Account-hub section anchors (/portal/account, #renewal-prefs,
 * #data-privacy), theme controls, and sign-out — all inside a role=menu popup.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { UserMenu } from '@/components/shell/user-menu';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

function renderMenu() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UserMenu displayName="Jane Member" email="jane@example.com" role="member" />
    </NextIntlClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
}

describe('<UserMenu> member Account hub (057)', () => {
  it('exposes the Account hub + section-anchor links', async () => {
    renderMenu();
    openMenu();
    const account = await screen.findByRole('menuitem', { name: /account settings/i });
    expect(account).toHaveAttribute('href', '/portal/account');
    expect(
      screen.getByRole('menuitem', { name: /renewal/i }),
    ).toHaveAttribute('href', '/portal/account#renewal-prefs');
    expect(
      screen.getByRole('menuitem', { name: /data & privacy/i }),
    ).toHaveAttribute('href', '/portal/account#data-privacy');
  });

  it('renders theme controls and a sign-out item', async () => {
    renderMenu();
    openMenu();
    expect(await screen.findByRole('menuitem', { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/components/shell/user-menu.test.tsx`
  Expected: FAIL — the current member dropdown has only a single "Account settings" item (via `router.push`, rendered without an `href`), no section anchors, and no theme controls; `findByRole('menuitem', { name: /renewal/i })` rejects.

- [ ] **Step 3: Implement** — in `src/components/shell/user-menu.tsx`: add imports for `Link`, `useTheme`, and the theme icons, and add the new i18n namespaces; then replace the two member-relevant `DropdownMenuGroup` blocks (the Account group ~95-102 and keep the sign-out group ~104-109) so members get the full hub. Concretely:

  (a) Add/extend imports near the top (after the existing lucide import on line 11):

```tsx
import {
  LogOutIcon,
  UserIcon,
  CalendarClockIcon,
  ShieldIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
```

  (b) Inside the component, after `const tBadge = useTranslations('shell.roleBadge');` (line 55), add:

```tsx
  const tTheme = useTranslations('shell.theme');
  const tHub = useTranslations('portal.account.menu');
  const { setTheme } = useTheme();
  const isMember = role === 'member';
```

  (c) Replace the Account `DropdownMenuGroup` (lines ~95-102) with a member-aware block. For members it renders the hub anchors + theme; for staff it keeps the original single account item:

```tsx
        <DropdownMenuSeparator />
        {isMember ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href="/portal/account" />}>
                <UserIcon className="size-4" aria-hidden />
                {t('account')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/portal/account#renewal-prefs" />}>
                <CalendarClockIcon className="size-4" aria-hidden />
                {tHub('renewalPrefs')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/portal/account#data-privacy" />}>
                <ShieldIcon className="size-4" aria-hidden />
                {tHub('dataPrivacy')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('light')}>
                <SunIcon className="size-4" aria-hidden />
                {tTheme('light')}
              </DropdownMenuItem>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('dark')}>
                <MoonIcon className="size-4" aria-hidden />
                {tTheme('dark')}
              </DropdownMenuItem>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('system')}>
                <MonitorIcon className="size-4" aria-hidden />
                {tTheme('system')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => router.push('/admin/account')}>
              <UserIcon className="size-4" aria-hidden />
              {t('account')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
```

  (Leave the existing sign-out `DropdownMenuGroup` at lines ~104-109 unchanged — it already covers both roles.)

  (d) Add the `portal.account.menu` i18n block to all three locales. In `src/i18n/messages/en.json`, immediately under the existing `"shell"."userMenu"` is NOT correct — these live under a new `portal.account.menu` namespace. Add to `en.json` inside the top-level `"portal"` object (search for `"portal": {`; if `portal.account` exists, add a `menu` child, else add `account.menu`):

```json
        "menu": {
          "renewalPrefs": "Renewal reminders",
          "dataPrivacy": "Data & privacy"
        }
```

  Add the TH equivalent to `th.json` (`renewalPrefs`: "การแจ้งเตือนต่ออายุ", `dataPrivacy`: "ข้อมูลและความเป็นส่วนตัว") and the SV equivalent to `sv.json` (`renewalPrefs`: "Förnyelsepåminnelser", `dataPrivacy`: "Data och integritet") at the matching `portal.account.menu` path.

  Note: `DropdownMenuItem render={<Link … />}` is the Base-UI render-prop pattern already used by this repo's `DropdownMenuTrigger render={<Button … />}` (see `user-menu.tsx` line 74 + `theme-toggle.tsx` line 27) — it makes the menuitem an `<a href>` so back-button / deep-link / share-link work (spec §4.5 review S-4). `closeOnClick={false}` keeps the menu open while toggling theme.

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/components/shell/user-menu.test.tsx && pnpm check:i18n`
  Expected: vitest PASS — Account hub anchors carry the right `href`s, theme + sign-out menuitems present; `check:i18n` reports 0 missing keys.

- [ ] **Step 5: Commit** — `git add src/components/shell/user-menu.tsx src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/unit/components/shell/user-menu.test.tsx`
  `git commit -m "feat(portal): UserMenu member Account hub — anchors + theme + sign-out"`

---

### Task 6: Wire the nav shell into the portal layout + set viewport-fit=cover

**Files:**
- Modify `src/app/(member)/portal/layout.tsx` — render `MemberBottomTabs`, gate `MemberNav` to desktop (already `hidden lg:flex` in the component), add `<main>` bottom padding (~58, 77, import ~6).
- Modify `src/app/layout.tsx` — add a `viewport` export (after `metadata`, ~41).
- Test `tests/unit/app/portal-layout-shell.test.tsx` — Create (asserts on the rendered tree of the layout's static markup pieces; the layout itself is an async server component, so we test the imported pieces' presence via a lightweight structural assertion on a thin wrapper).

- [ ] **Step 1: Write the failing test** — the portal `layout.tsx` is an async RSC that calls `requireSession`, which can't run in jsdom. So this task's failing test targets the **viewport export** (pure, importable) plus a structural guard that `MemberBottomTabs` is imported by the portal layout source. Create `tests/unit/app/portal-layout-shell.test.tsx`:

```tsx
/**
 * 057 — portal shell wiring. The portal layout is an async server component
 * (calls requireSession), so we don't render it in jsdom. Instead we pin the
 * two pure, statically-checkable contracts:
 *   1. the root layout exports a `viewport` with viewportFit: 'cover' so
 *      env(safe-area-inset-bottom) resolves on the iPhone home-bar (review a11y-1);
 *   2. the portal layout source imports + renders MemberBottomTabs and pads
 *      <main> so the fixed bar never obscures content (WCAG 2.4.11 / review a11y-2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewport } from '@/app/layout';

const portalLayoutSrc = readFileSync(
  resolve(__dirname, '../../../src/app/(member)/portal/layout.tsx'),
  'utf8',
);

describe('root layout viewport (057)', () => {
  it('sets viewportFit to cover', () => {
    expect(viewport.viewportFit).toBe('cover');
  });
});

describe('portal layout shell wiring (057)', () => {
  it('imports and renders MemberBottomTabs', () => {
    expect(portalLayoutSrc).toContain('member-bottom-tabs');
    expect(portalLayoutSrc).toContain('<MemberBottomTabs');
  });

  it('pads <main> bottom on mobile so the fixed tab bar never obscures content', () => {
    // Mobile-only bottom padding (>= bottom-tab height) cleared at lg where
    // the bar is hidden.
    expect(portalLayoutSrc).toMatch(/pb-\[calc\(var\(--bottom-tab-height\)/);
    expect(portalLayoutSrc).toContain('lg:pb-0');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/app/portal-layout-shell.test.tsx`
  Expected: FAIL — `viewport` is not exported from `@/app/layout` (import undefined → `.viewportFit` throws), and the portal layout source contains neither `MemberBottomTabs` nor the `pb-[calc(var(--bottom-tab-height)…` padding.

- [ ] **Step 3: Implement** — two edits.

  (a) In `src/app/layout.tsx`, add a `Viewport` import + a `viewport` export directly after the `metadata` export (after line 41):

```tsx
import type { Metadata, Viewport } from 'next';
```

```tsx
export const viewport: Viewport = {
  // `cover` lets content extend under the iPhone home-bar so the member
  // bottom-tab bar's `env(safe-area-inset-bottom)` padding has room to push
  // the tabs above the home indicator (057 review a11y-1).
  viewportFit: 'cover',
};
```

  (b) In `src/app/(member)/portal/layout.tsx`: import `MemberBottomTabs`, give `<main>` mobile bottom padding, and render the bar before the idle dialog.

  Add the import after the existing `MemberNav` import (line 6):

```tsx
import { MemberNav } from '@/components/layout/member-nav';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
```

  Change the `<main>` opening tag (line 77) from:

```tsx
      <main className="flex-1" id="main-content">
```

  to (the `--bottom-tab-height` token plus the safe-area inset reserves space so the fixed bar never overlaps the last row — Sign-out / Pay — on mobile; cleared at `lg` where the bar is hidden):

```tsx
      <main
        className="flex-1 pb-[calc(var(--bottom-tab-height)+env(safe-area-inset-bottom))] lg:pb-0"
        id="main-content"
      >
```

  Render the bar just before the `IdleWarningDialog` (after line 83's `</main>`):

```tsx
      </main>
      {/* 057 — mobile bottom tab bar (hidden ≥ lg). Fixed; <main> reserves
          equivalent padding-bottom above so it never obscures content. */}
      <MemberBottomTabs />
      {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
      <IdleWarningDialog portal="member" />
```

  (c) Define the `--bottom-tab-height` CSS token. In `src/app/globals.css`, add it next to the existing layout tokens (search for `--top-bar-height`; add in the same `:root`/`@theme` block):

```css
  --bottom-tab-height: 3.5rem; /* 56px — member mobile tab-bar height (057) */
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/app/portal-layout-shell.test.tsx`
  Expected: PASS — `viewport.viewportFit === 'cover'`; portal layout source imports/renders `MemberBottomTabs` and pads `<main>` with the `--bottom-tab-height` calc + `lg:pb-0`.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/layout.tsx" src/app/layout.tsx src/app/globals.css tests/unit/app/portal-layout-shell.test.tsx`
  `git commit -m "feat(portal): wire bottom-tabs into shell + viewport-fit=cover + main padding"`

---

### Task 7: Repoint the legacy member-nav E2E to the redesigned shell

**Files:**
- Modify `tests/e2e/member-nav.spec.ts` — full rewrite (~1-70).

- [ ] **Step 1: Write the failing test** — replace the entire contents of `tests/e2e/member-nav.spec.ts`. The old spec asserts an `Account` link inside the top-nav `<nav>`; after 057 the desktop top-nav has only 4 destinations (no Account) and a mobile tab bar adds the 5th. The rewrite covers both viewports:

```ts
/**
 * 057 — E2E: member portal nav shell (desktop top-nav + mobile bottom tabs).
 * Replaces the pre-057 8-item top-nav spec.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('member nav shell — 057', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
    }, { timeout: 10_000 });
  }

  test('desktop top-nav shows the 4 destinations with visible labels', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await page.goto('/portal');
    const nav = page.getByRole('navigation', { name: /member navigation/i });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Benefits' })).toBeVisible();
  });

  test('desktop active state sets aria-current on /portal/profile', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await page.goto('/portal/profile');
    const nav = page.getByRole('navigation', { name: /member navigation/i });
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  });

  test('mobile bottom tabs render 5 tabs incl. Account', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/portal');
    const tabs = page.getByRole('navigation', { name: /member tab bar/i });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Account' })).toBeVisible();
    await expect(tabs.getByRole('link')).toHaveCount(5);
  });

  test('mobile Benefits tab stays active on /portal/broadcasts/**', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/portal/broadcasts/new');
    const tabs = page.getByRole('navigation', { name: /member tab bar/i });
    await expect(tabs.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm test:e2e --grep "member nav shell" --workers=1`
  Expected: FAIL before the layout/component tasks land (no `member tab bar` nav, top-nav still has 8 items). With Tasks 1-6 merged it passes; if E2E creds are unset the suite reports SKIPPED (not a pass — re-run once creds + `/portal/broadcasts/new` route resolve). Note: `--workers=1` is mandatory on this machine.

- [ ] **Step 3: Implement** — no app code in this task; it is the regression-net rewrite that pins Tasks 1-6. (The old assertions for an Account link inside the top-nav are intentionally removed — Account moved to the avatar dropdown on desktop and the 5th bottom tab on mobile.)

- [ ] **Step 4: Run test (expect PASS)** — `pnpm test:e2e --grep "member nav shell" --workers=1`
  Expected: PASS on a build with Tasks 1-6 — desktop 4-item nav + aria-current, mobile 5-tab bar + Benefits-on-broadcasts. (Run on a preview deploy for the authoritative result per the E2E-gates-preview-only note.)

- [ ] **Step 5: Commit** — `git add tests/e2e/member-nav.spec.ts`
  `git commit -m "test(portal): rewrite member-nav E2E for 057 top-nav + bottom-tab shell"`

---

# G2 — Shared component move + dashboard primitives

### Task 20: Move InvoicesSummaryCard to the shared portal location

**Files:**
- Create `src/components/portal/invoices-summary-card.tsx`
- Delete `src/app/(member)/portal/invoices/_components/invoices-summary-card.tsx`
- Modify `src/app/(member)/portal/page.tsx` (line 17 import)
- Test `tests/unit/components/portal/invoices-summary-card-move.test.tsx`

The card currently lives under the invoices route group and imports its helpers with **relative** paths (`'../_utils/format'`, `'./portal-pdf-download-button'`). After moving to `src/components/portal/` those two imports MUST become absolute. The only importer is `src/app/(member)/portal/page.tsx:17`. No other file references it (verified by grep).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/invoices-summary-card-move.test.tsx
import { describe, it, expect } from 'vitest';

/**
 * G2 — locks the relocation of InvoicesSummaryCard to the shared
 * `src/components/portal/` path. The Dashboard (Task 25+) and the
 * Invoices page both import it from there. The old route-local path
 * must no longer export it (single source of truth).
 */
describe('InvoicesSummaryCard relocation', () => {
  it('is exported from the shared @/components/portal path', async () => {
    const mod = await import('@/components/portal/invoices-summary-card');
    expect(typeof mod.InvoicesSummaryCard).toBe('function');
  });

  it('is no longer exported from the old route-local _components path', async () => {
    await expect(
      import(
        '@/app/(member)/portal/invoices/_components/invoices-summary-card'
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/invoices-summary-card-move.test.tsx
```

Expected: FAIL — first case errors because `@/components/portal/invoices-summary-card` does not exist yet (module-not-found); second case currently *resolves* (old path still present) so the `rejects.toThrow` assertion fails.

- [ ] **Step 3: Implement** — create the file at the new path with absolute imports, then delete the old one.

```tsx
// src/components/portal/invoices-summary-card.tsx
/**
 * Member-portal invoice summary card (relocated from
 * `app/(member)/portal/invoices/_components/` to the shared
 * `src/components/portal/` namespace — review S1 architect).
 *
 * Renders the **latest 3 invoices** for the signed-in member plus a
 * "view all" link to `/portal/invoices`. Reused by BOTH the Invoices
 * page and the redesigned Dashboard (`/portal`), which is why it now
 * lives under `src/components/portal/` rather than a route-local
 * `_components/` folder.
 *
 * Architecture notes (unchanged from the original):
 * - Server Component: calls `listInvoicesPaged` directly with a
 *   `memberId` filter resolved from the session via
 *   `findByLinkedUserId` (RLS-safe, never URL-derived).
 *   `includeDrafts: false` — members never see drafts.
 * - Handles the three member-linking states (linked + has invoices,
 *   linked + empty, not linked) so the card renders gracefully in all
 *   cases — no 5xx regression path.
 * - On a backend read failure it logs + renders a distinct error
 *   variant (NOT the "no invoices" empty copy) so operators see the
 *   diagnostic (R7-M4).
 */
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import type { UserAccount } from '@/modules/auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from '@/app/(member)/portal/invoices/_utils/format';
import { PortalInvoiceDownloadButton } from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';

const SUMMARY_LIMIT = 3;

const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

export interface InvoicesSummaryCardProps {
  /** The authenticated member-role user from `requireSession('member')`. */
  readonly user: Pick<UserAccount, 'id'>;
}

export async function InvoicesSummaryCard({ user }: InvoicesSummaryCardProps) {
  const t = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const userLocale = await getLocale();

  const tenantCtx = resolveTenantFromRequest();
  const memberDeps = buildMembersDeps(tenantCtx);

  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(
    tenantCtx,
    user.id,
  );

  if (!memberResult.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('summary.heading')}</CardTitle>
          <CardDescription>{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-caption text-muted-foreground">
            {t('notLinked')}
          </p>
          <a
            href="mailto:info@swecham.se"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'min-h-11 px-3 self-start',
            )}
          >
            {t('summary.contactAdmin')}
          </a>
        </CardContent>
      </Card>
    );
  }

  const member = memberResult.value;

  const invoicesResult = await listInvoicesPaged(
    makeListInvoicesDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      offset: 0,
      pageSize: SUMMARY_LIMIT,
      includeDrafts: false,
      memberId: member.memberId,
    },
  );

  if (!invoicesResult.ok) {
    logger.warn(
      {
        tenantId: tenantCtx.slug,
        memberId: member.memberId,
        err: invoicesResult.error,
      },
      '[portal-invoices-summary] listInvoicesPaged failed — rendering error variant',
    );
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('summary.heading')}</CardTitle>
          <CardDescription>{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-muted-foreground">{t('loadFailed')}</p>
        </CardContent>
      </Card>
    );
  }
  const rows = invoicesResult.value.rows;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t('summary.heading')}</CardTitle>
          <CardDescription>{t('summary.description')}</CardDescription>
        </div>
        {rows.length > 0 ? (
          <Link
            href="/portal/invoices"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'min-h-11 px-3',
            )}
          >
            {t('summary.viewAll')}
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li
                key={r.invoiceId}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-col gap-1">
                  <Link
                    href={`/portal/invoices/${r.invoiceId}`}
                    className="font-mono text-caption text-muted-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 self-start"
                    aria-label={`${t('actions.viewDetail')} ${r.documentNumber?.raw ?? r.invoiceId}`}
                  >
                    {r.documentNumber?.raw ?? '—'}
                  </Link>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const Icon = STATUS_ICON_MAP[statusIconName(r.status)];
                      return (
                        <Badge
                          variant={statusBadgeVariant(r.status)}
                          className="inline-flex items-center gap-1"
                        >
                          <Icon className="size-3.5" aria-hidden="true" />
                          {tStatus(r.status)}
                        </Badge>
                      );
                    })()}
                    <span className="text-caption text-muted-foreground">
                      {formatDate(r.issueDate, userLocale)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums text-body font-medium">
                    {formatSatangThb(r.total?.satang ?? null, userLocale)}
                  </span>
                  {r.pdf ? (
                    <PortalInvoiceDownloadButton
                      invoiceId={r.invoiceId}
                      documentNumber={r.documentNumber?.raw ?? r.invoiceId}
                      label={t('actions.download')}
                      ariaLabel={t('actions.downloadInvoiceAria', {
                        number: r.documentNumber?.raw ?? r.invoiceId,
                      })}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                        'min-h-11 px-3',
                      )}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

Then delete the old file and re-point the importer:

```bash
git rm "src/app/(member)/portal/invoices/_components/invoices-summary-card.tsx"
```

Edit `src/app/(member)/portal/page.tsx` line 17 — replace:
```tsx
import { InvoicesSummaryCard } from './invoices/_components/invoices-summary-card';
```
with:
```tsx
import { InvoicesSummaryCard } from '@/components/portal/invoices-summary-card';
```
(line 77 usage `<InvoicesSummaryCard user={user} />` is unchanged.)

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/invoices-summary-card-move.test.tsx
```

Expected: PASS — shared path exports the function; old path now rejects (module-not-found). Also run `pnpm typecheck` to confirm no dangling importer remains.

- [ ] **Step 5: Commit**

```bash
git add "src/components/portal/invoices-summary-card.tsx" "src/app/(member)/portal/page.tsx" "tests/unit/components/portal/invoices-summary-card-move.test.tsx"
git rm "src/app/(member)/portal/invoices/_components/invoices-summary-card.tsx"
git commit -m "refactor(portal): move InvoicesSummaryCard to shared src/components/portal"
```

---

### Task 21: Add portal.dashboard i18n keys (EN/TH/SV)

**Files:**
- Modify `src/i18n/messages/en.json` (insert a `"dashboard": { … }` block inside the top-level `"portal"` object, which opens at line 3881)
- Modify `src/i18n/messages/th.json` (same block, Thai)
- Modify `src/i18n/messages/sv.json` (same block, Swedish)
- Test `tests/unit/components/portal/dashboard/i18n-keys.test.tsx`

These keys back the G2 primitives (quota-bar SR labels, activity-feed empty state, quick-action group label). EN is canonical (missing EN fails the build); TH/SV must match the same key set (`pnpm check:i18n`). No date strings here — BE display is handled by `RelativeTime`, so these are static labels only.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/dashboard/i18n-keys.test.tsx
import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

/**
 * Locks the portal.dashboard i18n surface for the G2 primitives across
 * all three locales. Missing keys would surface as raw key paths in the
 * UI (EN) or fail `pnpm check:i18n` on release branches (TH/SV).
 */
const REQUIRED = [
  'quotaBar.readout',
  'quotaBar.ariaLabel',
  'activity.title',
  'activity.empty.title',
  'activity.empty.body',
  'activity.viewAll',
  'quickActions.title',
] as const;

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      obj,
    );
}

describe('portal.dashboard i18n keys', () => {
  for (const [name, msgs] of [
    ['en', en],
    ['th', th],
    ['sv', sv],
  ] as const) {
    for (const key of REQUIRED) {
      it(`${name}: portal.dashboard.${key} is a non-empty string`, () => {
        const v = get(
          (msgs as Record<string, unknown>).portal,
          `dashboard.${key}`,
        );
        expect(typeof v).toBe('string');
        expect((v as string).length).toBeGreaterThan(0);
      });
    }
  }
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/i18n-keys.test.tsx
```

Expected: FAIL — `portal.dashboard` does not exist in any of the three message files (verified: `en.portal.dashboard` is `NONE`), so every assertion reports `typeof undefined !== 'string'`.

- [ ] **Step 3: Implement** — insert the `"dashboard"` block as the first key inside `"portal"`. In `src/i18n/messages/en.json`, the `"portal"` object opens at line 3881 (`  "portal": {`) immediately followed by `"account": {` on line 3882. Add the block between them.

`src/i18n/messages/en.json` — change:
```json
  "portal": {
    "account": {
```
to:
```json
  "portal": {
    "dashboard": {
      "quotaBar": {
        "readout": "{used} of {max}",
        "ariaLabel": "{label}: {used} of {max} used"
      },
      "activity": {
        "title": "Recent activity",
        "empty": {
          "title": "No activity yet",
          "body": "Your invoices, benefit usage and broadcasts will appear here as you use the portal."
        },
        "viewAll": "View all activity"
      },
      "quickActions": {
        "title": "Quick actions"
      }
    },
    "account": {
```

`src/i18n/messages/th.json` — insert the same-shaped block as the first key inside its `"portal"` object:
```json
    "dashboard": {
      "quotaBar": {
        "readout": "{used} จาก {max}",
        "ariaLabel": "{label}: ใช้ไป {used} จาก {max}"
      },
      "activity": {
        "title": "กิจกรรมล่าสุด",
        "empty": {
          "title": "ยังไม่มีกิจกรรม",
          "body": "ใบแจ้งหนี้ การใช้สิทธิประโยชน์ และอีเมลกระจายข่าวของคุณจะปรากฏที่นี่เมื่อคุณใช้งานพอร์ทัล"
        },
        "viewAll": "ดูกิจกรรมทั้งหมด"
      },
      "quickActions": {
        "title": "การดำเนินการด่วน"
      }
    },
```

`src/i18n/messages/sv.json` — insert the same-shaped block as the first key inside its `"portal"` object:
```json
    "dashboard": {
      "quotaBar": {
        "readout": "{used} av {max}",
        "ariaLabel": "{label}: {used} av {max} använt"
      },
      "activity": {
        "title": "Senaste aktivitet",
        "empty": {
          "title": "Ingen aktivitet ännu",
          "body": "Dina fakturor, förmånsanvändning och utskick visas här när du använder portalen."
        },
        "viewAll": "Visa all aktivitet"
      },
      "quickActions": {
        "title": "Snabbåtgärder"
      }
    },
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/i18n-keys.test.tsx
```

Expected: PASS — all 21 assertions (7 keys × 3 locales) green. Then run `pnpm check:i18n` and expect 0 missing EN keys + no TH/SV gaps for the new block.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/unit/components/portal/dashboard/i18n-keys.test.tsx
git commit -m "feat(portal): add portal.dashboard i18n keys (en/th/sv) for G2 primitives"
```

---

### Task 22: StatCard dashboard primitive

**Files:**
- Create `src/components/portal/dashboard/stat-card.tsx`
- Test `tests/unit/components/portal/dashboard/stat-card.test.tsx`

A presentational stat card: `label` + big `value` + optional `sub`, plus an optional `variant` (`neutral | warning | destructive | ok`). The variant MUST be conveyed by **text + icon**, never colour alone (WCAG 1.4.1 — spec §5). Server-safe (no `'use client'`, no hooks). Section title uses a real `<h2>` per spec a11y-6 (sections are real headings, not `CardTitle` divs).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/dashboard/stat-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from '@/components/portal/dashboard/stat-card';

describe('<StatCard>', () => {
  it('renders the label as a real h2, the value, and the sub', () => {
    render(
      <StatCard label="Outstanding balance" value="฿1,200" sub="2 invoices" />,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Outstanding balance');
    expect(screen.getByText('฿1,200')).toBeDefined();
    expect(screen.getByText('2 invoices')).toBeDefined();
  });

  it('omits the sub element when no sub is provided', () => {
    const { container } = render(<StatCard label="Members" value="131" />);
    expect(
      container.querySelector('[data-slot="stat-card-sub"]'),
    ).toBeNull();
  });

  it('exposes the variant via a data attribute AND a visible status text (not colour-only)', () => {
    render(
      <StatCard
        label="Membership"
        value="Action needed"
        variant="warning"
        variantLabel="Action needed"
      />,
    );
    const card = screen.getByTestId('stat-card');
    expect(card.getAttribute('data-variant')).toBe('warning');
    // Non-colour-only signal: the variant label text is present in the DOM.
    const status = screen.getByTestId('stat-card-status');
    expect(status.textContent).toContain('Action needed');
    // And an icon accompanies it (aria-hidden, paired with the text).
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('defaults to the neutral variant with no status row', () => {
    render(<StatCard label="Plan" value="Premium" />);
    const card = screen.getByTestId('stat-card');
    expect(card.getAttribute('data-variant')).toBe('neutral');
    expect(screen.queryByTestId('stat-card-status')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/stat-card.test.tsx
```

Expected: FAIL — `@/components/portal/dashboard/stat-card` does not exist (module-not-found resolution error).

- [ ] **Step 3: Implement**

```tsx
// src/components/portal/dashboard/stat-card.tsx
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Dashboard StatCard — label + big value + optional sub, with an
 * optional status variant. The variant is conveyed by BOTH a text
 * label and an icon (never colour alone — WCAG 1.4.1, spec §5).
 *
 * Server-safe: no `'use client'`, no hooks, pure presentation. The
 * caller supplies already-localised strings (no i18n inside the
 * primitive so it stays composable across portal surfaces).
 *
 * Heading rule (spec a11y-6): the label renders as a real `<h2>`, not
 * a CardTitle div, so the dashboard outline is h1 (PageHeader) → h2.
 */
export type StatCardVariant = 'neutral' | 'warning' | 'destructive' | 'ok';

const VARIANT_ICON: Record<Exclude<StatCardVariant, 'neutral'>, LucideIcon> = {
  warning: AlertTriangle,
  destructive: XCircle,
  ok: CheckCircle2,
};

const VARIANT_STATUS_CLASS: Record<
  Exclude<StatCardVariant, 'neutral'>,
  string
> = {
  warning: 'text-warning',
  destructive: 'text-destructive',
  ok: 'text-success',
};

export interface StatCardProps {
  /** Already-localised stat label. Rendered as a real `<h2>`. */
  readonly label: string;
  /** Already-localised primary value (the big number/text). */
  readonly value: React.ReactNode;
  /** Optional already-localised supporting line under the value. */
  readonly sub?: React.ReactNode;
  /** Status variant. Defaults to `neutral` (no status row). */
  readonly variant?: StatCardVariant;
  /**
   * Already-localised status text shown next to the variant icon.
   * Required to render the status row for non-neutral variants — the
   * text (not colour) is the accessible signal.
   */
  readonly variantLabel?: string;
  readonly className?: string;
}

export function StatCard({
  label,
  value,
  sub,
  variant = 'neutral',
  variantLabel,
  className,
}: StatCardProps) {
  const showStatus = variant !== 'neutral' && Boolean(variantLabel);
  const Icon = variant === 'neutral' ? Info : VARIANT_ICON[variant];

  return (
    <Card
      data-testid="stat-card"
      data-variant={variant}
      className={cn('h-full', className)}
    >
      <CardContent className="flex flex-col gap-1.5">
        <h2 className="text-caption font-medium text-muted-foreground">
          {label}
        </h2>
        <p className="text-2xl font-semibold leading-tight tabular-nums">
          {value}
        </p>
        {sub !== undefined ? (
          <p
            data-slot="stat-card-sub"
            className="text-caption text-muted-foreground"
          >
            {sub}
          </p>
        ) : null}
        {showStatus ? (
          <p
            data-testid="stat-card-status"
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 text-caption font-medium',
              variant !== 'neutral' && VARIANT_STATUS_CLASS[variant],
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {variantLabel}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/stat-card.test.tsx
```

Expected: PASS — h2 label, value, sub, `data-variant`, status text + svg, and neutral default all assert green.

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/dashboard/stat-card.tsx tests/unit/components/portal/dashboard/stat-card.test.tsx
git commit -m "feat(portal): add StatCard dashboard primitive (non-colour-only variant)"
```

---

### Task 23: QuotaBar dashboard primitive

**Files:**
- Create `src/components/portal/dashboard/quota-bar.tsx`
- Test `tests/unit/components/portal/dashboard/quota-bar.test.tsx`

A labelled progress bar showing a **VISIBLE** text value (e.g. `2/5`) alongside the bar, plus the WAI-ARIA `role="progressbar"` with `aria-valuenow/min/max` (spec §5/§7 a11y-5). It composes the existing `Progress` primitive (`@/components/ui/progress`) which already emits `role="progressbar"` + `aria-valuemin={0}` + `aria-valuemax={max}` + `aria-valuenow={value}`. The QuotaBar wires `aria-labelledby` to the visible label and renders the `used/max` readout as **visible** text (NOT `aria-hidden` — this is the deliberate difference from the existing `ProgressBar`, whose readout is hidden). It is a client component because it uses `useTranslations` for the SR aria-label string.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/dashboard/quota-bar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QuotaBar } from '@/components/portal/dashboard/quota-bar';
import enMessages from '@/i18n/messages/en.json';

function renderBar(props: Partial<React.ComponentProps<typeof QuotaBar>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QuotaBar label="E-Blasts" used={2} max={5} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<QuotaBar>', () => {
  it('renders the visible label and a VISIBLE 2/5 readout', () => {
    renderBar();
    expect(screen.getByText('E-Blasts')).toBeDefined();
    // Visible readout from portal.dashboard.quotaBar.readout = "{used} of {max}".
    const readout = screen.getByText('2 of 5');
    expect(readout).toBeDefined();
    // It MUST be visible — not aria-hidden (spec a11y-5: NOT length alone).
    expect(readout.getAttribute('aria-hidden')).toBeNull();
  });

  it('exposes a progressbar with aria-valuenow/min/max', () => {
    renderBar();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
  });

  it('gives the progressbar an accessible name including used/max', () => {
    renderBar();
    // portal.dashboard.quotaBar.ariaLabel = "{label}: {used} of {max} used".
    const bar = screen.getByRole('progressbar', {
      name: 'E-Blasts: 2 of 5 used',
    });
    expect(bar).toBeDefined();
  });

  it('clamps aria-valuenow within [0, max] for over-quota inputs', () => {
    renderBar({ used: 9, max: 5 });
    const bar = screen.getByRole('progressbar');
    // Visible readout still shows the raw counts (member sees 9 of 5).
    expect(screen.getByText('9 of 5')).toBeDefined();
    // But aria-valuenow is clamped so AT does not announce out-of-range.
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/quota-bar.test.tsx
```

Expected: FAIL — `@/components/portal/dashboard/quota-bar` does not exist (module-not-found).

- [ ] **Step 3: Implement**

```tsx
// src/components/portal/dashboard/quota-bar.tsx
'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/**
 * QuotaBar — a labelled benefit-quota bar for the member dashboard.
 *
 * Unlike the generic `<ProgressBar>` (whose numeric readout is
 * `aria-hidden` and exposed only via `aria-valuetext`), QuotaBar
 * renders the `used/max` readout as **visible** text next to the
 * label — spec §5/§7 a11y-5 mandates a visible value, NOT colour or
 * bar-length alone. The underlying `<Progress>` still supplies the
 * canonical `role="progressbar"` + `aria-valuemin/max/now`.
 *
 * `aria-valuenow` is clamped to `[0, max]` so assistive tech never
 * announces an out-of-range value when a member is over quota; the
 * visible readout deliberately keeps the raw counts (e.g. "9 of 5")
 * so the over-use is surfaced to sighted users too.
 */
export interface QuotaBarProps {
  /** Already-localised benefit label, e.g. "E-Blasts". */
  readonly label: string;
  readonly used: number;
  readonly max: number;
  readonly className?: string;
  /** Bar tone — defaults to primary; warning for under-/over-use callouts. */
  readonly tone?: 'primary' | 'warning' | 'success';
}

export function QuotaBar({
  label,
  used,
  max,
  className,
  tone = 'primary',
}: QuotaBarProps) {
  const t = useTranslations('portal.dashboard.quotaBar');
  const labelId = useId();

  const safeMax = max > 0 ? max : 0;
  const clampedNow = Math.min(Math.max(used, 0), safeMax);
  const readout = t('readout', { used, max: safeMax });
  const ariaLabel = t('ariaLabel', { label, used, max: safeMax });

  return (
    <div data-slot="quota-bar" className={cn('grid gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2 text-caption">
        <span id={labelId} className="font-medium">
          {label}
        </span>
        <span className="tabular-nums text-muted-foreground">{readout}</span>
      </div>
      <Progress
        value={clampedNow}
        max={safeMax}
        tone={tone}
        aria-labelledby={labelId}
        aria-label={ariaLabel}
      />
    </div>
  );
}
```

Note: `Progress` accepts both `aria-labelledby` and `aria-label`; here `aria-label` carries the used/max-rich name so the accessible name is "E-Blasts: 2 of 5 used" (the test asserts this exact name). `aria-valuenow`/`min`/`max` come straight from `Progress`.

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/quota-bar.test.tsx
```

Expected: PASS — visible `2 of 5`, progressbar role with valuenow=2/min=0/max=5, accessible name `E-Blasts: 2 of 5 used`, and the clamp case (valuenow=5 while readout shows `9 of 5`). Depends on Task 21 keys being present.

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/dashboard/quota-bar.tsx tests/unit/components/portal/dashboard/quota-bar.test.tsx
git commit -m "feat(portal): add QuotaBar primitive (visible 2/5 + progressbar aria)"
```

---

### Task 24: QuickAction dashboard primitive

**Files:**
- Create `src/components/portal/dashboard/quick-action.tsx`
- Test `tests/unit/components/portal/dashboard/quick-action.test.tsx`

An action affordance for the dashboard "Quick actions" grid: icon + label, `primary` or `secondary` emphasis, rendered as a Next.js `<Link>` so it is a real navigable anchor (role=link). The touch target is **≥44px** (WCAG 2.5.8, spec §7) via `min-h-11` (Tailwind `11` = 2.75rem = 44px). It reuses `buttonVariants` for the chrome (matching the existing portal pattern in the summary card). Server-safe (no hooks; caller passes a localised `label`).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/dashboard/quick-action.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreditCard } from 'lucide-react';
import { QuickAction } from '@/components/portal/dashboard/quick-action';

describe('<QuickAction>', () => {
  it('renders a link with the given href and label', () => {
    render(
      <QuickAction href="/portal/invoices" label="Pay invoice" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'Pay invoice' });
    expect(link.getAttribute('href')).toBe('/portal/invoices');
  });

  it('guarantees a >=44px target via the min-h-11 utility', () => {
    render(
      <QuickAction href="/portal/edit" label="Edit profile" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'Edit profile' });
    expect(link.className).toContain('min-h-11');
  });

  it('renders the icon as decorative (aria-hidden) so the label is the name', () => {
    render(
      <QuickAction href="/portal/benefits" label="View benefits" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'View benefits' });
    const svg = link.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies primary chrome by default and secondary when requested', () => {
    const { rerender } = render(
      <QuickAction href="/a" label="A" icon={CreditCard} />,
    );
    expect(screen.getByRole('link', { name: 'A' }).getAttribute('data-emphasis')).toBe(
      'primary',
    );
    rerender(
      <QuickAction href="/b" label="B" icon={CreditCard} emphasis="secondary" />,
    );
    expect(screen.getByRole('link', { name: 'B' }).getAttribute('data-emphasis')).toBe(
      'secondary',
    );
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/quick-action.test.tsx
```

Expected: FAIL — `@/components/portal/dashboard/quick-action` does not exist (module-not-found).

- [ ] **Step 3: Implement**

```tsx
// src/components/portal/dashboard/quick-action.tsx
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * QuickAction — a transactional dashboard shortcut (Pay invoice, View
 * benefits, Renew, Edit profile). Rendered as a real `<Link>` so it is
 * a navigable anchor (role=link) with working back-button / deep-link
 * behaviour.
 *
 * Touch target ≥44px (WCAG 2.5.8, spec §7): `min-h-11` is Tailwind's
 * 2.75rem = 44px. The icon is decorative (`aria-hidden`) — the visible
 * label is the accessible name. Chrome reuses `buttonVariants` to match
 * the existing portal button language. Server-safe (no hooks); the
 * caller passes an already-localised `label`.
 */
export interface QuickActionProps {
  readonly href: string;
  /** Already-localised action label (also the accessible name). */
  readonly label: string;
  readonly icon: LucideIcon;
  /** `primary` = filled CTA, `secondary` = outline. Defaults to primary. */
  readonly emphasis?: 'primary' | 'secondary';
  readonly className?: string;
}

export function QuickAction({
  href,
  label,
  icon: Icon,
  emphasis = 'primary',
  className,
}: QuickActionProps) {
  return (
    <Link
      href={href}
      data-emphasis={emphasis}
      className={cn(
        buttonVariants({
          variant: emphasis === 'primary' ? 'default' : 'outline',
        }),
        // min-h-11 = 44px target; justify-start + full width so the
        // 2×2 mobile grid (spec §4.1) reads as tappable rows.
        'min-h-11 w-full justify-start gap-2 px-3',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/quick-action.test.tsx
```

Expected: PASS — link href + name, `min-h-11` present, `svg` is `aria-hidden`, and `data-emphasis` flips primary/secondary.

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/dashboard/quick-action.tsx tests/unit/components/portal/dashboard/quick-action.test.tsx
git commit -m "feat(portal): add QuickAction primitive (>=44px target, icon+label link)"
```

---

### Task 25: ActivityFeed dashboard primitive

**Files:**
- Create `src/components/portal/dashboard/activity-feed.tsx`
- Test `tests/unit/components/portal/dashboard/activity-feed.test.tsx`

A compact recent-activity list: each item = icon + already-localised text + relative time (reusing `RelativeTime` from `@/components/ui/relative-time`), with a localised EMPTY state (spec §4.1 — empty/first-run is mandatory). It is a client component (uses `useTranslations`; `RelativeTime` itself is a client component requiring a `NextIntlClientProvider` ancestor). The caller supplies a pre-shaped, already-localised item list (the dashboard does the source-specific label/icon resolution + the member-permission event filter per spec S-2; this primitive is pure presentation).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/portal/dashboard/activity-feed.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CreditCard } from 'lucide-react';
import {
  ActivityFeed,
  type ActivityFeedItem,
} from '@/components/portal/dashboard/activity-feed';
import enMessages from '@/i18n/messages/en.json';

function renderFeed(items: readonly ActivityFeedItem[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ActivityFeed items={items} viewAllHref="/portal/timeline" />
    </NextIntlClientProvider>,
  );
}

describe('<ActivityFeed>', () => {
  it('renders the section title as a real h2', () => {
    renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice INV-2026-0001 paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
    ]);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Recent activity');
  });

  it('renders one list item per activity with its text and a <time> element', () => {
    renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice INV-2026-0001 paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
      {
        id: '2',
        icon: CreditCard,
        text: 'Broadcast "Spring news" sent',
        iso: '2026-06-04T09:00:00.000Z',
      },
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Invoice INV-2026-0001 paid')).toBeDefined();
    // RelativeTime renders a <time dateTime> element per item.
    expect(document.querySelectorAll('time')).toHaveLength(2);
  });

  it('renders the localised empty state when there are no items', () => {
    renderFeed([]);
    // portal.dashboard.activity.empty.title / .body
    expect(screen.getByText('No activity yet')).toBeDefined();
    expect(
      screen.getByText(/Your invoices, benefit usage and broadcasts/i),
    ).toBeDefined();
    // No list rendered in the empty state.
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders a view-all link only when items are present', () => {
    const { rerender } = renderFeed([
      {
        id: '1',
        icon: CreditCard,
        text: 'Invoice paid',
        iso: '2026-06-05T10:00:00.000Z',
      },
    ]);
    expect(
      screen.getByRole('link', { name: 'View all activity' }).getAttribute('href'),
    ).toBe('/portal/timeline');

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ActivityFeed items={[]} viewAllHref="/portal/timeline" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('link', { name: 'View all activity' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/activity-feed.test.tsx
```

Expected: FAIL — `@/components/portal/dashboard/activity-feed` does not exist (module-not-found).

- [ ] **Step 3: Implement**

```tsx
// src/components/portal/dashboard/activity-feed.tsx
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import { RelativeTime } from '@/components/ui/relative-time';
import { cn } from '@/lib/utils';

/**
 * ActivityFeed — a compact recent-activity preview for the member
 * dashboard (icon + text + relative time). The dashboard resolves the
 * source-specific icon + already-localised text AND applies the
 * member-permission event filter (spec S-2 — member-relevant events
 * only); this primitive is pure presentation.
 *
 * Mandatory empty/first-run state (spec §4.1): ~131 launch invitees
 * land on an empty dashboard, so a friendly localised empty state is
 * required, never a blank list.
 *
 * Client component: `RelativeTime` needs a `NextIntlClientProvider`
 * ancestor and `useTranslations` resolves the section/empty copy.
 * Section title is a real `<h2>` (spec a11y-6).
 */
export interface ActivityFeedItem {
  readonly id: string;
  readonly icon: LucideIcon;
  /** Already-localised one-line description of the event. */
  readonly text: string;
  /** ISO 8601 UTC timestamp (BE display handled by RelativeTime for `th`). */
  readonly iso: string;
}

export interface ActivityFeedProps {
  readonly items: readonly ActivityFeedItem[];
  /** "View all" destination (e.g. /portal/timeline). */
  readonly viewAllHref: string;
  readonly className?: string;
}

export function ActivityFeed({
  items,
  viewAllHref,
  className,
}: ActivityFeedProps) {
  const t = useTranslations('portal.dashboard.activity');
  const isEmpty = items.length === 0;

  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium leading-snug">
          {t('title')}
        </h2>
        {!isEmpty ? (
          <Link
            href={viewAllHref}
            className="text-caption text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t('viewAll')}
          </Link>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-body font-medium">{t('empty.title')}</p>
          <p className="mt-1 text-caption text-muted-foreground">
            {t('empty.body')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground"
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-body">{item.text}</span>
                  <RelativeTime
                    iso={item.iso}
                    className="text-caption text-muted-foreground"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
pnpm vitest run tests/unit/components/portal/dashboard/activity-feed.test.tsx
```

Expected: PASS — h2 title, 2 list items + 2 `<time>` elements, localised empty state (no list), and view-all link present only with items. Depends on Task 21 keys.

- [ ] **Step 5: Commit**

```bash
git add src/components/portal/dashboard/activity-feed.tsx tests/unit/components/portal/dashboard/activity-feed.test.tsx
git commit -m "feat(portal): add ActivityFeed primitive with mandatory empty state"
```

---

# G3 — Dashboard page (`/portal` at-a-glance hub)

### Task 40: Pure dashboard stat-derivation lib
**Files:**
- Create `src/app/(member)/portal/_lib/dashboard-stats.ts`
- Test `tests/unit/portal/dashboard/dashboard-stats.test.ts`

Pure, framework-free functions that turn the existing read outputs (`RenewalCycle`, the `BenefitUsage` VO, the invoice rows) into plain serialisable stat view-models. This is the testable core — no async, no DB, no React. The "Renew due" threshold (30 days) is the SINGLE source consumed by both the Membership card and the Quick-actions Renew CTA (spec §4.1 "same threshold").

- [ ] **Step 1: Write the failing test** — full test code block

```ts
// tests/unit/portal/dashboard/dashboard-stats.test.ts
import { describe, expect, it } from 'vitest';
import {
  RENEW_DUE_THRESHOLD_DAYS,
  deriveMembershipStat,
  deriveOutstandingStat,
  deriveBenefitsStat,
  isRenewDue,
} from '@/app/(member)/portal/_lib/dashboard-stats';
import type { RenewalCycle } from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';

function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: 'c1',
    memberId: 'm1',
    status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2026-12-31T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedReason: null,
    ...overrides,
  } as RenewalCycle;
}

const NOW = new Date('2026-06-06T00:00:00.000Z');

describe('deriveMembershipStat', () => {
  it('returns the empty/first-run variant when the member has no cycle', () => {
    const stat = deriveMembershipStat(null, NOW);
    expect(stat.kind).toBe('empty');
    expect(stat.variant).toBe('neutral');
    expect(stat.daysRemaining).toBeNull();
  });

  it('returns action-needed (warning) when awaiting payment within the renew threshold', () => {
    // expires 10 days out → within the 30-day threshold
    const stat = deriveMembershipStat(
      cycle({ status: 'awaiting_payment', expiresAt: '2026-06-16T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('due');
    expect(stat.variant).toBe('warning');
    expect(stat.daysRemaining).toBe(10);
  });

  it('returns overdue (destructive) when the cycle has expired and is non-terminal', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'awaiting_payment', expiresAt: '2026-05-27T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('overdue');
    expect(stat.variant).toBe('destructive');
    expect(stat.daysRemaining).toBe(-10);
  });

  it('returns active (neutral) when renewal is far off — no stale countdown', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'completed', expiresAt: '2026-12-31T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('active');
    expect(stat.variant).toBe('neutral');
  });
});

describe('isRenewDue', () => {
  it('is false when there is no cycle', () => {
    expect(isRenewDue(null, NOW)).toBe(false);
  });
  it('is true within the threshold, false outside it', () => {
    expect(isRenewDue(cycle({ expiresAt: '2026-06-16T00:00:00.000Z' }), NOW)).toBe(true);
    expect(isRenewDue(cycle({ expiresAt: '2026-09-30T00:00:00.000Z' }), NOW)).toBe(false);
  });
  it('is true when overdue (negative days still inside the renew window)', () => {
    expect(isRenewDue(cycle({ expiresAt: '2026-05-27T00:00:00.000Z' }), NOW)).toBe(true);
  });
  it('is false for a terminal completed cycle far from expiry', () => {
    expect(
      isRenewDue(cycle({ status: 'completed', expiresAt: '2026-12-31T00:00:00.000Z' }), NOW),
    ).toBe(false);
  });
  it('exposes the threshold constant', () => {
    expect(RENEW_DUE_THRESHOLD_DAYS).toBe(30);
  });
});

describe('deriveOutstandingStat', () => {
  it('sums issued/overdue totals and counts them', () => {
    const stat = deriveOutstandingStat([
      { status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' },
      { status: 'issued', totalSatang: 53_50n, dueDate: '2026-06-10' },
      { status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' },
    ]);
    expect(stat.kind).toBe('owing');
    expect(stat.totalSatang).toBe(1_123_50n);
    expect(stat.count).toBe(2);
    expect(stat.earliestDueDate).toBe('2026-06-10');
  });

  it('returns the clear/first-run variant when nothing is owed', () => {
    const stat = deriveOutstandingStat([
      { status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' },
    ]);
    expect(stat.kind).toBe('clear');
    expect(stat.totalSatang).toBe(0n);
    expect(stat.count).toBe(0);
  });

  it('treats an empty list as clear (first-run member)', () => {
    expect(deriveOutstandingStat([]).kind).toBe('clear');
  });
});

describe('deriveBenefitsStat', () => {
  function usage(overrides: Partial<BenefitUsage>): BenefitUsage {
    return {
      membershipYear: 2026,
      elapsedYearPct: 50,
      quantifiable: [],
      active: [],
      aggregateConsumedPct: null,
      gapPct: null,
      underUseWarning: false,
      ...overrides,
    };
  }

  it('returns empty/first-run when the member has no benefits at all', () => {
    expect(deriveBenefitsStat(usage({})).kind).toBe('empty');
  });

  it('counts per-benefit under-use (each benefit ratio lagging elapsed-year by ≥25pts)', () => {
    // elapsed 80%; eblast 0/5 (0%) is under-used, cultural 5/5 (100%) is on track
    const stat = deriveBenefitsStat(
      usage({
        elapsedYearPct: 80,
        quantifiable: [
          { key: 'eblast', used: 0, entitlement: 5, lastUsedAt: null },
          { key: 'cultural_tickets', used: 5, entitlement: 5, lastUsedAt: '2026-03-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(stat.kind).toBe('under-use');
    expect(stat.variant).toBe('warning');
    expect(stat.underUseCount).toBe(1);
  });

  it('returns on-track when every benefit keeps pace with the year', () => {
    const stat = deriveBenefitsStat(
      usage({
        elapsedYearPct: 50,
        quantifiable: [{ key: 'eblast', used: 3, entitlement: 5, lastUsedAt: null }],
      }),
    );
    expect(stat.kind).toBe('on-track');
    expect(stat.variant).toBe('neutral');
    expect(stat.underUseCount).toBe(0);
  });

  it('is on-track (never under-use) for an active-only plan with no quantifiable benefits', () => {
    const stat = deriveBenefitsStat(usage({ active: [{ key: 'logo_listing' }] }));
    expect(stat.kind).toBe('on-track');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/portal/dashboard/dashboard-stats.test.ts`
  - Expected: FAIL — `Cannot find module '@/app/(member)/portal/_lib/dashboard-stats'` (file not created yet).

- [ ] **Step 3: Implement** — full code block

```ts
// src/app/(member)/portal/_lib/dashboard-stats.ts
/**
 * 057 portal redesign §4.1 — pure dashboard stat derivations.
 *
 * Framework-free (Constitution Principle III: presentation-pure helpers stay
 * dependency-light). Turns the existing F4/F8/F9 read outputs into plain,
 * serialisable view-models the dashboard sections render. No async, no DB,
 * no React — fully unit-testable.
 *
 * The 30-day "renew due" threshold is the single source consumed by BOTH the
 * Membership stat card AND the Quick-actions Renew CTA (spec §4.1: "same
 * threshold as the Membership card; hide/disable when not due").
 */
import {
  daysUntilExpiry,
  isOverdue,
  isTerminalCycleStatus,
  type RenewalCycle,
} from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';

/** Visual emphasis for a stat chip — never colour-alone (a text label always pairs it). */
export type StatVariant = 'neutral' | 'warning' | 'destructive';

/** Days-to-expiry at/under which the Renew CTA + Membership "due" variant fire. */
export const RENEW_DUE_THRESHOLD_DAYS = 30;

export interface MembershipStat {
  /** `empty` = first-run (no cycle); `active` = far off; `due`/`overdue` = act. */
  readonly kind: 'empty' | 'active' | 'due' | 'overdue';
  readonly variant: StatVariant;
  /** Days to expiry (negative = overdue), or null when no cycle / malformed. */
  readonly daysRemaining: number | null;
  /** Cycle status passed through for the card sub-line, or null. */
  readonly status: RenewalCycle['status'] | null;
  readonly expiryIso: string | null;
}

export function deriveMembershipStat(
  cycle: RenewalCycle | null,
  now: Date,
): MembershipStat {
  if (cycle === null) {
    return { kind: 'empty', variant: 'neutral', daysRemaining: null, status: null, expiryIso: null };
  }
  const raw = daysUntilExpiry(cycle, now);
  const days = Number.isFinite(raw) ? raw : null;
  const status = cycle.status;
  if (isOverdue(cycle, now)) {
    return { kind: 'overdue', variant: 'destructive', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  if (days !== null && days <= RENEW_DUE_THRESHOLD_DAYS && !isTerminalCycleStatus(status)) {
    return { kind: 'due', variant: 'warning', daysRemaining: days, status, expiryIso: cycle.expiresAt };
  }
  // Far off OR terminal-but-not-overdue → show membership status, not a stale countdown.
  return { kind: 'active', variant: 'neutral', daysRemaining: days, status, expiryIso: cycle.expiresAt };
}

/** True when the Renew CTA should show (same window as the Membership "due"/"overdue"). */
export function isRenewDue(cycle: RenewalCycle | null, now: Date): boolean {
  if (cycle === null) return false;
  if (isOverdue(cycle, now)) return true;
  if (isTerminalCycleStatus(cycle.status)) return false;
  const raw = daysUntilExpiry(cycle, now);
  return Number.isFinite(raw) && raw <= RENEW_DUE_THRESHOLD_DAYS;
}

/** The minimal invoice shape the outstanding stat needs (decoupled from the F4 domain row). */
export interface OutstandingInvoiceInput {
  readonly status: string;
  /** Invoice total in satang, or null for drafts (excluded anyway). */
  readonly totalSatang: bigint | null;
  /** ISO YYYY-MM-DD due date, or null. */
  readonly dueDate: string | null;
}

export interface OutstandingStat {
  readonly kind: 'owing' | 'clear';
  readonly totalSatang: bigint;
  readonly count: number;
  /** Earliest due date among owed invoices (lexicographic on YYYY-MM-DD), or null. */
  readonly earliestDueDate: string | null;
}

/** Statuses that represent an unpaid balance the member can pay online. */
const OWED_STATUSES = new Set(['issued']);

export function deriveOutstandingStat(
  invoices: readonly OutstandingInvoiceInput[],
): OutstandingStat {
  let totalSatang = 0n;
  let count = 0;
  let earliestDueDate: string | null = null;
  for (const inv of invoices) {
    if (!OWED_STATUSES.has(inv.status) || inv.totalSatang === null) continue;
    totalSatang += inv.totalSatang;
    count += 1;
    if (inv.dueDate !== null && (earliestDueDate === null || inv.dueDate < earliestDueDate)) {
      earliestDueDate = inv.dueDate;
    }
  }
  return {
    kind: count > 0 ? 'owing' : 'clear',
    totalSatang,
    count,
    earliestDueDate,
  };
}

/** Percentage-point gap at/above which a SINGLE benefit counts as under-used (mirrors FR-021). */
export const PER_BENEFIT_UNDER_USE_GAP_PCT = 25;

export interface BenefitsStat {
  /** `empty` = first-run (no benefits); `under-use` = ≥1 lagging; `on-track` otherwise. */
  readonly kind: 'empty' | 'under-use' | 'on-track';
  readonly variant: StatVariant;
  readonly underUseCount: number;
}

/**
 * Under-use HIGHLIGHT (spec §4.1 + review S-1) — a COUNT of benefits lagging
 * the elapsed year, NOT the aggregate %. A benefit is under-used when its
 * (used ÷ entitlement) %-point gap below the elapsed-year % is ≥ 25 (same
 * threshold the F9 aggregate uses). Active-only plans (no quantifiable
 * benefit) are always "on-track".
 */
export function deriveBenefitsStat(usage: BenefitUsage): BenefitsStat {
  const hasContent = usage.quantifiable.length > 0 || usage.active.length > 0;
  if (!hasContent) {
    return { kind: 'empty', variant: 'neutral', underUseCount: 0 };
  }
  let underUseCount = 0;
  for (const b of usage.quantifiable) {
    if (b.entitlement <= 0) continue;
    const consumedPct = (b.used / b.entitlement) * 100;
    if (usage.elapsedYearPct - consumedPct >= PER_BENEFIT_UNDER_USE_GAP_PCT) {
      underUseCount += 1;
    }
  }
  return underUseCount > 0
    ? { kind: 'under-use', variant: 'warning', underUseCount }
    : { kind: 'on-track', variant: 'neutral', underUseCount: 0 };
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/portal/dashboard/dashboard-stats.test.ts`
  - Expected: PASS — all derivation + threshold cases green.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/_lib/dashboard-stats.ts" tests/unit/portal/dashboard/dashboard-stats.test.ts`
  - `feat(portal): pure dashboard stat derivations (membership/outstanding/benefits + renew threshold)`

---

### Task 41: Reusable `StatCard` presentational primitive
**Files:**
- Create `src/app/(member)/portal/_components/stat-card.tsx`
- Test `tests/unit/portal/dashboard/stat-card.test.tsx`

A small presentational card: label (real `<h2>` so it lands in the SR heading tree, spec §7 heading rule) + big value + sub-line + an optional non-colour-only variant chip + an optional action link. Reuses `Card`, `Badge`, `Button`. Client-safe (no module imports) so all 3 stat sections feed it plain props.

- [ ] **Step 1: Write the failing test** — full test code block

```tsx
// tests/unit/portal/dashboard/stat-card.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from '@/app/(member)/portal/_components/stat-card';

describe('StatCard', () => {
  it('renders the label as a real <h2>, the value, and the sub-line', () => {
    render(
      <StatCard
        headingId="stat-membership"
        label="Membership"
        value="Active"
        sub="Renews in 40 days"
        variant="neutral"
      />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Membership' });
    expect(heading).toHaveAttribute('id', 'stat-membership');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Renews in 40 days')).toBeInTheDocument();
  });

  it('renders a text chip for the warning variant (not colour-alone)', () => {
    render(
      <StatCard
        headingId="stat-membership"
        label="Membership"
        value="Renew soon"
        sub="10 days remaining"
        variant="warning"
        chipLabel="Action needed"
      />,
    );
    expect(screen.getByText('Action needed')).toBeInTheDocument();
  });

  it('renders the action link when href + actionLabel are supplied', () => {
    render(
      <StatCard
        headingId="stat-outstanding"
        label="Outstanding"
        value="1,070.00 THB"
        sub="2 invoices"
        variant="destructive"
        actionHref="/portal/invoices"
        actionLabel="Pay now"
      />,
    );
    const link = screen.getByRole('link', { name: 'Pay now' });
    expect(link).toHaveAttribute('href', '/portal/invoices');
  });

  it('omits the action link when no href is given', () => {
    render(
      <StatCard headingId="s" label="Benefits" value="All on track" sub="" variant="neutral" />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/portal/dashboard/stat-card.test.tsx`
  - Expected: FAIL — `Cannot find module '@/app/(member)/portal/_components/stat-card'`.

- [ ] **Step 3: Implement** — full code block

```tsx
// src/app/(member)/portal/_components/stat-card.tsx
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StatVariant } from '../_lib/dashboard-stats';

const CHIP_VARIANT: Record<StatVariant, 'secondary' | 'outline' | 'destructive'> = {
  neutral: 'secondary',
  warning: 'outline',
  destructive: 'destructive',
};

export interface StatCardProps {
  /** Wired to the heading id so the label is a real <h2> in the SR tree (spec §7). */
  readonly headingId: string;
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly variant: StatVariant;
  /** Non-colour-only text chip (WCAG 1.4.1) — omitted when undefined. */
  readonly chipLabel?: string;
  readonly actionHref?: string;
  readonly actionLabel?: string;
}

/**
 * 057 portal redesign §4.1 / §5 — at-a-glance stat card (label + big value +
 * sub + optional variant chip + optional action). Presentational only; the
 * dashboard sections compute the props from the pure derivations.
 */
export function StatCard({
  headingId,
  label,
  value,
  sub,
  variant,
  chipLabel,
  actionHref,
  actionLabel,
}: StatCardProps): React.ReactElement {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-2 py-5">
        <div className="flex items-start justify-between gap-2">
          {/* Real <h2> (not CardTitle <div>) so the card lands under the page <h1> (spec §7). */}
          <h2 id={headingId} className="text-caption font-medium text-muted-foreground">
            {label}
          </h2>
          {chipLabel !== undefined ? (
            <Badge variant={CHIP_VARIANT[variant]}>{chipLabel}</Badge>
          ) : null}
        </div>
        <p className="text-h2 font-semibold tabular-nums">{value}</p>
        {sub ? <p className="text-caption text-muted-foreground">{sub}</p> : null}
        {actionHref !== undefined && actionLabel !== undefined ? (
          <Link
            href={actionHref}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'mt-auto min-h-11 self-start px-3',
            )}
          >
            {actionLabel}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/portal/dashboard/stat-card.test.tsx`
  - Expected: PASS — heading-level, value, sub, chip, and conditional link assertions green.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/_components/stat-card.tsx" tests/unit/portal/dashboard/stat-card.test.tsx`
  - `feat(portal): reusable StatCard primitive for dashboard stat sections`

---

### Task 42: Dashboard i18n keys (EN/TH/SV)
**Files:**
- Modify `src/i18n/messages/en.json` (add `portal.dashboard` block under the existing `"portal"` object)
- Modify `src/i18n/messages/th.json` (same path)
- Modify `src/i18n/messages/sv.json` (same path)

Add the full `portal.dashboard.*` namespace consumed by Tasks 43–45. EN is canonical (a missing EN key fails the build). TH/SV must mirror every key (`pnpm check:i18n` is 0-missing on release branches). Thai dates stay BE display-only via the existing `formatDate`/`useFormatter` helpers — no BE strings hardcoded here.

- [ ] **Step 1: Write the failing test** — there is no per-key vitest; the gate IS `pnpm check:i18n`. Establish the failing baseline by adding the EN keys ONLY first, which makes the check report TH/SV as missing:

```jsonc
// src/i18n/messages/en.json — add inside the existing top-level "portal": { ... } object
"dashboard": {
  "welcome": "Hi {name}",
  "intro": "Here's your membership at a glance.",
  "statusChip": {
    "active": "Active",
    "inactive": "Inactive",
    "archived": "Archived"
  },
  "membership": {
    "label": "Membership",
    "activeValue": "Active",
    "renewDueValue": "Renew soon",
    "overdueValue": "Renewal overdue",
    "activeSub": "Your membership is in good standing.",
    "daysRemainingSub": "Renews in {days} days",
    "overdueSub": "Overdue by {days} days",
    "emptyValue": "Welcome aboard",
    "emptySub": "Your renewal schedule will appear here once your first cycle starts."
  },
  "outstanding": {
    "label": "Outstanding balance",
    "value": "{amount}",
    "countSub": "{count, plural, one {# unpaid invoice} other {# unpaid invoices}}",
    "dueSub": "Earliest due {date}",
    "clearValue": "All paid",
    "clearSub": "You have no outstanding invoices."
  },
  "benefits": {
    "label": "Benefits",
    "underUseValue": "{count, plural, one {# benefit under-used} other {# benefits under-used}}",
    "underUseSub": "Make the most of what your plan includes.",
    "onTrackValue": "All benefits on track",
    "onTrackSub": "You're keeping pace with the year.",
    "emptyValue": "No benefits yet",
    "emptySub": "Your plan's benefits will show up here."
  },
  "quickActions": {
    "heading": "Quick actions",
    "pay": "Pay invoice",
    "benefits": "View benefits",
    "renew": "Renew membership",
    "editProfile": "Edit profile"
  },
  "invoicesPanel": {
    "heading": "Latest invoices"
  },
  "benefitsPanel": {
    "heading": "Benefits usage",
    "viewAll": "View all benefits"
  },
  "activity": {
    "heading": "Recent activity",
    "viewAll": "View all activity",
    "empty": "No activity yet — your membership events will appear here.",
    "emptyCta": "Explore benefits"
  },
  "firstRun": {
    "title": "Welcome to the {tenant} member portal",
    "body": "Your dashboard fills up as you use your membership — pay invoices, attend events, and use your benefits.",
    "exploreBenefits": "Explore your benefits"
  }
}
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm check:i18n`
  - Expected: FAIL — reports `portal.dashboard.*` keys missing in `th.json` and `sv.json` (EN added, locales not yet).

- [ ] **Step 3: Implement** — add the mirrored blocks to TH and SV.

```jsonc
// src/i18n/messages/th.json — add inside the existing top-level "portal": { ... } object
"dashboard": {
  "welcome": "สวัสดี {name}",
  "intro": "ภาพรวมสมาชิกภาพของคุณโดยย่อ",
  "statusChip": {
    "active": "ใช้งานอยู่",
    "inactive": "ไม่ได้ใช้งาน",
    "archived": "เก็บถาวร"
  },
  "membership": {
    "label": "สมาชิกภาพ",
    "activeValue": "ใช้งานอยู่",
    "renewDueValue": "ใกล้ต่ออายุ",
    "overdueValue": "เกินกำหนดต่ออายุ",
    "activeSub": "สมาชิกภาพของคุณอยู่ในสถานะปกติ",
    "daysRemainingSub": "ต่ออายุภายใน {days} วัน",
    "overdueSub": "เกินกำหนด {days} วัน",
    "emptyValue": "ยินดีต้อนรับ",
    "emptySub": "กำหนดการต่ออายุจะแสดงที่นี่เมื่อรอบแรกของคุณเริ่มต้น"
  },
  "outstanding": {
    "label": "ยอดค้างชำระ",
    "value": "{amount}",
    "countSub": "{count, plural, other {ใบแจ้งหนี้ค้างชำระ # ใบ}}",
    "dueSub": "กำหนดชำระเร็วสุด {date}",
    "clearValue": "ชำระครบแล้ว",
    "clearSub": "คุณไม่มีใบแจ้งหนี้ค้างชำระ"
  },
  "benefits": {
    "label": "สิทธิประโยชน์",
    "underUseValue": "{count, plural, other {สิทธิประโยชน์ที่ยังใช้ไม่เต็มที่ # รายการ}}",
    "underUseSub": "ใช้สิทธิประโยชน์ในแพ็กเกจของคุณให้คุ้มค่า",
    "onTrackValue": "ใช้สิทธิประโยชน์ได้ตามเป้าหมาย",
    "onTrackSub": "คุณใช้สิทธิประโยชน์ได้สอดคล้องกับช่วงเวลาของปี",
    "emptyValue": "ยังไม่มีสิทธิประโยชน์",
    "emptySub": "สิทธิประโยชน์ตามแพ็กเกจของคุณจะแสดงที่นี่"
  },
  "quickActions": {
    "heading": "ทางลัด",
    "pay": "ชำระใบแจ้งหนี้",
    "benefits": "ดูสิทธิประโยชน์",
    "renew": "ต่ออายุสมาชิกภาพ",
    "editProfile": "แก้ไขโปรไฟล์"
  },
  "invoicesPanel": {
    "heading": "ใบแจ้งหนี้ล่าสุด"
  },
  "benefitsPanel": {
    "heading": "การใช้สิทธิประโยชน์",
    "viewAll": "ดูสิทธิประโยชน์ทั้งหมด"
  },
  "activity": {
    "heading": "กิจกรรมล่าสุด",
    "viewAll": "ดูกิจกรรมทั้งหมด",
    "empty": "ยังไม่มีกิจกรรม — กิจกรรมสมาชิกภาพของคุณจะแสดงที่นี่",
    "emptyCta": "สำรวจสิทธิประโยชน์"
  },
  "firstRun": {
    "title": "ยินดีต้อนรับสู่พอร์ทัลสมาชิก {tenant}",
    "body": "แดชบอร์ดของคุณจะมีข้อมูลมากขึ้นเมื่อคุณใช้สมาชิกภาพ — ชำระใบแจ้งหนี้ เข้าร่วมกิจกรรม และใช้สิทธิประโยชน์",
    "exploreBenefits": "สำรวจสิทธิประโยชน์ของคุณ"
  }
}
```

```jsonc
// src/i18n/messages/sv.json — add inside the existing top-level "portal": { ... } object
"dashboard": {
  "welcome": "Hej {name}",
  "intro": "Här är ditt medlemskap i korthet.",
  "statusChip": {
    "active": "Aktiv",
    "inactive": "Inaktiv",
    "archived": "Arkiverad"
  },
  "membership": {
    "label": "Medlemskap",
    "activeValue": "Aktivt",
    "renewDueValue": "Förnya snart",
    "overdueValue": "Förnyelse försenad",
    "activeSub": "Ditt medlemskap är i gott skick.",
    "daysRemainingSub": "Förnyas om {days} dagar",
    "overdueSub": "Försenad med {days} dagar",
    "emptyValue": "Välkommen",
    "emptySub": "Ditt förnyelseschema visas här när din första period börjar."
  },
  "outstanding": {
    "label": "Utestående saldo",
    "value": "{amount}",
    "countSub": "{count, plural, one {# obetald faktura} other {# obetalda fakturor}}",
    "dueSub": "Förfaller tidigast {date}",
    "clearValue": "Allt betalt",
    "clearSub": "Du har inga utestående fakturor."
  },
  "benefits": {
    "label": "Förmåner",
    "underUseValue": "{count, plural, one {# förmån underutnyttjad} other {# förmåner underutnyttjade}}",
    "underUseSub": "Få ut det mesta av det din plan inkluderar.",
    "onTrackValue": "Alla förmåner på rätt spår",
    "onTrackSub": "Du håller jämna steg med året.",
    "emptyValue": "Inga förmåner ännu",
    "emptySub": "Din plans förmåner visas här."
  },
  "quickActions": {
    "heading": "Snabbåtgärder",
    "pay": "Betala faktura",
    "benefits": "Visa förmåner",
    "renew": "Förnya medlemskap",
    "editProfile": "Redigera profil"
  },
  "invoicesPanel": {
    "heading": "Senaste fakturor"
  },
  "benefitsPanel": {
    "heading": "Förmånsanvändning",
    "viewAll": "Visa alla förmåner"
  },
  "activity": {
    "heading": "Senaste aktivitet",
    "viewAll": "Visa all aktivitet",
    "empty": "Ingen aktivitet ännu — dina medlemshändelser visas här.",
    "emptyCta": "Utforska förmåner"
  },
  "firstRun": {
    "title": "Välkommen till {tenant}s medlemsportal",
    "body": "Din instrumentpanel fylls på när du använder ditt medlemskap — betala fakturor, delta i evenemang och använd dina förmåner.",
    "exploreBenefits": "Utforska dina förmåner"
  }
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm check:i18n`
  - Expected: PASS — 0 missing keys across EN/TH/SV for `portal.dashboard.*`.

- [ ] **Step 5: Commit** — `git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json`
  - `feat(i18n): add portal.dashboard.* keys (EN/TH/SV)`

---

### Task 43: Cached reads + 3 stat sections (membership / outstanding / benefits)
**Files:**
- Create `src/app/(member)/portal/_components/dashboard-reads.ts`
- Create `src/app/(member)/portal/_components/membership-stat-section.tsx`
- Create `src/app/(member)/portal/_components/outstanding-stat-section.tsx`
- Create `src/app/(member)/portal/_components/benefits-stat-section.tsx`
- Test `tests/unit/portal/dashboard/dashboard-reads.test.ts`

`dashboard-reads.ts` centralises the RLS-safe, session-memberId reads wrapped in React `cache()` for per-request dedup (spec §4.1 + risk "duplicate reads"). Each stat section is an async server component that resolves the cached read, runs the pure derivation, and renders `StatCard` with a Suspense skeleton. The unit test here covers the pure label/variant→`StatCard`-props mapping (a tiny pure helper colocated in each section), so the async server components themselves stay thin.

- [ ] **Step 1: Write the failing test** — full test code block

```ts
// tests/unit/portal/dashboard/dashboard-reads.test.ts
import { describe, expect, it } from 'vitest';
import { toOutstandingInvoiceInputs } from '@/app/(member)/portal/_components/dashboard-reads';

describe('toOutstandingInvoiceInputs', () => {
  it('maps Invoice rows to the pure outstanding shape (satang + due date)', () => {
    const rows = [
      {
        status: 'issued',
        total: { satang: 107_000n },
        dueDate: '2026-06-20',
      },
      {
        status: 'draft',
        total: null,
        dueDate: null,
      },
    ] as const;
    const out = toOutstandingInvoiceInputs(rows as never);
    expect(out).toEqual([
      { status: 'issued', totalSatang: 107_000n, dueDate: '2026-06-20' },
      { status: 'draft', totalSatang: null, dueDate: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/portal/dashboard/dashboard-reads.test.ts`
  - Expected: FAIL — `Cannot find module '@/app/(member)/portal/_components/dashboard-reads'`.

- [ ] **Step 3: Implement** — full code blocks

```ts
// src/app/(member)/portal/_components/dashboard-reads.ts
/**
 * 057 portal redesign §4.1 — per-request cached, RLS-safe dashboard reads.
 *
 * The Dashboard renders 3 stat sections + 2 panels + an activity feed that
 * each need (a) the session member and (b) one of the existing F4/F8/F9
 * reads. Without dedup, `findByLinkedUserId` + the renewal/benefit reads
 * would run once per section. React `cache()` memoises per request so a read
 * runs at most once per render (spec §4.1 + §9 "duplicate reads" risk). These
 * wrappers are ALSO reusable by the Profile page (which reads renewal/benefit
 * too).
 *
 * Every read goes through a module barrel and resolves the member from the
 * SESSION (`findByLinkedUserId`), never the URL — a member can only ever see
 * their own data (Constitution Principle I; mirrors `/portal/benefits` +
 * `/portal/timeline`).
 */
import { cache } from 'react';
import type { UserAccount } from '@/modules/auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  loadMemberRenewalStatus,
  makeRenewalsDeps,
  type RenewalCycle,
} from '@/modules/renewals';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  type BenefitUsage,
} from '@/modules/insights';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  type Invoice,
} from '@/modules/invoicing';
import type { OutstandingInvoiceInput } from '../_lib/dashboard-stats';

/** Resolve the session member id once per request (null when the account isn't linked). */
export const resolveDashboardMemberId = cache(
  async (userId: UserAccount['id']): Promise<string | null> => {
    const tenant = resolveTenantFromRequest();
    const deps = buildMembersDeps(tenant);
    const res = await deps.memberRepo.findByLinkedUserId(tenant, userId);
    return res.ok ? res.value.memberId : null;
  },
);

/** Most-recent renewal cycle for the session member, or null. Cached per request. */
export const loadDashboardRenewalCycle = cache(
  async (memberId: string): Promise<RenewalCycle | null> => {
    const tenant = resolveTenantFromRequest();
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenant.slug), {
      tenantId: tenant.slug,
      memberId,
    });
    return res.ok ? res.value.cycle : null;
  },
);

/** Benefit usage VO for the session member, or null on a genuine compute failure. */
export const loadDashboardBenefitUsage = cache(
  async (memberId: string): Promise<BenefitUsage | null> => {
    const tenant = resolveTenantFromRequest();
    const res = await computeBenefitUsage(
      tenant,
      { memberId },
      makeComputeBenefitUsageDeps(tenant.slug),
    );
    return res.ok ? res.value : null;
  },
);

/** Map F4 Invoice rows to the pure outstanding-stat shape (extracted for unit test). */
export function toOutstandingInvoiceInputs(
  rows: readonly Invoice[],
): OutstandingInvoiceInput[] {
  return rows.map((r) => ({
    status: r.status,
    totalSatang: r.total?.satang ?? null,
    dueDate: r.dueDate,
  }));
}

/** The member's unpaid invoices (issued only — drafts excluded). Cached per request. */
export const loadDashboardOutstanding = cache(
  async (memberId: string): Promise<OutstandingInvoiceInput[]> => {
    const tenant = resolveTenantFromRequest();
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenant.slug), {
      tenantId: tenant.slug,
      offset: 0,
      pageSize: 200,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    return res.ok ? toOutstandingInvoiceInputs(res.value.rows) : [];
  },
);
```

```tsx
// src/app/(member)/portal/_components/membership-stat-section.tsx
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from './stat-card';
import { deriveMembershipStat } from '../_lib/dashboard-stats';
import { loadDashboardRenewalCycle } from './dashboard-reads';

export async function MembershipStatSection({
  memberId,
}: {
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.membership');
  const cycle = await loadDashboardRenewalCycle(memberId);
  const stat = deriveMembershipStat(cycle, new Date());

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'overdue'
        ? t('overdueValue')
        : stat.kind === 'due'
          ? t('renewDueValue')
          : t('activeValue');

  const sub =
    stat.kind === 'empty'
      ? t('emptySub')
      : stat.kind === 'overdue' && stat.daysRemaining !== null
        ? t('overdueSub', { days: Math.abs(stat.daysRemaining) })
        : stat.daysRemaining !== null && stat.kind !== 'active'
          ? t('daysRemainingSub', { days: stat.daysRemaining })
          : t('activeSub');

  return (
    <StatCard
      headingId="dashboard-stat-membership"
      label={t('label')}
      value={value}
      sub={sub}
      variant={stat.variant}
      {...(stat.kind === 'due' || stat.kind === 'overdue'
        ? { actionHref: `/portal/renewal/${memberId}`, actionLabel: t('renewDueValue') }
        : {})}
    />
  );
}

export function StatSkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true" className="h-full">
      <CardContent className="flex flex-col gap-2 py-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  );
}
```

```tsx
// src/app/(member)/portal/_components/outstanding-stat-section.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { formatSatangThb } from '@/lib/format-thb';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { StatCard } from './stat-card';
import { deriveOutstandingStat } from '../_lib/dashboard-stats';
import { loadDashboardOutstanding } from './dashboard-reads';

function formatDueDate(ymd: string, locale: string): string {
  // Display-only BE for th via getDateFormatLocale (storage stays UTC Gregorian).
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString(getDateFormatLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export async function OutstandingStatSection({
  memberId,
}: {
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.outstanding');
  const locale = await getLocale();
  const invoices = await loadDashboardOutstanding(memberId);
  const stat = deriveOutstandingStat(invoices);

  if (stat.kind === 'clear') {
    return (
      <StatCard
        headingId="dashboard-stat-outstanding"
        label={t('label')}
        value={t('clearValue')}
        sub={t('clearSub')}
        variant="neutral"
      />
    );
  }

  const sub =
    stat.earliestDueDate !== null
      ? t('dueSub', { date: formatDueDate(stat.earliestDueDate, locale) })
      : t('countSub', { count: stat.count });

  return (
    <StatCard
      headingId="dashboard-stat-outstanding"
      label={t('label')}
      value={t('value', { amount: formatSatangThb(stat.totalSatang, locale) })}
      sub={sub}
      variant="destructive"
      actionHref="/portal/invoices"
      actionLabel={t('countSub', { count: stat.count })}
    />
  );
}
```

```tsx
// src/app/(member)/portal/_components/benefits-stat-section.tsx
import { getTranslations } from 'next-intl/server';
import { StatCard } from './stat-card';
import { deriveBenefitsStat } from '../_lib/dashboard-stats';
import { loadDashboardBenefitUsage } from './dashboard-reads';

export async function BenefitsStatSection({
  memberId,
}: {
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.benefits');
  const usage = await loadDashboardBenefitUsage(memberId);

  // Risk PM-3: a genuine compute miss (null) shows a placeholder, never a wrong number.
  if (usage === null) {
    return (
      <StatCard
        headingId="dashboard-stat-benefits"
        label={t('label')}
        value={t('emptyValue')}
        sub={t('emptySub')}
        variant="neutral"
      />
    );
  }

  const stat = deriveBenefitsStat(usage);

  const value =
    stat.kind === 'empty'
      ? t('emptyValue')
      : stat.kind === 'under-use'
        ? t('underUseValue', { count: stat.underUseCount })
        : t('onTrackValue');
  const sub =
    stat.kind === 'empty'
      ? t('emptySub')
      : stat.kind === 'under-use'
        ? t('underUseSub')
        : t('onTrackSub');

  return (
    <StatCard
      headingId="dashboard-stat-benefits"
      label={t('label')}
      value={value}
      sub={sub}
      variant={stat.variant}
      actionHref="/portal/benefits"
      actionLabel={t('label')}
    />
  );
}
```

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/portal/dashboard/dashboard-reads.test.ts`
  - Expected: PASS — `toOutstandingInvoiceInputs` mapping green. Also run `pnpm typecheck` to confirm the barrel imports (`Invoice`, `BenefitUsage`, `RenewalCycle`, `makeComputeBenefitUsageDeps`) resolve.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/_components/dashboard-reads.ts" "src/app/(member)/portal/_components/membership-stat-section.tsx" "src/app/(member)/portal/_components/outstanding-stat-section.tsx" "src/app/(member)/portal/_components/benefits-stat-section.tsx" tests/unit/portal/dashboard/dashboard-reads.test.ts`
  - `feat(portal): cached dashboard reads + 3 stat sections (membership/outstanding/benefits)`

---

### Task 44: Quick-actions + recent-activity sections
**Files:**
- Create `src/app/(member)/portal/_components/quick-actions.tsx`
- Create `src/app/(member)/portal/_components/recent-activity-section.tsx`
- Test `tests/unit/portal/dashboard/quick-actions.test.tsx`

`QuickActions` is a transactional 2×2 grid (Pay primary · Benefits · Renew-conditional · Edit) — the Renew tile only renders when `isRenewDue` is true (spec §4.1 "hide/disable when not due"). `RecentActivitySection` reuses the SAME member-permission `timelineList` read as `/portal/timeline` (member role redacts internal annotations), takes the first 3–4 events, and shows a friendly empty CTA for first-run members.

- [ ] **Step 1: Write the failing test** — full test code block

```tsx
// tests/unit/portal/dashboard/quick-actions.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QuickActions } from '@/app/(member)/portal/_components/quick-actions';

const messages = {
  portal: {
    dashboard: {
      quickActions: {
        heading: 'Quick actions',
        pay: 'Pay invoice',
        benefits: 'View benefits',
        renew: 'Renew membership',
        editProfile: 'Edit profile',
      },
    },
  },
};

function renderActions(props: React.ComponentProps<typeof QuickActions>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Bangkok">
      <QuickActions {...props} />
    </NextIntlClientProvider>,
  );
}

describe('QuickActions', () => {
  it('renders Pay / Benefits / Edit always, and Renew only when due', () => {
    renderActions({ memberId: 'm1', renewDue: true });
    expect(screen.getByRole('link', { name: 'Pay invoice' })).toHaveAttribute(
      'href',
      '/portal/invoices',
    );
    expect(screen.getByRole('link', { name: 'View benefits' })).toHaveAttribute(
      'href',
      '/portal/benefits',
    );
    expect(screen.getByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/portal/edit',
    );
    expect(screen.getByRole('link', { name: 'Renew membership' })).toHaveAttribute(
      'href',
      '/portal/renewal/m1',
    );
  });

  it('hides the Renew tile when renewal is not due', () => {
    renderActions({ memberId: 'm1', renewDue: false });
    expect(screen.queryByRole('link', { name: 'Renew membership' })).not.toBeInTheDocument();
  });

  it('exposes an accessible group label via the section heading', () => {
    renderActions({ memberId: 'm1', renewDue: false });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Quick actions' }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/unit/portal/dashboard/quick-actions.test.tsx`
  - Expected: FAIL — `Cannot find module '@/app/(member)/portal/_components/quick-actions'`.

- [ ] **Step 3: Implement** — full code blocks

```tsx
// src/app/(member)/portal/_components/quick-actions.tsx
import Link from 'next/link';
import { CreditCard, Gift, RefreshCw, UserPen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface QuickActionsProps {
  readonly memberId: string;
  /** Renew tile renders only when true (same threshold as the Membership card). */
  readonly renewDue: boolean;
}

/**
 * 057 portal redesign §4.1 — transactional quick actions. 2×2 grid on mobile,
 * 4-up on desktop. The Renew tile is conditional (hidden when not due).
 */
export function QuickActions({ memberId, renewDue }: QuickActionsProps): React.ReactElement {
  const t = useTranslations('portal.dashboard.quickActions');

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <h2 className="text-caption font-medium text-muted-foreground">{t('heading')}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Link
            href="/portal/invoices"
            className={cn(buttonVariants({ variant: 'default' }), 'min-h-11 justify-start gap-2')}
          >
            <CreditCard className="size-4" aria-hidden="true" />
            {t('pay')}
          </Link>
          <Link
            href="/portal/benefits"
            className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 justify-start gap-2')}
          >
            <Gift className="size-4" aria-hidden="true" />
            {t('benefits')}
          </Link>
          {renewDue ? (
            <Link
              href={`/portal/renewal/${memberId}`}
              className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 justify-start gap-2')}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t('renew')}
            </Link>
          ) : null}
          <Link
            href="/portal/edit"
            className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11 justify-start gap-2')}
          >
            <UserPen className="size-4" aria-hidden="true" />
            {t('editProfile')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

```tsx
// src/app/(member)/portal/_components/recent-activity-section.tsx
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { toTimelineItemProps } from '@/lib/timeline-presenter';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TimelineEventItem } from '@/components/members/timeline-event-item';

const PREVIEW_LIMIT = 4;

export async function RecentActivitySection({
  userId,
  memberId,
}: {
  readonly userId: string;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('portal.dashboard.activity');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);
  const deps = buildMembersDeps(tenant);

  // SAME member-permission filter as /portal/timeline: scoped by this member +
  // actorRole 'member' so internal/admin-only annotations are redacted (FR-017,
  // spec §4.1 review S-2). Never the URL — memberId comes from the session.
  const result = await timelineList(
    { memberId, limit: PREVIEW_LIMIT },
    { actorUserId: userId, actorRole: 'member', requestId },
    tenant,
    { memberRepo: deps.memberRepo, timeline: deps.timeline },
  );
  const events = result.ok ? result.value.events.slice(0, PREVIEW_LIMIT).map(toTimelineItemProps) : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium leading-snug">{t('heading')}</h2>
        {events.length > 0 ? (
          <Link
            href="/portal/timeline"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-11 px-3')}
          >
            {t('viewAll')}
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
            <Link
              href="/portal/benefits"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-11 px-3')}
            >
              {t('emptyCta')}
            </Link>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {events.map((ev) => (
              <TimelineEventItem key={ev.id} {...ev} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export function RecentActivitySkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
```

  - Note: confirm `TimelineEventItem` accepts a spread `TimelineItemProps` (it does — `toTimelineItemProps` produces exactly its props; the same item is used in `TimelineStream`). If `TimelineEventItem` is not directly importable as a standalone item, render the events via `TimelineStream` with `initialEvents={events}` + `fetchPath="/api/portal/timeline"` instead — verify the import path during implementation and adjust to whichever the timeline module exposes.

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/unit/portal/dashboard/quick-actions.test.tsx`
  - Expected: PASS — Pay/Benefits/Edit always present; Renew gated on `renewDue`. Also run `pnpm typecheck`.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/_components/quick-actions.tsx" "src/app/(member)/portal/_components/recent-activity-section.tsx" tests/unit/portal/dashboard/quick-actions.test.tsx`
  - `feat(portal): dashboard quick-actions + member-filtered recent-activity preview`

---

### Task 45: Rebuild the dashboard page + cross-tenant integration test
**Files:**
- Modify `src/app/(member)/portal/page.tsx` (full rewrite of lines 1–95)
- Create `tests/integration/portal/dashboard-cross-tenant.test.ts`

Rebuild `/portal` as the at-a-glance hub: PageHeader (welcome + member# chip + plan/status chips, **versionBadge REMOVED**) → 3 stat sections (each in its own Suspense boundary) → quick actions → 2-col (`InvoicesSummaryCard` | benefits quota `BenefitUsageCard` compact with a **portal** `previewHref`) → recent activity. A not-linked / first-run member gets the localised `firstRun` empty card instead of zeroes. The integration test (live Neon, Principle I Review-Gate blocker) proves member A's reads never surface member B's renewal/benefit/invoice data.

- [ ] **Step 1: Write the failing test** — full test code block

```ts
// tests/integration/portal/dashboard-cross-tenant.test.ts
/**
 * 057 portal redesign §4.1 — Dashboard cross-tenant isolation (live Neon).
 *
 * Principle I Review-Gate blocker: every member-facing read backing the
 * Dashboard (renewal status, outstanding invoices, benefit usage) must be
 * tenant-scoped. We seed a member + cycle in tenant A and assert tenant B's
 * deps — querying the SAME memberId — see NOTHING. The dashboard resolves the
 * member from the session, so a leak here would surface another tenant's data
 * on the landing page.
 *
 * All seed data is SIMULATED (random UUIDs + fake company names) — never real
 * SweCham PII.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadMemberRenewalStatus, makeRenewalsDeps } from '@/modules/renewals';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const DAY_MS = 86_400_000;

describe('057 dashboard reads — cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `dash-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co ${memberId.slice(0, 4)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      }),
    );

    const now = Date.now();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(now - 30 * DAY_MS),
        periodTo: new Date(now + 20 * DAY_MS),
        expiresAt: new Date(now + 20 * DAY_MS),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(now - 5 * DAY_MS),
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('tenant A sees its own renewal cycle', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle?.cycleId).toBe(cycleId);
  });

  it('tenant B cannot see tenant A renewal cycle for the same memberId', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle).toBeNull();
  });

  it('tenant B cannot see tenant A invoices for the same memberId', async () => {
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** — `pnpm vitest run tests/integration/portal/dashboard-cross-tenant.test.ts --config vitest.integration.config.ts`
  - Expected: FAIL initially only if the `tests/integration/portal/` dir / helpers path is new — confirm the relative `../helpers/test-tenant` + `../helpers/seed-member-number` resolve from `tests/integration/portal/` (the renewals integration test imports them from `../helpers/`; from a `portal/` subdir the path is identical depth). If the suite errors on import resolution, that is the expected RED. Once helpers resolve, this test should actually PASS against current isolation — it is a regression guard that the new read surfaces stay scoped; keep it because the page rewrite in Step 3 wires these exact reads.

- [ ] **Step 3: Implement** — full page rewrite

```tsx
// src/app/(member)/portal/page.tsx
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { PackageOpen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { formatMemberNumber, resolveMemberNumberPrefix } from '@/modules/members';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  type BenefitUsageItem,
} from '@/modules/insights';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';
import Link from 'next/link';
import { InvoicesSummaryCard } from './invoices/_components/invoices-summary-card';
import { StatSkeleton, MembershipStatSection } from './_components/membership-stat-section';
import { OutstandingStatSection } from './_components/outstanding-stat-section';
import { BenefitsStatSection } from './_components/benefits-stat-section';
import { QuickActions } from './_components/quick-actions';
import {
  RecentActivitySection,
  RecentActivitySkeleton,
} from './_components/recent-activity-section';
import { isRenewDue, deriveBenefitsStat } from './_lib/dashboard-stats';
import { loadDashboardRenewalCycle, resolveDashboardMemberId } from './_components/dashboard-reads';

const PORTAL_BENEFITS_HREF = '/portal/benefits';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.memberPortal');
  return { title: t('title') };
}

export default async function MemberPortalHomePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.dashboard');
  const locale = await getLocale();

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);
  const memberRes = await deps.memberRepo.findByLinkedUserId(tenant, user.id);

  // First-run / not-linked member: friendly, localised, actionable empty hub
  // (spec §4.1 MANDATORY) — never zeroes + blank lists. ~131 launch invitees
  // all land here first.
  if (!memberRes.ok) {
    return (
      <DetailContainer>
        <PageHeader
          title={t('welcome', { name: user.displayName ?? user.email })}
          subtitle={t('intro')}
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <PackageOpen aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="text-lg font-semibold">
              {t('firstRun.title', {
                tenant: process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham',
              })}
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">{t('firstRun.body')}</p>
            <Link
              href={PORTAL_BENEFITS_HREF}
              className={cn(buttonVariants({ variant: 'default' }), 'min-h-11')}
            >
              {t('firstRun.exploreBenefits')}
            </Link>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  const member = memberRes.value;
  const memberId = member.memberId;
  // Resolve the member number for the header chip (RLS-safe prefix resolver).
  const memberNumberLabel = formatMemberNumber(
    await resolveMemberNumberPrefix(tenant, deps.memberSettings),
    member.memberNumber,
  );

  // Renew-CTA gating reuses the cached cycle read (no extra round-trip).
  const cycle = await loadDashboardRenewalCycle(memberId);
  const renewDue = isRenewDue(cycle, new Date());

  // Benefits quota panel (compact card) — reuse computeBenefitUsage once; if it
  // misses, the panel simply omits (the stat card already placeholders it).
  const benefitRes = await computeBenefitUsage(
    tenant,
    { memberId },
    makeComputeBenefitUsageDeps(tenant.slug),
  );
  const usage = benefitRes.ok ? benefitRes.value : null;
  const quantifiable: BenefitUsageItem[] = usage
    ? usage.quantifiable.map((b) => ({ ...b }))
    : [];

  const statusChipKey =
    member.status === 'archived'
      ? 'archived'
      : member.status === 'active'
        ? 'active'
        : 'inactive';

  return (
    <DetailContainer>
      <PageHeader
        title={t('welcome', { name: user.displayName ?? user.email })}
        subtitle={t('intro')}
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono">
              {memberNumberLabel}
            </Badge>
            <Badge variant="secondary">{t(`statusChip.${statusChipKey}`)}</Badge>
          </span>
        }
      />

      {/* 3 stat cards — 1 col mobile, 3-up desktop. Each in its own Suspense
          boundary so a slow read never blocks the others. */}
      <div className="grid grid-cols-1 gap-[var(--page-section-gap)] sm:grid-cols-3">
        <Suspense fallback={<StatSkeleton />}>
          <MembershipStatSection memberId={memberId} />
        </Suspense>
        <Suspense fallback={<StatSkeleton />}>
          <OutstandingStatSection memberId={memberId} />
        </Suspense>
        <Suspense fallback={<StatSkeleton />}>
          <BenefitsStatSection memberId={memberId} />
        </Suspense>
      </div>

      <QuickActions memberId={memberId} renewDue={renewDue} />

      {/* 2-col: latest invoices | benefits quota. Stacks to 1-col on mobile. */}
      <div className="grid grid-cols-1 gap-[var(--page-section-gap)] lg:grid-cols-2">
        <InvoicesSummaryCard user={user} />
        {usage !== null && deriveBenefitsStat(usage).kind !== 'empty' ? (
          <BenefitUsageCard
            locale={locale}
            membershipYear={usage.membershipYear}
            elapsedYearPct={usage.elapsedYearPct}
            quantifiable={quantifiable}
            active={usage.active}
            aggregateConsumedPct={usage.aggregateConsumedPct}
            underUseWarning={usage.underUseWarning}
            compact
            previewHref={PORTAL_BENEFITS_HREF}
            headingId="dashboard-benefits-panel"
          />
        ) : null}
      </div>

      <Suspense fallback={<RecentActivitySkeleton />}>
        <RecentActivitySection userId={user.id} memberId={memberId} />
      </Suspense>
    </DetailContainer>
  );
}
```

  - Note: confirm `member.status` enum values during implementation (the F3 `MemberEntity` status — likely `active` / `inactive` / `archived`); adjust the `statusChipKey` branch + the matching i18n keys if the enum differs. `member.memberNumber` is already a branded `MemberNumber` (per the original page), so it passes straight into `formatMemberNumber`.

- [ ] **Step 4: Run test (expect PASS)** — `pnpm vitest run tests/integration/portal/dashboard-cross-tenant.test.ts --config vitest.integration.config.ts`
  - Expected: PASS — tenant A sees its cycle; tenant B sees null cycle + 0 invoices. Then run `pnpm typecheck` (via a temp tsconfig excluding `.next` while the dev server is up — per the masked-typecheck gotcha) and `pnpm lint` to confirm the page + new components compile and respect the module-barrel ESLint rule.

- [ ] **Step 5: Commit** — `git add "src/app/(member)/portal/page.tsx" tests/integration/portal/dashboard-cross-tenant.test.ts`
  - `feat(portal): rebuild /portal as at-a-glance hub + cross-tenant dashboard isolation test`

---

# G4 — Profile page (`/portal/profile` member-facing redesign)

### Task 60: Add `portal.profile.*` i18n keys for the redesigned profile page (EN/TH/SV)

**Files:**
- Modify: `src/i18n/messages/en.json` (under the existing `portal.profile` object)
- Modify: `src/i18n/messages/th.json` (under the existing `portal.profile` object)
- Modify: `src/i18n/messages/sv.json` (under the existing `portal.profile` object)
- Test: `pnpm check:i18n` (parity gate — no per-key vitest file; the build gate is the test)

The current `portal.profile` block lacks: real section-heading keys for an **Organisation** + **Membership** split (today it has `companySection`/`planSection`), a **member status badge** in the header (`statusBadge.*`), and the Organisation/Membership field labels (`taxId`, `foundedYear`, `turnoverThb`, `lastActivityAt`, `address`). The directory section reuses the existing `directorySettings.*` namespace (already present — verified) so it gets NO new keys.

- [ ] **Step 1: Write the failing test** — run the i18n parity gate as the failing check (it fails because EN has keys TH/SV lack once we add EN first; here we add all three so the gate passes — the "red" is the pre-edit assertion that the keys are absent):

```bash
# RED probe — confirm the new keys do NOT yet exist (expect: prints `undefined`)
node -e "const en=require('./src/i18n/messages/en.json'); console.log(en.portal.profile.organisationSection, en.portal.profile.statusBadge?.active, en.portal.profile.fields.taxId)"
```
Expected output (RED): `undefined undefined undefined`

- [ ] **Step 2: Run test (expect FAIL)** — the probe above prints three `undefined` values, confirming the keys are missing. (No vitest here; `pnpm check:i18n` is the green gate in Step 4.)

- [ ] **Step 3: Implement** — In `src/i18n/messages/en.json`, replace the existing `portal.profile` object with the version below (keeps every current key the live page still uses during refactor, adds the new ones):

```json
"profile": {
  "title": "My profile",
  "pageTitle": "My Profile",
  "notLinked": "Your account is not linked to a member. Please contact your administrator.",
  "loadError": "Could not load your profile. Please try again.",
  "editButton": "Edit Profile",
  "organisationSection": "Organisation",
  "membershipSection": "Membership",
  "contactsSection": "Contacts",
  "inviteColleague": "Invite Colleague",
  "primaryBadge": "Primary",
  "portalLinked": "Portal linked",
  "noContacts": "No contacts found.",
  "statusBadge": {
    "active": "Active",
    "inactive": "Inactive",
    "archived": "Archived"
  },
  "fields": {
    "memberId": "Member ID",
    "memberIdHelp": "Reference this ID when contacting chamber support.",
    "memberIdCopy": "Copy member ID",
    "memberIdCopied": "Member ID copied",
    "memberNumber": "Member Number",
    "memberNumberCopy": "Copy member number",
    "companyName": "Company Name",
    "legalEntityType": "Legal Entity Type",
    "country": "Country",
    "website": "Website",
    "description": "Description",
    "taxId": "Tax ID",
    "foundedYear": "Founded",
    "turnoverThb": "Annual turnover",
    "address": "Address",
    "planName": "Plan Name",
    "planYear": "Plan Year",
    "registrationDate": "Registration Date",
    "lastActivityAt": "Last activity",
    "status": "Status"
  }
}
```

In `src/i18n/messages/th.json`, set the `portal.profile` object to:

```json
"profile": {
  "title": "โปรไฟล์ของฉัน",
  "pageTitle": "โปรไฟล์ของฉัน",
  "notLinked": "บัญชีของคุณยังไม่ได้เชื่อมโยงกับสมาชิก กรุณาติดต่อผู้ดูแลระบบ",
  "loadError": "ไม่สามารถโหลดโปรไฟล์ได้ กรุณาลองใหม่อีกครั้ง",
  "editButton": "แก้ไขโปรไฟล์",
  "organisationSection": "องค์กร",
  "membershipSection": "การเป็นสมาชิก",
  "contactsSection": "ผู้ติดต่อ",
  "inviteColleague": "เชิญเพื่อนร่วมงาน",
  "primaryBadge": "หลัก",
  "portalLinked": "เชื่อมโยงพอร์ทัลแล้ว",
  "noContacts": "ไม่พบผู้ติดต่อ",
  "statusBadge": {
    "active": "ใช้งานอยู่",
    "inactive": "ไม่ได้ใช้งาน",
    "archived": "เก็บถาวร"
  },
  "fields": {
    "memberId": "รหัสสมาชิก",
    "memberIdHelp": "อ้างอิงรหัสนี้เมื่อติดต่อฝ่ายสนับสนุนของหอการค้า",
    "memberIdCopy": "คัดลอกรหัสสมาชิก",
    "memberIdCopied": "คัดลอกรหัสสมาชิกแล้ว",
    "memberNumber": "หมายเลขสมาชิก",
    "memberNumberCopy": "คัดลอกหมายเลขสมาชิก",
    "companyName": "ชื่อบริษัท",
    "legalEntityType": "ประเภทนิติบุคคล",
    "country": "ประเทศ",
    "website": "เว็บไซต์",
    "description": "คำอธิบาย",
    "taxId": "เลขประจำตัวผู้เสียภาษี",
    "foundedYear": "ก่อตั้งเมื่อ",
    "turnoverThb": "รายได้ต่อปี",
    "address": "ที่อยู่",
    "planName": "ชื่อแพ็กเกจ",
    "planYear": "ปีของแพ็กเกจ",
    "registrationDate": "วันที่ลงทะเบียน",
    "lastActivityAt": "กิจกรรมล่าสุด",
    "status": "สถานะ"
  }
}
```

In `src/i18n/messages/sv.json`, set the `portal.profile` object to:

```json
"profile": {
  "title": "Min profil",
  "pageTitle": "Min profil",
  "notLinked": "Ditt konto är inte kopplat till en medlem. Kontakta din administratör.",
  "loadError": "Det gick inte att läsa in din profil. Försök igen.",
  "editButton": "Redigera profil",
  "organisationSection": "Organisation",
  "membershipSection": "Medlemskap",
  "contactsSection": "Kontakter",
  "inviteColleague": "Bjud in kollega",
  "primaryBadge": "Primär",
  "portalLinked": "Portal kopplad",
  "noContacts": "Inga kontakter hittades.",
  "statusBadge": {
    "active": "Aktiv",
    "inactive": "Inaktiv",
    "archived": "Arkiverad"
  },
  "fields": {
    "memberId": "Medlems-ID",
    "memberIdHelp": "Ange detta ID när du kontaktar handelskammarens support.",
    "memberIdCopy": "Kopiera medlems-ID",
    "memberIdCopied": "Medlems-ID kopierat",
    "memberNumber": "Medlemsnummer",
    "memberNumberCopy": "Kopiera medlemsnummer",
    "companyName": "Företagsnamn",
    "legalEntityType": "Juridisk form",
    "country": "Land",
    "website": "Webbplats",
    "description": "Beskrivning",
    "taxId": "Skatte-ID",
    "foundedYear": "Grundat",
    "turnoverThb": "Årsomsättning",
    "address": "Adress",
    "planName": "Plannamn",
    "planYear": "Planår",
    "registrationDate": "Registreringsdatum",
    "lastActivityAt": "Senaste aktivitet",
    "status": "Status"
  }
}
```

- [ ] **Step 4: Run test (expect PASS)** —

```bash
pnpm check:i18n
```
Expected: exit 0, **0 missing keys** across EN/TH/SV. (The Step-1 probe now prints `Organisation Active Tax ID`.)

- [ ] **Step 5: Commit** —

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(portal): add portal.profile.* i18n keys for profile redesign (EN/TH/SV)"
```

---

### Task 61: Refactor `/portal/profile` to the member-facing member-detail (DetailField + real `<h2>` sections + localised dates)

**Files:**
- Modify: `src/app/(member)/portal/profile/page.tsx` (full rewrite of the default export; lines 1–342 — the whole file)
- Test: `tests/unit/app/portal/profile/portal-profile-body.test.tsx` (Task 62 authors the test; this task makes it pass by exporting a testable `PortalProfileBody`)

The current file (read in full) uses inline `<dt>/<dd>` rows and `CardTitle` for section headings — the exact h1→h(div) pattern the spec §4.2 forbids. This task: (1) extracts the data-fetching + JSX into an exported `PortalProfileBody({ user })` async function (so the unit test can invoke it without a real session), keeping the default export as a thin session wrapper; (2) replaces every `<dt>/<dd>` with `DetailField`; (3) renders section titles via a local `SectionHeading` (real `<h2>`, mirroring the admin page's helper) wrapped in `<section aria-labelledby>`; (4) splits the single Company card into **Organisation** + **Membership** cards; (5) routes the registration date through `formatLocalisedDate` (BE display-only for `th`); (6) keeps the Contacts card + the F9 directory section unchanged in behaviour but moves their headings to real `<h2>`.

- [ ] **Step 1: Write the failing test** — Task 62 owns the full test. The minimal red signal for THIS task is that `PortalProfileBody` is not yet exported:

```bash
# RED probe — confirm the testable body export does not yet exist (expect: not found)
node -e "import('./src/app/(member)/portal/profile/page.tsx').then(m=>console.log(typeof m.PortalProfileBody)).catch(e=>console.log('IMPORT-ERR'))"
```
Expected (RED): `IMPORT-ERR` or `undefined` (the module is a `.tsx` RSC; the probe just documents the missing export — Task 62's vitest is the authoritative red).

- [ ] **Step 2: Run test (expect FAIL)** — run Task 62's suite (it must exist first if running tasks in number order; if running 61 before 62, this step is the probe above). Once Task 62's file exists:

```bash
pnpm vitest run tests/unit/app/portal/profile/portal-profile-body.test.tsx
```
Expected: FAIL — `PortalProfileBody is not a function` / section titles still render as `CardTitle` divs.

- [ ] **Step 3: Implement** — Replace the entire contents of `src/app/(member)/portal/profile/page.tsx` with:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { BookUserIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { DetailField } from '@/components/members/detail-field';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  getMember,
  formatMemberNumber,
  resolveMemberNumberPrefix,
} from '@/modules/members';
import { env } from '@/lib/env';

/**
 * 057 — member-facing member-detail (design §4.2, Option C structure WITHOUT
 * admin actions / renewal-triage). Header (company + SCCM-NNNN + status) →
 * Organisation card → Membership card → Contacts card → Directory listing.
 *
 * Refactor of the old inline `<dt>/<dd>` page (review S-3): all rows now use
 * the shared `DetailField`; section titles are real `<h2>` (review a11y-6 —
 * NEVER CardTitle, which renders a div and reproduced the admin h1→h3 skip).
 * Dates render via `formatLocalisedDate` (BE display-only for th-TH; storage
 * stays Gregorian ISO).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.profile');
  return { title: t('pageTitle') };
}

/**
 * 057 fix — section heading as a real `<h2>` (not a CardTitle `<div>`) so every
 * content group is reachable via SR heading navigation under the page `<h1>`.
 * Mirrors the admin detail page's SectionHeading; carries CardTitle font
 * classes so the visual is unchanged. The `id` is wired to the wrapping
 * `<section aria-labelledby>`.
 */
function SectionHeading({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <h2
      id={id}
      className="font-heading text-base font-medium leading-snug"
    >
      {children}
    </h2>
  );
}

/**
 * Testable RSC body — accepts the already-resolved session user so a unit
 * test can invoke it directly (no live session). The default export below is
 * a thin wrapper that resolves the member session and delegates here.
 */
export async function PortalProfileBody({
  user,
}: {
  user: { id: string };
}) {
  const t = await getTranslations('portal.profile');
  const tDir = await getTranslations('directorySettings');
  const locale = await getLocale();

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // memberId is ALWAYS resolved from the session user via findByLinkedUserId —
  // NEVER from a URL param (review M-2: cross-tenant safety. The repo wraps the
  // query in runInTenant so RLS scopes it to the caller's tenant).
  const memberResult = await deps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('notLinked')}</p>
        </div>
      </DetailContainer>
    );
  }

  const member = memberResult.value;
  const result = await getMember(
    member.memberId,
    { actorUserId: user.id, requestId: 'portal-profile' },
    {
      tenant,
      memberRepo: deps.memberRepo,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
    },
  );

  if (!result.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('loadError')}</p>
        </div>
      </DetailContainer>
    );
  }

  const { member: m, contacts } = result.value;
  const activeContacts = contacts.filter((c) => !c.removedAt);
  const ownContact = activeContacts.find(
    (c) => String(c.linkedUserId) === user.id,
  );
  const isPrimary = ownContact?.isPrimary === true;

  // Both reads are independent (plan lookup vs. member-settings row) — collapse
  // to ~1 RTT. Mirrors the Promise.all on the admin detail page.
  const [planLookup, memberPrefix] = await Promise.all([
    deps.plans.getPlan(tenant, m.planId, m.planYear),
    resolveMemberNumberPrefix(tenant, deps.memberSettings),
  ]);
  const planDisplayName = planLookup.ok ? planLookup.value.planNameEn : m.planId;

  // `m.memberNumber` is already a branded MemberNumber (validated by
  // rowToMember) — no re-wrap needed.
  const memberNumberFormatted = formatMemberNumber(memberPrefix, m.memberNumber);

  return (
    <DetailContainer>
      <PageHeader
        title={m.companyName}
        subtitle={t('pageTitle')}
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={m.status === 'active' ? 'default' : 'secondary'}
            >
              {t(`statusBadge.${m.status}`)}
            </Badge>
            <Badge variant="outline" className="font-mono">
              {memberNumberFormatted}
            </Badge>
          </div>
        }
        actions={
          <Link href="/portal/edit" className={buttonVariants()}>
            <PencilIcon className="size-4" aria-hidden />
            {t('editButton')}
          </Link>
        }
      />

      {/* Organisation — who the member is. */}
      <section aria-labelledby="portal-profile-org-heading">
        <Card>
          <CardHeader>
            <SectionHeading id="portal-profile-org-heading">
              {t('organisationSection')}
            </SectionHeading>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.memberNumber')}
                value={memberNumberFormatted}
                mono
                extra={
                  <CopyButton
                    value={memberNumberFormatted}
                    label={t('fields.memberNumberCopy')}
                  />
                }
              />
              <DetailField
                label={t('fields.companyName')}
                value={m.companyName}
              />
              <DetailField
                label={t('fields.legalEntityType')}
                value={m.legalEntityType}
              />
              <DetailField
                label={t('fields.country')}
                value={null}
                extra={<CountryDisplay code={m.country} />}
              />
              <DetailField
                label={t('fields.website')}
                value={null}
                {...(m.website
                  ? {
                      extra: (
                        <a
                          href={m.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <span className="truncate">{m.website}</span>
                        </a>
                      ),
                    }
                  : {})}
              />
              <DetailField
                label={t('fields.foundedYear')}
                value={m.foundedYear}
              />
              {m.description ? (
                <div className="sm:col-span-2 lg:col-span-3">
                  <DetailField
                    label={t('fields.description')}
                    value={m.description}
                  />
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Membership — the chamber relationship. */}
      <section aria-labelledby="portal-profile-membership-heading">
        <Card>
          <CardHeader>
            <SectionHeading id="portal-profile-membership-heading">
              {t('membershipSection')}
            </SectionHeading>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.planName')}
                value={planDisplayName}
              />
              <DetailField
                label={t('fields.planYear')}
                value={m.planYear}
              />
              <DetailField
                label={t('fields.registrationDate')}
                value={formatLocalisedDate(
                  m.registrationDate.toISOString(),
                  locale,
                  { dateStyle: 'medium' },
                )}
              />
              <DetailField
                label={t('fields.lastActivityAt')}
                value={
                  m.lastActivityAt
                    ? formatLocalisedDate(
                        m.lastActivityAt.toISOString(),
                        locale,
                        { dateStyle: 'medium', timeStyle: 'short' },
                      )
                    : null
                }
              />
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Contacts — primary + others. */}
      <section aria-labelledby="portal-profile-contacts-heading">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <SectionHeading id="portal-profile-contacts-heading">
              {t('contactsSection')}
            </SectionHeading>
            {isPrimary && (
              <Link
                href="/portal/contacts/invite"
                className={buttonVariants({ variant: 'outline' })}
              >
                <UserPlusIcon className="size-4" aria-hidden />
                {t('inviteColleague')}
              </Link>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {activeContacts.map((contact, i) => (
                <div key={contact.contactId} className="flex flex-col gap-4">
                  {i > 0 ? <Separator /> : null}
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-body font-medium">
                          {`${contact.firstName} ${contact.lastName}`.trim()}
                        </p>
                        {contact.isPrimary && (
                          <Badge variant="secondary">
                            {t('primaryBadge')}
                          </Badge>
                        )}
                        {contact.linkedUserId && (
                          <Badge variant="outline">{t('portalLinked')}</Badge>
                        )}
                      </div>
                      <dl className="mt-1 grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
                        <DetailField
                          label={t('fields.companyName')}
                          value={null}
                          extra={
                            <span className="text-sm">{contact.email}</span>
                          }
                        />
                        {contact.roleTitle ? (
                          <DetailField
                            label={t('fields.legalEntityType')}
                            value={contact.roleTitle}
                          />
                        ) : null}
                      </dl>
                    </div>
                  </div>
                </div>
              ))}
              {activeContacts.length === 0 && (
                <p className="text-body text-muted-foreground">
                  {t('noContacts')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* F9 directory listing self-service — gated on the F9 flag so it stays
          hidden until the feature flips on; the target page notFounds when
          dark. Heading is a real <h2> per a11y-6. */}
      {env.features.f9Dashboard ? (
        <section aria-labelledby="portal-profile-directory-heading">
          <Card>
            <CardHeader>
              <SectionHeading id="portal-profile-directory-heading">
                {tDir('title')}
              </SectionHeading>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-body text-muted-foreground">
                {tDir('subtitle')}
              </p>
              <Link
                href="/portal/profile/directory"
                className={buttonVariants({ variant: 'outline' })}
              >
                <BookUserIcon className="size-4" aria-hidden />
                {tDir('manage')}
              </Link>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </DetailContainer>
  );
}

export default async function PortalProfilePage() {
  const { user } = await requireSession('member');
  return <PortalProfileBody user={{ id: user.id }} />;
}
```

NOTE on field reuse: the contact `email`/`roleTitle` rows above intentionally reuse `fields.companyName`/`fields.legalEntityType` labels only as DetailField label placeholders is WRONG — replace those two contact-row `label` props with dedicated keys. To keep this task self-contained without adding more keys, render the contact email as a muted `<p>` instead of a DetailField:

Replace the contact `<dl>…</dl>` block (the `mt-1 grid` block) with:

```tsx
                      <p className="text-caption text-muted-foreground">
                        {contact.email}
                      </p>
                      {contact.roleTitle ? (
                        <p className="text-caption text-muted-foreground">
                          {contact.roleTitle}
                        </p>
                      ) : null}
```

- [ ] **Step 4: Run test (expect PASS)** —

```bash
pnpm vitest run tests/unit/app/portal/profile/portal-profile-body.test.tsx
```
Expected: PASS — `PortalProfileBody` is exported and returns a tree whose section titles are `h2` elements (no `CardTitle`), with DetailField rows and a BE-aware date string.

- [ ] **Step 5: Commit** —

```bash
git add "src/app/(member)/portal/profile/page.tsx"
git commit -m "feat(portal): rebuild profile as member-facing detail (DetailField + real h2 + localised dates)"
```

---

### Task 62: Unit-test the profile body — heading order, DetailField usage, BE date, status badge, cross-tenant note

**Files:**
- Create: `tests/unit/app/portal/profile/portal-profile-body.test.tsx`
- Modify: `src/app/(member)/portal/profile/page.tsx` (only if a finding requires it — none expected if Task 61 landed correctly)

This test invokes the exported `PortalProfileBody` RSC body directly with a mocked tenant, deps, member, and `getMember` result, then inspects the returned React element tree (the codebase's established pattern — see `tests/unit/members/presentation/members-page-sort-wiring.test.tsx`, which JSON-stringifies the tree). It asserts: (1) no section title is a `CardTitle` and every section heading is an `h2` (h1→h2, no skip — the h1 lives in `PageHeader`, not this tree's section titles); (2) `DetailField` is used (label keys present); (3) the registration date is rendered through `formatLocalisedDate` with BE for `th` (asserts the BE year 2569 for a 2026 date); (4) the status badge label key resolves; (5) **cross-tenant note** — `findByLinkedUserId` is called with the session user id (never a URL param), proving memberId is session-derived.

- [ ] **Step 1: Write the failing test** —

```tsx
/**
 * 057 G4 — PortalProfileBody RSC unit test.
 *
 * Invokes the async RSC body directly (no live session) with mocked deps and
 * inspects the returned element tree. Pattern mirrors
 * members-page-sort-wiring.test.tsx (JSON-stringify the tree + walk children).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// --- Boundary mocks ---------------------------------------------------------

const findByLinkedUserIdMock = vi.fn();
const getMemberMock = vi.fn();
const getPlanMock = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: (...args: unknown[]) =>
        findByLinkedUserIdMock(...args),
    },
    contactRepo: {},
    audit: {},
    memberSettings: {},
    plans: { getPlan: (...args: unknown[]) => getPlanMock(...args) },
  }),
}));

vi.mock('@/modules/members', () => ({
  getMember: (...args: unknown[]) => getMemberMock(...args),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: false } },
}));

// next-intl server: identity translator (returns the key) + fixed locale.
const localeRef = { current: 'en' };
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
  getLocale: vi.fn().mockImplementation(async () => localeRef.current),
}));

// next-intl client hook used by CountryDisplay (rendered to markup below).
vi.mock('next-intl', () => ({
  useLocale: () => localeRef.current,
}));

const now = new Date('2026-04-16T10:00:00Z');

const member = {
  memberId: 'mem-a',
  companyName: 'Alpha Corp',
  legalEntityType: 'limited',
  country: 'TH',
  website: null,
  description: null,
  foundedYear: 2010,
  memberNumber: 42,
  planId: 'corporate',
  planYear: 2026,
  registrationDate: now,
  lastActivityAt: null,
  status: 'active' as const,
};

const ownContact = {
  contactId: 'con-a',
  firstName: 'Test',
  lastName: 'User',
  email: 'member@a.example',
  phone: null,
  roleTitle: null,
  isPrimary: true,
  linkedUserId: 'user-a',
  removedAt: null,
};

import { PortalProfileBody } from '@/app/(member)/portal/profile/page';

beforeEach(() => {
  vi.clearAllMocks();
  localeRef.current = 'en';
  findByLinkedUserIdMock.mockResolvedValue({ ok: true, value: member });
  getMemberMock.mockResolvedValue({
    ok: true,
    value: { member, contacts: [ownContact] },
  });
  getPlanMock.mockResolvedValue({
    ok: true,
    value: { planNameEn: 'Corporate' },
  });
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
});

/** Walk the element tree collecting every node's `type` + flattened text. */
function collectByType(node: unknown, type: string, acc: ReactElement[]) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const c of node) collectByType(c, type, acc);
    return acc;
  }
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === type) acc.push(el);
  if (el.props && 'children' in el.props) {
    collectByType(el.props.children, type, acc);
  }
  return acc;
}

describe('PortalProfileBody — heading order + DetailField + dates (057 G4)', () => {
  it('renders section titles as real <h2>, never CardTitle (a11y-6)', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // Three section <h2>s: Organisation, Membership, Contacts (F9 dir off).
    const h2Count = (html.match(/<h2/g) ?? []).length;
    expect(h2Count).toBe(3);
    // The section-title keys render inside <h2>, proving they are NOT divs.
    expect(html).toContain('organisationSection');
    expect(html).toContain('membershipSection');
    expect(html).toContain('contactsSection');
    // No <h3> in this tree — no h2→h(skip) and no admin h1→h3 pattern.
    expect(html).not.toContain('<h3');
  });

  it('uses DetailField label keys for organisation rows', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('fields.memberNumber');
    expect(html).toContain('fields.companyName');
    expect(html).toContain('fields.planName');
    // DetailField renders a <dt>/<dd> pair (its signature contract).
    expect(html).toContain('<dt');
    expect(html).toContain('<dd');
    // The formatted member number flows through formatMemberNumber.
    expect(html).toContain('SCCM-0042');
  });

  it('renders the status badge label via statusBadge.<status>', async () => {
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('statusBadge.active');
  });

  it('renders registration date in Buddhist Era for th (display-only, 2026→2569)', async () => {
    localeRef.current = 'th';
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    // 2026 CE + 543 = 2569 BE — the localised helper maps th → buddhist cal.
    expect(html).toContain('2569');
    expect(html).not.toContain('2026');
  });

  it('CROSS-TENANT: resolves memberId from the session user via findByLinkedUserId (never a URL param)', async () => {
    await PortalProfileBody({ user: { id: 'user-a' } });
    expect(findByLinkedUserIdMock).toHaveBeenCalledTimes(1);
    // 2nd arg is the session user id — the ONLY input that scopes the member.
    expect(findByLinkedUserIdMock.mock.calls[0]![1]).toBe('user-a');
    // getMember is then called with the member id returned by that lookup,
    // not with any externally supplied id.
    expect(getMemberMock.mock.calls[0]![0]).toBe('mem-a');
  });

  it('shows the not-linked message when findByLinkedUserId fails', async () => {
    findByLinkedUserIdMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'repo.not_found' },
    });
    const tree = await PortalProfileBody({ user: { id: 'user-a' } });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain('notLinked');
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)** —

```bash
pnpm vitest run tests/unit/app/portal/profile/portal-profile-body.test.tsx
```
Expected: FAIL before Task 61 lands — either `PortalProfileBody is not a function` (export missing) or, if run against the pre-refactor page, `h2Count` is 0 (titles are `CardTitle` divs) and `2569` is absent (date used the raw `getFormatter`).

- [ ] **Step 3: Implement** — No new implementation file: Task 61 already produced the body that satisfies these assertions. If the suite reports a finding (e.g. a stray `<h3>` from a copied contact block, or `2026` leaking because a date bypassed `formatLocalisedDate`), fix it in `src/app/(member)/portal/profile/page.tsx` so the body matches the Task-61 code exactly (contact names rendered as `<p>`, not `<h3>`; every date through `formatLocalisedDate`). The Task-61 code above already renders contact names as `<p>` and routes both dates through the helper, so no change is expected.

- [ ] **Step 4: Run test (expect PASS)** —

```bash
pnpm vitest run tests/unit/app/portal/profile/portal-profile-body.test.tsx
```
Expected: PASS — 6 passing tests (heading-order h2×3 / no h3, DetailField dt/dd + SCCM-0042, status badge key, BE 2569 for th, cross-tenant findByLinkedUserId('user-a'), not-linked fallback).

- [ ] **Step 5: Commit** —

```bash
git add tests/unit/app/portal/profile/portal-profile-body.test.tsx
git commit -m "test(portal): profile body heading-order + DetailField + BE-date + cross-tenant guard"
```

---

## Appendix A — i18n keys (add to `src/i18n/messages/{en,th,sv}.json`)

- `nav.member.accountShort`
- `nav.member.benefitsShort`
- `nav.member.bottomTabsAriaLabel`
- `portal.account.menu.dataPrivacy`
- `portal.account.menu.renewalPrefs`
- `portal.dashboard.activity.empty`
- `portal.dashboard.activity.empty.body`
- `portal.dashboard.activity.empty.title`
- `portal.dashboard.activity.emptyCta`
- `portal.dashboard.activity.heading`
- `portal.dashboard.activity.title`
- `portal.dashboard.activity.viewAll`
- `portal.dashboard.benefits.emptySub`
- `portal.dashboard.benefits.emptyValue`
- `portal.dashboard.benefits.label`
- `portal.dashboard.benefits.onTrackSub`
- `portal.dashboard.benefits.onTrackValue`
- `portal.dashboard.benefits.underUseSub`
- `portal.dashboard.benefits.underUseValue`
- `portal.dashboard.benefitsPanel.heading`
- `portal.dashboard.benefitsPanel.viewAll`
- `portal.dashboard.firstRun.body`
- `portal.dashboard.firstRun.exploreBenefits`
- `portal.dashboard.firstRun.title`
- `portal.dashboard.intro`
- `portal.dashboard.invoicesPanel.heading`
- `portal.dashboard.membership.activeSub`
- `portal.dashboard.membership.activeValue`
- `portal.dashboard.membership.daysRemainingSub`
- `portal.dashboard.membership.emptySub`
- `portal.dashboard.membership.emptyValue`
- `portal.dashboard.membership.label`
- `portal.dashboard.membership.overdueSub`
- `portal.dashboard.membership.overdueValue`
- `portal.dashboard.membership.renewDueValue`
- `portal.dashboard.outstanding.clearSub`
- `portal.dashboard.outstanding.clearValue`
- `portal.dashboard.outstanding.countSub`
- `portal.dashboard.outstanding.dueSub`
- `portal.dashboard.outstanding.label`
- `portal.dashboard.outstanding.value`
- `portal.dashboard.quickActions.benefits`
- `portal.dashboard.quickActions.editProfile`
- `portal.dashboard.quickActions.heading`
- `portal.dashboard.quickActions.pay`
- `portal.dashboard.quickActions.renew`
- `portal.dashboard.quickActions.title`
- `portal.dashboard.quotaBar.ariaLabel`
- `portal.dashboard.quotaBar.readout`
- `portal.dashboard.statusChip.active`
- `portal.dashboard.statusChip.archived`
- `portal.dashboard.statusChip.inactive`
- `portal.dashboard.welcome`
- `portal.profile.contactsSection`
- `portal.profile.editButton`
- `portal.profile.fields.address`
- `portal.profile.fields.companyName`
- `portal.profile.fields.country`
- `portal.profile.fields.description`
- `portal.profile.fields.foundedYear`
- `portal.profile.fields.lastActivityAt`
- `portal.profile.fields.legalEntityType`
- `portal.profile.fields.memberId`
- `portal.profile.fields.memberIdCopy`
- `portal.profile.fields.memberIdHelp`
- `portal.profile.fields.memberNumber`
- `portal.profile.fields.memberNumberCopy`
- `portal.profile.fields.planName`
- `portal.profile.fields.planYear`
- `portal.profile.fields.registrationDate`
- `portal.profile.fields.status`
- `portal.profile.fields.taxId`
- `portal.profile.fields.turnoverThb`
- `portal.profile.fields.website`
- `portal.profile.inviteColleague`
- `portal.profile.loadError`
- `portal.profile.membershipSection`
- `portal.profile.noContacts`
- `portal.profile.notLinked`
- `portal.profile.organisationSection`
- `portal.profile.pageTitle`
- `portal.profile.portalLinked`
- `portal.profile.primaryBadge`
- `portal.profile.statusBadge.active`
- `portal.profile.statusBadge.archived`
- `portal.profile.statusBadge.inactive`

_TH bottom-tab short labels (`*Short`) must fit a 320px tab; full label stays as `aria-label`. `th` dates are Buddhist-Era display-only._
