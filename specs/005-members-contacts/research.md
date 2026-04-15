# Phase 0 Research — F3 Members & Contacts

**Branch**: `005-members-contacts` | **Date**: 2026-04-15
**Source**: [`plan.md`](./plan.md) Technical Context unknowns + integration patterns

This document resolves every `NEEDS CLARIFICATION` and integration unknown surfaced by the plan. Each section is structured as **Decision / Rationale / Alternatives considered** per Spec Kit conventions.

---

## 1. Search strategy for the directory (FR-016, SC-002 — 500ms p95 on 5,000 rows)

**Decision**: **Postgres `pg_trgm` extension + GIN index on `company_name` + ILIKE substring queries**, with secondary plain-text indexes on `contacts.email` and `contacts.first_name || ' ' || contacts.last_name`. Single SQL query per search; no separate search service.

**Rationale**:
- 5,000 rows × ~3 indexed string columns is well within Postgres single-instance capacity. `pg_trgm` GIN search on a 5,000-row column completes in < 50ms even cold.
- Zero new infrastructure — no Typesense / Meilisearch / Elasticsearch deploy, no separate region, no ETL pipeline.
- Search results respect RLS automatically — the same `runInTenant` wrapping returns tenant-isolated results without a separate filter step.
- F1 already enables `pg_trgm` for the audit-log search exploration that didn't ship; the extension is a single migration line.

**Alternatives considered**:
- **Meilisearch / Typesense**: rejected — operational cost (separate service, separate region, separate SLO, secrets rotation), eventual consistency vs. immediate visibility on member create, additional network hop. Re-evaluate only if SC-002 fails on real data or when search expands across modules in F9.
- **Postgres tsvector full-text search**: rejected — overkill for substring matching. tsvector is great for stemmed-token queries but worse than `pg_trgm` for "Fog…" partial-prefix matching.
- **Server-rendered + client-side filter** (preload all members): rejected — does not scale to 5,000 rows on mobile, leaks the entire directory to manager role unnecessarily, defeats RLS audit grain.

---

## 2. Atomic transaction pattern for contact email change (FR-012a)

**Decision**: **Single Postgres transaction wrapping (a) contact update, (b) linked user email update, (c) session invalidation, (d) old-email lockout**, with **email send via outbox row dispatched after commit**.

**Rationale**:
- The DB-level steps are all atomic-feasible — they touch `contacts`, `users`, `user_sessions` (F1 table), and a new `users_email_lockout` row (or just rely on the new email having `email_verified_at = NULL` which the F1 sign-in already gates on — see decision below).
- Email send is intentionally NOT in the transaction. Resend outage would otherwise roll back the email change, leaving the user with a stale email locally and a verified email at Resend that never went anywhere. Outbox pattern: write a row to `notifications_outbox` (existing F1 table for password-reset emails) inside the transaction; a single after-commit hook + retry-on-failure dispatcher sends the email.
- Session revocation — F1 `user_sessions` table has `revoked_at` column; updating WHERE `user_id = X AND revoked_at IS NULL` revokes all live sessions in one statement.
- Old-email lockout is implicit: F1 sign-in resolves email → `users.email`. Once we update `users.email = new`, the old email no longer matches anything. No separate lockout table needed.
- New-email sign-in gating: F1 sign-in already requires `users.email_verified_at IS NOT NULL`. We set `users.email_verified_at = NULL` inside the transaction, dispatch the verification token via the existing F1 password-reset/verification token table (`auth_tokens` with `purpose = 'email_verification'`, 24h TTL).

**Alternatives considered**:
- **Two-phase commit / saga across DB + Resend**: rejected — Resend has no 2PC support; saga complexity is unjustified for a low-frequency operation.
- **Defer all 4 DB steps, send email first, only commit on Resend success**: rejected — leaves window where the linked user can still sign in with the old email after the admin clicked Save, defeating the security guarantee in Q2.
- **Don't auto-update F1 user email at all** (Q2 Option D): rejected by user during clarification.

---

## 3. RBAC extension for `members:*` and `contacts:*` resource families

**Decision**: Extend the F1 `rbac-guard.ts` resource map with two new families:

```ts
// shape only — actual code lives in src/modules/auth (F1) extended in F3
const RBAC_MAP = {
  // F1 inherited:
  'auth:*': { admin: ['*'], manager: ['read'], member: ['read:self'] },
  // F2 inherited:
  'plans:*': { admin: ['*'], manager: ['read'], member: [] },
  'fees:*':  { admin: ['*'], manager: ['read'], member: [] },
  // F3 new:
  'members:*':  { admin: ['*'], manager: ['read'], member: ['read:self', 'update:self:whitelisted'] },
  'contacts:*': { admin: ['*'], manager: ['read'], member: ['read:own-member', 'update:self', 'invite:colleague'] },
};
```

**Rationale**:
- Same shape as F1+F2 — no new abstraction.
- `read:self` for `member` role on `members:*` means the resolver checks `member.id === session.member_id`. The check is enforced in the use case via a `ResourceOwnership` policy in Domain.
- `update:self:whitelisted` is a marker that engages the `enforce-self-service-field-whitelist` Application use case, which strips disallowed fields (FR-014).
- `invite:colleague` for `member` on `contacts:*` is gated on the inviter being the primary contact OR explicitly granted by admin — for MVP, primary contact only (matches spec US5 AS4 which doesn't differentiate).

**Alternatives considered**:
- **Attribute-based access control (ABAC) via OPA / Casbin**: rejected — overkill for 3 roles + 5 resource families; F1's enum-table approach remains correct.
- **Per-field RBAC**: rejected for member self-service — the whitelist lives in the use case, not the RBAC table; cleaner separation of concerns (RBAC = "can the user enter this door"; use case = "what can they do once inside").

---

## 4. Outbox pattern for email dispatch (verification + invitation + colleague invite)

**Decision**: **Create a new `notifications_outbox` table in F3 migration 0011** — part of the auth-shared schema (co-located with `email_delivery_events`, since the outbox is expected to serve auth flows like password-reset in a future refactor). Audit correction (2026-04-15): F1 does NOT currently have an outbox — F1 password-reset and invitation emails go directly via `resend-client.ts` (synchronous 3-retry send). The F3 outbox is **new infrastructure**, not a reuse. `notification_type` enum values for F3: `member_invitation`, `email_verification`, `email_change_revert`, `email_verification_resent`. A single Vercel Cron Job (every 60s) drains the outbox; up to 5 retries with exponential backoff; permanent failure after 5 attempts logs an `email_dispatch_failed` audit event.

**Rationale**:
- After-commit dispatch decouples DB transaction durability from email service availability (Resend SLO) — required by FR-012a's 6-step atomic txn.
- Single table covers both F3 (members) and future auth flows (password-reset migration is a follow-up).
- Resend itself supports idempotency keys; the outbox row's UUID is the idempotency key.
- Schema lives in `src/modules/auth/infrastructure/db/schema.ts` (shared location) per 2026-04-15 decision.

**Alternatives considered**:
- **Direct synchronous Resend call inside the transaction**: rejected — see § 2.
- **A new queue service (BullMQ on Upstash Redis, Vercel Queues, etc.)**: rejected — F1 outbox already meets the SLO; new infra is not justified at < 50 emails/day expected throughput.

---

## 5. Bundle-change real-count query (FR-010, SC-008 — 200ms p95 on ≤500 members per plan)

**Decision**: **Single indexed COUNT query** against `members` filtered by `(tenant_id, plan_year, plan_id)`. The endpoint `GET /api/plans/[year]/[planId]/affected-members` returns `{ current_count: number, includes_corporate_plan_id: text|null }` so the dialog can render the localized "X members keep their {old} benefits; new signups receive {new}" copy on the client.

**Rationale**:
- The composite index `members(tenant_id, plan_year, plan_id)` (declared in `data-model.md`) makes COUNT a sub-50ms operation even on 5,000 members.
- Tenant scoping via RLS ensures the count is automatically tenant-isolated — no risk of leaking cross-tenant member count to the admin.
- Returning the current `includes_corporate_plan_id` lets the dialog show both old and new bundles without an extra round-trip.

**Alternatives considered**:
- **Materialized view**: rejected — refresh complexity not justified for a count query that hits a small indexed table.
- **Approximate count (Postgres `pg_class.reltuples`)**: rejected — admin needs a precise number for the warning.

---

## 6. Date-of-birth (DOB) handling — Thai Alumni eligibility (FR-008, edge case)

**Decision**: `contacts.date_of_birth` is a nullable `DATE` column. Required ONLY when the parent member's plan is `Thai Alumni`; enforced at the Application layer (not a CHECK constraint, because plan changes can move a contact in/out of the requirement). Excluded from default API responses; opt-in via `?include=date_of_birth` admin-only query parameter on the detail endpoint. Redacted in `pino` logs by name. Used to compute age at plan start for the eligibility warning.

**Rationale**:
- DOB is sensitive PII (PDPA + GDPR special category if linked to age verification). Minimum-necessity principle: collect only when needed, expose only when needed.
- Database-level CHECK constraint rejected because the requirement is plan-dependent; moving a contact from Thai Alumni to Premium Corporate would require dropping the constraint mid-transaction.
- The `?include=` pattern matches the F1 pattern for the user audit log's optional `source_ip` field.

**Alternatives considered**:
- **Store DOB on `members` instead of `contacts`**: rejected — for Individual + Thai Alumni the "company" is effectively a person, but the data model treats company_name as the display name and the contact carries the actual person identity. DOB belongs on the human, not the company.
- **Derived age column**: rejected — age changes over time; recompute on every read.
- **Don't store DOB at all, just an "eligible" boolean**: rejected — admins need to verify eligibility annually for Thai Alumni renewals (F8); a boolean loses the audit trail of how eligibility was determined.

---

## 7. Inline edit + bulk action UX — TanStack Table integration (US4, F2 US7 carry-over)

**Decision**: **`@tanstack/react-table v8` headless table** wrapped by a shadcn `<Table>` for visual primitives. Inline edit on `status`, `country`, `notes` columns via a `<Combobox>` / `<Select>` / `<Textarea>` cell editor that commits on blur with optimistic update + server rollback toast on error. Multi-row selection via a header checkbox column; bulk actions via a context bar that appears when ≥1 row is selected. Server-side cap of 100 rows enforced in the API handler via a zod refinement.

**Rationale**:
- TanStack Table v8 is the de facto standard for headless, framework-agnostic editable tables in React 19; tree-shakable, ~14KB gzipped, full TS types.
- Headless = full control over a11y (screen-reader announcements, keyboard nav) and reduced-motion handling.
- Reusing shadcn `<Table>` for visuals keeps the design language consistent with F1+F2.
- 100-row cap (Q4 clarification) applied client-side AND server-side per defence-in-depth.

**Alternatives considered**:
- **AG Grid Community**: rejected — heavier (~200KB gzipped), worse a11y story, license complexity for "Enterprise" features that we'd want.
- **Build custom table**: rejected — reinventing keyboard nav + sort/filter wheel is wasted effort.
- **Server-side pagination only, no inline edit**: rejected — defeats US4.

---

## 8. Command palette extension — Members group (smart feature #4 expansion)

**Decision**: Extend the F2 `cmdk` palette with a new "Members" group rendered above the existing "Plans" group. Lookup is **client-side filter on a server-fetched window of the 50 most recently active members** for the current tenant, refreshed on palette open. Selecting a member result navigates to `/admin/members/:id`. Member self-service (`role=member`) sees a stripped palette with only "Profile / Edit / Invite colleague" actions.

**Rationale**:
- 50 recent members covers > 90% of admin lookup intent; deeper search is the directory's job.
- Refresh-on-open keeps the cache fresh without server-side invalidation.
- RBAC-aware palette (member sees fewer entries) matches F2's pattern of palette respecting the user's role.

**Alternatives considered**:
- **Server-side palette search** (one query per keystroke debounced): rejected — extra latency, unnecessary load for 90% of usage. Re-evaluate if "find any member" becomes a primary use case.
- **Preload all members to client**: rejected — leaks PII via the client bundle/cache.

---

## 9. Timeline implementation (US6) — read-only audit projection

**Decision**: Timeline is a **server-rendered Cache-Components page** that queries `audit_log` filtered by `(tenant_id, payload->>'member_id' = $1 OR target_user_id = X OR payload->>'related_member_id' = $1)`, ordered DESC by `timestamp`, paginated via cursor (`(timestamp, id)` tuple) in batches of 50. Member-role users get a redacted projection (override reasons + internal notes stripped). Timeline display strings (`event_type` → human label) are localized via `audit.eventType.{event_type}` keys.

**Rationale**:
- Audit log is already append-only and indexed by `(tenant_id, timestamp)`. A small additional index on `((payload->>'member_id'))` accelerates the filter.
- Cache Components are the natural fit per Next.js 16 — timeline is reads-only, can be cached with `cacheTag('member', memberId)` and invalidated on every audit-log write to that member.
- Cursor pagination prevents the deep-page performance cliff of OFFSET-based pagination.

**Alternatives considered**:
- **Materialized view per member**: rejected — refresh cost outweighs query saving for the < 1,000 events/member typical case.
- **Separate `member_timeline` table denormalized from audit_log**: rejected — duplication, sync complexity, and the F1 audit_log already serves the use case.

---

## 10. Country code data + localized country names (FR-001, Q3)

**Decision**: Use the **`i18n-iso-countries` npm package** loaded with EN + TH + SV locale data only at build time (tree-shaken via dynamic import in the country selector + display components). Stored value on `members.country` is the alpha-2 code (e.g., `TH`, `SE`, `US`). Display rendered via `getName(code, locale)` from the package.

**Rationale**:
- Avoids depending on the runtime ICU build shipped by Vercel's serverless Node.js (ICU may or may not include Thai/Swedish country names in `Intl.DisplayNames` depending on edge region).
- ~70KB total for 3 locales after tree-shaking; loaded lazily only on the directory + member detail / form pages.
- Stable data source (ISO 3166 maintained by ISO).

**Alternatives considered**:
- **`Intl.DisplayNames`** (built-in): rejected — see above ICU concerns.
- **Hand-curated EN/TH/SV country list**: rejected — maintenance burden + risk of staleness on real-world country list changes.

---

## Summary

All 10 research questions resolved. No remaining `NEEDS CLARIFICATION`. Plan proceeds to Phase 1 (data-model, contracts, quickstart).
