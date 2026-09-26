/**
 * Segment-level error boundary for `/unsubscribe/[token]`.
 *
 * Last-line-of-defence safety net for the GDPR Art. 21 unsubscribe
 * surface. The page itself is contracted "never throws" via the
 * top-level guard inside `processUnsubscribe`, but the surrounding
 * page renderer (i18n key access, `t.rich` callbacks, React hydration)
 * can still throw — e.g. a missing TH/SV i18n key on a release branch
 * or an OTel exporter init throw between the use-case commit and the
 * return. Without this boundary Next.js would render a 500, which is
 * the worst possible outcome for a recipient who clicked an
 * unsubscribe link in good faith.
 *
 * This component MUST be a client component (Next.js error boundary
 * contract). It deliberately does NOT call `useTranslations()` — the i18n
 * loader is the most likely source of the throw we are catching — so the
 * copy is static, in all three locales. The segment layout supplies the
 * recipient's locale and the monitored privacy inbox through context
 * (`unsubscribe-contact-context.tsx`); without it the boundary still
 * renders, in English, without an address.
 */
'use client';

import { useEffect } from 'react';
import { useUnsubscribeContact, type UnsubscribeLocale } from './unsubscribe-contact-context';

interface ErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

const COPY: Readonly<
  Record<
    UnsubscribeLocale,
    {
      readonly heading: string;
      readonly body: string;
      readonly contactWith: readonly [string, string];
      readonly contactWithout: string;
      readonly tryAgain: string;
    }
  >
> = {
  en: {
    heading: 'Temporary error',
    body: 'We could not display this unsubscribe page right now due to a temporary system error. Your unsubscribe was NOT recorded — please try the link again in a few minutes.',
    contactWith: [
      'If the problem persists, email us at ',
      ' and we will remove your address from all E-Blasts within 2 business days. This is free of charge.',
    ],
    contactWithout:
      'If the problem persists, email the chamber office and we will remove your address from all E-Blasts within 2 business days. This is free of charge.',
    tryAgain: 'Try again',
  },
  th: {
    heading: 'ระบบขัดข้องชั่วคราว',
    body: 'ขออภัย เราไม่สามารถแสดงหน้ายกเลิกการรับข่าวสารได้ในขณะนี้เนื่องจากระบบขัดข้องชั่วคราว การยกเลิกของคุณยังไม่ถูกบันทึก กรุณาลองคลิกลิงก์อีกครั้งในอีกสักครู่',
    contactWith: [
      'หากปัญหายังคงอยู่ กรุณาส่งอีเมลถึงเราที่ ',
      ' แล้วเราจะนำที่อยู่อีเมลของคุณออกจากรายชื่อผู้รับ E-Blast ทั้งหมดภายใน 2 วันทำการ โดยไม่มีค่าใช้จ่ายใด ๆ',
    ],
    contactWithout:
      'หากปัญหายังคงอยู่ กรุณาส่งอีเมลถึงสำนักงานหอการค้า แล้วเราจะนำที่อยู่อีเมลของคุณออกจากรายชื่อผู้รับ E-Blast ทั้งหมดภายใน 2 วันทำการ โดยไม่มีค่าใช้จ่ายใด ๆ',
    tryAgain: 'ลองอีกครั้ง',
  },
  sv: {
    heading: 'Tillfälligt fel',
    body: 'Vi kunde inte visa den här avregistreringssidan just nu på grund av ett tillfälligt systemfel. Din avregistrering har INTE registrerats — försök länken igen om några minuter.',
    contactWith: [
      'Om problemet kvarstår, mejla oss på ',
      ' så tar vi bort din adress från alla utskick inom två arbetsdagar. Det är kostnadsfritt.',
    ],
    contactWithout:
      'Om problemet kvarstår, mejla kammarens kansli så tar vi bort din adress från alla utskick inom två arbetsdagar. Det är kostnadsfritt.',
    tryAgain: 'Försök igen',
  },
};

export default function UnsubscribeErrorBoundary({
  error,
  reset,
}: ErrorProps): React.ReactElement {
  const { email, locale } = useUnsubscribeContact();
  const copy = COPY[locale] ?? COPY.en;

  useEffect(() => {
    // The Next.js runtime already logs the throw; this hook is here so
    // the digest is structurally available for future telemetry hooks.
    // Avoid any imports that could themselves throw (i18n, metrics).
    console.error('unsubscribe_page_render_threw', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <main
      lang={locale}
      className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6 text-center"
    >
      <article className="w-full rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-4 text-2xl font-semibold">{copy.heading}</h1>
        <p className="mb-3 text-base text-foreground">{copy.body}</p>
        <p className="mb-4 text-sm text-foreground">
          {email ? (
            <>
              {copy.contactWith[0]}
              <a
                href={`mailto:${email}`}
                className="inline-block py-1 font-medium underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                {email}
              </a>
              {copy.contactWith[1]}
            </>
          ) : (
            copy.contactWithout
          )}
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-block rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          {copy.tryAgain}
        </button>
      </article>
    </main>
  );
}
