# Plan: Resend SDK 4.8 → 6.x; renewals send a real Idempotency-Key

Spec: `specs/141-resend-sdk-6/spec.md` · Size: L · Agreed by the user on: 30 Oct 2026 (plan mode)

## Approach

**Pin first, then bump.** Slice 1 starts on 4.8 with a contract suite that drives the real SDK against a stubbed global `fetch`. It records exactly what each caller puts on the wire, and how each caller reads `{ data, error }` and a network failure. This is characterisation, so the suite passes on 4.8 by design. The bump to 6.35.0 is what can turn it red: any wire change fails it.

After the bump we:
- check the five confirm points in `node_modules/resend`;
- fix only what the suite or `tsc` flags — review rounds 1–5 widened this to the Broadcasts gateway's error reading, the empty-id guard and `listAudiences` paging (§ Evidence);
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
  - `src/**` only where the suite or `tsc` flags it — as built: `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` (`httpStatusOf`, `rawHttpStatusOf`, `isProviderGone`, `assertNonEmpty`, `listAudiences` paging, comments), `src/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences.ts` (the last-audience refusal), `src/modules/members/infrastructure/adapters/subprocessor-erasure-adapter.ts` (`gatewayKind` / `gatewayCode` on the failure log); `docs/runbooks/member-erasure.md`
  - docs: `.claude/rules/modules/broadcasts.md`, `specs/139-eblast-erasure-close/research.md`, `docs/changelog.md`, `docs/email-broadcast-analysis.md`, `docs/go-live-readiness.md`
- **Slice 2:**
  - `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx` (the send option, and `mapResendError` for the two idempotency 409s)
  - `tests/unit/renewals/infrastructure/resend-transactional-renewal-gateway.test.ts`
  - `tests/contract/resend/renewals-email.contract.test.ts` (re-recorded)
  - **Grown at build (30 Oct 2026, the maintainer's option A, below):** `application/ports/renewal-gateway.ts` (a replay success variant: `idempotentReplay: true`, `deliveryId: null`); `application/ports/renewal-reminder-event-repo.ts` + `infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts` (`deliveryId: string | null` on `transitionStatus` / `transitionFailedToSent`; the column is already nullable, so no migration); `application/use-cases/_lib/dispatch-one-cycle.ts`, `retry-failed-reminders.ts`, `accept-tier-upgrade.ts` (branch on the replay); the `renewal_reminder_sent` payload (`idempotent_replay: true`, `delivery_id` already nullable); a `renewalsMetrics` replay counter.
  - **Env guard (moved here in review round 2):** `baseUrl` on the three `new Resend(…)`; `src/lib/env.ts` refuses `RESEND_DEBUG` when `NODE_ENV=production`.

## Data model and migration

n/a

## Slices (L only)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | The bump, behaviour identical | RS1–RS5 | security-engineer, pdpa-gdpr, spec-compliance-auditor | `141-resend-sdk-6-s1` | #704 · done |
| 2 | Renewals send a real Idempotency-Key | RI1–RI3 | reliability-guardian, spec-compliance-auditor | `141-resend-sdk-6-s2` | #705 · done |

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
| Slice 2: a 409 `invalid_idempotent_request` on a retry is read as "already sent under this key" (option A), with no delivery id | The cross-tick retry re-renders a different body (a redeem link signed with `now`), so the same key meets a changed payload; MEASURED 2026-10-30 that a 422 does not consume a key, so a 409 means an earlier request with that key SUCCEEDED — the double send the spec exists to stop. Residual: if Resend stores a key on its own 5xx (unmeasurable, undocumented), that reminder is recorded as sent and lost; the 422 result is the evidence it is unlikely. A replay row has no delivery id, so delivery webhooks cannot attach to it, and its `dispatched_at` is the replay time | Key = event id + body hash (option B): leaves the cross-tick double send open. Persisting the rendered body for a byte-stable retry: a schema change, spec 140 territory. A sentinel delivery id: a fabricated value in an audit field |
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

**Review round 4 (30 Oct 2026)** — security-engineer APPROVE (no High / Medium); `/code-review high` 8 findings:
- **Fixed** (RED `6b2887022`, GREEN `1930154bd`): `listAudiences` keeps each audience once and stops on a cursor it has seen, logging `audiences_list_truncated` at the page cap or on a repeat; an empty contact list is a no-op again before the id guard (the old behaviour); `isProviderGone` is the one already-gone check for `deleteAudience` / `deleteBroadcast`; the reclaim refusal matches `\blast (audience|segment)\b` (a false match only skips a delete).
- **Corrected wording**: the SDK's outer `catch` (`statusCode: null`) also takes a 2xx whose body would not parse, so the docblock no longer calls it "never reached Resend"; a retried create can then mint a second resource — **as on 4.8**, not new.
- **Refuted**: a 404 with no `name` on `DELETE /contacts/{email}` is not Resend's answer (MEASURED `{"statusCode":404,"name":"not_found"}`), so dropping the `http_404` arm cannot fail a real "already gone". Paging every `/segments` page per tenant tick: correctness over cost at 3 segments today. Altitude (one id choke point): carried to spec 140, as in round 3.
- **Checks**: `tests/contract/resend/` + reclaim + `broadcasts-deps` 85 passed; `pnpm check` exit 0; the 4 gateway integration files on dev, 14 passed.

**Review round 5 (30 Oct 2026)** — `/code-review high`, 8 findings, half of them induced by rounds 3–4:
- **Fixed** (RED `f3c138ac6`, GREEN `3620c71a5`): `rawHttpStatusOf` now decides only "gone" — a raw 404 / 410 needs Resend's JSON error, every other raw status keeps its reading on `main` (a raw non-JSON 413 on the import upload stays permanent, one attempt); an empty page that still says `has_more` logs `audiences_list_truncated`; the reclaim skip needs "delete … last audience|segment" and never applies to a retryable error; the erasure adapter's failure log carries `gatewayKind` / `gatewayCode` (fixed enum values, never the provider's text), and the runbook reads those fields instead of claiming the line already told the causes apart, and no longer points at a broadcast id the log does not carry; the contract files clear `RESEND_BASE_URL` / `RESEND_USER_AGENT` before the SDK is built (positive control: with `RESEND_BASE_URL` set and the clear removed, 11 cases fail).
- **Carried**: the `RESEND_BASE_URL` host split between SDK and raw-fetch calls joins the slice-2 env guard; the twin status rules (one keyed on the SDK's `application_error`, one on the body) and the id choke point: spec 140.
- **Checks**: `tests/contract/resend/` + reclaim + erasure adapter 89 passed (also with `RESEND_BASE_URL` set); `pnpm check` exit 0; the 4 gateway integration files on dev, 14 passed. `broadcasts-deps`: its two cold-import cases timed out at 30 s on this machine under memory pressure after rounds 3–5 (they passed 10/10 solo in round 3, and nothing in this diff is on that file's import path). The last full local unit run is round 3 GREEN (8,151); since then only the targeted suites above ran locally, and CI's coverage job is the full run.
- **Stop rule for the review** (set before round 6): a round that returns only items already dispositioned above ends the review.

**Review round 6 (30 Oct 2026)** — spec-compliance-auditor COMPLIANT (RS1–RS5 MET; all 16 cited hashes exist, RED → GREEN order checked); pdpa APPROVE; `/code-review high` 10 findings:
- **Refuted by MEASUREMENT** (2026-10-30, live account, a made-up id / sink address): `GET` and `DELETE /broadcasts/{missing id}` and `DELETE /contacts/{missing}` all answer `404 application/json {"statusCode":404,"message":"… not found","name":"not_found"}` — so `rawHttpStatusOf` still reads a real "gone" as gone and the erasure cascade cannot stall on it.
- **Fixed** (RED `24e00870a`, GREEN `e187930aa`): the reclaim skip takes any message naming "last audience|segment" with a delete / remove verb in either order ("The last segment cannot be deleted", "Cannot remove the last segment"), still never on a retryable error, read through `_classify-thrown`; the erasure log's `gatewayCode` logs only a plain identifier, anything else as `unrecognised` (pdpa Low + code-review).
- **Already dispositioned** (the stop rule): email unencoded in the `contacts.remove` path, the id choke point / branded id, the twin status readers and their invented statuses → spec 140. **Pre-existing on `main`**, carried to spec 140: an import answering 2xx with no id is classified 502 and retried; `listAudiences` has no overall time budget across pages (one page today); a whitespace-only id is refused here while two callers test only `''`.
- **Checks**: reclaim + erasure adapter + `tests/contract/resend/` 92 passed; `pnpm check` exit 0; the 4 gateway integration files on dev, 14 passed.
- **Review ends here** under the stop rule: no new High or Medium remains.

### Slice 2 (30 Oct 2026)

| Done-when | Evidence |
|---|---|
| Step 0 | DOCUMENTED + MEASURED idempotency facts in spec § Premises (slice 2): same key + same body → same id `01a18d68-5028-…`, one email; same key + changed body → 409 `invalid_idempotent_request`; a 422 does not consume the key. The maintainer chose option A on these facts. |
| RI1 | RED `d6467805c` → GREEN `622349fd5`: both sends call `emails.send(payload, { idempotencyKey })` with no `idempotency-key` in `payload.headers` (`resend-transactional-renewal-gateway.test.ts` — the reminder case and the tier-upgrade case). The tier-upgrade case first failed on the test's env mock lacking `app.baseUrl` (fixed in GREEN); its positive control on the committed GREEN — the key put back into `headers` — fails `expected { Object (idempotency-key) } to be undefined`. `tests/contract/resend/renewals-email.contract.test.ts` re-recorded: the body loses `headers`, the request gains `Idempotency-Key: reminder-event-id-1`. |
| RI1b | Same RED / GREEN: `invalid_idempotent_request` → `ok({ deliveryId: null, idempotentReplay: true })`, one call; `concurrent_idempotent_requests` → transient, retried, then the original id. `dispatch-one-cycle` and `retry-failed-reminders` record the replay as sent with `deliveryId: null` and `idempotent_replay: true` in `renewal_reminder_sent`, and count `renewals_reminder_idempotent_replay_total{path}`. The repo's single-row transitions take `deliveryId: string \| null` (the column was already nullable; `bulkTransitionToSent` has no caller and is unchanged). |
| RI2 | MEASURED 2026-10-30 17:07 UTC through the real gateway (a throwaway tsx probe, deleted; `delivered@resend.dev` only), one key three times: send → `01a18dc8-350e-7500-90ae-0cfdb1009213`; same body → the same id; changed `renewal_link_url` → `idempotentReplay: true`, no id. Resend lists exactly one "Renewal reminder: Regular membership in 30 days", `delivered`. |
| RI3 | The gateway docblock and the `retry-failed-reminders.ts` comment say what is now true; changelog. |
| Env guard | RED `2de8f0459` → GREEN `c5e27a255`: with `RESEND_BASE_URL=https://elsewhere.invalid` set before any client loads, the auth sender, the Broadcasts gateway and the renewals gateway all reach `api.resend.com` (`tests/contract/resend/base-url-pinned.contract.test.ts`; RED: all three hit `elsewhere.invalid`); `env.ts` throws on `RESEND_DEBUG` in production and allows it in development (`tests/unit/lib/env-stripe.test.ts`; RED: "promise resolved … instead of rejecting"). `.env.example` documents `RESEND_DEBUG`; go-live § 6.6 and the broadcasts rule say "enforced in code". |
| Checks | `pnpm check` exit 0 (after `pnpm install` brought the worktree to AURA 5.71.0 from #700); `tests/unit/renewals` 132 files, 1,633 tests passed (before the env guard); `tests/contract/resend/` + env 71 passed; renewals integration on dev: 10 files, 43 tests passed (`audit-emit-rollback`, `concurrent-admin-race`, `concurrent-admin-send`, `cross-tenant-isolation`, `cross-year-catchup-double-send`, `dispatch-cron-idempotency`, `dispatch-missed-cron-catchup`, `dispatch-unreconciled-invoice-guard`, `tier-upgrade-on-offline-mark`, `tier-upgrade-pending`). |

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
