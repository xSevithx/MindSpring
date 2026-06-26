import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

// The server validates only that these are strings of bounded length.
// It has no idea what they decrypt to.
const noteSchema = z.object({
  iv: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(5_000_000),
});

notesRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, iv, ciphertext, created_at, updated_at
       FROM notes WHERE user_id = $1 ORDER BY updated_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

notesRouter.post('/', async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid note payload' });
  const { iv, ciphertext } = parsed.data;
  const { rows } = await query(
    `INSERT INTO notes (user_id, iv, ciphertext) VALUES ($1, $2, $3)
     RETURNING id, iv, ciphertext, created_at, updated_at`,
    [req.userId, iv, ciphertext]
  );
  res.status(201).json(rows[0]);
});

notesRouter.put('/:id', async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid note payload' });
  const { iv, ciphertext } = parsed.data;
  const { rows } = await query(
    `UPDATE notes SET iv = $1, ciphertext = $2, updated_at = now()
       WHERE id = $3 AND user_id = $4
     RETURNING id, iv, ciphertext, created_at, updated_at`,
    [iv, ciphertext, req.params.id, req.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Note not found' });
  res.json(rows[0]);
});

notesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM notes WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Note not found' });
  res.json({ ok: true });
});
