import { fetchOllamaModels, fetchClaudeModels, fetchColabOllamaModels, getProvider, getColabOllamaBase, modelSupportsVision } from './api.js';
import { GEMINI_MODELS } from './gemini.js';
import { populateModels, onModelChange, updateTopbarModel, appendMessage, clearMessages, setSendDisabled, autoResize, renderHistory, renderSessionMessages, updateTokenCounter, showAttachedFiles, appendSystemMessage, showSummaryPopup } from './ui.js';
import { sendMessage, sendMessage as chatSendMessage } from './chat.js';
import { saveSessions, loadSessions, deleteSession, saveImage, restoreImageData, deleteImages } from './storage.js';
import { readFile, buildFileMessage } from './files.js';
import { state } from './state.js';
import { initSettings, initOllamaDownload } from './settings.js';

// Default Model Token Limits.
const MODEL_LIMIT_KEY = 'modelTokenLimits';
const DEFAULT_CONTEXT_LIMITS = {
  'claude': 1000000,
  'gemini': 1000000,
  'ollama': 8000,
};


// Returns a Json which contains each model token limit set by user.
function getModelLimits() {
  try { return JSON.parse(localStorage.getItem(MODEL_LIMIT_KEY) || '{}'); } catch { return {}; }
}

// Returns the contex limit of the model.
function getContextLimit(model) {
  const saved = getModelLimits();
  if (saved[model] !== undefined) return saved[model];
  const provider = getProvider(model);
  return DEFAULT_CONTEXT_LIMITS[provider] || 1000000;
}

// Save the context limit of model in localStorage.
function saveContextLimit(model, limit) {
  const saved = getModelLimits();
  saved[model] = limit;
  localStorage.setItem(MODEL_LIMIT_KEY, JSON.stringify(saved));
}

const MAX_IMAGES = 10;
const MAX_FILES = 20;
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful, harmless, and honest AI assistant. Answer clearly and concisely.';

let sessions = {};
let activeId = null;
let pendingFiles = [];
let summaryPopupShown = false;

function countTokens(history) {
  // Only count user/assistant messages for display — system/summary are context overhead
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .reduce((n, m) => n + Math.ceil((m.content || '').length / 4), 0);
}

function trimHistoryToLimit(history, limit) {
  // Trim oldest non-system messages when over limit
  while (countTokens(history) > limit) {
    const idx = history.findIndex(m => m.role !== 'system' && m.role !== 'summary');
    if (idx === -1) break;
    history.splice(idx, 1);
  }
}

function newSessionId() { return Date.now().toString(); }

function startNewChat() {
  summaryPopupShown = false;
  activeId = newSessionId();
  const prompt = document.getElementById('systemPrompt').value.trim() || DEFAULT_SYSTEM_PROMPT;
  sessions[activeId] = { title: 'New Chat', messages: [], systemPrompt: prompt };
  saveSessions(sessions);
  clearMessages();
  updateTokenCounter(0, getContextLimit(document.getElementById('modelSelect').value));
  document.getElementById('systemPrompt').value = prompt;
  refreshHistory();
}

function refreshHistory() {
  renderHistory(sessions, activeId, loadSession, (id) => {
    deleteSession(id, sessions);
    if (id === activeId) startNewChat();
    else refreshHistory();
  });
}

function loadSession(id) {
  activeId = id;
  summaryPopupShown = false;
  renderSessionMessages(sessions[id].messages);
  updateTokenCounter(countTokens(sessions[id].messages), getContextLimit(document.getElementById('modelSelect').value));
  const prompt = sessions[id].systemPrompt || DEFAULT_SYSTEM_PROMPT;
  document.getElementById('systemPrompt').value = prompt;
  const model = document.getElementById('modelSelect').value;
  if (model) document.getElementById('contextLimit').value = getContextLimit(model);
  refreshHistory();
}

async function init() {
  const raw = loadSessions();
  sessions = await restoreImageData(raw);

  // Populate model list: Ollama + Gemini
  const modelSel = document.getElementById('modelSelect');
  modelSel.innerHTML = '';

  // Claude models (from Claude.py proxy)
  try {
    const claudeModels = await fetchClaudeModels();
    if (claudeModels.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Claude (via Claude.py)';
      claudeModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        grp.appendChild(opt);
      });
      modelSel.appendChild(grp);
    }
  } catch (e) {
    console.warn('Claude.py not reachable:', e.message);
  }

  // Ollama models (local)
  try {
    const ollamaModels = await fetchOllamaModels();
    if (ollamaModels.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Ollama (Local)';
      ollamaModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        opt.dataset.backend = 'local';
        grp.appendChild(opt);
      });
      modelSel.appendChild(grp);
    } else {
      console.info('Ollama reachable but no models installed.');
    }
  } catch (e) {
    console.info('Ollama not reachable - paste URL in Settings to connect:', e.message);
  }

  // Ollama models (Colab)
  try {
    const colabModels = await fetchColabOllamaModels();
    if (colabModels.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Ollama (Colab)';
      colabModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = 'colab:' + m; opt.textContent = m + ' (Colab)';
        opt.dataset.backend = 'colab';
        grp.appendChild(opt);
      });
      modelSel.appendChild(grp);
    }
  } catch (e) {
    console.info('Colab Ollama not reachable:', e.message);
  }

  // Gemini models (always show, needs API key)
  const geminiGrp = document.createElement('optgroup');
  geminiGrp.label = 'Gemini (Google)';
  GEMINI_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    geminiGrp.appendChild(opt);
  });
  modelSel.appendChild(geminiGrp);

  // Build custom dropdown from populated native select
  populateModels();
  updateTopbarModel();

  const ids = Object.keys(sessions).sort((a, b) => b - a);
  if (ids.length > 0) loadSession(ids[0]);
  else {
    document.getElementById('systemPrompt').value = DEFAULT_SYSTEM_PROMPT;
    startNewChat();
  }

  // Init settings panel
  initSettings(() => sessions);
  initOllamaDownload(
    () => localStorage.getItem('ollamaUrl') || 'http://localhost:11434',
    async () => {
      try {
        const ollamaModels = await fetchOllamaModels();
        const sel = document.getElementById('modelSelect');
        const existing = sel.querySelector('optgroup[label="Ollama (Local)"]');
        if (existing) existing.remove();
        if (ollamaModels.length > 0) {
          const grp = document.createElement('optgroup');
          grp.label = 'Ollama (Local)';
          ollamaModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            opt.dataset.backend = 'local';
            grp.appendChild(opt);
          });
          sel.appendChild(grp);
        }
        populateModels();
      } catch(e) { console.warn('Could not refresh models:', e.message); }
    },
    'local'
  );

  // ── Colab model refresh (shared helper) ──
  async function refreshColabModels(silent = false) {
    const btn = document.getElementById('ollamaColabRefreshBtn');
    if (btn) { btn.textContent = '⟳'; btn.disabled = true; }
    try {
      const colabModels = await fetchColabOllamaModels();
      const sel = document.getElementById('modelSelect');
      const existing = sel.querySelector('optgroup[label="Ollama (Colab)"]');
      if (existing) existing.remove();
      if (colabModels.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Ollama (Colab)';
        colabModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = 'colab:' + m; opt.textContent = m + ' (Colab)';
          opt.dataset.backend = 'colab';
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
        if (!silent) showToast('Colab connected! ' + colabModels.length + ' model(s) loaded.');
      } else {
        if (!silent) showToast('Colab reachable but no models found.');
      }
      populateModels();
    } catch(e) {
      if (!silent) showToast('Could not reach Colab: ' + e.message);
      console.warn('Could not refresh Colab models:', e.message);
    } finally {
      if (btn) { btn.textContent = '↺'; btn.disabled = false; }
    }
  }

  // Reconnect button
  const colabRefreshBtn = document.getElementById('ollamaColabRefreshBtn');
  if (colabRefreshBtn) {
    colabRefreshBtn.addEventListener('click', () => {
      // Save the current input value first
      const url = document.getElementById('ollamaColabUrlInput').value.trim();
      if (url) localStorage.setItem('ollamaColabUrl', url);
      refreshColabModels(false);
    });
  }

  // Also refresh colab models after saving settings
  const origSaveBtn = document.getElementById('saveSettingsBtn');
  if (origSaveBtn) {
    origSaveBtn.addEventListener('click', () => {
      // Small delay to let settings.js save first
      setTimeout(() => refreshColabModels(true), 100);
    });
  }

  // Colab Ollama download button
  initOllamaDownload(
    () => localStorage.getItem('ollamaColabUrl') || '',
    () => refreshColabModels(false),
    'colab'
  );
}

function showToast(msg) {
  const t = document.getElementById('settingsToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function showWarningToast(msg) {
  let t = document.getElementById('warningToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'warningToast';
    t.className = 'warning-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

function getOptions() {
  return {
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: parseInt(document.getElementById('maxTokens').value)
  };
}

function getSystemPrompt() {
  return document.getElementById('systemPrompt').value.trim();
}

function refreshPendingFiles() {
  showAttachedFiles(pendingFiles, (i) => {
    pendingFiles.splice(i, 1);
    refreshPendingFiles();
  });
}

async function handleSend() {
  const input = document.getElementById('inputText');
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0) return;

  const model = document.getElementById('modelSelect').value;
  if (!model) { alert('Please select a model.'); return; }

  input.value = '';
  input.style.height = 'auto';
  setSendDisabled(true);

  const session = sessions[activeId];
  const history = session.messages;

  const currentPrompt = getSystemPrompt() || DEFAULT_SYSTEM_PROMPT;
  sessions[activeId].systemPrompt = currentPrompt;
  document.getElementById('systemPrompt').value = currentPrompt;

  if (history.length === 0) {
    history.push({ role: 'system', content: currentPrompt });
  } else {
    const sysIdx = history.findIndex(m => m.role === 'system');
    if (sysIdx !== -1) history[sysIdx].content = currentPrompt;
    else history.unshift({ role: 'system', content: currentPrompt });
  }

  const attachedFiles = [...pendingFiles];
  pendingFiles = [];
  refreshPendingFiles();

  for (const f of attachedFiles) {
    if (f.type === 'image') {
      f.dbKey = `img_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await saveImage(f.dbKey, f.data);
    }
  }

  let fullContent = text;
  const textFiles = attachedFiles.filter(f => f.type === 'text');
  const imageFiles = attachedFiles.filter(f => f.type === 'image');
  if (textFiles.length > 0) fullContent += buildFileMessage(textFiles);
  if (!fullContent.trim() && imageFiles.length > 0) fullContent = 'Please analyze these images.';

  // Warn if sending images to a non-vision Ollama model
  if (imageFiles.length > 0 && getProvider(model) === 'ollama' && !modelSupportsVision(model)) {
    showWarningToast('⚠️ This model may not support images. Use llava, moondream or another vision model.');
  }

  if (!history.find(m => m.role === 'user')) {
    session.title = (text || 'Image').slice(0, 40) + ((text || '').length > 40 ? '…' : '');
  }

  const msgId = 'msg-' + Date.now();
  history.push({ id: msgId, role: 'user', content: fullContent, files: attachedFiles });
  appendMessage('user', text, attachedFiles, msgId);

  const ctxLimit = getContextLimit(document.getElementById('modelSelect').value);
  trimHistoryToLimit(history, ctxLimit);
  updateTokenCounter(countTokens(history), getContextLimit(document.getElementById('modelSelect').value));
  saveSessions(sessions);
  refreshHistory();

  // Route colab: prefixed models to Colab backend
  let actualModel = model;
  let ollamaOverrideBase = null;
  if (model.startsWith('colab:')) {
    actualModel = model.replace('colab:', '');
    ollamaOverrideBase = getColabOllamaBase();
  }

  const replyId = 'msg-' + (Date.now() + 1);
  const reply = await sendMessage(actualModel, history, getOptions(), ollamaOverrideBase);
  history.push({ id: replyId, role: 'assistant', content: reply, files: [], model: actualModel });

  const ctxLimit2 = getContextLimit(document.getElementById('modelSelect').value);
  trimHistoryToLimit(history, ctxLimit2);
  const usedAfter = countTokens(history);
  updateTokenCounter(usedAfter, ctxLimit2);
  saveSessions(sessions);
  setSendDisabled(false);

  // ── 70% token limit check ──
  if (!summaryPopupShown && usedAfter >= ctxLimit2 * 0.70) {
    summaryPopupShown = true;
    showSummaryPopup(usedAfter, ctxLimit2,
      async () => {
        // YES: generate summary
        await handleConversationSummary(model);
        summaryPopupShown = false;
      },
      () => {
        // NO: keep going, don't show again until next threshold cross
        summaryPopupShown = false;
      }
    );
  }
}

async function handleConversationSummary(model) {
  const session = sessions[activeId];
  if (!session) return;

  const history = session.messages;
  // Build a summary prompt from non-system messages
  const nonSystem = history.filter(m => m.role !== 'system');
  const transcript = nonSystem.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');

  const summaryHistory = [
    { role: 'system', content: 'You are a helpful assistant that creates concise conversation summaries.' },
    { role: 'user', content: `Please summarize the following conversation concisely, preserving all key points, decisions, and important context:\n\n${transcript}` }
  ];

  // Strip colab: prefix if needed
  let summaryModel = model;
  let summaryBase = null;
  if (model.startsWith('colab:')) {
    summaryModel = model.replace('colab:', '');
    summaryBase = getColabOllamaBase();
  }

  setSendDisabled(true);
  let summaryText = '';
  try {
    summaryText = await chatSendMessage(summaryModel, summaryHistory, getOptions(), summaryBase);
  } catch(e) {
    console.error('Summary generation failed:', e);
    setSendDisabled(false);
    return;
  }

  // Clear history keeping only system prompt
  const systemPrompt = session.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  session.messages = [{ role: 'system', content: systemPrompt }];

  // Add summary into history as system-level context
  session.messages.push({ role: 'user', content: '[Previous Conversation Summary]: ' + summaryText });
  session.messages.push({ role: 'assistant', content: 'Got it. I have the summary as context and will continue.' });

  // Store summary message for rendering
  const summaryMsgId = 'msg-summary-' + Date.now();
  session.messages.unshift({ id: summaryMsgId, role: 'summary', content: summaryText });

  // Re-render chat with just the summary shown as system message
  clearMessages();
  appendSystemMessage(summaryText, summaryMsgId);

  const ctxLimit = getContextLimit(document.getElementById('modelSelect').value);
  updateTokenCounter(countTokens(session.messages), ctxLimit);
  saveSessions(sessions);
  setSendDisabled(false);
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    const isImage = file.type.startsWith('image/');
    if (pendingFiles.length >= MAX_FILES) { alert(`Max ${MAX_FILES} files allowed per message.`); break; }
    if (isImage && pendingFiles.filter(f => f.type === 'image').length >= MAX_IMAGES) { alert(`Max ${MAX_IMAGES} images allowed per message.`); continue; }
    try {
      const result = await readFile(file);
      pendingFiles.push(result);
    } catch (e) { console.error('File read error:', e); }
  }
  refreshPendingFiles();
}

document.addEventListener('deleteMessage', async (e) => {
  const { id } = e.detail;
  if (!activeId || !sessions[activeId]) return;
  const history = sessions[activeId].messages;
  const idx = history.findIndex(m => m.id === id);
  if (idx !== -1) {
    const msg = history[idx];
    const imgKeys = (msg.files || []).filter(f => f.type === 'image' && f.dbKey).map(f => f.dbKey);
    if (imgKeys.length) await deleteImages(imgKeys);
    history.splice(idx, 1);
    updateTokenCounter(countTokens(history), getContextLimit(document.getElementById('modelSelect').value));
    saveSessions(sessions);
  }
});

document.getElementById('newChatBtn').addEventListener('click', () => startNewChat());
document.getElementById('clearBtn').addEventListener('click', () => {
  if (!activeId || !sessions[activeId]) return;
  if (!confirm('Clear this chat? This cannot be undone.')) return;
  const msgs = sessions[activeId].messages || [];
  const imgKeys = msgs.flatMap(m => (m.files || []).filter(f => f.type === 'image' && f.dbKey).map(f => f.dbKey));
  if (imgKeys.length) deleteImages(imgKeys);
  sessions[activeId].messages = [];
  sessions[activeId].title = 'New Chat';
  saveSessions(sessions);
  clearMessages();
  updateTokenCounter(0, getContextLimit(document.getElementById('modelSelect').value));
  refreshHistory();
});
document.getElementById('sendBtn').addEventListener('click', handleSend);
      onModelChange((model) => {
      updateTopbarModel();
      const limit = getContextLimit(model);
      document.getElementById('contextLimit').value = limit;
      updateTokenCounter(countTokens(sessions[activeId]?.messages || []), limit);
    });

const visualModeBtn = document.getElementById('visualModeBtn');
visualModeBtn.addEventListener('click', () => {
  state.visualMode = !state.visualMode;
  visualModeBtn.textContent = `▶ Run Visual: ${state.visualMode ? 'On' : 'Off'}`;
  visualModeBtn.classList.toggle('active', state.visualMode);
});

const themeBtn = document.getElementById('themeBtn');
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark') { document.body.classList.add('dark'); themeBtn.textContent = '☀️'; }
themeBtn.addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark');
  themeBtn.textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

document.getElementById('sidebarToggle').addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 600;
  if (isMobile) {
    sidebar.classList.toggle('open');
    // Add/remove overlay
    let ov = document.getElementById('sidebarMobileOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sidebarMobileOverlay';
      ov.className = 'sidebar-mobile-overlay';
      ov.addEventListener('click', () => { sidebar.classList.remove('open'); ov.classList.remove('open'); });
      document.body.appendChild(ov);
    }
    ov.classList.toggle('open', sidebar.classList.contains('open'));
  } else {
    sidebar.classList.toggle('collapsed');
  }
});
document.getElementById('paramsToggle').addEventListener('click', () => {
  document.getElementById('paramsPanel').classList.toggle('hidden');
});
document.getElementById('temperature').addEventListener('input', (e) => {
  document.getElementById('tempVal').textContent = parseFloat(e.target.value).toFixed(2);
});
document.getElementById('contextLimit').addEventListener('change', (e) => {
  const model = document.getElementById('modelSelect').value;
  if (model) saveContextLimit(model, parseInt(e.target.value));
});
document.getElementById('inputText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
document.getElementById('inputText').addEventListener('input', (e) => { autoResize(e.target); });
document.getElementById('fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

// ── Ctrl+V paste screenshot / image from clipboard ──
document.addEventListener('paste', (e) => {
  // Only intercept when clipboard contains image items.
  // Text-only pastes (into inputText etc.) are NOT affected.
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter(item => item.type.startsWith('image/'));
  if (imageItems.length === 0) return;

  e.preventDefault();

  const files = imageItems.map(item => {
    const blob = item.getAsFile();
    return new File([blob], `screenshot-${Date.now()}.png`, { type: blob.type || 'image/png' });
  });

  handleFiles(files);
  document.getElementById('inputText').focus();
});

const mainEl = document.querySelector('.main');
mainEl.addEventListener('dragover', (e) => { e.preventDefault(); document.getElementById('dropOverlay').classList.remove('hidden'); });
mainEl.addEventListener('dragleave', (e) => { if (!mainEl.contains(e.relatedTarget)) document.getElementById('dropOverlay').classList.add('hidden'); });
mainEl.addEventListener('drop', (e) => {
  e.preventDefault();
  document.getElementById('dropOverlay').classList.add('hidden');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

init();
