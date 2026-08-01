---
name: better-auth-integration
description: Guide only for applications using @dodopayments/better-auth, covering authenticated customer sync, checkout, portal access, usage ingestion, and verified webhook callbacks.
---

# Better Auth Integration

This skill covers the `@dodopayments/better-auth` plugin, which synchronizes customers between Better Auth and Dodo Payments, handles checkout sessions, customer portal access, subscription listing, metered usage, and signature-verified webhooks.

## When to use this skill

- You're building a SaaS with Better Auth and need to sync users to Dodo Payments automatically on sign-up.
- You want to create checkout sessions tied to authenticated users without manual customer creation.
- You need to let signed-in users access the Dodo customer portal for subscriptions and payment methods.
- You're ingesting metered usage events from authenticated sessions.
- You need to handle Dodo webhooks with signature verification and event-specific callbacks.

## Core concepts

**Customer synchronization:** When a user signs up via Better Auth, the plugin creates a Dodo customer automatically if `createCustomerOnSignUp` is enabled. Metadata (like the Better Auth user ID) is attached to the customer record.

**Product slug mapping:** Instead of passing product IDs to checkout, you configure product slugs in the plugin. The plugin maps `slug: "premium-plan"` to the actual Dodo product ID.

**Authenticated portal:** The customer portal session is created server-side for the signed-in user, then redirected to the hosted portal URL.

**Webhook verification:** The plugin exposes a signature-verified webhook endpoint. Dodo signs each webhook with HMAC-SHA256 following the Standard Webhooks spec.

## Install

```bash
npm install @dodopayments/better-auth dodopayments better-auth zod
```

Verify the exact export names against your installed package version, as the official docs show an inconsistency between lowercase `betterAuth` and uppercase `BetterAuth`.

## Server setup

Register the Dodo plugin with your Better Auth instance. The plugin accepts a Dodo client, customer creation settings, and optional portal support.

```typescript
import { betterAuth } from "better-auth";
import DodoPayments from "dodopayments";
import { dodopayments, portal } from "@dodopayments/better-auth";

const dodoPayments = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: process.env.DODO_PAYMENTS_ENVIRONMENT || "test_mode",
  webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
});

export const auth = betterAuth({
  database: {
    // your database config
  },
  plugins: [
    dodopayments({
      client: dodoPayments,
      createCustomerOnSignUp: true,
      use: [portal()],
      getCustomerParams: (user) => ({
        metadata: { userId: user.id },
        phone_number: user.phoneNumber ?? null,
      }),
    }),
  ],
});
```

**Key options:**

- `client`: The initialized Dodo Payments client.
- `createCustomerOnSignUp`: If `true`, a Dodo customer is created when a user signs up. Defaults to `false`.
- `use`: Array of plugin features. Include `portal()` to enable the customer portal.
- `getCustomerParams`: A function that receives the Better Auth user object and returns Dodo customer metadata. Use this to attach the Better Auth user ID or other fields to the Dodo customer record.

## Client setup and checkout

On the client side, use the `authClient.dodopayments.checkoutSession()` method to create a checkout session for the signed-in user.

```typescript
import { authClient } from "@/lib/auth-client";

async function startCheckout() {
  const { data: session, error } = await authClient.dodopayments.checkoutSession({
    slug: "premium-plan",
    referenceId: "order_123",
  });

  if (error) {
    console.error("Checkout error:", error);
    return;
  }

  if (session) {
    window.location.href = session.url;
  }
}
```

**Parameters:**

- `slug`: The product slug configured in your Better Auth plugin setup. Maps to a Dodo product ID.
- `referenceId`: Your internal order or reference ID. Useful for reconciliation.

The method returns a checkout session with a `url` property. Redirect the user to that URL to begin payment.

## Customer portal

Enable the customer portal by including `portal()` in the plugin's `use` array during server setup. Then create a portal session server-side and redirect the user.

```typescript
import { auth } from "@/lib/auth";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const portalSession = await auth.api.dodopayments.customerPortal({
    headers: request.headers,
  });

  if (portalSession?.url) {
    return new Response(null, {
      status: 302,
      headers: { Location: portalSession.url },
    });
  }

  return new Response("Portal session failed", { status: 500 });
}
```

The portal allows users to manage subscriptions, update payment methods, view invoices, and cancel plans.

## List subscriptions and payments

Retrieve the signed-in customer's subscriptions and payments.

```typescript
const { data: subscriptions } = await authClient.dodopayments.listSubscriptions({
  headers: request.headers,
});

const { data: payments } = await authClient.dodopayments.listPayments({
  headers: request.headers,
});

subscriptions?.forEach((sub) => {
  console.log(`Subscription ${sub.id}: ${sub.status}`);
});

payments?.forEach((payment) => {
  console.log(`Payment ${payment.id}: ${payment.amount} ${payment.currency}`);
});
```

## Metered usage ingestion

If you're using metered billing, ingest usage events through the plugin.

```typescript
const { error } = await authClient.dodopayments.ingestUsage({
  meter_id: "meter_abc123",
  quantity: 100,
  idempotency_key: `usage_${Date.now()}`,
});

if (error) {
  console.error("Usage ingestion failed:", error);
}
```

The `idempotency_key` ensures the same event is not counted twice if the request is retried.

## Webhook endpoint

Set up a server-side webhook endpoint that verifies signatures and dispatches events.

```typescript
import { auth } from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.text();

  try {
    const event = await auth.api.dodopayments.verifyWebhook({
      body,
      headers: {
        "webhook-id": request.headers.get("webhook-id") || "",
        "webhook-signature": request.headers.get("webhook-signature") || "",
        "webhook-timestamp": request.headers.get("webhook-timestamp") || "",
      },
    });

    // Handle event
    switch (event.type) {
      case "payment.succeeded":
        console.log("Payment succeeded:", event.data.payment_id);
        break;
      case "subscription.active":
        console.log("Subscription active:", event.data.subscription_id);
        break;
      case "subscription.cancelled":
        console.log("Subscription cancelled:", event.data.subscription_id);
        break;
      default:
        console.log("Unhandled event:", event.type);
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (error) {
    console.error("Webhook verification failed:", error);
    return new Response("Invalid signature", { status: 401 });
  }
}
```

The plugin verifies the webhook signature using the Standard Webhooks spec. The signed message is `webhook-id.webhook-timestamp.raw_body`, HMAC-SHA256, base64-encoded.

## Common mistakes

**Creating Dodo customers manually in addition to the plugin.** If `createCustomerOnSignUp` is enabled, the plugin creates the customer automatically. Don't call `client.customers.create()` yourself for the same user, or you'll end up with duplicate customer records.

**Trusting client-side session state for entitlement.** Always verify the user's subscription status server-side before granting access to premium features. A user's session cookie can be forged or expired; the Dodo subscription is the source of truth.

**Skipping the webhook endpoint.** If you don't set up the webhook handler, you won't know when subscriptions renew, fail, or are cancelled. Implement the webhook endpoint and register it in the Dodo dashboard.

**Forgetting to pass the raw request body to webhook verification.** If you parse the body as JSON first, then re-serialize it, the signature will not match. Always pass the raw body string to the verification function.

**Not mapping user metadata.** Use `getCustomerParams` to attach the Better Auth user ID to the Dodo customer. This makes it easy to look up the Dodo customer later when you receive a webhook event.

## Resources

- [Better Auth Adapter](https://docs.dodopayments.com/developer-resources/better-auth-adaptor)
- [Dodo Payments SDK](https://github.com/dodopayments/dodopayments-typescript)
- [Standard Webhooks Spec](https://standardwebhooks.com)
