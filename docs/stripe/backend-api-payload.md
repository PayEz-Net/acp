# Backend: Upsert Merchant Credentials via Encryption API

**Endpoint:** `PUT https://encryption.payez.net/api/MerchantCredential/{clientId}`

**Auth:** `ContainerAuthorize` header (container auth token)

**What it does:** Encrypts secrets server-side via `AESGCM_Encryption.EncryptGeneral` and stores in `encryption.payez_merchant_credentials`.

---

## Payload for IdealResume (clientId = 8)

```json
{
  "gatewayType": "stripe",
  "publishableKey": "pk_live_REPLACE_WITH_PUBLISHABLE_KEY",
  "secretKey": "sk_live_REPLACE_WITH_SECRET_KEY",
  "webhookSecret": "whsec_REPLACE_WITH_WEBHOOK_SECRET",
  "accountId": "acct_REPLACE_WITH_STRIPE_ACCOUNT_ID",
  "userId": "your-admin-user-id"
}
```

## Verification

```bash
# Check if credentials exist (masked)
curl -s https://encryption.payez.net/api/MerchantCredential/8 \
  -H "Authorization: Bearer <container_token>"

# Resolve decrypted credentials
curl -s https://encryption.payez.net/api/MerchantCredential/8/resolve?gatewayType=stripe \
  -H "Authorization: Bearer <container_token>"
```

## Fields

| Field | Source | Example |
|---|---|---|
| `publishableKey` | Stripe Dashboard → API keys | `pk_live_51SUtxa...` |
| `secretKey` | Stripe Dashboard → API keys (restricted) | `sk_live_...` |
| `webhookSecret` | Stripe Dashboard → Webhooks → Signing secret | `whsec_...` |
| `accountId` | Stripe Dashboard → Settings → Account details | `acct_1SUtxa...` |
| `userId` | Your admin user ID in the system | `101` or `system` |

## After Upsert

The `StripeCredentialResolver` in `PayEz.Vibe.Public.Api` will automatically pick up the live credentials on the next request.
