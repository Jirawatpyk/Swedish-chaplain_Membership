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
 * `migratedPaths` are the globs already on AURA; `@/components/ui/*` is banned
 * there. The list lives in `eslint.config.mjs` (`MIGRATED_PATHS`) and only grows;
 * at US13 the ban goes global and the list is deleted.
 */

const TS_FILES = ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"];

/** The legacy kit's only `cmdk` consumer; it goes when US1 swaps in AURA `Command`. */
const CMDK_HOST = "src/components/ui/command.tsx";

const GLOBAL_PATHS = [
  { name: "sonner", message: "Spec 122: toasts go through `@/lib/toast`." },
  {
    name: "@jirawatpyk/aura-react",
    importNames: ["formatDate", "useFormatDate"],
    message:
      "Spec 122: `@/lib/format-date-localised` is the only date formatter (tenant time zone, Buddhist Era for th).",
  },
];

const CMDK = { name: "cmdk", message: "Spec 122: use AURA `Command`." };

const LEGACY_KIT = {
  group: ["@/components/ui", "@/components/ui/*"],
  message:
    "Spec 122: this path is on AURA (MIGRATED_PATHS) — import from `@jirawatpyk/aura-react`, not the legacy kit.",
};

const rule = (paths, patterns = []) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { paths, patterns }],
});

/**
 * @param {readonly string[]} migratedPaths globs already on AURA
 * @returns {import("eslint").Linter.Config[]}
 */
export function uiRatchet(migratedPaths) {
  const blocks = [
    { name: "spec-122/ui-ratchet", files: TS_FILES, rules: rule([...GLOBAL_PATHS, CMDK]) },
    { name: "spec-122/ui-ratchet/cmdk-host", files: [CMDK_HOST], rules: rule(GLOBAL_PATHS) },
  ];
  if (migratedPaths.length > 0) {
    blocks.push({
      name: "spec-122/ui-ratchet/migrated",
      files: [...migratedPaths],
      rules: rule([...GLOBAL_PATHS, CMDK], [LEGACY_KIT]),
    });
  }
  return blocks;
}
