# F2 Plans API — Contract

**Feature**: F2 Membership Plans
**Branch**: `002-membership-plans`
**Date**: 2026-04-11
**Base URL**: `https://swecham.zyncdata.app` (prod) · `http://localhost:3100` (dev)

This document is the authoritative contract between Presentation (React / Server Actions / fetch clients) and the Application layer exposed through `src/app/api/plans/**` and `src/app/api/fee-config/**`. Every endpoint listed here has a matching **contract test** in `tests/contract/plans/` that asserts request and response shapes against a shared zod schema. Changing a contract without updating the test is a red-bar CI event.

**Shared conventions**:

- **Auth**: every endpoint requires an authenticated F1 session cookie (same as F1). Unauthenticated requests receive `401 unauthenticated`.
- **RBAC**: every endpoint checks the user's role against the plans policy matrix (research.md § 3). Denied requests receive `403 forbidden`.
- **Tenant context**: resolved by `src/lib/tenant-context.ts` from the session (F2 returns the constant `'swecham'`). Every SQL query runs inside `runInTenant(ctx, fn)` so Postgres RLS enforces the tenant boundary. Cross-tenant probes always resolve to `404 not_found` — never `403` — per FR-005 and Constitution v1.4.0 Principle I. Request-path code logs a `plan_not_found` audit event on any admin 404 (info severity); a future periodic super-admin scan (F13) correlates these events across tenants and escalates matches to `plan_cross_tenant_probe` at high severity. **Request path never runs a `BYPASS RLS` query** (critique E6, 2026-04-11 — eliminates the privilege-escalation vector).
- **Idempotency**: every state-changing endpoint (POST / PATCH / DELETE) requires an `Idempotency-Key: <uuid>` header. Replayed key + same body returns the original response verbatim; replayed key + different body returns `409 idempotency_conflict`.
- **Content type**: `application/json` for request + response.
- **Locale**: active locale resolved from `Accept-Language` or session preference; toast / error messages are already localised server-side.
- **Error envelope**: every non-2xx response uses `{ "error": { "code": "<machine_code>", "message": "<localised>", "details": {...} } }`.
- **CSRF**: mutating endpoints require `Origin` in the `APP_ALLOWED_ORIGINS` allow-list (inherited from F1 middleware).
- **Audit**: every mutating endpoint appends exactly one audit event; event types listed per endpoint.

---

## 1. `GET /api/plans` — list plans (US1)

**Roles**: `admin`, `manager` (read)
**Query parameters**:

| Name | Type | Default | Description |
|---|---|---|---|
| `year` | integer | current year | Plan year filter; `2026`, `2027`, … |
| `category` | `'corporate' \| 'partnership'` | both | Category filter |
| `q` | string | — | Free-text search over `plan_name.{active_locale}` case-insensitive |
| `activeOnly` | boolean | `false` | If `true`, only `is_active=true` rows |
| `showDeleted` | boolean | `false` | If `true`, include `deleted_at IS NOT NULL` rows |

**Response** `200 OK`:

```jsonc
{
  "data": [
    {
      "plan_id": "premium",
      "plan_year": 2026,
      "plan_name": { "en": "Premium Corporate", "th": "...", "sv": "..." },
      "description": { "en": "Base tier for companies > 100M THB turnover" },
      "plan_category": "corporate",
      "member_type_scope": "company",
      "annual_fee_minor_units": 3600000,         // 36,000.00 in tenant currency
      "annual_fee_display": "฿36,000.00",         // server-formatted, localised
      "vat_rate": 0.0700,
      "total_with_vat_minor_units": 3852000,      // 38,520.00 in tenant currency (derived)
      "total_with_vat_display": "฿38,520.00",
      "includes_corporate_plan_id": null,
      "is_active": true,
      "deleted_at": null,
      "created_at": "2026-04-11T10:00:00Z",
      "updated_at": "2026-04-11T10:00:00Z",
      "missing_translations": ["sv"],             // computed from plan_name — only shown to admin
      "eblast_quota_per_year": 12,                // C4 — additive OPTIONAL; projected from benefit_matrix.eblast_per_year (null = unlimited/unknown)
      "cultural_tickets_quota_per_year": 6        // C4 — additive OPTIONAL; projected from benefit_matrix.cultural_tickets_per_year (null = unlimited/unknown)
    }
    // ... up to 9 rows for SweCham 2026
  ],
  "meta": {
    "total": 9,
    "year": 2026,
    "currency_code": "THB",                       // the single authoritative currency for this tenant (from tenant_fee_config)
    "filter": { "category": null, "q": null, "activeOnly": false, "showDeleted": false }
  }
}
```

Note: response does NOT include a per-plan `currency_code` field — currency is resolved from `tenant_fee_config.currency_code` and surfaced once on `meta.currency_code` (critique P3, 2026-04-11).

Note (C4): `eblast_quota_per_year` + `cultural_tickets_quota_per_year` are **additive, optional** projections of the two quantifiable yearly benefit quotas from each plan's `benefit_matrix`. They exist so the portal renewal downgrade dialog can render the quota-delta rows + over-quota warning for the target plan. `null` means unlimited/unknown (a legacy or partial `benefit_matrix` row missing the field). Being optional + additive, they do not break existing consumers — this is not a contract-breaking change.

**Errors**: `401 unauthenticated`, `403 forbidden` (member role), `400 invalid_query`.

**Contract test**: `tests/contract/plans/list-plans.test.ts`.

---

## 2. `GET /api/plans/{year}/{planId}` — get one plan (US1, US3)

**Roles**: `admin`, `manager` (read)
**Path parameters**: `year` (integer), `planId` (slug)

**Response** `200 OK`: full plan object including `benefit_matrix` (expanded), eligibility constraints, and `missing_translations` flag.

**Response** `404 not_found`: when the plan does not exist OR belongs to a different tenant. The two cases are **deliberately indistinguishable** — existence MUST NOT leak. On every admin 404 the server appends a `plan_not_found` info-severity audit event with `payload = { requested_plan_id, requested_year, method: 'GET', route: '/api/plans/{year}/{planId}' }`. A periodic super-admin scan (F13, future) correlates `plan_not_found` events against the platform-wide plan inventory and escalates matches to `plan_cross_tenant_probe` high-severity events. **Request path does NOT run a `BYPASS RLS` query** to detect the cross-tenant case — it has no way to distinguish an innocent typo from a genuine probe, and that's deliberate (critique E6, 2026-04-11).

**Errors**: `401`, `403`, `404`, `400 invalid_path`.

**Contract test**: `tests/contract/plans/get-plan.test.ts`.

---

## 3. `POST /api/plans` — create plan (US2)

**Roles**: `admin` only
**Headers**: `Idempotency-Key: <uuid>` (required)
**Request body**:

```jsonc
{
  "plan_id": "custom-plan-2027",     // slug [a-z0-9-]{2,63}
  "plan_year": 2027,
  "plan_name": { "en": "Custom", "th": "...", "sv": "..." },  // en required; th/sv optional
  "description": { "en": "..." },
  "sort_order": 100,
  "plan_category": "corporate",
  "member_type_scope": "company",
  "annual_fee_minor_units": 4000000,           // integer minor units in tenant currency
  "includes_corporate_plan_id": null,
  "min_turnover_minor_units": 10000000000,
  "max_turnover_minor_units": null,
  "max_duration_years": null,
  "max_member_age": null,
  "benefit_matrix": { /* full BenefitMatrix per data-model.md § 2.2 */ }
}
```

**Validation**: zod schema from `src/modules/plans/domain/plan-validators.ts`. Corporate + partnership consistency enforced (partnership MUST have `includes_corporate_plan_id` + `benefit_matrix.partnership`; corporate MUST NOT). Minor-units are non-negative integers; currency is implicit from the tenant fee-config row.

**Response** `201 Created`: the newly created plan (same shape as GET).

**Errors**:
- `400 invalid_body` — zod validation fail, with `details.issues: [{ path, message }]`
- `401 unauthenticated`
- `403 forbidden` (manager / member)
- `409 duplicate_plan` — plan with same `(tenant, plan_id, plan_year)` already exists
- `409 idempotency_conflict` — same `Idempotency-Key` with different body
- `422 partnership_corporate_mismatch` — corporate/partnership integrity rule violated

**Audit**: `plan_created` with full payload in `audit_log.payload` (jsonb column added by migration 0007).

**Contract test**: `tests/contract/plans/create-plan.test.ts`.

---

## 4. `PATCH /api/plans/{year}/{planId}` — update plan (US3)

**Roles**: `admin` only
**Headers**: `Idempotency-Key: <uuid>` (required)
**Path parameters**: `year`, `planId`
**Request body**: partial plan object — any subset of the mutable fields. Server applies `detectLockedFieldChanges` against the existing plan and the patch per FR-014 + research.md § 8.

**Response** `200 OK`: the updated plan.

**Errors**:
- `400 invalid_body`
- `401`
- `403 forbidden`
- `404 not_found` (see § 2 for 404-never-403 rule)
- `409 idempotency_conflict`
- **`422 prior_year_locked_fields`** — at least one locked field was included in the patch when `plan_year < current_year`. Response `details`:
  ```jsonc
  {
    "error": {
      "code": "prior_year_locked_fields",
      "message": "Cannot edit pricing or eligibility on a previous-year plan.",
      "details": {
        "locked_fields": ["annual_fee", "benefit_matrix"],
        "suggested_action": "clone_to_current_year",
        "clone_action_path": "/api/plans/clone"
      }
    }
  }
  ```

**Audit**: `plan_updated` with field-level diff in `audit_log.payload`.

**Contract test**: `tests/contract/plans/update-plan.test.ts` (covers both the happy path and the 422 locked-field path).

---

## 5. `POST /api/plans/{year}/{planId}/activate` — activate (US1, US7)

**Roles**: `admin` only
**Headers**: `Idempotency-Key` (required)

**Response** `200 OK`: `{ "plan_id": "...", "plan_year": 2026, "is_active": true }`
**Response** `200 OK` (no-op): same body if plan was already active; Idempotency-Key semantics guarantee repeat calls are safe.

**Errors**: `401`, `403`, `404`, `409 idempotency_conflict`.

**Audit**: `plan_activated`.

---

## 6. `POST /api/plans/{year}/{planId}/deactivate` — deactivate (US4)

Same shape as § 5 but sets `is_active=false`. Requires confirmation dialog client-side per UX standards § 4.1 — server does not gate on confirmation.

**Audit**: `plan_deactivated`.

---

## 7. `DELETE /api/plans/{year}/{planId}` — soft-delete (US4)

**Roles**: `admin` only
**Headers**: `Idempotency-Key` (required)

**Response** `200 OK`: `{ "plan_id": "...", "deleted_at": "<iso>" }`

**Errors**:
- `401`, `403`, `404`, `409 idempotency_conflict`
- `409 plan_has_active_members` — FR-010 refusal. Response `details.member_count` with a suggestion to migrate affected members. In F2 this check is a no-op (no members table); once F3 lands the count becomes real. **The endpoint MUST still check this condition from day one** so F3 does not have to retrofit a new 409 path into the contract.

**Audit**: `plan_soft_deleted`.

---

## 8. `POST /api/plans/{year}/{planId}/undelete` — restore (US4)

**Roles**: `admin` only
**Headers**: `Idempotency-Key` (required)

**Response** `200 OK`: the restored plan with `deleted_at: null` and `is_active: false` (US4 AS4 — restore always lands inactive).

**Audit**: `plan_undeleted`.

---

## 9. `POST /api/plans/clone` — clone year (US2)

**Roles**: `admin` only
**Headers**: `Idempotency-Key` (required)
**Request body**:

```jsonc
{
  "source_year": 2026,
  "target_year": 2027,
  "activate_cloned": false   // default false — cloned plans start inactive per US2 AS1
}
```

**Behaviour**:
1. Read all non-deleted plans for `(tenant, source_year)`
2. Open a single transaction
3. Check that `(tenant, target_year)` has **zero** plans (including soft-deleted). If any exist → `409 target_year_populated`
4. Insert N new rows with `plan_year = target_year`, identical benefit matrix + money fields, `is_active = activate_cloned`, new `created_at` / `updated_at`, `created_by` = current admin user
5. Append one `plan_cloned` audit event with the full list of new plan IDs
6. Commit

**Response** `201 Created`:
```jsonc
{
  "source_year": 2026,
  "target_year": 2027,
  "cloned_count": 9,
  "cloned_plan_ids": ["premium", "large", "regular", "start-up", "individual", "thai-alumni", "diamond", "platinum", "gold"]
}
```

**Errors**:
- `400 invalid_body` (source_year == target_year, etc.)
- `401`, `403`
- `409 target_year_populated` — refuses overwrite; `details.existing_plan_ids: [...]`
- `409 source_year_empty` — refuses empty clone
- `409 idempotency_conflict`

**Audit**: `plan_cloned` (one event for the whole batch; `payload = { source_year, target_year, plan_ids, count }`).

**Contract test**: `tests/contract/plans/clone-plans.test.ts`.

---

## 10. `POST /api/plans/bulk` — **DEFERRED to F3** (critique X1c, 2026-04-11)

Bulk activate / deactivate / clone-selected with atomic rollback + 10-second undo grace period is deferred to F3 together with US7. Admin clients in F2 perform single-row actions via the endpoints in §§ 5–8. The undo pattern + stale-state-guarded reverse-action API (per critique E4) will be introduced alongside `@tanstack/react-table` in F3 Members & Contacts where row cardinality immediately justifies both.

**F2 alternative**: the Command Palette (US6, § 11) provides a fast single-row action path — `⌘K → type plan name → Enter → Deactivate` — that is roughly as fast as a bulk action on ≤5 rows.

---

## 11. `GET /api/plans/search` — palette search backend (US6)

**Roles**: role-aware — admin sees all actions; manager sees only read actions; member → `403`

**Query parameters**:
| Name | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Search term (min length 1) |
| `limit` | integer | 20 | Cap on results |

**Response** `200 OK`:

```jsonc
{
  "results": {
    "plans": [
      {
        "plan_id": "platinum",
        "plan_year": 2026,
        "plan_name": "Platinum Partnership",    // active locale, already resolved
        "category": "partnership",
        "is_active": true,
        "url": "/admin/plans/2026/platinum/edit"
      }
    ],
    "actions": [
      { "id": "plan.create",              "label": "Create plan",         "url": "/admin/plans/new" },
      { "id": "plan.clone_year",          "label": "Clone 2026 → 2027",   "url": "/admin/plans/clone?from=2026&to=2027" },
      { "id": "fee_config.edit",          "label": "Edit fee config",     "url": "/admin/settings/fees" }
    ],
    "navigate": [
      { "id": "nav.plans",     "label": "Plans",       "url": "/admin/plans" },
      { "id": "nav.fees",      "label": "Fee config",  "url": "/admin/settings/fees" }
    ]
  }
}
```

**Notes**:
- Search is in-memory on the server (9 rows per tenant). The cost of the round-trip dominates — no DB hit beyond the existing plan list query, which is cached for 30 s via `unstable_cache` tagged by tenant.
- Client **lazy-loads** on first `⌘K` press (critique E7, 2026-04-11) — no preload on admin shell mount. The 100 ms SC-008 budget comfortably absorbs the cold round-trip.
- Results are localised server-side based on the request's active locale.
- Actions are filtered by role — a `manager` request gets no `plan.create` / `plan.clone_year` / `fee_config.edit`.

**Errors**: `400 invalid_query`, `401`, `403`.

**Contract test**: `tests/contract/plans/palette-search.test.ts`.

---

## 12. `GET /api/fee-config` — get tenant fee config (US5)

**Roles**: `admin`, `manager` (read)

**Response** `200 OK`:

```jsonc
{
  "tenant_id": "swecham",
  "currency_code": "THB",                      // authoritative for all plan money fields
  "vat_rate": 0.0700,
  "registration_fee_minor_units": 100000,      // 1,000.00 THB
  "registration_fee_display": "฿1,000.00",     // server-formatted for active locale
  "updated_at": "2026-04-11T10:00:00Z"
}
```

---

## 13. `PATCH /api/fee-config` — update tenant fee config (US5)

**Roles**: `admin` only
**Headers**: `Idempotency-Key` (required)
**Request body**: partial subset of the **editable** fields: `vat_rate` (numeric in `[0, 1)`) and `registration_fee_minor_units` (non-negative integer). `currency_code` is **NOT editable via PATCH in F2** — it is set once at tenant-creation time (seed script in F2, F10 onboarding UI for future tenants) and is immutable thereafter once any plan exists for the tenant. Any request body carrying `currency_code` is either silently ignored (if the value equals the current one) or rejected with `422 currency_code_immutable_in_f2` (critique R1, 2026-04-11).

**Response** `200 OK`: the updated fee config.

**Errors**: `400 invalid_body`, `401`, `403`, `409 idempotency_conflict`, `422 currency_code_immutable_in_f2` with `details: { current_currency_code, attempted_currency_code, non_deleted_plan_count, remediation: 'Delete or soft-delete all plans for this tenant, then change currency, then rebuild plans. Proper currency migration with FX-rate-aware revaluation is an F10 concern.' }`.

**Contract test**: `tests/contract/plans/fee-config.test.ts` (covers both read + update).

---

## 14. Error codes — canonical list

| HTTP | Code | When |
|---|---|---|
| 400 | `invalid_body` | Request body fails zod validation |
| 400 | `invalid_query` | Query parameters fail zod validation |
| 400 | `invalid_path` | Path parameters malformed |
| 401 | `unauthenticated` | No valid session cookie |
| 403 | `forbidden` | Role forbidden by RBAC policy |
| 404 | `not_found` | Plan does not exist OR belongs to another tenant (indistinguishable by design) |
| 409 | `duplicate_plan` | (tenant, plan_id, plan_year) already exists |
| 409 | `target_year_populated` | Clone target year already has plans |
| 409 | `source_year_empty` | Clone source has zero plans |
| 409 | `plan_has_active_members` | Soft-delete refused — members still attached (F3+) |
| 409 | `idempotency_conflict` | Same Idempotency-Key, different body |
| 422 | `prior_year_locked_fields` | Patch touches a locked field on a prior-year plan |
| 422 | `partnership_corporate_mismatch` | Corporate/partnership integrity rule violated |
| ~~422 `bulk_partial_failure`~~ | *deferred to F3 with US7* |
| 422 | `currency_code_immutable_in_f2` | `PATCH /api/fee-config` attempt to change `currency_code` while plans exist for the tenant — immutable in F2 (critique R1) |
| 429 | `rate_limited` | Admin mutation endpoint rate limit exceeded |
| 503 | `read_only_mode` | `READ_ONLY_MODE=true` in env — mutation temporarily disabled (inherited from F1 emergency freeze) |

---

## 15. Rate limiting

Admin mutation endpoints (`POST`, `PATCH`, `DELETE` under `/api/plans/**` and `/api/fee-config`) share an Upstash Redis token bucket per `(user_id, endpoint)` — **30 mutations / minute / admin / endpoint**.

Rate limiting does NOT apply to `GET` endpoints — the RLS + session-cookie combination is the only gate on read.

Exceeded → `429 rate_limited` with a `Retry-After` header.

---

## 16. Server Actions parallel

Next.js 16 Server Actions are a thin wrapper around the same Application use cases. The Presentation layer uses Server Actions where practical (form submissions) and the REST endpoints above where Server Actions don't fit (the command palette, inline-edit optimistic updates, client-side Undo). **Both code paths share the same zod schemas and use-case functions.** This means:

- Contract tests in `tests/contract/plans/` test the REST endpoints directly via `supertest`-style calls.
- Server Action tests are covered by integration tests in `tests/integration/plans/**` that invoke the use case directly.
- **There is no divergence risk** between the two surfaces — they go through identical validation and identical audit emission.

---

## 17. Summary

| Endpoint | Method | Roles | Audit Event |
|---|---|---|---|
| `/api/plans` | GET | admin, manager | — |
| `/api/plans/{year}/{planId}` | GET | admin, manager | `plan_not_found` (on any admin 404 — info severity, may be escalated to `plan_cross_tenant_probe` by F13 periodic scan) |
| `/api/plans` | POST | admin | `plan_created` |
| `/api/plans/{year}/{planId}` | PATCH | admin | `plan_updated` |
| `/api/plans/{year}/{planId}/activate` | POST | admin | `plan_activated` |
| `/api/plans/{year}/{planId}/deactivate` | POST | admin | `plan_deactivated` |
| `/api/plans/{year}/{planId}` | DELETE | admin | `plan_soft_deleted` |
| `/api/plans/{year}/{planId}/undelete` | POST | admin | `plan_undeleted` |
| `/api/plans/clone` | POST | admin | `plan_cloned` |
| ~~`/api/plans/bulk`~~ | ~~POST~~ | — | *deferred to F3 with US7* |
| `/api/plans/search` | GET | admin, manager | — |
| `/api/fee-config` | GET | admin, manager | — |
| `/api/fee-config` | PATCH | admin | `fee_config_updated` |

**12 endpoints · 10 audit event types (9 request-path + 1 F13-scan-escalated) · 1 Review-Gate blocker integration test (`tenant-isolation.test.ts`).**
