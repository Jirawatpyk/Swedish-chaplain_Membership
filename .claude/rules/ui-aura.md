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
- Both command palettes use AURA `Command`. `cmdk` is banned outside its legacy host `src/components/ui/command.tsx` (pickers and `ui/combobox`, until US13).
- **i18n**: a literal `t('key')` missing from `en.json` fails `check:i18n`; next-intl does NOT throw on a missing key at runtime, so a renamed key ships as `MISSING_MESSAGE`. No italic on Thai text; muted grey is the empty-value sentinel.
- **UX playbook** `docs/ux-standards.md` (+ `docs/ux-patterns.md`): every dialog sets `finalFocus`; portal card titles sit inside `CardHeader`; buttons are `h-9`.
- **e2e**: `--workers=1`; scope locators to `:visible` (Next keeps the previous segment's DOM hidden after a client navigation), never `.first()`; the `e2e-member` persona is LAPSED — use `e2e-member-empty` for a member in good standing.
