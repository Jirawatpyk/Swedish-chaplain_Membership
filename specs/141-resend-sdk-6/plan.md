# Plan: Resend SDK 4.8 → 6.x; renewals send a real Idempotency-Key

Spec: `specs/141-resend-sdk-6/spec.md` · Size: L · Agreed by the user on: 30 Oct 2026 (plan mode)

## Approach

**Pin first, then bump.** Slice 1 starts on 4.8 with a contract suite that drives the real SDK against a stubbed global `fetch`. It records exactly what each caller puts on the wire, and how each caller reads `{ data, error }` and a network failure. This is characterisation, so the suite passes on 4.8 by design. The bump to 6.35.0 is what can turn it red: any wire change fails it.

After the bump we:
- check the five confirm points in `node_modules/resend`;
- fix only what the suite or `tsc` flags;
- leave `RESEND_DEBUG` unset.

Slice 2 is ordinary TDD on the renewals gateway.

**Paths kept compatible:** auth email, outbox email and renewals email. Their usage lines are in `spec.md` § Premises (D-041).

**Alternatives not taken:**
- **Bump to 5.x only.** It does not bring `signal`, which spec 140 needs.
- **Fold the bump into spec 140.** That would widen 140's review with sign-in and renewal email.
- **Move to segments now.** The maintainer moved it to 140.

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md`; the auth and renewals module rules where present.
- **Slice 1:**
  - `package.json`, `pnpm-lock.yaml`
  - new `tests/contract/resend/{auth-email,renewals-email,broadcasts-sdk}.contract.test.ts`
  - `tests/support/broadcasts/resend-contract-fake.ts` (gains `post` if 6.x needs it)
  - `src/**` only where the suite or `tsc` flags it
- **Slice 2:**
  - `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx`
  - `tests/unit/renewals/infrastructure/resend-transactional-renewal-gateway.test.ts`

## Data model and migration

n/a

## Slices (L only)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | The bump, behaviour identical | RS1–RS5 | security-engineer, pdpa-gdpr, spec-compliance-auditor | `141-resend-sdk-6-s1` | — · open |
| 2 | Renewals send a real Idempotency-Key | RI1–RI3 | reliability-guardian, spec-compliance-auditor | `141-resend-sdk-6-s2` | — · open |

## Test plan

| Done-when line | Test that goes red first | Level |
|---|---|---|
| RS1 / RS2 | `tests/contract/resend/*.contract.test.ts`: written on 4.8 and green there by design. The RED event is the bump; record any case it turns red, and its fix. | contract |
| RS3 | none (a source read, recorded in Evidence) | — |
| RS4 | the live Verify on :3400 (Evidence) | manual |
| RI1 | `resend-transactional-renewal-gateway.test.ts`: "sends the idempotency key as the request option, not an email header". It fails on the current code. | unit |
| RI2 | the live sink measurement (Evidence) | manual |

## Constitution Check

- **I Data Privacy & Security:** no change to what is sent or to whom. Keys stay in env. No PII in tests (example.com addresses only).
- **II Test-First:** the contract suite comes before the bump; slice 2 has its RED.
- **III Clean Architecture:** unchanged. The SDK stays in infrastructure, and the ESLint rule forbids it in the domain.
- **IV PCI:** n/a.
- **V i18n:** n/a.
- **VI Inclusive UX:** n/a.
- **VII Perf & Observability:** n/a.
- **VIII Reliability:** slice 2 closes a double-send window on renewals.
- **IX Code Quality:** an exact pin.
- **X Simplicity:** zero new dependencies; one dependency moves version.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (auth / PII email surface): the five checks in `review-and-ship` § 2 | No second human reviewer | — |
| Slice 1's "RED" is the bump, not a test commit | The suite characterises existing behaviour, so it is green by design | Writing a failing test first is not possible for "nothing changes" |

## Evidence

(Filled in at Verify.)

## Rollout

- **Slice 1:** goes live on merge, with no flag. Every email path runs on 6.x. Rollback is a revert commit.
- **Slice 2:** goes live on merge. Renewals start sending a real `Idempotency-Key`. Rollback is a revert commit.

## Risks

| Risk | How we notice |
|---|---|
| A 6.x wire change alters an email | the contract suite, plus the live sink sends |
| A PDF attachment encodes differently | the attachment contract case, plus the live invoice send |
| `post` is no longer public | the confirm step; then `broadcasts.send(id, { idempotencyKey })`, with the existing `resend-send-broadcast.test.ts` as the pin |
| The SDK starts logging errors (or stops) | 6.35 makes logging opt-in; nothing of ours reads SDK logs |
