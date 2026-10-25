import { notFound } from 'next/navigation';
import { requirePagePermission } from '@/lib/rbac';

/**
 * Catch-all for unmatched `/admin/*` URLs (R84, after PR #640).
 *
 * A segment `not-found.tsx` only catches `notFound()` thrown inside its
 * segment; a URL that matches NO route never reaches it and renders the
 * framework's bare root 404 — outside the admin shell, English only, with no
 * way back. Matching the rest of the path here and answering `notFound()`
 * routes those URLs to `admin/not-found.tsx`, inside the staff layout, so the
 * session guard and the member → `/portal` redirect still run first. Every
 * real route (including `(auth-public)/admin/sign-in`) outranks a catch-all,
 * so nothing existing is shadowed. Same pattern as `portal/[...unknown]`.
 *
 * Gated like the dashboard (`dashboard.view`): every staff page declares its
 * permission (`check:staff-page-guard`), and a denial is the same `notFound()`,
 * so the reader sees the one cause-neutral page either way.
 */
export default async function UnknownStaffRoute(): Promise<never> {
  await requirePagePermission('dashboard.view');
  notFound();
}
