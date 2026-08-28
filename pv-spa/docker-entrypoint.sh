#!/bin/sh
set -e

echo "Starting HBVU PHOTOS Frontend..."
echo "Injecting runtime environment variables..."

# Create env-config.js map from environment variables
cat <<EOF > /usr/share/nginx/html/env-config.js
window.__ENV__ = {
  API_URL: "${API_URL}",
  TURNSTILE_SITE_KEY: "${TURNSTILE_SITE_KEY}"
};
EOF

echo "Starting Nginx..."
exec nginx -g "daemon off;"
