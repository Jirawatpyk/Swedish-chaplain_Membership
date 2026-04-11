# F2 → F3 Deferrals

Items from F2 Membership Plans spec that were **consciously deferred**
to F3 Member & Contact Management because they depend on F3-scope
entities (members table, member invoices, benefit inheritance) that
don't exist in F2.

**How to use this file**:
1. During `/speckit.specify` for F3 (`003-members-contacts`), grep
   this file and check each row against the F3 spec outline.
2. For every item marked "pending", either (a) add a matching US /
   AS / task to the F3 spec, or (b) move the row to the "resolved"
   section below with a pointer to the F3 artefact that addresses it.
3. This file is the **single place** F2 deferrals live. Do not
   scatter TODOs across spec.md / plan.md / QA reports — point
   everything back here instead.

**Invariant**: this file MUST NOT be deleted until every row under
"Pending for F3" has either been shipped or explicitly rejected.
Deleting it silently loses every F2 → F3 carry-over.

---

## Pending for F3

### D1 — US3 AS4 Partnership bundle-change warning

**Origin**: `spec.md` § US3 Acceptance Scenario 4 (F2 spec.md line 71)

**What the spec says**:
> **Given** the admin is editing a partnership plan,
> **When** they change the "includes Premium Corporate" toggle,
> **Then** a clear explanatory note surfaces in the review step
> warning that downstream benefit inheritance logic depends on this
> flag and member invoices already issued for the plan will not
> retroactively change.

**Why deferred**:
1. **Form shape mismatch** — F2 US3 `PlanEditForm` is a flat form
   (all fields in one pass, single Save). The spec's "review step"
   language assumes a multi-step wizard like US2's create flow.
   Refactoring the edit flow into a wizard for one warning would
   double the Save path's click-count for the 99% cosmetic-edit
   case.
2. **Downstream dependencies don't exist yet in F2**:
   - `members` table → F3 scope
   - `invoices` → F4 Payments scope
   - `includes_corporate_plan_id` is persisted correctly in F2 but
     NO code yet reads it to inherit benefits to real members.
3. **A warning with no real numbers is worse than no warning** —
   the spec wants "X existing members keep their Premium benefits;
   new signups after this save will get Large benefits instead".
   In F2 we'd have to write "0 members affected" every time, which
   trains the admin to ignore the dialog before it ever becomes
   accurate in F3.

**What F3 needs to add when `003-members-contacts` opens**:

| Item | Owner | Notes |
|---|---|---|
| `BundleChangeWarningDialog` component in `src/components/plans/` | Frontend | Reuses `AlertDialog` per UX standards § 4.1, shows member count + "keep/new" split |
| Detect `includes_corporate_plan_id` change in `edit-plan-client.tsx` client shell | Frontend | Compare `initialValues.includes_corporate_plan_id` vs `draft.includes_corporate_plan_id` before calling fetch; if different, open dialog; on confirm, proceed with PATCH |
| `GET /api/plans/[year]/[planId]/affected-members?newBundle=...` backend | Backend | Returns `{current_count: N, new_signup_warning: bool}` — reads members table (F3) filtered by `plan_id + plan_year` |
| i18n keys under `admin.plans.bundleChangeWarning.*` | i18n | EN/TH/SV; keys: `title`, `description` with `{currentCount}` + `{oldBundle}` + `{newBundle}` placeholders, `confirmCta`, `cancelCta` |
| Integration test: change bundle on partnership plan → verify warning dialog fires + count is accurate | Tests | Requires F3 member fixtures |
| Update F3 spec US3 (or whichever F3 US covers plan edits) | Spec | Add a line in the F3 acceptance scenarios that this bundle-change warning is now backed by real data |

**F3 acceptance criterion (proposed)**:
> Given a Partnership plan with 3 active members, when the admin
> changes `includes_corporate_plan_id` from Premium to Large and
> clicks Save, then a confirmation dialog shows "3 existing members
> keep their Premium Corporate benefits; new signups after this save
> will receive Large Corporate benefits", and only on explicit
> confirmation does the PATCH fire.

**Blockers removed when F3 ships**:
- Members table exists → the dialog can quote a real count
- F3 signup flow reads `includes_corporate_plan_id` → the warning's
  downstream claim is true

**Estimated scope**: ~4 hours during F3 implementation (1 component +
1 API route + 1 integration test + 1 i18n patch). Trivial if the
rest of F3's infrastructure is already in place.

---

## Resolved in F3

_None yet — F3 hasn't shipped._

When F3 merges an item from the pending list above, move the row
here with a pointer to the commit / PR / spec anchor that shipped it.
Example format:

```
### D1 — US3 AS4 Partnership bundle-change warning
**Shipped in F3**: commit abc1234 (`003-members-contacts` branch),
F3 spec AS `US3 AS7`.
```
