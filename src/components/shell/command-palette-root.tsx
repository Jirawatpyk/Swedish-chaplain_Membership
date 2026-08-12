/**
 * T155 — CommandPaletteRoot — shell-level mount wrapper (US6).
 *
 * Thin server-component wrapper that:
 *   1. Reads the current session via `requireSession('staff')` so the
 *      palette can apply role-aware filtering.
 *   2. Mounts the client `<CommandPalette>` once at the admin shell
 *      level, so ⌘K works on every `/admin/**` page without each page
 *      re-mounting a listener.
 *
 * Member role is blocked at the admin layout level — members never
 * reach this component. Defensive: if a member somehow lands here we
 * short-circuit to `null` rather than throwing.
 */
import { requireSession } from '@/lib/auth-session';
import { CommandPalette } from '@/components/command-palette/command-palette';

export async function CommandPaletteRoot() {
  const { user } = await requireSession('staff');
  if (user.role === 'member') return null;
  // 016 T064 — the palette no longer takes a role. Every entry is filtered
  // server-side against its destination's declared permission; a role prop here
  // would only invite a second, unreproducible client-side gate.
  return <CommandPalette />;
}
