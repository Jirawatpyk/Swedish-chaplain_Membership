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
