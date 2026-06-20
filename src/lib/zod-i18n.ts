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
    (value.startsWith('auth.') || value.startsWith('shared.'))
  ) {
    console.error(
      `[i18n] ${context}: t() returned the key '${value}' as the message — translation missing. Run \`pnpm check:i18n\` to find the gap.`,
    );
  }
  return value;
}

/**
 * A next-intl translator narrowed to the shape these helpers need:
 * `(key, values?) => string`. The real `useTranslations('shared.validation')`
 * return value is structurally compatible once widened at the call site
 * (next-intl's namespaced key typing does not match a plain `string`
 * param — same widening already used by `buildMemberFormSchema`). A test
 * sentinel translator also satisfies this shape.
 */
export type Translator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Required free-text field: an i18n "this field is required" message
 * and, optionally, an i18n "too long" bound. Replaces the raw
 * `z.string().min(1).max(n)` shape whose Zod-default English
 * ("String must contain at least 1 character(s)") leaked verbatim into
 * every locale (2026-06-20 raw-Zod sweep).
 */
export function requiredText(tv: Translator, max?: number): z.ZodString {
  const base = z.string().min(1, guardI18nValue(tv('required'), 'required'));
  return max === undefined
    ? base
    : base.max(max, guardI18nValue(tv('tooLong', { max }), 'tooLong'));
}

/**
 * Email field with i18n "invalid email" + "too long" messages (replaces
 * the raw `.email()` whose Zod default "Invalid email" leaked).
 */
export function emailText(tv: Translator, max = 254): z.ZodString {
  return z
    .string()
    .email(guardI18nValue(tv('invalidEmail'), 'invalidEmail'))
    .max(max, guardI18nValue(tv('tooLong', { max }), 'tooLong'));
}

/**
 * Optional/bounded free-text field — only an i18n "too long" bound, no
 * required check. Caller adds `.optional()` / `.default('')` as needed.
 */
export function boundedText(tv: Translator, max: number): z.ZodString {
  return z.string().max(max, guardI18nValue(tv('tooLong', { max }), 'tooLong'));
}

/**
 * Common password-pair field shape. Returned as a plain
 * `Record<string, ZodType>` so callers can spread it into a larger
 * `z.object({...})` shape that includes extra fields (e.g.
 * `displayName`, `currentPassword`).
 *
 * `tooLong` was added in the 2026-06-20 raw-Zod sweep — the trailing
 * `.max(256)` previously had no message and leaked Zod's English default
 * into reset-password / change-password.
 */
export function passwordPairFields(
  tooShort: string,
  tooLong: string,
): {
  newPassword: z.ZodString;
  confirmPassword: z.ZodString;
} {
  return {
    newPassword: z
      .string()
      .min(12, guardI18nValue(tooShort, 'tooShort'))
      .max(256, guardI18nValue(tooLong, 'tooLong')),
    confirmPassword: z.string(),
  };
}

/**
 * Refine that "the new password" matches confirmPassword. Caller
 * passes the actual field name (defaults to `newPassword`).
 *
 * I1 (Round 4) — generic shape changed from
 * `<T extends z.ZodObject<z.ZodRawShape>>(schema: T, ...): z.ZodEffects<T>`
 * to `<T extends z.ZodRawShape>(schema: z.ZodObject<T>, ...)`. The
 * pre-fix shape collapsed the input's per-field types to the raw-shape
 * record, so the returned `ZodEffects` no longer preserved enough
 * information to be structurally assignment-compatible with the
 * caller's `z.ZodType<FormValues>`. Each form ended up writing
 * `as unknown as z.ZodType<FormValues>` — the kind of cast Strict TS
 * is supposed to prevent. The new signature keeps the per-field
 * `ZodRawShape` parameter alive, so the cast is no longer needed.
 */
export function refinePasswordPair<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  passwordMismatch: string,
  newPasswordFieldName: 'newPassword' | 'password' = 'newPassword',
): z.ZodEffects<z.ZodObject<T>> {
  const guarded = guardI18nValue(passwordMismatch, 'passwordMismatch');
  return schema.refine(
    (data: Record<string, unknown>) =>
      data[newPasswordFieldName] === data.confirmPassword,
    { path: ['confirmPassword'], message: guarded },
  );
}
