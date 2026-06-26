import { deriveKey, encryptNote, decryptNote, assertCryptoAvailable } from './crypto.js';

const API = '/api';
let cryptoKey = null;     // AES key, lives only in memory for this session
let notes = [];           // [{ id, title, body, created_at, updated_at }]
let activeId = null;
let saveTimer = null;
let authMode = 'login';
let aiEnabled = false;
let autoSync = false;
let conversations = [];
let activeConvoId = null;
let aiSending = false;

const $ = (id) => document.getElementById(id);

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- Auth ----------
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.mode === mode));
  $('auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('pw-hint').classList.toggle('hidden', mode === 'login');
  $('auth-error').textContent = '';
}

async function handleAuth() {
  const email = $('email').value.trim();
  const password = $('password').value;
  $('auth-error').textContent = '';
  if (!email || password.length < 10) {
    $('auth-error').textContent = 'Enter an email and a passphrase of at least 10 characters.';
    return;
  }
  $('auth-submit').disabled = true;
  try {
    const { encSalt } = await api(`/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    // Derive the key in-browser. The password is now discarded.
    cryptoKey = await deriveKey(password, encSalt);
    $('password').value = '';
    await enterApp(email);
  } catch (e) {
    $('auth-error').textContent = e.message;
  } finally {
    $('auth-submit').disabled = false;
  }
}

async function enterApp(email) {
  $('user-email').textContent = email;
  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  window.inkwell._init({
    getActiveNote: () => notes.find((n) => n.id === activeId) || null,
    getNotes: () => [...notes],
    api,
  });
  await loadNotes();
  await loadExtensions();
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  cryptoKey = null; notes = []; activeId = null;
  aiEnabled = false; conversations = []; activeConvoId = null; aiSending = false;
  $('app-view').classList.add('hidden');
  $('ai-panel').classList.add('hidden');
  $('ext-panel').classList.add('hidden');
  $('auth-view').classList.remove('hidden');
  $('note-list').innerHTML = '';
}

// ---------- Notes ----------
async function loadNotes() {
  const rows = await api('/notes');
  notes = [];
  for (const row of rows) {
    try {
      const data = await decryptNote(cryptoKey, row.iv, row.ciphertext);
      notes.push({ id: row.id, ...data, created_at: row.created_at, updated_at: row.updated_at });
    } catch {
      // A note we can't decrypt (shouldn't happen with the right key) — skip.
    }
  }
  renderList();
  if (notes.length) selectNote(notes[0].id);
  else showEmpty();
  window.inkwell._emit('notesLoad', notes);
}

function renderList(filter = '') {
  const list = $('note-list');
  list.innerHTML = '';
  const q = filter.toLowerCase();
  const shown = notes.filter((n) =>
    !q || (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
  for (const n of shown) {
    const li = document.createElement('li');
    li.className = 'note-item' + (n.id === activeId ? ' is-active' : '');
    li.dataset.id = n.id;
    const title = document.createElement('div');
    title.className = 'note-item-title';
    title.textContent = n.title || 'Untitled';
    const meta = document.createElement('div');
    meta.className = 'note-item-meta';
    meta.textContent = new Date(n.updated_at).toLocaleDateString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric' });
    li.append(title, meta);
    li.addEventListener('click', () => selectNote(n.id));
    list.appendChild(li);
  }
}

function showEmpty() {
  activeId = null;
  $('empty-state').classList.remove('hidden');
  $('editor-pane').classList.add('hidden');
}

function selectNote(id) {
  activeId = id;
  const n = notes.find((x) => x.id === id);
  if (!n) return showEmpty();
  $('empty-state').classList.add('hidden');
  $('editor-pane').classList.remove('hidden');
  $('note-title').value = n.title || '';
  $('note-body').value = n.body || '';
  $('save-status').textContent = 'Saved';
  renderList($('search').value);
  window.inkwell._emit('noteSelect', n);
}

async function newNote() {
  const payload = { title: '', body: '' };
  const enc = await encryptNote(cryptoKey, payload);
  const row = await api('/notes', { method: 'POST', body: JSON.stringify(enc) });
  const created = { id: row.id, ...payload, created_at: row.created_at, updated_at: row.updated_at };
  notes.unshift(created);
  renderList();
  selectNote(row.id);
  $('note-title').focus();
  window.inkwell._emit('noteCreate', created);
}

function scheduleSave() {
  $('save-status').textContent = 'Saving…';
  $('save-status').classList.add('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveActive, 700);
}

async function saveActive() {
  const n = notes.find((x) => x.id === activeId);
  if (!n) return;
  n.title = $('note-title').value;
  n.body = $('note-body').value;
  try {
    const enc = await encryptNote(cryptoKey, { title: n.title, body: n.body });
    const row = await api(`/notes/${n.id}`, { method: 'PUT', body: JSON.stringify(enc) });
    n.updated_at = row.updated_at;
    $('save-status').textContent = 'Saved';
    $('save-status').classList.remove('saving');
    renderList($('search').value);
    window.inkwell._emit('noteSave', n);
    if (aiEnabled && autoSync) {
      syncSingleNote(n).catch(() => {});
    }
  } catch (e) {
    $('save-status').textContent = 'Save failed';
    $('save-status').classList.remove('saving');
  }
}

async function deleteActive() {
  if (!activeId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  const deletedId = activeId;
  await api(`/notes/${activeId}`, { method: 'DELETE' });
  notes = notes.filter((n) => n.id !== activeId);
  renderList($('search').value);
  window.inkwell._emit('noteDelete', deletedId);
  if (notes.length) selectNote(notes[0].id);
  else showEmpty();
}

// ---------- Export ----------
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJSON() {
  const data = notes.map(({ id, title, body, created_at, updated_at }) =>
    ({ id, title, body, created_at, updated_at }));
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`mindspring-export-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function exportMarkdown() {
  const stamp = new Date().toISOString().slice(0, 10);
  const md = notes.map((n) => {
    const date = new Date(n.updated_at).toLocaleString();
    return `# ${n.title || 'Untitled'}\n\n_Last updated: ${date}_\n\n${n.body || ''}`;
  }).join('\n\n---\n\n');
  downloadFile(`mindspring-export-${stamp}.md`, md, 'text/markdown');
}

function toggleExportMenu() {
  $('export-menu').classList.toggle('hidden');
}

function handleExport(format) {
  $('export-menu').classList.add('hidden');
  if (!notes.length) return;
  if (format === 'json') exportJSON();
  else exportMarkdown();
}

// ---------- AI Chat ----------
function toggleAIPanel() {
  const panel = $('ai-panel');
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (!isOpen && !conversations.length) {
    loadConversations();
  }
}

async function loadConversations() {
  try {
    conversations = await api('/ai/conversations');
    renderConvoTabs();
    if (conversations.length && !activeConvoId) {
      await selectConversation(conversations[0].id);
    }
  } catch { /* AI may not be configured */ }
}

function renderConvoTabs() {
  const ul = $('ai-convo-tabs');
  ul.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    li.className = 'ai-tab' + (c.id === activeConvoId ? ' is-active' : '');
    li.dataset.id = c.id;
    const label = document.createElement('span');
    label.className = 'ai-tab-label';
    label.textContent = c.title || 'New chat';
    const del = document.createElement('button');
    del.className = 'ai-tab-close';
    del.textContent = '\u00d7';
    del.title = 'Delete chat';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(c.id); });
    li.append(label, del);
    li.addEventListener('click', () => selectConversation(c.id));
    ul.appendChild(li);
  }
}

async function selectConversation(id) {
  activeConvoId = id;
  renderConvoTabs();
  try {
    const convo = await api(`/ai/conversations/${id}`);
    renderMessages(convo.messages || []);
  } catch {
    renderMessages([]);
  }
}

async function createConversation() {
  try {
    const convo = await api('/ai/conversations', { method: 'POST' });
    conversations.unshift(convo);
    await selectConversation(convo.id);
  } catch (e) {
    console.error('Failed to create conversation', e);
  }
}

async function deleteConversation(id) {
  try {
    await api(`/ai/conversations/${id}`, { method: 'DELETE' });
    conversations = conversations.filter((c) => c.id !== id);
    if (activeConvoId === id) {
      activeConvoId = null;
      if (conversations.length) {
        await selectConversation(conversations[0].id);
      } else {
        renderConvoTabs();
        renderMessages([]);
      }
    } else {
      renderConvoTabs();
    }
  } catch (e) {
    console.error('Failed to delete conversation', e);
  }
}

function renderMessages(msgs) {
  const container = $('ai-messages');
  container.innerHTML = '';
  if (!msgs.length) {
    container.innerHTML = '<div class="ai-empty-chat">Ask anything about your notes.</div>';
    return;
  }
  for (const m of msgs) {
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${m.role}`;
    div.textContent = m.content;
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

function appendMessage(role, content) {
  const container = $('ai-messages');
  const empty = container.querySelector('.ai-empty-chat');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `ai-msg ai-msg-${role}`;
  div.textContent = content;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

let attachedFileData = null;

function handleFileUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheets = [];
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        if (!rows.length) continue;
        const header = rows[0].map((h) => h != null ? String(h).trim() : '');
        const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== ''));
        let text = `Sheet: ${name}\nColumns: ${header.join(' | ')}\n`;
        text += dataRows.slice(0, 50).map((r) =>
          header.map((h, i) => `${h}: ${r[i] ?? ''}`).join(' | ')
        ).join('\n');
        if (dataRows.length > 50) text += `\n... and ${dataRows.length - 50} more rows`;
        sheets.push({ name, header, rowCount: dataRows.length, text, rawRows: dataRows });
      }
      attachedFileData = { fileName: file.name, sheets };
      $('ai-file-name').textContent = `${file.name} (${sheets.reduce((s, sh) => s + sh.rowCount, 0)} rows across ${sheets.length} sheet${sheets.length !== 1 ? 's' : ''})`;
      $('ai-file-preview').classList.remove('hidden');
    } catch (err) {
      showToast('Failed to parse file: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
}

function clearAttachedFile() {
  attachedFileData = null;
  $('ai-file-preview').classList.add('hidden');
  $('ai-file-name').textContent = '';
}

function guessFieldType(header, sampleValues) {
  const h = header.toLowerCase();
  if (h.includes('url') || h.includes('link') || h.includes('http')) return 'url';
  if (h.includes('date') || h.includes('created') || h.includes('updated')) return 'date';

  const textHints = ['name', 'account', 'login', 'user', 'host', 'domain', 'description',
    'function', 'owner', 'admin', 'fqdn', 'permission', 'path', 'comment', 'note', 'tier',
    'type', 'region', 'env', 'product', 'service', 'server', 'instance', 'database'];
  if (textHints.some((w) => h.includes(w))) return 'text';

  if (h.includes('port') || h.includes('count') || h.includes('number') || h.includes('qty')) return 'number';

  const nonEmpty = sampleValues.filter((v) => v !== '' && v != null);
  if (!nonEmpty.length) return 'text';
  if (nonEmpty.length >= 3 && nonEmpty.every((v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())))) return 'number';
  if (nonEmpty.some((v) => String(v).length > 200)) return 'longtext';
  return 'text';
}

async function handleSpreadsheetImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const btn = $('import-spreadsheet-btn');
  btn.disabled = true;
  btn.textContent = 'Reading file...';

  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });

    const sheets = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      if (!rows.length) continue;
      const header = rows[0].map((h) => h != null ? String(h).trim() : '');
      const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== ''));
      if (!header.length || !dataRows.length) continue;
      sheets.push({ name, header, rawRows: dataRows });
    }

    if (!sheets.length) {
      showToast('No data found in file', 'error');
      return;
    }

    btn.textContent = `Importing ${sheets.length} table${sheets.length !== 1 ? 's' : ''}...`;
    attachedFileData = { fileName: file.name, sheets };
    await importFileAsTables();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '\u{1F4C4} Import Spreadsheet';
  }
}

async function importFileAsTables() {
  if (!attachedFileData || !attachedFileData.sheets.length) {
    showToast('No file attached', 'error');
    return;
  }

  const btn = $('ai-file-import');
  btn.disabled = true;
  btn.textContent = 'Importing...';
  let imported = 0;

  try {
    for (const sheet of attachedFileData.sheets) {
      if (!sheet.header.length || !sheet.rawRows.length) continue;

      // Determine field types from sample data
      const fields = sheet.header.map((name, i) => {
        const samples = sheet.rawRows.slice(0, 20).map((r) => r[i]);
        return { name: String(name || `Column ${i + 1}`), type: guessFieldType(String(name), samples) };
      });

      // Create table with fields
      const tbl = await api('/tables', {
        method: 'POST',
        body: JSON.stringify({
          name: sheet.name,
          description: `Imported from ${attachedFileData.fileName}`,
          fields,
        }),
      });

      // Build a field ID map from the response
      const fieldMap = {};
      for (const f of tbl.fields) {
        fieldMap[f.name] = f.id;
      }

      // Build all records and send in a single batch
      const batchRecords = [];
      for (const row of sheet.rawRows) {
        const values = {};
        for (let i = 0; i < fields.length; i++) {
          const fId = fieldMap[fields[i].name];
          if (!fId) continue;
          let val = row[i];
          if (val == null || val === '') continue;
          if (fields[i].type === 'number') {
            const n = Number(val);
            if (isNaN(n)) val = String(val);
            else val = n;
          } else {
            val = String(val);
          }
          values[fId] = val;
        }
        if (Object.keys(values).length) batchRecords.push({ values });
      }
      if (batchRecords.length) {
        await api(`/tables/${tbl.id}/records/batch`, {
          method: 'POST',
          body: JSON.stringify({ records: batchRecords }),
        });
      }
      imported++;
    }

    clearAttachedFile();
    showToast(`Imported ${imported} table${imported !== 1 ? 's' : ''} successfully!`, 'info');

    // Switch to tables view and reload
    switchView('tables');
    await loadTables();
  } catch (e) {
    showToast('Import failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import as Tables';
  }
}

async function sendAIMessage() {
  const input = $('ai-input');
  const text = input.value.trim();
  if (!text || aiSending) return;

  if (!activeConvoId) {
    await createConversation();
    if (!activeConvoId) return;
  }

  aiSending = true;
  input.value = '';
  $('ai-send').disabled = true;

  let messageContent = text;
  if (attachedFileData) {
    const fileSummary = attachedFileData.sheets.map((s) => s.text).join('\n\n');
    messageContent = `[Attached file: ${attachedFileData.fileName}]\n\n${fileSummary}\n\nUser request: ${text}`;
    appendMessage('user', `📎 ${attachedFileData.fileName}\n${text}`);
  } else {
    appendMessage('user', text);
  }
  clearAttachedFile();
  const thinkingEl = appendMessage('assistant', 'Thinking...');

  try {
    const noteContext = notes.map((n) => ({ id: n.id, title: n.title, body: n.body }));
    const result = await api(`/ai/conversations/${activeConvoId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: messageContent, noteContext }),
    });

    thinkingEl.textContent = result.assistantMessage.content;

    // If the AI created notes, encrypt and save them
    if (result.createNotes && Array.isArray(result.createNotes)) {
      let created = 0;
      for (const n of result.createNotes) {
        try {
          const { iv, ciphertext } = await encryptNote(cryptoKey, n.title || 'Untitled', n.body || '');
          await api('/notes', {
            method: 'POST',
            body: JSON.stringify({ iv, ciphertext }),
          });
          created++;
        } catch { /* skip failed notes */ }
      }
      if (created) {
        showToast(`Created ${created} note${created !== 1 ? 's' : ''}`, 'info');
        await loadNotes();
      }
    }

    // If the AI created a table, refresh table list
    if (result.tableCreated) {
      showToast(`Table "${result.tableCreated.name}" created with ${result.tableCreated.recordCount} records`, 'info');
    }

    // If the AI built an extension, hot-load it
    if (result.extensionInstalled) {
      showToast(`Extension "${result.extensionInstalled}" installed!`, 'info');
      await hotReloadExtension(result.extensionId);
      setTimeout(renderExtPanels, 500);
    }

    // Refresh tab title if it changed
    const convo = conversations.find((c) => c.id === activeConvoId);
    if (convo && convo.title === 'New chat') {
      const updated = await api(`/ai/conversations/${activeConvoId}`).catch(() => null);
      if (updated) {
        convo.title = updated.title;
        renderConvoTabs();
      }
    }
  } catch (e) {
    thinkingEl.textContent = `Error: ${e.message}`;
    thinkingEl.classList.add('ai-msg-error');
  } finally {
    aiSending = false;
    $('ai-send').disabled = false;
    $('ai-input').focus();
  }
}

// ---------- Settings ----------
function openSettings() {
  $('settings-overlay').classList.remove('hidden');
  loadAIStatus();
  renderExtensionSettings();
}

function closeSettings() {
  $('settings-overlay').classList.add('hidden');
}

async function loadAIStatus() {
  try {
    const status = await api('/ai/status');
    aiEnabled = status.aiEnabled;
    if (aiEnabled) {
      let statusParts = [`Notes: ${status.syncedCount}/${status.totalNotes}`];
      if (status.totalRecords > 0) statusParts.push(`Records: ${status.syncedRecords}/${status.totalRecords}`);
      $('ai-status-text').textContent = `Synced — ${statusParts.join(' · ')}`;
    } else {
      $('ai-status-text').textContent = 'AI not enabled';
    }
    $('ai-warning').classList.toggle('hidden', aiEnabled);
    $('ai-sync-btn').textContent = aiEnabled ? 'Re-sync all' : 'Sync to AI';
  } catch {
    $('ai-status-text').textContent = 'AI not available (check API key)';
    $('ai-sync-btn').disabled = true;
  }
}

async function syncToAI() {
  if (!notes.length && !userTables.length) {
    showToast('Nothing to sync — create some notes or tables first', 'error');
    return;
  }

  if (!aiEnabled) {
    const ok = confirm(
      'This will send your decrypted note content and table data to the server and Hyperbolic\'s AI API. '
      + 'Embeddings will be stored server-side. Continue?'
    );
    if (!ok) return;
  }

  $('ai-sync-btn').disabled = true;
  $('ai-sync-progress').textContent = 'Syncing...';

  try {
    const payload = notes.map((n) => ({ id: n.id, title: n.title || '', body: n.body || '' }));
    const result = await api('/ai/sync', {
      method: 'POST',
      body: JSON.stringify({ notes: payload }),
    });
    aiEnabled = true;
    let syncMsg = `Synced ${result.synced} notes`;
    if (result.syncedRecords > 0) syncMsg += ` + ${result.syncedRecords} table records`;
    $('ai-sync-progress').textContent = syncMsg;
    $('ai-warning').classList.add('hidden');
    $('ai-sync-btn').textContent = 'Re-sync all';
    await loadAIStatus();
  } catch (e) {
    $('ai-sync-progress').textContent = `Sync failed: ${e.message}`;
  } finally {
    $('ai-sync-btn').disabled = false;
  }
}

async function syncSingleNote(note) {
  await api('/ai/sync/note', {
    method: 'POST',
    body: JSON.stringify({ id: note.id, title: note.title || '', body: note.body || '' }),
  });
}

async function purgeAI() {
  if (!confirm('This will delete all AI data: embeddings, conversations, and chat history. Continue?')) return;
  try {
    await api('/ai/sync', { method: 'DELETE' });
    aiEnabled = false;
    conversations = [];
    activeConvoId = null;
    $('ai-messages').innerHTML = '<div class="ai-empty-chat">Ask anything about your notes.</div>';
    renderConvoTabs();
    await loadAIStatus();
  } catch (e) {
    console.error('Purge failed', e);
  }
}

// ---------- Extensions ----------
let loadedExtensions = [];

async function loadExtensions() {
  try {
    loadedExtensions = await api('/extensions');
    for (const ext of loadedExtensions) {
      if (ext.frontend?.panel) {
        const script = document.createElement('script');
        script.src = `/api/extensions/${ext.id}/files/${ext.frontend.panel}`;
        document.body.appendChild(script);
      }
      if (ext.frontend?.styles) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `/api/extensions/${ext.id}/files/${ext.frontend.styles}`;
        document.head.appendChild(link);
      }
    }
  } catch { /* extensions endpoint may not exist yet */ }
}

async function hotReloadExtension(extId) {
  // Remove old script/link for this extension
  document.querySelectorAll(`script[src*="/extensions/${extId}/"]`).forEach((s) => s.remove());
  document.querySelectorAll(`link[href*="/extensions/${extId}/"]`).forEach((l) => l.remove());

  try {
    const exts = await api('/extensions');
    const ext = exts.find((e) => e.id === extId);
    if (!ext) return;

    if (ext.frontend?.panel) {
      const script = document.createElement('script');
      script.src = `/api/extensions/${ext.id}/files/${ext.frontend.panel}?t=${Date.now()}`;
      document.body.appendChild(script);
    }
    if (ext.frontend?.styles) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/api/extensions/${ext.id}/files/${ext.frontend.styles}?t=${Date.now()}`;
      document.head.appendChild(link);
    }
  } catch { /* skip */ }
}

function toggleExtPanel() {
  $('ext-panel').classList.toggle('hidden');
}

function renderExtPanels() {
  const tabs = $('ext-tabs');
  const content = $('ext-content');
  const panels = window.inkwell._panels;
  tabs.innerHTML = '';
  content.innerHTML = '';

  if (!panels.length) {
    content.innerHTML = '<div class="ai-empty-chat">No extension panels installed.</div>';
    return;
  }

  for (const p of panels) {
    const section = document.createElement('div');
    section.className = 'ext-section';
    section.id = `ext-panel-${p.id}`;
    const heading = document.createElement('div');
    heading.className = 'ext-section-head';
    heading.textContent = p.title || p.id;
    const body = document.createElement('div');
    body.className = 'ext-section-body';
    section.append(heading, body);
    content.appendChild(section);
    try { p.render(body); } catch (e) { body.textContent = `Error: ${e.message}`; }
  }
}

function showToast(message, type = 'info') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-fade'); }, 3000);
  setTimeout(() => { toast.remove(); }, 3500);
}

async function renderExtensionSettings() {
  const container = $('ext-list-settings');
  try {
    const exts = await api('/extensions/admin/list');
    if (!exts.length) {
      container.innerHTML = '<span class="ai-status">No extensions installed. Ask the AI to build one!</span>';
      return;
    }
    container.innerHTML = '';
    for (const ext of exts) {
      const row = document.createElement('div');
      row.className = 'ext-settings-row';
      const info = document.createElement('div');
      info.className = 'ext-settings-info';
      info.innerHTML = `<strong>${ext.name || ext.id}</strong><br><span class="ext-settings-desc">${ext.description || ''}</span>`;
      const actions = document.createElement('div');
      actions.className = 'ext-settings-actions';
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn-ghost';
      toggleBtn.textContent = ext.enabled !== false ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', async () => {
        await api(`/extensions/${ext.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: ext.enabled === false }),
        });
        renderExtensionSettings();
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-ghost danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete extension "${ext.name || ext.id}"?`)) return;
        await api(`/extensions/${ext.id}`, { method: 'DELETE' });
        renderExtensionSettings();
      });
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-ghost';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openExtEditor(ext.id));
      actions.append(editBtn, toggleBtn, delBtn);
      row.append(info, actions);
      container.appendChild(row);
    }
  } catch {
    container.innerHTML = '<span class="ai-status">Could not load extensions</span>';
  }
}

// ---------- Tables (Airtable-style) ----------
let userTables = [];
let activeTableId = null;
let activeTableFields = [];
let activeTableRecords = [];
let currentView = 'notes'; // 'notes' | 'tables'

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.sidebar-nav-tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.view === view);
  });
  const notesSidebar = $('notes-sidebar');
  const tablesSidebar = $('tables-sidebar');
  const editorSection = document.querySelector('.editor');
  const tablesSection = $('tables-view');

  if (view === 'notes') {
    notesSidebar.classList.remove('hidden');
    tablesSidebar.classList.add('hidden');
    editorSection.classList.remove('hidden');
    tablesSection.classList.add('hidden');
  } else {
    notesSidebar.classList.add('hidden');
    tablesSidebar.classList.remove('hidden');
    editorSection.classList.add('hidden');
    tablesSection.classList.remove('hidden');
    loadTables();
  }
}

async function loadTables() {
  try {
    userTables = await api('/tables');
    renderTableList();
  } catch { userTables = []; }
}

function renderTableList() {
  const list = $('table-list');
  list.innerHTML = '';
  if (!userTables.length) {
    list.innerHTML = '<li style="padding:1rem;color:var(--ink-faint);font-size:0.88rem">No tables yet</li>';
    return;
  }
  for (const tbl of userTables) {
    const li = document.createElement('li');
    li.className = 'note-item' + (tbl.id === activeTableId ? ' is-active' : '');
    li.innerHTML = `<div class="note-item-title">${esc(tbl.name)}</div>
      <div class="note-item-meta">${tbl.description || ''}</div>`;
    li.addEventListener('click', () => openTable(tbl.id));
    list.appendChild(li);
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function openTable(tableId) {
  activeTableId = tableId;
  renderTableList();
  $('tbl-empty').classList.add('hidden');
  $('tbl-grid-pane').classList.remove('hidden');

  const tbl = userTables.find((t) => t.id === tableId);
  $('tbl-grid-title').textContent = tbl?.name || '';

  try {
    const data = await api(`/tables/${tableId}/records`);
    activeTableFields = data.fields;
    activeTableRecords = data.records;
    renderGrid();
  } catch (e) {
    showToast('Failed to load table: ' + e.message, 'error');
  }
}

function renderGrid() {
  const thead = $('tbl-grid-head-row');
  const tbody = $('tbl-grid-body');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const headerRow = document.createElement('tr');
  for (const f of activeTableFields) {
    const th = document.createElement('th');
    const label = document.createElement('span');
    label.innerHTML = `${esc(f.name)}<span class="th-type">${f.type}</span>`;
    th.appendChild(label);
    const delBtn = document.createElement('button');
    delBtn.className = 'th-del';
    delBtn.innerHTML = '&#x2715;';
    delBtn.title = `Delete "${f.name}" field`;
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete the "${f.name}" column and all its data?`)) return;
      try {
        await api(`/tables/${activeTableId}/fields/${f.id}`, { method: 'DELETE' });
        await openTable(activeTableId);
      } catch (e) { showToast('Delete field failed: ' + e.message, 'error'); }
    });
    th.appendChild(delBtn);
    headerRow.appendChild(th);
  }
  const actTh = document.createElement('th');
  actTh.textContent = '';
  headerRow.appendChild(actTh);
  thead.appendChild(headerRow);

  for (const rec of activeTableRecords) {
    const tr = document.createElement('tr');
    for (const f of activeTableFields) {
      const td = document.createElement('td');
      td.appendChild(renderCell(f, rec.values[f.id], rec.id));
      tr.appendChild(td);
    }
    const actTd = document.createElement('td');
    actTd.className = 'tbl-cell-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-ghost danger';
    delBtn.textContent = 'Del';
    delBtn.addEventListener('click', () => deleteRecord(rec.id));
    actTd.appendChild(delBtn);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }
}

function renderCell(field, value, recordId) {
  const wrap = document.createElement('span');

  if (field.type === 'checkbox') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tbl-cell-check';
    cb.checked = Boolean(value);
    cb.addEventListener('change', () => {
      saveCellValue(recordId, field.id, cb.checked);
    });
    wrap.appendChild(cb);
    return wrap;
  }

  if (field.type === 'url') {
    wrap.className = 'tbl-cell-url';
    if (value) {
      const a = document.createElement('a');
      a.href = value;
      a.target = '_blank';
      a.textContent = value;
      wrap.appendChild(a);
    }
    wrap.addEventListener('dblclick', () => startInlineEdit(wrap, field, value, recordId));
    return wrap;
  }

  if (field.type === 'link') {
    wrap.className = 'tbl-cell-link';
    if (Array.isArray(value) && value.length) {
      wrap.textContent = value.map((v) => v.display || v.id).join(', ');
    }
    return wrap;
  }

  if (field.type === 'select') {
    const sel = document.createElement('select');
    sel.className = 'tbl-cell-edit';
    sel.style.minWidth = '100px';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '—';
    sel.appendChild(emptyOpt);
    const choices = field.options?.choices || [];
    for (const c of choices) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => saveCellValue(recordId, field.id, sel.value));
    wrap.appendChild(sel);
    return wrap;
  }

  // For text, longtext, number, date — show text, double-click to edit
  wrap.textContent = value ?? '';
  wrap.addEventListener('dblclick', () => startInlineEdit(wrap, field, value, recordId));
  return wrap;
}

function startInlineEdit(wrap, field, value, recordId) {
  const isLong = field.type === 'longtext';
  const input = document.createElement(isLong ? 'textarea' : 'input');
  input.className = 'tbl-cell-edit';
  if (field.type === 'number') input.type = 'number';
  else if (field.type === 'date') input.type = 'date';
  else input.type = 'text';
  input.value = value ?? '';
  wrap.textContent = '';
  wrap.appendChild(input);
  input.focus();

  const finish = () => {
    const newVal = input.value;
    wrap.textContent = newVal;
    wrap.addEventListener('dblclick', () => startInlineEdit(wrap, field, newVal, recordId));
    saveCellValue(recordId, field.id, newVal);
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !isLong) { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { wrap.textContent = value ?? ''; }
  });
}

async function saveCellValue(recordId, fieldId, value) {
  try {
    await api(`/tables/${activeTableId}/records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ values: { [fieldId]: value } }),
    });
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function deleteRecord(recordId) {
  if (!confirm('Delete this record?')) return;
  try {
    await api(`/tables/${activeTableId}/records/${recordId}`, { method: 'DELETE' });
    activeTableRecords = activeTableRecords.filter((r) => r.id !== recordId);
    renderGrid();
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

async function deleteActiveTable() {
  if (!activeTableId) return;
  const tbl = userTables.find((t) => t.id === activeTableId);
  const tableName = tbl?.name || 'this table';

  if (!confirm(`Are you sure you want to delete "${tableName}"?\nThis will permanently remove all columns, records, and data in this table.`)) return;

  const typed = prompt(`To confirm, type the table name exactly: "${tableName}"`);
  if (typed !== tableName) {
    if (typed !== null) showToast('Table name did not match. Deletion cancelled.', 'error');
    return;
  }

  try {
    await api(`/tables/${activeTableId}`, { method: 'DELETE' });
    showToast(`Table "${tableName}" deleted`, 'info');
    activeTableId = null;
    activeTableFields = [];
    activeTableRecords = [];
    $('tbl-grid-pane').classList.add('hidden');
    $('tbl-empty').classList.remove('hidden');
    await loadTables();
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

// -- New table modal --
function openNewTableModal() {
  $('new-table-name').value = '';
  $('new-table-desc').value = '';
  $('new-table-overlay').classList.remove('hidden');
  $('new-table-name').focus();
}
function closeNewTableModal() { $('new-table-overlay').classList.add('hidden'); }

async function createTable() {
  const name = $('new-table-name').value.trim();
  if (!name) { showToast('Table name is required', 'error'); return; }
  try {
    const tbl = await api('/tables', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: $('new-table-desc').value.trim(),
        fields: [{ name: 'Name', type: 'text' }],
      }),
    });
    closeNewTableModal();
    await loadTables();
    openTable(tbl.id);
  } catch (e) {
    showToast('Create failed: ' + e.message, 'error');
  }
}

// -- Add field modal --
function openFieldModal() {
  $('field-name').value = '';
  $('field-type').value = 'text';
  $('field-options-wrap').classList.add('hidden');
  $('field-link-wrap').classList.add('hidden');
  $('field-options-input').value = '';
  $('field-overlay').classList.remove('hidden');
  $('field-name').focus();
}
function closeFieldModal() { $('field-overlay').classList.add('hidden'); }

function onFieldTypeChange() {
  const t = $('field-type').value;
  $('field-options-wrap').classList.toggle('hidden', t !== 'select' && t !== 'multiselect');
  if (t === 'link') {
    $('field-link-wrap').classList.remove('hidden');
    const sel = $('field-link-table');
    sel.innerHTML = '';
    for (const tbl of userTables) {
      const opt = document.createElement('option');
      opt.value = tbl.id;
      opt.textContent = tbl.name;
      sel.appendChild(opt);
    }
  } else {
    $('field-link-wrap').classList.add('hidden');
  }
}

async function createField() {
  const name = $('field-name').value.trim();
  const type = $('field-type').value;
  if (!name) { showToast('Field name is required', 'error'); return; }

  const options = {};
  if (type === 'select' || type === 'multiselect') {
    options.choices = $('field-options-input').value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'link') {
    options.linkedTableId = $('field-link-table').value;
  }

  try {
    await api(`/tables/${activeTableId}/fields`, {
      method: 'POST',
      body: JSON.stringify({ name, type, options }),
    });
    closeFieldModal();
    await openTable(activeTableId);
  } catch (e) {
    showToast('Add field failed: ' + e.message, 'error');
  }
}

// -- Record form modal --
let editingRecordId = null;

function openRecordModal(recordId) {
  editingRecordId = recordId || null;
  $('record-modal-title').textContent = recordId ? 'Edit Record' : 'Add Record';
  const container = $('record-fields');
  container.innerHTML = '';

  const existingValues = recordId
    ? (activeTableRecords.find((r) => r.id === recordId)?.values || {})
    : {};

  for (const f of activeTableFields) {
    const group = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'record-field-label';
    label.textContent = f.name;
    group.appendChild(label);

    const val = existingValues[f.id];

    if (f.type === 'longtext') {
      const ta = document.createElement('textarea');
      ta.className = 'record-field-input';
      ta.dataset.fieldId = f.id;
      ta.value = val ?? '';
      group.appendChild(ta);
    } else if (f.type === 'checkbox') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tbl-cell-check';
      cb.dataset.fieldId = f.id;
      cb.checked = Boolean(val);
      group.appendChild(cb);
    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'field-select';
      sel.dataset.fieldId = f.id;
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '—';
      sel.appendChild(emptyOpt);
      for (const c of (f.options?.choices || [])) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        if (c === val) opt.selected = true;
        sel.appendChild(opt);
      }
      group.appendChild(sel);
    } else if (f.type === 'multiselect') {
      const wrap = document.createElement('div');
      wrap.dataset.fieldId = f.id;
      wrap.dataset.fieldType = 'multiselect';
      const currentVals = Array.isArray(val) ? val : [];
      for (const c of (f.options?.choices || [])) {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:flex;align-items:center;gap:0.3rem;font-size:0.85rem;margin:0.2rem 0';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = c;
        cb.checked = currentVals.includes(c);
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(c));
        wrap.appendChild(lbl);
      }
      group.appendChild(wrap);
    } else if (f.type === 'link') {
      const sel = document.createElement('select');
      sel.className = 'field-select';
      sel.dataset.fieldId = f.id;
      sel.dataset.fieldType = 'link';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '— Select —';
      sel.appendChild(emptyOpt);
      // Load records from linked table async
      const linkedId = f.options?.linkedTableId;
      if (linkedId) {
        api(`/tables/${linkedId}/records`).then((data) => {
          for (const r of data.records) {
            const firstField = data.fields[0];
            const display = firstField ? (r.values[firstField.id] || r.id) : r.id;
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = display;
            const currentLinks = Array.isArray(val) ? val.map((v) => v.id || v) : [];
            if (currentLinks.includes(r.id)) opt.selected = true;
            sel.appendChild(opt);
          }
        }).catch(() => {});
      }
      group.appendChild(sel);
    } else {
      const input = document.createElement('input');
      input.className = 'record-field-input';
      input.dataset.fieldId = f.id;
      if (f.type === 'number') input.type = 'number';
      else if (f.type === 'date') input.type = 'date';
      else if (f.type === 'url') input.type = 'url';
      else input.type = 'text';
      input.value = val ?? '';
      group.appendChild(input);
    }
    container.appendChild(group);
  }

  $('record-overlay').classList.remove('hidden');
}
function closeRecordModal() { $('record-overlay').classList.add('hidden'); }

async function saveRecord() {
  const values = {};
  for (const f of activeTableFields) {
    const el = $('record-fields').querySelector(`[data-field-id="${f.id}"]`);
    if (!el) {
      // Check for multiselect container
      const msWrap = $('record-fields').querySelector(`[data-field-id="${f.id}"][data-field-type="multiselect"]`);
      if (msWrap) {
        values[f.id] = [...msWrap.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
      }
      continue;
    }
    if (f.type === 'checkbox') {
      values[f.id] = el.checked;
    } else if (f.type === 'link') {
      values[f.id] = el.value ? [el.value] : [];
    } else {
      values[f.id] = el.value;
    }
  }

  try {
    if (editingRecordId) {
      await api(`/tables/${activeTableId}/records/${editingRecordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ values }),
      });
    } else {
      await api(`/tables/${activeTableId}/records`, {
        method: 'POST',
        body: JSON.stringify({ values }),
      });
    }
    closeRecordModal();
    await openTable(activeTableId);
  } catch (e) {
    showToast('Save record failed: ' + e.message, 'error');
  }
}

// ---------- Find in Note ----------
let findMatches = [];
let findIndex = -1;

function toggleFindBar() {
  const bar = $('find-bar');
  const isHidden = bar.classList.toggle('hidden');
  if (!isHidden) {
    $('find-input').focus();
    const sel = window.getSelection()?.toString() || '';
    if (sel) { $('find-input').value = sel; runFind(); }
  } else {
    $('find-input').value = '';
    $('find-count').textContent = '';
    findMatches = [];
    findIndex = -1;
    renderFindHighlights();
  }
}

function runFind() {
  const query = $('find-input').value;
  const body = $('note-body').value;
  findMatches = [];
  findIndex = -1;
  if (!query || !body) {
    $('find-count').textContent = '';
    renderFindHighlights();
    return;
  }
  const lower = body.toLowerCase();
  const q = query.toLowerCase();
  let pos = 0;
  while ((pos = lower.indexOf(q, pos)) !== -1) {
    findMatches.push(pos);
    pos += q.length;
  }
  if (findMatches.length) {
    findIndex = 0;
    scrollToMatch();
  }
  renderFindHighlights();
  updateFindCount();
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderFindHighlights() {
  const backdrop = $('find-backdrop');
  const body = $('note-body').value;
  const query = $('find-input').value;

  if (!query || !findMatches.length) {
    backdrop.innerHTML = '';
    return;
  }

  let html = '';
  let last = 0;
  for (let i = 0; i < findMatches.length; i++) {
    const start = findMatches[i];
    html += escHtml(body.substring(last, start));
    const matchText = body.substring(start, start + query.length);
    const cls = i === findIndex ? 'active' : '';
    html += `<mark class="${cls}">${escHtml(matchText)}</mark>`;
    last = start + query.length;
  }
  html += escHtml(body.substring(last));
  backdrop.innerHTML = html;
}

function scrollToMatch() {
  if (findIndex < 0 || findIndex >= findMatches.length) return;
  const ta = $('note-body');
  const start = findMatches[findIndex];
  const linesBefore = ta.value.substring(0, start).split('\n').length;
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (linesBefore - 3) * lineHeight);
  syncBackdropScroll();
}

function syncBackdropScroll() {
  const ta = $('note-body');
  const backdrop = $('find-backdrop');
  backdrop.scrollTop = ta.scrollTop;
  backdrop.scrollLeft = ta.scrollLeft;
}

function updateFindCount() {
  const el = $('find-count');
  if (!findMatches.length) {
    el.textContent = $('find-input').value ? '0 / 0' : '';
  } else {
    el.textContent = `${findIndex + 1} / ${findMatches.length}`;
  }
}

function findNext() {
  if (!findMatches.length) return;
  findIndex = (findIndex + 1) % findMatches.length;
  scrollToMatch();
  renderFindHighlights();
  updateFindCount();
  $('find-input').focus();
}

function findPrev() {
  if (!findMatches.length) return;
  findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
  scrollToMatch();
  renderFindHighlights();
  updateFindCount();
  $('find-input').focus();
}

// ---------- Extension Editor ----------
let extEditorState = { isNew: false, originalId: null, files: {}, activeFile: null };

function openExtEditorModal() {
  $('settings-overlay').classList.add('hidden');
  $('ext-editor-overlay').classList.remove('hidden');
}
function closeExtEditor() {
  $('ext-editor-overlay').classList.add('hidden');
  extEditorState = { isNew: false, originalId: null, files: {}, activeFile: null };
}

async function openExtEditor(extId) {
  try {
    const data = await api(`/extensions/admin/${extId}`);
    extEditorState = {
      isNew: false,
      originalId: extId,
      files: data.files || {},
      activeFile: null,
    };
    $('ext-edit-id').value = data.id;
    $('ext-edit-id').readOnly = true;
    $('ext-edit-name').value = data.name || '';
    $('ext-edit-desc').value = data.description || '';
    $('ext-editor-title').textContent = `Edit: ${data.name || data.id}`;
    $('ext-editor-status').textContent = '';

    const fileNames = Object.keys(extEditorState.files);
    if (!fileNames.length) {
      extEditorState.files['panel.js'] = '';
      extEditorState.activeFile = 'panel.js';
    } else {
      extEditorState.activeFile = fileNames.includes('panel.js') ? 'panel.js' : fileNames[0];
    }
    renderEditorFileTabs();
    openExtEditorModal();
  } catch (e) {
    showToast('Failed to load extension: ' + e.message, 'error');
  }
}

function openNewExtEditor() {
  extEditorState = {
    isNew: true,
    originalId: null,
    files: { 'panel.js': '', 'styles.css': '' },
    activeFile: 'panel.js',
  };
  $('ext-edit-id').value = '';
  $('ext-edit-id').readOnly = false;
  $('ext-edit-name').value = '';
  $('ext-edit-desc').value = '';
  $('ext-editor-title').textContent = 'New Extension';
  $('ext-editor-status').textContent = '';
  renderEditorFileTabs();
  openExtEditorModal();
}

function renderEditorFileTabs() {
  const tabsEl = $('ext-editor-file-tabs');
  tabsEl.innerHTML = '';
  const files = Object.keys(extEditorState.files);
  for (const name of files) {
    const li = document.createElement('li');
    li.className = 'ext-file-tab' + (name === extEditorState.activeFile ? ' is-active' : '');
    const label = document.createElement('span');
    label.textContent = name;
    label.addEventListener('click', () => switchEditorFile(name));
    li.appendChild(label);
    if (name !== 'panel.js') {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'ext-file-tab-close';
      closeBtn.innerHTML = '&#x2715;';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeEditorFile(name); });
      li.appendChild(closeBtn);
    }
    tabsEl.appendChild(li);
  }
  $('ext-editor-code').value = extEditorState.files[extEditorState.activeFile] || '';
}

function switchEditorFile(name) {
  extEditorState.files[extEditorState.activeFile] = $('ext-editor-code').value;
  extEditorState.activeFile = name;
  renderEditorFileTabs();
}

function removeEditorFile(name) {
  delete extEditorState.files[name];
  if (extEditorState.activeFile === name) {
    extEditorState.activeFile = Object.keys(extEditorState.files)[0] || 'panel.js';
  }
  renderEditorFileTabs();
}

function addEditorFile() {
  const name = prompt('File name (e.g. helpers.js, theme.css):');
  if (!name || name.includes('..') || name.includes('/')) return;
  if (extEditorState.files[name] !== undefined) {
    switchEditorFile(name);
    return;
  }
  extEditorState.files[extEditorState.activeFile] = $('ext-editor-code').value;
  extEditorState.files[name] = '';
  extEditorState.activeFile = name;
  renderEditorFileTabs();
}

async function saveExtension() {
  extEditorState.files[extEditorState.activeFile] = $('ext-editor-code').value;
  const id = $('ext-edit-id').value.trim();
  const name = $('ext-edit-name').value.trim();
  const desc = $('ext-edit-desc').value.trim();

  if (!id) { showToast('Extension ID is required', 'error'); return; }
  if (!/^[a-z0-9-]+$/.test(id)) { showToast('ID must be lowercase alphanumeric with dashes', 'error'); return; }

  $('ext-editor-status').textContent = 'Deploying...';
  $('ext-editor-save').disabled = true;
  try {
    await api('/extensions/build', {
      method: 'POST',
      body: JSON.stringify({ id, name: name || id, description: desc, files: extEditorState.files }),
    });
    $('ext-editor-status').textContent = 'Deployed!';
    extEditorState.isNew = false;
    extEditorState.originalId = id;
    $('ext-edit-id').readOnly = true;
    showToast(`Extension "${name || id}" deployed`, 'info');
    await hotReloadExtension(id);
    setTimeout(renderExtPanels, 500);
    renderExtensionSettings();
  } catch (e) {
    $('ext-editor-status').textContent = 'Error';
    showToast('Deploy failed: ' + e.message, 'error');
  } finally {
    $('ext-editor-save').disabled = false;
  }
}

// ---------- Wire up ----------
function init() {
  document.querySelectorAll('.auth-tab').forEach((t) =>
    t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('auth-submit').addEventListener('click', handleAuth);
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAuth(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('password').focus(); });

  $('new-note').addEventListener('click', newNote);
  $('logout').addEventListener('click', logout);
  $('delete-note').addEventListener('click', deleteActive);
  $('note-title').addEventListener('input', scheduleSave);
  $('note-body').addEventListener('input', scheduleSave);
  $('search').addEventListener('input', (e) => renderList(e.target.value));

  // Sidebar view tabs
  document.querySelectorAll('.sidebar-nav-tab').forEach((t) => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });

  // Tables
  $('new-table-btn').addEventListener('click', openNewTableModal);
  $('import-spreadsheet-btn').addEventListener('click', () => $('import-file-input').click());
  $('import-file-input').addEventListener('change', handleSpreadsheetImport);
  $('tbl-delete-table').addEventListener('click', deleteActiveTable);
  $('new-table-close').addEventListener('click', closeNewTableModal);
  $('new-table-overlay').addEventListener('click', (e) => { if (e.target === $('new-table-overlay')) closeNewTableModal(); });
  $('new-table-save').addEventListener('click', createTable);
  $('new-table-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTable(); });

  $('tbl-add-field').addEventListener('click', openFieldModal);
  $('field-close').addEventListener('click', closeFieldModal);
  $('field-overlay').addEventListener('click', (e) => { if (e.target === $('field-overlay')) closeFieldModal(); });
  $('field-save').addEventListener('click', createField);
  $('field-type').addEventListener('change', onFieldTypeChange);

  $('tbl-add-record').addEventListener('click', () => openRecordModal());
  $('record-close').addEventListener('click', closeRecordModal);
  $('record-overlay').addEventListener('click', (e) => { if (e.target === $('record-overlay')) closeRecordModal(); });
  $('record-save').addEventListener('click', saveRecord);

  // Find in note
  $('find-input').addEventListener('input', runFind);
  $('find-next').addEventListener('click', findNext);
  $('find-prev').addEventListener('click', findPrev);
  $('find-close').addEventListener('click', toggleFindBar);
  $('note-body').addEventListener('scroll', syncBackdropScroll);
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext(); }
    if (e.key === 'Escape') toggleFindBar();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !$('editor-pane').classList.contains('hidden')) {
      e.preventDefault();
      toggleFindBar();
    }
  });

  $('export-btn').addEventListener('click', toggleExportMenu);
  $('export-menu').querySelectorAll('.export-option').forEach((btn) =>
    btn.addEventListener('click', () => handleExport(btn.dataset.format)));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-wrap')) $('export-menu').classList.add('hidden');
  });

  // AI panel
  $('ai-toggle').addEventListener('click', toggleAIPanel);
  $('ai-close').addEventListener('click', toggleAIPanel);
  $('ai-new-convo').addEventListener('click', createConversation);
  $('ai-send').addEventListener('click', sendAIMessage);
  $('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAIMessage(); });
  $('ai-upload-btn').addEventListener('click', () => $('ai-file-input').click());
  $('ai-file-input').addEventListener('change', handleFileUpload);
  $('ai-file-clear').addEventListener('click', clearAttachedFile);
  $('ai-file-import').addEventListener('click', importFileAsTables);

  // Settings
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', (e) => {
    if (e.target === $('settings-overlay')) closeSettings();
  });
  $('ai-sync-btn').addEventListener('click', syncToAI);
  $('ai-purge-btn').addEventListener('click', purgeAI);

  autoSync = localStorage.getItem('mindspring-auto-sync') === 'true';
  $('ai-auto-sync').checked = autoSync;
  $('ai-auto-sync').addEventListener('change', (e) => {
    autoSync = e.target.checked;
    localStorage.setItem('mindspring-auto-sync', autoSync);
  });

  // Extensions panel
  $('ext-toggle').addEventListener('click', toggleExtPanel);
  $('ext-close').addEventListener('click', toggleExtPanel);
  $('ext-new-btn').addEventListener('click', openNewExtEditor);
  $('ext-editor-close').addEventListener('click', closeExtEditor);
  $('ext-editor-overlay').addEventListener('click', (e) => {
    if (e.target === $('ext-editor-overlay')) closeExtEditor();
  });
  $('ext-editor-save').addEventListener('click', saveExtension);
  $('ext-editor-add-file').addEventListener('click', addEditorFile);
  $('ext-editor-code').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    }
  });
  window.inkwell.on('_panelsChanged', renderExtPanels);
  window.inkwell.on('_refreshPanel', (id) => {
    const p = window.inkwell._panels.find((x) => x.id === id);
    const container = document.querySelector(`#ext-panel-${id} .ext-section-body`);
    if (p && container) { try { p.render(container); } catch { /* skip */ } }
  });
  window.inkwell.on('_notify', ({ message, type }) => showToast(message, type));

  // A session may exist but the key does not survive reload — must re-enter
  // the passphrase to derive it again. So we always start at the auth gate.
  $('auth-view').classList.remove('hidden');
  setAuthMode('login');
  try {
    assertCryptoAvailable();
  } catch (e) {
    $('auth-error').textContent = e.message;
  }
}

init();
