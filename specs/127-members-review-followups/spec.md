# 127 — Members review follow-ups (deferred from PR #645)

**Size**: M (renewals money path, members use case + route + edit form, i18n; no migration, no flag).
**Status**: built on `127-members-review-followups`, 25 Oct 2026.
**Source**: the PR #645 reviews (financial-integrity M-1, security-engineer L2/L3, /code-review high), listed in `specs/126-members-plans-review-fixes/spec.md` § Out of scope.

The maintainer's decisions:
- **Legal entity type edit:** block it, but allow an override reason.
- **Plan-change age date:** keep "today", and write the rule down.

## Done when

1. **Archive → undelete carries an unpaid invoice.**
   - **The bill moves to the restored cycle.** When the member's latest cycle is `cancelled` and still linked to an `issued` invoice, the restore:
     - re-creates the cycle for that billed period;
     - moves the link off the cancelled row, so exactly one cycle holds it;
     - reconciles the frozen plan fields to what was billed;
     - moves the cycle `upcoming → awaiting_payment`.
     
     A later payment then completes it. This covers the bulk Undo too.
   - **Paid or credited bills are not moved.** Paying while archived already seeded the next cycle; relinking would grant a free term.
   - **The invoice row is locked first**, so the restore serialises with a payment of the same invoice.
2. **A payment that lands on a `cancelled` cycle raises the admin work item** (`post_termination_payment_review`) even when the period has not expired. It used to be skipped silently.
3. **`updateMember` checks a CHANGED legal entity type against the member's current plan `memberTypeScope`.**
   - "Changed" means it differs from the locked row, so an echoed value never blocks an edit.
   - It refuses with 422 `member_type_warning` unless `override_reason_code` is given. The override is recorded on `member_updated`.
   - The edit form's override dialog re-sends the FIELD patch, not a plan payload.
   - The warning names the plan's member type (EN/TH/SV).
   - Write paths for `legal_entity_type`: `createMember` (126) and `updateMember` (127). The F114 change requests never set it.
4. **Age rule.** A plan change measures the primary contact's age on the day of the change; `createMember` uses the registration date.
5. **Bulk archive/unarchive.**
   - It logs one completion line per batch after its post-commit cascades.
   - The route sets `maxDuration = 300`.
   - A shared portal user being revoked everywhere is an accepted risk (`specs/001-auth-rbac/security.md`).

## Out of scope
- Paying the invoice while the member is archived, with no next cycle seeded: the restore does not synthesise the completion. The payment work item covers it.
- `createNextCycleOnPaid` seeding a cycle for an archived member (pre-existing; financial-integrity note).
