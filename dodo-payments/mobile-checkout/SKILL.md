---
name: mobile-checkout
description: Guide for implementing mobile in-app checkout with Dodo Payments across React Native, Flutter, iOS, and Android platforms.
---

# Mobile In-App Checkout

This skill covers integrating Dodo Payments hosted checkout into native and cross-platform mobile apps using secure system browser contexts.

## When to use this skill

- Building a React Native app with Turbo Module checkout integration
- Adding checkout to a Flutter app via native bridge
- Implementing native iOS or Android checkout with secure browser contexts
- Registering custom URL schemes and deep links for payment return
- Handling abandoned checkout sessions and recovery flows
- Confirming payment authority server-side before granting access

## Core principle: Backend creates, mobile opens

Your backend creates the checkout session and returns a URL. The mobile app opens that URL in a secure browser context. Your API key must never be embedded in the app binary. The mobile SDK result is informational only; always verify the payment server-side via webhook or API before unlocking features or granting access.

## Architecture overview

1. **Backend:** Create a checkout session via `client.checkoutSessions.create(...)` and return the `checkout_url` to your mobile app.
2. **Mobile app:** Call the platform-specific SDK with the checkout URL and a registered return URL scheme.
3. **Browser context:** The SDK opens the URL in a secure system browser: SFSafariViewController on iOS and Chrome Custom Tabs on Android.
4. **Return:** After payment, the browser navigates to your return URL. The SDK captures the result and passes it to your app.
5. **Verification:** Query the checkout session or listen for a webhook to confirm the payment before granting access.

## React Native (Turbo Module)

### Installation

```bash
npm install @dodopayments/react-native-checkout
```

For Expo projects, add the plugin to `app.json`:

```json
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      [
        "@dodopayments/react-native-checkout",
        { "scheme": "myappcheckout" }
      ]
    ]
  }
}
```

The plugin registers a custom URL scheme (`myappcheckout://`) that the checkout flow uses to return to your app.

### Setup

Register the URL listener at app startup:

```typescript
import { Linking } from 'react-native';
import { DodoCheckout } from '@dodopayments/react-native-checkout';

// Required for iOS return-URL handling
Linking.addEventListener('url', ({ url }) => DodoCheckout.handleOpenURL(url));
```

### Starting checkout

```typescript
const result = await DodoCheckout.start({
  checkoutUrl: 'https://checkout.dodopayments.com/...',  // from your backend
  returnUrl: 'myappcheckout://checkout/return',          // must match registered scheme
  onEvent: (e) => console.log(e.type),                   // optional event logging
});

switch (result.status) {
  case 'succeeded':
    // Payment succeeded. Verify server-side before granting access.
    await verifyPaymentOnBackend(result.paymentId);
    showSuccess();
    break;
  case 'failed':
    // Payment failed. Show error to user.
    showFailure();
    break;
  case 'cancelled':
    // Sheet closed before the return URL arrived: the outcome is UNKNOWN and the
    // payment may have succeeded. Do not show a failure - reconcile instead.
    await reconcileAbandonedSession();
    break;
  case 'pending':
    // Settles later (status=processing / requires_*), or status was missing.
    await reconcileAbandonedSession();
    break;
  case 'expired':
    // Checkout session expired. Prompt user to start a new checkout.
    showExpired();
    break;
}
```

### Abandoned session recovery

The SDK keeps a record of the session until checkout ends with `succeeded`, `failed`, or `expired`. The record survives an app kill and **stays after a `cancelled` or `pending` result**. Check it on the next launch and after every `cancelled`/`pending`:

```typescript
import { DodoCheckout } from '@dodopayments/react-native-checkout';

async function reconcileAbandonedSession() {
  const abandoned = await DodoCheckout.getAbandonedSession();
  if (!abandoned) return;

  // Your backend calls GET /checkouts/{abandoned.sessionId} and returns payment_status.
  const outcome = await fetchCheckoutOutcome(abandoned.sessionId);
  if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'expired') {
    showOutcome(outcome);
    // Clear only once the outcome is final; until then treat it as pending, not failed.
    await DodoCheckout.clearAbandonedSession();
  } else {
    showPending();
  }
}
```

### Android minSdk requirement

React Native checkout requires Android minSdk 24 or higher. Note: the general mobile documentation mentions minSdk 23, but React Native specifically requires 24.

## Flutter

### Installation

Add the Dodo Payments Flutter package to `pubspec.yaml`:

```yaml
dependencies:
  dodopayments_checkout: ^1.0.2
```

### Setup

The package uses `DodoCheckout.instance`. On iOS, register the return URL scheme and forward incoming links from your deep-link listener. Run `flutter pub add app_links` if you use the `app_links` approach shown here:

```dart
import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:dodopayments_checkout/dodopayments_checkout.dart';

late final StreamSubscription<Uri> checkoutLinkSubscription;

void listenForCheckoutReturns() {
  checkoutLinkSubscription = AppLinks().uriLinkStream.listen((uri) {
    unawaited(DodoCheckout.instance.handleOpenURL(uri.toString()));
  });
}
```

Start the listener from your root state object's `initState` and cancel `checkoutLinkSubscription` from `dispose`. `handleOpenURL` is required on iOS and safely returns `false` on Android.

### Starting checkout

```dart
import 'package:dodopayments_checkout/dodopayments_checkout.dart';

final result = await DodoCheckout.instance.start(
  CheckoutParams(
    checkoutUrl: Uri.parse('https://checkout.dodopayments.com/...'),
    returnUrl: Uri.parse('myapp://checkout/return'),
    onEvent: (event) => print(event.type),
  ),
);

switch (result.status) {
  case CheckoutStatus.succeeded:
    final paymentId = result.paymentId;
    if (paymentId != null) {
      await verifyPaymentOnBackend(paymentId);
    }
    showSuccess();
    break;
  case CheckoutStatus.failed:
    showFailure();
    break;
  case CheckoutStatus.cancelled:
  case CheckoutStatus.pending:
    // Outcome unknown (the payment may have succeeded): reconcile the
    // abandoned session with your backend instead of showing a failure.
    await reconcileAbandonedSession();
    break;
  case CheckoutStatus.expired:
    showExpired();
    break;
}
```

### Return URL registration

On Android, set the callback scheme in `android/app/build.gradle.kts`. The package's native checkout dependency supplies the intent filter, so do not add one manually:

```kotlin
android {
  defaultConfig {
    minSdk = 23
    manifestPlaceholders["dodoCallbackScheme"] = "myapp"
  }
}
```

Remove an empty `android:taskAffinity=""` from `MainActivity` if the generated Flutter manifest contains it; it can prevent Custom Tabs from returning correctly on some devices.

On iOS, register the same scheme in `ios/Runner/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>myapp</string>
    </array>
  </dict>
</array>
```

## iOS (native)

Use the official Swift package rather than parsing the return URL yourself. It presents `SFSafariViewController`, matches the return URL, and maps `status` (including `active` for subscriptions and `processing`/`requires_*` as pending) into a typed result. Requires iOS 16+ and Swift 6.2+.

### Installation

Add `https://github.com/dodopayments/dodopayments-mobile-sdk-ios` (1.1.0 or later) in **File → Add Package Dependencies**, or in `Package.swift`:

```swift
.package(url: "https://github.com/dodopayments/dodopayments-mobile-sdk-ios", from: "1.1.0")
```

The library product is `DodoCheckout`. Register your scheme (`myapp`) under `CFBundleURLTypes` in `Info.plist`, and use the same URL as the session's `return_url`.

### Starting checkout

```swift
import DodoCheckout

let result = try await DodoCheckout.start(
    checkoutUrl: checkoutUrl,   // URL from your backend's checkout session
    returnUrl: URL(string: "myapp://checkout/return")!,
    onEvent: { event in print(event.name) }  // logging only
)

switch result.status {
case .succeeded: showSuccess(result.paymentId)          // UI hint only; verify on the backend
case .failed:    showFailure()
case .cancelled: await reconcileAbandonedSession()      // outcome unknown, not a failure
case .pending:   await reconcileAbandonedSession()
case .expired:   showExpired()
}
```

### Forwarding the return URL

`SFSafariViewController` cannot catch its own return URL, so forward every incoming URL to the SDK:

```swift
// SwiftUI
.onOpenURL { url in
    DodoCheckout.handleOpenURL(url)
}
```

`handleOpenURL` returns `true` only for the in-progress checkout's return URL; handle other URLs yourself.

### Abandoned sessions

```swift
func reconcileAbandonedSession() async {
    guard let abandoned = DodoCheckout.getAbandonedSession() else { return }

    // Your backend calls GET /checkouts/{sessionId} and returns payment_status.
    let outcome = await fetchCheckoutOutcome(abandoned.sessionId)
    switch outcome {
    case "succeeded", "failed", "expired":
        showOutcome(outcome)
        // Clear only once the outcome is final.
        DodoCheckout.clearAbandonedSession()
    default:
        showPending() // still pending - keep the record and check again later
    }
}
```

## Android (native)

Use the official Android checkout SDK (`minSdk` 23, Kotlin, Java 17). It opens Chrome Custom Tabs, declares the redirect intent filter itself, and returns a typed result.

### Installation

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.dodopayments.api:checkout-android:1.1.0")
}

android {
    defaultConfig {
        // The SDK's manifest uses this placeholder; do not add an intent filter yourself.
        manifestPlaceholders["dodoCallbackScheme"] = "myapp"
    }
}
```

### Starting checkout

```kotlin
import com.dodopayments.checkout.CheckoutParams
import com.dodopayments.checkout.CheckoutStatus
import com.dodopayments.checkout.DodoCheckout

// The activity-result launcher survives process death.
private val checkoutLauncher =
    registerForActivityResult(DodoCheckout.contract()) { result ->
        when (result.status) {
            CheckoutStatus.SUCCEEDED -> showSuccess(result.paymentId) // UI hint only; verify on the backend
            CheckoutStatus.FAILED -> showFailure()
            CheckoutStatus.CANCELLED -> reconcileAbandonedSession() // outcome unknown, not a failure
            CheckoutStatus.PENDING -> reconcileAbandonedSession()
            CheckoutStatus.EXPIRED -> showExpired()
        }
    }

checkoutLauncher.launch(
    CheckoutParams(
        checkoutUrl = checkoutUrl, // from your backend's checkout session
        returnUrl = "myapp://checkout/return"
    )
)
```

### Abandoned sessions

```kotlin
suspend fun reconcileAbandonedSession() {
    val abandoned = DodoCheckout.getAbandonedSession(context) ?: return

    // Your backend calls GET /checkouts/{sessionId} and returns payment_status.
    when (val outcome = fetchCheckoutOutcome(abandoned.sessionId)) {
        "succeeded", "failed", "expired" -> {
            showOutcome(outcome)
            // Clear only once the outcome is final.
            DodoCheckout.clearAbandonedSession(context)
        }
        else -> showPending() // still pending - keep the record and check again later
    }
}
```

## Backend: Creating checkout sessions

Always create checkout sessions on your backend. Never embed your API key in the mobile app.

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});

const MOBILE_PRODUCTS = new Map([
  ['starter', 'pdt_starter123'],
  ['pro', 'pdt_pro456'],
]);

app.post('/api/mobile-checkout', requireAuth, async (req, res) => {
  const productId = MOBILE_PRODUCTS.get(req.body.plan);

  if (!productId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  // requireAuth derives this mapping from the authenticated server-side session.
  const customerId = req.auth.dodoCustomerId;
  
  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { customer_id: customerId },
    return_url: 'myapp://checkout/return',
  });
  
  res.json({ checkout_url: session.checkout_url });
});
```

## Verifying payment server-side

Never grant access based on the mobile SDK result alone. Always verify via webhook or API.

### Via webhook

Listen for `payment.succeeded` webhooks. Webhook signature verification is covered in the `webhook-integration` skill.

```typescript
// Mount with express.raw({ type: 'application/json' }) so req.body is the raw Buffer.
app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = client.webhooks.unwrap(req.body.toString(), {
      headers: {
        'webhook-id': req.headers['webhook-id'] as string,
        'webhook-signature': req.headers['webhook-signature'] as string,
        'webhook-timestamp': req.headers['webhook-timestamp'] as string,
      },
    });
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    // Dodo retries and may redeliver: claim webhook-id with a UNIQUE insert
    // and grant in the same transaction so a duplicate is a no-op.
    await db.$transaction(async (tx) => {
      const claim = await tx.webhookLog.createMany({
        data: [{ webhookId: req.headers['webhook-id'] as string, eventType: event.type }],
        skipDuplicates: true,
      });
      if (claim.count === 0) return; // already processed

      if (event.type === 'payment.succeeded') {
        await grantAccess(event.data.customer.customer_id, tx);
      }
    });
  } catch (error) {
    // Non-2xx makes Dodo retry; the transaction rolled back the claim.
    return res.status(500).json({ error: 'Processing failed' });
  }

  res.json({ received: true });
});
```

### Via API

Query the checkout session to confirm payment:

```typescript
const session = await client.checkoutSessions.retrieve(sessionId);

if (session.payment_status === 'succeeded' && session.payment_id) {
  const payment = await client.payments.retrieve(session.payment_id);
  await grantAccess(payment.customer.customer_id);
}
```

## Selling digital goods on iOS

Dodo Payments hosted checkout can sell digital goods (subscriptions, courses, downloads, SaaS plans) in an iOS app **only on App Store storefronts where Apple allows external purchases**:

- **United States:** Guideline 3.1.1(a) allows buttons and links to other purchase methods without an entitlement (subject to the Epic v. Apple proceedings).
- **European Union:** requires Apple's EU external purchase entitlement (the StoreKit External Purchases or Offers Entitlement from October 1, 2026) and DMA compliance.
- **Japan:** allowed under the Mobile Software Competition Act, following Apple's Japan-specific entitlement requirements.
- **South Korea is not supported** (Apple requires a native, non-web-view flow through an approved Korean PSP).

On other storefronts, digital goods sold inside the iOS app must use Apple in-app purchase (StoreKit). Review Apple's region-specific entitlements before enabling Dodo checkout for a storefront; unsupported flows can get the app rejected.

## Common mistakes

### Embedding the API key in the app

Never include your API key in the app binary or client-side code. Always create checkout sessions on your backend.

```typescript
// WRONG
const client = new DodoPayments({
  bearerToken: 'dodo_live_abc123...',  // Never hardcode
});

// CORRECT
const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,  // Backend only
});
```

### Trusting the mobile SDK result

The SDK result is informational. Always verify server-side before granting access.

```typescript
// WRONG
if (result.status === 'succeeded') {
  grantAccess();  // No verification
}

// CORRECT
if (result.status === 'succeeded') {
  const verified = await verifyPaymentOnBackend(result.paymentId);
  if (verified) {
    grantAccess();
  }
}
```

### Forgetting URL scheme registration

If you don't register the custom URL scheme, the app won't receive the return callback and checkout will appear to hang.

- React Native: Use the Expo plugin or manually register in `Info.plist` and `AndroidManifest.xml`.
- Flutter: Register in both `Info.plist` and `AndroidManifest.xml`.
- iOS: Add `CFBundleURLTypes` to `Info.plist` and forward URLs to `DodoCheckout.handleOpenURL`.
- Android: Set `manifestPlaceholders["dodoCallbackScheme"]`; the SDK supplies the intent filter.

### Not handling all result statuses

Always handle all five statuses: `succeeded`, `failed`, `cancelled`, `pending`, and `expired`. Each requires different UX.

```typescript
// WRONG
if (result.status === 'succeeded') {
  showSuccess();
}

// CORRECT
switch (result.status) {
  case 'succeeded':
    showSuccess();
    break;
  case 'failed':
    showFailure();
    break;
  case 'cancelled':
  case 'pending':
    // Unknown outcome - reconcile, never show a failure
    reconcileAbandonedSession();
    break;
  case 'expired':
    showExpired();
    break;
}
```

### Ignoring abandoned sessions

If the app crashes or is backgrounded during checkout, the session is abandoned. Always check for and recover abandoned sessions on app startup.

```typescript
// WRONG
// No recovery logic

// CORRECT: reconcile on launch and after every cancelled/pending result,
// and clear the record only once the backend reports a final outcome.
await reconcileAbandonedSession(); // defined in the React Native section above
```

## Package names

Use `@dodopayments/react-native-checkout` for React Native and `dodopayments_checkout` for Flutter. The similarly named `@dodopayments/react-native` and `dodo_payments_flutter` packages do not exist.

## Resources

- [Mobile Integration](https://docs.dodopayments.com/developer-resources/mobile-integration)
- [React Native SDK](https://docs.dodopayments.com/developer-resources/sdks/react-native)
- [iOS SDK](https://docs.dodopayments.com/developer-resources/sdks/ios)
- [Android SDK](https://docs.dodopayments.com/developer-resources/sdks/android)
- [Flutter SDK](https://pub.dev/packages/dodopayments_checkout)
- [Selling Digital Goods on iOS](https://docs.dodopayments.com/features/appstore-digital-goods)
- [Webhook Integration](https://docs.dodopayments.com/developer-resources/webhooks/intents) (for payment verification)
