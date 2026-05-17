/**
 * O1 (Round 3) — shared zod fragments for i18n-aware password-pair
 * validation used by 3 forms: reset-password, invite-redeem,
 * change-password.
 *
 * Pre-O1 each form duplicated a 14-line `buildSchema(tooShort,
 * passwordMismatch)`; the only diverging detail was the field name
 * for the new password (`newPassword` vs `password`) and whether
 * extra fields (`displayName`, `currentPassword`) were layered on
 * top. Extracting the password-pair shape eliminates the duplication
 * and gives one place to refresh if/when the password policy changes.
 *
 * N6 (Round 3) — also folds in a dev-mode guard: if the translator
 * function returns its own key as the value (i.e., the key is
 * missing from the locale file and next-intl is in lenient mode),
 * a console.error fires so dev catches translation drift even
 * before CI's `check:i18n` runs.
 */
import { z } from 'zod';

const I18N_KEY_RE = /^[a-z][a-zA-Z0-9.]+\.[a-zA-Z0-9]+$/;

/**
 * Dev-mode guard: log if the translator returned a literal key
 * (which next-intl does in lenient mode when the key is missing).
 * Production behaviour unchanged — silent fallback to the EN key.
 */
function guardI18nValue(value: string, context: string): string {
  if (
    process.env.NODE_ENV !== 'production' &&
    I18N_KEY_RE.test(value) &&
    value.startsWith('auth.')
  ) {
    console.error(
      `[i18n] ${context}: t() returned the key '${value}' as the message — translation missing. Run \`pnpm check:i18n\` to find the gap.`,
    );
  }
  return value;
}

/**
 * Common password-pair field shape. Returned as a plain
 * `Record<string, ZodType>` so callers can spread it into a larger
 * `z.object({...})` shape that includes extra fields (e.g.
 * `displayName`, `currentPassword`).
 */
export function passwordPairFields(tooShort: string): {
  newPassword: z.ZodString;
  confirmPassword: z.ZodString;
} {
  return {
    newPassword: z.string().min(12, guardI18nValue(tooShort, 'tooShort')).max(256),
    confirmPassword: z.string(),
  };
}

/**
 * Refine that "the new password" matches confirmPassword. Caller
 * passes the actual field name (defaults to `newPassword`).
 */
export function refinePasswordPair<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  passwordMismatch: string,
  newPasswordFieldName: 'newPassword' | 'password' = 'newPassword',
): z.ZodEffects<T> {
  const guarded = guardI18nValue(passwordMismatch, 'passwordMismatch');
  return schema.refine(
    (data: Record<string, unknown>) =>
      data[newPasswordFieldName] === data.confirmPassword,
    { path: ['confirmPassword'], message: guarded },
  );
}
