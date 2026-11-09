# Dodo Payments Skill

The official AI agent skill from Dodo Payments. One skill, `dodo-payments`, helps agents integrate payments, subscriptions, webhooks, usage and credit billing, license keys, and more.

## Installation

### Skills CLI (any agent)

```bash
npx skills add dodopayments/skills
```

### Claude Code

```text
/plugin marketplace add dodopayments/skills
/plugin install dodo-payments
```

### Dodo Payments agent plugin

The [Dodo Payments agent plugin](https://github.com/dodopayments/dodo-agent-plugin) ships this skill together with the `dodopayments` MCP server (`https://mcp.dodopayments.com/mcp`).

## The skill

| Skill | Description |
|-------|-------------|
| [dodo-payments](./dodo-payments/dodo-payments/) | Index (`SKILL.md`) with the standard checkout-to-webhook path, client setup, safety rules, MCP usage, and a routing table to one reference file per topic |

[`SKILL.md`](./dodo-payments/dodo-payments/SKILL.md) is the only file an agent loads up front. It links each topic file in [`references/`](./dodo-payments/dodo-payments/references/), which the agent reads only when the task needs it:

| Reference | Covers |
|---|---|
| `checkout.md` | Checkout sessions, overlay and inline checkout, static payment links, return URL |
| `mobile-checkout.md` | React Native, Flutter, iOS and Android checkout |
| `subscriptions.md` | Trials, statuses, plan changes and proration, pause and cancel, recovery, on-demand charges |
| `webhooks.md` | Endpoint setup, signature verification, idempotent processing, every webhook type |
| `usage-billing.md` | Meters, usage events, per-unit pricing |
| `credits.md` | Credit entitlements, balances, ledger, rollover, overage |
| `license-keys.md` | Activation, validation, CLI and desktop apps, revocation |
| `products.md` | Products, add-ons, collections, images, digital files |
| `discounts.md` | Discount codes, eligibility, stacking, plan changes |
| `localized-pricing.md` | Adaptive Currency, localized prices, purchasing power parity |
| `customers.md` | Customers, customer portal, payment methods, wallets |
| `refunds-disputes.md` | Refunds, disputes, access |
| `framework-adapters.md` | `@dodopayments/*` adapters for Next.js, Express, Hono, Fastify, Astro, Remix, SvelteKit, Nuxt, TanStack, Bun, Convex |
| `better-auth.md` | The `@dodopayments/better-auth` plugin |
| `billing-sdk.md` | BillingSDK React components |
| `testing-go-live.md` | Test cards, Dodo CLI, local webhooks, go-live checklist |
| `mcp.md` | The `dodopayments` MCP server |

The 18 separate skills of version 2 (`dodo-best-practices`, `checkout-integration`, `webhook-integration` and the rest) are merged into this one skill. Reinstall with the commands above.

## What are Skills?

Skills are reusable capabilities for AI agents. They provide procedural knowledge that helps agents accomplish specific tasks more effectively. Think of them as plugins that enhance what your AI agent can do when working with Dodo Payments.

## Contributing

The skill is pasted verbatim into an agent's context and reproduced as-is, so a wrong field name propagates
exactly as reliably as correct code — and usually fails *silently* rather than loudly. Four checks run in CI
and should be run locally before opening a PR:

```bash
npm install
npm run check      # validate + typecheck (TypeScript, Go, Python)
```

**`npm run validate`** enforces structural rules: real API hostnames, correct `dodo_test_`/`dodo_live_` key
formats, no hand-rolled webhook HMAC, no deprecated SDK calls, no type suppression, and agreement between
the skill's directory name, its frontmatter, `marketplace.json`, and the README table. It follows Anthropic's
skill authoring guidelines: `SKILL.md` stays at or under 150 lines and its description at or under 1,024
characters; `references/` is one level deep, every reference file is linked from `SKILL.md`, every link
resolves, reference files carry no frontmatter, and a reference file over 100 lines starts with a
`## Contents` list. It also rejects the removed MCP server names and CLI sign-in text that asks for a pasted
API key.

**`npm run typecheck`** extracts every TypeScript block from every `SKILL.md` and `references/*.md` file and compiles it against the
real `dodopayments` types — plus the `@dodopayments/*` framework adapters, so adapter examples are checked
rather than degrading to `any`. This is what catches wrong field and parameter names.

**`npm run typecheck:go`** and **`npm run typecheck:python`** do the same for Go and Python examples, using
`go build` against `dodopayments-go` and pyright against the real Python SDK. The Python check creates a
virtualenv on first run and reuses it afterwards.

Blocks that are deliberate counter-examples are skipped, but only when *explicitly* labelled — a bolded
`**Wrong:**`-style marker, or an `<!-- typecheck: skip -->` comment. Inferring "this is meant to be broken"
from surrounding prose silently removed coverage from correct blocks, so opting out is now deliberate and
greppable.

When you add or change an example, prefer fixing the field name over casting to `any` — the point of the
check is that the published example actually compiles.

## Resources

- [Dodo Payments Documentation](https://docs.dodopayments.com)
- [API Reference](https://docs.dodopayments.com/api-reference/introduction)
- [Discord Community](https://discord.gg/bYqAp4ayYh)
- [GitHub](https://github.com/dodopayments)

## License

MIT
