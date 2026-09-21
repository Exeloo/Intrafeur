import { Router, type Request, type Response } from 'express';
import db from '../db';
import type { AssignmentRow } from '../types';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AssignmentBody {
  factionId?: unknown;
}

router.get('/', (req: Request, res: Response) => {
  const rows = db
    .prepare('SELECT student_email, faction_id FROM assignments WHERE faction_id IS NOT NULL')
    .all() as AssignmentRow[];
  const map: Record<string, number | null> = {};
  for (const row of rows) {
    map[row.student_email] = row.faction_id;
  }
  res.json(map);
});

router.put('/:email', (req: Request<{ email: string }, unknown, AssignmentBody>, res: Response) => {
  const email = req.params.email;
  const { factionId } = req.body || {};

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid email' });
  }
  if (factionId !== null && !Number.isInteger(factionId)) {
    return res.status(400).json({ error: 'factionId must be an integer or null' });
  }

  if (factionId !== null) {
    const faction = db.prepare('SELECT id FROM factions WHERE id = ?').get(factionId as number);
    if (!faction) {
      return res.status(404).json({ error: 'faction not found' });
    }
  }

  db.prepare(
    `INSERT INTO assignments (student_email, faction_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(student_email) DO UPDATE SET faction_id = excluded.faction_id, updated_at = excluded.updated_at`,
  ).run(email, factionId as number | null);

  res.json({ email, factionId });
});

export default router;
