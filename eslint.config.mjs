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
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
              group: ["next/*", "drizzle-orm/*"],
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
          ],
        },
      ],
    },
  },
  {
    // Security: forbid direct equality checks on password* / passwordHash* variables
    // (addresses spec SC-018 / tasks.md T-190). Use argon2 verify() instead.
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
