import { redirect } from 'next/navigation';

/**
 * Portal landing — redirects to /portal/profile.
 *
 * F1 shipped a placeholder roadmap page here. Now that US5 delivers
 * real profile content, the landing simply forwards. The layout's
 * `requireSession('member')` guard runs before this page, so
 * unauthenticated users never reach the redirect.
 */
export default function MemberPortalHomePage() {
  redirect('/portal/profile');
}
