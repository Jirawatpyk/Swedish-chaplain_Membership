/**
 * T086 — Member command-palette shell-level mount (F5 Group I).
 *
 * Thin server-component wrapper that reads the current session via
 * `requireSession('member')` and mounts `<MemberCommandPalette>` once
 * at the portal shell level so ⌘K works on every `/portal/**` page.
 *
 * Non-member callers short-circuit to `null` — the portal layout
 * already redirects staff to `/admin`, but we keep the guard so the
 * component is safe to mount anywhere.
 */
import { requireSession } from '@/lib/auth-session';
import { MemberCommandPalette } from '@/components/command-palette/member-invoices-group';

export async function MemberCommandPaletteRoot() {
  const { user } = await requireSession('member');
  if (user.role !== 'member') return null;
  return <MemberCommandPalette currentUserRole={user.role} />;
}
