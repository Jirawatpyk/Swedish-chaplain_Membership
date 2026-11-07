# Plan: spec 143, the spec 142 follow-ups


Spec: `specs/143-audience-audit-tidy/spec.md` · Size: M · Agreed by the user on: 7 Nov 2026 (plan mode). Test plan: TT1 → the constants module + the pinning cells in `audience-audit-index.test.ts` (moved from `audience-audit-rows.test.ts` in round 3, W3) and `audience-audit-sites.test.ts`; TT2 → the type-level cell for `tests/support/broadcasts/tick-deps-type.ts`; TT3 → reversed in review round 2 (see § Evidence V1); the probe test `audience-audit-tenant-probe.test.ts` pins every-call probing, and V2 (the two audience reads bind `ctx.slug`) is pinned by its bound-parameter cell; TT4 → V2 and W7, pinned by that cell and `evidence-reads-tenant-binding.test.ts`.
## Context
PR #767 (spec 142, merged `9dd891e3c`) left three Low follow-ups. The maintainer asked to fix them. Exploration on `9dd891e3c` (7 Nov 2026) corrected two of my own earlier claims: the copies number more than three, and the probe runs twice, not three times.

1. **The index text is spelled in at least six places.**
   - The migration 0328 CREATE (:63-65) and its expected literal `v_expected` (:88).
   - `scripts/verify-schema.ts:280`: the canary literal and its normalisation, inline.
   - `audit-adapter.ts:147`: the `emitOnce` ON CONFLICT target and predicate, hard-coded.
   - `drizzle-broadcasts-repo.ts:1852-1853`: the `hasAudienceDeletedAuditInTx` key and predicate.
   - `audience-audit-rows.test.ts:398` `LIVE_DEF`.

   Text-scraping tests pin the migration and the canary to each other. Nothing pins the adapter's or the repo's `WHERE event_type = 'broadcast_audience_deleted'` predicate.
2. **The tick harness guard is weak.** All 5 `build-audience-tick*.test.ts` harnesses type their deps as `DepsWithEveryPort = { [K in keyof BuildAudienceTickDeps]: unknown }`, so every value is `unknown`, and they call `deps as never`. Three of them guard the audit double with `satisfies`. Two do not: `-audience-audit.test.ts:233` and `-failure-paths.test.ts:808`. A double that lacks `emitOnce` therefore compiles, and the cell runs the silent lost-row branch, the class review round 3 found.
3. **The reclaim tx runs the SQL tenant probe twice per segment.** The probe is `assertTenantBoundTx`'s `SELECT current_setting('app.current_tenant')`.
   - A disclosed segment probes in `findAudienceDisclosureInTx`, then in `emitOnce`.
   - A segment with no disclosure probes in `findAudienceDisclosureInTx`, then in `hasAudienceDeletedAuditInTx`.

   The tx's tenant cannot change between those calls.

**Size M** (audit write path, tenant guard; never S). **Spec:** `specs/143-audience-audit-tidy/`, short. No migration, and no runtime behaviour change (the one planned difference, one fewer probe round trip, went with TT3 in review round 2).

## Approach
**A. One TS source for the index text** (fixes 1). In `src/modules/broadcasts/infrastructure/db/audience-audit-index.ts`, add:
- `AUDIENCE_DELETED_KEY_SQL`: `(tenant_id, (payload->>'resend_audience_id'))`;
- `AUDIENCE_DELETED_PREDICATE_SQL`: `event_type = 'broadcast_audience_deleted'`;
- `AUDIENCE_DELETED_INDEX_DEF`: the normalised expected definition;
- `normaliseIndexDefSql(expr)`: the shared normalisation fragment.

All four are literal strings, used through `sql.raw`. They must never become bound parameters: a bound parameter gives 42P10 in ON CONFLICT, and a bound key would cost the read its index.

Callers:
- the adapter's `ON CONFLICT ${raw(KEY)} WHERE ${raw(PREDICATE)}`;
- the repo's lockless read, with key and predicate built from the same constants;
- `scripts/verify-schema.ts`'s canary, which imports `AUDIENCE_DELETED_INDEX_DEF` (check that the script's tsx import of a `src/` module follows how other `scripts/` files import from `src`);
- the integration test's `LIVE_DEF`, which becomes that constant.

The `.sql` migration cannot import TS, so it stays a copy. The existing cell then asserts the migration's `v_expected` equals `AUDIENCE_DELETED_INDEX_DEF` (replacing the scrape-the-canary half) and that the CREATE text matches the key and predicate. The unit site scan (`audience-audit-sites.test.ts:321`) asserts the adapter and the repo use the constants rather than inline text. Net result: one TS source and one SQL copy, pinned to each other.

**B. The harness deps type requires the audit port** (fixes 2, at the type root rather than per literal).
- In each of the 5 harnesses, `DepsWithEveryPort` becomes `{ [K in keyof BuildAudienceTickDeps]: unknown } & { readonly audit: Pick<AuditPort, 'emit'> & AudienceDeletedAuditPort }`, typed once in a shared `tests/support/broadcasts/tick-deps-type.ts` (`TickHarnessDeps`). An audit double without `emitOnce`, or with the wrong shape, then fails typecheck wherever deps are built, `satisfies` or not. **As built after review round 3 (W1, W2):** the audit slot is `BuildAudienceTickDeps['audit']` rather than the hand-picked type above, the harnesses share `makeTickAuditDouble`, and `member-send-standing-unknown-kind.test.ts` is the sixth caller.
- Drop the now-redundant `satisfies` on the 3 literals.
- **RED:** a type-level test in that support file's companion (an `// @ts-expect-error` cell) shows a deps object whose audit lacks `emitOnce` does not compile.

**C. One tenant probe per reclaim tx** (fixes 3). **Reversed in review round 2 (maintainer, 7 Nov 2026); not shipped.** The cache below was built, then removed: it saved at most one ~30 ms probe per reclaimed segment, and its safety rested on a single-writer scan that could not be made complete. What ships instead is per-call probing plus V2: `hasAudienceDeletedAuditInTx` and `findAudienceDisclosureInTx` take no tenant argument and bind `ctx.slug` (§ Evidence, round 2). The original approach, kept for the record:
- `assertAudienceAuditTenantBoundTx` (`drizzle-broadcasts-repo.ts:200`) caches per tx: a module-local `WeakMap<tx, slug>` records a tx already proven bound to a slug. A later call on the same tx with the same slug skips the SQL probe; a different slug still probes and refuses.
- The first call still probes, so the check still fails closed. `emitOnce` uses the same function (it is imported from the repo module), so it shares the cache.
- Reclaim drops from 2 probes to 1 per segment. Restart and cleanup stay at 1.
- **Not taken:** switching to D-030's `tenantSlugOf` WeakMap. It proves the opener, not the live GUC, and it would change the broadcasts tenant-SQL-shape gate. A narrower cache keeps the probe's semantics.
- **RED:**
  - a unit cell on a recording tx: two audit reads on one tx issue one `current_setting` probe, and a second slug on the same tx probes again and refuses;
  - the existing cross-tenant integration cells stay green.

## Files
- **new:** `src/modules/broadcasts/infrastructure/db/audience-audit-index.ts`
- **changed:** `audit-adapter.ts`, `drizzle-broadcasts-repo.ts`, `scripts/verify-schema.ts`
- **new:** `tests/support/broadcasts/tick-deps-type.ts`
- **changed tests:** the 5 `tests/unit/broadcasts/application/build-audience-tick*.test.ts`, `audience-audit-sites.test.ts`, `tests/integration/broadcasts/audience-audit-rows.test.ts`, plus a new probe unit test (`audience-audit-tenant-probe.test.ts`, every-call probing after the revert); review round 3 added `tests/unit/broadcasts/infrastructure/audience-audit-index.test.ts` (the file-only pins) and typed `member-send-standing-unknown-kind.test.ts`
- **docs:** `specs/143-audience-audit-tidy/{spec,plan}.md`, the changelog line, and 142 plan.md's listed follow-ups marked closed by 143

## Verification
- `pnpm check`; contract tests; the `tests/unit/broadcasts` + `tests/unit/broadcast` + `tests/unit/scripts` units.
- Integration by path: `audience-audit-rows`, `eblast-send-time-standing`, `audience-cleanup`, `unverifiable-count-audit`, `tx-tenant-binding-guard`, `audit/completeness`.
- `pnpm db:verify` (the canary now reads the constant).
- No `/verify`: after the TT3 revert there is no runtime behaviour change. The live paths are unchanged, and the PR says so.
- Reviews: `/code-review high`, plus `reliability-guardian` (the probe cache, later reverted), within the D-043 cap.
- Merge on the maintainer's word.

## Evidence
Build, 7 Nov 2026, on `143-audience-audit-tidy`.

| Test | RED (commit, failing line) | GREEN |
|---|---|---|
| TT1 `audience-audit-sites.test.ts` (adapter / repo cells) | `5d27e5a79`: `expected '...' to match /from '\.\/db\/audience-audit-index'/` (2 failed, 21 passed) | `1d6b41422`: 23 passed |
| TT1 `audience-audit-rows.test.ts` canary-source cell | `5d27e5a79`: `expected '/**\r\n * Quick schema verification a…' to match /from '\.\.\/src\/modules\/broadca…/` (1 failed, 26 passed) | `1d6b41422`: 27 passed; `pnpm db:verify` 32/32 canaries |
| TT1 migration pins (`v_expected`, CREATE), green by construction | Mutation: whitespace added to `AUDIENCE_DELETED_PREDICATE_SQL` and `AUDIENCE_DELETED_INDEX_DEF` turned 4 cells red (the v_expected, CREATE, live positive control and variant cells); reverted | 27 passed |
| TT2 `tick-deps-type.test.ts` | `92bec56e4`: `tick-deps-type.test.ts(42,5): error TS2578: Unused '@ts-expect-error' directive`, and (45,5) | `283e5863e`: tsc clean; 6 files, 321 tests |
| TT2 the two unguarded harnesses | Did not compile against `TickHarnessDeps` (their `emitOnce` took a `Record` payload): `-audience-audit.test.ts(244,13)`, `-failure-paths.test.ts(819,15)` TS2322 | fixed in `283e5863e` |
| TT3 (superseded by V1: the cache was reverted and the file renamed `audience-audit-tenant-probe.test.ts`) `audience-audit-tenant-probe-cache.test.ts` | `d1e170cd1`: `AssertionError: expected 2 to be 1` on both reclaim sequences (2 failed, 4 passed) | `cbbfef3f9`: 6 passed; mutation (cache before the probe) turned the two "caches nothing" cells red; reverted |
| TT3 cross-tenant integration | | `audience-audit-rows` + `tx-tenant-binding-guard`: 31 passed |

### Review round 1 fold-in (D-043)
Findings of `/code-review high` on PR 768 (CR) and of `reliability-guardian`. Round 1 supersedes the spec's Out-of-scope line on `tenantSlugOf`: the probe cache now reads D-030's registry as a precondition (it never replaces the probe), because a cache keyed on any object also cached the bare `db` singleton.

| Fix | RED (commit, failing line) | GREEN |
|---|---|---|
| U1 (CR 1, 4) the probe proof only for a tx `runInTenant` registered under the expected slug; any other object probes every call; a tx registered for another slug is refused. U3 (CR 3) the two reads refuse a foreign `tenantIdArg` before any SQL | `6ada65275`: `expected 1 to be 3` (unregistered object), `expected null to be an instance of AuditPortInvariantError` (registered for another slug; both reads' `tenantIdArg` cells); 4 failed, 6 passed | 10 passed |
| U2 (CR 2, reliability LOW) `tests/unit/lib/current-tenant-guc-single-writer.test.ts`: `src/` writes `app.current_tenant` only in `src/lib/db.ts`, once (SET, SET LOCAL, SET SESSION, set_config; comments stripped), green by construction | Mutation: a `set_config('app.current_tenant', ...)` in a scratch `src/lib` file turned the scan red (`+ "src/lib/zz-mutant.ts": 1`); removed | 7 passed |
| U5 (CR 6) the TT1 inline scan narrowed to this index's text: its key, predicate and name in literal and bound spellings anywhere in the adapter and the repo, plus a bound payload key inside `emitOnce`'s and the existence read's bodies; another table's ON CONFLICT is not a violation | `7384f8e73`: `expected false to be true` (bound predicate, ON CONSTRAINT, bound key in a body), `expected true to be false` (another table's ON CONFLICT); 4 failed, 24 passed | 28 passed; mutation (a bound `payload->>${...}` line in `hasAudienceDeletedAuditInTx`) turned the read cell red; restored |
| U4 (CR 5) `AUDIENCE_DELETED_INDEX_CANARY_SQL` in `audience-audit-index.ts` is the whole 0328 canary query; `scripts/verify-schema.ts` runs it as it is and the integration live cell executes the same text | `74b116e59`: `expected '/**\r\n * Quick schema verification a…' to contain 'query: AUDIENCE_DELETED_INDEX_CANARY_…'`, `expected [] to have a length of 1 but got +0`; 2 failed, 25 passed | 27 passed; `pnpm db:verify` 32/32; mutation (a typo in the to_regclass name) turned the live cell red; restored |
| U6 (CR 7, 8, 9, reliability TT2 LOW) refactor: the integration test drops `sqlText`, `LIVE_DEF` and `NORMALISE` for `sqlStringLiteral` and the module's own names; `AUDIENCE_DELETED_ID_EXPR_SQL` is built from `AUDIENCE_AUDIT_PAYLOAD_KEYS.resendAudienceId` (relative import, type-only imports behind it, so plain tsx loads it) and the sites cell pins its literal; the `emitOnce` docblock rewrapped; `TickHarnessDeps` is `-?`, so `pauseBeforeReprobe` is now present in every harness, with a type-level cell | No behaviour change | `tests/unit/broadcasts` + the U2 scan: 169 files, 2886 passed; `audience-audit-rows` 27 passed; `pnpm db:verify` 32/32; tsc clean |

### Review round 2 fold-in (D-043)
Findings of the second `/code-review high` round on PR 768. **The maintainer reverted TT3 (7 Nov 2026).** The probe cache saved at most one SQL probe per reclaimed segment: measured 7 Nov 2026, probe p50 29.2 ms and p95 32 ms from a Bangkok workstation to Neon dev; reclaim runs daily with `LIMIT 200`, so at most about 6 s a day, far less from Vercel `sin1`. Its safety rested on a single-writer static scan that cannot be made complete: finding 2 showed its comment stripper blanked 2,784 live lines, and it missed `RESET`, `DISCARD` and bound forms. Per-call fail-closed probing is the defence. Round 1's U1, U2 and U3 go with it (U3 by its root fix, V2).

| Fix | RED (commit, failing line) | GREEN |
|---|---|---|
| V1 the revert: `assertAudienceAuditTenantBoundTx` probes on every call (the `WeakMap`, the `tenantSlugOf` precondition and the skip removed; the `AuditPortInvariantError` mapping of a binding refusal kept). `tests/unit/lib/current-tenant-guc-single-writer.test.ts` deleted: a known-leaky gate is worse than none. `audience-audit-tenant-probe-cache.test.ts` reworked and renamed `audience-audit-tenant-probe.test.ts`: both reclaim sequences on a registered (`runInTenant`-shaped) tx probe twice, with the rendered ON CONFLICT and EXISTS pins; a tx bound to another tenant is refused as `AuditPortInvariantError` on all three calls before any audit SQL; an unbound tx is refused on every call. Dropped: the "caches nothing", "another tx" and registered-vs-unregistered cells, which collapse into "every call probes" | `cae7ae7c2`: `AssertionError: expected 1 to be 2` on both reclaim sequences (2 failed, 2 passed) | `dd6975ccd`: 4 passed |
| V2 (finding 6) `hasAudienceDeletedAuditInTx` and `findAudienceDisclosureInTx` lose their `tenantId` argument; the predicate binds `ctx.slug`; `assertAudienceAuditTenantArg` removed; the reclaim helper and five test doubles follow | Refactor, no RED: round 1's guard already forced the argument equal to `ctx.slug`, so every non-throwing path binds the same value, and the removed refusal path is unrepresentable (typecheck). Pinned by a new bound-parameter cell in the probe test (the EXISTS read binds `[tenant, audienceId]`, the disclosure read binds the tenant at `$3`) | `f6222d50d`: units green; `audience-audit-rows` (cross-tenant cells at the new arity) + `tx-tenant-binding-guard`: 31 passed |
| V3 (finding 9) `TickHarnessDeps` drops `-?` (with `unknown` values a present optional key checks nothing); the typed `audit` and its shape cell stay; the `pauseBeforeReprobe: undefined` lines and the `-?` `@ts-expect-error` cell removed | Refactor | `555b8267c`: tsc clean |
| V4 (finding 7) `audience-audit-index.ts` imports nothing: `AUDIENCE_DELETED_ID_EXPR_SQL` is a pinned literal, and the sites constants cell checks it against `AUDIENCE_AUDIT_PAYLOAD_KEYS.resendAudienceId` | Refactor | `9c854a4b5`: sites 28 passed; `pnpm db:verify` 32/32 |
| V5 (finding 10) the long `emitOnce` docblock line rewrapped to the surrounding width | Folded into V1's docblock edit | `dd6975ccd` |

Totals after the fold-in: `tests/unit/broadcasts` 168 files, 2872 passed; `audience-audit-rows` + `tx-tenant-binding-guard` 31 passed; `pnpm db:verify` 32/32 canaries.

**Low, deliberately not fixed:** finding 8 (round 2) and finding 7 (round 3), the TT1 inline scan does not catch the index text written through Drizzle builder forms (for example `eq(auditLog.eventType, 'broadcast_audience_deleted')`) in the adapter or the repo; it matches raw SQL spellings only. No builder-form copy exists today (checked 7 Nov 2026). Widening a text scan to every syntactic form is the open-ended, leaky class that sank TT3's single-writer scan, so the changelog claim is narrowed instead, and the scan stays a guard against the raw-SQL copy that the code actually used.

### Review round 3 fold-in (D-043, targeted round 1 of 2)
Findings of the third `/code-review high` round on PR 768, all Low; no runtime defect.

| Fix | Kind | GREEN |
|---|---|---|
| W1 (finding 2) `member-send-standing-unknown-kind.test.ts` built tick deps `as never` with no audit double; it now builds `TickHarnessDeps` with every key and the shared double, and asserts no audit row | Test only | `4c3bc9ed7` |
| W2 (finding 3) the harness audit slot is `BuildAudienceTickDeps['audit']`, not a hand-picked type; `makeTickAuditDouble(overrides?)` records `emit` / `emitOnce` and throws on the methods the tick does not use; the type test gains a no-`emitTyped` compile-error cell and two runtime cells | Test only | `4c3bc9ed7`; 7 changed unit files 327 passed |
| W3 (finding 4) the file-only pins (migration `v_expected` and CREATE text, and the canary source) move to the unit test `audience-audit-index.test.ts`, so `pnpm test` catches drift; the live cells stay in the integration file | Test only | `8d9f6cedc`; `audience-audit-rows` 24 passed |
| W4 (finding 5) the probe test drops the `bindTenantTx` registry setup the code no longer reads | Test only | `b5de8c7da`; 4 passed |
| W5 (finding 6) review-history prose removed from the repo docblock and the harness header | Comment | `aa6e2e7c7` |
| W6 (findings 1, 7) the plan's Approach C, the spec and the PR body say TT3 was reversed and V2 shipped; the changelog's scan claim is narrowed to raw SQL text in the adapter and the repo | Docs | `9445cc19d`, `3ad0f1c3e` |
| W7 (architect LOW-2, pre-existing on `main`; the maintainer asked to fix it here, 7 Nov 2026) `readAlreadySentEvidenceInTx` and `hasUnverifiableCountAuditInTx` probed `ctx.slug` but bound the tenant argument in the advisory-lock key and the `tenant_id` predicate; both lose the argument and bind `ctx.slug`, as V2 did. The lock-key text is unchanged, so an equal slug gives the same key | Refactor, no RED: every caller passed `input.tenant.slug`, so every non-throwing path bound the same value; the mismatch is now unrepresentable. Pinned by `tests/unit/broadcasts/infrastructure/evidence-reads-tenant-binding.test.ts` (lock SQL and predicate bind the repo tenant; a tx bound to another tenant is refused before any lock) | `33d4d3012`: `tests/unit/broadcasts` 170 files, 2880 passed; mutation on `2a3d98508` (each of the two lock keys, and the evidence predicate, bound to a constant instead of `ctx.slug`) turned the matching cell red, 1 failed / 2 passed each time; reverted; integration `already-sent-evidence` 8, `audience-import-repo` 28, `halt-flag-precondition` 7, `tx-tenant-binding-guard` 4, `eblast-send-time-standing` 19 |
