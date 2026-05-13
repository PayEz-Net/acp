# Stripe Testing Checklist

**Run this before any production release.**

---

## Pre-Test Setup

- [ ] Stripe **test** API key configured (`sk_test_...`)
- [ ] Stripe webhook secret configured (`whsec_...`)
- [ ] Stripe CLI installed for local webhook forwarding: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
- [ ] Test products/prices created in Stripe dashboard (or use existing test price IDs)
- [ ] Database migrations applied (`tier_configurations`, `stripe_webhook_events`)
- [ ] `STRIPE_PRICE_ENTERPRISE` has a real price ID (not placeholder)

---

## Checkout Flow

- [ ] Unauthenticated user redirected to login before checkout
- [ ] Premium monthly checkout creates session and redirects to Stripe
- [ ] Premium annual checkout works
- [ ] Ultimate monthly checkout works
- [ ] Ultimate annual checkout works
- [ ] Success redirect lands on `/payment/success`
- [ ] Cancel redirect returns to `/pricing`
- [ ] Stripe test card `4242424242424242` processes successfully

---

## Webhook Processing

- [ ] `checkout.session.completed` → credits allocated correctly
- [ ] `customer.subscription.created` → tier updated
- [ ] `customer.subscription.updated` → tier changes reflected
- [ ] `customer.subscription.deleted` → user reverts to free tier
- [ ] `payment_intent.succeeded` → logged
- [ ] `payment_intent.payment_failed` → logged, visible in `/admin/billing-issues`
- [ ] Duplicate webhook events are idempotent (same `event_id` ignored)
- [ ] Invalid webhook signature returns 400

---

## Credit Allocation

- [ ] Premium: 30 credits added
- [ ] Ultimate: 100 credits added
- [ ] Enterprise: 500 credits added
- [ ] Credits persist across sessions
- [ ] Credits do not double-allocate on duplicate webhooks

---

## Tier Management

- [ ] Free → Premium upgrade works
- [ ] Premium → Ultimate upgrade works
- [ ] Subscription cancellation → Free downgrade works
- [ ] Tier claims cached and invalidated correctly
- [ ] User sees correct tier in profile/dashboard

---

## Multi-Tenant (Vibe Public API)

- [ ] `StripeCredentialResolver` decrypts per-client keys
- [ ] Checkout session created with correct client's Stripe account
- [ ] Portal session opens correct client's billing portal
- [ ] Subscription cancellation scoped to correct client
- [ ] Billing status returns correct subscription state

---

## Edge Cases

- [ ] Expired card handling (`payment_intent.payment_failed`)
- [ ] User with no Stripe customer ID attempts checkout
- [ ] Webhook received before checkout session completed
- [ ] Multiple rapid webhook deliveries (idempotency)
- [ ] Stripe API timeout during checkout session creation

---

*Last updated: 2026-04-28*
