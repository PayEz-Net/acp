#!/bin/bash
# Quick SignalR negotiate test with HMAC auth
# Usage: ./test-negotiate.sh [dev|prod]

ENV="${1:-dev}"

if [ "$ENV" = "prod" ]; then
    API_URL="https://api.idealvibe.online"
    CLIENT_ID="vibe_b2d2aac0315549d9"
    HMAC_KEY="KAG7vjumrWhx4CHtPSNcowYzjkbeVZmSitD8xjdZXkw="
else
    API_URL="http://10.0.0.93:32786"
    CLIENT_ID="vibe_2577f53820d8436d"
    HMAC_KEY="fTgHIwYUWBAjh03SDhS6VK25ddHJ1v2ZIFyikG4LI0w="
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
