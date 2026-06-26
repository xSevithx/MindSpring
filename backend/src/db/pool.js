import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'notes',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'securenotes',
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function query(text, params) {
  return pool.query(text, params);
}
