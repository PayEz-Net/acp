# Stripe Configuration Reference

**Applies to:** IdealResume production and beta environments.

---

## AKS ConfigMap — `idealresume-config`

Namespace: `external-services`

| Key | Current Value | Type |
|---|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_51SUtxaLZTjUNa0XI...` | **Build-time** |
| `STRIPE_PRICE_PREMIUM` | `price_1ScMiKANFKV4tLacE1XStJSA` | Runtime |
| `STRIPE_PRICE_PREMIUM_ANNUAL` | `price_1ScMiKANFKV4tLacCuBbUuyH` | Runtime |
| `STRIPE_PRICE_ULTIMATE` | `price_1ScMnqANFKV4tLacxwa8MeLd` | Runtime |
| `STRIPE_PRICE_ULTIMATE_ANNUAL` | `price_1ScMnqANFKV4tLac3E7sCRH1` | Runtime |

> **Build-time warning:** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is inlined by Next.js at `docker build` time. Changing it in the ConfigMap without a rebuild has no effect.

---

## AKS Secrets — `idealresume-secrets`

Namespace: `external-services`

| Key | Current Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_your_stripe_secret_key_here` | **PLACEHOLDER** — replace with real key |
| `STRIPE_WEBHOOK_SECRET` | `whsec_your_webhook_secret_here` | **PLACEHOLDER** — replace with real secret |

---

## Beta ConfigMap — `idealresume-beta-config`

Same keys as production, different price IDs. No publishable key defined (beta uses `PAYEZ_CLIENT_ID` mode).

---

## Tier-to-Price Mapping

| Tier | Credits/Month | ConfigMap Key |
|---|---|---|
| Premium Monthly | 30 | `STRIPE_PRICE_PREMIUM` |
| Premium Annual | 30 | `STRIPE_PRICE_PREMIUM_ANNUAL` |
| Ultimate Monthly | 100 | `STRIPE_PRICE_ULTIMATE` |
| Ultimate Annual | 100 | `STRIPE_PRICE_ULTIMATE_ANNUAL` |
| Enterprise Monthly | 500 | **PLACEHOLDER** — needs real price ID |

---

## PayEz.Stripe.Api Settings

```json
{
  "Stripe": {
    "BaseUrl": "https://api.stripe.com/v1/",
    "ApiKeySecretName": "StripeApiKey",
    "WebhookSecretName": "StripeWebhookSecret"
  }
}
```

---

## Multi-Tenant Credentials

Per-client Stripe keys stored in `encryption.payez_merchant_credentials`:

| Column | Purpose |
|---|---|
| `IDPClientId` | Maps to Vibe client |
| `GatewayType` | `"stripe"` |
| `EncryptedSecretKey` | AES-256-GCM encrypted Stripe secret |
| `EncryptedWebhookSecret` | AES-256-GCM encrypted webhook secret |
| `PublishableKey` | Client-side safe publishable key |
| `AccountId` | Stripe account ID |

Decryption key: `MerchantCredentials:EncryptionKey` in appsettings.

---

## Known Placeholders

1. `STRIPE_PRICE_ENTERPRISE` — no real price ID exists yet.
2. `STRIPE_SECRET_KEY` in secrets YAML — placeholder.
3. `STRIPE_WEBHOOK_SECRET` in secrets YAML — placeholder.
4. `idealresume-beta-config` has Stripe price IDs but no publishable key.

---

*Last updated: 2026-04-28*
