import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getNow, getTimeZone } from 'next-intl/server';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { SkipToContent } from '@/components/shell/skip-to-content';
import './globals.css';

/**
 * Root layout (T050, ux-standards § 1.7 + § 7.1).
 *
 * Wires up:
 *   - Geist sans + mono fonts (next/font CSS variables)
 *   - next-intl provider (per-request locale + messages)
 *   - next-themes ThemeProvider (light / dark / system, no SSR flash)
 *   - SkipToContent — first focusable element for keyboard users
 *   - Sonner Toaster — single global toast root
 */

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'SweCham Membership',
    template: '%s · SweCham Membership',
  },
  description: 'Thai-Swedish Chamber of Commerce — membership system',
  robots: {
    index: false,
    follow: false,
  },
  // iOS standalone (PWA) support. The home-screen icon comes from the
  // `apple-icon.png` file convention; `statusBarStyle: 'default'` avoids
  // content slipping under the status bar on the non-`viewport-fit=cover`
  // admin/auth surfaces (the member portal opts into `cover` per-segment).
  appleWebApp: {
    capable: true,
    title: 'SweCham',
    statusBarStyle: 'default',
  },
};

// NOTE: `viewport-fit=cover` is intentionally NOT exported here. It is scoped
// to the member portal segment (`(member)/portal/layout.tsx`) where the
// fixed-bottom tab bar needs `env(safe-area-inset-bottom)` room. Exporting it
// at the root leaked `cover` app-wide — admin/auth surfaces (e.g. the
// fixed-bottom `bulk-action-bar`) then lost their safe-area inset under the
// iPhone home indicator (057 review F3). The root keeps Next.js's sensible
// default viewport.

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve ALL four per-request values next-intl needs (`locale`,
  // `messages`, `now`, `timeZone`) from the server-side request
  // configuration. Pass every one to `NextIntlClientProvider`
  // EXPLICITLY — per the next-intl v4 docs, the provider can only
  // participate in Next.js static rendering if it has all four
  // props. When any is missing, next-intl bails out of static mode,
  // which in Next.js 16 triggers a SSR pass of client components
  // BEFORE the provider context is wired up — that SSR pass throws
  // `useTranslations context not found` in the dev terminal even
  // though the page recovers via a client-only render.
  //
  // Providing all four props keeps the SSR pass self-contained: the
  // provider owns its own request config, and every descendant
  // `useTranslations` / `useFormatter` call sees a fully-populated
  // context from the first render pass onward.
  const [locale, messages, now, timeZone] = await Promise.all([
    getLocale(),
    getMessages(),
    getNow(),
    getTimeZone(),
  ]);

  // CSP nonce for next-themes' SSR'd inline theme-setter script. The proxy
  // mints a fresh nonce per request (proxy.ts NONCE_HEADER) and the CSP is
  // nonce-based CSP Level 3 with 'strict-dynamic': modern browsers IGNORE
  // the legacy 'unsafe-inline' fallback whenever a nonce source is present,
  // so without this prop the theme script is BLOCKED — dark-mode users get
  // a light-theme flash on every load plus a CSP violation in the console.
  // `next/headers` reads the proxy-forwarded request headers; empty string
  // (e.g. a context without the proxy, like some tests) degrades to no
  // nonce attribute, which matches the pre-fix behaviour.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          now={now}
          timeZone={timeZone}
        >
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            {...(nonce !== undefined && { nonce })}
          >
            <SkipToContent />
            <div className="min-h-full">
              {children}
            </div>
            <Toaster position="top-right" richColors />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
