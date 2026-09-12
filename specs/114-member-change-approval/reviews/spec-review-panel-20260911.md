# Spec review panel — 114-member-change-approval

**Spec**: `specs/114-member-change-approval/spec.md` (Status: Draft — clarified 2026-09-11, ready for `/speckit-plan`)
**Panel result**: 1 CONFIRMED · 11 REFUTED · ~110 UNVERIFIED (capped, not adjudicated)

## Confirmed findings (severity-sorted)

| id | sev / kind | anchor | claim | evidence (MEASURED) | lenses |
|---|---|---|---|---|---|
| #12 | MEDIUM / premise | FR-013 (second clause); § Edge Cases "Reviewer's own account is a member's contact" | The self-review refusal guards a state that cannot exist: a staff user can never be a portal submitter, so `reviewer = submitter` never trips and the acceptance test is green before implementation — indistinguishable from a broken guard. | `src/modules/auth/infrastructure/db/schema.ts:748,774` — one `role` column + `users_email_lower_unique` (one person = one account = one role) · `src/app/(member)/portal/layout.tsx:49-51` — `isStaffRole(user.role) → redirect('/admin')` · `src/lib/member-context.ts:65` — `role !== 'member' → 403` on every `/api/portal/**` route · `invite-colleague.ts:156`, `invite-portal.ts:113` — both portal-invite paths mint `role: 'member'` · **`src/modules/auth/application/change-role.ts:6-8,71-76`** — staff ↔ member role crossings refused with `400 role-portal-mismatch`, citing F1 spec §Q2 "separate accounts for staff members who are also TSCC members", so the same `users.id` can never move from submitter to reviewer either. | testability, premise |

**Impossible if the spec were right**: if FR-013's clause could ever fire, `change-role.ts`'s `role-portal-mismatch`, the portal layout's staff redirect, and `member-context.ts`'s non-member 403 would all be dead code. They are live.

Why the delete-and-record shape (not the re-specify shape the finding also offered): re-specifying the guard against `contacts.linked_user_id` would be equally dead — `linked_user_id` is only ever set to a freshly-minted `member`-role user (`drizzle-contact-repo.ts:276`), and that user can never become staff. The F1 design already answers the dual-role person: two unlinked accounts. The honest spec position is "no system control; policy", stated in scope.

## Amendments (apply via `/speckit.clarify` or a spec `AMENDMENT` block)

**FR-013** — closes #12
> - **FR-013**: Only a staff user holding the members-write right (`members.write`; no new permission is introduced) MUST be able to decide a pending request. No self-review rule is specified: a staff account can never be a portal submitter by construction — one `role` per user account, global case-insensitive email uniqueness, staff sessions are redirected off `/portal/**`, `/api/portal/**` refuses any non-member role, and a staff ↔ member role change is refused (`role-portal-mismatch`; F1 § Q2: a staff person who is also a member holds a *separate* member account). A reviewer's user id therefore never equals a submitter's user id, and a guard comparing them would be untestable dead code (see § Out of Scope).

**§ Edge Cases — replace "Reviewer's own account is a member's contact"** — closes #12
> - **Reviewer who is, as a natural person, also a member's contact**: by F1 § Q2 such a person holds two unrelated accounts (one staff, one member, under different email addresses); the system holds no identity link between them and does not attempt to detect one. The review page shows the submitting person's name and role at submission; refraining from deciding a request for one's own company is chamber policy, not a system control (see § Out of Scope).

**§ Out of Scope — append** — closes #12
> - Detecting or refusing "self-review" by a natural person who holds both a staff account and a member account. No person-identity link exists between accounts (F1 § Q2 separate accounts; `role-portal-mismatch` forbids a role crossing), so a system-enforced rule would need a cross-account identity model, which is its own feature with its own PII review.

## Optional hygiene (residuals the refutations left at LOW — not required for GO, maintainer's call)

- **FR-011 / § Assumptions "Staff notification recipients"**: add "'of the tenant' is vacuous under STD (one deployed tenant; `users` is cross-tenant by design per `docs/saas-architecture.md` § 4); recipient enumeration becomes `user_tenants`-scoped at F10" — and add that F10 checklist item. (from #1/#3/#11)
- **FR-031**: state the setting's initial value for a newly onboarded tenant (repo precedent `auto_invoice_enabled` is `DEFAULT false`); confirm the flag→setting ordering. (from #2)
- **FR-037**: bind the plan-gate alert threshold to the Art. 12(3) / PDPA §30 one-month bound already in `docs/runbook/gdpr-rights-verification.md`, so the operational alarm doubles as the statutory backstop. (from #4)
- **SC-002**: qualify "the email alone is enough…" with "for the submission that generated it; after a coalesced resubmission the link opens the current values (SC-013)". (from #9)
- **US1 AS4**: drop "a malformed postal code" from the examples (no format rule exists on any path; it collapses into "over-long"). (from #8)
- **Plan-gate notes, not spec text**: apply step uses the throw-to-rollback bridge (`UseCaseAbort` / `runInTenantWithRollbackOnErr`), never `return err(...)` inside the tx (#5); decision use case opens exactly one `runInTenant` and calls the `*InTx` + `recordInTx` ports, never `updateMember`/contact-crud writers (#6); name the owning module in plan.md § Structure Decision (#7); submit/withdraw/decide are `/api/**` route handlers so the Origin allow-list + `requireMemberContext` chokepoint apply (#10); generalise "re-validate at approval" from the company-name edge case to every Group B field (#6).

## Refuted (do not re-raise)

- **#1 / #3 / #11** — "tenant-scoped staff set cannot be enumerated": there is no physical `tenants` table; tenant identity is the `TENANT_SLUG` boot constant, so "every active staff user of the tenant holding `members.write`" IS `role IN (admin, super_admin) AND status='active'` today; `user_tenants` lands with F10 by the documented migration path (saas-architecture § 4; constitution :367-373 pre-blesses it); SC-009 scopes its test to *requests*. Residual: one Assumptions line.
- **#2** — "setting OFF widens Group B with no review": the feature ships dark behind the platform flag; FR-031 pins SweCham ON; SC-011 states the OFF behaviour deliberately; no second tenant exists under STD. Residual: state the column default.
- **#4** — "Art. 16 self-rectification converted into a gated non-right": Q2 records the field-by-field decision with the statute named; Art. 16 is a request to the controller with a 30-day clock, and the statutory channel (staff edit) stays immediate (FR-021); `users_last_admin_guard()` guarantees ≥1 reviewer. Residual: bind FR-037's threshold to the 30-day bound.
- **#5** — "`err()` inside `runInTenant` commits, so FR-015 is violated by the natural idiom": the members module's natural idiom is `UseCaseAbort` (throw-to-rollback) at 102 sites, including a mid-tx re-read refusal in `member-self-update.ts:312`; `docs/code-conventions.md` § 4 mandates the bridge for multi-row mutations; FR-015 states the invariant, plan.md picks the primitive.
- **#6** — "FR-015 unsatisfiable via staff-edit use cases": the spec never prescribes them; `updateFieldsInTx` / `updateInTx` / `recordInTx` exist for exactly this; US2 AS4 already mandates the truthful attribution.
- **#7** — "owning bounded context unnamed makes FR-015 unimplementable": module ownership is the plan.md Structure Decision (spec template forbids it); the members barrel already exports tx-accepting `*InTx` variants consumed by sibling modules.
- **#8** — "AS4's staff-edit validations do not exist": `buildMemberFormSchema` (used by both staff edit pages) refuses a future `founded_year` and normalises website before `.url()`; `asPhone` is shared; only the postal-code example lacks a counterpart (wording nit).
- **#9** — "coalescing makes SC-002 false": the review page is the sole decision surface (no approve-from-email path); the dynamic link is the recorded mitigation (clarify Q, FR-011, US5 AS2, SC-013). Residual: qualify SC-002.
- **#10** — "Server Actions would lose CSRF + portal-access gates": zero `'use server'` directives exist; `specs/001-auth-rbac/research.md` § 4.1 rejected Server Actions; Next's built-in Server-Action Origin check is *tighter* than the allow-list anyway; transport belongs to the plan's contracts artefact.

## Unverified (capped) — carried to `/speckit.plan` as inputs, NOT findings

These were raised but not adversarially verified in this round; the planner should treat them as questions, not defects. Grouped by theme:

1. **PII at rest outside the request table** — `notifications_outbox.context_data` carries the field diff (staff-addressed rows are not matched by the erasure outbox-cancel port; sent rows retained 90 days); audit payloads + insights redaction map + pino key-name redaction; the `member_id` snake_case payload key bumping `last_activity_at` on staff decisions.
2. **Portal-visible scope** — FR-029/FR-030 let one contact see another contact's old/new name and phone; DSAR export member- vs person-scoped.
3. **Tax-document edges** — registered address is the §86/4 buyer address when billing is unset (FR-019 flags only billing); draft invoice created before approval, issued after; proposed legal name vs frozen tax ID; contact name on the buyer block; billing-address removal semantics; the "no tax document data" retention rationale.
4. **Rate limit / idempotency mechanics** — 10-per-24h counter durable vs Upstash (fails open; CI smoke has no Redis); one-pending-per-person needs a DB constraint; FR-017's no-op vs refusal discriminator; the inherited idempotency waiver on the submit endpoint.
5. **Existing-mechanism reuse costs** — outbox `notification_type` enum + dispatcher branch migrations; new audit enum values (5 places); immutability-trigger GUC exemption for erasure scrub; `tenant_member_settings` update path + audit; migration `when` collision.
6. **Two preferred-language stores** (`members.preferred_locale` vs `contacts.preferred_language`) — FR-004 and FR-023 must name which; secondary-contact locale/address resolution through `RecipientLocalePort`.
7. **Surfaces** — F9 dashboard is a cron snapshot (AS3 timing); no nav badge slot; InsightsPanel is dismissible; loading/empty/error/permission states unnamed; who may *see* the queue (manager/marketing); FR-034 dialog dynamism; per-field error surface on the portal form.
8. **Editorial** — US5 scenario numbering (1,2,5,3,4); FR-031 permission key; "job title" = `role_title`; `member_cross_tenant_probe` reuse vs new event; BE display-only note; DPIA/RoPA update.

spec-review: GO WITH AMENDMENTS — one confirmed premise defect (FR-013 self-review clause guards an unreachable state; F1 §Q2 separate accounts + `role-portal-mismatch`) closes by deleting the clause and recording the boundary, no design change.