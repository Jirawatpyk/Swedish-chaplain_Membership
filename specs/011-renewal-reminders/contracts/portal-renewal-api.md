# F8 — Portal Renewal API Contract

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 contract output

Member-portal endpoints. Authenticated via F1 session OR (for token-verify entry) via signed renewal-link token. Cross-member access attempts emit `renewal_cross_member_probe`.

Lapsed members (per FR-005) can access only the routes listed below + the F1 sign-out endpoint; other portal routes return 403 + redirect to `/portal/renewal/<member_id>` with banner.

---

## 1. Token-verified entry (public route)

### `GET /portal/renewal/[memberId]?token=<signed_token>`

URL format revised at /speckit.critique round 2 / M4: F8 uses F1's existing `resolveTenantFromRequest()` abstraction (era-agnostic).

- **MVP era**: `https://swecham.zyncdata.app/portal/renewal/<memberId>?token=<...>` (single-tenant; resolver returns constant `env.tenant.slug`)
- **Post-F10 era**: `https://<tenant>.zyncdata.app/portal/renewal/<memberId>?token=<...>` (multi-tenant subdomain; resolver returns per-request tenant)

F8 verifier code is identical in both eras. F8 does NOT extend F1 middleware; era transition handled transparently by F1's existing abstraction at F10 ship time.

**Server-rendered page** (NOT a JSON API). Token verification flow per research.md R1 (revised M4):

1. **F8 route handler calls `resolveTenantFromRequest(req)`** from F1's `src/lib/tenant-context.ts`. MVP era returns constant; post-F10 era returns subdomain-derived value.
2. Parse token format `v1.<base64url(payload)>.<base64url(mac)>`
3. `crypto.timingSafeEqual` MAC check (try PRIMARY then FALLBACK secret per R16 dual-key rotation)
4. TTL check (30 days from `iat`)
5. **Cross-tenant check**: `payload.tid === tenantFromRequest`? if not → reject (defence-in-depth; era-agnostic check works for both single-tenant + future multi-tenant)
6. Replay check via `consumed_link_tokens`
7. Bind `app.current_tenant` from token's `tid` (already-validated)
8. Verify member exists in tenant (`SELECT 1 FROM members WHERE tenant_id = $tid AND member_id = $mid`)
9. Insert `consumed_link_tokens` row
10. Sign-in member to a session
11. Render renewal page

**Failure paths** (all render the SAME generic error page — FR-027 no oracle):
- Malformed token → 200 generic error page + audit `renewal_token_invalid {reason: 'malformed'}`
- MAC mismatch → 200 generic error + audit `reason: 'mac_mismatch'`
- Expired → 200 generic error + audit `reason: 'expired'`
- Cross-tenant (subdomain ≠ token.tid) → 200 generic error + audit `reason: 'cross_tenant'`
- Replay → 200 generic error + audit `reason: 'replay'`
- Member not found in tenant → 200 generic error + audit `reason: 'member_not_found_in_tenant'`

**Rate limit**: 20 hits / 5 min per source IP.

**Audit on success**: `renewal_self_service_initiated`

---

### `GET /portal/renewal/[memberId]`

(no token query) — accessible only to authenticated members of that member-id. If session is for a different member-id → 404 + audit `renewal_cross_member_probe`.

**Response 200**: server-rendered page with:
- Current plan + price + tier bucket
- `expires_at` formatted in member's `preferred_locale` (Buddhist Era for `th`)
- Benefit consumption summary for closing year (E-Blast usage, event tickets, etc. — fall back to `0/N` if F2/F4/F6/F7 data not yet populated)
- "Confirm renewal" CTA
- "Change plan" secondary CTA
- (If lapsed) banner "Your membership lapsed on {date}; renew now to restore access"

---

## 2. Confirm renewal

### `POST /api/portal/renewal/[memberId]/confirm`

**Body** (zod-validated):
```json
{
  "selected_plan_id"?: "uuid"  // optional plan-change
}
```

**Behavior**:
1. Verify session matches member-id
2. Tenant-scope guard (RLS)
3. If `selected_plan_id` present and differs from current `members.plan_id` → cycle's invoice will be at the new plan's price (FR-025)
4. Invoke F4 `createMembershipInvoice` via barrel: `{member_id, plan_id, period: {from: expires_at, to: expires_at + plan.term_months}}`
5. Transition cycle to `awaiting_payment`
6. Redirect to F5 `/portal/billing/<invoice_id>/pay`

**Response 200**: `{ invoice_id, redirect_to: "/portal/billing/<id>/pay" }`
**Response 409**: `{ error: "cycle_already_in_terminal_state" }` if cycle is already `completed` / `cancelled` / `lapsed_beyond_grace_window`

**Audit**: `renewal_invoice_created` + (`renewal_with_plan_change` if plan changed)

**Rate limit**: 10 confirmations / 1h per `(tenant_id, member_id)` (prevents double-click duplicate-invoice attempts; F4 `createMembershipInvoice` is idempotent at the FR-007 level but the rate limit reduces noise)

---

## 3. Confirmation page (post-payment)

### `GET /portal/renewal/[memberId]/success`

Server-rendered post-F5-payment landing page. F8 has already (via the F5 webhook → F4 `markPaidFromProcessor` → F8 `markCycleCompleteFromInvoicePaid` chain) advanced `members.expires_at` and transitioned the cycle to `completed`.

**Response 200**: confirmation page with:
- Welcome message in member's locale
- New `expires_at` highlighted
- Tax-receipt PDF download link (delegates to F4 receipt route)
- "Back to portal home" CTA

---

## 4. Renewal preferences

### `GET /portal/preferences/renewals`

Server-rendered page. Authenticated members of self only.

**Response 200**: page with current `renewal_reminders_opted_out` toggle + explainer text.

---

### `POST /api/portal/preferences/renewals`

Toggle opt-out (FR-016).

**Body**: `{ opted_out: boolean }`

**Response 200**: `{ opted_out, opted_out_at }`
**Audit**: F1 audit `member_preference_changed` with payload `{key: 'renewal_reminders_opted_out', new_value}`

**Rate limit**: 20 toggles / 1h per `(tenant_id, member_id)`

**Note**: FR-016 — when opted out, F8 cron skips email dispatch but STILL: (a) lists in admin pipeline, (b) generates manual escalation tasks per tier policy, (c) emits `renewal_reminder_skipped {reason: 'member_opted_out'}` audit per evaluation
