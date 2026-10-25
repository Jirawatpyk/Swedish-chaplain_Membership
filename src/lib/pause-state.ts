/**
 * What the proxy's kill switches refuse right now, read from the same flags
 * `src/proxy.ts` reads: READ_ONLY_MODE (every write, a maintenance freeze) and
 * the F3/F4/F5/F7/F8 feature switches. The staff help page (`/admin/support`)
 * and the staff maintenance banner show it, so a staff user who was refused
 * learns why without guessing.
 *
 * Pure: the caller passes `env` (or the slice of it), so it reads per request
 * like the proxy does and stays testable without booting the env schema.
 */

/** A feature switch, in the order the help page lists them. */
export type PausableFeature = 'members' | 'invoicing' | 'onlinePayment' | 'broadcasts' | 'renewals';

export interface PauseState {
  /** READ_ONLY_MODE: every state-changing request is refused. */
  readonly readOnly: boolean;
  /** Features whose switch is off, so their requests are refused. */
  readonly featuresOff: readonly PausableFeature[];
}

export interface PauseFlags {
  readonly flags: { readonly readOnlyMode: boolean };
  readonly features: {
    readonly f3Members: boolean;
    readonly f4Invoicing: boolean;
    readonly f5OnlinePayment: boolean;
    readonly f7Broadcasts: boolean;
    readonly f8Renewals: boolean;
  };
}

export function readPauseState({ flags, features }: PauseFlags): PauseState {
  const switches: ReadonlyArray<readonly [PausableFeature, boolean]> = [
    ['members', features.f3Members],
    ['invoicing', features.f4Invoicing],
    ['onlinePayment', features.f5OnlinePayment],
    ['broadcasts', features.f7Broadcasts],
    ['renewals', features.f8Renewals],
  ];
  return {
    readOnly: flags.readOnlyMode,
    featuresOff: switches.filter(([, on]) => !on).map(([feature]) => feature),
  };
}
