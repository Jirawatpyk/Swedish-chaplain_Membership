# PR-A — GDPR follow-ups (deferred 2026-07-15)

Raised by a `pdpa-gdpr-compliance-officer` review of `bb9607da` (audit/logger
redaction) and `cb4858a5` (Art. 14 attestation) on branch
`059-member-tax-correctness`. The reviewer's verdict was **APPROVE WITH
CONDITIONS — no blockers**; these are the conditions. None blocks the merge.

Two were fixed on the branch and are NOT listed here: the wrong-article citation
(H-2, fixed in `2ecfd952`) and the raw-`tax_id`-in-audit leak itself.

---

## H-1 — `invite-colleague` / `invite-user-for-member` collect a third party with no notice

**Severity: HIGH. Close before go-live.**

Both use-cases take a named natural person's details **from an admin**, exactly
like the two paths Task 8 closed — but they set `art14AttestedAt: null` and there
is no compensating notice.

I had assumed the invitation email discharged this ("they get an email, so they
learn they're in the system"). **The reviewer read the actual template
(`src/modules/auth/infrastructure/email/invitation-email.ts`) and I was wrong.**
It contains: a greeting, "an administrator has invited you", the assigned role, a
set-password CTA, a 7-day expiry, and a chamber-name footer.

It contains **none** of Art. 14(1)-(2): no purpose, no legal basis, no categories,
no recipients, no retention period, no rights list, no right to complain, not
even a privacy-policy link.

Receiving an email is a notice **delivery channel**. Art. 14 governs notice
**content**. So these two paths are in a *worse* position than the two Task 8
closed — those at least carry an attestation record.

**Two ways to close it** (either works):

- **(a) Extend the attestation gate.** Add the `z.literal(true)` Art. 14 checkbox
  to both use-cases, mirroring `contact-crud.ts` / `create-member.ts`.
- **(b) Put real Art. 14 content in the invitation email.** Controller identity,
  purpose, legal basis, retention, the rights list, the right to complain, and a
  privacy-policy link. The email then *is* the notice.

**Recommend (b).** It is automatic, it does not depend on an admin actually
having spoken to the person, and it is stronger evidence than a self-reported
attestation. It also fixes the notice for everyone already invited.

Files: `src/modules/members/application/use-cases/invite-colleague.ts:177`,
`invite-user-for-member.ts:287`,
`src/modules/auth/infrastructure/email/invitation-email.ts:78-115`.

---

## M-1 — the RoPA does not record any of this

**Severity: MEDIUM.**

`docs/compliance/processing-records.md` § F3 (last reviewed 2026-06-21) has no
entry for `contacts.art14_attested_at`, does not distinguish Art. 13 (collected
from the data subject) from Art. 14 (collected from a third party), and — most
importantly —

**does not record the maintainer's deliberate decision to leave `companyName` and
the address fields RAW in the `member_updated` audit diff.**

That decision (2026-07-14) is defensible: unlike `taxId` — whose *value* has no
audit worth beyond "it changed", so redacting it costs nothing — a name or
address change *is* a genuinely useful audit trail, and `audit_log` has its own
legal basis. But for the ~15 `individual` / `sole_proprietor` members,
`companyName` **is** a natural person's real name and the address **is** their
home address, and both survive an Art. 17 erasure for the full 5-year retention
window.

Right now that reasoning lives **only in `.superpowers/sdd/progress.md`** — a
gitignored scratch file. That is not where a supervisory authority or the PDPC
would look. As it stands, the decision would read as an oversight rather than a
decision.

**Action:** one paragraph under § F3 naming the retention basis (Art. 17(3)(e) —
establishment/exercise/defence of legal claims — is the stronger fit than
17(3)(b), since Chamber-OS has no external statutory mandate for change-history
retention the way F4 invoices have RD §87/3), the necessity/proportionality
reasoning, and an explicit acknowledgement that for the individual/sole-proprietor
subset this is natural-person PII.

---

## M-2 — the attestation copy is thinner than Art. 14(1)-(2), and shows no policy link

**Severity: MEDIUM.**

Current copy (`en.json:1368`, `:1472`, + th/sv):

> "I have informed this person that the chamber holds their contact details, and
> where to find the chamber's privacy policy."

Art. 14(1)-(2) requires purpose, legal basis, categories, recipients, retention,
the full rights list, and the right to complain. The attested statement delegates
all of that to "the privacy policy" — which is:

- **never shown to the admin.** The label is a static string with no `<a href>`,
  so there is nothing concrete for the admin to point the person *at*.
- **never verified to contain the Art. 14 elements.** Chamber-OS is explicitly not
  a CMS; the policy is tenant-hosted and outside this codebase. **If TSCC's policy
  is itself incomplete, this control fails silently even when every admin attests
  in good faith.**

F7 already has `TENANT_PRIVACY_POLICY_URL` (it powers the E-Blast unsubscribe
footer). Reuse it.

**Action:** name purpose / retention / rights explicitly in the attested
statement, and render the tenant's actual privacy-policy URL as a link beside the
checkbox.

---

## M-3 — the `tax_id` redaction is not retroactive

**Severity: MEDIUM. Answer before go-live.**

`bb9607da` stops a raw `tax_id` (which may be a foreign member's passport) being
written into `audit_log.payload.diff` going forward. It cannot reach rows already
written — `audit_log` is append-only and **nothing in `src/` ever issues an
`UPDATE` against it**. That property is exactly what made the leak serious, and it
is what makes the fix un-backdatable. Any pre-existing raw value is there for the
full 5-year window.

Free-form `tax_id` has been live since F3, so such rows *can* exist.

**Action — run against prod and record the answer:**

```sql
SELECT count(*)
  FROM audit_log
 WHERE event_type = 'member_updated'
   AND payload->'diff'->'taxId' IS NOT NULL;
```

Prod was wiped twice (2026-07-10, 2026-07-12), so this is *probably* 0 — but that
is an **operational accident, not a guarantee**, and "probably zero" is not an
answer a regulator accepts. If the count is non-zero: either accept it as a
documented residual, or write a one-time redaction migration.

---

## Not deferred — already done on the branch

- **H-2** (we cited the wrong article — Art. 14(5)(a) is an *exemption* from
  notice, not a licence to deliver notice by another channel and claim none was
  owed): fixed in `2ecfd952` across the migration, the domain type and the test
  docblock. The control is now correctly described as the Art. 14(1)-(2) duty
  **discharged out-of-band**, with the timestamp as Art. 5(2) accountability
  evidence.
