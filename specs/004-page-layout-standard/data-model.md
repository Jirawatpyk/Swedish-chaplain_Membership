# Data Model: F4 — Page Layout Enterprise Standardization & Responsive Design

**Branch**: `004-page-layout-standard` | **Date**: 2026-04-12

## Database Changes

**None.** F4 is a pure presentation-layer feature. No new tables, columns, migrations, or RLS policies.

## Component Data Model

F4 introduces layout components with the following prop interfaces (expressed as TypeScript-style contracts, not implementation):

### PageHeader

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| title | string | Yes | Page title (i18n-resolved by caller) |
| subtitle | string | No | Descriptive subtitle below title |
| actions | ReactNode | No | Slot for action buttons (right-aligned, wraps on mobile) |
| badge | ReactNode | No | Slot for a status badge next to subtitle |

### ContentContainer

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| children | ReactNode | Yes | Page content |
| fullBleed | boolean | No | Opt out of max-width constraint (default: false) |
| variant | 'admin' \| 'portal' | No | Determines max-width token (default: 'admin' = 72rem, 'portal' = 64rem) |

### BreadcrumbNav

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| — (reads from context) | — | — | Consumes BreadcrumbProvider context for labels |

Renders automatically from the current route path. Static segments use i18n keys. Dynamic segments use labels registered by pages via `useBreadcrumbLabels()`.

### BreadcrumbProvider

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| children | ReactNode | Yes | Layout subtree |

Provides a `Map<string, string>` context for dynamic breadcrumb label registration.

**Hook**: `useBreadcrumbLabels()` — returns `{ setLabel(segment: string, label: string): void }`. Pages call this in a `useEffect` to register their dynamic labels.

## Design Tokens (CSS Custom Properties)

| Token | Value | Used by |
|-------|-------|---------|
| `--content-max-width-admin` | `72rem` (1152px) | ContentContainer variant='admin' |
| `--content-max-width-portal` | `64rem` (1024px) | ContentContainer variant='portal' |
| `--page-padding-x` | `1.5rem` (24px) | ContentContainer horizontal padding |
| `--page-padding-y` | `1.5rem` (24px) | ContentContainer vertical padding |
| `--page-header-gap` | `1.5rem` (24px) | Gap between PageHeader and content |
| `--page-section-gap` | `1.5rem` (24px) | Gap between content sections |
| `--top-bar-height` | `3.5rem` (56px) | Admin + portal top bar fixed height (FR-016) |
| **Typography Scale (FR-017)** | | |
| `--font-size-h1` | `1.875rem` (30px) | PageHeader h1 + `.text-h1` |
| `--font-size-h2` | `1.5rem` (24px) | `.text-h2` |
| `--font-size-h3` | `1.25rem` (20px) | `.text-h3` |
| `--font-size-h4` | `1.125rem` (18px) | `.text-h4` |
| `--font-size-body` | `0.875rem` (14px) | `.text-body` |
| `--font-size-caption` | `0.75rem` (12px) | `.text-caption` |
| `--font-weight-heading` | `600` | All h1–h4 |
| `--line-height-body` | `1.5` | Body + Latin headings |
| `--line-height-caption` | `1.4` | Caption |
| `--line-height-th` | `1.65` | `[lang="th"]` override for Thai diacritics |
| **Form Fields (FR-019)** | | |
| `--input-height` | `2.25rem` (36px) | Input, Textarea, Select trigger |
| `--input-padding-x` | `0.75rem` (12px) | Horizontal padding |
| `--field-label-gap` | `0.375rem` (6px) | Label-to-field spacing |
| `--field-error-color` | `var(--destructive)` | Error state border + helper text |
| **Data Tables (FR-020)** | | |
| `--table-row-height` | `2.75rem` (44px) | TableRow height |
| `--table-cell-padding-x` | `0.75rem` (12px) | TableCell horizontal padding |
| `--table-cell-padding-y` | `0.5rem` (8px) | TableCell vertical padding |
| `--table-row-hover-bg` | `color-mix(in oklch, var(--muted) 50%, transparent)` | Row hover |
| **Cards (FR-021)** | | |
| `--card-padding` | `1.5rem` (24px) | Card content padding |
| `--card-radius` | `var(--radius-lg)` | Border radius |
| `--card-shadow` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | Elevation |
| **Modals / Overlays (FR-022)** | | |
| `--modal-backdrop-opacity` | `0.8` | Backdrop dimming |
| `--modal-max-width-sm` | `25rem` (400px) | Confirmation dialogs |
| `--modal-max-width-md` | `32rem` (512px) | Form dialogs |
| `--modal-max-width-lg` | `42rem` (672px) | Detail dialogs |
| `--modal-duration` | `200ms` | Enter/exit animation |
| `--modal-easing` | `cubic-bezier(0.4, 0, 0.2, 1)` | Material "standard" easing — paired with `--modal-duration` |
| **Button (FR-014 R2 Q1)** | | |
| (Button size="default") | `h-9` (36px) | CHANGED from `h-8` (32px) to align with `--input-height` |

## i18n Keys (new)

Namespace: `breadcrumb`

| Key | EN | TH | SV |
|-----|----|----|-----|
| `breadcrumb.admin` | Admin | ผู้ดูแลระบบ | Admin |
| `breadcrumb.dashboard` | Dashboard | แดชบอร์ด | Instrumentpanel |
| `breadcrumb.users` | Users | ผู้ใช้งาน | Användare |
| `breadcrumb.plans` | Plans | แผนสมาชิก | Planer |
| `breadcrumb.settings` | Settings | การตั้งค่า | Inställningar |
| `breadcrumb.fees` | Fee Configuration | การตั้งค่าค่าธรรมเนียม | Avgiftskonfiguration |
| `breadcrumb.account` | Account | บัญชี | Konto |
| `breadcrumb.newPlan` | New Plan | แผนใหม่ | Ny plan |
| `breadcrumb.clonePlan` | Clone Plan | คัดลอกแผน | Klona plan |
| `breadcrumb.editPlan` | Edit | แก้ไข | Redigera |

Namespace: `layout`

| Key | EN | TH | SV |
|-----|----|----|-----|
| `layout.breadcrumbAriaLabel` | Breadcrumb navigation | การนำทางเส้นทาง | Brödsmulenavigering |
| `layout.ellipsis` | More pages | หน้าอื่นๆ | Fler sidor |
