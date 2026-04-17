# Contract: Layout Container Primitives

**Feature**: 006-layout-container-tier2
**Scope**: Public API surface of `src/components/layout/{table,detail,form}-container.tsx`.

This is a UI/component contract, not an HTTP or RPC contract. The feature has no external interfaces.

## Public API

```ts
import {
  TableContainer,
  DetailContainer,
  FormContainer,
} from '@/components/layout';

type ContainerProps = {
  children: ReactNode;
  className?: string;
};

declare const TableContainer: FC<ContainerProps>;
declare const DetailContainer: FC<ContainerProps>;
declare const FormContainer: FC<ContainerProps>;
```

## Rendered Output Contract

Each primitive MUST render a single `<div>` with:

- `data-slot="layout-container"`
- `data-variant` = `"table"` | `"detail"` | `"form"` (for testability + CSS hooks)
- Tailwind classes: `mx-auto w-full` + `max-w-[var(--layout-max-width-{variant})]` + `px-[var(--page-padding-x)] py-[var(--page-padding-y)]` + merged `className`.

## Behavioural Contract

| Property | TableContainer | DetailContainer | FormContainer |
|---|---|---|---|
| `max-width` cap | 96rem | 72rem | 42rem |
| Horizontal centre (`mx-auto`) | yes | yes | yes |
| Full width on `<768px` | yes | yes | yes |
| Collapses to full width minus `--page-padding-x` | yes | yes | yes |
| Accepts arbitrary children | yes | yes | yes |
| Forwards `className` via `cn()` | yes | yes | yes |

## Test Contract

Each primitive MUST have a unit test asserting:

1. Renders `children` verbatim.
2. Root element has `data-slot="layout-container"` and correct `data-variant`.
3. Root element computed `max-width` resolves to the expected rem value (via JSDOM `getComputedStyle` after injecting `:root` tokens, OR by asserting the class string).
4. Custom `className` appears on the root element.

## Stability & Versioning

- Breaking changes to prop shape require a new feature branch + spec amendment.
- Removing `ContentContainer` is a breaking change to the layout module's public API; it ships within this feature and is documented in `docs/ux-standards.md`.

## Non-Contract

The following are **explicitly not** part of the public contract and MAY change without notice:

- The exact Tailwind class strings (so long as computed `max-width` and horizontal centring are preserved).
- Internal DOM structure (we may add wrapper elements for future grid/focus features).
