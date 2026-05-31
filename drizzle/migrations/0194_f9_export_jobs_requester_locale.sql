-- ---------------------------------------------------------------------------
-- F9 US6 (T089) — export_jobs.requester_locale
--
-- Source of truth: specs/015-admin-dashboard/spec.md FR-029.
--
-- FR-029 requires the GDPR archive README to be rendered in the REQUESTER's
-- locale (the member's own for self-service, or the admin's for an
-- admin-on-behalf request), with EN fallback. The README is produced LATER by
-- the async `process-export-jobs` cron worker, which has no access to the
-- requesting session — so the requester's locale is captured at request time
-- by `requestDataExport` and persisted here for the worker to read.
--
-- Nullable: directory artefacts (E-Book / JSON) + audit exports do not carry a
-- requester locale; only `gdpr_member_archive` rows set it. The worker falls
-- back to the tenant default locale (EN) when null.
--
-- The column is NOT part of the idempotency key (data-model § 4:
-- hash(tenant_id, kind, subject_member_id, requested_for_period)), so a repeat
-- request within the same idempotency window returns the existing job and keeps
-- the locale captured by the FIRST request.
--
-- Rollback:
--   ALTER TABLE "export_jobs" DROP COLUMN "requester_locale";
-- ---------------------------------------------------------------------------

ALTER TABLE "export_jobs"
  ADD COLUMN "requester_locale" text;
