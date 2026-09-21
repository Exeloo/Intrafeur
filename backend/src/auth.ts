import type { Request, Response, NextFunction } from 'express';

const ALLOWED_TOKENS = (process.env.ALLOWED_TOKENS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (ALLOWED_TOKENS.length === 0) {
    res.status(500).json({ error: 'Server misconfigured: no ALLOWED_TOKENS set' });
    return;
  }

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token || !ALLOWED_TOKENS.includes(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
