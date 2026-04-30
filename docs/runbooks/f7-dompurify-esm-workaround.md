# F7 — `isomorphic-dompurify` ESM/CJS interop workaround

**Status**: ⚠️ **PARTIALLY ACTIVE** — 2 of 4 layers re-applied 2026-05-01

**History**:
- 2026-04-30 (Node 20): all 4 layers active
- 2026-04-30 (Node 22 LTS adoption): all 4 layers removed; verified GREEN locally + on Node 22 dev-server
- 2026-05-01 (Vercel prod deploy crashed): **Vercel's serverless Node 22 runtime does NOT enable `--experimental-require-module`** by default — even though local Node 22 binary does. Lambda cold-start crashed with `ERR_REQUIRE_ESM` on `/var/task/node_modules/.pnpm/@exodus+bytes@1.15.0/.../encoding-lite.js`. 2 layers re-applied:
  - **Layer 3 ACTIVE** (`pnpm.overrides` pins `jsdom@25` + `html-encoding-sniffer@4` + `whatwg-url@14`) — keeps the dep tree CJS-clean so `@exodus/bytes` ESM-only chunk is never pulled in.
  - **Layer 4 ACTIVE** (`next.config.ts` `serverExternalPackages: ['isomorphic-dompurify','jsdom','html-encoding-sniffer','@exodus/bytes']`) — tells Next.js bundler to leave these as Node externals so the runtime's CJS-pinned versions are loaded.

**Layers NOT needed** (Node 22 supports static imports in dev + Vercel build phase):
- ~~Layer 1: dynamic `await import('isomorphic-dompurify')` in preview-pane.tsx~~ — static import works on Node 22.
- ~~Layer 2: lazy `require()` in broadcasts-deps.ts~~ — static import works on Node 22.

**Affected**: F7 Email Broadcast (compose, submit, dispatch, admin review)

**Symptom**:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module
  .pnpm/@exodus+bytes@1.15.0/.../encoding-lite.js
  from .pnpm/html-encoding-sniffer@6.0.0/.../html-encoding-sniffer.js
  not supported.
```

Crashes Node 20's CJS loader during dev-server SSR pre-render the moment
ANY route or client component imports `isomorphic-dompurify` (directly
or transitively via the broadcasts barrel).

## Root cause

`isomorphic-dompurify@2.36.0` requires `jsdom@^28.0.0`. jsdom@28's
transitive dependency graph includes:

- `whatwg-url@^16.0.0` → requires ESM-only `@exodus/bytes/encoding.js`
- `html-encoding-sniffer@^6.0.0` → requires ESM-only `@exodus/bytes/encoding-lite.js`
- `@exodus/bytes@^1.15.0` → published as ESM-only

Node 20.18 LTS does not support `require()` of ESM modules
(`--experimental-require-module` was introduced in Node 22). Turbopack
+ Next.js 16 dev server bundles these as CJS externals that the runtime
then `require()`s — crashing the SSR worker.

## Fix layers (defence in depth)

### 1. `preview-pane.tsx` — dynamic import inside `useEffect`

The compose-page client component switched from static
`import DOMPurify from 'isomorphic-dompurify'` to runtime
`await import('isomorphic-dompurify')` inside `useEffect`. SSR
pre-render NEVER touches dompurify; the browser loads it on first
effect tick. Initial paint is empty (no XSS surface — `dangerouslySet
InnerHTML` only fires after sanitiser resolves).

File: `src/components/broadcast/preview-pane.tsx`

### 2. `broadcasts-deps.ts` — lazy `require()` for server-side sanitiser

Read-only routes (admin queue list, broadcast detail) MUST NOT trigger
the dompurify chain. The `dompurifySanitizer` is now lazy-loaded:

```ts
function loadDompurifySanitizer(): HtmlSanitizerPort {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dompurifySanitizer } = require('./sanitizer/dompurify-sanitizer') as { ... };
  return dompurifySanitizer;
}
```

Only `makeSaveDraftDeps` + `makeSubmitBroadcastDeps` invoke the loader;
admin-side factories never see it.

File: `src/modules/broadcasts/infrastructure/broadcasts-deps.ts`

### 3. `pnpm overrides` — pin the chain to CJS-clean versions

Forces every transitive resolution through `isomorphic-dompurify` to
use the same CJS-clean dependency graph that vitest already uses for
jsdom@25:

```json
"pnpm": {
  "overrides": {
    "jsdom":                "25.0.1",
    "whatwg-url":           "14.2.0",
    "html-encoding-sniffer": "4.0.0"
  }
}
```

Verify after `pnpm install`:

```bash
pnpm why html-encoding-sniffer  # all paths resolve to 4.0.0
pnpm why whatwg-url             # all paths resolve to 14.2.0
pnpm why jsdom                  # all paths resolve to 25.0.1
```

File: `package.json` § pnpm.overrides

### 4. `next.config.ts` — `serverExternalPackages`

Marks the chain as Node externals so Next.js leaves them out of the
SSR bundle and lets Node's loader handle them at runtime — works in
concert with the pnpm overrides:

```ts
serverExternalPackages: [
  'isomorphic-dompurify',
  'jsdom',
  'html-encoding-sniffer',
  '@exodus/bytes',
],
```

File: `next.config.ts`

## Verification commands

```bash
# Resolution graph clean
pnpm why html-encoding-sniffer | grep "version 4"
pnpm why whatwg-url | grep "version 14"

# Server-side sanitisation works (compose + submit)
pnpm test:e2e tests/e2e/broadcast-compose-and-submit.spec.ts --workers=1 --project=chromium
# expect: 6/6 pass / 0 skip / 0 fail

# Client-side preview pane works (no SSR crash)
curl -i http://localhost:3100/portal/broadcasts/new  # 307 (auth) — never 500
```

## Revisit checkpoint

**Next mandatory revisit**: 2026-10-30 (6 months from F7 ship) OR at the
start of F7.1 (US3+ scope), whichever comes first. Re-evaluate the four
removal criteria below; if any are met, the maintainer **MUST** schedule
removal in the same release. Document the re-evaluation outcome in this
runbook (append a `## Revisit log` section). This prevents the four-layer
workaround from quietly becoming permanent debt.

**Tracking issues** (subscribe for upstream fix notifications):
- isomorphic-dompurify: https://github.com/kkomelin/isomorphic-dompurify/issues
- jsdom @exodus/bytes ESM resolution: https://github.com/jsdom/jsdom/issues
- whatwg-url CJS-clean release: https://github.com/jsdom/whatwg-url/releases
- html-encoding-sniffer CJS-clean: https://github.com/jsdom/html-encoding-sniffer/releases

## Removal criteria (when this workaround can be dropped)

ANY of:

1. **Node 22 LTS adoption**: production runtime + CI Node 22 enabled by
   default → `--experimental-require-module` → CJS can require ESM
   natively. Node 22 LTS becomes Active LTS October 2025; consider
   upgrading after that date.
2. **`isomorphic-dompurify` ships ESM-clean upstream**: track
   https://github.com/kkomelin/isomorphic-dompurify/issues for an
   ESM-output or jsdom@29 migration.
3. **`jsdom@29+` reverts to CJS-clean dependency graph**: track
   https://github.com/jsdom/jsdom for the @exodus/bytes resolution.
4. **`html-encoding-sniffer@7`** + **`whatwg-url@17`** ship CJS-clean
   versions: monitor whatwg-url + html-encoding-sniffer release notes.

When removing the workaround:

```bash
# 1. Remove the four pnpm overrides
# 2. Remove the four serverExternalPackages entries
# 3. Inline the static import in preview-pane.tsx (revert lazy useEffect)
# 4. Inline the static import in broadcasts-deps.ts (revert require())
# 5. Verify
pnpm install
pnpm typecheck && pnpm lint
pnpm test tests/{unit,contract,integration}/broadcasts/ --run
pnpm test:e2e tests/e2e/broadcast-*.spec.ts --workers=1 --project=chromium
# all GREEN expected
```

## Why this is documented

- Multiple workaround layers — without this runbook the next maintainer
  who tries to upgrade `isomorphic-dompurify` will hit the ESM crash
  in dev mode and not know which knob to turn off first.
- The pnpm overrides change the resolution graph for the WHOLE
  workspace — anything that depends on jsdom@28 features will silently
  use jsdom@25 instead. Verify equivalence before upgrading.
- `serverExternalPackages` interaction with Turbopack vs webpack
  bundlers differs; restoring will need both bundler paths re-tested.

## Related

- `docs/runbooks/cron-jobs.md` — separate F7/F5 cron-job.org setup.
- `next.config.ts` — `serverExternalPackages` block has inline pointer
  to this runbook.
- `package.json` § `pnpm.overrides` — has inline comment pointing here.
