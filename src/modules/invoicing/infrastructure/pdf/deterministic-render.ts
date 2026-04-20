/**
 * Deterministic-render harness for `@react-pdf/renderer` v4.
 *
 * Closes **SC-003** (re-downloading the same invoice PDF returns
 * **byte-identical** content 100% of the time) and **CP-5.2** (member
 * portal PDF byte-equal to admin-rendered version).
 *
 * Why this exists
 * ---------------
 * `@react-pdf/renderer` v4 → `@react-pdf/pdfkit` generates a 6-char
 * font-subset tag prefix using `Math.random()` (see upstream
 * `pdfkit.js` `_subset` code, generates `String.fromCharCode(
 * Math.random() * 26 + 65)`). The subset tag is then **embedded inside
 * the compressed font subset stream** (TrueType/CFF `name` table,
 * etc.), so two renders of identical input produce different bytes.
 *
 * The fix
 * -------
 * 1. Replace `Math.random` with a **seeded PRNG** for the duration of
 *    a single render. Seed is derived from a stable hash of the
 *    serialised input — same input → same seed → same tag → same
 *    compressed stream → same sha256.
 * 2. Replace `new Date()` with a **fixed Date** — pdfkit writes
 *    `CreationDate: new Date()` into the PDF info dictionary; without
 *    pinning, every render bakes in the wall-clock time. Pinned
 *    timestamp = the input's `issueDate` at midnight UTC (no leak of
 *    server time, deterministic for the document's lifetime).
 * 3. Run renders through an **async mutex** so concurrent calls do
 *    not interleave the stubs (Node single-threaded protects sync
 *    code; explicit serialisation protects across `await`s).
 *
 * Safety notes
 * -----------
 * - The Math.random override is restored in a `try/finally` even if
 *   the render throws. Other consumers see the original Math.random.
 * - Throughput: F4 PDF rendering is bounded by react-pdf itself
 *   (~1-2 s/doc); serialising renders is acceptable at SweCham scale
 *   (single-tenant, ~100 invoices/yr) and would be acceptable at any
 *   plausible Chamber-OS scale (a few hundred invoices/day worst-case).
 * - The stub does NOT call into legitimate PRNG-needing code in our
 *   own modules — `Math.random` is not used anywhere in `src/` per
 *   ESLint check (Constitution requirement: cryptographic randomness
 *   uses `node:crypto`, never `Math.random`).
 */
import { createHash } from 'node:crypto';

/**
 * Mulberry32 PRNG — 32-bit integer state, deterministic, well-tested
 * uniform distribution. Output is a number in [0, 1). Safe stand-in
 * for `Math.random` for the narrow purpose of generating font-subset
 * tag characters; not cryptographically secure (not needed here —
 * the tag is a PDF housekeeping byte sequence, not a security token).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a 32-bit seed from a stable input hash. */
function seedFromInput(stableInput: unknown): number {
  const h = createHash('sha256')
    .update(JSON.stringify(stableInput, replacer))
    .digest();
  // Take the first 4 bytes as a uint32 — uniformly distributed over
  // the seed space, plenty of entropy for a 6-char A-Z tag (26^6 ≈
  // 309M slots vs 4.3B seeds).
  return h.readUInt32BE(0);
}

/**
 * JSON-serialisation replacer that handles the value objects the
 * invoicing template passes (Money, VatRate, DocumentNumber wrap
 * primitives, but bigint is also possible). The point is **stability**,
 * not fidelity — same input → same string → same hash.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Async mutex — serialises calls so two concurrent `withSeededRandom`
 * invocations do not stomp on each other's Math.random stub. Node's
 * event loop is single-threaded, so the stub itself is atomic for
 * sync code; this lock covers the `await renderToStream(...)` window
 * during which the event loop may schedule unrelated callbacks.
 */
let renderChain: Promise<unknown> = Promise.resolve();

/**
 * Pin `new Date()` (no-args ctor) to a fixed instant for the duration
 * of a render. Other call shapes (`new Date(2026, ...)`,
 * `new Date('...')`, `Date.now()`, `Date.parse(...)`) are left
 * untouched so business logic that reads explicit timestamps still
 * works correctly.
 */
function pinDateNoArgs(fixedIso: string): { restore: () => void } {
  const OriginalDate = Date;
  const fixed = new OriginalDate(fixedIso);
  // Proxy preserves prototype + static methods (Date.now / Date.UTC /
  // Date.parse) while overriding the no-args constructor path.
  const PinnedDate = new Proxy(OriginalDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) {
        return Reflect.construct(target, [fixed.getTime()], newTarget);
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = PinnedDate;
  return {
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = OriginalDate;
    },
  };
}

/**
 * Pick a stable timestamp out of the render input. We look for an
 * `issueDate` (string YYYY-MM-DD) — the F4 contract guarantees this
 * is set on every doc kind we render. Fallback: epoch (only reached
 * if a future caller renders without an issueDate, which the
 * Domain layer would already reject).
 */
function pinnedDateFromInput(stableInput: unknown): string {
  if (
    stableInput &&
    typeof stableInput === 'object' &&
    'issueDate' in stableInput &&
    typeof (stableInput as { issueDate: unknown }).issueDate === 'string'
  ) {
    return `${(stableInput as { issueDate: string }).issueDate}T00:00:00Z`;
  }
  return '1970-01-01T00:00:00Z';
}

export async function withSeededRandom<T>(
  stableInput: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const seed = seedFromInput(stableInput);
  const fixedIso = pinnedDateFromInput(stableInput);
  const next = renderChain.then(async () => {
    const originalRandom = Math.random;
    const seeded = mulberry32(seed);
    Math.random = seeded;
    const pinned = pinDateNoArgs(fixedIso);
    try {
      return await fn();
    } finally {
      pinned.restore();
      Math.random = originalRandom;
    }
  });
  renderChain = next.catch(() => undefined);
  return next as Promise<T>;
}
