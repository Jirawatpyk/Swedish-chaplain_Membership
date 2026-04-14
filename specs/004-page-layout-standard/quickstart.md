# Quickstart: F4 — Page Layout Enterprise Standardization & Responsive Design

**Branch**: `004-page-layout-standard` | **Date**: 2026-04-12

## Prerequisites

F4 has no new infrastructure requirements. If you can run F3 (`003-nav-menu`), you can run F4.

- Node.js 22 LTS
- pnpm (lockfile: `pnpm-lock.yaml`)
- `.env.local` with Vercel env vars (run `vercel env pull .env.local` if stale)

## Setup

```bash
git checkout 004-page-layout-standard
pnpm install
pnpm dev          # → http://localhost:3100
```

No new environment variables, no new database migrations, no new external services.

## Development workflow

### Install shadcn breadcrumb primitive (if not already present)

```bash
pnpm dlx shadcn@latest add breadcrumb
```

### Key files to work on

**New layout components**
| Component | Path |
|-----------|------|
| PageHeader | `src/components/layout/page-header.tsx` |
| ContentContainer | `src/components/layout/content-container.tsx` |
| BreadcrumbNav | `src/components/layout/breadcrumb-nav.tsx` |
| BreadcrumbProvider | `src/components/layout/breadcrumb-provider.tsx` |

**Modified shadcn/ui primitives**
| Primitive | Change |
|-----------|--------|
| `src/components/ui/button.tsx` | cursor + disabled + size default 32→36px |
| `src/components/ui/input.tsx` | `--input-height` / padding / disabled state |
| `src/components/ui/textarea.tsx`, `select.tsx`, `checkbox.tsx`, `radio-group.tsx`, `switch.tsx`, `label.tsx` | form-field tokens + focus ring |
| `src/components/ui/table.tsx` | row/cell tokens + responsive wrapper |
| `src/components/ui/card.tsx` | card tokens |
| `src/components/ui/dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx` | modal tokens |
| `src/components/ui/dropdown-menu.tsx` | audit all triggers → Button variant="ghost" |

**Cross-cutting**
| File | Change |
|------|--------|
| `src/app/globals.css` | ~30 new design tokens + `.focus-ring` + `.text-h{1-4}` / `.text-body` / `.text-caption` utility classes |
| `src/app/(staff)/admin/layout.tsx` | BreadcrumbProvider + top-bar tokens |
| `src/app/(member)/portal/layout.tsx` | ContentContainer + top-bar tokens |
| `src/i18n/messages/{en,th,sv}.json` | 22 new keys (breadcrumb + layout) |
| `src/app/__test__/button-matrix/page.tsx` | Dev-only test fixture (guarded by NODE_ENV) |

### Testing

```bash
# Unit tests (breadcrumb parsing, component rendering)
pnpm test -- tests/unit/layout/

# Full test suite (verify no regressions)
pnpm test

# E2E viewport tests
pnpm test:e2e -- tests/e2e/layout-responsive.spec.ts

# Accessibility scan
pnpm test:e2e -- tests/e2e/layout-a11y.spec.ts

# i18n key coverage
pnpm check:i18n

# Full CI pipeline
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:e2e
```

### Visual verification

Open the dev server and check these pages at multiple viewports (320px, 375px, 768px, 1024px, 1440px):

1. `/admin` — dashboard (depth 1, NO breadcrumb)
2. `/admin/users` — table page (depth 2, NO breadcrumb)
3. `/admin/plans/new` — form page (depth 3, breadcrumb visible)
4. `/admin/plans/[year]/[planId]` — detail page (depth 4, dynamic label)
5. `/admin/settings/fees` — settings form (depth 3, breadcrumb)
6. `/portal` — member landing page
7. `/__test__/button-matrix` — dev-only button cursor/state matrix

Verify:
- **Layout**: Consistent page header, content container max-width (72rem admin / 64rem portal), consistent top-bar height (56px)
- **Breadcrumbs**: Visible on depth ≥ 3 only; mobile truncation = immediate parent + current + leading `...`
- **Responsive**: No horizontal scroll at any viewport; actions wrap below 640px; grids collapse below 768px; tables scroll horizontally within their container
- **Buttons**: `cursor-pointer` on hover when enabled, `cursor-not-allowed` + 50% opacity when disabled, default size = 36px
- **Typography**: h2/h3/h4 all use `.text-h{N}` semantic classes; Thai content has tighter line-height applied under `[lang="th"]`
- **Focus**: Keyboard Tab through any page — every interactive element shows the 3px ring-ring/50 focus outline identically
- **Forms**: All Inputs, Textareas, Selects at 36px height; label-to-field gap identical; disabled state mirrors Button
- **Tables**: Users + Plans tables have identical row height, cell padding, hover background
- **Overlays**: Cards, Dialogs, DropdownMenus share padding/radius/shadow per FR-021/022/023
- **CLS**: Sidebar toggle = 0 layout shift

## No new secrets or services

F4 adds zero new environment variables, external services, or infrastructure.
