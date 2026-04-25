/**
 * T082b — Stripe JS SDK interception helper for pay-sheet E2E.
 *
 * Strategy
 * --------
 * `@stripe/stripe-js`'s `loadStripe()` short-circuits when `window.Stripe`
 * is already defined at call time (see
 * node_modules/@stripe/stripe-js/dist/index.js line ~93/119). We exploit
 * this by installing a fake `window.Stripe` factory via Playwright's
 * `addInitScript` BEFORE the page navigates. The real Stripe bundle is
 * never fetched and no js.stripe.com iframe is mounted.
 *
 * What we stub (minimum surface required by CardForm + PaySheetInternal):
 *
 *   Stripe(pk)                     → { elements, confirmPayment,
 *                                       retrievePaymentIntent }
 *   stripe.elements(options)       → { create, getElement }
 *   elements.create('payment', _)  → element
 *                                      .mount(node)  — no-op
 *                                      .on('ready', cb) — fires cb on next tick
 *                                      .update(opts) — no-op
 *                                      .destroy() — no-op
 *   stripe.confirmPayment({...})   → { paymentIntent: { id, status:
 *                                       'succeeded' } }
 *
 * The `confirmPayment` resolution drives PaySheetInternal's state
 * machine: card-form → success, at which point <ConfirmationPanel>
 * renders + the 44×44 Download-receipt CTA is exercised.
 *
 * Why not the network-route approach
 * ----------------------------------
 * The prompt's initial sketch used `page.route('**\/v1/payment_intents/
 * *\/confirm**')` to stub Stripe's REST endpoint. That path fails
 * because the real Stripe JS bundle refuses to run without a valid card
 * field typed into the hosted iframe — and the hosted iframe's origin
 * is `js.stripe.com`, which `frameLocator().fill()` can drive but is
 * slow + flaky at 3 viewports × 9 tests. Replacing the whole SDK is
 * faster + deterministic and preserves PCI posture (no card data moves
 * through our stubs at all — the fake SDK never sees a PAN).
 *
 * PCI posture
 * -----------
 * The stub returns only PCI-safe fields on the fake PaymentIntent:
 * `id`, `status`, `latest_charge`. No PAN, CVV, fingerprint, or
 * full-card metadata. Last4 / brand are never synthesised — the
 * ConfirmationPanel receives `last4` from a different path (prop) and
 * the default "****" renders when the prop is absent, which is
 * acceptable for this LAYOUT assertion.
 *
 * Known limitation
 * ----------------
 * This intercepts everything — you can't reach the real Stripe test
 * sandbox from tests that install the stub. Spec files that exercise
 * real Stripe flows (e.g. 3DS challenge UI, decline codes) should
 * either skip `stubStripeConfirmSuccess` or call it with a different
 * scenario resolver. Scope today is the success path only.
 */
import type { Page } from '@playwright/test';

/**
 * Install a fake `window.Stripe` factory that resolves
 * `confirmPayment()` to a succeeded PaymentIntent. Call BEFORE
 * `page.goto(...)` so the init script runs on the navigation.
 *
 * @param page         Playwright page to instrument.
 * @param options.paymentIntentId — echoed back on `confirmPayment`.
 *                       Defaults to `pi_test_layout` to match the
 *                       initiate stub in pay-sheet-viewport.spec.ts.
 */
export async function stubStripeConfirmSuccess(
  page: Page,
  options: { paymentIntentId?: string } = {},
): Promise<void> {
  return installStubStripe(page, {
    paymentIntentId: options.paymentIntentId ?? 'pi_test_layout',
    scenario: 'success',
  });
}

/**
 * Decline-card variant of {@link stubStripeConfirmSuccess} for AS-3
 * (Review I-8). `confirmPayment()` rejects with a Stripe-shaped error
 * carrying `code: 'card_declined'` + `decline_code: 'generic_decline'`.
 * Drives PaySheetInternal: card-form → failed → bilingual decline
 * message via `payments-errors-i18n.ts`.
 *
 * Use the test card 4000 0000 0000 0002 contract — Stripe maps that
 * card to this exact decline shape. The stub avoids a real `js.stripe.com`
 * round-trip while preserving the contract the UI consumes.
 */
export async function stubStripeConfirmDecline(
  page: Page,
  options: { paymentIntentId?: string; declineCode?: string } = {},
): Promise<void> {
  return installStubStripe(page, {
    paymentIntentId: options.paymentIntentId ?? 'pi_test_decline',
    scenario: 'decline',
    declineCode: options.declineCode ?? 'generic_decline',
  });
}

type StubScenario =
  | { scenario: 'success'; paymentIntentId: string }
  | { scenario: 'decline'; paymentIntentId: string; declineCode: string };

async function installStubStripe(
  page: Page,
  config: StubScenario,
): Promise<void> {
  const paymentIntentId = config.paymentIntentId;
  const scenario = config.scenario;
  const declineCode = config.scenario === 'decline' ? config.declineCode : '';

  // R5 fix (2026-04-25): @stripe/stripe-js v6+ injects the script tag
  // UNCONDITIONALLY (it no longer short-circuits on existing
  // `window.Stripe`). If real Stripe loads, it overwrites our stub
  // factory and validates clientSecret/publishableKey strictly →
  // IntegrationError → ErrorBoundary. Block ALL js.stripe.com requests
  // at the network layer so the script never reaches the page; our
  // addInitScript-defined `window.Stripe` is then the only factory.
  await page.route(
    (url) => url.hostname === 'js.stripe.com',
    (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        // Empty body — `window.Stripe` already injected by addInitScript.
        body: '/* stub-stripe: js.stripe.com blocked by E2E fixture */',
      });
    },
  );

  await page.addInitScript(([pi, scen, dc]: [string, string, string]) => {
    // -----------------------------------------------------------------
    // Fetch override for `/api/payments/initiate`
    // -----------------------------------------------------------------
    // PaySheetInternal's initiate effect has an inherent race: it
    // installs an AbortController cleanup keyed on `payState.kind`
    // being in the deps array, and calls `setPayState({kind:
    // 'initiating'})` SYNCHRONOUSLY inside the async IIFE before
    // `await fetch()`. When Playwright's `page.route(...)` intercepts
    // the initiate POST and fulfills over the wire, the response
    // arrives AFTER React commits the `initiating` re-render + runs
    // the old effect's cleanup (abort()), so the aborted flag trips
    // and the success branch never executes. State gets stuck at
    // `initiating` and the card panel never mounts.
    //
    // Overriding `fetch` here lets our response resolve on the
    // microtask queue that drains BEFORE React's rendering phase, so
    // the setPayState({kind: 'card-form', ...}) inside the async body
    // commits with the same paint as `initiating` and the state
    // advances cleanly. This is a test-only work-around; production
    // behaviour is unchanged (the real network path still has the
    // same latency characteristics that made the bug invisible until
    // now — a Phase 9 follow-up candidate).
     
    console.log('[stripe-mock] init script installed');
    const originalFetch = window.fetch.bind(window);
    window.fetch = function stubbedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/api/payments/initiate')) {
         
        console.log('[stripe-mock] intercepted initiate', url);
        const body = JSON.stringify({
          payment: { id: 'pay_test_layout' },
          stripe: {
            clientSecret: `${pi}_secret_test`,
            publishableKey: 'pk_test_layout',
            paymentIntentId: pi,
            promptpayQrSvgUrl: null,
          },
          correlationId: 'test-correlation-layout',
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return originalFetch(input, init);
    };

    // Build a minimal fake Stripe instance. The structure mirrors the
    // subset of the Stripe.js v3 API that @stripe/react-stripe-js +
    // CardForm actually reach for.
    //
    // NOTE: this runs in page context, so no TypeScript types —
    // everything is `any` by necessity.
    type ReadyListener = () => void;

    function makeElement() {
      const readyListeners: ReadyListener[] = [];
      const element = {
        mount() {
          // Fire `ready` on a microtask so React has time to commit.
          // PaySheetInternal gates on onReady → show=true which drives
          // the real submit button into the DOM.
          Promise.resolve().then(() => {
            readyListeners.forEach((cb) => {
              try {
                cb();
              } catch {
                // noop — test should fail visibly elsewhere.
              }
            });
          });
          return element;
        },
        unmount() {
          return element;
        },
        destroy() {
          return element;
        },
        on(event: string, cb: ReadyListener) {
          if (event === 'ready') {
            readyListeners.push(cb);
            // Also fire async so listeners registered after mount()
            // still receive the ready signal.
            Promise.resolve().then(() => {
              try {
                cb();
              } catch {
                // noop
              }
            });
          }
          return element;
        },
        off() {
          return element;
        },
        update() {
          return element;
        },
        blur() {
          return element;
        },
        focus() {
          return element;
        },
        clear() {
          return element;
        },
      };
      return element;
    }

    function makeElements() {
      const byType = new Map<string, unknown>();
      return {
        create(type: string) {
          const el = makeElement();
          byType.set(type, el);
          return el;
        },
        getElement(type: string) {
          return byType.get(type) ?? null;
        },
        submit() {
          return Promise.resolve({});
        },
        update() {
          return this;
        },
        fetchUpdates() {
          return Promise.resolve({});
        },
      };
    }

    function FakeStripe() {
      const declineResponse = () => ({
        // Stripe SDK shape on a card decline — `code: 'card_declined'`
        // + `decline_code: 'generic_decline'` matches the production
        // contract that `payments-errors-i18n.ts` keys against.
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: dc,
          message: 'Your card was declined.',
          payment_intent: { id: pi, status: 'requires_payment_method' },
        },
      });
      const successResponse = () => ({
        paymentIntent: {
          id: pi,
          status: 'succeeded',
          latest_charge: 'ch_test_layout',
        },
      });
      return {
        elements() {
          return makeElements();
        },
        confirmPayment() {
          return Promise.resolve(
            scen === 'decline' ? declineResponse() : successResponse(),
          );
        },
        confirmCardPayment() {
          return Promise.resolve(
            scen === 'decline'
              ? declineResponse()
              : { paymentIntent: { id: pi, status: 'succeeded' } },
          );
        },
        retrievePaymentIntent() {
          return Promise.resolve({
            paymentIntent: {
              id: pi,
              status:
                scen === 'decline' ? 'requires_payment_method' : 'succeeded',
            },
          });
        },
        createPaymentMethod() {
          return Promise.resolve({
            paymentMethod: { id: 'pm_test_layout' },
          });
        },
        // R5 fix (2026-04-25): @stripe/react-stripe-js validateStripe()
        // requires `createToken` to be a function — without this method
        // <Elements> rejects the prop with "Invalid prop `stripe`
        // supplied to `Elements`". Returning a benign empty token shape
        // is enough; the test path never exercises legacy token flows.
        createToken() {
          return Promise.resolve({ token: { id: 'tok_test_layout' } });
        },
      };
    }

    // @stripe/stripe-js checks `window.Stripe` before injecting the
    // <script src="https://js.stripe.com/v3/">. If we set it here, the
    // real bundle is never fetched.
    (window as unknown as { Stripe: typeof FakeStripe }).Stripe = FakeStripe;
  }, [paymentIntentId, scenario, declineCode] as [string, string, string]);
}
