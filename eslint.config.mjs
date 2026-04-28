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
];

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
              group: ["next/*", "drizzle-orm/*", "stripe/*", "@stripe/*"],
              message: "Domain layer must not import framework subpaths.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/modules/**/application/**/*.ts",
      "src/modules/**/application/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: applicationForbiddenImports.map((name) => ({
            name,
            message:
              "Application layer must not depend on Next.js, React, or a specific ORM. " +
              "Use Infrastructure adapters via dependency injection.",
          })),
          patterns: [
            {
              // F5 subpath guard — `stripe/types`, `stripe/resources/*`, and
              // `@stripe/*/internal` deep imports slip past the bare-name
              // `paths:` list. Application MUST mock/inject via Infrastructure
              // port; ANY Stripe subpath coupling breaks that boundary.
              group: ["stripe/*", "@stripe/*"],
              message:
                "Application layer must not import Stripe SDK subpaths. " +
                "Go through the Infrastructure port (StripeClient) — " +
                "Constitution Principle III + PCI DSS Principle IV.",
            },
            {
              // Path C hardening — B1-class regression guard.
              // Round 3 staff review found 4 Application files importing
              // Drizzle schema VALUES directly from
              // `@/modules/*/infrastructure/**`. The package-name rule
              // above (drizzle-orm, next, …) did not cover project-local
              // infrastructure paths.
              //
              // `allowTypeImports: true` — `import type { ... }` lines
              // erase at compile time and create no runtime coupling.
              // F1 use cases (sign-in.ts, reset-password.ts, etc.)
              // legitimately import port INTERFACES via `import type`
              // for DI wiring; blocking those would force duplicate
              // type definitions. What B1 caught was VALUE imports
              // (`import { auditLog } ...` → `tx.insert(auditLog)`),
              // which this rule still blocks.
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
          ],
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
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
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
    // under members/** couples Member Domain to Auth Domain and defeats
    // the opaque-type boundary. The cross-module barrel rule above
    // ignores `src/modules/members/**`, so this dedicated rule is needed.
    files: ["src/modules/members/**/*.ts", "src/modules/members/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/modules/auth/domain/**",
                "./modules/auth/domain/**",
                "../modules/auth/domain/**",
                "../../modules/auth/domain/**",
              ],
              message:
                "F3 Plan E2 — members module must not import `@/modules/auth/domain/**`. " +
                "Model `linked_user_id` as a branded opaque `UserId` in members/domain/ instead.",
            },
          ],
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
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "drizzle/migrations/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
