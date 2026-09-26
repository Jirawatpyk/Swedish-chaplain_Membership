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
import type { UserEvent } from '@testing-library/user-event';

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
