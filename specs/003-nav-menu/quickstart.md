# Quickstart: Navigation Menu (003-nav-menu)

## Prerequisites

- Node 22 LTS
- pnpm installed
- `.env.local` present (run `vercel env pull .env.local` if missing)

## Setup

```bash
# Install dependencies (includes new shadcn sidebar component)
pnpm install

# Start dev server
pnpm dev
# → http://localhost:3100
```

## New Dependencies

```bash
# shadcn/ui sidebar component (adds Sheet, Tooltip dependencies if not present)
npx shadcn@latest add sidebar
```

## Verify

1. **Staff sidebar**: Sign in as admin → sidebar visible on left with Dashboard, Plans, Users, Settings
2. **Collapse**: Click the collapse toggle → sidebar shrinks to icon-only rail
3. **Mobile**: Resize to < 768px → hamburger menu appears, sidebar becomes drawer
4. **Member nav**: Sign in as member → horizontal top nav with Dashboard, Account
5. **i18n**: Switch locale (EN/TH/SV) → nav labels change
6. **Keyboard**: Tab through sidebar items → correct focus order

## Files Changed

```
src/
├── config/nav.ts                          # NEW — nav config arrays (staff + member)
├── components/
│   ├── ui/sidebar.tsx                     # NEW — shadcn sidebar primitive
│   ├── layout/
│   │   ├── staff-sidebar.tsx              # NEW — staff sidebar component
│   │   ├── member-nav.tsx                 # NEW — member top nav bar
│   │   └── nav-item.tsx                   # NEW — shared nav item renderer
│   └── shell/
│       └── sidebar-toggle.tsx             # NEW — collapse/expand toggle button
├── app/
│   ├── (staff)/admin/layout.tsx           # MODIFIED — wrap with SidebarProvider + staff sidebar
│   └── (member)/portal/layout.tsx         # MODIFIED — add member nav bar
├── i18n/messages/
│   ├── en.json                            # MODIFIED — add nav.* keys
│   ├── th.json                            # MODIFIED — add nav.* keys
│   └── sv.json                            # MODIFIED — add nav.* keys
└── hooks/
    └── use-sidebar-state.ts               # NEW — localStorage persistence hook (if not in shadcn)
```

## Testing

```bash
# Unit tests (nav config, active state logic)
pnpm test -- --grep nav

# Full test suite
pnpm test

# i18n coverage check
pnpm check:i18n

# E2E (if nav e2e tests added)
pnpm test:e2e -- --grep nav

# Accessibility scan
pnpm test:e2e -- --grep "@a11y"
```
