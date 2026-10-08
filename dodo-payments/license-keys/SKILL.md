---
name: license-keys
description: Guide for implementing license key management with Dodo Payments - activation, validation, and access control for software products.
---

# Dodo Payments License Keys

License keys authorize access to your digital products. Use them for software licensing, per-seat controls, and gating premium features.

## When to use this skill

- Implementing end-user license activation and validation flows
- Building merchant dashboards to manage customer license keys
- Handling license expiry, activation limits, and subscription-linked revocation
- Integrating license checks into desktop apps, CLIs, or web services
- Reacting to license lifecycle webhooks

## Core concepts

**License Key Entitlements** deliver keys when a product is purchased. The entitlement config supplies activation limits, optional duration, and fulfillment mode (auto or manual).

**Three distinct resources:**

1. **`client.licenses.*`** — end-user activation flow (public, no API key required)
   - `activate()` — activate a key on a device
   - `validate()` — check if a key is valid
   - `deactivate()` — free an activation slot

2. **Entitlement grants** — merchant-side reads and revocation (requires API key)
   - `client.customers.listEntitlementGrants()`, `client.entitlements.grants.list()` — list issued keys (each license-key grant carries a `license_key` object)
   - `client.entitlements.grants.revoke()` — revoke a key
   - `client.licenseKeys.create()` — still supported, for **importing** existing keys
   - `client.licenseKeys.list()` / `retrieve()` / `update()` are **deprecated** (`GET /license_keys`, `GET`/`PATCH /license_keys/{id}`); use the grant endpoints above instead

3. **`client.licenseKeyInstances.*`** — per-device activation instances (requires API key)
   - `list()`, `retrieve()`, `update()` — track active devices per key

**Activation limits:** blank/null means unlimited; otherwise it's the maximum concurrent activations. Attempting to activate beyond the limit returns `422`.

**Expiry semantics:**
- One-time-payment keys honor the entitlement duration.
- Subscription-issued keys have no independent expiry; Dodo drives their validity from subscription state **automatically**: `past_due` leaves them active, `on_hold` and `paused` disable them until the subscription recovers or resumes, `cancelled`/`expired` disable them permanently, and `plan_changed` replaces them. A one-time `refund.succeeded` also disables them. You do not need to disable keys yourself.
- Imported keys use nullable `expires_at`; null means perpetual.

---

## End-User Activation Flow

### Activate a license key

```typescript
import DodoPayments from 'dodopayments';

// The license endpoints are public and don't check the token, but the SDK
// constructor requires a value. Never ship your secret API key in client software.
// Set the environment explicitly: the SDK defaults to live_mode.
const client = new DodoPayments({ bearerToken: 'public', environment: 'test_mode' });

async function activateLicense(licenseKey: string, deviceName: string) {
  try {
    const response = await client.licenses.activate({
      license_key: licenseKey,
      name: deviceName, // e.g., "John's MacBook Pro"
    });

    return {
      success: true,
      instanceId: response.id,
      customerId: response.customer.customer_id,
      productId: response.product.product_id,
    };
  } catch (error: any) {
    if (error.status === 422) {
      return { success: false, error: 'Activation limit reached' };
    }
    return { success: false, error: error.message || 'Activation failed' };
  }
}
```

Response includes `id` (instance ID), `business_id`, `name`, `license_key_id`, `created_at`, customer details, and product details.

### Validate a license key

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({ bearerToken: 'public', environment: 'test_mode' }); // public endpoints: placeholder token; use 'live_mode' in production

async function validateLicense(licenseKey: string, instanceId: string) {
  try {
    const response = await client.licenses.validate({
      license_key: licenseKey,
      // Also checks that THIS device's activation still exists, so a
      // deactivated device stops validating even though the key is active.
      license_key_instance_id: instanceId,
    });

    return { valid: response.valid };
  } catch (error) {
    return { valid: false };
  }
}
```

Without `license_key_instance_id`, validation only checks that the key is `active` and unexpired. Pass the instance ID you stored at activation.

### Deactivate a license

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({ bearerToken: 'public', environment: 'test_mode' }); // public endpoints: placeholder token; use 'live_mode' in production

async function deactivateLicense(licenseKey: string, instanceId: string) {
  try {
    await client.licenses.deactivate({
      license_key: licenseKey,
      license_key_instance_id: instanceId,
    });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
```

---

## Merchant-Side Key Management

### List a customer's license keys

`client.licenseKeys.list()`, `retrieve()`, and `update()` are deprecated. Read keys through the entitlement grant endpoints; each license-key grant carries a `license_key` object (`key`, `status`, `expires_at`, `activations_used`, `activations_limit`), which is `null` on a manual-mode grant still `Pending`.

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});

async function listCustomerKeys(customerId: string) {
  const keys = [];
  for await (const grant of client.customers.listEntitlementGrants(customerId, {
    integration_type: 'license_key',
    status: 'Delivered',
  })) {
    if (!grant.license_key) continue;
    keys.push({
      grantId: grant.id,
      entitlementId: grant.entitlement_id,
      key: grant.license_key.key,
      status: grant.license_key.status,
      expiresAt: grant.license_key.expires_at,
      activationsUsed: grant.license_key.activations_used,
      activationsLimit: grant.license_key.activations_limit,
    });
  }
  return keys;
}
```

To list every key issued for one License Key entitlement, use `client.entitlements.grants.list('ent_...', { status: 'Delivered' })`.

### Revoke a license key

```typescript
// Disables the key with revocation_reason: manual. Manually revoked keys are
// not re-granted on subscription renewal.
await client.entitlements.grants.revoke('entg_abc123', { id: 'ent_license_key_id' });
```

### Import a license key (`POST /license_keys`)

Use this to migrate keys from another system. Imported keys do **not** trigger a customer email; notify the customer yourself. For keys Dodo issues, Dodo emails them.

```typescript
const newKey = await client.licenseKeys.create({
  customer_id: 'cus_abc123',
  key: 'PREMIUM-AAAA-BBBB-CCCC',
  product_id: 'pdt_abc123',
  activations_limit: 5,
  expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
});

console.log(newKey.key); // The actual license key string
```

---

## List Activation Instances

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});

// List all instances for a specific license key
for await (const instance of client.licenseKeyInstances.list({
  license_key_id: 'lk_abc123',
})) {
  console.log({
    id: instance.id,
    name: instance.name,
    createdAt: instance.created_at,
  });
}
```

Optional query fields: `page_size` (default 10, max 100), `page_number` (default 0), `license_key_id`, and `grant_id`.

---

## Desktop App Integration

### Electron app example

```typescript
// main/license.ts
import Store from 'electron-store';
import DodoPayments from 'dodopayments';
import os from 'os';

const store = new Store();
const client = new DodoPayments({ bearerToken: 'public', environment: 'test_mode' }); // public endpoints: placeholder token; use 'live_mode' in production

interface LicenseInfo {
  key: string;
  instanceId: string;
  activatedAt: string;
  lastValidatedAt?: string; // last time the server confirmed the license (absent on records saved before it was added)
}

export async function activateLicense(licenseKey: string): Promise<boolean> {
  try {
    const deviceName = `${os.hostname()} - ${os.platform()}`;

    const response = await client.licenses.activate({
      license_key: licenseKey,
      name: deviceName,
    });

    const now = new Date().toISOString();
    const licenseInfo: LicenseInfo = {
      key: licenseKey,
      instanceId: response.id,
      activatedAt: now,
      lastValidatedAt: now,
    };

    store.set('license', licenseInfo);
    return true;
  } catch (error) {
    console.error('Activation failed:', error);
    return false;
  }
}

export async function checkLicense(): Promise<boolean> {
  const license = store.get('license') as LicenseInfo | undefined;

  if (!license) {
    return false;
  }

  try {
    const response = await client.licenses.validate({
      license_key: license.key,
      license_key_instance_id: license.instanceId,
    });

    if (!response.valid) {
      // An explicit "invalid" from the server (revoked key, deactivated
      // instance) ends the license: drop the cache so a later offline start
      // cannot fall back to the grace period.
      store.delete('license');
      return false;
    }
    store.set('license', { ...license, lastValidatedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    // Only a connection failure (offline, DNS, timeout) earns the grace period.
    // Any other API error - a revoked key, a deactivated instance - is a real
    // answer from the server, so fail closed.
    if (!(error instanceof DodoPayments.APIConnectionError)) {
      return false;
    }

    // Trust the cached result only within a grace period measured from the
    // LAST SUCCESSFUL validation, not from activation - otherwise a key revoked
    // yesterday keeps working offline for 30 days after activation, and an old
    // activation gets no grace at all.
    // Records saved before lastValidatedAt existed fall back to activatedAt
    // until their first successful validation.
    const lastValidated = new Date(license.lastValidatedAt ?? license.activatedAt);
    const daysSinceValidation = (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);

    // Allow 30-day offline grace period
    return daysSinceValidation < 30;
  }
}

export async function deactivateLicense(): Promise<boolean> {
  const license = store.get('license') as LicenseInfo | undefined;

  if (!license) {
    return true;
  }

  try {
    await client.licenses.deactivate({
      license_key: license.key,
      license_key_instance_id: license.instanceId,
    });

    store.delete('license');
    return true;
  } catch (error) {
    console.error('Deactivation failed:', error);
    return false;
  }
}
```

### React component for license input

```tsx
// components/LicenseActivation.tsx
import { useState } from 'react';

interface Props {
  onActivated: () => void;
}

export function LicenseActivation({ onActivated }: Props) {
  const [licenseKey, setLicenseKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    setLoading(true);
    setError(null);

    try {
      const success = await window.electronAPI.activateLicense(licenseKey);

      if (success) {
        onActivated();
      } else {
        setError('Invalid license key. Please check and try again.');
      }
    } catch (err) {
      setError('Activation failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="license-form">
      <h2>Activate Your License</h2>
      <p>Enter your license key to unlock all features.</p>

      <input
        type="text"
        value={licenseKey}
        onChange={(e) => setLicenseKey(e.target.value)}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        disabled={loading}
      />

      {error && <p className="error">{error}</p>}

      <button onClick={handleActivate} disabled={loading || !licenseKey}>
        {loading ? 'Activating...' : 'Activate License'}
      </button>
    </div>
  );
}
```

---

## CLI Tool Integration

### Node.js CLI example

```typescript
// src/license.ts
import Conf from 'conf';
import DodoPayments from 'dodopayments';
import { machineIdSync } from 'node-machine-id';

interface StoredLicense {
  key: string;
  instanceId: string;
  machineId: string;
}

interface CliStore {
  license?: StoredLicense;
}

// Typing the store keeps `config.get('license')` strongly typed at every call site.
const config = new Conf<CliStore>({ projectName: 'your-cli' });
const client = new DodoPayments({ bearerToken: 'public', environment: 'test_mode' }); // public endpoints: placeholder token; use 'live_mode' in production

export async function activate(licenseKey: string): Promise<void> {
  const machineId = machineIdSync();
  const deviceName = `CLI - ${process.platform} - ${machineId.substring(0, 8)}`;

  try {
    const response = await client.licenses.activate({
      license_key: licenseKey,
      name: deviceName,
    });

    config.set('license', {
      key: licenseKey,
      instanceId: response.id,
      machineId,
    });

    console.log('License activated successfully!');
  } catch (error: any) {
    if (error.status === 422) {
      console.error('Activation limit reached. Deactivate another device first.');
    } else {
      console.error('Activation failed:', error.message);
    }
    process.exit(1);
  }
}

export async function checkLicense(): Promise<boolean> {
  const license = config.get('license');

  if (!license) {
    return false;
  }

  try {
    const response = await client.licenses.validate({
      license_key: license.key,
      license_key_instance_id: license.instanceId,
    });

    return response.valid;
  } catch {
    return false;
  }
}

export async function deactivate(): Promise<void> {
  const license = config.get('license');

  if (!license) {
    console.log('No active license found.');
    return;
  }

  try {
    await client.licenses.deactivate({
      license_key: license.key,
      license_key_instance_id: license.instanceId,
    });

    config.delete('license');
    console.log('License deactivated.');
  } catch (error: any) {
    console.error('Deactivation failed:', error.message);
  }
}

export function requireLicense() {
  return async () => {
    const valid = await checkLicense();
    if (!valid) {
      console.error('This command requires a valid license.');
      console.error('Run: your-cli activate <license-key>');
      process.exit(1);
    }
  };
}
```

### CLI commands

```typescript
// src/cli.ts
import { Command } from 'commander';
import { activate, deactivate, checkLicense, requireLicense } from './license';

const program = new Command();

program
  .command('activate <license-key>')
  .description('Activate your license')
  .action(activate);

program
  .command('deactivate')
  .description('Deactivate license on this device')
  .action(deactivate);

program
  .command('status')
  .description('Check license status')
  .action(async () => {
    const valid = await checkLicense();
    console.log(valid ? 'License: Active' : 'License: Not activated');
  });

program
  .command('generate')
  .description('Generate something (requires license)')
  .hook('preAction', requireLicense())
  .action(async () => {
    // Premium feature
  });

program.parse();
```

---

## Webhook Integration

### Handle license key delivery

Dodo generates **and emails** each auto-fulfilled key to the customer (including the entitlement's activation message), and it disables, re-enables, and replaces keys as the subscription changes state. Your webhook only needs to mirror that state for your own records - do not email keys yourself and do not disable keys on cancellation.

When a product with licensing enabled is purchased, an auto-fulfilled key arrives as `entitlement_grant.created` with `status: "Delivered"` and a `license_key` object; no separate `entitlement_grant.delivered` follows. `entitlement_grant.delivered` fires only when a grant moves to `Delivered` later (for example, when you manually fulfill a `Pending` grant, or a revoked grant is restored), so handle both:

```typescript
// app/api/webhooks/dodo/route.ts
import { NextRequest, NextResponse } from 'next/server';
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
  environment: process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live_mode' : 'test_mode',
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const event = client.webhooks.unwrap(body, {
      headers: {
        'webhook-id': req.headers.get('webhook-id') || '',
        'webhook-signature': req.headers.get('webhook-signature') || '',
        'webhook-timestamp': req.headers.get('webhook-timestamp') || '',
      },
    });

    if (
      (event.type === 'entitlement_grant.created' || event.type === 'entitlement_grant.delivered') &&
      event.data.status === 'Delivered'
    ) {
      const { customer_id, id, license_key } = event.data;

      // Grants for other entitlement types (and Pending manual grants) have no license key.
      if (!license_key) {
        return NextResponse.json({ received: true });
      }

      // Store in your database. Upsert on the grant ID so retries and a restored
      // grant (entitlement_grant.delivered again for the same grant) are idempotent.
      // Dodo emails the key to the customer itself, so there is no email to send
      // here - which also means a retried delivery cannot send a duplicate.
      const record = {
        key: license_key.key,
        customerId: customer_id,
        expiresAt: license_key.expires_at ? new Date(license_key.expires_at) : null,
        activationsLimit: license_key.activations_limit,
        status: 'active',
      };
      await prisma.license.upsert({
        where: { externalId: id },
        create: { externalId: id, ...record },
        update: record,
      });
    }

    if (event.type === 'entitlement_grant.revoked') {
      // Dodo already disabled the key (cancellation, expiry, refund, on_hold,
      // pause, plan change, or manual revoke). Mirror it locally.
      await prisma.license.updateMany({
        where: { externalId: event.data.id },
        data: { status: 'revoked' },
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
}
```

**Webhook events:**

- `entitlement_grant.created` — grant created; `status: "Delivered"` with a `license_key` for auto-fulfilled keys (the primary issuance event), `status: "Pending"` with no key for manual fulfillment
- `entitlement_grant.delivered` — an existing grant moved to `Delivered` (manual fulfillment, or a revoked grant restored); not sent for auto-fulfilled keys
- `entitlement_grant.revoked` — license key revoked (Dodo already disabled it; mirror the state, inspect `revocation_reason`)
- `license_key.created` — legacy event (still fires, but use `entitlement_grant.*` for new integrations)

Subscription `cancelled`/`expired`/`on_hold`/`paused` events need no license action from you: Dodo disables the keys itself, and `licenses.validate()` reflects it immediately.

---

## Common Mistakes

### 1. Validating only at install time

Don't validate once and trust forever. Validate periodically (e.g., weekly) to catch revoked or expired keys.

```typescript
// Bad: validate once
if (await validateLicense(key)) {
  store.set('trusted', true);
}

// Good: validate on each startup
const isValid = await validateLicense(key);
if (!isValid) {
  // Fail closed
  process.exit(1);
}
```

### 2. Not handling activation-limit errors

When a user hits the activation limit, they need a clear path to deactivate an old device.

```typescript
try {
  await client.licenses.activate({ license_key: key, name: deviceName });
} catch (error: any) {
  if (error.status === 422) {
    // Show UI: "You've reached your activation limit. Deactivate a device first."
    // Provide a list of active instances so they can choose which to remove.
  }
}
```

### 3. Trusting client-side validation alone

Always validate on your server before granting access to sensitive features.

```typescript
// Bad: trust the client
if (localStorage.getItem('license_valid')) {
  showPremiumFeature();
}

// Good: validate server-side
const response = await fetch('/api/validate-license', {
  method: 'POST',
  body: JSON.stringify({ licenseKey }),
});
const { valid } = await response.json();
if (valid) {
  showPremiumFeature();
}
```

### 4. Hardcoding license keys

Never embed keys in client code or version control.

```typescript
// Bad
const LICENSE_KEY = 'PRO-AAAA-BBBB-CCCC-DDDD';

// Good
const licenseKey = process.env.DODO_LICENSE_KEY;
// or read from user input / secure storage
```

### 5. Not storing the instance ID

The instance ID is required for deactivation. Store it alongside the key.

```typescript
// Bad: only store the key
store.set('license_key', key);

// Good: store both
store.set('license', {
  key,
  instanceId: response.id,
  activatedAt: new Date().toISOString(),
  lastValidatedAt: new Date().toISOString(),
});
```

### 6. Failing open on validation errors

If validation fails (network error, server down), fail closed. Don't grant access.

```typescript
// Bad: assume valid if offline
try {
  const valid = await validateLicense(key);
  return valid;
} catch {
  return true; // WRONG: grants access on error
}

// Good: fail closed, with optional grace period
try {
  const valid = await validateLicense(key);
  return valid;
} catch {
  // Only trust local cache if within grace period
  const lastValidated = store.get('last_validated_at');
  const daysSince = (Date.now() - lastValidated) / (1000 * 60 * 60 * 24);
  return daysSince < 30;
}
```

---

## Resources

- [License Keys Guide](https://docs.dodopayments.com/features/license-keys)
- [Activate License API](https://docs.dodopayments.com/api-reference/licenses/activate-license)
- [Validate License API](https://docs.dodopayments.com/api-reference/licenses/validate-license)
- [Deactivate License API](https://docs.dodopayments.com/api-reference/licenses/deactivate-license)
- [License Key Instances API](https://docs.dodopayments.com/api-reference/licenses/get-license-key-instances)
- [List Customer Grants API](https://docs.dodopayments.com/api-reference/entitlements/list-customer-grants)
- [Entitlement Grant Webhooks](https://docs.dodopayments.com/developer-resources/webhooks/intents/entitlement-grant)
- [Webhook Verification](https://docs.dodopayments.com/developer-resources/webhooks/verification)
