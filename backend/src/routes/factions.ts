import { Router, type Request, type Response } from 'express';
import db from '../db';
import type { Faction } from '../types';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface FactionBody {
  name?: unknown;
  color?: unknown;
}

const selectAll = db.prepare('SELECT id, name, color FROM factions ORDER BY name');
const selectOne = db.prepare('SELECT id, name, color FROM factions WHERE id = ?');
const insert = db.prepare('INSERT INTO factions (name, color) VALUES (?, ?)');
const update = db.prepare('UPDATE factions SET name = ?, color = ? WHERE id = ?');
const remove = db.prepare('DELETE FROM factions WHERE id = ?');

// Validation message for a provided name/color, or null when valid.
function invalidName(name: unknown): string | null {
  return typeof name === 'string' && name.trim().length > 0 ? null : 'name must be a non-empty string';
}
function invalidColor(color: unknown): string | null {
  return typeof color === 'string' && HEX_COLOR.test(color) ? null : 'color must be a hex string like #A1B2C3';
}

// Runs a write; a duplicate name becomes a 409 instead of a 500.
function uniqueName(res: Response, write: () => void): void {
  try {
    write();
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'A faction with that name already exists' });
      return;
    }
    throw err;
  }
}

router.get('/', (req: Request, res: Response) => {
  res.json(selectAll.all() as Faction[]);
});

router.post('/', (req: Request<unknown, unknown, FactionBody>, res: Response) => {
  const { name, color } = req.body || {};

  const error = invalidName(name) ?? invalidColor(color);
  if (error) return res.status(400).json({ error });

  uniqueName(res, () => {
    const info = insert.run((name as string).trim(), color);
    res.status(201).json(selectOne.get(info.lastInsertRowid) as Faction);
  });
});

router.patch('/:id', (req: Request<{ id: string }, unknown, FactionBody>, res: Response) => {
  const id = Number(req.params.id);
  const { name, color } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const error = (name !== undefined ? invalidName(name) : null) ?? (color !== undefined ? invalidColor(color) : null);
  if (error) return res.status(400).json({ error });

  const existing = selectOne.get(id) as Faction | undefined;
  if (!existing) {
    return res.status(404).json({ error: 'faction not found' });
  }

  uniqueName(res, () => {
    update.run(
      name !== undefined ? (name as string).trim() : existing.name,
      color !== undefined ? (color as string) : existing.color,
      id,
    );
    res.json(selectOne.get(id) as Faction);
  });
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const info = remove.run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'faction not found' });
  }

  res.status(204).end();
});

export default router;
