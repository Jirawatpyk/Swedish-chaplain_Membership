'use client';

/**
 * Hands the monitored privacy inbox and the recipient's locale from the
 * server segment layout to the client error boundary (`error.tsx`), which
 * cannot read env and deliberately avoids the i18n loader. Plain values in a
 * context — nothing here can throw.
 */
import { createContext, useContext } from 'react';

export type UnsubscribeLocale = 'en' | 'th' | 'sv';

interface UnsubscribeContact {
  readonly email: string | null;
  readonly locale: UnsubscribeLocale;
}

const UnsubscribeContactContext = createContext<UnsubscribeContact>({
  email: null,
  locale: 'en',
});

export function UnsubscribeContactProvider({
  email,
  locale,
  children,
}: {
  readonly email: string | null;
  readonly locale: UnsubscribeLocale;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <UnsubscribeContactContext.Provider value={{ email, locale }}>
      {children}
    </UnsubscribeContactContext.Provider>
  );
}

export function useUnsubscribeContact(): UnsubscribeContact {
  return useContext(UnsubscribeContactContext);
}
