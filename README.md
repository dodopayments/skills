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

```
/plugin marketplace add dodopayments/skills
```

Install a plugin:

```
/plugin install dodo-best-practices
/plugin install webhook-integration
/plugin install subscription-integration
```

### OpenCode

Skills are automatically available when configured in your OpenCode settings.

## Available Skills

| Skill | Description |
|-------|-------------|
| [dodo-best-practices](./dodo-payments/best-practices/) | Comprehensive guide to integrating Dodo Payments with best practices |
| [webhook-integration](./dodo-payments/webhook-integration/) | Setting up and handling webhooks for payment events |
| [subscription-integration](./dodo-payments/subscription-integration/) | Implementing subscription billing flows |
| [checkout-integration](./dodo-payments/checkout-integration/) | Creating checkout sessions and payment flows |
| [usage-based-billing](./dodo-payments/usage-based-billing/) | Implementing metered billing with events and meters |
| [billing-sdk](./dodo-payments/billing-sdk/) | Using BillingSDK React components |
| [license-keys](./dodo-payments/license-keys/) | Managing license keys for digital products |

## What are Skills?

Skills are reusable capabilities for AI agents. They provide procedural knowledge that helps agents accomplish specific tasks more effectively. Think of them as plugins that enhance what your AI agent can do when working with Dodo Payments.

## Resources

- [Dodo Payments Documentation](https://docs.dodopayments.com)
- [API Reference](https://docs.dodopayments.com/api-reference/introduction)
- [Discord Community](https://discord.gg/bYqAp4ayYh)
- [GitHub](https://github.com/dodopayments)

## License

MIT
