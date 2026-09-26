/**
 * Spec 122 — class strings for the few shell controls AURA has no component
 * for (the language pill, the account and search triggers on the `topbar()`
 * boards). They use AURA's tokens so they sit beside AURA's own buttons.
 */

/** AURA's focus ring: the same colour, width and offset as its components. */
export const AURA_FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--aura-focus-ring-width)] focus-visible:outline-offset-[var(--aura-focus-ring-offset)] focus-visible:outline-[var(--aura-focus-ring)]';
