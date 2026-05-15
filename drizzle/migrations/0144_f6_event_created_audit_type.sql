-- =========================================================================
-- 0144 — F6.1 (Feature 013 · T026 full impl): audit_event_type enum extension
-- =========================================================================
--
-- Adds the `event_created` value to the `audit_event_type` Postgres enum
-- so the new `createEvent` Application use-case can emit audit rows when
-- an admin manually creates an event via the /admin/events/import inline-
-- create modal. Closes the "no way to seed events" gap left when
-- EventCreate's native API moved behind Enterprise tier (see
-- `project_eventcreate_api_gated` memory + `docs/event-integration-analysis.md`).
--
-- Mirrors the pattern from 0132 (initial F6 enum) + 0137 (round-6
-- precondition-failed) + 0141 (F6.1 CSV-import events): idempotent
-- DO-block with EXCEPTION → NULL to allow re-runs.
--
-- Pairs with TypeScript `F6_AUDIT_EVENT_TYPES` extension in
-- `src/modules/events/application/ports/audit-port.ts` (`event_created`
-- variant added) + `AuditPayloads.event_created` discriminated payload.
-- Both layers must stay in sync; this migration is the DB half.
-- =========================================================================

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'event_created';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
