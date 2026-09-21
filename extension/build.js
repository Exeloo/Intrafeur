// Bundles the TypeScript sources with esbuild into extension/dist/{chrome,firefox}
// (one bundled JS file per entry point — background, the content script, and
// options — each with webextension-polyfill inlined), copies static assets
// (CSS/HTML/icons) alongside them, and adds the browser-specific manifest.json.
// Also packages dist/firefox into dist/intrafeur-toolbox.xpi for browsers whose
// "Install Add-on From File" flow wants a packaged file rather than a folder.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const ENTRY_POINTS = [
  { in: 'src/background.ts', out: 'background.js' },
  { in: 'src/content/attendance.ts', out: 'content/attendance.js' },
  { in: 'src/options/options.ts', out: 'options/options.js' },
];

const STATIC_FILES = ['src/content/attendance.css', 'src/options/options.html', 'src/options/options.css'];

function copyFile(relSrc, outDir) {
  const src = path.join(ROOT, relSrc);
  const dest = path.join(outDir, path.relative('src', relSrc));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function buildTarget(browserName, manifestFile) {
  const outDir = path.join(DIST, browserName);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: ENTRY_POINTS.map((e) => path.join(ROOT, e.in)),
    outbase: path.join(ROOT, 'src'),
    outdir: outDir,
    bundle: true,
    format: 'iife',
    target: 'es2020',
    sourcemap: false,
    logLevel: 'info',
  });

  for (const rel of STATIC_FILES) copyFile(rel, outDir);
  copyRecursive(path.join(ROOT, 'icons'), path.join(outDir, 'icons'));
  fs.copyFileSync(path.join(ROOT, manifestFile), path.join(outDir, 'manifest.json'));

  console.log(`Built ${browserName} -> ${path.relative(ROOT, outDir)}`);
}

function packageXpi(sourceDir, outFile) {
  const script = `
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            zf.write(full, os.path.relpath(full, src))
`;
  execFileSync('python3', ['-c', script, sourceDir, outFile]);
  console.log(`Packaged -> ${path.relative(ROOT, outFile)}`);
}

async function main() {
  await buildTarget('chrome', 'manifest.chrome.json');
  await buildTarget('firefox', 'manifest.firefox.json');
  packageXpi(path.join(DIST, 'firefox'), path.join(DIST, 'intrafeur-toolbox.xpi'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
