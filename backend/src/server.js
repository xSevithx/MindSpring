import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pgvector from 'pgvector/pg';
import 'dotenv/config';

import { pool } from './db/pool.js';
import { authRouter } from './routes/auth.js';
import { notesRouter } from './routes/notes.js';
import { aiRouter } from './routes/ai.js';
import { extensionsRouter } from './routes/extensions.js';
import { tablesRouter } from './routes/tables.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '6mb' }));
app.use(cookieParser());

const origin = process.env.CORS_ORIGIN || 'http://localhost:8080';
app.use(cors({ origin, credentials: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/notes', notesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/extensions', extensionsRouter);
app.use('/api/tables', tablesRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    const client = await pool.connect();
    await pgvector.registerTypes(client);
    client.release();
  } catch (e) {
    console.warn('pgvector type registration skipped:', e.message);
  }
  app.listen(PORT, () => console.log(`API listening on ${PORT}`));
}

start();
