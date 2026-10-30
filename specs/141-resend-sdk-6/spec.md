# 141 — Resend SDK 4.8 → 6.x with a gateway contract suite; renewals send a real Idempotency-Key

**Size**: L (`docs/workflow.md` § Sizes: auth and PII email across four modules, a major dependency bump). Two slices.
**Status**: slice 1 in build. The plan was agreed by the maintainer on 30 Oct 2026 in plan mode.
**Source**: closes #363 (F7 T110). The maintainer first moved segments to spec 140, then, once the pre-read showed that 6.35 sends `audiences.*` to `/segments`, chose on 30 Oct 2026 to accept `/segments` here (measured equivalent, below). Spec 140 builds on segments. The renewals idempotency bug was found while mapping the SDK's uses, and the maintainer chose to fix it here.

## Why

- **The pin:** `resend` is declared `^4.0.1`, installed 4.8.0. The latest is 6.35.0 (npm, 2026-10-27).
- **Spec 140 needs 6.x.** It builds the import-only E-Blast leg on 6.x, which accepts `signal` and request options on every method from 6.32.
- **The same package sends LIVE transactional mail,** so the bump must leave every email the members get unchanged.
- **The renewals bug.** The renewals gateway puts its idempotency key into the email's own headers (`headers: { 'idempotency-key': … }`, `resend-transactional-renewal-gateway.tsx:276, :651`). It does not send it as the HTTP `Idempotency-Key` that Resend dedupes on. A retried reminder can therefore be sent twice, despite the file's docblock.

## Premises (D-041)

**Usage lines.** These are prod counts, read-only, ordered by the maintainer on 2026-10-30 on host `ep-bold-block`:
- `renewal_reminder_events`: **76 rows `sent` in the last 30 days.** Renewals are the live, high-volume path.
- `notifications_outbox`: **5 rows retained, all `sent`, the last on 2026-09-03.** Sent rows are purged at 90 days, so this shows what exists now, not what was ever sent. The outbox carries verification, invitations, invoice and receipt emails, and the E-Blast approval notices. Only the **void notice** carries a PDF attachment, and only with `FEATURE_F4_VOID_ATTACHMENT` on (default off; `outbox-dispatch/route.ts`).
- **Password reset** sends directly and leaves no countable row. It is LIVE by design, since sign-in depends on it.

**The SDK's uses** (mapped 2026-10-30):
- `src/modules/auth/infrastructure/email/resend-client.ts`: `emails.send` with `html`, optional `text` and `attachments` (a Buffer PDF). It reads `error.name` and `error.message`.
- `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx`: `emails.send` with `headers`, and `replyTo` on the reminder path.
- `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-{client,gateway}.ts` makes these calls: `audiences.create/list/remove`, `contacts.create/list/remove`, `broadcasts.create/get/remove`, and `sdk.post('/broadcasts/{id}/send', {}, { idempotencyKey })`. The last bypasses `broadcasts.send`, which drops the key in 4.8.
- Raw-fetch calls are not affected: `retrieveBroadcastOnce`, `deleteBroadcastOnce`, and `importFetch` (contact imports, the global contact delete).
- No code passes `react:` to the SDK; every caller renders HTML first. Only `Resend` is imported from the package.

**Provider facts** come from the SDK release notes (DOCUMENTED, github.com/resend/resend-node/releases, accessed 2026-10-30):
- No method we call was removed or renamed between 4.8 and 6.35, **but the wire changed**: 6.35 sets `this.audiences = this.segments` (`node_modules/resend/dist/index.mjs:1646`), so `audiences.create/list/remove` and `contacts.list({ audienceId })` go to `/segments…`. `contacts.create/remove({ audienceId })` and `broadcasts.create`'s `audience_id` keep their 4.8 shape.
- 5.0: `@react-email/render` became an optional peer dependency.
- 6.0: an attachment `contentId` rename, a field we don't use.
- 6.5: Node ≥20 required; we run Node 22.
- 6.32: `signal` and request options on every method.
- 6.35: API error logging becomes opt-in via `RESEND_DEBUG` (`index.mjs:1639`). Under it the SDK prints the request path, which carries an email on contact calls; 6.34 logged whenever `NODE_ENV` was not production. Hence the exact pin at 6.35. `RESEND_BASE_URL` (`:1633`) would redirect every Bearer key.
- 6.35 attaches `statusCode` to a non-JSON error body; 4.8 left it undefined, so the Broadcasts classifier read 500 and retried.
- 6.35 adds two transitive dependencies, `postal-mime` and `standardwebhooks` (security review: `resend`, `postal-mime` and `standardwebhooks` carry SLSA provenance; their own deps `@stablelib/base64` and `fast-sha256` do not; no install scripts; lockfile integrity matches the registry; neither new dep is on a path we call).

**Measured 2026-10-30 on the live Broadcasts account (sink only, no send; probe segment and audience deleted):** an id created at `/audiences` reads at `/segments/{id}` (200), and one created at `/segments` reads at `/audiences/{id}`; both lists show both; `GET /audiences/{id}/contacts` and `/segments/{id}/contacts` answer the same count with `has_more: false`; a contact removed through `/audiences/{id}/contacts/{email}` is gone from `/segments/{id}/contacts`; `DELETE /segments/{id}` makes `GET /audiences/{id}` 404. **Audiences and segments are one resource under two paths.**

**Confirm in the 6.x source** before relying on these (results in plan.md § Evidence):
- `post` is still public, and its third argument still sets `Idempotency-Key`.
- `emails` and `batch` are still instance properties.
- How a Buffer attachment serialises.
- `contacts.list({ audienceId })` still returns `has_more`.
- A network failure still has no `statusCode` of 400 or more.

## User stories

### US1: The bump changes no email and no E-Blast call (slice 1)
**Done when:**
- **RS1.** A contract suite in `tests/contract/resend/` pins, on 4.8, the method, URL, headers and JSON body of every SDK call above. Each test drives the real SDK against a stubbed `fetch`. The auth send is covered three ways: plain, with text, and with a PDF attachment. The suite also pins how each caller reads `{ data, error }` and a network failure.
- **RS2.** `resend` is pinned exactly to `6.35.0`. On 6.x the RS1 suite differs from 4.8 only in the changes listed in § Premises — the `/audiences` → `/segments` URLs (measured equivalent) and the non-JSON 4xx now read as permanent — each re-recorded on purpose and listed in Evidence; every other pinned request is byte-identical, and every existing resend test passes. `pnpm build` succeeds (the optional `@react-email/render` peer).
- **RS3.** Each of the five confirm points is recorded as checked in the 6.x source (`node_modules/resend`), with the file and the finding.
- **RS4.** Live Verify on :3400 against dev, with a sink address only:
  - a password-reset email arrives;
  - with `FEATURE_F4_VOID_ATTACHMENT` on for the :3400 run only, a void notice with its PDF attachment goes through the outbox cron and arrives; **waived by the maintainer on 30 Oct 2026** (plan.md § Complexity Tracking);
  - an E-Blast draft create → get → delete answers as before. **Met at the gateway, not the UI** (a draft reaches Resend only at dispatch, which sends; plan.md § Complexity Tracking).
- **RS5.** Docs updated:
  - the broadcasts module rule's stack line;
  - the SDK line in `specs/139-eblast-erasure-close/research.md`;
  - `docs/changelog.md`;
  - the #363 platform-risk note in `docs/email-broadcast-analysis.md` and `docs/go-live-readiness.md`.

### US2: A retried renewal email is not delivered twice (slice 2)
**Done when:**
- **RI1.** The reminder and tier-upgrade sends call `emails.send(payload, { idempotencyKey })`. The key is no longer in `payload.headers`. A unit test pins both halves and fails first on the current code; `tests/contract/resend/renewals-email.contract.test.ts` is re-recorded (the body loses `headers`, the request gains `Idempotency-Key`).
- **RI1b.** Resend's idempotency 409s are mapped: `invalid_idempotent_request` (same key, different body) is permanent; `concurrent_idempotent_requests` is transient. A unit test per code.
- **RI2.** MEASURED on the transactional account against the sink: two sends with the same key and the same body yield one message (the same id, or a documented 409); the same key with a changed body is recorded too, and the plan checks whether a reminder's body is byte-stable across cron ticks. Results recorded with their date.
- **RI3.** The renewals docblock and the changelog say what changed.

## Out of scope

- **Calling the Segments API by its new names** (`segments.*`, `segmentId`) in our code: spec 140. Here the SDK alias sends the existing calls to `/segments`, which is measured equivalent.
- **Adopting `signal` / per-call timeouts:** spec 140 for broadcasts. The transactional paths keep today's retry ladders.
- **Bumping `@react-email/components`.**
- **#362 / #364** (the 108 recipient legs): reviewed at spec 140's start.

## Open questions

None.
