import * as React from 'react';

import { Input } from '@/components/ui/input';

/**
 * EmailInput — an `<Input>` pre-set for email entry.
 *
 * ux-standards.md § 11.2 requires `inputmode="email"` on email fields so
 * mobile users get the @-optimised soft keyboard (the member portal is the
 * mobile-first surface). `type="email"` alone is honoured inconsistently
 * across mobile browsers, and several forms forgot `inputmode` entirely
 * (audit XF-06). Baking the trio (type + inputMode + autoComplete) into one
 * component means it can't be forgotten again.
 *
 * Defaults are overridable: e.g. the sign-in form passes
 * `autoComplete="username"` (the WAI-ARIA-correct value for a login email),
 * which wins over the `"email"` default because spread props come last.
 *
 * React 19 forwards `ref` as a normal prop, so `{...register('email')}` from
 * react-hook-form threads its ref through `Input` → base-ui unchanged.
 */
export function EmailInput({
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      type="email"
      inputMode="email"
      autoComplete="email"
      {...props}
    />
  );
}
