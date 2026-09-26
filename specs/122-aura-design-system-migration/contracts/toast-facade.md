# Contract: `src/lib/toast.ts` (toast facade)

This is the single import for every toast in the product. It is the contract for the 115 call sites and for the 111 tests that mock it (`vi.mock('@/lib/toast', …)`).

## API

```ts
export interface ToastAction { label: string; onClick?: () => void }
export interface ToastOptions {
  description?: string;        // plain text only (AURA 5.5); rich content → handoff item 53
  id?: string;                 // same id replaces the toast in place
  action?: ToastAction;        // at most one
  duration?: number;           // ms; Infinity = sticky; default 5000
  closeButton?: boolean;       // accepted, ignored (AURA toasts are always dismissible)
}
export interface Toast {
  (title: string, opts?: ToastOptions): string;      // neutral tone
  success(title: string, opts?: ToastOptions): string;
  error(title: string, opts?: ToastOptions): string;   // AURA "danger" tone
  warning(title: string, opts?: ToastOptions): string;
  info(title: string, opts?: ToastOptions): string;
  loading(title: string, opts?: ToastOptions): string;
  dismiss(id: string): void;
}
export const toast: Toast;
```

## Behaviour

- **Return value:** every call returns the toast id (the given `id`, or a generated one).
- **Visibility and placement:** at most three toasts are visible; more queue. They sit top-centre below the 56px top bar — AURA 5.5's `position="top"` is still right-aligned, so `globals.css` centres it (AURA-handoff #54). Announced politely; an error is announced assertively.
- **Errors persist:** `toast.error` defaults to `duration: Infinity` unless the caller passes one (ux-standards § 4.2).
- **Keyboard:** Alt+T (AuraBridge) focuses the newest toast's action, else its close button (AURA-handoff #55). After an action runs, AURA removes the toast; the facade returns focus to the element focused when the toast appeared, unless the action moved focus itself.
- **Commit A (sonner):**
  - The facade forwards to `sonner` unchanged.
  - The type above is the compile-time contract, so passing a React node as `description` stops compiling from this commit on.
- **Commit B (AURA):**
  - Each method forwards to `toast` from `@jirawatpyk/aura-react`.
  - `closeButton` is dropped.
  - Unknown keys are impossible, because they fail at compile time.
- **Never throws:** calling it before the Toaster mounts queues or no-ops (AURA behaviour), and never throws.

## Tests (RED first)

`tests/unit/lib/toast-facade.test.ts`:
1. Each method forwards `title` and the option subset, and returns the id.
2. `error` maps to the danger tone.
3. `closeButton` is not forwarded.
4. `dismiss(id)` forwards.
5. `id` reuse calls the implementation with the same id.
