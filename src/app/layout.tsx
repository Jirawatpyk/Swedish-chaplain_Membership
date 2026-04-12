import type { Metadata } from 'next';
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
  description: 'Thailand-Swedish Chamber of Commerce — membership system',
  robots: {
    index: false,
    follow: false,
  },
};

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
