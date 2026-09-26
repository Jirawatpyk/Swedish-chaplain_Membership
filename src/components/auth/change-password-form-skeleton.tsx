import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Colocated skeleton for <ChangePasswordForm> (same directory as the
 * real form so drift gets caught at review time).
 *
 * Shape mirrors `change-password-form.tsx` on AURA (spec 122 US2):
 *   - `gap-4` between fields
 *   - 3 fields (current / new / confirm): an 18px label, 6px gap, then
 *     AURA's input height
 *   - `<PasswordStrength>` bar 8px below the new-password input
 *   - Full-width 44px submit button after `pt-2`, so the swap has no CLS
 *
 * Used by route-level `loading.tsx` at `/admin/account` and
 * `/portal/account` — both mount the real form identically.
 */
export function ChangePasswordFormSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {/* Current password */}
      <div className="flex flex-col gap-1.5">
        <SkeletonBlock className="h-[18px] w-32" />
        <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
      </div>
      {/* New password + strength meter */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className="h-[18px] w-28" />
          <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
        </div>
        <SkeletonBlock className="h-1 w-full" />
      </div>
      {/* Confirm password */}
      <div className="flex flex-col gap-1.5">
        <SkeletonBlock className="h-[18px] w-32" />
        <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
      </div>
      {/* Submit — full-width 44px, as the real form */}
      <div className="pt-2">
        <SkeletonBlock className="h-11 w-full" />
      </div>
    </div>
  );
}
