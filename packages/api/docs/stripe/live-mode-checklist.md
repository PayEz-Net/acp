# Stripe Live Mode Checklist

**Switching IdealResume from Stripe test/sandbox to production.**

> **Account:** Current sandbox is `acct_1SUtxaLZTjUNa0XI`. You need a **live Stripe account** (activate existing or create new).

---

## Step 1 — Stripe Dashboard Setup

- [ ] Activate live mode on Stripe account (or create new live account)
- [ ] Create live **Products** for each plan:
  - Premium Monthly
  - Premium Annual
  - Ultimate Monthly
  - Ultimate Annual
  - Enterprise Monthly
- [ ] Copy live **Price IDs** from Stripe Dashboard

---

## Step 2 — Update AKS Secrets

File: `PayEz-Core/AKS/secrets/idealresume-secrets.yaml`

```yaml
STRIPE_SECRET_KEY: "sk_live_..."        # Live secret key
STRIPE_WEBHOOK_SECRET: "whsec_..."      # Live webhook signing secret
```

Apply:
```bash
kubectl apply -f PayEz-Core/AKS/secrets/idealresume-secrets.yaml
```

---

## Step 3 — Update AKS ConfigMap

File: `PayEz-Core/AKS/configmaps/idealresume-config.yaml`

```yaml
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_..."   # Live publishable key
STRIPE_PRICE_PREMIUM: "price_live_..."
STRIPE_PRICE_PREMIUM_ANNUAL: "price_live_..."
STRIPE_PRICE_ULTIMATE: "price_live_..."
STRIPE_PRICE_ULTIMATE_ANNUAL: "price_live_..."
```

Apply:
```bash
kubectl apply -f PayEz-Core/AKS/configmaps/idealresume-config.yaml
```

---

## Step 4 — Build-Time Fix (Critical)

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is inlined by Next.js at **build time**. The current Dockerfile and `azure-pipelines.yml` do **not** pass it as a build arg.

### Option A — Add build arg to pipeline (recommended)

Update `idealvibe.online/azure-pipelines.yml`:
```bash
docker build \
  --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$(STRIPE_PUBLISHABLE_KEY) \
  ...
```

Update `idealvibe.online/Dockerfile`:
```dockerfile
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

Add pipeline variable `STRIPE_PUBLISHABLE_KEY` in Azure DevOps.

### Option B — Update `.env.production`

Change `idealvibe.online/.env.production`:
```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

Commit, push, and let pipeline rebuild. **Less secure** — live key in git.

---

## Step 5 — Live Webhook Endpoint

In Stripe Dashboard:
- [ ] Create webhook endpoint: `https://idealresume.online/api/stripe/webhook`
- [ ] Subscribe to events:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `charge.refunded`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `invoice.payment_succeeded`
- [ ] Copy signing secret to `STRIPE_WEBHOOK_SECRET`

---

## Step 6 — Deploy

```bash
# If only ConfigMap/Secret changed (no rebuild needed for runtime vars)
kubectl rollout restart deployment/idealresume -n external-services

# If build-time publishable key changed (requires full pipeline run)
# Trigger Azure DevOps pipeline or push to main
```

---

## Step 7 — Post-Deploy Validation

- [ ] Run [testing-checklist.md](./testing-checklist.md) with a real card
- [ ] Verify webhook events process correctly
- [ ] Check `/admin/billing-issues` for any failures
- [ ] Confirm credits allocate correctly for each tier

---

## Rollback Plan

If issues detected:
1. Revert `idealresume-secrets.yaml` to test keys
2. Revert `idealresume-config.yaml` to test price IDs
3. Rebuild with test publishable key (if build-time was changed)
4. `kubectl rollout restart deployment/idealresume -n external-services`

---

*Last updated: 2026-04-28*
