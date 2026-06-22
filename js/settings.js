// Settings panel — Ollama URL, Gemini API key, Export history
import { _ngrokHeaders } from './api.js';

export function getOllamaUrl() {
  return localStorage.getItem('ollamaUrl') || 'http://localhost:11434';
}

export function getColabOllamaUrl() {
  return localStorage.getItem('ollamaColabUrl') || '';
}

export function getClaudeUrl() {
  return localStorage.getItem('claudeUrl') || 'http://localhost:5000';
}

export function getGeminiKey() {
  return localStorage.getItem('geminiKey') || '';
}

export function initSettings(getSessions) {
  const btn = document.getElementById('settingsBtn');
  const panel = document.getElementById('settingsPanel');
  const overlay = document.getElementById('settingsOverlay');

  document.getElementById('ollamaUrlInput').value = getOllamaUrl();
  document.getElementById('ollamaColabUrlInput').value = getColabOllamaUrl();
  document.getElementById('claudeUrlInput').value = getClaudeUrl();
  document.getElementById('geminiKeyInput').value = getGeminiKey();

  btn.addEventListener('click', () => {
    const opening = !panel.classList.contains('open');
    if (opening) {
      // Refresh inputs from localStorage each time panel opens
      document.getElementById('ollamaUrlInput').value = getOllamaUrl();
      document.getElementById('ollamaColabUrlInput').value = getColabOllamaUrl();
      document.getElementById('claudeUrlInput').value = getClaudeUrl();
      document.getElementById('geminiKeyInput').value = getGeminiKey();
    }
    panel.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', () => {
    panel.classList.remove('open');
    overlay.classList.remove('open');
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    panel.classList.remove('open');
    overlay.classList.remove('open');
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    const ollamaUrl = document.getElementById('ollamaUrlInput').value.trim();
    const ollamaColabUrl = document.getElementById('ollamaColabUrlInput').value.trim();
    const geminiKey = document.getElementById('geminiKeyInput').value.trim();
    const claudeUrl = document.getElementById('claudeUrlInput').value.trim();
    localStorage.setItem('ollamaUrl', ollamaUrl || 'http://localhost:11434');
    localStorage.setItem('ollamaColabUrl', ollamaColabUrl);
    localStorage.setItem('claudeUrl', claudeUrl || 'http://localhost:5000');
    localStorage.setItem('geminiKey', geminiKey);
    showSettingsToast('Settings saved!');
  });

  document.getElementById('exportHistoryBtn').addEventListener('click', () => {
    exportHistory(getSessions());
  });
}

function exportHistory(sessions) {
  const ids = Object.keys(sessions).sort((a, b) => a - b);
  if (!ids.length) { alert('No chat history to export.'); return; }

  let output = '';
  for (const id of ids) {
    const s = sessions[id];
    output += `═══════════════════════════════════════\n`;
    output += `Chat: ${s.title || 'New Chat'}\n`;
    output += `═══════════════════════════════════════\n\n`;
    const msgs = (s.messages || []).filter(m => m.role !== 'system');
    for (const msg of msgs) {
      const label = msg.role === 'user' ? 'You' : 'AI';
      output += `${label}:\n${(msg.content || '').trim()}\n\n`;
    }
    output += '\n';
  }

  const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-history-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function showSettingsToast(msg) {
  let toast = document.getElementById('settingsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'settingsToast';
    toast.className = 'settings-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ── Ollama Download State — separate for local and colab ──
const dlStates = {
  local: { active: false, modelId: '', status: '', pct: 0, abortController: null },
  colab: { active: false, modelId: '', status: '', pct: 0, abortController: null }
};

function updateTopbarDlIcon() {
  const icon = document.getElementById('ollamaTopbarDlBtn');
  if (!icon) return;
  icon.style.display = (dlStates.local.active || dlStates.colab.active) ? 'flex' : 'none';
}

/**
 * @param {function} getBaseUrl - returns the ollama base URL string
 * @param {function} onSuccess  - called after successful download
 * @param {'local'|'colab'} type
 */
export function initOllamaDownload(getBaseUrl, onSuccess, type = 'local') {
  const isColab = type === 'colab';
  const openBtn = document.getElementById(isColab ? 'ollamaColabDlBtn' : 'ollamaDlBtn');
  if (!openBtn) return;
  const overlay = document.getElementById(isColab ? 'ollamaColabDlOverlay' : 'ollamaDlOverlay');
  const win = document.getElementById(isColab ? 'ollamaColabDlWindow' : 'ollamaDlWindow');
  const closeBtn = document.getElementById(isColab ? 'ollamaColabDlClose' : 'ollamaDlClose');
  const input = document.getElementById(isColab ? 'ollamaColabModelIdInput' : 'ollamaModelIdInput');
  const dlBtn = document.getElementById(isColab ? 'ollamaColabDownloadBtn' : 'ollamaDownloadBtn');
  const cancelBtn = document.getElementById(isColab ? 'ollamaColabCancelBtn' : 'ollamaCancelBtn');
  const progress = document.getElementById(isColab ? 'ollamaColabDlProgress' : 'ollamaDlProgress');
  const status = document.getElementById(isColab ? 'ollamaColabDlStatus' : 'ollamaDlStatus');
  const barFill = document.getElementById(isColab ? 'ollamaColabDlBarFill' : 'ollamaDlBarFill');
  const pct = document.getElementById(isColab ? 'ollamaColabDlPct' : 'ollamaDlPct');
  const topbarDlBtn = document.getElementById('ollamaTopbarDlBtn');
  const dlState = dlStates[type];
  // alias so body below works unchanged
  const getOllamaUrl = getBaseUrl;

  function openWindow() {
    win.classList.add('open');
    overlay.classList.add('open');
    // Always sync UI to current dlState
    if (dlState.active) {
      input.value = dlState.modelId;
      input.disabled = true;
      dlBtn.disabled = true;
      cancelBtn.classList.remove('hidden');
      progress.classList.remove('hidden');
      status.textContent = dlState.status || 'Downloading...';
      barFill.style.width = dlState.pct + '%';
      pct.textContent = dlState.pct + '%';
    } else {
      // Make sure UI is fully reset when no download is active
      resetUI();
      setTimeout(() => input.focus(), 50);
    }
  }

  function closeWindow(force = false) {
    // During active download, only close via the X button (force=true), not overlay click
    if (dlState.active && !force) return;
    win.classList.remove('open');
    overlay.classList.remove('open');
    if (!dlState.active) resetUI();
  }

  function resetUI() {
    input.value = '';
    input.disabled = false;
    dlBtn.disabled = true;
    cancelBtn.classList.add('hidden');
    progress.classList.add('hidden');
    status.textContent = '';
    barFill.style.width = '0%';
    pct.textContent = '0%';
  }

  openBtn.addEventListener('click', openWindow);
  // Topbar download icon only opens local window (not colab)
  if (topbarDlBtn && !isColab) topbarDlBtn.addEventListener('click', openWindow);
  overlay.addEventListener('click', () => closeWindow(false));
  closeBtn.addEventListener('click', () => closeWindow(true));

  input.addEventListener('input', () => {
    dlBtn.disabled = input.value.trim() === '';
  });

  cancelBtn.addEventListener('click', () => {
    if (dlState.abortController) {
      dlState.abortController.abort();
    }
    dlState.active = false;
    dlState.abortController = null;
    updateTopbarDlIcon();
    resetUI();
    showSettingsToast('Download cancelled.');
  });

  dlBtn.addEventListener('click', async () => {
    const modelId = input.value.trim();
    if (!modelId) return;
    const base = getOllamaUrl();

    dlState.active = true;
    dlState.modelId = modelId;
    dlState.pct = 0;
    dlState.status = 'Connecting to Ollama...';
    dlState.abortController = new AbortController();
    updateTopbarDlIcon();

    input.disabled = true;
    dlBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    progress.classList.remove('hidden');
    status.textContent = 'Connecting to Ollama...';
    barFill.style.width = '0%';
    pct.textContent = '0%';

    try {
      const res = await fetch(base + '/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._ngrokHeaders(base) },
        body: JSON.stringify({ name: modelId, stream: true }),
        signal: dlState.abortController.signal
      });

      if (!res.ok) {
        showSettingsToast('Ollama not reachable. Check server URL.');
        dlState.active = false;
        updateTopbarDlIcon();
        resetUI();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let alreadyExists = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.error) {
              showSettingsToast('Error: ' + data.error);
              dlState.active = false;
              updateTopbarDlIcon();
              resetUI();
              return;
            }
            const st = data.status || '';
            dlState.status = st;
            status.textContent = st;
            if (st === 'success') {
              dlState.active = false;
              updateTopbarDlIcon();
              showSettingsToast('Model downloaded successfully!');
              closeWindow();
              resetUI();
              if (onSuccess) onSuccess();
              return;
            }
            if (st.includes('already')) {
              alreadyExists = true;
              dlState.active = false;
              updateTopbarDlIcon();
              showSettingsToast('Model already exists!');
              closeWindow();
              resetUI();
              return;
            }
            if (data.total && data.completed) {
              const p = Math.round((data.completed / data.total) * 100);
              dlState.pct = p;
              barFill.style.width = p + '%';
              pct.textContent = p + '%';
            }
          } catch { }
        }
      }

      if (!alreadyExists) {
        dlState.active = false;
        updateTopbarDlIcon();
        showSettingsToast('Download complete!');
        closeWindow();
        resetUI();
        if (onSuccess) onSuccess();
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // cancelled, already handled
      showSettingsToast('Error: ' + e.message);
      dlState.active = false;
      updateTopbarDlIcon();
      resetUI();
    }
  });
}
