---
name: checkout-integration
description: Guide for creating checkout sessions and payment flows with Dodo Payments - one-time, subscriptions, and overlay checkout.
---

# Dodo Payments Checkout Integration

Use `client.checkoutSessions.create(...)` to build hosted checkout pages or overlay checkout modals. This is the recommended path for all new payment integrations.

## When to use this skill

- Build a one-time payment checkout flow
- Create a subscription checkout with optional trial
- Embed checkout in an overlay or inline modal
- Collect customer billing info and custom fields at checkout
- Apply discount codes or handle currency selection
- Redirect customers after payment completes

---

## Checkout Methods

Dodo Payments offers three ways to collect payment:

| Method | Best For | Setup |
|--------|----------|-------|
| **Checkout Sessions** (recommended) | Most integrations; full control | Server-side SDK call |
| **Static Payment Links** | No-code sharing; reusable URLs | Dashboard or direct URL |
| **Overlay/Inline Checkout** | Seamless UX; stays on your site | Client-side SDK |

**Legacy:** Dynamic Payment Links created via `POST /payments` or `POST /subscriptions` are deprecated. Use Checkout Sessions instead.

---

## Core Concepts

**Amounts in smallest currency unit:** All prices are in cents (or equivalent). A $10 USD charge is `1000`.

**Checkout Session:** A single-use session that generates a hosted checkout URL. Expires after 24 hours (or 15 minutes if `confirm=true`).

**Return URL:** Where the customer lands after payment. Query parameters include `status=success` and `session_id`.

**Entitlement on webhook:** The browser redirect is not the source of truth. Always verify payment via webhook before granting access. See `webhook-integration` skill for verification.

---

## Create a Checkout Session

### Basic One-Time Payment

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode', // or 'live_mode'
});

const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: {
    email: 'customer@example.com',
    name: 'Jane Doe'
  },
  return_url: 'https://yoursite.com/checkout/success'
});

console.log('Redirect to:', session.checkout_url);
```

Response fields:
- `session_id`: Unique checkout session ID
- `checkout_url`: Hosted checkout URL (redirect customer here)
- `client_secret`: Present only if `confirm=true`
- `payment_id`: Present only if `confirm=true`

### With Multiple Products

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_item_1', quantity: 2 },
    { product_id: 'pdt_item_2', quantity: 1 }
  ],
  customer: { email: 'customer@example.com' },
  return_url: 'https://yoursite.com/success'
});
```

### With Existing Customer

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer_id: 'cus_existing_id',
  return_url: 'https://yoursite.com/success'
});
```

### With Billing Address and Tax ID

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: {
    email: 'customer@example.com',
    name: 'Jane Doe'
  },
  billing_address: {
    country: 'US',
    street: '123 Main St',
    city: 'San Francisco',
    state: 'CA',
    zipcode: '94105'
  },
  tax_id: 'VAT123456789',
  customer_business_name: 'Acme Corp',
  return_url: 'https://yoursite.com/success'
});
```

### With Discount Codes

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: { email: 'customer@example.com' },
  discount_codes: ['PROMO10', 'WELCOME5'], // max 20, ordered
  feature_flags: {
    allow_discount_code: true
  },
  return_url: 'https://yoursite.com/success'
});
```

### With Subscription and Trial

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_monthly_subscription', quantity: 1 }
  ],
  subscription_data: {
    trial_period_days: 14
  },
  customer: { email: 'subscriber@example.com' },
  return_url: 'https://yoursite.com/success'
});
```

### With Custom Fields

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: { email: 'customer@example.com' },
  custom_fields: [
    {
      key: 'company_size',
      label: 'Company Size',
      field_type: 'dropdown',
      options: ['1-10', '11-50', '51-200', '200+'],
      required: true
    },
    {
      key: 'use_case',
      label: 'Primary Use Case',
      field_type: 'text',
      placeholder: 'e.g., analytics, reporting',
      required: false
    }
  ],
  return_url: 'https://yoursite.com/success'
});
```

### With Metadata

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: { email: 'customer@example.com' },
  metadata: {
    order_id: 'order_12345',
    referral_code: 'FRIEND20',
    campaign: 'summer_sale'
  },
  return_url: 'https://yoursite.com/success'
});
```

---

## Next.js App Router

### API Route

```typescript
// app/api/checkout/route.ts
import { NextRequest, NextResponse } from 'next/server';
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY!,
  environment: process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode'
});

export async function POST(req: NextRequest) {
  try {
    const { productId, quantity = 1, email, name, metadata } = await req.json();

    if (!productId || !email) {
      return NextResponse.json(
        { error: 'Missing productId or email' },
        { status: 400 }
      );
    }

    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity }],
      customer: { email, name },
      metadata,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`
    });

    return NextResponse.json({
      checkoutUrl: session.checkout_url,
      sessionId: session.session_id
    });
  } catch (error: any) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create checkout' },
      { status: 500 }
    );
  }
}
```

### Client Component

```typescript
// components/CheckoutButton.tsx
'use client';

import { useState } from 'react';

interface CheckoutButtonProps {
  productId: string;
  email: string;
  name?: string;
  children: React.ReactNode;
}

export function CheckoutButton({ productId, email, name, children }: CheckoutButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, email, name })
      });

      const data = await response.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error(data.error || 'Failed to create checkout');
      }
    } catch (error) {
      console.error('Checkout error:', error);
      alert('Failed to start checkout. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleCheckout} disabled={loading}>
      {loading ? 'Loading...' : children}
    </button>
  );
}
```

### Success Page

```typescript
// app/checkout/success/page.tsx
import { Suspense } from 'react';

function SuccessContent() {
  return (
    <div className="text-center py-20">
      <h1 className="text-3xl font-bold">Payment Successful</h1>
      <p className="mt-4 text-gray-600">
        Thank you for your purchase. Check your email for a confirmation.
      </p>
      <a href="/" className="mt-8 inline-block text-blue-600 hover:underline">
        Return to Home
      </a>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SuccessContent />
    </Suspense>
  );
}
```

---

## Express.js

```typescript
import express from 'express';
import DodoPayments from 'dodopayments';

const app = express();
app.use(express.json());

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY!,
  environment: process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode'
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { productId, email, name, quantity = 1 } = req.body;

    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity }],
      customer: { email, name },
      return_url: `${process.env.APP_URL}/success`
    });

    res.json({ checkoutUrl: session.checkout_url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/success', (req, res) => {
  res.send('Payment successful!');
});
```

---

## Python (FastAPI)

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dodopayments import DodoPayments
import os

app = FastAPI()
client = DodoPayments(
    bearer_token=os.environ["DODO_PAYMENTS_API_KEY"],
    environment="test_mode"
)

class CheckoutRequest(BaseModel):
    product_id: str
    email: str
    name: str = None
    quantity: int = 1

@app.post("/api/checkout")
async def create_checkout(request: CheckoutRequest):
    try:
        session = client.checkout_sessions.create(
            product_cart=[{
                "product_id": request.product_id,
                "quantity": request.quantity
            }],
            customer={
                "email": request.email,
                "name": request.name
            },
            return_url=f"{os.environ['APP_URL']}/success"
        )
        return {"checkout_url": session.checkout_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

---

## Overlay Checkout

Use the `dodopayments-checkout` package for overlay or inline checkout that stays on your site.

### Installation

```bash
npm install dodopayments-checkout
```

### Overlay Mode

```typescript
import { DodoPayments } from 'dodopayments-checkout';

// First, create a checkout session on your server
const session = await client.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_example', quantity: 1 }],
  customer: { email: 'customer@example.com' },
  return_url: 'https://yoursite.com/success'
});

// Then initialize and open the overlay
DodoPayments.Initialize({
  mode: 'test', // or 'live'
  displayType: 'overlay',
  onEvent: (event) => {
    console.log('Checkout event:', event);
  }
});

DodoPayments.Checkout.open({
  checkoutUrl: session.checkout_url
});
```

### Inline/Embedded Mode

```typescript
import { DodoPayments } from 'dodopayments-checkout';

DodoPayments.Initialize({
  mode: 'test',
  displayType: 'inline',
  onEvent: (event) => {
    console.log('Checkout event:', event);
  }
});

DodoPayments.Checkout.open({
  checkoutUrl: session.checkout_url,
  elementId: 'dodo-inline-checkout'
});
```

```html
<div id="dodo-inline-checkout"></div>
```

---

## Static Payment Links

No-code shareable links. No server-side API call needed.

### Basic Format

```text
https://checkout.dodopayments.com/buy/{productid}
```

Example:
```text
https://checkout.dodopayments.com/buy/pdt_example
```

### With Query Parameters

```text
https://checkout.dodopayments.com/buy/pdt_example?quantity=2&email=customer@example.com&redirect_url=https%3A%2F%2Fyoursite.com%2Fsuccess
```

Supported parameters:
- `quantity`: Item quantity
- `redirect_url`: Success redirect URL
- `email`: Prefill customer email
- `fullName`, `firstName`, `lastName`: Prefill name
- `country`, `city`, `state`, `zipCode`, `addressLine`: Prefill address
- `paymentCurrency`: Force currency
- `metadata_*`: Custom metadata (e.g., `metadata_orderId=123`)

---

## Retrieve and Preview Sessions

### Retrieve Session Status

```typescript
const status = await client.checkoutSessions.retrieve('cks_session_id');

console.log(status.session_id);
console.log(status.checkout_url);
```

### Preview Session (without creating)

```typescript
const preview = await client.checkoutSessions.preview({
  product_cart: [
    { product_id: 'pdt_example', quantity: 1 }
  ],
  customer: { email: 'customer@example.com' },
  billing_currency: 'EUR'
});

console.log('Preview total:', preview.total_amount);
```

---

## Customization

### Theme and Appearance

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_example', quantity: 1 }],
  customer: { email: 'customer@example.com' },
  customization: {
    theme: 'dark', // 'light', 'dark', or 'system'
    force_language: 'en',
    show_order_details: true,
    theme_config: {
      font_size: 'md',
      font_weight: 'normal',
      radius: '8px',
      pay_button_text: 'Complete Purchase',
      light: {
        bg_primary: '#ffffff',
        text_primary: '#000000',
        button_primary: '#0066ff'
      }
    }
  },
  return_url: 'https://yoursite.com/success'
});
```

### Feature Flags

```typescript
const session = await client.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_example', quantity: 1 }],
  customer: { email: 'customer@example.com' },
  feature_flags: {
    allow_discount_code: true,
    allow_currency_selection: true,
    allow_customer_editing_email: true,
    allow_phone_number_collection: true,
    require_phone_number: false,
    allow_tax_id: true
  },
  return_url: 'https://yoursite.com/success'
});
```

---

## Post-Payment Flow

### Return URL Handling

After payment, the customer is redirected to your `return_url` with query parameters:

```text
https://yoursite.com/success?status=success&session_id=cks_123
```

Query parameters:
- `status`: `success` or `failed`
- `session_id`: Checkout session ID

### Verify Payment Server-Side

Do not trust the browser redirect. Always verify via webhook:

```typescript
app.post('/webhook', async (req, res) => {
  try {
    const event = client.webhooks.unwrap(req.body.toString(), {
      headers: {
        'webhook-id': req.headers['webhook-id'] as string,
        'webhook-signature': req.headers['webhook-signature'] as string,
        'webhook-timestamp': req.headers['webhook-timestamp'] as string
      }
    });

    if (event.type === 'payment.succeeded') {
      // Payment verified. Grant access here.
      await grantAccess(event.data.customer_id);
    }

    res.json({ received: true });
  } catch (error) {
    res.status(401).json({ error: 'Invalid signature' });
  }
});
```

Webhook signature verification is covered in the `webhook-integration` skill.

---

## Common Mistakes

**1. Trusting the browser redirect**
The return URL redirect is not proof of payment. Always verify via webhook before granting access or fulfilling the order.

**2. Using deprecated APIs**
Do not use `client.payments.create()` or `client.subscriptions.create()` for new integrations. Both are deprecated. Use `client.checkoutSessions.create()`.

**3. Forgetting the `environment` flag**
The default is `live_mode`. Always set `environment: 'test_mode'` during development to avoid charging real cards.

**4. Mixing `discount_code` and `discount_codes`**
The singular `discount_code` is deprecated. Use the array `discount_codes` (max 20). They cannot be combined.

**5. Amounts in wrong unit**
All amounts are in the smallest currency unit (cents for USD). $10 is `1000`, not `10`.

**6. Reusing checkout URLs**
Checkout URLs are single-use. Create a new session for each checkout attempt.

**7. Ignoring `confirm=true` behavior**
When `confirm=true`, the session is finalized immediately and the checkout URL expires in 15 minutes instead of 24 hours. Use only when you have all required customer data.

**8. Forgetting raw body for webhooks**
Webhook signature verification requires the raw request body, not a re-serialized JSON object. Use `express.raw()` middleware.

---

## Resources

- [Checkout Sessions Integration Guide](https://docs.dodopayments.com/developer-resources/integration-guide)
- [Checkout Sessions API Reference](https://docs.dodopayments.com/api-reference/checkout-sessions/create)
- [Overlay Checkout](https://docs.dodopayments.com/developer-resources/overlay-checkout)
- [Inline Checkout](https://docs.dodopayments.com/developer-resources/inline-checkout)
- [Static Payment Links](https://docs.dodopayments.com/developer-resources/integration-guide)
- [Webhook Integration](https://docs.dodopayments.com/developer-resources/webhooks)
