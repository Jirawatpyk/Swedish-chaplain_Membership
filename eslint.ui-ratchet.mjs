/**
 * Spec 122 — the AURA migration's import ratchet (contracts/lint-ratchet.md).
 *
 * It uses `@typescript-eslint/no-restricted-imports`, a rule id distinct from
 * the core `no-restricted-imports` that carries the Clean Architecture
 * boundaries: flat config REPLACES a rule's options block by block, so reusing
 * the core rule here would silently switch the architecture bans off for every
 * file this matches.
 *
 * The same "last block wins" applies to this rule id too, so every block
 * restates the global bans rather than adding to them.
 *
 * Since US13 the legacy kit is deleted and every ban is global: one block on
 * `src/**` and `tests/**`. The per-path list (`MIGRATED_PATHS`) and the `cmdk`
 * host went with the kit.
 */

const TS_FILES = ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"];

const GLOBAL_PATHS = [
  { name: "sonner", message: "Spec 122: toasts go through `@/lib/toast`." },
  {
    name: "@jirawatpyk/aura-react",
    importNames: ["formatDate", "useFormatDate"],
    message:
      "Spec 122: `@/lib/format-date-localised` is the only date formatter (tenant time zone, Buddhist Era for th).",
  },
];

const CMDK = { name: "cmdk", message: "Spec 122: use AURA `Command` or `Combobox`." };

const LEGACY_KIT = {
  group: ["@/components/ui", "@/components/ui/*"],
  message:
    "Spec 122: the legacy kit was removed at US13 — import from `@jirawatpyk/aura-react` (or `/server`).",
};

const rule = (paths, patterns = []) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { paths, patterns }],
});

/** @returns {import("eslint").Linter.Config[]} */
export function uiRatchet() {
  return [{ name: "spec-122/ui-ratchet", files: TS_FILES, rules: rule([...GLOBAL_PATHS, CMDK], [LEGACY_KIT]) }];
}
