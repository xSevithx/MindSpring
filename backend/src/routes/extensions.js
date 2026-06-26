import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';

export const extensionsRouter = Router();

const EXT_DIR = path.resolve(process.cwd(), 'extensions');

async function ensureExtDir() {
  await fs.mkdir(EXT_DIR, { recursive: true });
}

async function listExtensions() {
  await ensureExtDir();
  const entries = await fs.readdir(EXT_DIR, { withFileTypes: true });
  const extensions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(EXT_DIR, entry.name, 'manifest.json'), 'utf-8');
      extensions.push(JSON.parse(raw));
    } catch {
      // No manifest or invalid JSON — skip
    }
  }
  return extensions;
}

// Public: list enabled extensions (frontend loader calls this)
extensionsRouter.get('/', async (req, res) => {
  const all = await listExtensions();
  res.json(all.filter((e) => e.enabled !== false));
});

// Serve extension frontend files (JS, CSS)
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

extensionsRouter.get('/:id/files/*', async (req, res) => {
  const extId = req.params.id;
  const filePath = req.params[0];
  if (!extId || !filePath || filePath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const full = path.join(EXT_DIR, extId, filePath);
  try {
    const content = await fs.readFile(full, 'utf-8');
    const ext = path.extname(filePath);
    res.type(MIME[ext] || 'text/plain').send(content);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Auth-protected management routes below
extensionsRouter.use(requireAuth);

// List all extensions (including disabled)
extensionsRouter.get('/admin/list', async (req, res) => {
  res.json(await listExtensions());
});

// Get full extension details including file contents (for editor)
extensionsRouter.get('/admin/:id', async (req, res) => {
  const extPath = path.join(EXT_DIR, req.params.id);
  try {
    const manifestRaw = await fs.readFile(path.join(extPath, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    const entries = await fs.readdir(extPath);
    const files = {};
    for (const name of entries) {
      if (name === 'manifest.json') continue;
      const stat = await fs.stat(path.join(extPath, name));
      if (!stat.isFile()) continue;
      files[name] = await fs.readFile(path.join(extPath, name), 'utf-8');
    }
    res.json({ ...manifest, files });
  } catch {
    res.status(404).json({ error: 'Extension not found' });
  }
});

// Build/deploy an extension (AI builder writes here)
extensionsRouter.post('/build', async (req, res) => {
  const { id, name, description, files } = req.body;
  if (!id || !files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Missing id or files' });
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({ error: 'Extension id must be lowercase alphanumeric with dashes' });
  }

  const extPath = path.join(EXT_DIR, id);
  await fs.mkdir(extPath, { recursive: true });

  // Write manifest if not included in files
  if (!files['manifest.json']) {
    files['manifest.json'] = JSON.stringify({
      id,
      name: name || id,
      description: description || '',
      version: '1.0.0',
      enabled: true,
      frontend: {
        panel: files['panel.js'] ? 'panel.js' : undefined,
        styles: files['styles.css'] ? 'styles.css' : undefined,
      },
    }, null, 2);
  }

  for (const [filename, content] of Object.entries(files)) {
    if (filename.includes('..') || filename.includes('/')) continue;
    await fs.writeFile(path.join(extPath, filename), content, 'utf-8');
  }

  // Re-read the written manifest to return it
  const raw = await fs.readFile(path.join(extPath, 'manifest.json'), 'utf-8');
  res.status(201).json(JSON.parse(raw));
});

// Enable/disable an extension
extensionsRouter.patch('/:id', async (req, res) => {
  const manifestPath = path.join(EXT_DIR, req.params.id, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (req.body.enabled !== undefined) manifest.enabled = req.body.enabled;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    res.json(manifest);
  } catch {
    res.status(404).json({ error: 'Extension not found' });
  }
});

// Delete an extension
extensionsRouter.delete('/:id', async (req, res) => {
  const extPath = path.join(EXT_DIR, req.params.id);
  try {
    await fs.rm(extPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Extension not found' });
  }
});
