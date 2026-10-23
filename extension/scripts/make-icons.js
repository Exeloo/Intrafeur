// Renders icons/icon.svg (the source of truth) to the PNG sizes the manifests
// reference. Needs `rsvg-convert` (librsvg); the PNGs are committed, so this
// only has to run after editing the SVG.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const iconsDir = path.join(__dirname, '..', 'icons');
const svg = path.join(iconsDir, 'icon.svg');

for (const size of [16, 32, 48, 128]) {
  const out = path.join(iconsDir, `icon${size}.png`);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out]);
  console.log(`wrote icons/icon${size}.png`);
}
