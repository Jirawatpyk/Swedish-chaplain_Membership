---
paths:
  - "src/modules/members/**"
  - "src/app/*/admin/members/**"
  - "src/app/*/admin/change-requests/**"
  - "src/app/*/admin/directory/**"
  - "src/app/*/portal/profile/**"
  - "src/app/*/portal/contacts/**"
  - "src/app/*/portal/change-requests/**"
  - "src/components/members/**"
  - "src/app/*/admin/settings/member-changes/**"
  - "src/app/api/members/**"
  - "tests/**/members/**"
---

# Members & contacts (F3 `005-members-contacts`, 108, F114)

PII surface — review with `pdpa-gdpr-compliance-officer` + `security-engineer`.

- **F3 stack**: `@tanstack/react-table@^8` (server-side pagination/sort/filter on the directory) · `i18n-iso-countries@^7`. Tables `members` + `contacts` with a pg_trgm GIN index, RLS+FORCE policies, and a `last_activity_at` SECURITY DEFINER trigger (migrations 0009 + 0010). **That trigger fires only on an audit payload key `member_id` — snake_case**; two features emitted `memberId` and the trigger never fired for either (fixed #336/#337).
- **108 contact recipient rules**: migrations `0292`–`0297` · permission key `contacts.marketing` (admin / super_admin / marketing — **never** manager) · `contacts_check_member_primary()` SECURITY DEFINER with `row_security = off`, behind two DEFERRABLE INITIALLY DEFERRED constraint triggers, enforces exactly-one-live-primary at COMMIT · `contacts_tenant_lower_email_all_idx` is **not** partial, so a carry-forward opt-out lookup can still match REMOVED rows · `MembersBridgePort.filterMarketingOptedOut` drops opted-out addresses from every segment at dispatch, fail-closed.
- **F114 member change approval** (`src/modules/members/**/change-requests/**`): tables `member_change_requests` + `member_change_request_fields` (migrations `0300`–`0302`; RLS + FORCE; partial unique one-PENDING-per-submitter) · `tenant_member_settings.member_change_approval_enabled` (the per-tenant switch, audited `{ previous, next }`) · `notification_type` +2, skipped by the outbox drainer while `FEATURE_MEMBER_CHANGE_APPROVAL` is off · gauges `members_change_requests_pending_count` / `members_change_request_oldest_age_seconds` on the per-tenant tick (`docs/observability.md` § 27; runbook `docs/runbooks/member-change-requests.md`).
- **Hard delete** walks 10+ FK children bottom-up; erasure must read dependents BEFORE the in-tx scrub, and a cross-member erasure must not touch another member's rows.
