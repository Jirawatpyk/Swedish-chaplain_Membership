# Plan: spec 143, the spec 142 follow-ups


Spec: `specs/143-audience-audit-tidy/spec.md` · Size: M · Agreed by the user on: 7 Nov 2026 (plan mode). Test plan: TT1 → the constants module + the pinning cells in `audience-audit-rows.test.ts` and `audience-audit-sites.test.ts`; TT2 → the type-level cell for `tests/support/broadcasts/tick-deps-type.ts`; TT3 → the probe-cache unit cell + the existing cross-tenant integration cells.
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

**Size M** (audit write path, tenant guard; never S). **Spec:** `specs/143-audience-audit-tidy/`, short. No migration, and no runtime behaviour change except one fewer probe round trip.

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
- In each of the 5 harnesses, `DepsWithEveryPort` becomes `{ [K in keyof BuildAudienceTickDeps]: unknown } & { readonly audit: Pick<AuditPort, 'emit'> & AudienceDeletedAuditPort }`, typed once in a shared `tests/support/broadcasts/tick-deps-type.ts` (`TickHarnessDeps`). An audit double without `emitOnce`, or with the wrong shape, then fails typecheck wherever deps are built, `satisfies` or not.
- Drop the now-redundant `satisfies` on the 3 literals.
- **RED:** a type-level test in that support file's companion (an `// @ts-expect-error` cell) shows a deps object whose audit lacks `emitOnce` does not compile.

**C. One tenant probe per reclaim tx** (fixes 3).
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
- **changed tests:** the 5 `tests/unit/broadcasts/application/build-audience-tick*.test.ts`, `audience-audit-sites.test.ts`, `tests/integration/broadcasts/audience-audit-rows.test.ts`, plus a new probe-cache unit test
- **docs:** `specs/143-audience-audit-tidy/{spec,plan}.md`, the changelog line, and 142 plan.md's listed follow-ups marked closed by 143

## Verification
- `pnpm check`; contract tests; the `tests/unit/broadcasts` + `tests/unit/broadcast` + `tests/unit/scripts` units.
- Integration by path: `audience-audit-rows`, `eblast-send-time-standing`, `audience-cleanup`, `unverifiable-count-audit`, `tx-tenant-binding-guard`, `audit/completeness`.
- `pnpm db:verify` (the canary now reads the constant).
- No `/verify`: there is no runtime surface beyond one fewer probe. The live paths are unchanged, and the PR says so.
- Reviews: `/code-review high`, plus `reliability-guardian` (the probe cache), within the D-043 cap.
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
| TT3 `audience-audit-tenant-probe-cache.test.ts` | `d1e170cd1`: `AssertionError: expected 2 to be 1` on both reclaim sequences (2 failed, 4 passed) | `cbbfef3f9`: 6 passed; mutation (cache before the probe) turned the two "caches nothing" cells red; reverted |
| TT3 cross-tenant integration | | `audience-audit-rows` + `tx-tenant-binding-guard`: 31 passed |
