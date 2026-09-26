/**
 * The product's single toast API (spec 122 FR-007, contracts/toast-facade.md).
 *
 * Every call site imports `toast` from here and every test mocks this module,
 * never a toast library, so the implementation behind it changes in one place
 * (AURA; its Toaster is mounted once, top-centre below the top bar, by
 * AuraBridge). At most three toasts show at once; more queue. AURA also owns
 * the keyboard path (Alt+T reaches the newest toast) and returns focus when a
 * toast that held it closes. The option set is deliberately narrow — the
 * subset the product actually uses.
 */
import type { ReactNode } from 'react';
import { toast as impl, type ToastShorthandOptions } from '@jirawatpyk/aura-react';

export interface ToastAction {
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
  /** Makes the action a link, routed through `next/link` by AuraBridge. */
  readonly href?: string | undefined;
  /** Default true: the toast closes when the action runs. */
  readonly dismiss?: boolean | undefined;
}

export interface ToastOptions {
  /** Text, or lines with their own links (read once inside the toast's live region). */
  readonly description?: ReactNode | undefined;
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

function toImpl(opts: ToastOptions | undefined): ToastShorthandOptions | undefined {
  if (opts === undefined) return undefined;
  const out: ToastShorthandOptions = {};
  if (opts.description !== undefined) out.description = opts.description;
  if (opts.id !== undefined) out.id = opts.id;
  if (opts.duration !== undefined) out.duration = opts.duration;
  if (opts.action !== undefined) out.action = opts.action;
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
