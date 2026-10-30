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
| RS3 | none (a source read, recorded in Evidence) | — |
| RS4 | the live Verify on :3400 (Evidence) | manual |
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
| RS2 | `resend` exact `6.35.0`, lockfile integrity `sha512-sScNQHunU2Np7oICQ/44GXif8cQ0lp2WPEo9nDtTnM1koPvgJwH/SEee8mJwYRwyIfi+uj7IetKiYspfyYBYaA==` (`f69ca27f6`). The bump turned **5** cases red, all accepted and re-recorded: `createAudience`, `getAudienceContactCount`, `listAudiences`, `deleteAudience` (`/audiences…` → `/segments…`, measured equivalent, spec § Premises), and the non-JSON 413 (6 retryable attempts → 1, `permanent`) — the 413 went back to its 4.8 recording in review round 2 (option A, below). Every other pinned request is byte-identical (auth plain / text / PDF attachment, renewals, broadcasts create / send with Idempotency-Key / get / contacts create & remove). Resend-related suites on 6.35: **52 files, 559 tests passed**. `pnpm check` exit 0. `pnpm build` exit 0 (compiled; 129/129 pages) — run with `E2E_X_TENANT_HEADER_ENABLED=false` and a placeholder `TENANT_PRIVACY_CONTACT_EMAIL`, because `.env.local` is a dev file that `env.ts` refuses under a production build; no `Module not found` for the optional `@react-email/render` peer. |
| RS3 | `node_modules/resend/dist/index.mjs` (6.35.0), each point read in the source and exercised by a contract case on 6.35: **`post`** public at `:1764`, sets `Idempotency-Key` from its third argument at `:1769` (case "sendBroadcast carries the Idempotency-Key header"). **`emails` / `batch`** are instance fields set in the constructor, `:1653` / `:1648` (so `tests/integration-setup.ts` can still override them). **Buffer attachment** is passed to `JSON.stringify` unchanged and goes out as `{type:'Buffer',data:[…]}` (case "a send with a PDF attachment", byte-identical to 4.8). **`has_more`**: the list response body is returned as-is (`:1746`); measured `has_more:false` on both paths (spec § Premises); case "getAudienceContactCount reads data length and has_more". **Network failure**: the outer `catch` at `:1750` returns `statusCode: null` (`:1753`), read as transient (case "reads a network failure as transient and retries it"). A non-JSON error body: the `SyntaxError` branch at `:1708` now sets `statusCode: response.status` — the 413 change in RS2. Also `this.audiences = this.segments` `:1646`; `RESEND_BASE_URL` `:1633`; `RESEND_DEBUG` `:1639`. |
| RS4 | **On :3400** (branch server, dev DB, 2026-10-30): `POST /api/auth/forgot-password` for the `e2e-member-empty` persona (a reserved `.test` address, so nothing can be delivered) → 200 neutral body; Resend lists the message `01a18c52-de0b-76c8-b1b0-7db6fc275c02`, subject "Reset your SweCham password", status `sent` at 10:20:03 UTC — the live password-reset path on 6.35 inside the Next server runtime. `GET /api/cron/broadcasts/reconcile-stuck-sending` with the cron Bearer → 200, `processed: 0` (no `sending` row on dev, so no provider call), which loads the Broadcasts gateway and the SDK in the Next runtime; without the Bearer → 401. `/admin/broadcasts` as the e2e admin (Playwright probe, deleted) → 200, heading "E-Blast review queue", no error boundary. **E-Blast draft create → get → delete** was driven through the real gateway, not the UI, because a draft reaches Resend only at dispatch, which would send, and dev and prod share the Broadcasts key: a throwaway `tsx` probe on 6.35 (deleted), `delivered@resend.dev` only, no broadcast sent — `createAudience` (now `/segments`) → `06f717e3-…` → `addContactsToAudience` → `getAudienceContactCount` `{count:1, complete:true}` → `createBroadcast` → `retrieveBroadcast` `draft` → `deleteBroadcast` → `not_found` → `deleteAudience` → absent from the list. The same probe sent a transactional email with a PDF attachment to the sink: message `01a18c4b-c954-738b-9fde-82ecd283ca09`, status `delivered`. **The void-notice cron run was waived by the maintainer** (30 Oct 2026): the flag is off in prod, and the attachment is pinned by the contract case and the delivered sink send. |
| RS5 | `14d9a324f`: broadcasts rule (SDK pin, segments alias, never `RESEND_DEBUG` / `RESEND_BASE_URL`), 139 research SDK line, changelog, email-broadcast-analysis and go-live § 6.6 platform-risk notes. `RESEND_DEBUG` and `RESEND_BASE_URL` absent from the Vercel project's env listing (88 keys, names only; 2026-10-30). |

**Review round 1 (30 Oct 2026)** — `/code-review high`, security-engineer, pdpa-gdpr, spec-compliance-auditor:
- **Empty-id guard** (code-review, the most serious): on 6.35 a falsy `audienceId` drops the audience from the path, so `contacts.remove` becomes the account-wide `DELETE /contacts/{email}` (`index.mjs` Contacts `remove`). RED `a4674b4a8`: 5 cases in "an empty id never reaches the SDK" failed — `promise resolved "{ kind: 'detached' }" instead of rejecting`, `promise resolved "{ count: +0, complete: true }" instead of rejecting`; the empty-email case retried for 30 s. GREEN `1fd21df2a`: `assertNonEmpty` refuses `empty_identifier` (permanent) before any request in `addContactsToAudience`, `removeContactFromAudience`, `getAudienceContactCount`, `deleteAudience`.
- **Non-JSON error status**: the maintainer first accepted the 6.35 reading; **superseded in round 2** (below).
- **`/segments` page size**: MEASURED 2026-10-30 on the live account (sink only, all removed): a throwaway segment with 25 and then 110 `delivered+p141-n@resend.dev` contacts — `GET /segments/{id}/contacts` and `/audiences/{id}/contacts` with no `limit` both returned all 110, `has_more: false`. The finding does not hold at that size.
- **Contract suite gaps closed**: the auth file mocks `@/lib/env` (the recorded `from` no longer depends on a developer's `RESEND_FROM_EMAIL`; a mutated `fromEmail` turned 3 cases red); renewals gained network-failure and 500 cases (positive control: `attempts 3` failed); broadcasts gained a network-failure case; the `as never` casts became `satisfies` / typed constants.
- **Docs**: stale `resend@4.8` comments in the gateway now say what 6.35 does; the provenance line corrected (two transitive deps carry no attestation); the erasure runbook notes the dashboard may say Segments; spec RS4 records the waiver; an unrelated `deprecated:` line `pnpm add` dropped from the lockfile is restored.
- **Checks after the fixes**: `pnpm check` exit 0 (one pre-existing lint warning in `tests/unit/layout/breadcrumb-provider.test.tsx`); `tests/contract/` + `tests/unit/broadcasts` + `tests/unit/broadcast`: 517 files, 6,172 tests passed; integration on dev: `dispatch-persist-before-send`, `erasure-vs-dispatch-begun`, `erase-member-subprocessor-cascade`, `subprocessor-erasure` — 4 files, 14 tests passed.
- **Carried, not fixed here** (security LOW): a code guard against `RESEND_DEBUG` / `RESEND_BASE_URL` (pass `baseUrl` to each `new Resend`, refuse `RESEND_DEBUG` in production in `env.ts`) — **slice 2, by the maintainer's word (30 Oct 2026)**.

**Review round 2 (30 Oct 2026)** — `/code-review high` and security-engineer:
- **Option A, the maintainer's final choice** ("don't mix; don't switch again"): The gateway keeps the 4.8 reading (the maintainer's choice, 30 Oct 2026, after review round 2 found that otherwise an HTML 404 on the erasure path writes a false "already absent" into the Art. 30 record): an error the SDK builds itself (`application_error` — a non-JSON body, or a thrown fetch) reads as a transient 500 whatever status it carries (a thrown fetch as the network class); any other `statusCode: null` error is an SDK-local refusal and is permanent; a real Resend error keeps its status. Pinned per case in `tests/contract/resend/broadcasts-sdk.contract.test.ts`. `httpStatusOf` is the one place the gateway reads a status from the SDK; `classifyResendError` and the `deleteAudience` / `deleteBroadcast` already-gone checks both go through it. This closes: an HTML 404 writing a false "already absent" on the erasure path (both reviewers); an HTML 404 mid-`addContactsToAudience` failing a dispatch; an HTML 404 making the reconciler mark a sending broadcast failed; a thrown fetch tagged `server_5xx` instead of `network`; SDK-local `statusCode: null` refusals retried ~31 s.
- **Empty-id guard on every method** that takes an id or an email (`createBroadcast`, `sendBroadcast`, `retrieveBroadcast`, `deleteBroadcast`, `deleteContactGlobally`, `createContactImport`, besides the round-1 four); the `*Once` methods answer `{ kind: 'other' }` with no request; a `null` is refused as a `GatewayThrowable`, not a raw `TypeError`.
- RED `833608b55`: 19 cases failed, e.g. `expected { outcome: 'resolved', attempts: 1 } to deeply equal { outcome: 'retryable', …(2) }` (HTML 404 on `removeContactFromAudience`), `TypeError: Cannot read properties of null (reading 'trim')`, and the network subKind. GREEN `91f5b9a40`: contract 49 passed; `tests/contract/` + `tests/unit/{broadcasts,broadcast,members}` 733 files / 8,142 tests passed; `pnpm check` exit 0; the 4 gateway integration files on dev, 14 tests passed.
- **Carried to spec 140** (pre-existing, unchanged by this PR): `contacts.remove` puts the email into the path unencoded (zod fences `/ ? #`; encoding would change the erasure wire pdpa confirmed byte-identical); `listAudiences` ignores `has_more` on `/segments` (the 110-contact measurement was a segment's contacts; 3 segments today) — **fixed in round 3**.

**Review round 3 (30 Oct 2026)** — `/code-review high`, security-engineer, pdpa-gdpr (all three APPROVE with conditions):
- **Raw-fetch calls follow option A too** (security Medium + code-review; the maintainer: "fix it"): `rawHttpStatusOf` reads an error status only from Resend's own JSON error (it parses, it has a `name`); any other error body is a transient 500. `deleteBroadcastOnce`, `retrieveBroadcastOnce` and every `importFetch` caller (`deleteContactGlobally`, the import calls) go through it, and `deleteContactGlobally`'s dead `http_404` arm is gone. RED `06d558973`: `expected { kind: 'absent' } to deeply equal { kind: 'retryable' }`, `expected { kind: 'not_found' } …`, `expected { outcome: 'resolved', attempts: 1 } to deeply equal { outcome: 'retryable', attempts: 6 }`. GREEN `4cdd905dc`.
- **`listAudiences` pages `/segments`** (code-review): follows `has_more` with `limit=100` and an `after` cursor, each page its own retry, capped at 50 pages. **`getContactImport` guarded**; the blank-id rule is one `isBlankId` predicate. **The reclaim refusal** accepts "last segment" as well as "last audience" (the `/segments` wording was not measured; deleting the last segment cannot be probed on an account prod shares). RED `595624453` (3 failing), GREEN `e5916e211`; the `listAudiences` pin gains `?limit=100`.
- **Runbook** (pdpa Medium + Low): `docs/runbooks/member-erasure.md` tells the two failure causes apart — `empty_identifier` (check the broadcast row, nothing to open in Resend) and retries exhausted (an edge page is read as transient on purpose; the contact is not known to be gone).
- **Refuted / carried**: pdpa "HIGH" (up to 31 s of retry per audience inside `eraseMember`) is the 4.8 behaviour live on `main` today, restored by option A, not introduced here — carried to spec 140 with the lease work. The branded non-empty id type (code-review altitude) is a port-wide change, carried to spec 140. `RESEND_DEBUG` / `RESEND_BASE_URL` code guard: slice 2.
- **Checks**: `tests/contract/resend/` + `tests/unit/broadcasts/infrastructure` 48 files / 539 tests (one `broadcasts-deps` case timed out while a second suite ran alongside; solo 10/10); the earlier full run `tests/contract/` + `tests/unit/{broadcasts,broadcast,members}` 733 files / 8,151 tests; `pnpm check` exit 0; the 4 gateway integration files on dev, 14 tests passed.

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
