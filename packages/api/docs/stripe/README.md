# Stripe Integration — Agent Reference

**Scope:** IdealResume / IdealVibe checkout, billing, and subscription flow.  
**Backend:** PayEz-Core Stripe services + AKS.  
**Frontend:** idealvibe.online Next.js checkout components.

---

## Quick Links

| Doc | Purpose |
|---|---|
| [configuration.md](./configuration.md) | Keys, price IDs, AKS configmaps/secrets |
| [testing-checklist.md](./testing-checklist.md) | Pre-release validation steps |
| [live-mode-checklist.md](./live-mode-checklist.md) | Switching from test to production |
| [backend-api-payload.md](./backend-api-payload.md) | Encryption API payload for merchant credentials |

---

## Where to Add the Prod Key — Complete Map

### Frontend (IdealResume Next.js on AKS)

| Secret | Where | File |
|---|---|---|
| **Secret key** | K8s Secret (runtime) | `PayEz-Core/AKS/secrets/idealresume-secrets.yaml` → `STRIPE_SECRET_KEY` |
| **Webhook secret** | K8s Secret (runtime) | `PayEz-Core/AKS/secrets/idealresume-secrets.yaml` → `STRIPE_WEBHOOK_SECRET` |
| **Publishable key** | K8s ConfigMap + Docker build arg | `PayEz-Core/AKS/configmaps/idealresume-config.yaml` → `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |
| **Price IDs** | K8s ConfigMap (runtime) | `PayEz-Core/AKS/configmaps/idealresume-config.yaml` → `STRIPE_PRICE_*` |

> ⚠️ `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is inlined at Docker build time by Next.js. The ConfigMap value is for server-side code only. You must also pass it as `--build-arg` in the Dockerfile/pipeline for the browser bundle.

### Backend (Vibe API — Encryption layer)

| What | Where | How |
|---|---|---|
| **All Stripe credentials** | Encryption API | `PUT api/MerchantCredential/{clientId}` — server-side encrypts via `AESGCM_Encryption.EncryptGeneral` |
| **IdealResume clientId** | `8` | `ideal_resume_website` maps to `idp_client_id = 8` |

The backend does **not** use K8s env vars for Stripe. It calls the Encryption API per-client.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  idealvibe.online │────▶│  PayEz.Stripe.Api │────▶│  Stripe.com    │
│  (Next.js checkout)│     │  (AKS, .NET)      │     │  (live/test)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│  AKS ConfigMap   │     │  VibeSQL         │
│  (price IDs)     │     │  (tier config)   │
└─────────────────┘     └──────────────────┘
```

---

## Environments

| Env | Stripe Mode | Account | K8s Namespace |
|---|---|---|---|
| Production | Live | `acct_1SUtxaLZTjUNa0XI` (activate for live) | `external-services` |
| Beta | Test | Same sandbox | `external-services` |

---

## Key Files in Repo

- `PayEz-Core/AKS/configmaps/idealresume-config.yaml` — publishable key + price IDs
- `PayEz-Core/AKS/configmaps/idealresume-beta-config.yaml` — beta price IDs
- `PayEz-Core/AKS/secrets/idealresume-secrets.yaml` — secret key + webhook secret
- `idealvibe.online/azure-pipelines.yml` — build pipeline (needs build-arg for `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`)
- `idealvibe.online/Dockerfile` — container build
- `idealvibe.online/app/checkout/components/CreditCardForm.tsx` — Stripe Elements loader

---

## Current Status

- **Test mode:** Active. All price IDs are test IDs.
- **Live mode:** Not yet activated. Placeholder values in secrets YAML.
- **Build-time issue:** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not passed as Docker build-arg. Next.js inlines it at build time — runtime ConfigMap changes do not affect it without a rebuild.

---

*Last updated: 2026-04-28*
