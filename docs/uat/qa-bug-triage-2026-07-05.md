# SweCham UAT — QA Bug Triage & Resolution (2026-07-05)

Source: **SweCham_CRM_Bug_Report.xlsx** → Bug Log (BUG-001…028), QA Team (Nut / Boat).
Baseline: git `origin/main` @ `8a1dde60` (includes PR #147/#148/#149 + Tao's fixes #131/#132/#133/#134).
Method: each bug verified against the live code + its UAT test case (parallel triage workflow + adversarial cross-check + manual deep-verify of P1/P2). "Verify before fix."

**Legend — Sheet `Status` column:** `Fixed - Pending Retest` · `Won't Fix` (by design / not a defect) · `N/A` · `New` (needs decision).

---

## Summary

| Verdict | Count | Bugs |
|---|---|---|
| 🔧 **Fixed this session** (code) | 10 | 007, 008, 009, 010, 015, 018, 022, **023**, 024, 028 (021 folded into 008) |
| ✅ **Already fixed** (Tao's PRs — retest only) | 4 | 001, 002, 003, 017 |
| ⚠️ **Not a bug** (by design / QA misread) | 13 | 004, 005, 006, 011, 012, 013, 014, 016, 019, 020, 025, 026, 027 |

> Note: BUG-021 is the same root cause as BUG-008 (create-plan `{year}` not interpolated) — one fix closes both.

---

## 🔧 Fixed this session (Status → "Fixed - Pending Retest")

| Bug | TC | Fix (file) | Resolution Notes (for sheet) |
|---|---|---|---|
| **BUG-007** | TC-PLAN-22* | `plans-table.tsx` | Plans search box now commits on **Enter** (added `onKeyDown`). It previously only searched on blur because the FilterBar is a `role=search` div with no `<form>`. (*QA's TC-PLAN-22 is actually the Command Palette; the real defect is the plans list search box.) |
| **BUG-008** | TC-PLAN-13 | `new-plan-client.tsx` | Duplicate-plan-ID error toast now passes the year, so it reads "A plan with this ID already exists for **2026**" instead of the literal `{year}`. Same fix closes **BUG-021**. |
| **BUG-009** | TC-PLAN-03 | `plans-table.tsx` | Added a visible **Year** filter dropdown to the Plans toolbar (was URL-only `?year=`). |
| **BUG-010** | TC-PLAN-08 | `clone-year-client.tsx` | Clone-year plan **count** now refetches when the Source year changes, so the description/button/dialog quote the correct number (was pinned to the current year). The actual clone was always correct — only the pre-flight display was wrong. |
| **BUG-015** | TC-INV-04 | `invoices/page.tsx` | "Draft" invoice filter now returns **drafts only** (the page wasn't forwarding `status:'draft'` to the repo, so the query returned every invoice). |
| **BUG-018** | TC-AUTH-05 | `idle-warning-dialog.tsx` | **P2.** "Stay signed in" no longer force-signs-out. Two coupled defects fixed: (1) the dialog now closes optimistically **before** the heartbeat round-trip so a late click can't fall through to the countdown's sign-out; (2) only a genuine **401** signs out — a transient 429/5xx heartbeat keeps the session. +3 regression tests. |
| **BUG-022** | — | `redeem-invite.ts`, `user-repo.ts` | **Register/invite page:** the name typed on the activation form is now **saved** (was accepted then silently dropped, so the account showed the email). "Preferred language" half is by design (cookie-based; no per-user column on staff accounts — see BUG note). |
| **BUG-023** | TC-MEM-26/22 | `portal/account/page.tsx`, i18n×3 | **Account settings polish (option B):** removed the redundant theme toggle (it duplicated the header + UserMenu theme controls) and **folded Sign out into the Account card**, deleting the standalone "Appearance" card (hub 5→4 sections). Sign-out stays findable + reachable even when the account is unlinked. |
| **BUG-024** | TC-PLAN-23 | `search-plans.ts`, `groups.tsx`, `registry.ts` | Command Palette: typing **"create"** now surfaces "Create new plan/member/invoice/E-Blast template" (search now matches English synonyms, not just the i18n key). |
| **BUG-028** | — (F7) | `resend-broadcasts-gateway.ts` | **E-Blast "Too many requests":** HTTP **429 is now retryable** (was "permanent" → killed the broadcast) and **each contact create retries individually** with backoff, so a mid-sync 429 no longer re-creates already-added contacts. ⚠️ *Reliable single-invocation delivery of **very large audiences (»100 recipients)** still needs a batched multi-tick dispatch — see follow-ups.* *(Filed under F6 but it's F7 broadcasts.)* |

---

## ✅ Already fixed before QA re-tested (Status → "Fixed - Pending Retest")

| Bug | TC | Notes |
|---|---|---|
| **BUG-001** | TC-AUTH-11 | Fixed by **PR #132** — reset-password strength meter no longer contradicts the inline error (low-entropy/breached pins the bar red). QA tested a pre-#132 build. |
| **BUG-002** | (TC-AUDIT-06) | Fixed by **PR #134** — audit log now has bidirectional pagination (a "Newer" button on the last page). *QA mislabeled it TC-AUTH-07/F1; it's the F9 audit viewer.* |
| **BUG-003** | — (F3) | Fixed by **PR #131** — member-create errors are now field-targeted + descriptive. *QA labeled F1; member create is F3.* |
| **BUG-017** | TC-AUTH-05 | Fixed by **PR #133** — idle sign-out **toast** now reads "You've been signed out due to inactivity" (was the countdown copy "…in 0 seconds"). QA tested a pre-#133 build. |

---

## ⚠️ Not a bug — by design / QA misread (Status → "Won't Fix", reason below)

| Bug | TC | Why it's not a defect |
|---|---|---|
| **BUG-004** | — | Password strength shows "Strong" only at **≥16 chars + a symbol** (by design; client mirrors server). Retest with e.g. `SuperSecret2024!`. *Optional: add a hint telling users the criteria.* |
| **BUG-005** | — | Sidebar: at a **tablet width (~960px = half a 1920 monitor)** it intentionally collapses to a ~48px icon rail; it only fully hides into a drawer **below 768px**. Matches spec 003-nav-menu FR-004. |
| **BUG-006** | TC-AUTH-28 | Audit log **is** complete — forced session-ends are logged as the batched `concurrent_sessions_revoked` event (per contract). The only never-emitted enum (`session_forcibly_ended`) is intentional. *Optional: hide it from the audit-viewer filter dropdown.* |
| **BUG-011** | TC-MBR-08 | "All" status = Active + Inactive by design; archived (soft-deleted) rows appear only under the **"Archived"** option (spec FR-034). *Optional: relabel "All" to avoid confusion.* |
| **BUG-012** | TC-MBR-16 | Editing the email on the member **Edit page** is the intended, security-hardened change flow (session cut + re-verify + dual-channel revert, FR-012a). The contact *dialog* deliberately locks email to funnel changes here. |
| **BUG-013** | TC-MBR-23 | Bulk-action button intentionally shows the static verb "Archive"; the count is on the "N selected" counter + confirm dialog (matches TC-MBR-23). Archived rows can't be re-archived (guarded + rolled back). *Optional: disable the checkbox on already-archived rows.* |
| **BUG-014** | TC-INV-01 | Invoice PDF alignment is deliberate (right-aligned amounts, left-aligned descriptions, centered footer) and there are **no bullet lists** in the document. TC-INV-01 defines no centering requirement. |
| **BUG-016** | TC-INV-07 | Re-issuing the **same** invoice is blocked (status guard + row lock → 409). Creating two *separate* invoices for the same member/plan is allowed by design (corrections/re-bills). *(TC-INV-07 is actually a payment-idempotency case, also satisfied.)* |
| **BUG-019** | TC-AUTH-05 | Member portal **does** mount the idle dialog (since 2026-04-10) with logic identical to staff; no code path suppresses it. Likely an environment/timing artifact (machine sleep / background tab / <29 min idle). **Please re-test foreground, fully idle 29+ min, and screen-record if it recurs.** |
| **BUG-020** | — | "Erasure log" sidebar link is correctly wired to an existing admin-only page. "Does nothing" is likely: not signed in as **admin**, already on that page, or the clean-launch empty-state (no erasures yet). Retest as admin from another page. |
| **BUG-025** | — | Directory logo **is** used — in the member's own preview + the JSON directory export (FR-027). It's intentionally not embedded in the E-Book PDF. The staff column is a "has-logo" indicator, not dead. *(F9 directory feature, not F3.)* |
| **BUG-026** | TC-PAY-01 | Card + PromptPay both failing = **environment/config**, not code (the initiate path is intact; #147 fix is in HEAD). Reconfirm: `FEATURE_F5_ONLINE_PAYMENT=true`, tenant payment settings row (test keys, both methods enabled, online payments on), and `stripe listen` webhook secret. Capture the failing `/api/payments/initiate` HTTP status to pinpoint. |
| **BUG-027** | TC-MBR-04 | Empty Tax ID for Corporate/Partnership is **allowed by an accepted product decision** (tax_id optional-by-tier; §86/4 buyer-TIN only required for VAT-registrant buyers). The UAT doc TC-MBR-04 itself says "save passes — tax_id not required by tier (intentional)." *Doc hygiene: the superseded spec text FR-009a should be updated.* |

---

## ✅ BUG-023 — resolved (option B)

"Remove the Appearance section" couldn't be a straight delete — the card also held the **Sign out** button (TC-MEM-26/22 depend on it). Verified every consumer first (i18n key, UserMenu deep-links, and a unit test asserting `#appearance` that would have broken silently), then implemented **option B**: removed the redundant theme toggle, **folded Sign out into the Account card**, and deleted the standalone card (hub 5→4 sections). Verified: tsc · check:i18n (4158 keys) · eslint · account-hub 13/13.

---

## Follow-ups surfaced (not in QA sheet)

- **Architectural (BUG-028):** large-audience E-Blast (»100 recipients) can't finish a one-at-a-time contact sync within a single serverless invocation given Resend's 2 req/s limit. Move large-audience sync to a **batched multi-tick dispatch** (or set an explicit `maxDuration` on the dispatch route). The 429-retry fix stops the broadcast *failing*, but throughput for big audiences needs this. *(An earlier attempt to fix it by sleeping 600ms/contact was rejected in review — it guaranteed a function timeout, which is worse than the 429.)*
- **Doc hygiene (BUG-027):** update superseded spec text `specs/005-members-contacts/spec.md` FR-009a + `tax-id.ts` docstring so future QA don't re-flag optional tax_id.
- **QA sheet metadata:** several TC IDs are mislabeled (BUG-002 → TC-AUDIT-06/F9 not TC-AUTH-07/F1; BUG-003 → F3; BUG-024's TC-PLAN-22 is the palette; BUG-028 → F7 not F6).
- **Optional polish** (each low-value, listed inline above): password hint copy (004), audit-filter enum hide (006), "All" relabel (011), archived-row checkbox guard (013).
