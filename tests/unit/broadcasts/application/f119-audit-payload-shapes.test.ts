/**
 * F119 follow-up — type-level lock on the four E-Blast audit payload shapes
 * (`F7AuditPayloadShapes`), in the pattern of
 * `audit-port-typed-constraint.test.ts`.
 *
 * The runtime assertions are incidental; the `@ts-expect-error` lines are the
 * test. If a shape is loosened so the forbidden payload compiles, the directive
 * becomes unused and `pnpm typecheck` fails.
 *
 * The two rules pinned here are the ones a loose shape would silently drop:
 *   - `broadcast_image_uploaded` carries EXACTLY ONE member key. `member_id`
 *     (snake_case) is the only key the 0009 `last_activity_at` trigger reads,
 *     so a staff upload that also carried it would refresh the member's
 *     recency; a payload with neither key loses who the image is for.
 *   - `broadcast_image_removed` states `blob_disposition` on a SWEEP row and
 *     never on a MARK row, whose bytes are not deleted yet (`blob_deleted:
 *     false`).
 */
import { describe, expect, it } from 'vitest';
import type { F7AuditPayloadShapes } from '@/modules/broadcasts/application/ports/audit-port';

type Uploaded = F7AuditPayloadShapes['broadcast_image_uploaded'];
type Removed = F7AuditPayloadShapes['broadcast_image_removed'];

const UPLOAD_COMMON = {
  owner_kind: 'broadcast',
  owner_id: 'bc-1',
  image_id: 'img-1',
  byte_size: 1024,
  mime_type: 'image/png',
  content_hash: 'hash-1',
  actor_role: 'member',
} as const;

const REMOVED_COMMON = {
  related_member_id: null,
  owner_kind: 'broadcast',
  owner_id: 'bc-1',
  image_id: 'img-1',
  content_hash: 'hash-1',
} as const;

describe('F119 audit payload shapes — broadcast_image_uploaded', () => {
  it('accepts a member upload (member_id) and a staff upload (related_member_id)', () => {
    const member: Uploaded = { ...UPLOAD_COMMON, member_id: 'mem-1' };
    const staff: Uploaded = { ...UPLOAD_COMMON, related_member_id: null };
    expect([member, staff]).toHaveLength(2);
  });

  it('refuses a payload with BOTH member keys or with NEITHER', () => {
    // @ts-expect-error — `member_id` and `related_member_id` are mutually exclusive
    const both: Uploaded = { ...UPLOAD_COMMON, member_id: 'mem-1', related_member_id: 'mem-1' };
    // @ts-expect-error — one of the two member keys is required
    const neither: Uploaded = { ...UPLOAD_COMMON };
    expect([both, neither]).toHaveLength(2);
  });
});

describe('F119 audit payload shapes — broadcast_image_removed', () => {
  it('accepts a mark row without blob_disposition and a sweep row with one', () => {
    const mark: Removed = { ...REMOVED_COMMON, reason: 'draft_discarded', blob_deleted: false, actor_role: 'member' };
    const sweep: Removed = {
      ...REMOVED_COMMON,
      reason: 'sweep',
      blob_deleted: true,
      blob_disposition: 'deleted',
      actor_role: 'system',
    };
    expect([mark, sweep]).toHaveLength(2);
  });

  it('refuses blob_disposition on a mark row, and a sweep row without it', () => {
    // @ts-expect-error — a mark row never states what happened to the bytes
    const markWithDisposition: Removed = { ...REMOVED_COMMON, reason: 'member_erased', blob_deleted: false, blob_disposition: 'deleted', actor_role: 'system' };
    // @ts-expect-error — a sweep row must say what happened to the bytes
    const sweepWithout: Removed = { ...REMOVED_COMMON, reason: 'sweep_orphaned', blob_deleted: false, actor_role: 'system' };
    // @ts-expect-error — a mark row's bytes are not deleted at the mark
    const markDeleted: Removed = { ...REMOVED_COMMON, reason: 'draft_pruned', blob_deleted: true, actor_role: 'system' };
    expect([markWithDisposition, sweepWithout, markDeleted]).toHaveLength(3);
  });
});
