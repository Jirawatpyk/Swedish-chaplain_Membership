'use client';

/**
 * Keeps the staff maintenance banner off `/admin/support`: that page states
 * the pause in its own status, and the banner's Help button would link to the
 * page already open. Client-side because the admin layout, which mounts the
 * banner, does not re-render on navigation and so cannot know the path.
 */
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function HideOnSupportPage({ children }: { readonly children: ReactNode }): ReactNode {
  return usePathname() === '/admin/support' ? null : children;
}
