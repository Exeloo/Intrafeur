// Bundles the TypeScript sources with esbuild into extension/dist/{chrome,firefox}
// (one bundled JS file per entry point — background, the content script, and
// options — each with webextension-polyfill inlined), copies static assets
// (CSS/HTML/icons) alongside them, and adds the browser-specific manifest.json.
// Also packages dist/firefox into dist/intrafeur.xpi for browsers whose
// "Install Add-on From File" flow wants a packaged file rather than a folder.
//
// The manifests' "version" is overwritten with package.json's, so bumping
// package.json is the only step needed for a release. If FIREFOX_UPDATE_URL is
// set, it becomes the Firefox manifest's gecko.update_url (self-hosted
// updates, see scripts/release-firefox.sh); Chrome never gets one.
//
// `node build.js --watch` rebuilds dist/ on every change (no .xpi) for use with
// `npm run dev:firefox` / `npm run dev:chrome`, which reload the extension.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');
const VERSION = require('./package.json').version;
const FIREFOX_UPDATE_URL = (process.env.FIREFOX_UPDATE_URL || '').trim();

const ENTRY_POINTS = [
  { in: 'src/background.ts', out: 'background.js' },
  { in: 'src/content/attendance.ts', out: 'content/attendance.js' },
  { in: 'src/content/unit-filters.ts', out: 'content/unit-filters.js' },
  { in: 'src/content/event-info.ts', out: 'content/event-info.js' },
  { in: 'src/content/event-info-toggle.ts', out: 'content/event-info-toggle.js' },
  { in: 'src/content/eval-sheet.ts', out: 'content/eval-sheet.js' },
  { in: 'src/content/eval-sheet-page.ts', out: 'content/eval-sheet-page.js' },
  { in: 'src/options/options.ts', out: 'options/options.js' },
  { in: 'src/popup/popup.ts', out: 'popup/popup.js' },
];

const STATIC_FILES = [
  'src/content/attendance.css',
  'src/content/unit-filters.css',
  'src/content/event-info.css',
  'src/content/eval-sheet.css',
  'src/options/options.html',
  'src/options/options.css',
  'src/popup/popup.html',
  'src/popup/popup.css',
];

function copyFile(relSrc, outDir) {
  const src = path.join(ROOT, relSrc);
  const dest = path.join(outDir, path.relative('src', relSrc));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeManifest(browserName, manifestFile, outDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, manifestFile), 'utf8'));
  manifest.version = VERSION;
  if (browserName === 'firefox' && FIREFOX_UPDATE_URL) {
    manifest.browser_specific_settings.gecko.update_url = FIREFOX_UPDATE_URL;
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function copyAssets(browserName, manifestFile, outDir) {
  for (const rel of STATIC_FILES) copyFile(rel, outDir);
  // Only the rendered PNGs; icons/icon.svg is the source, not shipped.
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'icons')).filter((f) => f.endsWith('.png'))) {
    fs.copyFileSync(path.join(ROOT, 'icons', f), path.join(outDir, 'icons', f));
  }
  writeManifest(browserName, manifestFile, outDir);
}

function esbuildOptions(outDir) {
  return {
    entryPoints: ENTRY_POINTS.map((e) => path.join(ROOT, e.in)),
    outbase: path.join(ROOT, 'src'),
    outdir: outDir,
    bundle: true,
    format: 'iife',
    target: 'es2020',
    sourcemap: false,
    logLevel: 'info',
  };
}

async function buildTarget(browserName, manifestFile) {
  const outDir = path.join(DIST, browserName);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build(esbuildOptions(outDir));
  copyAssets(browserName, manifestFile, outDir);

  console.log(`Built ${browserName} ${VERSION} -> ${path.relative(ROOT, outDir)}`);
}

// Watch mode: esbuild rebuilds the bundles; CSS/HTML/icons/manifests aren't
// esbuild inputs, so they're re-copied after every rebuild and on their own
// changes (fs.watch).
async function watchTarget(browserName, manifestFile) {
  const outDir = path.join(DIST, browserName);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const recopy = () => copyAssets(browserName, manifestFile, outDir);
  const ctx = await esbuild.context({
    ...esbuildOptions(outDir),
    plugins: [{ name: 'copy-assets', setup: (b) => b.onEnd(recopy) }],
  });
  await ctx.watch();

  let timer = null;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        recopy();
        console.log(`[watch] ${browserName}: assets re-copied`);
      } catch (err) {
        console.error(err);
      }
    }, 100);
  };
  for (const rel of [...STATIC_FILES, manifestFile, 'package.json']) {
    fs.watch(path.join(ROOT, rel), onChange);
  }
  fs.watch(path.join(ROOT, 'icons'), onChange);
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
  if (WATCH) {
    await watchTarget('chrome', 'manifest.chrome.json');
    await watchTarget('firefox', 'manifest.firefox.json');
    console.log('Watching for changes...');
    return;
  }
  await buildTarget('chrome', 'manifest.chrome.json');
  await buildTarget('firefox', 'manifest.firefox.json');
  packageXpi(path.join(DIST, 'firefox'), path.join(DIST, 'intrafeur.xpi'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
