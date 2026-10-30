---
paths:
  - "src/components/**"
  - "src/app/**/*.tsx"
  - "src/styles/**"
  - "src/i18n/messages/**"
  - "tests/e2e/**"
---

# UI — AURA migration (spec 122), i18n, UX

Any UI-touching change also gets an `enterprise-ux-designer` pass (see the `review-and-ship` skill).

- **AURA**: `@jirawatpyk/aura-react` + `@jirawatpyk/aura-tokens`, exact-pinned (check `package.json`), replacing the legacy kit module by module. Guide `docs/aura-adoption.md`: the adoption ledger, every handoff item, and the stand-ins awaiting an AURA fix (each labelled `stand-in until AURA #NN`; `tests/unit/architecture/aura-internal-class-ratchet.test.ts` refuses an unlabelled `.aura-*` reach).
- CSS layer order + token bridge + generated brand theme `src/styles/aura-theme.css` · `AuraBridge` provider · toasts only through `@/lib/toast` · UI import ratchet `@typescript-eslint/no-restricted-imports` + `MIGRATED_PATHS`.
- Icon names are registered once per registry (`AuraBridge`, `@/lib/aura-server-icons`); TH/SV use AURA's locale packs.
- Server files import static AURA components from `@jirawatpyk/aura-react/server`, never the root (`tests/unit/architecture/aura-server-imports.test.ts`).
- The legacy kit in `src/components/ui/` is shadcn/ui on **Base UI** (not Radix): click a radio's LABEL; `disabled` shows as `aria-disabled`; a render-prop ref is easy to drop; Switch needs a PointerEvent polyfill in jsdom.
- **Bottom bars** (D-039): every viewport `ActionBar` carries `edgeBelow="sm"` — an edge strip below 640px, the floating card from 640px; no hand-built bottom bar without a reason (`tests/unit/architecture/viewport-actionbar-edge.test.ts`).
- Both command palettes use AURA `Command`. `cmdk` is banned outside its legacy host `src/components/ui/command.tsx` (pickers and `ui/combobox`, until US13).
- **i18n**: a literal `t('key')` missing from `en.json` fails `check:i18n`; next-intl does NOT throw on a missing key at runtime, so a renamed key ships as `MISSING_MESSAGE`. No italic on Thai text; muted grey is the empty-value sentinel.
- **Migrate and fix** (the maintainer, 25 Oct 2026; spec 122 Session 2026-10-25): a migration slice also fixes the problems its files already had (UX, a11y, mobile, copy, states). Sweep each migrated file whole, not only the diff. A fix that changes server behaviour, data, money or an API ships as its own PR right after (FR-011), named in the slice's PR.
- **Board parity** (a Done-when that says "matches the boards"): compare the board's TEXT, element by element, with the built page's text — headings, column headers, captions, the header line, number formats (whole baht vs 2 decimals) — not only the layout in a screenshot. Each board element is either built or named in the spec's § Decisions as left out; "layout matches" proves neither (spec 124: three board elements missed at slice 3, found on prod).
- **Parity page per slice, like for like**: a slice's exit is not ticked without its parity artifact URL in `tasks.md`. Each pair is the whole board against the whole live page at the same width: a page with no preview fixture gets one in the slice (`src/app/test-fixtures/**`), and a component alone in a frame is never paired with a full-page board (US12d-2: shipped with no parity page, then a first page that set full boards against the bare editor).
- **UX playbook** `docs/ux-standards.md` (+ `docs/ux-patterns.md`): every dialog sets `finalFocus`; portal card titles sit inside `CardHeader`; buttons are `h-9`.
- **e2e**: `--workers=1`; scope locators to `:visible` (Next keeps the previous segment's DOM hidden after a client navigation), never `.first()`; the `e2e-member` persona is LAPSED — use `e2e-member-empty` for a member in good standing.
