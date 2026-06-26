import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { generateEmbedding } from '../services/embeddings.js';

export const tablesRouter = Router();
tablesRouter.use(requireAuth);

const FIELD_TYPES = ['text', 'longtext', 'number', 'select', 'multiselect', 'date', 'checkbox', 'url', 'link'];

// ── Table CRUD ──

const createTableSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  fields: z.array(z.object({
    name: z.string().min(1).max(200),
    type: z.enum(FIELD_TYPES).default('text'),
    options: z.record(z.any()).default({}),
  })).default([]),
});

tablesRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, description, created_at, updated_at FROM datatables
     WHERE user_id = $1 ORDER BY updated_at DESC`,
    [req.userId],
  );
  res.json(rows);
});

tablesRouter.post('/', async (req, res) => {
  const parsed = createTableSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const { name, description, fields } = parsed.data;
  const tbl = await query(
    `INSERT INTO datatables (user_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, created_at, updated_at`,
    [req.userId, name, description],
  );
  const tableId = tbl.rows[0].id;

  const createdFields = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const fld = await query(
      `INSERT INTO datafields (table_id, name, type, options, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, type, options, position`,
      [tableId, f.name, f.type, JSON.stringify(f.options), i],
    );
    createdFields.push(fld.rows[0]);
  }

  res.status(201).json({ ...tbl.rows[0], fields: createdFields });
});

tablesRouter.patch('/:id', async (req, res) => {
  const { name, description } = req.body;
  const sets = [];
  const vals = [];
  let idx = 1;
  if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = now()`);
  vals.push(req.params.id, req.userId);
  const { rows } = await query(
    `UPDATE datatables SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}
     RETURNING id, name, description, created_at, updated_at`,
    vals,
  );
  if (!rows[0]) return res.status(404).json({ error: 'Table not found' });
  res.json(rows[0]);
});

tablesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM datatables WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId],
  );
  if (!rowCount) return res.status(404).json({ error: 'Table not found' });
  res.json({ ok: true });
});

// ── Field management ──

tablesRouter.get('/:id/fields', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });
  const { rows } = await query(
    'SELECT id, name, type, options, position FROM datafields WHERE table_id = $1 ORDER BY position',
    [req.params.id],
  );
  res.json(rows);
});

tablesRouter.post('/:id/fields', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });

  const { name, type = 'text', options = {} } = req.body;
  if (!name) return res.status(400).json({ error: 'Field name is required' });
  if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid field type' });

  const maxPos = await query('SELECT COALESCE(MAX(position), -1) AS mp FROM datafields WHERE table_id = $1', [req.params.id]);
  const { rows } = await query(
    `INSERT INTO datafields (table_id, name, type, options, position)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, type, options, position`,
    [req.params.id, name, type, JSON.stringify(options), maxPos.rows[0].mp + 1],
  );
  res.status(201).json(rows[0]);
});

tablesRouter.patch('/:tableId/fields/:fieldId', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.tableId, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });

  const { name, options, position } = req.body;
  const sets = [];
  const vals = [];
  let idx = 1;
  if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
  if (options !== undefined) { sets.push(`options = $${idx++}`); vals.push(JSON.stringify(options)); }
  if (position !== undefined) { sets.push(`position = $${idx++}`); vals.push(position); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.fieldId, req.params.tableId);
  const { rows } = await query(
    `UPDATE datafields SET ${sets.join(', ')} WHERE id = $${idx++} AND table_id = $${idx}
     RETURNING id, name, type, options, position`,
    vals,
  );
  if (!rows[0]) return res.status(404).json({ error: 'Field not found' });
  res.json(rows[0]);
});

tablesRouter.delete('/:tableId/fields/:fieldId', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.tableId, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });
  const { rowCount } = await query(
    'DELETE FROM datafields WHERE id = $1 AND table_id = $2',
    [req.params.fieldId, req.params.tableId],
  );
  if (!rowCount) return res.status(404).json({ error: 'Field not found' });
  res.json({ ok: true });
});

// ── Records ──

async function getRecordsWithValues(tableId, userId) {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [tableId, userId]);
  if (!tbl.rows[0]) return null;

  const fields = await query(
    'SELECT id, name, type, options, position FROM datafields WHERE table_id = $1 ORDER BY position',
    [tableId],
  );
  const records = await query(
    'SELECT id, created_at, updated_at FROM datarecords WHERE table_id = $1 ORDER BY created_at',
    [tableId],
  );
  if (!records.rows.length) return { fields: fields.rows, records: [] };

  const recIds = records.rows.map((r) => r.id);
  const vals = await query(
    `SELECT record_id, field_id, text_val, number_val, json_val FROM datavalues
     WHERE record_id = ANY($1)`,
    [recIds],
  );

  const valMap = {};
  for (const v of vals.rows) {
    if (!valMap[v.record_id]) valMap[v.record_id] = {};
    valMap[v.record_id][v.field_id] = v;
  }

  // Resolve link fields
  const linkFields = fields.rows.filter((f) => f.type === 'link');
  const linkedRecordIds = new Set();
  if (linkFields.length) {
    for (const rec of records.rows) {
      for (const lf of linkFields) {
        const v = valMap[rec.id]?.[lf.id];
        const linked = v?.json_val;
        if (Array.isArray(linked)) linked.forEach((lid) => linkedRecordIds.add(lid));
        else if (linked) linkedRecordIds.add(linked);
      }
    }
  }
  let linkedDisplayMap = {};
  if (linkedRecordIds.size) {
    const linkedIds = [...linkedRecordIds];
    const linkedRecs = await query(
      `SELECT dr.id AS record_id, df.name AS field_name, dv.text_val
       FROM datarecords dr
       JOIN datafields df ON df.table_id = dr.table_id AND df.position = 0
       LEFT JOIN datavalues dv ON dv.record_id = dr.id AND dv.field_id = df.id
       WHERE dr.id = ANY($1)`,
      [linkedIds],
    );
    for (const lr of linkedRecs.rows) {
      linkedDisplayMap[lr.record_id] = lr.text_val || '(unnamed)';
    }
  }

  const enriched = records.rows.map((r) => {
    const values = {};
    for (const f of fields.rows) {
      const v = valMap[r.id]?.[f.id];
      if (!v) { values[f.id] = null; continue; }
      if (f.type === 'number') values[f.id] = v.number_val;
      else if (f.type === 'checkbox') values[f.id] = v.json_val;
      else if (f.type === 'select') values[f.id] = v.text_val;
      else if (f.type === 'multiselect') values[f.id] = v.json_val || [];
      else if (f.type === 'link') {
        const linked = v.json_val;
        if (Array.isArray(linked)) {
          values[f.id] = linked.map((lid) => ({ id: lid, display: linkedDisplayMap[lid] || lid }));
        } else if (linked) {
          values[f.id] = [{ id: linked, display: linkedDisplayMap[linked] || linked }];
        } else {
          values[f.id] = [];
        }
      } else {
        values[f.id] = v.text_val;
      }
    }
    return { id: r.id, created_at: r.created_at, updated_at: r.updated_at, values };
  });

  return { fields: fields.rows, records: enriched };
}

tablesRouter.get('/:id/records', async (req, res) => {
  const data = await getRecordsWithValues(req.params.id, req.userId);
  if (!data) return res.status(404).json({ error: 'Table not found' });
  res.json(data);
});

tablesRouter.post('/:id/records', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });

  const rec = await query(
    `INSERT INTO datarecords (table_id, user_id) VALUES ($1, $2)
     RETURNING id, created_at, updated_at`,
    [req.params.id, req.userId],
  );
  const recordId = rec.rows[0].id;

  const { values } = req.body;
  if (values && typeof values === 'object') {
    await writeValues(recordId, values, req.params.id);
  }

  await embedRecord(recordId, req.params.id, req.userId);
  await query('UPDATE datatables SET updated_at = now() WHERE id = $1', [req.params.id]);

  res.status(201).json(rec.rows[0]);
});

tablesRouter.post('/:id/records/batch', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });

  const { records: recordsData } = req.body;
  if (!Array.isArray(recordsData)) return res.status(400).json({ error: 'records must be an array' });

  const created = [];
  for (const entry of recordsData) {
    const rec = await query(
      `INSERT INTO datarecords (table_id, user_id) VALUES ($1, $2) RETURNING id`,
      [req.params.id, req.userId],
    );
    const recordId = rec.rows[0].id;
    if (entry.values && typeof entry.values === 'object') {
      await writeValues(recordId, entry.values, req.params.id);
    }
    created.push(recordId);
  }

  // Embed in background — don't block the response
  setImmediate(async () => {
    for (const recId of created) {
      await embedRecord(recId, req.params.id, req.userId);
    }
  });

  await query('UPDATE datatables SET updated_at = now() WHERE id = $1', [req.params.id]);
  res.status(201).json({ created: created.length });
});

tablesRouter.patch('/:tableId/records/:recordId', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.tableId, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });
  const rec = await query('SELECT id FROM datarecords WHERE id = $1 AND table_id = $2', [req.params.recordId, req.params.tableId]);
  if (!rec.rows[0]) return res.status(404).json({ error: 'Record not found' });

  const { values } = req.body;
  if (values && typeof values === 'object') {
    await writeValues(req.params.recordId, values, req.params.tableId);
  }
  await query('UPDATE datarecords SET updated_at = now() WHERE id = $1', [req.params.recordId]);
  await query('UPDATE datatables SET updated_at = now() WHERE id = $1', [req.params.tableId]);

  await embedRecord(req.params.recordId, req.params.tableId, req.userId);

  res.json({ ok: true });
});

tablesRouter.delete('/:tableId/records/:recordId', async (req, res) => {
  const tbl = await query('SELECT id FROM datatables WHERE id = $1 AND user_id = $2', [req.params.tableId, req.userId]);
  if (!tbl.rows[0]) return res.status(404).json({ error: 'Table not found' });
  const { rowCount } = await query(
    'DELETE FROM datarecords WHERE id = $1 AND table_id = $2',
    [req.params.recordId, req.params.tableId],
  );
  if (!rowCount) return res.status(404).json({ error: 'Record not found' });
  res.json({ ok: true });
});

// ── Helpers ──

async function writeValues(recordId, values, tableId) {
  const fields = await query(
    'SELECT id, type FROM datafields WHERE table_id = $1',
    [tableId],
  );
  const fieldMap = new Map(fields.rows.map((f) => [f.id, f]));

  for (const [fieldId, val] of Object.entries(values)) {
    const field = fieldMap.get(fieldId);
    if (!field) continue;

    let textVal = null, numberVal = null, jsonVal = null;
    if (field.type === 'number') {
      numberVal = val === '' || val === null ? null : Number(val);
    } else if (field.type === 'checkbox') {
      jsonVal = Boolean(val);
    } else if (field.type === 'multiselect' || field.type === 'link') {
      jsonVal = Array.isArray(val) ? val : val ? [val] : [];
    } else {
      textVal = val === null ? null : String(val);
    }

    await query(
      `INSERT INTO datavalues (record_id, field_id, text_val, number_val, json_val)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (record_id, field_id) DO UPDATE
         SET text_val = EXCLUDED.text_val,
             number_val = EXCLUDED.number_val,
             json_val = EXCLUDED.json_val`,
      [recordId, fieldId, textVal, numberVal, jsonVal !== null ? JSON.stringify(jsonVal) : null],
    );
  }
}

async function embedRecord(recordId, tableId, userId) {
  try {
    const fields = await query(
      'SELECT id, name, type FROM datafields WHERE table_id = $1 ORDER BY position',
      [tableId],
    );
    const vals = await query(
      'SELECT field_id, text_val, number_val, json_val FROM datavalues WHERE record_id = $1',
      [recordId],
    );
    const valMap = new Map(vals.rows.map((v) => [v.field_id, v]));

    const parts = [];
    for (const f of fields.rows) {
      const v = valMap.get(f.id);
      if (!v) continue;
      let display = '';
      if (f.type === 'number') display = v.number_val != null ? String(v.number_val) : '';
      else if (f.type === 'checkbox') display = v.json_val ? 'yes' : 'no';
      else if (f.type === 'multiselect') display = Array.isArray(v.json_val) ? v.json_val.join(', ') : '';
      else display = v.text_val || '';
      if (display) parts.push(`${f.name}: ${display}`);
    }

    if (!parts.length) return;
    const text = parts.join('\n');
    const embedding = await generateEmbedding(text);
    const vecLiteral = `[${embedding.join(',')}]`;

    await query(
      `INSERT INTO record_embeddings (record_id, user_id, embedding, content_hash, synced_at)
       VALUES ($1, $2, $3::vector, $4, now())
       ON CONFLICT (record_id) DO UPDATE
         SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash, synced_at = now()`,
      [recordId, userId, vecLiteral, text.slice(0, 200)],
    );
  } catch (e) {
    console.warn('Record embedding failed:', e.message);
  }
}
