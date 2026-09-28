'use client';

/**
 * Spec 122 US4 — the pay sheet's states for the no-DB preview route
 * (`ALLOW_TEST_ROUTES` only). Stripe cannot load here, so the drawer is the
 * real AURA Drawer and the panels are the real panels, fed fixture props;
 * the card state shows the card-form skeleton the member sees while Stripe
 * Elements loads.
 */
import { useState } from 'react';
import { Drawer } from '@jirawatpyk/aura-react';
import { useTranslations } from 'next-intl';
import { MethodTabs, type PaymentMethod } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/method-tabs';
import { OrderSummary } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/order-summary';
import { SecurityFooter } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/security-footer';
import { PromptPayPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/promptpay-panel';
import { StatusPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/status-panel';
import { ConfirmationPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/confirmation-panel';
import { PaymentFailurePanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/payment-failure-panel';
import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';

export type PayPreviewState = 'card' | 'promptpay' | 'qr-expired' | 'processing' | '3ds' | 'success' | 'failed' | 'failed-permanent';

// A QR-shaped placeholder (the real one is Stripe's PromptPay image).
const QR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>' +
    Array.from({ length: 21 * 21 }, (_, i) => ((i * 7919) % 13 < 6 ? `<rect x="${i % 21}" y="${Math.floor(i / 21)}" width="1" height="1"/>` : '')).join('') +
    '</svg>',
)}`;

export function PayPreview({ state }: { readonly state: PayPreviewState }) {
  const t = useTranslations('portal.payment');
  const [method, setMethod] = useState<PaymentMethod>(state === 'promptpay' || state === 'qr-expired' ? 'promptpay' : 'card');
  const amountSatang = 3852000;
  let body: React.ReactNode;
  if (state === 'processing' || state === '3ds') {
    body = (
      // As `pay-sheet-internal.tsx` renders them: Cancel on the 3-D Secure
      // step only, none while processing.
      state === '3ds' ? (
        <StatusPanel kind="three-d-secure" onCancel={() => undefined} />
      ) : (
        <StatusPanel kind="processing" />
      )
    );
  } else if (state === 'success') {
    body = (
      <ConfirmationPanel
        method="card"
        amount="38,520.00 THB"
        dateTime="24 Sep 2026, 14:12"
        receiptUrl="#"
        invoiceId="00000000-0000-4000-8000-0000000000a1"
        onClose={() => undefined}
      />
    );
  } else {
    // As `pay-sheet-internal` composes it: the summary and the tabs stay on
    // screen for a card failure (the failure panel replaces the card form).
    const failed = state === 'failed' || state === 'failed-permanent';
    body = (
      <div className="space-y-4">
        <OrderSummary invoiceNumber="SC-2026-000123" amountDue={amountSatang} isBill />
        <MethodTabs
          enabledMethods={['card', 'promptpay']}
          activeMethod={method}
          onMethodChange={setMethod}
          cardPanel={
            failed ? (
              <PaymentFailurePanel
                reason={t('retry.reasonCardDeclined')}
                ctaLabel={t('retry.cta')}
                onRetry={() => undefined}
                testId="pay-sheet-retry-panel"
                ctaTestId="pay-sheet-retry-cta"
                permanent={state === 'failed-permanent'}
              />
            ) : (
              <PaySheetSkeleton variant="card" />
            )
          }
          promptPayPanel={
            <PromptPayPanel
              qrSvgUrl={QR}
              amountSatang={amountSatang}
              currency="THB"
              expirySeconds={state === 'qr-expired' ? 0 : 872}
              status={state === 'qr-expired' ? 'expired' : 'pending'}
              onRefresh={() => undefined}
              active={method === 'promptpay'}
            />
          }
        />
        <SecurityFooter />
      </div>
    );
  }
  return (
    <Drawer
      open
      onClose={() => undefined}
      size="md"
      title={t('drawer.title')}
      description={
        <span className="block truncate font-mono text-xs">
          {t('drawer.subtitle', { invoiceNumber: 'SC-2026-000123' })}
        </span>
      }
      className="pay-sheet [&_.aura-drawer\_\_head_.aura-icon-btn]:min-h-11 [&_.aura-drawer\_\_head_.aura-icon-btn]:min-w-11"
    >
      {body}
    </Drawer>
  );
}
