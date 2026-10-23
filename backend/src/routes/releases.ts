// Self-hosted Firefox update channel. The signed XPIs live in
// DATA_DIR/releases (the persisted volume) as intrafeur-<version>.xpi.
// Firefox polls GET /extension/updates.json (the manifest's
// browser_specific_settings.gecko.update_url) without any credentials, so the
// read routes are public; uploading a release needs RELEASE_TOKEN, which is
// deliberately separate from the staff ALLOWED_TOKENS.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const RELEASES_DIR = path.join(DATA_DIR, 'releases');
fs.mkdirSync(RELEASES_DIR, { recursive: true });

const ADDON_ID = process.env.EXTENSION_ID || 'epitools@epitech-toolbox.local';
const RELEASE_TOKEN = (process.env.RELEASE_TOKEN || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const FILE_RE = /^intrafeur-(\d+(?:\.\d+){0,3})\.xpi$/;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Behind the Dokploy proxy req.protocol is plain http, and Firefox requires an
// https update_link, so PUBLIC_URL is the reliable source; the request host is
// only a fallback for local testing.
function baseUrl(req: Request): string {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function requireReleaseToken(req: Request, res: Response, next: NextFunction): void {
  if (!RELEASE_TOKEN) {
    res.status(503).json({ error: 'Releases disabled: no RELEASE_TOKEN set' });
    return;
  }
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || token !== RELEASE_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const router = express.Router();

router.get('/updates.json', (req: Request, res: Response) => {
  const updates = fs
    .readdirSync(RELEASES_DIR)
    .map((file) => ({ file, match: FILE_RE.exec(file) }))
    .filter((e): e is { file: string; match: RegExpExecArray } => e.match !== null)
    .sort((a, b) => compareVersions(a.match[1], b.match[1]))
    .map(({ file, match }) => {
      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(RELEASES_DIR, file)))
        .digest('hex');
      return {
        version: match[1],
        update_link: `${baseUrl(req)}/extension/${file}`,
        update_hash: `sha256:${hash}`,
      };
    });
  res.set('Cache-Control', 'no-cache');
  res.json({ addons: { [ADDON_ID]: { updates } } });
});

router.get('/:file', (req: Request, res: Response) => {
  const file = String(req.params.file);
  if (!FILE_RE.test(file) || !fs.existsSync(path.join(RELEASES_DIR, file))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('application/x-xpinstall');
  res.sendFile(path.join(RELEASES_DIR, file));
});

router.put(
  '/releases/:version',
  requireReleaseToken,
  express.raw({ type: '*/*', limit: '20mb' }),
  (req: Request, res: Response) => {
    const version = String(req.params.version);
    const body = req.body as Buffer;
    if (!VERSION_RE.test(version)) {
      res.status(400).json({ error: 'invalid version' });
      return;
    }
    // An XPI is a zip: reject anything that doesn't start with the zip magic.
    if (!Buffer.isBuffer(body) || body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) {
      res.status(400).json({ error: 'body must be an .xpi (zip) file' });
      return;
    }
    const dest = path.join(RELEASES_DIR, `intrafeur-${version}.xpi`);
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
    res.status(201).json({ version, url: `${baseUrl(req)}/extension/${path.basename(dest)}` });
  },
);

export default router;
