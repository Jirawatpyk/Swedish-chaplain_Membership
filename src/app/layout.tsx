import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
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
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <SkipToContent />
            <div id="main-content" className="min-h-full">
              {children}
            </div>
            <Toaster position="top-right" richColors />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
