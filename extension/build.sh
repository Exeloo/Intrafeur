#!/usr/bin/env bash
# Builds the extension (node build.js) then packages the store-ready files:
# dist/intrafeur-toolbox-chrome.zip (dist/chrome, zipped for the Chrome Web
# Store) and dist/intrafeur-toolbox-firefox.xpi (renamed from the .xpi that
# build.js already produces from dist/firefox for AMO).
set -euo pipefail
cd "$(dirname "$0")"

node build.js

DIST="dist"
CHROME_ZIP="$DIST/intrafeur-toolbox-chrome.zip"
FIREFOX_XPI="$DIST/intrafeur-toolbox-firefox.xpi"

rm -f "$CHROME_ZIP"
python3 -c "
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            zf.write(full, os.path.relpath(full, src))
" "$DIST/chrome" "$CHROME_ZIP"

mv -f "$DIST/intrafeur-toolbox.xpi" "$FIREFOX_XPI"

echo "Chrome package  -> $CHROME_ZIP"
echo "Firefox package -> $FIREFOX_XPI"
