import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Colocated skeleton for <ChangePasswordForm> (same directory as the
 * real form so drift gets caught at review time).
 *
 * Shape mirrors `change-password-form.tsx`:
 *   - `space-y-4` vertical rhythm
 *   - 3 fields (current / new / confirm) with label above input
 *   - `<PasswordStrength>` bar below the new-password input
 *   - Full-width submit button at the bottom. F4 sets `size="lg"` to
 *     the same `h-9` as the default variant (aligned with --input-height),
 *     so the skeleton uses `h-9` to match without any CLS on swap.
 *
 * Used by route-level `loading.tsx` at `/admin/account` and
 * `/portal/account` — both mount the real form identically.
 */
export function ChangePasswordFormSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      {/* Current password */}
      <div className="space-y-2">
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-[var(--input-height)] w-full" />
      </div>
      {/* New password + strength meter */}
      <div className="space-y-2">
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="h-[var(--input-height)] w-full" />
        <SkeletonBlock className="h-2 w-full" />
      </div>
      {/* Confirm password */}
      <div className="space-y-2">
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-[var(--input-height)] w-full" />
      </div>
      {/* Submit — full-width lg per real form */}
      <SkeletonBlock className="h-9 w-full" />
    </div>
  );
}
