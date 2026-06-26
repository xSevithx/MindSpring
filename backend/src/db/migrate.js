import { pool } from './pool.js';

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  -- Argon2 hash used ONLY to authenticate the login (server-side).
  auth_hash     TEXT NOT NULL,
  -- Random per-user salt the CLIENT uses to derive the encryption key
  -- from the password. The server never sees the derived key.
  enc_salt      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Everything below is ciphertext + IV produced in the browser.
  -- The server stores opaque blobs; it cannot read titles or bodies.
  iv            TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at DESC);
`;

const EMBED_DIM = parseInt(process.env.EMBED_DIM || '384', 10);

const AI_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id       UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  embedding     vector(${EMBED_DIM}),
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_note_embed_user ON note_embeddings(user_id);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'New chat',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_convos_user ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_msgs_convo ON ai_messages(conversation_id, created_at);
`;

const TABLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS datatables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datatables_user ON datatables(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS datafields (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',
  options     JSONB NOT NULL DEFAULT '{}',
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datafields_table ON datafields(table_id, position);

CREATE TABLE IF NOT EXISTS datarecords (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datarecords_table ON datarecords(table_id, created_at);

CREATE TABLE IF NOT EXISTS datavalues (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   UUID NOT NULL REFERENCES datarecords(id) ON DELETE CASCADE,
  field_id    UUID NOT NULL REFERENCES datafields(id) ON DELETE CASCADE,
  text_val    TEXT,
  number_val  DOUBLE PRECISION,
  json_val    JSONB,
  UNIQUE(record_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_datavalues_record ON datavalues(record_id);
CREATE INDEX IF NOT EXISTS idx_datavalues_field ON datavalues(field_id);

CREATE TABLE IF NOT EXISTS record_embeddings (
  record_id   UUID PRIMARY KEY REFERENCES datarecords(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  embedding   vector(${EMBED_DIM}),
  content_hash TEXT,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_record_embed_user ON record_embeddings(user_id);
`;

async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(AI_SCHEMA);
  await pool.query(TABLES_SCHEMA);
  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
