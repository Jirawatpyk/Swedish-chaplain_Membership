# 143 — Spec 142 follow-ups: one source for the index text, typed tick harnesses, one tenant probe per reclaim tx

**Size**: M (an audit write path and a tenant guard; never S). **Status**: started 7 Nov 2026. The plan was agreed by the maintainer in plan mode on 7 Nov 2026.
**Source**: the Low follow-ups that spec 142 (PR #767, `9dd891e3c`) listed in `specs/142-audience-audit-once/plan.md`.

## Premises (checked on `9dd891e3c`, 7 Nov 2026)
- **The text of `audit_log_audience_deleted_once` is written out in six places:**
  - the migration 0328 CREATE;
  - its expected literal `v_expected`;
  - the `scripts/verify-schema.ts` canary;
  - `audit-adapter.ts` `emitOnce` (ON CONFLICT);
  - `drizzle-broadcasts-repo.ts` `hasAudienceDeletedAuditInTx`;
  - the integration test's `LIVE_DEF`.

  Text-scraping tests pin the migration to the canary. Nothing pins the predicate copies in the adapter and the repo.
- **The deps type of the 5 tick harnesses does not check the audit port.** Each `build-audience-tick*.test.ts` declares `DepsWithEveryPort = { [K in keyof BuildAudienceTickDeps]: unknown }` and calls with `deps as never`. Three harnesses guard their audit double with `satisfies`; `-audience-audit` and `-failure-paths` do not.
- **The reclaim tx runs the SQL tenant probe twice per segment, not three times** (an earlier claim corrected). The two probes are the disclosure read, then `emitOnce` or the existence read. Restart and cleanup run it once. A third probe appears only on dev, under `DEBUG_RLS_STATE`.
- **No runtime behaviour changes,** apart from one fewer probe round trip in reclaim.

## Done when
- **TT1.** The key, the predicate and the expected definition of the index live in one TS module. The adapter's ON CONFLICT, the repo's existence read, the `db:verify` canary and the integration test all use it as literal SQL, never as a bound parameter. A test pins the migration's `v_expected`, and its CREATE key and predicate, to those constants. A source scan fails if the adapter or the repo writes the text inline.
- **TT2.** The tick harnesses share one deps type that requires `audit: Pick<AuditPort,'emit'> & AudienceDeletedAuditPort`. A type-level test shows that a deps object whose audit lacks `emitOnce` does not compile. All 5 harnesses use the type.
- **TT3.** On one tx, the tenant-binding check for the audience audit runs the SQL probe once per tenant slug. A second call on the same tx with the same slug skips the probe. A different slug probes again and is refused. The first call still fails closed with `AuditPortInvariantError`. Reclaim's probes per segment drop from 2 to 1.

## Out of scope
- Switching broadcasts to D-030's `tenantSlugOf` WeakMap. It proves which tenant opened the tx, not the live GUC, and it would change the tenant-SQL-shape gate.
- Changing the migration 0328 file. It is applied, and only the tests that pin it change.

## Open questions
None.
