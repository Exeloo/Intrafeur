import { Router, type Request, type Response } from 'express';
import db from '../db';
import type { Faction } from '../types';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface FactionBody {
  name?: unknown;
  color?: unknown;
}

router.get('/', (req: Request, res: Response) => {
  const factions = db.prepare('SELECT id, name, color FROM factions ORDER BY name').all() as Faction[];
  res.json(factions);
});

router.post('/', (req: Request<unknown, unknown, FactionBody>, res: Response) => {
  const { name, color } = req.body || {};

  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
    return res.status(400).json({ error: 'color must be a hex string like #A1B2C3' });
  }

  try {
    const info = db.prepare('INSERT INTO factions (name, color) VALUES (?, ?)').run(name.trim(), color);
    const faction = db
      .prepare('SELECT id, name, color FROM factions WHERE id = ?')
      .get(info.lastInsertRowid) as Faction;
    res.status(201).json(faction);
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A faction with that name already exists' });
    }
    throw err;
  }
});

router.patch('/:id', (req: Request<{ id: string }, unknown, FactionBody>, res: Response) => {
  const id = Number(req.params.id);
  const { name, color } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (color !== undefined && (typeof color !== 'string' || !HEX_COLOR.test(color))) {
    return res.status(400).json({ error: 'color must be a hex string like #A1B2C3' });
  }

  const existing = db.prepare('SELECT id, name, color FROM factions WHERE id = ?').get(id) as Faction | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'faction not found' });
  }

  try {
    db.prepare('UPDATE factions SET name = ?, color = ? WHERE id = ?').run(
      name !== undefined ? (name as string).trim() : existing.name,
      color !== undefined ? (color as string) : existing.color,
      id,
    );
    res.json(db.prepare('SELECT id, name, color FROM factions WHERE id = ?').get(id) as Faction);
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A faction with that name already exists' });
    }
    throw err;
  }
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const info = db.prepare('DELETE FROM factions WHERE id = ?').run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'faction not found' });
  }

  res.status(204).end();
});

export default router;
