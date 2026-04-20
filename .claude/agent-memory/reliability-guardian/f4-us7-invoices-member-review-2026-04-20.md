---
name: F4 US7 Member-Invoices Review
description: Reliability findings from US7 diff — list-invoices-by-member, member-invoices-section, API route, member_id audit payload additions (2026-04-20)
type: project
---

## Key findings (2026-04-20)

**Critical — Missing member-existence check in API route**
`src/app/api/members/[memberId]/invoices/route.ts` calls `listInvoicesByMember` without first verifying the member exists in the current tenant. Any UUID returns `{rows:[], total:0}` with HTTP 200. Compare to `/api/members/[memberId]/timeline/route.ts` which verifies via `timelineList` → `memberRepo.findById` first. Fix: add memberRepo.findById check + return 404 on not_found before invoking the use case.

**Important — `ListInvoicesByMemberError = never` is dishonest**
`list-invoices-by-member.ts:35` — if `listPaged` throws (network, RLS error), the exception propagates uncaught through the Result wrapper. The type contract claims there are no errors, but a throw from the repo bypasses it. Fix: wrap `listPaged` in try/catch → return `err({type:'repo_error',...})` and widen the error type.

**Important — Silent empty state on repo failure (Server Component)**
`member-invoices-section.tsx:96` — `result.ok ? result.value.rows : []` swallows repo errors silently; the UI renders "No invoices" instead of an error state. Since `ListInvoicesByMemberError = never`, result.ok is always true in the type system — but if the use-case is fixed to return repo errors, this fallback will silently hide them. Compare to getMember on the parent page which propagates errors. Fix: when `!result.ok`, throw an Error to trigger the nearest error.tsx boundary (or render an explicit ErrorState component).

**Suggestion — Audit payload `member_id` divergence risk**
`record-payment.ts:297` and `issue-credit-note.ts:512` now include `member_id: loaded.memberId` in the audit payload. This is safe (no PII beyond what's already in the invoice row, and is the entity FK not a person identifier). However, `F4AuditEvent.payload` is typed as `Record<string, unknown>` — future events can silently omit `member_id` without a type error. Consider tightening to per-event discriminated union payload shapes.

**Patterns confirmed correct:**
- `member_id` in audit payload reads from `loaded.memberId` (already fetched from DB in the same tx), not from untrusted input — no divergence risk if FK is immutable.
- audit.emit is inside the same Drizzle tx in both record-payment and issue-credit-note — atomic.
- No PII in log payload at route level (only requestId + err).
- Payment reference stored as sha256 only — no plaintext in audit.

**Anti-pattern noted:**
- Thin use-case wrappers that call a repo method directly and return `Result<T, never>` (i.e., claim infallibility) are a recurring pattern in F4. Any unchecked throw from the repo breaks the Result contract silently. Always wrap repo calls in try/catch inside Application use cases.
