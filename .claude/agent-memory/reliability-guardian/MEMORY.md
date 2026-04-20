# Reliability Guardian — Memory Index

- [US4 Bulk+InlineEdit Review Patterns](us4-review-patterns.md) — recurring error-leak and tx patterns found in bulk-action + inline-edit use cases (F3, 2026-04-16)
- [F3 Outbox Migration Patterns](f3-outbox-migration-patterns.md) — create-user atomicity gap, enqueue non-fatal tolerance, dispatcher permanent-fail audit gap, change-plan split-write (2026-04-17)
- [F4 Invoicing Reliability Review](f4-invoicing-review-2026-04-19.md) — confirmed-correct patterns + gaps: applyDraftUpdate missing status guard, locale hardcoded 'en' in outbox, 0021 index non-concurrent (2026-04-19)
- [F4 US7 Member-Invoices Review](f4-us7-invoices-member-review-2026-04-20.md) — missing member-existence check in API route, Result<T,never> dishonesty, silent empty-state on repo failure, audit payload member_id pattern (2026-04-20)
