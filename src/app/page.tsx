import { redirect } from 'next/navigation';

/**
 * Root URL `/` — for F1, redirects to the staff sign-in screen because
 * the staff portal is the only audience served. Member sign-in lives at
 * `/portal/sign-in` and the member landing at `/portal` (placeholder
 * until F3 adds real member content).
 */
export default function Home() {
  redirect('/admin/sign-in');
}
