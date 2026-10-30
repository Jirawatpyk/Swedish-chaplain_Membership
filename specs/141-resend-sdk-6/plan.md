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
- **Keep `/audiences` by raw `sdk.get/post/delete` calls.** The architect's preference for a byte-identical wire; the maintainer chose to accept `/segments`, the provider's current API, after it was measured equivalent (spec § Premises).

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md`; the auth and renewals module rules where present.
- **Slice 1:**
  - `package.json`, `pnpm-lock.yaml`
  - new `tests/contract/resend/{auth-email,renewals-email,broadcasts-sdk}.contract.test.ts`
  - `tests/support/broadcasts/resend-contract-fake.ts` (only if 6.x needs it)
  - `src/**` only where the suite or `tsc` flags it
  - docs: `.claude/rules/modules/broadcasts.md`, `specs/139-eblast-erasure-close/research.md`, `docs/changelog.md`, `docs/email-broadcast-analysis.md`, `docs/go-live-readiness.md`
- **Slice 2:**
  - `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx` (the send option, and `mapResendError` for the two idempotency 409s)
  - `tests/unit/renewals/infrastructure/resend-transactional-renewal-gateway.test.ts`
  - `tests/contract/resend/renewals-email.contract.test.ts` (re-recorded)

## Data model and migration

n/a

## Slices (L only)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | The bump, behaviour identical | RS1–RS5 | security-engineer, pdpa-gdpr, spec-compliance-auditor | `141-resend-sdk-6-s1` | #704 · done |
| 2 | Renewals send a real Idempotency-Key | RI1–RI3 | reliability-guardian, spec-compliance-auditor | `141-resend-sdk-6-s2` | — · open |

## Test plan

| Done-when line | Test that goes red first | Level |
|---|---|---|
| RS1 / RS2 | `tests/contract/resend/*.contract.test.ts`: written on 4.8 and green there by design; every URL is pinned, so an unexpected path fails its snapshot. A **positive control** per file (one asserted value mutated on 4.8, then restored) proves each can fail. The bump is the RED event; every case it turns red is listed in Evidence with its disposition. | contract |
| RS2 build | `pnpm build` on the bumped tree | build |
| RS3 | `node_modules/resend/dist/index.mjs` (6.35.0), each point read in the source and exercised by a contract case on 6.35: **`post`** public at `:1764`, sets `Idempotency-Key` from its third argument at `:1769` (case "sendBroadcast carries the Idempotency-Key header"). **`emails` / `batch`** are instance fields set in the constructor, `:1653` / `:1648` (so `tests/integration-setup.ts` can still override them). **Buffer attachment** is passed to `JSON.stringify` unchanged and goes out as `{type:'Buffer',data:[…]}` (case "a send with a PDF attachment", byte-identical to 4.8). **`has_more`**: the list response body is returned as-is (`:1746`); measured `has_more:false` on both paths (spec § Premises); case "getAudienceContactCount reads data length and has_more". **Network failure**: the outer `catch` at `:1750` returns `statusCode: null` (`:1753`), read as transient (case "reads a network failure as transient and retries it"). A non-JSON error body: the `SyntaxError` branch at `:1708` now sets `statusCode: response.status` — the 413 change in RS2. Also `this.audiences = this.segments` `:1646`; `RESEND_BASE_URL` `:1633`; `RESEND_DEBUG` `:1639`. |
| RS4 | **On :3400** (branch server, dev DB, 2026-10-30): `POST /api/auth/forgot-password` for the `e2e-member-empty` persona (a reserved `.test` address, so nothing can be delivered) → 200 neutral body; Resend lists the message `01a18c52-de0b-76c8-b1b0-7db6fc275c02`, subject "Reset your SweCham password", status `sent` at 10:20:03 UTC — the live password-reset path on 6.35 inside the Next server runtime. `GET /api/cron/broadcasts/reconcile-stuck-sending` with the cron Bearer → 200, `processed: 0` (no `sending` row on dev, so no provider call), which loads the Broadcasts gateway and the SDK in the Next runtime; without the Bearer → 401. `/admin/broadcasts` as the e2e admin (Playwright probe, deleted) → 200, heading "E-Blast review queue", no error boundary. **E-Blast draft create → get → delete** was driven through the real gateway, not the UI, because a draft reaches Resend only at dispatch, which would send, and dev and prod share the Broadcasts key: a throwaway `tsx` probe on 6.35 (deleted), `delivered@resend.dev` only, no broadcast sent — `createAudience` (now `/segments`) → `06f717e3-…` → `addContactsToAudience` → `getAudienceContactCount` `{count:1, complete:true}` → `createBroadcast` → `retrieveBroadcast` `draft` → `deleteBroadcast` → `not_found` → `deleteAudience` → absent from the list. The same probe sent a transactional email with a PDF attachment to the sink: message `01a18c4b-c954-738b-9fde-82ecd283ca09`, status `delivered`. **The void-notice cron run was waived by the maintainer** (30 Oct 2026): the flag is off in prod, and the attachment is pinned by the contract case and the delivered sink send. |
| RI1 | `resend-transactional-renewal-gateway.test.ts`: "sends the idempotency key as the request option, not an email header". It fails on the current code. | unit |
| RI1b | the same file: one case per idempotency 409 code | unit |
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
- **X Simplicity:** zero new direct dependencies; one moves version, and 6.35 brings two new transitive ones (`postal-mime`, `standardwebhooks`), justified by the bump.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (auth / PII email surface): the five checks in `review-and-ship` § 2 | No second human reviewer | — |
| Slice 1's "RED" is the bump, not a test commit | The suite characterises existing behaviour, so it is green by design; each file's positive control is its recorded failing run | A test that fails before the change cannot exist for "nothing changes"; the positive control proves the suite can fail |
| RS4's void-notice cron run waived; the E-Blast draft lifecycle checked at the gateway | Driving a draft through the UI reaches Resend only at dispatch, which sends; the void-notice flag is off in prod | The maintainer chose (30 Oct 2026) to run :3400 for password reset and the E-Blast surface, and to waive the void-notice run. The attachment is pinned by the contract case and a delivered sink send |

## Evidence

### Slice 1 (30 Oct 2026)

| Done-when | Evidence |
|---|---|
| RS1 | `tests/contract/resend/` written on 4.8 (`3920dd2a9`, `55783a423`): auth 6, renewals 3, broadcasts 13 cases. **Positive controls** on 4.8 (one asserted value mutated, then restored), each failing alone: auth "a plain send", renewals "a reminder send", broadcasts "sendBroadcast carries the Idempotency-Key header". |
| RS2 | `resend` exact `6.35.0`, lockfile integrity `sha512-sScNQHunU2Np7oICQ/44GXif8cQ0lp2WPEo9nDtTnM1koPvgJwH/SEee8mJwYRwyIfi+uj7IetKiYspfyYBYaA==` (`f69ca27f6`). The bump turned **5** cases red, all accepted and re-recorded: `createAudience`, `getAudienceContactCount`, `listAudiences`, `deleteAudience` (`/audiences…` → `/segments…`, measured equivalent, spec § Premises), and the non-JSON 413 (6 retryable attempts → 1, `permanent`). Every other pinned request is byte-identical (auth plain / text / PDF attachment, renewals, broadcasts create / send with Idempotency-Key / get / contacts create & remove). Resend-related suites on 6.35: **52 files, 559 tests passed**. `pnpm check` exit 0. `pnpm build` exit 0 (compiled; 129/129 pages) — run with `E2E_X_TENANT_HEADER_ENABLED=false` and a placeholder `TENANT_PRIVACY_CONTACT_EMAIL`, because `.env.local` is a dev file that `env.ts` refuses under a production build; no `Module not found` for the optional `@react-email/render` peer. |
| RS3 | `node_modules/resend/dist/index.mjs` (6.35.0), each point read in the source and exercised by a contract case on 6.35: **`post`** public at `:1764`, sets `Idempotency-Key` from its third argument at `:1769` (case "sendBroadcast carries the Idempotency-Key header"). **`emails` / `batch`** are instance fields set in the constructor, `:1653` / `:1648` (so `tests/integration-setup.ts` can still override them). **Buffer attachment** is passed to `JSON.stringify` unchanged and goes out as `{type:'Buffer',data:[…]}` (case "a send with a PDF attachment", byte-identical to 4.8). **`has_more`**: the list response body is returned as-is (`:1746`); measured `has_more:false` on both paths (spec § Premises); case "getAudienceContactCount reads data length and has_more". **Network failure**: the outer `catch` at `:1750` returns `statusCode: null` (`:1753`), read as transient (case "reads a network failure as transient and retries it"). A non-JSON error body: the `SyntaxError` branch at `:1708` now sets `statusCode: response.status` — the 413 change in RS2. Also `this.audiences = this.segments` `:1646`; `RESEND_BASE_URL` `:1633`; `RESEND_DEBUG` `:1639`. |
| RS4 | **On :3400** (branch server, dev DB, 2026-10-30): `POST /api/auth/forgot-password` for the `e2e-member-empty` persona (a reserved `.test` address, so nothing can be delivered) → 200 neutral body; Resend lists the message `01a18c52-de0b-76c8-b1b0-7db6fc275c02`, subject "Reset your SweCham password", status `sent` at 10:20:03 UTC — the live password-reset path on 6.35 inside the Next server runtime. `GET /api/cron/broadcasts/reconcile-stuck-sending` with the cron Bearer → 200, `processed: 0` (no `sending` row on dev, so no provider call), which loads the Broadcasts gateway and the SDK in the Next runtime; without the Bearer → 401. `/admin/broadcasts` as the e2e admin (Playwright probe, deleted) → 200, heading "E-Blast review queue", no error boundary. **E-Blast draft create → get → delete** was driven through the real gateway, not the UI, because a draft reaches Resend only at dispatch, which would send, and dev and prod share the Broadcasts key: a throwaway `tsx` probe on 6.35 (deleted), `delivered@resend.dev` only, no broadcast sent — `createAudience` (now `/segments`) → `06f717e3-…` → `addContactsToAudience` → `getAudienceContactCount` `{count:1, complete:true}` → `createBroadcast` → `retrieveBroadcast` `draft` → `deleteBroadcast` → `not_found` → `deleteAudience` → absent from the list. The same probe sent a transactional email with a PDF attachment to the sink: message `01a18c4b-c954-738b-9fde-82ecd283ca09`, status `delivered`. **The void-notice cron run was waived by the maintainer** (30 Oct 2026): the flag is off in prod, and the attachment is pinned by the contract case and the delivered sink send. |
| RS5 | `14d9a324f`: broadcasts rule (SDK pin, segments alias, never `RESEND_DEBUG` / `RESEND_BASE_URL`), 139 research SDK line, changelog, email-broadcast-analysis and go-live § 6.6 platform-risk notes. `RESEND_DEBUG` and `RESEND_BASE_URL` absent from the Vercel project's env listing (88 keys, names only; 2026-10-30). |

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
