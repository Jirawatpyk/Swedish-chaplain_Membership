/**
 * R5.3.1 / Round 4 I-4 — JSON-stringify a non-Error value for
 * cause-wrapping. Guards against circular references (which would
 * crash a naive `JSON.stringify`) and caps the output so a future
 * adversarial throw can't bloat the audit row.
 *
 * /code-review (2026-05-19 post-ship review) — extracted from
 * `process-attendee-in-tx.ts` into its own helper file. Previously
 * `safe-audit-emit.ts` imported `safeStringify` from
 * `process-attendee-in-tx.ts`, which `apply-quota-effect.ts`
 * (a sibling use-case) imported in turn — closing a 3-file circular
 * dependency cycle:
 *
 *   process-attendee-in-tx.ts
 *     ↑ imports `safeStringify`
 *   safe-audit-emit.ts
 *     ↑ imports `safeAuditEmit`
 *   apply-quota-effect.ts
 *     ↑ imports `applyQuotaEffect`, `buildQuotaLockKey`
 *   process-attendee-in-tx.ts  ← cycle closed
 *
 * The cycle was benign at runtime because `safeStringify` is a
 * function declaration (hoisted), but TDZ-fragile if a future refactor
 * converted it to `export const safeStringify = (...) => ...`. Moving
 * the function into a leaf module breaks the cycle preventively.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */

export function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      return v;
    });
    return (json ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
