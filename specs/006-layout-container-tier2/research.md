# Phase 0 Research — Layout Container Tier 2

**Feature**: 006-layout-container-tier2
**Date**: 2026-04-18
**Status**: All NEEDS CLARIFICATION resolved at `/speckit.clarify` gate.

## R1. Canonical width caps

- **Decision**: Form 42rem (672px) / Detail 72rem (1152px) / Table 96rem (1536px). Values are locked; no per-page tuning.
- **Rationale**: 42rem keeps body/form text within the ~75-character comfortable reading line (Baymard Institute + Material Design guidance). 72rem preserves exact F4 ContentContainer parity so detail/dashboard pages ship with zero visible regression (spec SC-003). 96rem matches Stripe Dashboard, Linear, and Vercel Dashboard table widths on 1440p+ monitors and is wide enough to hold ~10-column tables without inner scroll at 1280px viewport while still capping on ultrawide (≥1920px) for horizontal eye-scan comfort.
- **Alternatives considered**:
  - Full-bleed tables (100% minus gutter): rejected — rows become too wide on 2560px+ monitors, rendering rows hard to scan.
  - 40rem form: rejected — too narrow for multi-column form groups (e.g., address blocks) already in F3.
  - 112rem table: rejected — no current admin table needs >96rem; premature widening.

## R2. CSS token strategy

- **Decision**: Replace the two existing CSS custom properties (`--content-max-width-admin` / `--content-max-width-portal`) in `src/styles/globals.css` with three new tokens: `--layout-max-width-form: 42rem`, `--layout-max-width-detail: 72rem`, `--layout-max-width-table: 96rem`. Each primitive references its own token via a Tailwind arbitrary-value utility (`max-w-[var(--layout-max-width-form)]` etc.).
- **Rationale**: Mirrors the token-based approach already used by F4 ContentContainer so theming and dark-mode behaviour stay identical. Token names are semantic (by content type), not variant-based (admin/portal) — this is the core fix that retires the leaky "admin/portal" variant abstraction.
- **Alternatives considered**:
  - Hard-code Tailwind `max-w-2xl`/`max-w-5xl`/`max-w-screen-xl`: rejected — couples primitive to Tailwind's preset ladder, which doesn't include 42/72/96 rem exactly.
  - Per-component inline style: rejected — defeats the cascade / theme override story.

## R3. Horizontal gutter (page padding) parity

- **Decision**: All three containers reuse the existing `--page-padding-x` / `--page-padding-y` tokens. No new gutter tokens.
- **Rationale**: Page gutters are a shell concern, not a content-type concern. Diverging gutters between containers would introduce visual inconsistency during route transitions (risking SC-007 CLS budget).
- **Alternatives considered**: Per-container gutter scaling — rejected for simplicity (Principle X) and to keep the three primitives near-interchangeable.

## R4. Prop surface of each primitive

- **Decision**: Each primitive exposes exactly `{ children: ReactNode; className?: string }`. No `variant`, no `fullBleed`, no size escape hatch.
- **Rationale**: Removing escape hatches is the whole point — they caused the F4 drift where admin tables ended up on `variant='admin'` (72rem) instead of a wider surface. If a genuine full-bleed table arrives later, a fourth primitive can be introduced then; we do not design it today (Principle X).
- **Alternatives considered**: Keep a `fullBleed` prop on `TableContainer` — rejected; leaks the previous anti-pattern.

## R5. Migration mapping lock

- **Decision**: The 19-route mapping in spec Assumptions is authoritative. One table-category probe: `/admin/plans/[year]/[planId]` is a DetailContainer page despite embedding a small table (member list by plan) — the page's primary surface is summary cards + metadata.
- **Rationale**: Spec locks mapping. Inner wider content inside DetailContainer uses local `overflow-x: auto` (existing pattern), not container widening.
- **Alternatives considered**: Auto-wide based on tag sniffing — rejected, non-deterministic and opaque.
- **Pre-ship visual check**: Before merge, render `/admin/plans/[year]/[planId]` with a realistic plan containing ≥5 members. If the embedded members-by-plan table overflows the 72rem inner width (even with the shadcn `<Table>` built-in `overflow-x-auto` wrapper absorbing the scroll), reclassify this specific page to `TableContainer` and update the Content-Type Mapping in spec Assumptions. This check is a human step during the Review gate, not an automated test.
- **Overflow ownership**: The three new containers MUST NOT set `overflow-x`. Horizontal overflow for wide tables is owned by the shadcn `<Table>` wrapper at `src/components/ui/table.tsx:11` (`overflow-x-auto` on the `data-slot="table-container"` div). Adding container-level overflow would clip sticky columns, dropdown menus, and tooltips.

## R6. `ContentContainer` teardown order

- **Decision**: (1) Add three new primitives + tokens in one commit with unit tests green. (2) Migrate pages in category batches (table → form → detail) with commits per batch. (3) Delete `content-container.tsx` + remove tokens in the final commit. Build must pass at every commit boundary.
- **Rationale**: Keeps PR reviewable in stages, avoids a megapatch, guarantees `main` can be checked out at any intermediate SHA and still build (Reliability posture even though the change itself is presentation-only).
- **Alternatives considered**: One-shot replace-and-delete — rejected, noisier review.

## R7. Test strategy

- **Decision**:
  - **Unit (Vitest)**: one spec per primitive asserting (a) rendered `max-width` class resolves to the correct token value via `getComputedStyle`, (b) children render, (c) custom `className` merges via `cn()`.
  - **E2E (Playwright)**: one spec `tests/e2e/layout/container-widths.spec.ts` covering three representative pages × three viewport widths (1280, 1440, 1920):
    - `/admin/members` (table) → assert `scrollWidth === clientWidth` on `<html>` + measured content area width ≤ 96rem at 1920px.
    - `/admin/settings/fees` (form) → assert content column width ≈ 42rem (±4px).
    - `/admin` (detail) → assert content column width ≈ 72rem (±4px) at 1440px.
  - **Accessibility**: existing `@axe-core/playwright` suite must pass unchanged on migrated pages.
- **Rationale**: Matches the `/speckit.clarify` Q3 answer (Playwright assertions, no screenshot baselines). Cheap, deterministic, catches regressions.
- **Alternatives considered**: Full screenshot-diff baselines (Chromatic/Percy) — rejected as over-investment for a presentation-only change.

## R8. Skeleton (`loading.tsx`) parity

- **Decision**: Every migrated `page.tsx` gets its `loading.tsx` sibling updated to wrap the skeleton in the same container so the pre-hydration frame has the same outer bound as the hydrated frame (prevents flash-of-wider-layout).
- **Rationale**: Same container = same `max-width` = zero CLS on hydration (SC-007).
- **Alternatives considered**: Letting skeletons free-float — rejected, visible CLS.

## R9. Documentation update scope

- **Decision**: Add a "Container Selection Guideline" subsection to `docs/ux-standards.md`, placed near the existing layout section. Include: (1) one-sentence decision rule, (2) table mapping content type → primitive → width, (3) three minimal code examples, (4) callout that `ContentContainer` has been removed.
- **Rationale**: FR-008 + SC-009 require discoverable guidance in the same PR.
- **Alternatives considered**: Separate `docs/layout.md` — rejected; fragmentation.

## R9b. Thai line-break hedge for narrow containers

- **Decision**: Add a single CSS rule `:lang(th) { line-break: loose; word-break: normal; }` to `src/app/globals.css`.
- **Rationale**: Thai has no inter-word spaces. Without a hint, browsers may break Thai text at arbitrary character boundaries, which feels jarring inside narrow containers — most notably FormContainer (42rem). `line-break: loose` tells the browser to use its locale-aware ICU Thai dictionary for word segmentation, improving readability **globally** (not only in forms) at zero layout-width cost.
- **Rationale for including in this feature**: The globals.css file is already being edited to swap width tokens, and the rule is 2 lines. Bundling avoids a separate PR for a tiny readability win. The change is orthogonal to width locks (FR-002/003/004) and does not alter SC-001 through SC-008.
- **Alternatives considered**:
  - Widen FormContainer for `:lang(th)` to 44–48rem: rejected — no evidence, undermines "focused form" intent, and character-per-line is not the true issue; line-break *behavior* is.
  - Apply `line-break: loose` only inside FormContainer: rejected — Thai benefits from better line-breaking everywhere (DetailContainer body copy, PageHeader long titles, etc.), not just forms.
  - Defer to a separate feature: rejected — trivial cost inside this PR, meaningful cost as a solo change.
- **Verification**: Manual check on `/admin/settings/fees` in `th` locale — Thai descriptions should wrap at word boundaries (not mid-word). Not automated; no SC added.

## R10. Pre-existing tests that MUST be updated or removed

The F4 feature added tests that hard-code `ContentContainer` / `variant="portal"` / `max-width: 1152px`. Removing `ContentContainer` will break these; they MUST be updated in the same PR:

| File | Action |
|---|---|
| `tests/unit/layout/content-container.test.tsx` | **Delete** — replaced by new per-primitive unit tests. |
| `tests/e2e/layout-consistency.spec.ts` | **Rewrite** — replace "every admin page has `max-width: 1152px`" with per-category assertions: table pages ≤ 96rem, detail pages 72rem, form pages 42rem. |
| `tests/e2e/empty-state-composition.spec.ts` | **Update** — replace `ContentContainer` reference with `DetailContainer` (empty states typically render on detail/dashboard pages). |
| `tests/e2e/portal-layout.spec.ts` | **Rewrite** — T043 asserts `variant="portal"` (64rem); update to assert the portal page's new container + width per Content-Type Mapping. |

All four are in-scope for this feature and MUST land in the same PR to keep `main` green at every commit (R6 teardown order).

## R11. Modernization audit (2026 patterns)

Reviewed against 2026 industry practice; no plan changes required:

- **`<main>` landmark (WCAG 2.1 AA)**: Verified `src/app/(staff)/admin/layout.tsx:73` and `src/app/(member)/portal/layout.tsx:50` already render `<main className="flex-1" id="main-content">` wrapping the container slot. Containers MUST stay as `<div>` (adding `as="main"` would nest `<main>` elements — a11y violation). No change.
- **`cva` / variant-merged primitive**: Rejected deliberately — the "one primitive + variant" pattern is the F4 anti-pattern we are undoing. Three explicit primitives preserve the locked width contract and prevent drift.
- **CSS Container Queries (`@container`)**: Deferred. Tailwind v4 supports `@container` natively, but viewport-based sizing is sufficient for the current shell (sidebar width is fixed tokens). Revisit if/when sidebar becomes user-resizable.
- **React 19 / RSC**: Primitives are server-component-safe (no hooks, no client state). No directive change.

## Open questions carried forward

None. All Phase 0 items resolved.
