#!/bin/bash
# Setup GMGN credentials
# Usage: bash setup_gmgn.sh YOUR_API_KEY

API_KEY="${1:?Usage: bash setup_gmgn.sh YOUR_API_KEY}"
ENV_FILE="$HOME/.config/gmgn/.env"
PRIV_FILE="$HOME/.config/gmgn/gmgn_private.pem"

if [ ! -f "$PRIV_FILE" ]; then
  echo "ERROR: Private key not found at $PRIV_FILE"
  exit 1
fi

PRIV_KEY=$(cat "$PRIV_FILE")

cat > "$ENV_FILE" << EOF
GMGN_API_KEY=${API_KEY}
GMGN_PRIVATE_KEY="${PRIV_KEY}"
EOF

chmod 600 "$ENV_FILE"
echo "GMGN credentials saved to $ENV_FILE"
echo "API key: ${API_KEY:0:8}...${API_KEY: -4}"
echo "Private key: $(wc -c < "$PRIV_FILE" | tr -d ' ') bytes"
