/**
 * FR-005 — 90-day archive/undelete window.
 *
 * Exposed as a separate policy (rather than only via `undelete()` in
 * member.ts) so Presentation can ask "is this archived member still
 * undeletable?" at render time without attempting the transition.
 *
 * Pure TypeScript — no framework imports.
 */
import { ARCHIVE_UNDELETE_WINDOW_DAYS } from '../member';

export type ArchiveWindowStatus =
  | { state: 'not_archived' }
  | { state: 'within_window'; daysRemaining: number }
  | { state: 'window_expired'; daysSinceArchive: number };

export function archiveWindowStatus(
  archivedAt: Date | null,
  now: Date,
): ArchiveWindowStatus {
  if (archivedAt === null) return { state: 'not_archived' };
  const elapsedMs = now.getTime() - archivedAt.getTime();
  const elapsedDays = Math.floor(elapsedMs / 86_400_000);
  if (elapsedDays > ARCHIVE_UNDELETE_WINDOW_DAYS)
    return { state: 'window_expired', daysSinceArchive: elapsedDays };
  return {
    state: 'within_window',
    daysRemaining: ARCHIVE_UNDELETE_WINDOW_DAYS - elapsedDays,
  };
}

export { ARCHIVE_UNDELETE_WINDOW_DAYS };
