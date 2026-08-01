---
name: testing-and-go-live
description: Guide for test-mode payment scenarios, renewal simulation, local webhook delivery tests, test and live catalog migration, and production launch checks.
---

# Testing and Go-Live

This skill covers test mode, test payment methods, webhook testing, and the production launch checklist. Use it when building payment flows that need verification before going live, or when preparing to switch from test to production.

## When to use this skill

- You need to test card success/decline scenarios, subscription renewals, or regional payment methods.
- You're setting up webhook testing locally or in a staging environment.
- You're preparing to launch to production and need a go-live checklist.
- You want to verify that test and live environments are properly isolated.
- You're copying products from test to production.

## Core concepts

**Test vs. live mode:** Dodo Payments maintains two completely separate environments. Each has its own base URL, API keys, webhooks, products, customers, and transactions. Data does not carry over between them.

- **Test mode:** `https://test.dodopayments.com`
- **Live mode:** `https://live.dodopayments.com`

Each environment requires separate API keys issued from the dashboard. The SDK defaults to `live_mode` if you don't specify `environment`, which is a real footgun in development.

**Test payment methods:** Dodo documents specific card numbers, VPAs, and payment method scenarios for testing. These only work in test mode.

**Webhook testing:** The CLI provides commands to listen for webhooks locally and trigger test events without making real payments.

---

## Setting up test mode

Always explicitly set `environment: 'test_mode'` during development. The default is `live_mode`.

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode', // REQUIRED — defaults to 'live_mode'
});
```

```python
from dodopayments import DodoPayments

client = DodoPayments(
    bearer_token=os.environ.get("DODO_PAYMENTS_API_KEY"),
    environment="test_mode",  # defaults to "live_mode"
)
```

```go
client := dodopayments.NewClient(
    option.WithBearerToken("dodo_test_..."),
    option.WithEnvironmentTestMode(), // defaults to WithEnvironmentLiveMode()
)
```

Get your test API key from the Dodo dashboard. Test keys are prefixed `dodo_test_`.

---

## Test payment methods

### Card success and decline scenarios

Use these card numbers in test mode. The expiry can be any future date; the CVC can be any three digits.

| Scenario | Card Number | Result |
|---|---|---|
| Success | `4242 4242 4242 4242` | Payment succeeds |
| Decline | `4000 0000 0000 0002` | Payment declined |
| Decline (insufficient funds) | `4000 0000 0000 9995` | Insufficient funds error |
| Decline (lost card) | `4000 0000 0000 9987` | Lost card error |

### Subscription renewal failure

To test subscription renewal failures, use this card:

| Card Number | Behavior |
|---|---|
| `4000 0000 0000 0069` | Renewal fails on next billing date |

### UPI (India)

Test UPI success and failure with these VPAs:

| VPA | Result |
|---|---|
| `success@okhdfcbank` | Payment succeeds |
| `failure@okhdfcbank` | Payment fails |

### BNPL, wallets, and regional methods

BNPL, Apple Pay, Google Pay, and European payment methods (Giropay, iDEAL, Bancontact) are available in test mode. Exact test scenarios vary by method. Refer to the [Testing Process](https://docs.dodopayments.com/miscellaneous/testing-process) documentation for the current test matrix.

---

## Testing subscription renewals

To force a subscription to renew on a specific date without waiting, update the `next_billing_date`:

```typescript
await client.subscriptions.update('sub_123', {
  next_billing_date: '2026-05-03T00:00:00Z',
});
```

```python
client.subscriptions.update(
    'sub_123',
    next_billing_date='2026-05-03T00:00:00Z'
)
```

```go
client.Subscriptions.Update(ctx, "sub_123", dodopayments.SubscriptionUpdateParams{
    NextBillingDate: dodopayments.F("2026-05-03T00:00:00Z"),
})
```

This immediately schedules the renewal. If you used the subscription-renewal-failure card, the failed charge emits `payment.failed` and the affected subscription enters `on_hold`, which emits `subscription.on_hold`.

---

## Webhook testing

### Listen for webhooks locally

The Dodo CLI provides a tunnel to receive webhooks on your local machine:

```bash
dodo wh listen
```

This starts a local server and prints a webhook URL. Use that URL in your dashboard webhook configuration during development.

### Trigger test webhook events

Send a test webhook event without making a real payment:

```bash
dodo wh trigger
```

This prompts you to select an event type and sends it to your configured webhook endpoint. Useful for testing your webhook handler before going live.

### Webhook signature verification

Webhook signature verification is covered in the `webhook-integration` skill. Always verify signatures in production, even in test mode.

---

## Copying products from test to live

Products are environment-specific. You cannot reuse a test product ID in production. Instead, recreate the product in live mode or use the dashboard to export and reimport.

**Manual approach:**

1. Note the product details (name, price, tax category, etc.) from test mode.
2. Create a new product in live mode with the same configuration.
3. Update your code to use the new live product ID.

**Programmatic approach:**

Fetch the product from test mode, extract its configuration, and create it in live mode:

```typescript
// In test mode
const testClient = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});
const testProduct = await testClient.products.retrieve('pdt_test_123');

// In live mode
const liveClient = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'live_mode',
});
const liveProduct = await liveClient.products.create({
  name: testProduct.name,
  price: testProduct.price,
  tax_category: testProduct.tax_category,
  // ... other fields
});
```

---

## Go-live checklist

Before switching to production, verify each item:

### Business and compliance

- [ ] KYC (Know Your Customer) verification is complete in the Dodo dashboard.
- [ ] Business verification is approved.
- [ ] Your business details are correct in the dashboard.

### API and keys

- [ ] You have live API keys from the dashboard (prefixed `dodo_live_`).
- [ ] You've rotated or revoked any test keys that were accidentally committed.
- [ ] Your code uses `environment: 'live_mode'` (or omits it, since live is the default).

### Webhooks

- [ ] Your webhook endpoint is publicly accessible over HTTPS.
- [ ] You've updated the webhook URL in the dashboard to your production domain.
- [ ] You've updated the webhook secret in your environment variables.
- [ ] Your webhook handler verifies signatures using `client.webhooks.unwrap()` or the `standardwebhooks` package.
- [ ] You've tested the webhook flow end-to-end in production (or a staging environment with live keys).

### Products and checkout

- [ ] All products are created in live mode (not copied from test).
- [ ] Your checkout code uses live product IDs.
- [ ] Return URLs point to your production domain.
- [ ] Tax categories are correct for your products.

### Monitoring and support

- [ ] You have monitoring in place for payment failures, webhook delivery, and API errors.
- [ ] You know how to access the Dodo dashboard to view transactions and disputes.
- [ ] You have a plan for handling refunds and chargebacks.

---

## Common mistakes

### Leaving `environment` unset

The SDK defaults to `live_mode`. If you forget to set `environment: 'test_mode'` during development, your test code will hit production and create real charges.

```typescript
// WRONG — this hits live mode
const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
});

// CORRECT
const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});
```

### Reusing test product IDs in production

Test and live environments are completely separate. A product ID from test mode does not exist in live mode. Always create new products in live mode or use the dashboard to migrate them.

```typescript
// WRONG — pdt_test_123 does not exist in live mode
const session = await liveClient.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_test_123', quantity: 1 }],
});

// CORRECT — use a live product ID
const session = await liveClient.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_live_456', quantity: 1 }],
});
```

### Forgetting to reconfigure webhooks for production

Test and live modes have separate webhook endpoints and secrets. If you copy your test webhook configuration to production without updating the URL and secret, webhooks will fail or go to the wrong place.

- [ ] Update `DODO_PAYMENTS_WEBHOOK_KEY` in production environment variables.
- [ ] Update the webhook URL in the dashboard to your production domain.
- [ ] Test webhook delivery in production.

### Not verifying webhook signatures in production

Always verify webhook signatures using `client.webhooks.unwrap()` or the `standardwebhooks` package. Never trust a webhook without verification, even if it came from Dodo.

```typescript
// WRONG — no verification
app.post('/webhook', (req, res) => {
  const event = req.body;
  handleEvent(event);
  res.json({ received: true });
});

// CORRECT
app.post('/webhook', async (req, res) => {
  try {
    const unwrapped = client.webhooks.unwrap(req.body.toString(), {
      headers: {
        'webhook-id': req.headers['webhook-id'] as string,
        'webhook-signature': req.headers['webhook-signature'] as string,
        'webhook-timestamp': req.headers['webhook-timestamp'] as string,
      },
    });
    handleEvent(unwrapped);
    res.json({ received: true });
  } catch (error) {
    res.status(401).json({ error: 'Invalid signature' });
  }
});
```

### Mixing test and live keys

Test keys (prefixed `dodo_test_`) only work with `https://test.dodopayments.com`. Live keys are issued per mode from the dashboard. Using a test key with live mode will fail with an authentication error.

---

## Resources

- [Testing Process](https://docs.dodopayments.com/miscellaneous/testing-process)
- [Test vs. Live Mode](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode)
- [Webhook Integration](https://docs.dodopayments.com/developer-resources/webhooks/intents/introduction)
- [Dodo CLI](https://docs.dodopayments.com/developer-resources/cli)
