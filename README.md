# Dodo Payments Skills

Official AI agent skills from Dodo Payments for integrating payments, subscriptions, billing, and more into your applications.

## Installation

### Skills CLI (Any Agent)

Install skills using the skills CLI:

```bash
npx skills add dodopayments/skills
```

Or install individual skills:

```bash
npx skills add dodopayments/skills/dodo-best-practices
npx skills add dodopayments/skills/webhook-integration
npx skills add dodopayments/skills/subscription-integration
```

### Claude Code

Add the marketplace:

```text
/plugin marketplace add dodopayments/skills
```

Install a plugin:

```text
/plugin install dodo-best-practices
/plugin install webhook-integration
/plugin install subscription-integration
```

### OpenCode

Skills are automatically available when configured in your OpenCode settings.

## Available Skills

### Getting started

| Skill | Description |
|-------|-------------|
| [dodo-best-practices](./dodo-payments/best-practices/) | Orientation guide: SDKs, environments, auth, core concepts, and the canonical integration path |
| [framework-adapters](./dodo-payments/framework-adapters/) | Official adapter packages for Next.js, Express, Hono, Astro, Remix, SvelteKit, Nuxt, Fastify, TanStack, Bun, and Convex |
| [testing-and-go-live](./dodo-payments/testing-and-go-live/) | Test mode, test payment methods, webhook testing, and the production launch checklist |

### Accepting payments

| Skill | Description |
|-------|-------------|
| [checkout-integration](./dodo-payments/checkout-integration/) | Creating checkout sessions, payment links, and overlay checkout |
| [subscription-integration](./dodo-payments/subscription-integration/) | Subscription lifecycle, trials, plan changes, proration, and on-demand charging |
| [mobile-checkout](./dodo-payments/mobile-checkout/) | In-app checkout for React Native, Flutter, iOS, and Android |
| [webhook-integration](./dodo-payments/webhook-integration/) | Receiving and verifying webhooks with the Standard Webhooks specification |

### Billing models

| Skill | Description |
|-------|-------------|
| [credit-based-billing](./dodo-payments/credit-based-billing/) | Credit entitlements, balances, ledger, rollover, overage, and meter-based deduction |
| [usage-based-billing](./dodo-payments/usage-based-billing/) | Metered billing with meters, event ingestion, and per-unit pricing |
| [license-keys](./dodo-payments/license-keys/) | License key activation, validation, and instance management |

### Catalog and pricing

| Skill | Description |
|-------|-------------|
| [product-catalog-management](./dodo-payments/product-catalog-management/) | Products, pricing, add-ons, collections, images, and digital product delivery |
| [discounts-and-promotions](./dodo-payments/discounts-and-promotions/) | Discount codes, eligibility rules, stacking, and subscription-cycle limits |
| [localized-pricing](./dodo-payments/localized-pricing/) | Localized pricing, adaptive currency, and purchasing power parity |

### Customers and operations

| Skill | Description |
|-------|-------------|
| [customer-management](./dodo-payments/customer-management/) | Customers, the self-service portal, payment methods, and wallets |
| [refunds-and-disputes](./dodo-payments/refunds-and-disputes/) | Issuing refunds, handling disputes and chargebacks, reconciling access |

### UI and integrations

| Skill | Description |
|-------|-------------|
| [billing-sdk](./dodo-payments/billing-sdk/) | BillingSDK React components for pricing tables and billing UI |
| [better-auth-integration](./dodo-payments/better-auth-integration/) | The `@dodopayments/better-auth` plugin for customer sync, checkout, and portal |

## What are Skills?

Skills are reusable capabilities for AI agents. They provide procedural knowledge that helps agents accomplish specific tasks more effectively. Think of them as plugins that enhance what your AI agent can do when working with Dodo Payments.

## Contributing

Skills are pasted verbatim into an agent's context and reproduced as-is, so a wrong field name propagates
exactly as reliably as correct code — and usually fails *silently* rather than loudly. Two checks run in CI
and should be run locally before opening a PR:

```bash
npm install
npm run check      # validate + typecheck
```

**`npm run validate`** enforces structural rules: real API hostnames, correct `dodo_test_`/`dodo_live_` key
formats, no hand-rolled webhook HMAC, no deprecated SDK calls, no type suppression, and agreement between
each skill's directory name, its frontmatter, `marketplace.json`, and the README table.

**`npm run typecheck`** extracts every TypeScript block from every `SKILL.md` and compiles it against the
real `dodopayments` types. This is what catches wrong field and parameter names. Blocks introduced as
deliberate counter-examples (`Wrong:`, `Incorrect:`) are skipped, since they are supposed to be wrong.

When you add or change an example, prefer fixing the field name over casting to `any` — the point of the
check is that the published example actually compiles.

## Resources

- [Dodo Payments Documentation](https://docs.dodopayments.com)
- [API Reference](https://docs.dodopayments.com/api-reference/introduction)
- [Discord Community](https://discord.gg/bYqAp4ayYh)
- [GitHub](https://github.com/dodopayments)

## License

MIT
