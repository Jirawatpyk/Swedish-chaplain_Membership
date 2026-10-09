/**
 * Spec 122 — Testing Library helpers for AURA components.
 *
 * AURA renders standard ARIA (Select: `combobox` + `listbox`/`option`;
 * Checkbox: a native `input[type=checkbox]`; Menu: `menu`/`menuitem*`;
 * Toaster: `status`, or `alert` for the danger tone), so these helpers query
 * by role and accessible name only — never by `aura-*` class names, which are
 * AURA's internals and may change on any minor bump.
 *
 * Tests that only check that a toast was *requested* keep mocking
 * `@/lib/toast`; `expectToast` is for tests that render the real Toaster.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';

type Name = string | RegExp;

/** Waits for a rendered toast whose text includes `title`; danger toasts are `alert`s. */
export async function expectToast(
  title: Name,
  opts: { readonly tone?: 'danger' | 'other' } = {},
): Promise<HTMLElement> {
  const role = opts.tone === 'danger' ? 'alert' : 'status';
  const matches = (el: HTMLElement): boolean => {
    const text = el.textContent ?? '';
    return typeof title === 'string' ? text.includes(title) : title.test(text);
  };
  return waitFor(() => {
    const found = screen.queryAllByRole(role).find(matches);
    if (!found) throw new Error(`No ${role} toast matching ${String(title)}`);
    return found;
  });
}

/** Opens the Select labelled `label` and picks the option named `option`. */
export async function pickSelect(user: UserEvent, label: Name, option: Name): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

/** Sets the checkbox labelled `label` to `checked` (no-op when it already is). */
export async function checkBox(user: UserEvent, label: Name, checked = true): Promise<void> {
  const box = screen.getByRole<HTMLInputElement>('checkbox', { name: label });
  if (box.checked !== checked) await user.click(box);
}

/** Opens the menu behind the trigger named `trigger` and returns the open menu. */
export async function openMenu(user: UserEvent, trigger: Name): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: trigger }));
  return screen.findByRole('menu');
}

/**
 * `userEvent.setup()` for a test that mounts an AURA `Select`.
 *
 * user-event replaces `HTMLElement.prototype.focus` / `blur` with getters
 * that have no setter, and AURA's Select assigns its own `focus` on the
 * hidden native `<select>` (so a label click or the required bubble hands
 * focus to its button). In strict mode that assignment throws on mount.
 * Adding a setter that stores an own property keeps user-event's patched
 * methods for every other element and lets the Select mount as it does in
 * a browser.
 */
export function setupUserForAuraSelect(): UserEvent {
  const user = userEvent.setup();
  for (const key of ['focus', 'blur'] as const) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    if (desc?.get && !desc.set) {
      Object.defineProperty(HTMLElement.prototype, key, {
        ...desc,
        set(this: HTMLElement, value: unknown) {
          Object.defineProperty(this, key, {
            value,
            configurable: true,
            writable: true,
          });
        },
      });
    }
  }
  return user;
}

/**
 * Lets an AURA `Select` pick an option in jsdom. Call it after the Select
 * mounts.
 *
 * The Select defines its own `value` / `selectedIndex` accessors on the
 * hidden native `<select>`, so a programmatic write also updates the shown
 * label. jsdom models `<select>` as a Proxy (it has indexed option access)
 * whose set trap does not honour an own accessor, so the Select's write
 * when an option is clicked throws. Removing the two accessors restores the
 * native ones; the Select still re-reads its label after every pick.
 */
export function releaseAuraSelectValueHooks(): void {
  for (const el of document.querySelectorAll('select[aria-hidden="true"]')) {
    const own = el as unknown as Record<string, unknown>;
    delete own['value'];
    delete own['selectedIndex'];
  }
}
