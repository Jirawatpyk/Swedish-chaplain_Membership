/**
 * No-op stand-in for the Next.js `server-only` marker package under plain
 * Node/tsx script runs.
 *
 * Next vendors `server-only` at build time, so the package is NOT installed in
 * node_modules — any script whose import graph reaches a module with
 * `import 'server-only'` (payments/invoicing infrastructure, and everything
 * that composes them: the members/renewals/invoicing barrels, makeRenewalsDeps,
 * commitMembers, …) dies with MODULE_NOT_FOUND under tsx. Run such scripts as
 *
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json TENANT_SLUG=… pnpm tsx scripts/<name>.ts …
 *
 * so the `paths` alias in tsconfig.scripts.json resolves `server-only` to this
 * empty module. The marker's only purpose — poisoning client-component bundles
 * at Next build time — is meaningless in a CLI, so a no-op is semantically
 * correct. (066 lesson / 2026-07-15 member-import runbook.)
 */
export {};
