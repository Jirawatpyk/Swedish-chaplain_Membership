/**
 * Eager Suspense-island promise plumbing for `/admin/renewals`
 * (waterfall fix — operator report: the money band double-skeletons and is
 * always last to fill).
 *
 * The page body awaits `loadPipeline` before RETURNING its JSX, so every
 * Suspense island used to START its own queries only after the pipeline
 * query resolved — a serial waterfall. The fix: the page CREATES each
 * island's data promise BEFORE `await loadPipeline` (fire, don't await) and
 * passes it in; the island awaits it inside its Suspense boundary.
 *
 * `settle` is the safety half of that pattern: an eagerly-created promise
 * that rejects BEFORE its island mounts would otherwise surface as an
 * unhandled rejection (Node warns; nothing catches it until the island's
 * late `await`). Attaching the rejection handler AT CREATION converts the
 * outcome into a plain value — `{ ok: true, v }` or `{ ok: false, e }` —
 * that the island unwraps, preserving its EXACT pre-existing best-effort
 * error semantics (the `e` is the original rejection, re-thrown or logged
 * exactly where the island's old try/catch did it).
 */

export type Settled<T> =
  | { readonly ok: true; readonly v: T }
  | { readonly ok: false; readonly e: unknown };

/** Attach both outcome handlers NOW — never rejects, never unhandled. */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
}
