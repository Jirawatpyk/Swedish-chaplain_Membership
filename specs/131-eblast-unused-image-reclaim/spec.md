# 131 — Reclaim E-Blast images that were uploaded but never used

**Size**: M (broadcasts use case + repo methods + 3 DELETE routes + the daily sweep + editor client + i18n + docs; migration 0319 adds one nullable column; no flag). Personal data and audit surfaces, so not S.
**Status**: building on `claude/jolly-feynman-8hpoyh`, 26 Oct 2026.
**Source**: found while building PR #655 (spec 122 US12d-2); named there as the server follow-up (FR-011). The maintainer chose two layers on 25 Oct 2026.

## Why

An author uploads an image from the editor's upload button and then cancels its description dialog. The image is never placed in the message. Its Vercel Blob and its `broadcast_images` row stay live (`deleted_at` NULL, owned by the draft or template), at a public, unauthenticated URL.

The daily sweep (`reclaimOrphanedImages`, cron Block 2 of `/api/cron/broadcasts/prune-expired-drafts`, 04:30 UTC) takes only:
- MARKED rows, which discard, prune, erasure, withdrawal, rejection or retention stamped;
- ORPHANED rows, whose owner row is gone.

Nothing compares an owner's images with its content. So an unused image on an E-Blast that is later **sent** stays public for about 5 years, until the retention sweep deletes the E-Blast. Members have no image library, so a cancelled image can never be reused; uploading it again makes a new row.

## Premises checked against the code

- The upload's 201 already returns `imageId` (`src/lib/broadcasts-image-upload-route.ts`). The uploader throws it away (`onUploaded(blobUrl)`).
- `authorizeImageOwner` already decides who may write to which owner:
  - a member: their own `draft`;
  - staff: an E-Blast in `draft | submitted | in_design`;
  - staff: an existing template.

  The release route reuses it unchanged, and then narrows it: only the uploader may release (Decisions).
- When a stamped row's URL is still embedded in live content, the marked arm already keeps the bytes and puts the row back in the live set (`restoreLive`, ROUND-2 S-3). So releasing a row whose URL the saved draft still embeds is safe: the sweep restores it. The release needs no content check of its own.
- `broadcast_image_removed` and its payload union exist. A removal reason is a payload value, not an enum, so the reasons need no migration. (Migration 0319 is the arm-3 watermark, Decisions.)

## Done when

1. **Cancel after an upload releases the image.** The author uploads an image, then cancels the description. The editor then:
   - sends `DELETE` to the release endpoint with that upload's `imageId`;
   - once the release succeeded, shows the info toast "The image wasn't added to your message. It will be removed automatically, usually within a day." (EN/TH/SV, `notInserted`). A refused or failed release, or an upload with no image id, shows "The image wasn't added to your message. It's still stored. Contact the chamber if it must be removed." (`notInsertedKept`), because nothing will remove it soon. A failure that may pass (offline, 429, 5xx) is sent once more after 2 s before that toast; a 404 or 409 is final (maintainer, 26 Oct 2026, #658 UX M2).

   The release URL is fixed when the image is uploaded. Leaving the page while the description is still open releases the upload too, whether by navigating inside the app or by closing the tab or reloading (`pagehide`, a `keepalive` request; maintainer, 26 Oct 2026). It is sent once.

   This works on all four hosts: member compose, staff compose on behalf, the approval workspace, and the template form. When the release fails, the author sees `notInsertedKept`. On an E-Blast, arm 3 still reclaims the image once the E-Blast closes; a template has no sweep behind it.
2. **The release endpoints.** `DELETE /api/broadcasts/inline-image-upload/[imageId]?draftId=…` (member), `DELETE /api/admin/broadcasts/[id]/images/[imageId]` (staff), `DELETE /api/admin/broadcasts/templates/[id]/images/[imageId]` (staff).
   - Each runs the same gate, kill-switch and write-rate bucket as its upload route, and `authorizeImageOwner`: 404 + probe audit for another member's or tenant's owner, and 409 when the owner is closed to this actor.
   - The proxy applies CSRF and the read-only freeze, as for every state-changing `/api/**` route.
   - A live row of that owner **uploaded by the caller** is stamped (`deleted_at`). Another user's upload is not released (maintainer, 26 Oct 2026). One `broadcast_image_removed { reason: 'not_inserted', blob_deleted: false }` is audited in the same transaction. A failed audit rolls the stamp back.
   - The answer is `200 { released: true }`. If no live row of this owner has that id, the answer is `200 { released: false }` and nothing is audited, so repeating the call is harmless and the endpoint reveals nothing about other owners' rows.
   - A malformed `imageId` → 404. The member route without `draftId` → 400.
3. **The next daily tick reclaims a released image** through the existing marked arm (the last-reference rule unchanged): its row is removed and its bytes are deleted unless another live row or live content holds them.
4. **Sweep arm 3, "unused".** A live image of an E-Blast that can no longer change (owner status in `TERMINAL_BROADCAST_STATUSES`) is reclaimed when its URL is not in that E-Blast's content. Its content is `body_html`, `body_source` and every version's bodies; a closed, never-sent E-Blast holds none (Domain `holdsImageReferences`).
   - It is audited `broadcast_image_removed { reason: 'sweep_unused', blob_disposition }`.
   - An image the E-Blast does show is never selected.
   - Drafts and E-Blasts still in review are never selected.
   - The shared-hash rule and the tenant-wide content backstop apply as in the other arms. A row kept by the backstop stays live and counts as `retained`.
   - **The watermark (0319 `unused_checked_at`).** Arm 3 examines a row at most once every 30 days.
     - It stamps the rows a terminal owner still uses, and the rows the backstop keeps.
     - It skips a stamped row until the 30 days lapse.
     - A row whose transaction fails is not stamped.
   - **Isolation.** Arm 3 lists in its own transaction under a statement timeout, and its failure never stops the marked arm.
   - **Time budget.** The sweep starts no new row after 150 s of the cron tick (measured from the tick's start).
   - The backlog already in production is removed from the first tick after merge, 200 rows per arm per tenant per tick (maintainer, 26 Oct 2026).
5. **Tenant isolation.** Every new query carries its own `tenant_id` predicate (D-029). A cross-tenant integration test shows tenant B cannot release tenant A's image.
6. **Docs:**
   - spec 119 § Personal data and `data-model.md` § 4;
   - `docs/compliance/processing-records.md` (the retention line for unused images);
   - `docs/runbooks/cron-jobs.md` Block 2;
   - `docs/changelog.md`.

## Out of scope

- A sweep arm for **template** images. A template can still be edited, so the sweep cannot tell "not yet used" from "unused"; layer 1 is all a template gets (maintainer, 26 Oct 2026).
- Images left over after an author deletes an inserted image and saves. The draft prune and arm 3 cover those once the E-Blast closes or is pruned; reclaiming them while the draft is open would need save-time diffing.
- Rows recorded for drafts started from a template (the template images route's "follow-up, not closed here").

## Decisions (maintainer, 26 Oct 2026)

- Arm 3 removes the existing backlog straight away. There is no report-only mode and no flag.
- Templates are included in layer 1.
- ~~The toast says the image "will be removed within a day".~~ Revised after the #658 reviews: "The image wasn't added to your message. It will be removed automatically, usually within a day." It names no destination and makes no hard promise.
- A watermark column (migration 0319) rather than re-scanning every image of every sent E-Blast every day.
- Only the uploader may release an image.

## Open questions

None.
