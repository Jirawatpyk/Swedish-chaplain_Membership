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
 *
 * 059-membership-suspension Task 9 item 7 — also resolves the member's
 * membership access so `<MemberCommandPalette>` can filter the "Compose
 * E-Blast" jump target when the member is not `full` (the suspended
 * denylist covers the ROUTE, `/portal/broadcasts/new`; it does not stop the
 * palette from offering a link that then bounces). Uses the shared,
 * request-cached `loadMembershipAccess` (`src/lib/load-membership-access.ts`)
 * — since this mounts on every portal page, sharing the cache with whatever
 * page-level check also runs in the same request keeps this to at most one
 * extra DB read per request, not one per page.
 */
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { loadMembershipAccess } from '@/lib/load-membership-access';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { MemberCommandPalette } from '@/components/command-palette/member-invoices-group';

export async function MemberCommandPaletteRoot() {
  const { user } = await requireSession('member');
  if (user.role !== 'member') return null;

  // Fail open to 'full' — this only controls whether a palette ENTRY is
  // shown, never actual access; the real gates are the layout chokepoint
  // + the F7 `submitBroadcast` use-case precondition.
  let membershipAccess: 'full' | 'suspended' | 'terminated' = 'full';
  try {
    const tenant = resolveTenantFromRequest();
    const membersDeps = buildMembersDeps(tenant);
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, user.id);
    if (memberLookup.ok) {
      const decision = await loadMembershipAccess(tenant.slug, memberLookup.value.memberId);
      membershipAccess = decision.access;
    }
  } catch {
    // Swallow — a lookup/read failure here must never break ⌘K globally.
    // `loadMembershipAccess` already logs its own internal failures.
  }

  return (
    <MemberCommandPalette currentUserRole={user.role} membershipAccess={membershipAccess} />
  );
}
