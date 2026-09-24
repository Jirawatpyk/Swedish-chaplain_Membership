# Tasks: Void-on-reissue supersede links

One task per behaviour; each names the test that goes RED first.

- [x] **T1 — AS1 forward link.** RED: `tests/integration/invoicing/invoice-supersession.test.ts`
      "resolves the replacement of a supersede-voided bill" (old bill → new bill id, SC number,
      issue date). GREEN: port + `invoiceSupersessionAdapter.findReplacement` + use-case.
- [x] **T2 — AS2 reverse link.** RED: same file, "resolves the bill(s) a replacement superseded".
      GREEN: `findReplaced` + migration `0305` (partial expression indexes).
- [x] **T3 — AS3 manual void shows nothing.** RED: same file, "a manual void has no link in
      either direction".
- [x] **T4 — AS4 cross-tenant isolation (Principle I.3 blocker).** RED: same file, two tenants;
      tenant B resolves neither direction of tenant A's link, including a forged tenant-B
      `invoice_voided` row naming a tenant-A invoice id; plus a DB-layer check that tenant B's
      RLS context sees none of tenant A's supersede rows.
- [x] **T5 — AS5 member scope (portal access).** RED: same file, a link to another member's
      invoice is dropped under `restrictToMemberId`, kept for staff; unit test
      `tests/unit/invoicing/get-invoice-supersession.test.ts` covers the drop + log, draft
      filtering and the `read_failed` branch.
- [x] **T6 — Admin UI.** "Replaced by" dashed row in the Voided section, "Replaces" field on
      the new bill. i18n EN/TH/SV.
- [x] **T7 — Portal UI.** "This bill was replaced by …" in the void block, "Replaces …" on the
      details card, rendered only from the member-scoped read. i18n EN/TH/SV.
- [x] **T8 — Gates.** `pnpm lint`, `pnpm typecheck`, `pnpm check:i18n`, `pnpm test`, the
      touched integration files by path, `pnpm db:migrate`.
