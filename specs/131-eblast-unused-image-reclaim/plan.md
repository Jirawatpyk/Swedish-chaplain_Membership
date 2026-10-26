# Plan: Reclaim E-Blast images that were uploaded but never used

Spec: `specs/131-eblast-unused-image-reclaim/spec.md` · Size: M · Agreed by the user on: 25 Oct 2026 (two layers), 26 Oct 2026 (backlog, templates, copy)

## Approach

Two layers.

**Layer 1: release on cancel.** The editor already knows the moment an upload goes unused: the author cancels the description dialog after an upload. The upload's 201 already returns `imageId`. The editor keeps it with the pending image and, on that cancel, sends `DELETE` to a release endpoint beside the upload route. A new use case `releaseUnusedImage` stamps that one row and audits `broadcast_image_removed { reason: 'not_inserted' }` in one transaction. The existing marked arm reclaims it on the next tick.

The release reuses `authorizeImageOwner` unchanged, then narrows it to the uploader's own row (maintainer, 26 Oct 2026). It does **not** check the owner's content. If the saved draft still embeds the URL (for example, the same file inserted earlier, deduped to the same URL), the marked arm finds the reference and puts the row back live (`restoreLive`). That is the existing S-3 path, so the release cannot remove a used image.

**Layer 2: sweep arm 3, "unused".** `listUnused` selects live `owner_kind='broadcast'` rows whose owner exists in a terminal status and whose URL that owner does not hold. An owner holds a URL when:
- it holds images at all (`OWNER_HOLDS_IMAGES`, the SQL twin of Domain `holdsImageReferences`), and
- its `body_html`, its `body_source` or one of its versions' bodies contains the URL.

The rows then go through the same per-row transaction as the orphan arm: timeout, hash lock, live count excluding the row itself, then the tenant-wide content backstop. Doing the owner check in the SELECT is what keeps the batch from filling with the images sent E-Blasts actually show; without it they would be picked every tick forever.

**Alternatives not taken:**
- *Layer 2 only.* Leaves an unused image public until the E-Blast closes, which can be weeks for a slow draft, and never for a draft that stays open past the prune.
- *Diffing images at every save.* Reclaims while the author may still undo, and needs a server-side content diff on the hot save path. Rejected for this change; it stays out of scope.
- *A content check in the release (409 `still_used`).* Redundant with the marked arm's restore, and a tenant-wide check would refuse legitimate releases whenever another E-Blast uses the same deduped file.
- *A dry-run mode for arm 3.* The maintainer chose to remove the backlog straight away.

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md`, `architecture.md` (D-029 tenant predicates, `runInTenant`, audit), `ui-aura.md` (i18n).

- **broadcasts / Application:**
  - `use-cases/release-unused-image.ts` (new);
  - `use-cases/_mark-owner-images-removed.ts` (reason `not_inserted`);
  - `use-cases/reclaim-orphaned-images.ts` (arm 3, reason `sweep_unused`, docblock);
  - `ports/broadcast-images-repo.ts` (`markDeletedById`, `listUnused`);
  - `ports/audit-port.ts` (two reasons in the payload union);
  - `index.ts` (barrel);
  - a deps factory beside `makeAuthorizeImageOwnerDeps`.
- **broadcasts / Infrastructure:** `db/drizzle-broadcast-images-repo.ts`, the two methods, each with its own `tenant_id` predicate (D-029).
- **Presentation:**
  - `src/lib/broadcasts-image-release-route.ts` (new, the shared half of the three routes, like the upload's);
  - `src/app/api/broadcasts/inline-image-upload/[imageId]/route.ts`;
  - `src/app/api/admin/broadcasts/[id]/images/[imageId]/route.ts`;
  - `src/app/api/admin/broadcasts/templates/[id]/images/[imageId]/route.ts`.
- **Client:**
  - `compose-inline-image-uploader.tsx`: `onUploaded({ blobUrl, imageId })`;
  - `tiptap-editor.tsx`: keeps `imageId` with the pending image; on cancel it sends `DELETE` to `${uploadUrl}/${imageId}?draftId=…`.
- **i18n:** `portal.broadcasts.compose.imageUpload.notInserted` (after a successful release) and `notInsertedKept` (otherwise) in EN/TH/SV.
- **Guards:** the RBAC matrix / route-guard registries, if they list API routes.

## Data model and migration

**Migration 0319** (`0319_broadcast_images_unused_checked_at.sql`) is added by the #658 review round, at the maintainer's choice.
- It adds `broadcast_images.unused_checked_at timestamptz NULL` and a partial index `(tenant_id, unused_checked_at) WHERE deleted_at IS NULL AND owner_kind = 'broadcast'`.
- It is additive and nullable, so it is safe before the code that reads it. NULL means "never examined".
- It is unflagged on deploy. Rollback is a forward fix; the column is harmless if unused.

There is no new audit type. `not_inserted` and `sweep_unused` are payload values.

## Test plan

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| 2 release stamps one live row of the owner + audits `not_inserted` in the tx | `tests/unit/broadcasts/application/release-unused-image.test.ts` › "stamps the row in the tx and audits not_inserted"; › "only the uploader releases" | unit |
| 2 no live row of this owner → `released:false`, no audit | same › "another owner's or an already-stamped id releases nothing" | unit |
| 2 a failed audit rolls the stamp back | same › "a failed audit fails the release" | unit |
| 2 owner refused → not_found / closed, nothing stamped | same › "refused owner stamps nothing" | unit |
| 2 routes: 200 / 404 / 409 / 429 / 503 kill-switch, malformed id | `tests/contract/broadcasts/image-release-routes.test.ts` | contract |
| 2 CSRF + read-only freeze cover the new DELETEs | the proxy's route coverage (existing gate), plus a contract row | contract |
| 1 cancel after upload sends DELETE with the image id; new toast | `tests/unit/broadcast/editor-sweep-round2.test.tsx` › "#5 …" (extended) | unit (UI) |
| 1 the uploader hands back `imageId` | `tests/unit/broadcast/inline-image-uploader-aura.test.tsx` | unit (UI) |
| 4 arm 3 reclaims an unused image of a sent E-Blast, keeps the used one | `tests/unit/broadcasts/application/reclaim-orphaned-images.test.ts` (or the lifecycle test) › arm 3 | unit |
| 4 the shared hash keeps the bytes; the backstop keeps the row live (`retained`) | same | unit |
| 4 `listUnused` SQL: terminal owners only, holds rule, the owner's bodies and versions | `tests/integration/broadcasts/eblast-image-lifecycle.test.ts` (relay) | integration |
| 4 / 5 every new statement has a `tenant_id` predicate | `tests/unit/broadcasts/infrastructure/*tenant-sql-shape*` (existing gate pattern) | unit |
| 5 tenant B cannot release tenant A's image | `tests/integration/broadcasts/…` cross-tenant case (relay) | integration |
| 3 release + next tick removes the row | integration (relay) | integration |

e2e: `broadcasts/image-upload-allowlist` and `broadcasts/eblast-a11y` on chromium + mobile-chrome (relay), plus a manual pass: upload, cancel, run the cron locally, the blob URL 404s.

## Constitution Check

- I Data Privacy & Security: pass. This removes personal data sooner. The ownership check is reused, every new query carries `tenant_id` (D-029) under RLS, and there is a cross-tenant test.
- II Test-First: pass. RED commits for the use case, repo, routes and sweep (audit / PII / guard classes, so no shared commit).
- III Clean Architecture: pass. Ports only in Application; the SQL is in the adapter.
- IV PCI DSS: n/a.
- V i18n: two keys (`notInserted`, `notInsertedKept`) in EN/TH/SV.
- VI Inclusive UX: the toast is the existing info toast (`role=status`).
- VII Perf & Observability: arm 3 adds one bounded SELECT per tenant per tick, and its rows share the per-row timeout. Logs use the existing sweep keys and `errKind`.
- VIII Reliability: the stamp and the audit share one transaction; the release is idempotent; the sweep's per-row isolation is unchanged.
- IX Code Quality: the shared route helper mirrors the upload's.
- X Simplicity: no dependency, no flag; one additive nullable column (0319), chosen over a daily rescan of every sent E-Blast's images.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (PII + audit surfaces). The five checks: (1) ≥ 2 rounds of `/code-review high` plus surface reviewers, counts in the PR; (2) `security-engineer`, `senior-tester`, `pdpa-gdpr-compliance-officer`, `reliability-guardian`; (3) coverage thresholds plus the integration files on Neon (relay); (4) RLS under the explicit predicates; (5) the raising reviewer re-checks each fix | No second human reviewer | — |

## Evidence

This cloud session has no `.env.local`, so the live-Neon and running-app evidence comes from the maintainer's relay run **R90** (relay doc).

**R90: pass** (maintainer, 26 Oct 2026; manual at `df0530c`, e2e at `4b27a42`, base `main` `a77d213`; :3400 against the Neon dev branch, ClamAV in Docker):
- **Migration 0319 on dev.** `pnpm db:migrate` applied it. `information_schema` shows `unused_checked_at` as `timestamp with time zone`, nullable. `pg_indexes` shows the partial index as written. `pnpm db:verify` passes 24/24 canaries, including 0319.
- **Integration.** `eblast-image-lifecycle.test.ts` passes 17/17: the 9 spec 131 cases plus the existing ones.
- **e2e** (`--workers=1`):
  - `image-upload-allowlist` passes 3/3 on chromium and mobile-chrome.
  - `eblast-a11y` passes 16/16 alone. The failures seen when it runs in the batch also occur on base, so they predate this PR.
- **Manual.** Each step was checked in SQL as well as in the browser.
  - 4.1–4.3: member, staff and template cancels each send one DELETE → 200, with `not_inserted`. Describe-and-insert sends none.
  - 4.4: the cron returns `rowsRemoved 16, blobsDeleted 15, rowsFailed 0, truncated false, unusedListFailed false`. Every released blob returns 404; the inserted image is kept.
  - 5.1: a blocked release is retried once (2 DELETEs), then the "still stored" toast shows, the row stays live and no audit is written.
  - 5.2–5.4: reload, tab close and in-app navigation each release once, with no toast.
- **Template 404, first run.** Both template releases first got 404 from a dev server that had never compiled that route (a Turbopack cold route). On a warm server the same release returns 200. Local gate on `d31887f`: `pnpm check` exit 0; `pnpm vitest run tests/contract/` 256 files, 2817 tests green. `pnpm test:coverage` 20795 green with no threshold miss. Its one red is the deliberate `pagehide` RED test (`28c92f9`), which landed mid-run; GREEN at `4b27a42`. The rerun on `4b27a42` is recorded in the PR.

| Done-when | Evidence |
|---|---|
| 1 Cancel releases; two toasts; leaving the page (in-app and `pagehide`) | `editor-sweep-round2.test.tsx` › spec 131 block (member / staff / template hosts, the release names the upload's draft, unmount, `pagehide` once, failed and 429 → `notInsertedKept`): 21/21. `inline-image-uploader-aura.test.tsx` › "hands back its blob URL and its image id". `tests/unit/broadcast` 99 files, 949 tests. Running app: R90 § 4 and § 5 (relay). |
| 2 Release endpoints | `release-unused-image.test.ts` 7/7 (stamp + `not_inserted` in the tx, uploader only, failed audit throws, refused owner, probe label `image_release`, staff on submitted). `image-release-routes.test.ts` 15/15 (200 / 404 / 400 / 409 codes / 429 Retry-After / 503 / 500 envelope, member and staff buckets). CSRF and freeze: `src/proxy.ts` covers every state-changing `/api/**`. |
| 3 Next tick reclaims a released image | integration › release and the next tick; restore when the saved draft embeds it; dedup (R90 § 2, relay). |
| 4 Arm 3 + watermark + isolation + budget | `eblast-image-lifecycle.test.ts` (unit) arm 3: 11 cases; `eblast-image-sweep-cron.test.ts` (truncated, `unused_list_failed`); integration › `listUnused` on a sent E-Blast, closed never-sent vs draft or in review, 0319 watermark (R90 § 2). Migration 0319 applied and verified: R90 § 1. |
| 5 Tenant isolation | `broadcast-images-repo-tenant-sql-shape.test.ts` (16 statements, positive control); integration › Principle I at both walls (R90 § 2). |
| 6 Docs | spec 119 `spec.md` + `data-model.md` § 4, `processing-records.md`, `cron-jobs.md` Block 2, `member-erasure.md`, `observability.md`, `changelog.md` (diff). |

## Rollout

Unflagged on merge.
- **Layer 1:** works from the first cancel after the deploy.
- **Arm 3:** runs from the next 04:30 UTC tick and removes the production backlog at 200 rows per arm per tenant per tick, each with an audit row.
- **Roll back:** revert the PR. Rows already removed stay removed, and their audit rows record what happened.

## Risks

- **Arm 3 removing an image a sent email still loads.** Guarded twice:
  - the SELECT keeps every URL in the owner's body or any version;
  - the per-row tenant-wide backstop keeps the bytes when anything else embeds them.

  How we'd notice: `broadcast_image_removed { reason: 'sweep_unused' }` rows, and the sweep log's counts.
- **Batch starvation by retained rows.** Closed by the 0319 watermark: a used or retained row is not re-examined for 30 days. What remains is a row whose transaction fails every tick (follow-up NEW-4). How we'd notice: `broadcasts_image_sweep_retained_total` and the per-row error logs.
- **A release racing an insert:** the author cancels, then re-uploads the same file and inserts it before the tick. The new upload is a new live row, so the hash count keeps the bytes.
