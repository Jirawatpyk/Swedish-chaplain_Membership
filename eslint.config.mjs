import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Clean Architecture boundary rules (Constitution Principle III).
 *
 * - Domain layer (`src/modules/**\/domain/**`): pure TypeScript only.
 *   Forbidden: any framework, ORM, HTTP client, React, or vendor SDK.
 * - Application layer (`src/modules/**\/application/**`): use cases only.
 *   Forbidden: drizzle, next, react, infrastructure vendor SDKs.
 * - Infrastructure layer may import anything.
 */
const domainForbiddenImports = [
  "next",
  "next/*",
  "react",
  "react-dom",
  "drizzle-orm",
  "drizzle-orm/*",
  "postgres",
  "@node-rs/argon2",
  "@upstash/ratelimit",
  "@upstash/redis",
  "resend",
  "@react-email/components",
  "pino",
  "@vercel/otel",
  "@opentelemetry/api",
  // F7 — broadcasts Domain layer must be framework-free. Tiptap is a
  // browser-side rich-text editor, DOMPurify is a sanitiser binding,
  // email-validator is a Node lib — all belong in Infrastructure.
  "@tiptap/react",
  "@tiptap/starter-kit",
  "isomorphic-dompurify",
  "email-validator",
  // F7.1a — Tiptap image extension is a browser editor plugin; the
  // ClamAV `clamscan` binding is a Node lib that talks to a TCP
  // daemon. Both belong in Infrastructure (Phase 2 T025 + T073).
  "@tiptap/extension-image",
  "clamscan",
];

const applicationForbiddenImports = [
  "next",
  "next/*",
  "react",
  "react-dom",
  "drizzle-orm",
  "drizzle-orm/*",
  "postgres",
  "@react-email/components",
  // F5 — PCI/Principle III guard. Application use-cases MUST talk to
  // Stripe through an Infrastructure port (`StripeClient` in
  // `src/modules/payments/infrastructure/stripe/stripe-client.ts`), never
  // by importing the SDK directly. Preserves mockability + keeps SAQ-A
  // scope enforcement at Infrastructure.
  "stripe",
  "@stripe/stripe-js",
  "@stripe/react-stripe-js",
  // F7 — broadcasts Application layer talks to Resend Broadcasts /
  // DOMPurify / Tiptap / email-validator only via Infrastructure ports
  // (HtmlSanitizerPort, EmailValidatorPort, BroadcastsGatewayPort).
  // Direct imports break testability and the OWASP A06 sanitiser-
  // boundary rule (Plan § Constitution).
  "@tiptap/react",
  "@tiptap/starter-kit",
  "isomorphic-dompurify",
  "email-validator",
  // F7.1a — Application layer reaches ClamAV via VirusScannerPort
  // (Phase 2 T021) and the Tiptap image extension via the editor
  // composition root only. Direct imports break the F7.1a US2
  // scan-before-persist invariant (FR-013 + T152) and the testable-
  // sanitiser boundary.
  "@tiptap/extension-image",
  "clamscan",
];

/**
 * Shared application-layer `no-restricted-imports` payload (paths + patterns).
 *
 * Extracted to a single source of truth so module-specific application blocks
 * (members, invoicing) can COMPOSE it instead of SHADOWING it. In ESLint flat
 * config, a later config object that matches the same files and re-sets
 * `no-restricted-imports` REPLACES the earlier rule entirely — it does not
 * merge. The members/invoicing cross-module-port blocks below therefore MUST
 * spread these base paths+patterns in, or the drizzle-orm + infrastructure-VALUE
 * bans silently vanish for those two modules (go-live audit S1-P0-2).
 */
// Events-brand unchecked-constructor ban (F6). The 4 unchecked UUID brand
// constructors are INFRASTRUCTURE-ONLY (Drizzle row reads where the DB guarantees
// UUID shape); every other layer MUST use the validating asEventId/asRegistrationId.
// Single source of truth (go-live audit #1): composed into the application-layer
// bans below AND applied to all other non-exempt files via the global block near
// the end of this file — so un-shadowing the application layer does not drop this
// ban for application files. Behaviour is keyed on importNames, not the message.
const EVENTS_BRAND_UNCHECKED_NAMES = [
  "asEventIdUnchecked",
  "asRegistrationIdUnchecked",
  "tryEventIdUnchecked",
  "tryRegistrationIdUnchecked",
];
const EVENTS_BRAND_MESSAGE =
  "Unchecked brand constructors are infrastructure-only (DB row reads). " +
  "Use asEventId / asRegistrationId / tryEventId / tryRegistrationId at HTTP/CSV boundaries — they validate UUID v4 shape.";
const eventsBrandForbiddenPaths = [
  {
    name: "@/modules/events",
    importNames: EVENTS_BRAND_UNCHECKED_NAMES,
    message: EVENTS_BRAND_MESSAGE,
  },
  {
    name: "@/modules/events/domain/branded-types",
    importNames: EVENTS_BRAND_UNCHECKED_NAMES,
    message: EVENTS_BRAND_MESSAGE,
  },
];
const eventsBrandForbiddenPatterns = [
  {
    group: [
      "**/modules/events/domain/branded-types",
      "**/modules/events/domain/branded-types.ts",
    ],
    importNames: EVENTS_BRAND_UNCHECKED_NAMES,
    message: EVENTS_BRAND_MESSAGE,
  },
];

const APPLICATION_PATH_MESSAGE =
  "Application layer must not depend on Next.js, React, or a specific ORM. " +
  "Use Infrastructure adapters via dependency injection.";
const applicationForbiddenPaths = [
  ...applicationForbiddenImports.map((name) => ({
    name,
    message: APPLICATION_PATH_MESSAGE,
  })),
  // go-live #1 — keep the F6 events-brand ban live for application files now that
  // the global block no longer shadows them.
  ...eventsBrandForbiddenPaths,
];
const applicationForbiddenPatterns = [
  {
    // F5 subpath guard — `stripe/types`, `stripe/resources/*`, and
    // `@stripe/*/internal` deep imports slip past the bare-name `paths:`
    // list. F7 — same for `@tiptap/core`, `@tiptap/extension-*`, etc.
    group: ["stripe/*", "@stripe/*", "@tiptap/*"],
    message:
      "Application layer must not import Stripe or Tiptap SDK subpaths. " +
      "Go through the Infrastructure port (StripeClient / " +
      "HtmlSanitizerPort / BroadcastsGatewayPort) — " +
      "Constitution Principle III + PCI DSS Principle IV (F5) / OWASP A06 (F7).",
  },
  {
    // Path C hardening — B1-class regression guard. Blocks Application files
    // importing Drizzle schema VALUES directly from infrastructure paths.
    // `allowTypeImports: true` — `import type { ... }` lines erase at compile
    // time and create no runtime coupling (legitimate DI port-interface wiring).
    group: [
      "@/modules/*/infrastructure/**",
      "./*/infrastructure/**",
      "./infrastructure/**",
      "../infrastructure/**",
      "../../infrastructure/**",
      "../../../infrastructure/**",
    ],
    allowTypeImports: true,
    message:
      "Application layer must NOT import Infrastructure VALUES directly. " +
      "Define a Port interface in application/ports/ and inject " +
      "the Infrastructure adapter via the composition root " +
      "(src/lib/auth-deps.ts, src/modules/<name>/<name>-deps.ts). " +
      "Type-only imports (`import type { ... }`) are allowed for DI wiring. " +
      "Constitution Principle III (NON-NEGOTIABLE).",
  },
  // go-live #1 — F6 events-brand relative-import bypass guard, kept live for the
  // application layer (see eventsBrandForbiddenPaths note above).
  ...eventsBrandForbiddenPatterns,
];

const DOMAIN_PATH_MESSAGE =
  "Domain layer must be framework-free (Constitution Principle III). " +
  "Move framework-dependent code to application/ or infrastructure/.";
const domainForbiddenPaths = domainForbiddenImports.map((name) => ({
  name,
  message: DOMAIN_PATH_MESSAGE,
}));
const domainForbiddenPatterns = [
  {
    group: ["next/*", "drizzle-orm/*", "stripe/*", "@stripe/*", "@tiptap/*"],
    message: "Domain layer must not import framework subpaths.",
  },
];

/**
 * F3 Plan E2 — members module must not depend on auth Domain types
 * (`linked_user_id` is a branded opaque `UserId` in members/domain/). Shared so
 * the per-layer members blocks can COMPOSE it without the `members/**` block
 * shadowing the layer-specific drizzle/framework bans (go-live audit S1-P0-2).
 */
const MEMBERS_AUTH_DOMAIN_PATTERN = {
  group: [
    "@/modules/auth/domain/**",
    "./modules/auth/domain/**",
    "../modules/auth/domain/**",
    "../../modules/auth/domain/**",
  ],
  message:
    "F3 Plan E2 — members module must not import `@/modules/auth/domain/**`. " +
    "Model `linked_user_id` as a branded opaque `UserId` in members/domain/ instead.",
};

/**
 * FR-003 — page-root ad-hoc utility-class blocker.
 *
 * Defined once at module scope so all three export-shape selectors
 * (function decl, arrow block body, arrow expression body) can share
 * one source of truth for the forbidden-class pattern.
 */
const AD_HOC_LAYOUT_CLASS_REGEX =
  "(^|\\s)(max-w-|mx-auto|container(\\s|$)|p-\\d|px-\\d|py-\\d|space-y-|text-(xl|2xl|3xl|4xl))";
const PAGE_ROOT_CLASS_ATTR = `JSXAttribute[name.name='className'][value.type='Literal'][value.value=/${AD_HOC_LAYOUT_CLASS_REGEX}/]`;
const PAGE_ROOT_MESSAGE =
  "Page roots must compose via <ContentContainer> + <PageHeader>. " +
  "Remove ad-hoc max-w-*/mx-auto/container/p-*/px-*/py-*/space-y-*/heading text-* classes from the top-level element.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Project-wide convention — args/vars/destructured fields prefixed
    // with `_` are intentional placeholders (factory signature symmetry,
    // skeleton functions, kept-for-API-stability params). Recognised by
    // every TS project using @typescript-eslint by default.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/modules/**/domain/**/*.ts", "src/modules/**/domain/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: domainForbiddenImports.map((name) => ({
            name,
            message:
              "Domain layer must be framework-free (Constitution Principle III). " +
              "Move framework-dependent code to application/ or infrastructure/.",
          })),
          patterns: [
            {
              group: ["next/*", "drizzle-orm/*", "stripe/*", "@stripe/*", "@tiptap/*"],
              message: "Domain layer must not import framework subpaths.",
            },
          ],
        },
      ],
    },
  },
  {
    // Application-layer import ban (Constitution Principle III) — drizzle/
    // framework/infrastructure-VALUE imports forbidden; `import type` allowed
    // (DI port wiring). go-live audit #1 FIX: this block USED to be shadowed at
    // runtime by the global F6 events-brand block (last `no-restricted-imports`
    // matcher; flat-config REPLACES, not merges). That block now excludes
    // `application/**`, so this rule is the effective one for application files
    // again — and it composes the events-brand ban (via applicationForbidden*)
    // so nothing is lost. Measured blast radius of un-shadowing was 0 real
    // violations (the only hits were the invoicing composition root, exempted
    // below). `tests/unit/architecture/application-layer-imports.test.ts` remains
    // the flat-config-immune backstop.
    //
    // Composition roots (`*-deps.ts`) are the documented place to wire
    // Infrastructure adapters, so they are exempt — mirrors the source-scan
    // test's `/-deps\.ts$/` skip.
    files: [
      "src/modules/**/application/**/*.ts",
      "src/modules/**/application/**/*.tsx",
    ],
    ignores: ["src/modules/**/application/**/*-deps.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: applicationForbiddenPaths,
          patterns: applicationForbiddenPatterns,
        },
      ],
    },
  },
  {
    // Clean Architecture boundary — cross-module imports MUST go
    // through the module's public barrel (`src/modules/auth/index.ts`,
    // `src/modules/plans/index.ts`, `src/modules/tenants/index.ts`).
    // Deep imports into `./domain`, `./application`, or
    // `./infrastructure` from outside the module leak layer internals
    // and bypass the boundary that the barrel exists to guard.
    //
    // Intra-module files (inside `src/modules/<name>/**`) are NOT subject
    // to this rule — the deep paths are the canonical way for
    // Application use cases to talk to Domain types and Infrastructure
    // ports via type-only imports. The scope below (`files`) excludes
    // the modules themselves so internal wiring keeps working.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/modules/auth/**",
      "src/modules/plans/**",
      "src/modules/tenants/**",
      "src/modules/members/**",
      "src/modules/invoicing/**",
      "src/modules/payments/**",
      "src/modules/broadcasts/**",
      "src/modules/renewals/**",
      "src/modules/events/**",
      "src/modules/insights/**",
      // `src/lib/**` is the shared composition adapter layer.
      // Files here provide the glue between module internals and
      // Next.js route handlers (cookies, session lookup, db client,
      // rbac guards, tenant resolver, composition roots).
      // These files LEGITIMATELY depend on branded types and
      // repository interfaces from `@/modules/**` — the boundary the
      // barrel guards is Presentation ↔ Module, and `src/lib/**` sits
      // on the Module side of that boundary.
      "src/lib/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Phase 9 Round-3 close — block production callers of
          // test-only `__test__readGaugeValues` accessor in
          // `src/lib/metrics.ts`. Folded INTO the existing
          // cross-module barrel block (vs. a separate config object)
          // because ESLint flat-config does NOT merge `no-restricted-
          // imports` rules across blocks — a separate block would
          // SHADOW the patterns below for every file in `src/**`,
          // silently disabling Constitution Principle III barrel
          // enforcement. The named-import restriction works alongside
          // pattern-based restrictions in the same rule entry.
          paths: [
            {
              name: "@/lib/metrics",
              importNames: ["__test__readGaugeValues"],
              message:
                "`__test__readGaugeValues` is a TEST-ONLY accessor exposing the per-process gauge-values accumulator. Production callers would leak gauge state across tenants. Use the OTel scrape pipeline instead.",
            },
          ],
          patterns: [
            {
              group: [
                "@/modules/auth/domain/**",
                "@/modules/auth/application/**",
                "@/modules/auth/infrastructure/**",
                "./modules/auth/domain/**",
                "./modules/auth/application/**",
                "./modules/auth/infrastructure/**",
                "../modules/auth/domain/**",
                "../modules/auth/application/**",
                "../modules/auth/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the auth public barrel (`@/modules/auth`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              group: [
                "@/modules/plans/domain/**",
                "@/modules/plans/application/**",
                "@/modules/plans/infrastructure/**",
                "./modules/plans/domain/**",
                "./modules/plans/application/**",
                "./modules/plans/infrastructure/**",
                "../modules/plans/domain/**",
                "../modules/plans/application/**",
                "../modules/plans/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the plans public barrel (`@/modules/plans`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              group: [
                "@/modules/tenants/domain/**",
                "./modules/tenants/domain/**",
                "../modules/tenants/domain/**",
              ],
              message:
                "Cross-module import must go through the tenants public barrel (`@/modules/tenants`). " +
                "Deep imports into domain from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              group: [
                "@/modules/members/domain/**",
                "@/modules/members/application/**",
                "@/modules/members/infrastructure/**",
                "./modules/members/domain/**",
                "./modules/members/application/**",
                "./modules/members/infrastructure/**",
                "../modules/members/domain/**",
                "../modules/members/application/**",
                "../modules/members/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the members public barrel (`@/modules/members`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F4 — invoicing module public-barrel boundary.
              group: [
                "@/modules/invoicing/domain/**",
                "@/modules/invoicing/application/**",
                "@/modules/invoicing/infrastructure/**",
                "./modules/invoicing/domain/**",
                "./modules/invoicing/application/**",
                "./modules/invoicing/infrastructure/**",
                "../modules/invoicing/domain/**",
                "../modules/invoicing/application/**",
                "../modules/invoicing/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the invoicing public barrel (`@/modules/invoicing`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F5 — payments module public-barrel boundary (T030).
              group: [
                "@/modules/payments/domain/**",
                "@/modules/payments/application/**",
                "@/modules/payments/infrastructure/**",
                "./modules/payments/domain/**",
                "./modules/payments/application/**",
                "./modules/payments/infrastructure/**",
                "../modules/payments/domain/**",
                "../modules/payments/application/**",
                "../modules/payments/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the payments public barrel (`@/modules/payments`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F7 — broadcasts module public-barrel boundary (T007).
              group: [
                "@/modules/broadcasts/domain/**",
                "@/modules/broadcasts/application/**",
                "@/modules/broadcasts/infrastructure/**",
                "./modules/broadcasts/domain/**",
                "./modules/broadcasts/application/**",
                "./modules/broadcasts/infrastructure/**",
                "../modules/broadcasts/domain/**",
                "../modules/broadcasts/application/**",
                "../modules/broadcasts/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the broadcasts public barrel (`@/modules/broadcasts`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F8 — renewals module public-barrel boundary (Phase 1 Setup T004).
              group: [
                "@/modules/renewals/domain/**",
                "@/modules/renewals/application/**",
                "@/modules/renewals/infrastructure/**",
                "./modules/renewals/domain/**",
                "./modules/renewals/application/**",
                "./modules/renewals/infrastructure/**",
                "../modules/renewals/domain/**",
                "../modules/renewals/application/**",
                "../modules/renewals/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the renewals public barrel (`@/modules/renewals`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F6 — events module public-barrel boundary (Phase 1 Setup T003).
              group: [
                "@/modules/events/domain/**",
                "@/modules/events/application/**",
                "@/modules/events/infrastructure/**",
                "./modules/events/domain/**",
                "./modules/events/application/**",
                "./modules/events/infrastructure/**",
                "../modules/events/domain/**",
                "../modules/events/application/**",
                "../modules/events/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the events public barrel (`@/modules/events`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
            {
              // F9 — insights module public-barrel boundary (Phase 1 Setup T003).
              group: [
                "@/modules/insights/domain/**",
                "@/modules/insights/application/**",
                "@/modules/insights/infrastructure/**",
                "./modules/insights/domain/**",
                "./modules/insights/application/**",
                "./modules/insights/infrastructure/**",
                "../modules/insights/domain/**",
                "../modules/insights/application/**",
                "../modules/insights/infrastructure/**",
              ],
              message:
                "Cross-module import must go through the insights public barrel (`@/modules/insights`). " +
                "Deep imports into domain/application/infrastructure from outside the module bypass Clean Architecture boundaries (Constitution Principle III).",
            },
          ],
        },
      ],
    },
  },
  {
    // F4 — Bidirectional port-type block: invoicing/application MUST NOT
    // import members/application ports, and vice versa. Cross-module
    // reads go through the public barrels (`@/modules/members`,
    // `@/modules/invoicing`) only. The architecture-invariant unit test
    // (T019) mirrors this rule in source-code scanning.
    files: ["src/modules/invoicing/application/**/*.ts", "src/modules/invoicing/application/**/*.tsx"],
    // go-live #1 — exempt the invoicing composition root (the one `*-deps.ts`
    // under application/) so this block doesn't re-flag its legitimate infra
    // wiring; matches the generic application block's exemption + the source-scan
    // test's `/-deps\.ts$/` skip.
    ignores: ["src/modules/invoicing/application/**/*-deps.ts"],
    rules: {
      // NOTE: flat config REPLACES (not merges) `no-restricted-imports` when a
      // later block matches the same files. This block matches invoicing/
      // application/** which the generic application block above also matches,
      // so it MUST re-include the base paths+patterns or they vanish (S1-P0-2).
      "no-restricted-imports": [
        "error",
        {
          paths: applicationForbiddenPaths,
          patterns: [
            ...applicationForbiddenPatterns,
            {
              group: [
                "@/modules/members/application/ports/**",
                "../../../members/application/ports/**",
                "../../members/application/ports/**",
              ],
              message:
                "F4 — invoicing/application MUST NOT import members/application/ports. " +
                "Use the members public barrel (`@/modules/members`) for cross-module reads.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/members/application/**/*.ts", "src/modules/members/application/**/*.tsx"],
    rules: {
      // Re-includes the base application paths+patterns (see note above) so the
      // drizzle-orm + infrastructure-VALUE bans stay live for members/application.
      "no-restricted-imports": [
        "error",
        {
          paths: applicationForbiddenPaths,
          patterns: [
            ...applicationForbiddenPatterns,
            {
              group: [
                "@/modules/invoicing/application/ports/**",
                "../../../invoicing/application/ports/**",
                "../../invoicing/application/ports/**",
              ],
              message:
                "F4 — members/application MUST NOT import invoicing/application/ports. " +
                "Use the invoicing public barrel (`@/modules/invoicing`) for cross-module reads.",
            },
            // F3 auth-domain ban folded in (the `members/**` block below now
            // ignores application/ so it no longer shadows this rule).
            MEMBERS_AUTH_DOMAIN_PATTERN,
          ],
        },
      ],
    },
  },
  {
    // Enforce PageHeader + ContentContainer composition on page.tsx roots.
    // Forbids ad-hoc layout/spacing/heading utility classes on the
    // outermost JSX element returned by a page component. Inner elements
    // are unrestricted so per-card / per-section styling keeps working.
    // The shared regex + message live at module top (FR-003 block).
    files: [
      "src/app/(staff)/admin/**/page.tsx",
      "src/app/(member)/portal/**/page.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // `export default function X() { return (<Root className=".." />) }`
          selector: `ExportDefaultDeclaration > FunctionDeclaration > BlockStatement > ReturnStatement > JSXElement > JSXOpeningElement > ${PAGE_ROOT_CLASS_ATTR}`,
          message: PAGE_ROOT_MESSAGE,
        },
        {
          // `export default () => { return (<Root className=".." />) }`
          selector: `ExportDefaultDeclaration > ArrowFunctionExpression > BlockStatement > ReturnStatement > JSXElement > JSXOpeningElement > ${PAGE_ROOT_CLASS_ATTR}`,
          message: PAGE_ROOT_MESSAGE,
        },
        {
          // `export default () => (<Root className=".." />)` — expression body
          selector: `ExportDefaultDeclaration > ArrowFunctionExpression > JSXElement > JSXOpeningElement > ${PAGE_ROOT_CLASS_ATTR}`,
          message: PAGE_ROOT_MESSAGE,
        },
      ],
    },
  },
  {
    // F3 Plan E2 — members module must not depend on auth Domain types.
    // `linked_user_id` is modelled as a branded opaque `UserId` inside
    // members/domain/. Importing `@/modules/auth/domain/**` from anywhere
    // under members/** couples Member Domain to Auth Domain.
    //
    // S1-P0-2 fix: this block previously matched ALL of `members/**`, which —
    // because it comes after the generic domain + application blocks and flat
    // config REPLACES (not merges) `no-restricted-imports` — silently disabled
    // the drizzle/framework bans for members/application and members/domain.
    // It now `ignores` those two layers (each re-asserts the auth-domain ban
    // itself: members/application above, members/domain below), so this block
    // governs only members/infrastructure + module-root files.
    files: ["src/modules/members/**/*.ts", "src/modules/members/**/*.tsx"],
    ignores: [
      "src/modules/members/application/**",
      "src/modules/members/domain/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [MEMBERS_AUTH_DOMAIN_PATTERN] }],
    },
  },
  {
    // members/domain — framework-free (generic domain ban) PLUS the F3
    // auth-domain ban. Placed after the generic domain block so it wins for
    // members/domain files without losing the drizzle/framework ban (S1-P0-2).
    files: ["src/modules/members/domain/**/*.ts", "src/modules/members/domain/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: domainForbiddenPaths,
          patterns: [...domainForbiddenPatterns, MEMBERS_AUTH_DOMAIN_PATTERN],
        },
      ],
    },
  },
  {
    // Forbid direct === comparisons on password variables — always use argon2 verify() instead.
    files: ["src/modules/auth/**/*.ts", "src/modules/auth/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator='==='][left.name=/^password/i], BinaryExpression[operator='==='][right.name=/^password/i]",
          message:
            "Never compare passwords with ===. Use argon2 verify() or the hasher adapter.",
        },
        {
          selector:
            "BinaryExpression[operator='==='][left.property.name=/^password/i], BinaryExpression[operator='==='][right.property.name=/^password/i]",
          message:
            "Never compare password fields with ===. Use argon2 verify() or the hasher adapter.",
        },
      ],
    },
  },
  {
    // D2 (Phase 10 Deferred) — ban bare `Content-Disposition` header
    // literals outside the canonical helper. All four PDF routes +
    // any future attachment stream MUST route through
    // `buildAttachmentContentDisposition` in `src/lib/content-disposition.ts`
    // so the CR/LF header-injection defense stays uniform (T121
    // regression guard). Inline construction historically drifted and
    // lost the `\r\n` strip — this rule catches that at lint time.
    //
    // Matches: object properties or string literals equal to
    // `Content-Disposition` / `content-disposition` (the HTTP header
    // name). Does NOT match the helper file itself (ignores), nor
    // tests that assert the header shape.
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
    ignores: [
      "src/lib/content-disposition.ts",
      "tests/unit/lib/content-disposition.test.ts",
    ],
    rules: {
      // The antipattern is INLINE CONSTRUCTION of a Content-Disposition
      // VALUE — i.e. a string literal / template literal shaped like
      // `attachment; filename="..."` somewhere OTHER than the helper
      // file. Setting `'Content-Disposition': helperOutput` on a
      // headers object is the correct pattern and stays allowed; the
      // rule only fires when someone hand-builds the value.
      //
      // Known residual (R2 security review RES-01): the rule matches
      // static Literal + TemplateLiteral nodes only. Runtime-built
      // values — `String.raw\`attachment; ...\``, `'attachment' + '; ...'`,
      // `['attachment', ...].join('; ')` — slip through because
      // ESLint has no taint-tracking. This is an acceptable lint-scope
      // limitation; code review remains the backstop for those
      // patterns. Documented in `specs/007-invoices-receipts/security.md § 5`.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^attachment;\\s*filename/i]",
          message:
            "Do not hand-construct `Content-Disposition` values. " +
            "Use `buildAttachmentContentDisposition()` from " +
            "`@/lib/content-disposition` so the CR/LF header-injection " +
            "defense + RFC 6266 extended-form stay uniform across all " +
            "PDF / attachment streams (T121).",
        },
        {
          // Template literals like `` `attachment; filename="${x}"` ``
          selector:
            "TemplateLiteral[quasis.0.value.raw=/^attachment;\\s*filename/i]",
          message:
            "Do not hand-construct `Content-Disposition` values with a template literal. " +
            "Use `buildAttachmentContentDisposition()` from `@/lib/content-disposition`.",
        },
      ],
    },
  },
  {
    // T188 (Phase 10 / i18n.md CHK053) — static-key invariant for `t()`.
    // Forward-looking guidance for new F7 (broadcasts) code only.
    // Pre-existing F1–F5 dynamic-key sites are left intact: the project
    // has no human TH/SV liaison pipeline (T189 deferred indefinitely),
    // and AI reviewers can read `t(\`namespace.${var}\`)` without
    // needing static-discoverability. The rule remains useful inside
    // the broadcasts surface where any future translator workflow
    // would be enabled, and where the marketing-copy review surface
    // is most regulated (PDPA marketing-consent).
    files: [
      "src/modules/broadcasts/**/*.ts",
      "src/modules/broadcasts/**/*.tsx",
      "src/app/api/broadcasts/**/*.ts",
      "src/app/api/admin/broadcasts/**/*.ts",
      "src/app/api/cron/broadcasts/**/*.ts",
      "src/app/api/webhooks/resend-broadcasts/**/*.ts",
      "src/app/(member)/portal/broadcasts/**/*.tsx",
      "src/app/(staff)/admin/broadcasts/**/*.tsx",
      "src/app/unsubscribe/**/*.tsx",
      "src/components/broadcast/**/*.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='t'] > TemplateLiteral[expressions.length>0]",
          message:
            "i18n.md CHK053 (F7 scope) — keys passed to `t()` MUST be " +
            "string literals. Use a switch/ternary that emits explicit " +
            "`t('literal')` per branch so every key is statically " +
            "discoverable. Forward-looking guidance — does NOT apply " +
            "to F1–F5 surfaces.",
        },
      ],
    },
  },
  // R6.1 H2 sweep — the R4.2 H-3/H-4 `no-restricted-syntax` block that
  // blocked `MemberExpression[property.name='startedFromTemplateId']`
  // and `.templateNameSnapshot` reads outside the Drizzle mapper has
  // been REMOVED. The Domain `Broadcast` interface no longer exposes
  // those raw fields; TypeScript enforces "no read of raw fields
  // outside the Infrastructure mapper" at type level. The Drizzle
  // mapper reads from `BroadcastRow` (Infrastructure schema type)
  // which still carries the columns. See
  // `src/modules/broadcasts/domain/broadcast.ts` R6.1 H2 commit.
  {
    // H3.3 — `*Unchecked` branded-type constructors skip the UUID v4
    // regex. They are INFRASTRUCTURE-ONLY: only Drizzle row-read
    // adapters (where the DB type system guarantees UUID shape via
    // `uuid DEFAULT gen_random_uuid()`) may use them. Every other
    // caller MUST use the validated default (`asEventId` /
    // `asRegistrationId`) which enforces the regex at the HTTP / CSV
    // boundary.
    //
    // Phase 5 Round 1 R1.3 H-code-2 finding: this block's
    // `files: ["src/**/*.{ts,tsx}"]` + flat-config last-wins semantics
    // shadow the cross-module barrel-guard + Application-layer rules
    // defined above, silently masking ~89 Constitution Principle III
    // violations across F1+F4+F5+F6+F8 modules. The shadow CANNOT be
    // removed in Phase 5 Round 1 scope — a clean fix requires
    // refactoring 42 callers to route through public barrels (out of
    // scope for the broadcasts US7 review).
    //
    // Mitigation:
    //   1. KEEP the shadow block (status quo preserves CI for F1-F8).
    //   2. CLOSE H-code-2 via a SOURCE-SCAN architecture test
    //      (`tests/unit/architecture/broadcasts-barrel.test.ts`) that
    //      is independent of ESLint flat-config quirks and catches the
    //      3 broadcasts deep imports from Phase 5 (template page /
    //      template edit page / tiptap-editor).
    //   3. Track the 89 surfaced violations as a SEPARATE backlog item
    //      in F1.1/F4.1/F5.1/F6.1/F8.1 cycles. The architecture-test
    //      pattern is reusable across modules.
    //
    // Reference: specs/014-email-broadcast-advance/retrospective.md
    // § "Phase 5 Round 1 R1.3 — ESLint shadow bug + architecture test
    // defence-in-depth".
    //
    // go-live audit #1 FIX: this block used to ALSO shadow the S1-P0-2
    // application-layer drizzle/infrastructure-VALUE bans (it matched application
    // files last → flat-config REPLACE wiped their rule). We now EXCLUDE
    // `application/**` here (last `ignores` entry) so the per-layer application
    // blocks above are the effective rule for those files, AND we compose the
    // events-brand ban into them (eventsBrandForbiddenPaths/Patterns) so excluding
    // application here loses no coverage. The source-scan test
    // `tests/unit/architecture/application-layer-imports.test.ts` remains the
    // flat-config-immune backstop. (The broadcasts-barrel shadow noted above is a
    // SEPARATE concern, still covered by its own source-scan test.)
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/modules/events/infrastructure/**",
      "src/modules/events/domain/branded-types.ts",
      "src/modules/**/application/**",
    ],
    rules: {
      // Single source of truth (go-live audit #1) — same const the application
      // blocks compose, so the events-brand ban is identical everywhere.
      "no-restricted-imports": [
        "error",
        {
          paths: eventsBrandForbiddenPaths,
          patterns: eventsBrandForbiddenPatterns,
        },
      ],
    },
  },
  {
    // Ban inline `BenefitMatrix` literal construction in production
    // code. See `src/modules/plans/domain/benefit-matrix.ts` (Option C
    // enforcement section) for the rationale + the partnership↔category
    // invariant + the test-fixture exemption (~92 inline literals
    // across F4/F6/F7/F8/auth/e2e seeds).
    //
    // Selectors cover: `const x: BenefitMatrix = {...}`,
    // `{...} as BenefitMatrix`, `{...} satisfies BenefitMatrix`,
    // ternary, function-return (declaration + arrow), and class
    // property declaration. Bypass NOT covered by lint: intermediate-
    // variable assignment (`const draft = {...}; const x:
    // BenefitMatrix = draft;`) requires dataflow analysis that ESLint
    // does not perform — code review catches it.
    files: [
      "src/modules/**/*.ts",
      "src/modules/**/*.tsx",
      "src/components/**/*.ts",
      "src/components/**/*.tsx",
      "src/app/**/*.ts",
      "src/app/**/*.tsx",
    ],
    ignores: [
      // The smart constructor itself + its tests construct literals
      // via the loose `BenefitMatrixInput` shape; that's the canonical
      // entry point.
      "src/modules/plans/domain/benefit-matrix.ts",
      // `rowToPlan` hydration boundary needs the documented
      // `as BenefitMatrix` cast on `cloneBenefitMatrix`.
      "src/modules/plans/infrastructure/db/plan-repo.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Pattern (a) — `const x: BenefitMatrix = { ... }`
          selector:
            "VariableDeclarator[id.typeAnnotation.typeAnnotation.typeName.name='BenefitMatrix'] > ObjectExpression",
          message:
            "R4-S4 — do not construct `BenefitMatrix` via inline object literal in production code. " +
            "Use `asBenefitMatrix(input, planCategory)` from `@/modules/plans` so the partnership↔category " +
            "integrity invariant is enforced at construction time.",
        },
        {
          // Pattern (b) — `... as BenefitMatrix` cast on ObjectExpression
          selector:
            "TSAsExpression[typeAnnotation.typeName.name='BenefitMatrix'] > ObjectExpression",
          message:
            "R4-S4 — do not cast `{...} as BenefitMatrix` in production code. " +
            "Use `asBenefitMatrix(input, planCategory)` from `@/modules/plans` so the partnership↔category " +
            "integrity invariant is enforced at construction time.",
        },
        {
          // R5-I9 Pattern (c) — `{...} satisfies BenefitMatrix`
          selector:
            "TSSatisfiesExpression[typeAnnotation.typeName.name='BenefitMatrix'] > ObjectExpression",
          message:
            "R5-I9 — do not use `{...} satisfies BenefitMatrix` in production code. " +
            "Use `asBenefitMatrix(input, planCategory)` from `@/modules/plans`.",
        },
        {
          // R5-I9 Pattern (d) — `const x: BenefitMatrix = cond ? a : { ... }`
          // Targets the ObjectExpression inside the ConditionalExpression
          // initializer of a BenefitMatrix-typed VariableDeclarator.
          selector:
            "VariableDeclarator[id.typeAnnotation.typeAnnotation.typeName.name='BenefitMatrix'] ConditionalExpression > ObjectExpression",
          message:
            "R5-I9 — do not construct `BenefitMatrix` via conditional expression with inline object literals. " +
            "Build the value via `asBenefitMatrix(input, planCategory)` first, then assign.",
        },
        {
          // R5-I9 Pattern (e) — `function f(): BenefitMatrix { return { ... }; }`
          // R6-I1 — tightened to `> BlockStatement > ReturnStatement >
          // ObjectExpression` (direct child chain) so that a nested
          // function inside a BenefitMatrix-returning function with
          // its own `return {...}` does NOT false-positive. Mirrors
          // the Pattern (g) direct-child structure.
          selector:
            "FunctionDeclaration[returnType.typeAnnotation.typeName.name='BenefitMatrix'] > BlockStatement > ReturnStatement > ObjectExpression",
          message:
            "R5-I9 — function declared as returning `BenefitMatrix` cannot return an inline object literal. " +
            "Build the value via `asBenefitMatrix(input, planCategory)`.",
        },
        {
          // R5-I9 Pattern (f) — `const f = (): BenefitMatrix => ({...})`
          // Concise-body arrow function returning an annotated BenefitMatrix.
          selector:
            "ArrowFunctionExpression[returnType.typeAnnotation.typeName.name='BenefitMatrix'] > ObjectExpression",
          message:
            "R5-I9 — arrow function declared as returning `BenefitMatrix` cannot return an inline object literal. " +
            "Build the value via `asBenefitMatrix(input, planCategory)`.",
        },
        {
          // R5-I9 Pattern (g) — `const f = (): BenefitMatrix => { return {...}; }`
          // Block-body arrow function.
          selector:
            "ArrowFunctionExpression[returnType.typeAnnotation.typeName.name='BenefitMatrix'] BlockStatement > ReturnStatement > ObjectExpression",
          message:
            "R5-I9 — arrow function declared as returning `BenefitMatrix` cannot return an inline object literal. " +
            "Build the value via `asBenefitMatrix(input, planCategory)`.",
        },
        {
          // R5-S2 Pattern (h) — class/object property declaration
          // `class X { matrix: BenefitMatrix = {...}; }`
          selector:
            "PropertyDefinition[typeAnnotation.typeAnnotation.typeName.name='BenefitMatrix'] > ObjectExpression",
          message:
            "R5-S2 — class property typed as `BenefitMatrix` cannot be initialized with an inline object literal. " +
            "Build the value via `asBenefitMatrix(input, planCategory)`.",
        },
      ],
    },
  },
  {
    // R5-S13 — symmetric to R4-S4 Option C: ban
    // `MutableScheduledPlanChange` as a public Application-layer
    // function-parameter or return-type annotation. The loose hydration
    // shape is exported from `@/modules/plans` ONLY because the Drizzle
    // adapter's `rowToDomain` (Infrastructure) needs it before
    // narrowing via `assertValidScheduledPlanChange`. Application-layer
    // code MUST accept/return the discriminated `ScheduledPlanChange`
    // union instead.
    //
    // Known limitation: the rule fires on ANY type-annotation use of
    // the identifier inside Application files. This catches function
    // parameters, return types, and local declarations alike. If a
    // future Application-layer test fixture needs to construct an
    // explicitly-malformed `MutableScheduledPlanChange` for `assertValid`
    // testing, that test file should be moved to `tests/unit/plans/domain/`
    // (which is not in this rule's `files` scope).
    files: [
      "src/modules/plans/application/**/*.ts",
      "src/modules/plans/application/**/*.tsx",
      "src/modules/members/application/**/*.ts",
      "src/modules/members/application/**/*.tsx",
      "src/modules/renewals/application/**/*.ts",
      "src/modules/renewals/application/**/*.tsx",
      "src/modules/invoicing/application/**/*.ts",
      "src/modules/invoicing/application/**/*.tsx",
      "src/modules/payments/application/**/*.ts",
      "src/modules/payments/application/**/*.tsx",
      "src/modules/events/application/**/*.ts",
      "src/modules/events/application/**/*.tsx",
      "src/modules/broadcasts/application/**/*.ts",
      "src/modules/broadcasts/application/**/*.tsx",
      "src/modules/auth/application/**/*.ts",
      "src/modules/auth/application/**/*.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Type-annotation reference to MutableScheduledPlanChange
          // (function parameters, variable declarations, return types).
          selector:
            "TSTypeReference[typeName.name='MutableScheduledPlanChange']",
          message:
            "R5-S13 / R4-S6 — Application-layer code must never accept or expose " +
            "`MutableScheduledPlanChange`; use the discriminated `ScheduledPlanChange` " +
            "union instead. The loose type is for Infrastructure hydration only " +
            "(`drizzle-scheduled-plan-change-repo.ts:rowToDomain`).",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "drizzle/migrations/**",
    "next-env.d.ts",
    // Plugin scratch dirs — both are gitignored (.gitignore § superpowers
    // + .remember). They hold brainstorm/plan artefacts + history buffers,
    // not project source. ESLint flat config does not read .gitignore, so
    // they must be ignored explicitly or `require()`-style scratch scripts
    // (e.g. .superpowers/assemble-plan.js) surface as lint errors.
    ".superpowers/**",
    ".remember/**",
    // Agent git worktrees — full nested repo checkouts of OTHER feature
    // branches (e.g. .claude/worktrees/<branch>/). ESLint flat config does not
    // read .gitignore, so without this bare `eslint` recurses into a sibling
    // worktree's entire src/tests tree and lints another branch's code —
    // breaking `pnpm lint` (and CI would too) whenever any worktree exists.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
