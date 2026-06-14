#!/bin/bash
set -e
CLIENT="${1:-all}"
if [ "$CLIENT" = "all" ]; then
  for config in wrangler-*.jsonc; do
    echo "Deploying $config..."
    npx wrangler deploy -c "$config"
  done
else
  echo "Deploying client: $CLIENT"
  npx wrangler deploy -c "wrangler-${CLIENT}.jsonc"
fi
