import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { isConfigured, chatCompletion } from '../services/hyperbolic.js';
import { generateEmbedding, generateEmbeddings } from '../services/embeddings.js';

const EXT_DIR = path.resolve(process.cwd(), 'extensions');

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.use((req, res, next) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'AI features are not configured (missing HYPERBOLIC_API_KEY)' });
  }
  next();
});

// ── Sync status ──

aiRouter.get('/status', async (req, res) => {
  const [userRow, embedRow, noteRow, recEmbedRow, recRow] = await Promise.all([
    query('SELECT ai_enabled FROM users WHERE id = $1', [req.userId]),
    query(
      `SELECT COUNT(*)::int AS count, MAX(synced_at) AS last
         FROM note_embeddings WHERE user_id = $1`,
      [req.userId],
    ),
    query('SELECT COUNT(*)::int AS count FROM notes WHERE user_id = $1', [req.userId]),
    query(
      `SELECT COUNT(*)::int AS count FROM record_embeddings WHERE user_id = $1`,
      [req.userId],
    ),
    query(
      `SELECT COUNT(*)::int AS count FROM datarecords dr
       JOIN datatables dt ON dt.id = dr.table_id
       WHERE dt.user_id = $1`,
      [req.userId],
    ),
  ]);
  res.json({
    aiEnabled: userRow.rows[0]?.ai_enabled ?? false,
    syncedCount: embedRow.rows[0].count,
    totalNotes: noteRow.rows[0].count,
    syncedRecords: recEmbedRow.rows[0].count,
    totalRecords: recRow.rows[0].count,
    lastSyncedAt: embedRow.rows[0].last,
  });
});

// ── Bulk sync ──

const syncSchema = z.object({
  notes: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().max(10000).default(''),
    body: z.string().max(500000).default(''),
  })).max(5000).default([]),
});

aiRouter.post('/sync', async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid sync payload' });

  const { notes } = parsed.data;
  const texts = notes.map((n) => `${n.title}\n\n${n.body}`.trim());

  const BATCH = 32;
  let synced = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const batchNotes = notes.slice(i, i + BATCH);
    const embeddings = await generateEmbeddings(batch);

    for (let j = 0; j < batchNotes.length; j++) {
      const vecLiteral = `[${embeddings[j].join(',')}]`;
      await query(
        `INSERT INTO note_embeddings (note_id, user_id, embedding, synced_at)
         VALUES ($1, $2, $3::vector, now())
         ON CONFLICT (note_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, synced_at = now()`,
        [batchNotes[j].id, req.userId, vecLiteral],
      );
      synced++;
    }
  }

  // Also sync all table records
  let syncedRecords = 0;
  const allRecords = await query(
    `SELECT dr.id AS record_id, dr.table_id
     FROM datarecords dr
     JOIN datatables dt ON dt.id = dr.table_id
     WHERE dt.user_id = $1`,
    [req.userId],
  );

  for (const rec of allRecords.rows) {
    try {
      const fields = await query(
        'SELECT id, name, type FROM datafields WHERE table_id = $1 ORDER BY position',
        [rec.table_id],
      );
      const vals = await query(
        'SELECT field_id, text_val, number_val, json_val FROM datavalues WHERE record_id = $1',
        [rec.record_id],
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
      if (!parts.length) continue;
      const text = parts.join('\n');
      const recEmbedding = await generateEmbedding(text);
      const recVec = `[${recEmbedding.join(',')}]`;
      await query(
        `INSERT INTO record_embeddings (record_id, user_id, embedding, content_hash, synced_at)
         VALUES ($1, $2, $3::vector, $4, now())
         ON CONFLICT (record_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash, synced_at = now()`,
        [rec.record_id, req.userId, recVec, text.slice(0, 200)],
      );
      syncedRecords++;
    } catch (e) {
      console.warn('Record embedding failed during sync:', rec.record_id, e.message);
    }
  }

  await query('UPDATE users SET ai_enabled = true WHERE id = $1', [req.userId]);
  res.json({ ok: true, synced, syncedRecords });
});

// ── Single-note sync (auto-sync on save) ──

const singleSyncSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(10000).default(''),
  body: z.string().max(500000).default(''),
});

aiRouter.post('/sync/note', async (req, res) => {
  const parsed = singleSyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid note payload' });

  const { id, title, body } = parsed.data;
  const text = `${title}\n\n${body}`.trim();
  const embedding = await generateEmbedding(text);
  const vecLiteral = `[${embedding.join(',')}]`;

  await query(
    `INSERT INTO note_embeddings (note_id, user_id, embedding, synced_at)
     VALUES ($1, $2, $3::vector, now())
     ON CONFLICT (note_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, synced_at = now()`,
    [id, req.userId, vecLiteral],
  );
  res.json({ ok: true });
});

// ── Purge all AI data ──

aiRouter.delete('/sync', async (req, res) => {
  await query('DELETE FROM ai_conversations WHERE user_id = $1', [req.userId]);
  await query('DELETE FROM note_embeddings WHERE user_id = $1', [req.userId]);
  await query('UPDATE users SET ai_enabled = false WHERE id = $1', [req.userId]);
  res.json({ ok: true });
});

// ── Conversations ──

aiRouter.get('/conversations', async (req, res) => {
  const { rows } = await query(
    `SELECT id, title, created_at, updated_at
       FROM ai_conversations WHERE user_id = $1
       ORDER BY updated_at DESC`,
    [req.userId],
  );
  res.json(rows);
});

aiRouter.post('/conversations', async (req, res) => {
  const { rows } = await query(
    `INSERT INTO ai_conversations (user_id) VALUES ($1)
     RETURNING id, title, created_at, updated_at`,
    [req.userId],
  );
  res.status(201).json(rows[0]);
});

aiRouter.get('/conversations/:id', async (req, res) => {
  const convo = await query(
    'SELECT id, title, created_at, updated_at FROM ai_conversations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId],
  );
  if (!convo.rows[0]) return res.status(404).json({ error: 'Conversation not found' });

  const msgs = await query(
    'SELECT id, role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at',
    [req.params.id],
  );
  res.json({ ...convo.rows[0], messages: msgs.rows });
});

aiRouter.delete('/conversations/:id', async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId],
  );
  if (!rowCount) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true });
});

// ── Send message (RAG pipeline) ──

const messageSchema = z.object({
  content: z.string().min(1).max(500000),
});

aiRouter.post('/conversations/:id/messages', async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Message content is required' });

  const convoCheck = await query(
    'SELECT id, title FROM ai_conversations WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId],
  );
  if (!convoCheck.rows[0]) return res.status(404).json({ error: 'Conversation not found' });

  const userContent = parsed.data.content;

  // Store user message
  const userMsg = await query(
    `INSERT INTO ai_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)
     RETURNING id, role, content, created_at`,
    [req.params.id, userContent],
  );

  // RAG: embed question → vector search → build context
  const questionEmbedding = await generateEmbedding(userContent);
  const vecLiteral = `[${questionEmbedding.join(',')}]`;

  const similar = await query(
    `SELECT ne.note_id, n.iv, n.ciphertext
       FROM note_embeddings ne
       JOIN notes n ON n.id = ne.note_id
       WHERE ne.user_id = $1
       ORDER BY ne.embedding <=> $2::vector
       LIMIT 5`,
    [req.userId, vecLiteral],
  );

  // We don't have plaintext on the server — the browser sent it during sync
  // but we only stored embeddings. For RAG context, we need the plaintext to
  // be included by the browser in the request, or we re-fetch from note_embeddings.
  // Since note_embeddings doesn't store plaintext (by design — minimize stored data),
  // we ask the browser to include note context. However, for a simpler UX,
  // we'll store a searchable snippet alongside the embedding.
  //
  // For now: the client includes decrypted notes in a separate field so the
  // server can look up plaintext by note ID from the request. If not provided,
  // we fall back to telling the LLM we found relevant notes but can't read them.

  // Alternative approach: store plaintext in note_embeddings for RAG.
  // Let's add a plaintext_content column approach — since the user already
  // opted into AI, storing plaintext server-side is within the security model.

  // Build context from similar notes
  let noteContext = '';
  if (req.body.noteContext && Array.isArray(req.body.noteContext)) {
    const contextMap = new Map(req.body.noteContext.map((n) => [n.id, n]));
    const contextNotes = similar.rows
      .map((r) => contextMap.get(r.note_id))
      .filter(Boolean);
    noteContext = contextNotes
      .map((n, i) => `--- Note ${i + 1}: ${n.title || 'Untitled'} ---\n${n.body || ''}`)
      .join('\n\n');
  }

  // Also search table records for relevant structured data
  let tableContext = '';
  try {
    const similarRecords = await query(
      `SELECT re.record_id, re.content_hash, dr.table_id
         FROM record_embeddings re
         JOIN datarecords dr ON dr.id = re.record_id
         WHERE re.user_id = $1
         ORDER BY re.embedding <=> $2::vector
         LIMIT 5`,
      [req.userId, vecLiteral],
    );
    if (similarRecords.rows.length) {
      const recordDetails = [];
      for (const sr of similarRecords.rows) {
        const tbl = await query('SELECT name FROM datatables WHERE id = $1', [sr.table_id]);
        const fields = await query(
          'SELECT id, name, type FROM datafields WHERE table_id = $1 ORDER BY position',
          [sr.table_id],
        );
        const vals = await query(
          'SELECT field_id, text_val, number_val, json_val FROM datavalues WHERE record_id = $1',
          [sr.record_id],
        );
        const valMap = new Map(vals.rows.map((v) => [v.field_id, v]));
        const parts = [];
        for (const f of fields.rows) {
          const v = valMap.get(f.id);
          if (!v) continue;
          let display = '';
          if (f.type === 'number') display = v.number_val != null ? String(v.number_val) : '';
          else if (f.type === 'checkbox') display = v.json_val ? 'Yes' : 'No';
          else if (f.type === 'multiselect') display = Array.isArray(v.json_val) ? v.json_val.join(', ') : '';
          else display = v.text_val || '';
          if (display) parts.push(`  ${f.name}: ${display}`);
        }
        if (parts.length) {
          recordDetails.push(`[${tbl.rows[0]?.name || 'Table'}]\n${parts.join('\n')}`);
        }
      }
      if (recordDetails.length) {
        tableContext = '\n\nRelevant table records:\n' + recordDetails.join('\n\n');
      }
    }
  } catch {
    // Table context is best-effort
  }

  // Get conversation history (last 20 messages for context window)
  const history = await query(
    `SELECT role, content FROM ai_messages
     WHERE conversation_id = $1
     ORDER BY created_at
     LIMIT 20`,
    [req.params.id],
  );

  const builderDocs = `
You can also BUILD extensions for the MindSpring app. When the user asks you to build a feature, UI panel, widget, or tool, generate the extension code wrapped in <extension> tags like this:

<extension>
{
  "id": "kebab-case-id",
  "name": "Human Readable Name",
  "description": "What it does",
  "files": {
    "panel.js": "// JavaScript code here",
    "styles.css": "/* CSS here */"
  }
}
</extension>

The extension's panel.js runs in the browser and has access to the window.inkwell API:
- inkwell.registerPanel({ id, title, render(container) }) — register a UI panel
- inkwell.on(event, callback) — listen: 'noteSelect', 'noteSave', 'noteCreate', 'noteDelete', 'notesLoad'
- inkwell.getActiveNote() — returns { id, title, body, created_at, updated_at } or null
- inkwell.getNotes() — returns array of all decrypted notes
- inkwell.refreshPanel(id) — re-render a panel
- inkwell.notify(message, type) — show toast ('info' or 'error')
- inkwell.api(path, opts) — make authenticated API calls

IMPORTANT rules for panel.js:
- It is loaded as a regular script (NOT a module), so do NOT use import/export
- Use the inkwell global object directly
- The render function receives a container DOM element — build your UI with createElement or innerHTML
- Keep it self-contained in a single file
- The CSS file is optional — use it for custom styles with a unique prefix to avoid conflicts

After the <extension> block, include a brief friendly description of what you built.

You can also CREATE NOTES or DATA TABLES when the user asks you to organize information (especially from uploaded files).

To create multiple notes, wrap them in <create_notes> tags:
<create_notes>
[
  { "title": "Note Title", "body": "Note content here..." },
  { "title": "Another Note", "body": "More content..." }
]
</create_notes>

To create a data table with records, wrap it in <create_table> tags:
<create_table>
{
  "name": "Table Name",
  "description": "What this table contains",
  "fields": [
    { "name": "Column Name", "type": "text" },
    { "name": "IP Address", "type": "text" },
    { "name": "Status", "type": "select", "options": { "choices": ["Active", "Inactive"] } },
    { "name": "Port", "type": "number" }
  ],
  "records": [
    { "Column Name": "value1", "IP Address": "10.0.0.1", "Status": "Active", "Port": 443 },
    { "Column Name": "value2", "IP Address": "10.0.0.2", "Status": "Inactive", "Port": 80 }
  ]
}
</create_table>

Available field types: text, longtext, number, select, multiselect, date, checkbox, url, link.
For select/multiselect, include options.choices array.

IMPORTANT RULES for intents:
- When the user uploads a spreadsheet/file and asks to create notes, use <create_notes>
- When the user uploads a spreadsheet/file and asks to create a table, use <create_table>
- Include ALL rows from the uploaded data, do not summarize or skip any
- For tables, choose appropriate field types based on the data (numbers as "number", yes/no as "checkbox", etc.)
- After the intent block, include a brief summary of what you created`;


  const hasContext = noteContext || tableContext;
  let systemPrompt = hasContext
    ? `You are MindSpring AI, a helpful assistant for a personal note-taking and data management app. The user has notes and structured data tables they've chosen to share with AI. Below is the most relevant information. Answer based on this data when relevant, and be clear when information comes from their data vs. your general knowledge.\n\n${noteContext ? 'Relevant notes:\n' + noteContext : ''}${tableContext}`
    : 'You are MindSpring AI, a helpful assistant for a personal note-taking and data management app. The user has notes and data tables but none seem directly relevant to this question. Answer with your general knowledge.';

  systemPrompt += '\n\n' + builderDocs;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.rows.map((m) => ({ role: m.role, content: m.content })),
  ];

  const hasFileData = userContent.includes('[Attached file:');
  let assistantContent = await chatCompletion(messages, { maxTokens: hasFileData ? 16384 : 4096 });

  // Check if the AI generated an extension
  let extensionInstalled = null;
  let extensionId = null;
  const extMatch = assistantContent.match(/<extension>\s*([\s\S]*?)\s*<\/extension>/);
  if (extMatch) {
    try {
      // The AI often puts literal newlines/tabs inside JSON string values,
      // which is invalid JSON. Fix by escaping control chars inside strings.
      const sanitized = extMatch[1].replace(
        /"(?:[^"\\]|\\.)*"/g,
        (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
      );
      const extData = JSON.parse(sanitized);
      extensionId = extData.id;
      const extPath = path.join(EXT_DIR, extData.id);
      await fs.mkdir(extPath, { recursive: true });

      const manifest = {
        id: extData.id,
        name: extData.name || extData.id,
        description: extData.description || '',
        version: '1.0.0',
        enabled: true,
        frontend: {
          panel: extData.files['panel.js'] ? 'panel.js' : undefined,
          styles: extData.files['styles.css'] ? 'styles.css' : undefined,
        },
      };
      await fs.writeFile(path.join(extPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

      for (const [filename, content] of Object.entries(extData.files)) {
        if (filename.includes('..')) continue;
        await fs.writeFile(path.join(extPath, filename), content, 'utf-8');
      }

      extensionInstalled = extData.name || extData.id;
      // Clean the extension block from the displayed message
      assistantContent = assistantContent
        .replace(/<extension>[\s\S]*?<\/extension>\s*/, '')
        .trim();
      if (!assistantContent) {
        assistantContent = `I've built and installed the "${extensionInstalled}" extension. Open the Extensions panel to see it in action!`;
      }
    } catch (e) {
      assistantContent += `\n\n(Extension deployment failed: ${e.message})`;
    }
  }

  // Check if the AI created notes
  let notesCreated = 0;
  const notesMatch = assistantContent.match(/<create_notes>\s*([\s\S]*?)\s*<\/create_notes>/);
  if (notesMatch) {
    try {
      const sanitized = notesMatch[1].replace(
        /"(?:[^"\\]|\\.)*"/g,
        (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
      );
      const notesList = JSON.parse(sanitized);
      if (Array.isArray(notesList)) {
        notesCreated = notesList.length;
      }
      assistantContent = assistantContent.replace(/<create_notes>[\s\S]*?<\/create_notes>\s*/, '').trim();
      if (!assistantContent) {
        assistantContent = `I've prepared ${notesCreated} note${notesCreated !== 1 ? 's' : ''} for creation.`;
      }
    } catch (e) {
      assistantContent += `\n\n(Note creation parse failed: ${e.message})`;
      notesCreated = 0;
    }
  }

  // Check if the AI created a table
  let tableCreated = null;
  const tableMatch = assistantContent.match(/<create_table>\s*([\s\S]*?)\s*<\/create_table>/);
  if (tableMatch) {
    try {
      const sanitized = tableMatch[1].replace(
        /"(?:[^"\\]|\\.)*"/g,
        (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
      );
      const tableData = JSON.parse(sanitized);

      // Create the table
      const tbl = await query(
        `INSERT INTO datatables (user_id, name, description) VALUES ($1, $2, $3)
         RETURNING id`,
        [req.userId, tableData.name || 'Imported Table', tableData.description || ''],
      );
      const tableId = tbl.rows[0].id;

      // Create fields
      const fieldIds = {};
      for (let i = 0; i < (tableData.fields || []).length; i++) {
        const f = tableData.fields[i];
        const fld = await query(
          `INSERT INTO datafields (table_id, name, type, options, position)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
          [tableId, f.name, f.type || 'text', JSON.stringify(f.options || {}), i],
        );
        fieldIds[f.name] = { id: fld.rows[0].id, type: f.type || 'text' };
      }

      // Create records
      let recordCount = 0;
      for (const record of (tableData.records || [])) {
        const rec = await query(
          `INSERT INTO datarecords (table_id, user_id) VALUES ($1, $2) RETURNING id`,
          [tableId, req.userId],
        );
        const recordId = rec.rows[0].id;

        for (const [fieldName, val] of Object.entries(record)) {
          const field = fieldIds[fieldName];
          if (!field) continue;
          let textVal = null, numberVal = null, jsonVal = null;
          if (field.type === 'number') numberVal = val === '' ? null : Number(val);
          else if (field.type === 'checkbox') jsonVal = Boolean(val);
          else if (field.type === 'multiselect') jsonVal = Array.isArray(val) ? val : [val];
          else textVal = val == null ? null : String(val);

          await query(
            `INSERT INTO datavalues (record_id, field_id, text_val, number_val, json_val)
             VALUES ($1, $2, $3, $4, $5)`,
            [recordId, field.id, textVal, numberVal, jsonVal != null ? JSON.stringify(jsonVal) : null],
          );
        }
        recordCount++;
      }

      tableCreated = { id: tableId, name: tableData.name, recordCount };
      assistantContent = assistantContent.replace(/<create_table>[\s\S]*?<\/create_table>\s*/, '').trim();
      if (!assistantContent) {
        assistantContent = `I've created the "${tableData.name}" table with ${recordCount} records. Switch to the Tables tab to see it!`;
      }
    } catch (e) {
      assistantContent += `\n\n(Table creation failed: ${e.message})`;
    }
  }

  // Store assistant message
  const assistantMsg = await query(
    `INSERT INTO ai_messages (conversation_id, role, content)
     VALUES ($1, 'assistant', $2)
     RETURNING id, role, content, created_at`,
    [req.params.id, assistantContent],
  );

  // Auto-title the conversation from the first user message
  if (convoCheck.rows[0].title === 'New chat') {
    try {
      const title = await chatCompletion(
        [{ role: 'user', content: `Generate a short title (max 6 words, no quotes) for a conversation that starts with: "${userContent}"` }],
        { maxTokens: 30, temperature: 0.5 },
      );
      const trimmed = title.replace(/^["']|["']$/g, '').slice(0, 80);
      await query(
        'UPDATE ai_conversations SET title = $1, updated_at = now() WHERE id = $2',
        [trimmed, req.params.id],
      );
    } catch {
      // Title generation is best-effort
    }
  } else {
    await query(
      'UPDATE ai_conversations SET updated_at = now() WHERE id = $1',
      [req.params.id],
    );
  }

  const response = {
    userMessage: userMsg.rows[0],
    assistantMessage: assistantMsg.rows[0],
  };
  if (extensionInstalled) {
    response.extensionInstalled = extensionInstalled;
    response.extensionId = extensionId;
  }
  if (notesCreated && notesMatch) {
    try {
      const sanitized = notesMatch[1].replace(
        /"(?:[^"\\]|\\.)*"/g,
        (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'),
      );
      response.createNotes = JSON.parse(sanitized);
    } catch { /* already handled */ }
  }
  if (tableCreated) {
    response.tableCreated = tableCreated;
  }
  res.json(response);
});
