#!/bin/bash
# Quick SignalR negotiate test with HMAC auth
# Usage: ./test-negotiate.sh [dev|prod]

ENV="${1:-dev}"

# Vibe HMAC creds removed from source — export before running:
#   VIBE_CLIENT_ID + VIBE_HMAC_KEY (current env)
#   VIBE_CLIENT_ID_PROD + VIBE_HMAC_KEY_PROD (overrides for prod)
if [ "$ENV" = "prod" ]; then
    API_URL="https://api.idealvibe.online"
    CLIENT_ID="${VIBE_CLIENT_ID_PROD:-${VIBE_CLIENT_ID:-}}"
    HMAC_KEY="${VIBE_HMAC_KEY_PROD:-${VIBE_HMAC_KEY:-}}"
else
    API_URL="http://127.0.0.1:32786"
    CLIENT_ID="${VIBE_CLIENT_ID:-}"
    HMAC_KEY="${VIBE_HMAC_KEY:-}"
fi

if [ -z "$CLIENT_ID" ] || [ -z "$HMAC_KEY" ]; then
    echo "ERROR: VIBE_CLIENT_ID and VIBE_HMAC_KEY must be set in the environment."
    exit 1
fi

# Generate timestamp
TIMESTAMP=$(date +%s)
METHOD="GET"
PATH="/hubs/agentmail/negotiate"

# Generate HMAC signature
# Format: timestamp|METHOD|path
STRING_TO_SIGN="${TIMESTAMP}|${METHOD}|${PATH}"
SIGNATURE=$(echo -n "$STRING_TO_SIGN" | openssl dgst -sha256 -hmac "$(echo -n "$HMAC_KEY" | base64 -d | xxd -p -c 256 | tr -d '\n' | xxd -r -p)" -binary | base64)

echo "═══════════════════════════════════════════════════════════════"
echo "  SignalR Negotiate Test"
echo "  Environment: $ENV"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Client ID:  $CLIENT_ID"
echo "Timestamp:  $TIMESTAMP"
echo "String:     $STRING_TO_SIGN"
echo "Signature:  ${SIGNATURE:0:50}..."
echo ""
echo "Requesting: ${API_URL}${PATH}"
echo ""

# Make request
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
    -H "X-Vibe-Client-Id: $CLIENT_ID" \
    -H "X-Vibe-Timestamp: $TIMESTAMP" \
    -H "X-Vibe-Signature: $SIGNATURE" \
    "${API_URL}${PATH}" 2>/dev/null)

BODY=$(echo "$RESPONSE" | sed '$d')
CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)

echo "Response Code: $CODE"
echo "Response Body:"
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
echo ""

if [ "$CODE" = "200" ]; then
    echo "✅ SUCCESS! SignalR negotiate endpoint is working"
elif [ "$CODE" = "401" ]; then
    echo "❌ UNAUTHORIZED - Check HMAC signature format"
elif [ "$CODE" = "500" ]; then
    echo "❌ SERVER ERROR - Backend issue"
else
    echo "⚠️  Unexpected response"
fi
