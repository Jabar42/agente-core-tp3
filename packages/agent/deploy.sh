#!/bin/bash
set -e

CLIENT="${1:-all}"

if [ "$CLIENT" = "all" ]; then
  for config in wrangler-*.jsonc; do
    echo "Desplegando $config..."
    npx wrangler deploy -c "$config"
  done
else
  echo "Desplegando cliente: $CLIENT"
  npx wrangler deploy -c "wrangler-${CLIENT}.jsonc"
fi
