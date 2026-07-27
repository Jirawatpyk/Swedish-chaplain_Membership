-- ---------------------------------------------------------------------------
-- 107-auto-invoice observability/perf follow-up (2026-07 audit) — partial
-- index backing every lookup keyed on `renewal_cycles.auto_draft_invoice_id`.
--
-- The column (added inert in migration 0274, no FK, no index) is the pointer
-- from a cycle to its pre-filled auto-renewal draft. Three hot paths filter or
-- join on it:
--   * `findCyclesByAutoDraftInvoiceIds` — the review-queue page's batched read
--     (maps each queued draft back to its cycle for the prediction badge).
--   * `pruneAutoDrafts` / `reconcileIssuedOrphans` — the housekeeping crons,
--     which INNER JOIN cycles to their auto_draft_invoice_id.
-- Without an index these degenerate to a per-tenant seq scan on a table that
-- grows with members × cycles-per-member. Benign at SweCham's ~131 members
-- (the audit rated this LOW / "before onboarding a large tenant"), added now
-- as cheap headroom while the feature is freshly live.
--
-- Partial on purpose: only a small, transient working set of cycles carries a
-- non-null pointer (it is nulled the moment the draft is issued/discarded/
-- pruned), so the index stays tiny regardless of how large `renewal_cycles`
-- grows. Same rationale as invoices_auto_renewal_draft_idx (migration 0279).
--
-- NO `CONCURRENTLY` — deliberate. Drizzle's migration runner wraps every
-- migration in a single BEGIN/COMMIT, and CREATE INDEX CONCURRENTLY is illegal
-- inside a transaction (it would fail the deploy). The brief
-- AccessExclusiveLock is a non-issue: `renewal_cycles` is small and the
-- predicate matches only the transient auto-draft working set. Same precedent
-- as migrations 0279, 0100 and 0054.
--
-- IF NOT EXISTS so a re-run against a partially-migrated branch is a no-op.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "renewal_cycles_auto_draft_invoice_id_idx"
  ON "renewal_cycles" USING btree ("tenant_id", "auto_draft_invoice_id")
  WHERE "auto_draft_invoice_id" IS NOT NULL;
