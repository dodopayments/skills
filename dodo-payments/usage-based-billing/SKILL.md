---
name: usage-based-billing
description: Guide for implementing usage-based billing with Dodo Payments - meters, events, pricing per unit, and metered subscriptions.
---

# Dodo Payments Usage-Based Billing

**Reference: [docs.dodopayments.com/features/usage-based-billing](https://docs.dodopayments.com/features/usage-based-billing/introduction)**

Charge customers for what they actually use—API calls, storage, AI tokens, or any metric you define.

---

## When to use this skill

- You need to bill customers based on consumption (API calls, tokens, storage, bandwidth).
- You want to combine usage charges with subscriptions or one-time purchases.
- You need to track and aggregate events into billable quantities.
- You're building an AI service, SaaS platform, or infrastructure product with metered features.

---

## Core Concepts

### Events

Usage records sent from your application to Dodo. Each event is attributed to a customer and matched to a meter by its `event_name`.

```json
{
  "event_id": "evt_unique_123",
  "customer_id": "cus_abc123",
  "event_name": "api.call",
  "timestamp": "2025-01-21T10:30:00Z",
  "metadata": { "endpoint": "/v1/users", "tokens": 150 }
}
```

### Meters

Filters and aggregates events into billable quantities. A meter specifies:
- **Event name**: which events to match (case-sensitive)
- **Aggregation type**: how to combine events (count, sum, max, last)
- **Measurement unit**: the billing unit (calls, tokens, GB, etc.)
- **Optional filters**: conditions events must meet to be counted

### Aggregation Types

| Type | Use Case | Example |
|------|----------|---------|
| **Count** | Total events | API calls, image generations |
| **Sum** | Add values from a property | Tokens used, bytes transferred |
| **Max** | Highest value in a period | Peak concurrent users |
| **Last** | Most recent value | Current storage used |

For `sum`, `max`, and `last`, you specify which metadata property to aggregate.

### Pricing

Attach a meter to a product price to charge per unit:
- **Price per unit**: e.g., $0.001 per API call
- **Free threshold**: e.g., 1,000 free calls per month
- **Charge formula**: `(usage − threshold) × price_per_unit`

**Example**: 2,500 calls − 1,000 free = 1,500 × $0.02 = $30.00

---

## Meter Lifecycle

### Create a Meter

```typescript
import DodoPayments from 'dodopayments';

const client = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
});

const meter = await client.meters.create({
  name: 'API Requests',
  event_name: 'api.call',
  aggregation: { type: 'count' },
  measurement_unit: 'calls',
  description: 'Track API calls per customer',
});

console.log(meter.id); // mtr_...
```

For a sum aggregation, specify the property to aggregate:

```typescript
const meter = await client.meters.create({
  name: 'Token Usage',
  event_name: 'ai.tokens',
  aggregation: { type: 'sum', key: 'tokens' },
  measurement_unit: 'tokens',
});
```

### List and Retrieve Meters

```typescript
// List all meters
const meters = await client.meters.list();

// Retrieve a specific meter
const meter = await client.meters.retrieve('mtr_abc123');
```

### Archive and Unarchive

Meters are archived, not deleted. Archived meters stop accepting new events but retain historical data.

```typescript
// Archive a meter
await client.meters.archive('mtr_abc123');

// Unarchive to resume
await client.meters.unarchive('mtr_abc123');
```

---

## Event Ingestion

### Send Events

```typescript
await client.usageEvents.ingest({
  events: [{
    event_id: `api_${Date.now()}_${crypto.randomUUID()}`,
    customer_id: 'cus_abc123',
    event_name: 'api.call',
    timestamp: new Date().toISOString(),
    metadata: {
      endpoint: '/v1/users',
      method: 'GET',
    }
  }]
});
```

### Event Schema

| Field | Required | Notes |
|-------|----------|-------|
| `event_id` | Yes | Unique identifier for idempotency. Duplicate IDs in the same request reject the entire request. |
| `customer_id` | Yes | Dodo Payments customer ID. |
| `event_name` | Yes | Must match a meter's event name exactly (case-sensitive). |
| `timestamp` | No | ISO-8601 datetime. Defaults to current UTC time. Must be within one hour in the past or five minutes in the future. |
| `metadata` | No | Object with string, integer, number, or boolean values. Max 50 pairs; key length 100, value length 500. No nested objects or arrays. |

### Idempotency and Deduplication

- Each `event_id` is unique per customer per meter.
- Duplicate IDs in a single request reject the entire batch.
- An ID already ingested in an earlier request is silently ignored, making retries safe.

### Batch Ingestion

Send up to 1,000 events per request:

```typescript
async function trackBatchUsage(
  events: Array<{
    customerId: string;
    eventName: string;
    metadata: Record<string, string>;
  }>
) {
  const formattedEvents = events.map((e, i) => ({
    event_id: `batch_${Date.now()}_${i}_${crypto.randomUUID()}`,
    customer_id: e.customerId,
    event_name: e.eventName,
    timestamp: new Date().toISOString(),
    metadata: e.metadata,
  }));

  await client.usageEvents.ingest({ events: formattedEvents });
}

// Batch track multiple API calls
await trackBatchUsage([
  { customerId: 'cus_abc', eventName: 'api.call', metadata: { endpoint: '/v1/users' } },
  { customerId: 'cus_abc', eventName: 'api.call', metadata: { endpoint: '/v1/orders' } },
  { customerId: 'cus_xyz', eventName: 'api.call', metadata: { endpoint: '/v1/products' } },
]);
```

### Query Events

```typescript
// List events for a customer
const events = await client.usageEvents.list({
  customer_id: 'cus_abc123',
});

// Retrieve a specific event
const event = await client.usageEvents.retrieve('evt_abc123');
```

---

## Pricing Models

### Per-Unit Pricing

The only currently documented and operable pricing model. Configure a meter on a product price with:
- `price_per_unit`: decimal string (max 5 integer digits, 12 decimal places)
- `free_threshold`: optional integer (usage below this is not charged)

Charge formula: `(usage − threshold) × price_per_unit`

```typescript
// Create a product with per-unit pricing
const product = await client.products.create({
  name: 'API Service',
  type: 'usage_based',
  prices: [{
    type: 'usage_based_price',
    currency: 'usd',
    billing_period: 'month',
    meters: [{
      meter_id: 'mtr_api_calls',
      price_per_unit: '0.001',
      free_threshold: 1000,
    }]
  }]
});
```

**Note:** Tiered, graduated, volume, and staircase pricing models are not currently documented in the Dodo Payments API. Use per-unit pricing with free thresholds for now.

---

## Instrumenting Your Application

### Track API Calls

Place the ingest call in a non-blocking context to avoid slowing down user requests:

```typescript
// Express middleware (non-blocking)
app.use(async (req, res, next) => {
  res.on('finish', async () => {
    // Fire-and-forget after response is sent
    client.usageEvents.ingest({
      events: [{
        event_id: `api_${Date.now()}_${crypto.randomUUID()}`,
        customer_id: req.user.id,
        event_name: 'api.call',
        timestamp: new Date().toISOString(),
        metadata: {
          endpoint: req.path,
          method: req.method,
          status: res.statusCode,
        }
      }]
    }).catch(err => console.error('Failed to ingest event:', err));
  });
  next();
});
```

### Track AI Token Usage

```typescript
async function callAI(customerId: string, prompt: string) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
  });

  // Track tokens after completion
  await client.usageEvents.ingest({
    events: [{
      event_id: `ai_${Date.now()}_${crypto.randomUUID()}`,
      customer_id: customerId,
      event_name: 'ai.tokens',
      timestamp: new Date().toISOString(),
      metadata: {
        tokens: response.usage.total_tokens.toString(),
        prompt_tokens: response.usage.prompt_tokens.toString(),
        completion_tokens: response.usage.completion_tokens.toString(),
        model: 'gpt-4',
      }
    }]
  });

  return response;
}
```

### Track Storage Usage

For snapshot-based metrics (current state), use the `last` aggregation:

```typescript
async function updateStorageUsage(customerId: string, bytesUsed: number) {
  await client.usageEvents.ingest({
    events: [{
      event_id: `storage_${Date.now()}_${customerId}`,
      customer_id: customerId,
      event_name: 'storage.snapshot',
      timestamp: new Date().toISOString(),
      metadata: {
        bytes: bytesUsed.toString(),
        gb: (bytesUsed / 1024 / 1024 / 1024).toFixed(2),
      }
    }]
  });
}

// Call periodically or after storage changes
await updateStorageUsage('cus_abc', 5368709120); // 5GB
```

---

## Querying Usage for Display

### Retrieve Usage History

```typescript
const usage = await client.subscriptions.retrieveUsageHistory(
  'sub_abc123',
  { limit: 100 }
);

console.log(usage.meters); // Array of meter usage records
```

This returns aggregated usage per meter for the subscription's current billing period.

---

## Credit-Based Billing Integration

Usage events can deduct from a customer's credit balance instead of charging per-unit. See the `credit-based-billing` skill for full details on credit entitlements, balances, and ledger management.

To link a meter to credits:

1. Create a credit entitlement (e.g., "AI Credits").
2. Attach the credit entitlement to the same product.
3. On the meter, enable **Bill usage in Credits**.
4. Set `credit_entitlement_id` and `meter_units_per_credit` (e.g., 1,000 tokens = 1 credit).

Usage under the free threshold is excluded. Approximately every minute, a background worker aggregates new usage, converts it using the meter-to-credit ratio, and consumes the oldest non-expired credit grants (FIFO). When credits run out, configured overage behavior applies.

---

## Webhook Integration

Usage events trigger webhooks for monitoring and reconciliation. See the `webhook-integration` skill for webhook setup and verification.

---

## Common Mistakes

### 1. Reusing Event IDs Across Distinct Events

Each event must have a unique ID. Reusing an ID causes the second event to be silently ignored.

```typescript
// WRONG
await client.usageEvents.ingest({
  events: [
    { event_id: 'evt_1', customer_id: 'cus_abc', event_name: 'api.call', ... },
    { event_id: 'evt_1', customer_id: 'cus_abc', event_name: 'api.call', ... }, // Ignored
  ]
});

// CORRECT
await client.usageEvents.ingest({
  events: [
    { event_id: `api_${Date.now()}_1`, customer_id: 'cus_abc', event_name: 'api.call', ... },
    { event_id: `api_${Date.now()}_2`, customer_id: 'cus_abc', event_name: 'api.call', ... },
  ]
});
```

### 2. Blocking User Requests on Event Ingestion

Ingest events asynchronously after the response is sent. Never wait for the ingest call to complete before returning to the user.

```typescript
// WRONG — blocks the user
app.post('/api/generate', async (req, res) => {
  const result = await generateAI(req.body);
  await client.usageEvents.ingest({ events: [...] }); // Blocks response
  res.json(result);
});

// CORRECT — fire-and-forget
app.post('/api/generate', async (req, res) => {
  const result = await generateAI(req.body);
  res.json(result);
  
  // Ingest after response is sent
  client.usageEvents.ingest({ events: [...] })
    .catch(err => console.error('Ingest failed:', err));
});
```

### 3. Clock Skew in Timestamps

Timestamps must be within one hour in the past or five minutes in the future. Ensure your server clock is synchronized.

```typescript
// WRONG — timestamp is 2 hours old
const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
await client.usageEvents.ingest({
  events: [{
    event_id: 'evt_123',
    customer_id: 'cus_abc',
    event_name: 'api.call',
    timestamp: oldTime, // Rejected
    metadata: {}
  }]
});

// CORRECT — use current time
await client.usageEvents.ingest({
  events: [{
    event_id: 'evt_123',
    customer_id: 'cus_abc',
    event_name: 'api.call',
    timestamp: new Date().toISOString(),
    metadata: {}
  }]
});
```

### 4. Ingesting on the Client Side

Never send events from client-side code. Always ingest from your backend to avoid exposing your API key.

```typescript
// WRONG — client-side
const trackUsage = async (eventName: string) => {
  await fetch('https://test.dodopayments.com/events/ingest', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`, // Exposed!
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ events: [...] })
  });
};

// CORRECT — backend route
app.post('/api/track-usage', async (req, res) => {
  const { customerId, eventName, metadata } = req.body;
  
  await client.usageEvents.ingest({
    events: [{
      event_id: `${eventName}_${Date.now()}_${crypto.randomUUID()}`,
      customer_id: customerId,
      event_name: eventName,
      timestamp: new Date().toISOString(),
      metadata,
    }]
  });
  
  res.json({ success: true });
});
```

### 5. Mismatched Event Names

Event names are case-sensitive and must match the meter's event name exactly.

```typescript
// WRONG — meter expects "api.call", event sends "API.CALL"
const meter = await client.meters.create({
  event_name: 'api.call',
  ...
});

await client.usageEvents.ingest({
  events: [{
    event_name: 'API.CALL', // Won't match
    ...
  }]
});

// CORRECT
await client.usageEvents.ingest({
  events: [{
    event_name: 'api.call', // Matches exactly
    ...
  }]
});
```

---

## Resources

- [Usage-Based Billing Guide](https://docs.dodopayments.com/features/usage-based-billing/introduction)
- [Meters Documentation](https://docs.dodopayments.com/features/usage-based-billing/meters)
- [Event Ingestion API](https://docs.dodopayments.com/api-reference/usage-events/ingest-events)
- [Create Meter API](https://docs.dodopayments.com/api-reference/meters/create-meter)
- [Usage-Based Billing Integration Guide](https://docs.dodopayments.com/developer-resources/usage-based-billing-guide)
- [Credit-Based Billing](https://docs.dodopayments.com/features/credit-based-billing)
- [Webhook Integration](https://docs.dodopayments.com/developer-resources/webhooks)
