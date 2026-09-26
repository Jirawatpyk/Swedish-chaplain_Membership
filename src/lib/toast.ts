/**
 * The product's single toast API (spec 122 FR-007, contracts/toast-facade.md).
 *
 * Every call site imports `toast` from here and every test mocks this module,
 * never a toast library, so the implementation behind it changes in one place
 * (AURA; its Toaster is mounted once, top-centre, by AuraBridge). At most
 * three toasts show at once; more queue. The option set is deliberately
 * narrow — the subset the product actually uses — and plain-text only: a
 * description is a string, and a toast carries at most one action.
 */
import { toast as impl, type ToastShorthandOptions } from '@jirawatpyk/aura-react';

export interface ToastAction {
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
}

export interface ToastOptions {
  readonly description?: string | undefined;
  /** Reusing an id replaces that toast in place. */
  readonly id?: string | undefined;
  readonly action?: ToastAction | undefined;
  /** Milliseconds; `Infinity` keeps the toast until dismissed. */
  readonly duration?: number | undefined;
  /** Accepted for existing callers and ignored: every AURA toast has a close button. */
  readonly closeButton?: boolean | undefined;
}

type Show = (title: string, opts?: ToastOptions) => string;

export interface Toast extends Show {
  readonly success: Show;
  readonly error: Show;
  readonly warning: Show;
  readonly info: Show;
  readonly loading: Show;
  readonly dismiss: (id: string) => void;
}

/**
 * AURA removes the toast — and with it the focused action button — right after
 * the action runs, which would drop keyboard focus to <body>. Put it back on
 * whatever was focused when the toast appeared, unless the action moved focus
 * somewhere on purpose.
 */
function restoringFocus(action: ToastAction): ToastAction {
  const before = typeof document === 'undefined' ? null : document.activeElement;
  return {
    label: action.label,
    onClick: () => {
      action.onClick?.();
      queueMicrotask(() => {
        const now = document.activeElement;
        const lost = now === null || now === document.body || !now.isConnected;
        if (lost && before instanceof HTMLElement && before.isConnected) before.focus();
      });
    },
  };
}

function toImpl(opts: ToastOptions | undefined): ToastShorthandOptions | undefined {
  if (opts === undefined) return undefined;
  const out: ToastShorthandOptions = {};
  if (opts.description !== undefined) out.description = opts.description;
  if (opts.id !== undefined) out.id = opts.id;
  if (opts.duration !== undefined) out.duration = opts.duration;
  if (opts.action !== undefined) out.action = restoringFocus(opts.action);
  return out;
}

const shorthand = (fn: (title: string, opts?: ToastShorthandOptions) => string): Show =>
  (title, opts) => fn(title, toImpl(opts));

/** Errors stay until dismissed (ux-standards § 4.2) unless the caller sets a duration. */
const persistentError: Show = (title, opts) =>
  impl.error(title, toImpl({ ...opts, duration: opts?.duration ?? Infinity }));

/** `toast(title)` is AURA's default (info) tone; `error` is AURA's danger tone, announced as an alert. */
export const toast: Toast = Object.assign((title: string, opts?: ToastOptions) => impl({ title, ...toImpl(opts) }), {
  success: shorthand(impl.success),
  error: persistentError,
  warning: shorthand(impl.warning),
  info: shorthand(impl.info),
  loading: shorthand(impl.loading),
  dismiss: (id: string) => {
    impl.dismiss(id);
  },
});
