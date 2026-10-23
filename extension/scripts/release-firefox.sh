#!/usr/bin/env bash
# Publishes a new self-hosted Firefox release:
#   1. builds dist/firefox with gecko.update_url baked in (it must be in the
#      manifest *before* signing — a signed XPI can't be edited afterwards),
#   2. signs it on AMO as an unlisted (self-distributed) add-on,
#   3. uploads the signed .xpi to the backend, which then lists it in
#      /extension/updates.json so installed copies update themselves.
#
# Bump "version" in package.json first (Firefox only updates to a higher one).
#
# Settings are read from the repo-root .env (the one the backend uses, see
# .env.example); variables already set in the environment take precedence.
#   WEB_EXT_API_KEY, WEB_EXT_API_SECRET  AMO API credentials
#                                        (https://addons.mozilla.org/developers/addon/api/key/)
#   BACKEND_URL                          public https URL of the backend
#                                        (defaults to PUBLIC_URL)
#   RELEASE_TOKEN                        same value as the backend's RELEASE_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="../.env"
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}" value="${BASH_REMATCH[3]}"
    [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]] && value="${BASH_REMATCH[1]}"
    [[ -z "${!key:-}" ]] && export "$key=$value"
  done < "$ENV_FILE"
fi
BACKEND_URL="${BACKEND_URL:-${PUBLIC_URL:-}}"

: "${WEB_EXT_API_KEY:?missing (set it in .env)}" "${WEB_EXT_API_SECRET:?missing (set it in .env)}"
: "${BACKEND_URL:?missing (set BACKEND_URL or PUBLIC_URL in .env)}" "${RELEASE_TOKEN:?missing (set it in .env)}"
BACKEND_URL="${BACKEND_URL%/}"

VERSION="$(node -p "require('./package.json').version")"
echo "Releasing Firefox $VERSION"

FIREFOX_UPDATE_URL="$BACKEND_URL/extension/updates.json" node build.js
grep -q '"update_url"' dist/firefox/manifest.json || { echo "update_url missing from manifest" >&2; exit 1; }

ARTIFACTS="web-ext-artifacts/$VERSION"
rm -rf "$ARTIFACTS"
npx web-ext sign --channel unlisted -s dist/firefox -a "$ARTIFACTS"

XPI="$(ls -t "$ARTIFACTS"/*.xpi | head -n1)"
echo "Signed -> $XPI"

curl --fail-with-body -sS -X PUT \
  -H "Authorization: Bearer $RELEASE_TOKEN" \
  -H "Content-Type: application/x-xpinstall" \
  --data-binary "@$XPI" \
  "$BACKEND_URL/extension/releases/$VERSION"
echo
echo "Published. Installed copies will pick it up on Firefox's next update check"
echo "(about:addons > gear > Check for Updates to force it)."
