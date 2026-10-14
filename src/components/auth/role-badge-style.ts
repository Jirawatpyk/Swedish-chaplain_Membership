/**
 * Spec 122 US10a/US10c — how a role reads as an AURA badge, shared by the
 * users list (board `Admin-users`) and the staff account header (board
 * `Admin-account`) so the same role never looks different on two screens.
 * super_admin is solid and also carries a shield icon at the call site, so it
 * is not a colour-only cue (WCAG 1.4.1).
 */
import type { Role } from '@/modules/auth/domain/role';

export const ROLE_BADGE_STYLE = {
  super_admin: { tone: 'neutral', variant: 'solid' },
  admin: { tone: 'accent', variant: 'soft' },
  manager: { tone: 'neutral', variant: 'soft' },
  marketing: { tone: 'success', variant: 'soft' },
  member: { tone: 'neutral', variant: 'outline' },
} as const satisfies Record<Role, { tone: 'neutral' | 'accent' | 'success'; variant: 'solid' | 'soft' | 'outline' }>;
