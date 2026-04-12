# Contract: Navigation Configuration

**Date**: 2026-04-12  
**Type**: Internal TypeScript interface contract (no external API)

## Overview

This feature exposes no new API endpoints or external interfaces. The contract defines the **internal configuration interface** that future features use to register navigation items.

## Navigation Registration Contract

Future features add navigation entries by modifying the nav config arrays in `src/config/nav.ts`.

### Staff Navigation Config

```typescript
// src/config/nav.ts — staff portal navigation
export const staffNavConfig: NavConfig = {
  sections: [
    {
      items: [
        { titleKey: 'nav.staff.dashboard', icon: LayoutDashboard, href: '/admin', activePattern: '/admin' },
        { titleKey: 'nav.staff.plans', icon: FileText, href: '/admin/plans', activePattern: '/admin/plans' },
        { titleKey: 'nav.staff.users', icon: Users, href: '/admin/users', activePattern: '/admin/users' },
      ],
    },
    {
      titleKey: 'nav.staff.sections.settings',
      items: [
        {
          titleKey: 'nav.staff.settings',
          icon: Settings,
          activePattern: '/admin/settings',
          children: [
            { titleKey: 'nav.staff.settingsFees', icon: DollarSign, href: '/admin/settings/fees', activePattern: '/admin/settings/fees' },
            // F3+ adds more settings sub-items here
          ],
        },
      ],
    },
  ],
};
```

### Member Navigation Config

```typescript
// src/config/nav.ts — member portal navigation
export const memberNavConfig: NavConfig = {
  sections: [
    {
      items: [
        { titleKey: 'nav.member.dashboard', icon: LayoutDashboard, href: '/portal', activePattern: '/portal' },
        { titleKey: 'nav.member.account', icon: UserCircle, href: '/portal/account', activePattern: '/portal/account' },
        // F3+ adds Invoices, Events, etc. here
      ],
    },
  ],
};
```

### Adding a New Nav Item (Future Feature Contract)

To add a navigation item for a new feature page:

1. Add the route/page as usual in `src/app/`
2. Add one entry to the appropriate config array in `src/config/nav.ts`
3. Add i18n keys to `en.json`, `th.json`, `sv.json` under the `nav.*` namespace
4. No component changes needed

This satisfies FR-009 (data-driven nav structure).
