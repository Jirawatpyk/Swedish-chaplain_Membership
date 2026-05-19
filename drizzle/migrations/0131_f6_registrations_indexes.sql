-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T010 — event_registrations indexes.
--
-- 6 indexes on `event_registrations`:
--   1. UNIQUE (tenant, event, external_id)   — registration idempotency (FR-011)
--   2. event-registered-at ORDER             — attendee-table render
--   3. matched-member partial                — F8 EventAttendeesPort lookup
--   4. email-lower                           — admin attendee-by-email erasure search
--   5. needs-relink partial                  — admin "needs relink" filter
--   6. retention-sweep eligibility partial   — daily cron at 2y threshold
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.2.
--
-- non-CONCURRENTLY rationale: see migration 0130 header comment.
-- ---------------------------------------------------------------------------

-- (1) Registration replay idempotency (FR-011) — second of two webhook
-- dedup layers (the first is eventcreate_idempotency_receipts in 0134).
-- ON CONFLICT (tenant_id, event_id, external_id) DO NOTHING on insert.
CREATE UNIQUE INDEX "event_regs_tenant_event_external_unique"
  ON "event_registrations" ("tenant_id", "event_id", "external_id");--> statement-breakpoint

-- (2) Event-detail attendee table render order (FR-021).
CREATE INDEX "event_regs_tenant_event_registered_idx"
  ON "event_registrations" ("tenant_id", "event_id", "registered_at" DESC);--> statement-breakpoint

-- (3) F8 EventAttendeesPort lookup by member — partial index excludes
-- non-member rows (matched_member_id IS NULL) keeping the index small.
CREATE INDEX "event_regs_tenant_matched_member_idx"
  ON "event_registrations" ("tenant_id", "matched_member_id")
  WHERE "matched_member_id" IS NOT NULL;--> statement-breakpoint

-- (4) Admin erasure search by attendee email (FR-032a).
CREATE INDEX "event_regs_tenant_email_lower_idx"
  ON "event_registrations" ("tenant_id", "attendee_email_lower");--> statement-breakpoint

-- (5) Admin "needs relink" filter — surfaces unmatched + non_member rows
-- for manual review (FR-014 admin relink flow).
CREATE INDEX "event_regs_tenant_needs_relink_idx"
  ON "event_registrations" ("tenant_id", "match_type")
  WHERE "match_type" IN ('unmatched','non_member');--> statement-breakpoint

-- (6) Daily retention-sweep eligibility (FR-032 / SC-011). Partial index
-- selecting only the rows the sweep needs to scan (non-member match_type
-- AND still raw PII). Index size stays bounded — pseudonymised rows fall
-- out as their pii_pseudonymised_at timestamp gets set.
CREATE INDEX "event_regs_pseudonymise_eligibility_idx"
  ON "event_registrations" ("tenant_id", "registered_at")
  WHERE "match_type" IN ('non_member','unmatched')
    AND "pii_pseudonymised_at" IS NULL;--> statement-breakpoint
