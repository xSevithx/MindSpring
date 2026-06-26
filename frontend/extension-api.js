// MindSpring Extension API — exposed as window.inkwell for extensions to use.
// The core app calls inkwell._init() to wire internal state into this API.

const listeners = {};
const panels = [];
const footerWidgets = [];
let _getActiveNote = () => null;
let _getNotes = () => [];
let _apiFn = async () => {};

function on(event, callback) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(callback);
  return () => {
    listeners[event] = listeners[event].filter((cb) => cb !== callback);
  };
}

function emit(event, data) {
  (listeners[event] || []).forEach((cb) => {
    try { cb(data); } catch (e) { console.error(`Extension error on ${event}:`, e); }
  });
}

function registerPanel({ id, title, render }) {
  const existing = panels.findIndex((p) => p.id === id);
  if (existing !== -1) panels[existing] = { id, title, render };
  else panels.push({ id, title, render });
  emit('_panelsChanged');
}

function registerFooterWidget({ id, render }) {
  const existing = footerWidgets.findIndex((w) => w.id === id);
  if (existing !== -1) footerWidgets[existing] = { id, render };
  else footerWidgets.push({ id, render });
  emit('_widgetsChanged');
}

function refreshPanel(id) {
  emit('_refreshPanel', id);
}

function notify(message, type = 'info') {
  emit('_notify', { message, type });
}

window.inkwell = {
  on,
  registerPanel,
  registerFooterWidget,
  refreshPanel,
  notify,
  getActiveNote: () => _getActiveNote(),
  getNotes: () => _getNotes(),
  api: (path, opts) => _apiFn(path, opts),

  // Internal — called by core app, not by extensions
  _emit: emit,
  _panels: panels,
  _footerWidgets: footerWidgets,
  _init({ getActiveNote, getNotes, api }) {
    _getActiveNote = getActiveNote;
    _getNotes = getNotes;
    _apiFn = api;
  },
};
