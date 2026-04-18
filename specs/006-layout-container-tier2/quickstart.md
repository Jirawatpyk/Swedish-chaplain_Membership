# Quickstart — Layout Container Tier 2

**Feature**: 006-layout-container-tier2

## Picking a container

Use this one-line decision rule:

> **Is the page's primary surface a wide table? → `TableContainer` (96rem).
> A single-column form or settings screen? → `FormContainer` (42rem).
> Anything else (dashboard, detail, mixed)? → `DetailContainer` (72rem, default).**

If you're unsure, pick `DetailContainer` — it's the safe default and matches the pre-feature width.

## Usage examples

### Table-dense page (e.g. `/admin/members`)

```tsx
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function MembersPage() {
  return (
    <TableContainer>
      <PageHeader title="Members" />
      <MembersTable />
    </TableContainer>
  );
}
```

### Form-focused page (e.g. `/admin/settings/fees`)

```tsx
import { FormContainer } from '@/components/layout';

export default function FeesSettingsPage() {
  return (
    <FormContainer>
      <PageHeader title="Fee settings" />
      <FeesForm />
    </FormContainer>
  );
}
```

### Detail / dashboard page (e.g. `/admin`)

```tsx
import { DetailContainer } from '@/components/layout';

export default function AdminDashboardPage() {
  return (
    <DetailContainer>
      <PageHeader title="Dashboard" />
      <DashboardCards />
    </DetailContainer>
  );
}
```

## Overflow handling (do NOT add to the container)

The three containers **deliberately do not set `overflow-x`**. Horizontal overflow for wide tables is handled by the shadcn `<Table>` component, which wraps its `<table>` in a `<div class="overflow-x-auto">` at `src/components/ui/table.tsx`. Adding `overflow-x-auto` at container level would clip sticky columns, dropdown menus, and tooltips that need to escape the table's bounding box.

- **Table wider than 96rem inside `TableContainer`** → inner shadcn `Table` wrapper scrolls horizontally; the container stays static. ✅
- **Table embedded inside `DetailContainer` (72rem)** → same behaviour; the table scrolls in place without widening the page. ✅
- **Raw `<table>` elements not using shadcn `<Table>`** → wrap them in `<div class="overflow-x-auto">` manually, or migrate them to the shadcn component.

## Skeleton parity

Every `loading.tsx` MUST use the same container as its sibling `page.tsx`:

```tsx
// app/(staff)/admin/members/loading.tsx
import { TableContainer } from '@/components/layout';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

export default function MembersLoading() {
  return (
    <TableContainer>
      <MembersTableSkeleton />
    </TableContainer>
  );
}
```

Failing to match containers causes a visible layout shift between skeleton and hydrated content (breaks SC-007).

## Migrating an existing page from `ContentContainer`

`ContentContainer` is **removed** in this feature. To migrate:

1. Identify the page's primary content type (table / form / detail).
2. Replace the import:

   ```diff
   - import { ContentContainer } from '@/components/layout';
   + import { DetailContainer } from '@/components/layout'; // or TableContainer / FormContainer
   ```

3. Replace the element:

   ```diff
   - <ContentContainer variant="admin">
   + <DetailContainer>
   ```

4. Drop the `variant` and `fullBleed` props — they no longer exist.
5. Update the sibling `loading.tsx` to use the same container.
6. Run `pnpm test tests/unit/components/layout` + `pnpm test:e2e --grep container-widths`.

## Running the verification suite locally

```bash
pnpm test tests/unit/components/layout                   # unit primitives
pnpm test:e2e tests/e2e/layout --workers=1               # Playwright F5 specs
pnpm check:layout                                        # static scope-gate
pnpm lint && pnpm typecheck                              # zero ContentContainer imports left
```

**`--workers=1` is mandatory for E2E on most dev machines.** The default
Playwright config allows 3 workers locally, but 3× Chromium instances +
live-infra rate-limit pressure + streaming server-components can crash a
machine mid-run (SIGABRT exit code 134). Run the full layout sweep in
~3 minutes with a single worker; parallelism is only enabled in CI.

If any `ContentContainer` import remains, `pnpm typecheck` fails (symbol deleted).

## Documentation

See `docs/ux-standards.md` § Container Selection Guideline for the authoritative rule and mapping table.
