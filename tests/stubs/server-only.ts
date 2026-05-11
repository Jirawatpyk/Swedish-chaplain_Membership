/**
 * K11: Vitest stub for the `server-only` virtual module.
 *
 * The `server-only` package is a marker import that Next.js intercepts
 * at compile time to throw if the module is bundled into a client
 * chunk. Outside Next's compiler the package resolves to a stub that
 * throws at import time (per the upstream design — a deliberate trap
 * to fail loudly when accidentally imported in a non-server context).
 *
 * Vitest is neither Next nor a real client bundle, so the only sane
 * behaviour during tests is to noop. This file is wired in
 * `vitest.config.ts` via the `resolve.alias` entry; do NOT import it
 * directly from production code.
 */
export {};
