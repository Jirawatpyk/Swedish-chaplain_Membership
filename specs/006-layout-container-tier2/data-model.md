# Phase 1 Data Model — Layout Container Tier 2

**Feature**: 006-layout-container-tier2
**Date**: 2026-04-18

## Overview

This feature has **no persistent data**. There are no database tables, no migrations, no API contracts, no audit events, no new PII, and no domain entities.

The "data model" is the component prop contract for three layout primitives.

## Component Prop Contracts

### `TableContainer`

```ts
type TableContainerProps = {
  children: ReactNode;
  className?: string;
};
```

- **Purpose**: Wraps data-dense list pages. Caps content width at `--layout-max-width-table` (96rem).
- **Invariants**:
  - No `variant` prop.
  - No `fullBleed` prop (was an F4 escape hatch; removed intentionally).
  - `className` merges via `cn()`; overriding `max-width` via a Tailwind arbitrary value is permitted but discouraged (future lint rule may flag it).

### `FormContainer`

```ts
type FormContainerProps = {
  children: ReactNode;
  className?: string;
};
```

- **Purpose**: Wraps single-column input surfaces. Caps content width at `--layout-max-width-form` (42rem).
- **Invariants**: Same as above — no variants, no escape hatches.

### `DetailContainer`

```ts
type DetailContainerProps = {
  children: ReactNode;
  className?: string;
};
```

- **Purpose**: Default container for detail, dashboard, and mixed-content pages. Caps content width at `--layout-max-width-detail` (72rem) — pixel-identical to former F4 `ContentContainer` so migration yields zero visible regression for these pages.
- **Invariants**: Same as above.

## CSS Token Contract

Defined in `src/app/globals.css`:

```css
:root {
  --layout-max-width-form: 42rem;
  --layout-max-width-detail: 72rem;
  --layout-max-width-table: 96rem;
  /* --content-max-width-admin / --content-max-width-portal REMOVED */
}
```

Dark mode inherits (no light/dark divergence for widths).

## Barrel Export Contract

`src/components/layout/index.ts` MUST export:

```ts
export { TableContainer } from './table-container';
export { DetailContainer } from './detail-container';
export { FormContainer } from './form-container';
// ContentContainer export REMOVED
```

## Removed Symbols

- `src/components/layout/content-container.tsx` — deleted.
- `ContentContainer` export in the barrel — deleted.
- `--content-max-width-admin`, `--content-max-width-portal` CSS tokens — deleted.

## State Transitions

None (stateless presentation primitives).

## Validation Rules

None at runtime (no props to validate beyond TypeScript static typing).
