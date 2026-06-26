import { Router } from 'express';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { signToken, requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const credsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(1024),
});

const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

authRouter.post('/register', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid email or password too short (min 10 chars)' });
  const { email, password } = parsed.data;

  const authHash = await argon2.hash(password, { type: argon2.argon2id });
  // Per-user salt the browser uses to derive its AES key. Public is fine;
  // a salt is not a secret. It just ensures unique keys per user.
  const encSalt = crypto.randomBytes(16).toString('base64');

  try {
    const { rows } = await query(
      `INSERT INTO users (email, auth_hash, enc_salt) VALUES ($1, $2, $3) RETURNING id, enc_salt`,
      [email.toLowerCase(), authHash, encSalt]
    );
    const user = rows[0];
    res.cookie('token', signToken(user.id), cookieOpts);
    res.json({ encSalt: user.enc_salt });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw e;
  }
});

authRouter.post('/login', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials' });
  const { email, password } = parsed.data;

  const { rows } = await query(
    `SELECT id, auth_hash, enc_salt FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  // Constant-ish time: still verify against a dummy hash if user missing.
  const hash = user?.auth_hash || '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await argon2.verify(hash, password).catch(() => false);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

  res.cookie('token', signToken(user.id), cookieOpts);
  res.json({ encSalt: user.enc_salt });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('token', { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query(`SELECT id, email, enc_salt FROM users WHERE id = $1`, [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: 'Not found' });
  res.json({ id: rows[0].id, email: rows[0].email, encSalt: rows[0].enc_salt });
});
