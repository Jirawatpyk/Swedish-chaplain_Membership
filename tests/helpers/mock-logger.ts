/**
 * Shared `@/lib/logger` mock builder — the ONLY safe way to partially
 * mock the pino-backed structured logger in a test file.
 *
 * ## Why this exists — never spread a pino logger instance
 *
 * The obvious-looking partial mock:
 *
 * ```ts
 * vi.mock('@/lib/logger', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('@/lib/logger')>();
 *   return {
 *     ...actual,
 *     logger: { ...actual.logger, error: vi.fn() }, // BROKEN
 *   };
 * });
 * ```
 *
 * looks completely reasonable — spread the real logger, override the one
 * method you want to assert on — but it produces a landmine. `Object`
 * spread only copies the target's *own enumerable* properties. Pino
 * stores its write machinery (`writeSym`, `streamSym`, …) on
 * **non-enumerable internal symbols** on the logger instance, so the
 * spread silently drops them. Every level method the mock does NOT
 * explicitly override (`info`, `debug`, `trace`, `fatal`, `child`, …) is
 * still the REAL pino implementation, now bound to a plain object that
 * no longer has the internals it needs. The very first call to that
 * un-stubbed method throws:
 *
 * ```
 * TypeError: this[writeSym] is not a function
 *   at Object.LOG [as info] (node_modules/.pnpm/pino@.../pino/lib/tools.js)
 * ```
 *
 * This exact trap bit `admin-reject-reactivation.test.ts`: the mock
 * stubbed `error`/`warn` but not `info`, and PR #185 (F5 async refund
 * lifecycle) later added a `logger.info(...)` call to the source under
 * test. The call hit the broken copied `info` method and threw — a
 * pre-existing test-infrastructure bug, not a regression in the source.
 * Seven other test files had the identical landmine armed, waiting for
 * the next contributor to add a log call their mock didn't happen to
 * stub.
 *
 * ## The fix
 *
 * Never touch the real pino instance. Build a complete fake logger from
 * scratch — every level method is its OWN `vi.fn()`, so a newly added
 * `logger.<anything>(...)` call in the source can never throw; it is
 * simply recorded as a no-op spy call. Pass in specific `vi.fn()` spies
 * for the methods you want to assert on via `overrides`; every other
 * method is still a working (if silent) `vi.fn()`.
 *
 * `child()` — used by `loggerFor()` in `src/lib/logger.ts` to bind
 * request-scoped context — returns another complete stub, so nested
 * `loggerFor(...).info(...)` call chains are equally safe.
 *
 * ## Usage
 *
 * ```ts
 * const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
 * vi.mock('@/lib/logger', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('@/lib/logger')>();
 *   return {
 *     ...actual, // fine — this is the MODULE namespace (loggerFor,
 *                // REDACT_PATHS, redactPanValues, …), not the logger
 *                // instance. Only spreading `actual.logger` is poison.
 *     logger: createMockLogger({ error: loggerErrorMock }),
 *   };
 * });
 * ```
 *
 * `createMockLogger` closes over nothing from the calling file, so it is
 * safe to import and call directly inside a `vi.mock(...)` factory —
 * `vi.mock` factories are hoisted above the file's own top-level `const`
 * declarations, so referencing anything OTHER than an imported binding
 * (e.g. a plain `const spy = vi.fn()` declared later in the same file)
 * requires `vi.hoisted(...)`. Imported bindings like `createMockLogger`
 * do not have this restriction.
 */
import { vi } from 'vitest';

/** The subset of pino's level methods the codebase actually calls. */
type LogLevelMethod = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Caller-supplied spies for the level methods a test wants to assert on
 * (e.g. a `vi.hoisted`-declared `loggerErrorMock`). Any level omitted
 * here still gets a working `vi.fn()` — it just isn't one the caller
 * can inspect by name (call `logger.warn` on the returned object
 * directly if needed).
 *
 * Typed as a plain callable (not `ReturnType<typeof vi.fn>`) so a caller
 * can also hand in a lazy wrapper — e.g.
 * `warn: (...args) => loggerWarnMock(...args)` — instead of the spy
 * itself, which matters when the spy is a plain top-level `const` (not
 * `vi.hoisted`) that may not be initialised yet at the point this
 * factory runs; the wrapper only dereferences it on first call.
 */
type LogFn = (...args: unknown[]) => unknown;
export type MockLoggerOverrides = Partial<Record<LogLevelMethod, LogFn>>;

/** Shape returned by `createMockLogger` — a complete, safe pino stand-in. */
export type MockLogger = Record<LogLevelMethod, LogFn> & {
  /** Mirrors `pino().child(bindings)` — returns another complete stub. */
  child: ReturnType<typeof vi.fn>;
};

/**
 * Build a complete, from-scratch fake logger — safe to assign directly
 * as the `logger` export of a mocked `@/lib/logger` module. NEVER
 * spread a real pino instance into this (see file header).
 */
export function createMockLogger(overrides: MockLoggerOverrides = {}): MockLogger {
  const mockLogger: MockLogger = {
    fatal: overrides.fatal ?? vi.fn(),
    error: overrides.error ?? vi.fn(),
    warn: overrides.warn ?? vi.fn(),
    info: overrides.info ?? vi.fn(),
    debug: overrides.debug ?? vi.fn(),
    trace: overrides.trace ?? vi.fn(),
    child: vi.fn(),
  };
  // `child()` returns a fresh complete stub each call — matches pino's
  // real behaviour (a child logger is itself a fully-featured logger).
  mockLogger.child.mockImplementation(() => createMockLogger());
  return mockLogger;
}
