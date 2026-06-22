import { getFileIcon } from './files.js';
import { state } from './state.js';

// ── Custom Model Dropdown ──
let _ddValue = '';
const _ddListeners = [];

export function onModelChange(fn) { _ddListeners.push(fn); }

function _setDDValue(val) {
  _ddValue = val;
  const sel = document.getElementById('modelSelect');
  if (sel) sel.value = val;
  // Find friendly label from the native select
  const selectedOpt = sel ? Array.from(sel.options).find(o => o.value === val) : null;
  const friendlyLabel = selectedOpt ? selectedOpt.textContent : (val || 'Select a model');
  const lbl = document.getElementById('cmdLabel');
  if (lbl) lbl.textContent = friendlyLabel;
  updateTopbarModel();
  _ddListeners.forEach(fn => fn(val));
}

export function populateModels() {
  // groups built from native select optgroups
  _buildCustomDropdown();
  const sel = document.getElementById('modelSelect');
  // Preserve current selection if it still exists in the new list, else pick first
  const currentVal = _ddValue;
  const stillExists = currentVal && Array.from(sel?.options || []).some(o => o.value === currentVal);
  const newVal = stillExists ? currentVal : (sel?.options[0]?.value || '');
  if (newVal) _setDDValue(newVal);
  updateTopbarModel();
}

function _buildCustomDropdown() {
  const container = document.getElementById('customModelDropdown');
  if (!container) return;
  container.innerHTML = '';

  const trigger = document.createElement('button');
  trigger.className = 'cmd-trigger';
  trigger.id = 'cmdTrigger';
  trigger.innerHTML = `<span id="cmdLabel">${_ddValue || 'Select a model'}</span><svg class="cmd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

  const panel = document.createElement('div');
  panel.className = 'cmd-panel';
  panel.id = 'cmdPanel';

  const sel = document.getElementById('modelSelect');
  const optgroups = sel ? Array.from(sel.querySelectorAll('optgroup')) : [];
  if (optgroups.length) {
    optgroups.forEach(grp => {
      const gl = document.createElement('div');
      gl.className = 'cmd-group-label';
      gl.textContent = grp.label;
      panel.appendChild(gl);
      Array.from(grp.querySelectorAll('option')).forEach(o => panel.appendChild(_makeItem(o.value, o.textContent)));
    });
  } else {
    Array.from(sel?.options || []).forEach(o => panel.appendChild(_makeItem(o.value, o.textContent)));
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = panel.classList.toggle('open');
    trigger.classList.toggle('open', open);
  });
  document.addEventListener('click', e => {
    if (!container.contains(e.target)) {
      panel.classList.remove('open');
      trigger.classList.remove('open');
    }
  });

  container.appendChild(trigger);
  container.appendChild(panel);
}

function _makeItem(val, label) {
  const item = document.createElement('div');
  item.className = 'cmd-item' + (val === _ddValue ? ' active' : '');
  item.textContent = label || val;
  item.dataset.value = val;
  item.addEventListener('click', () => {
    _setDDValue(val);
    document.getElementById('cmdPanel')?.querySelectorAll('.cmd-item')
      .forEach(el => el.classList.toggle('active', el.dataset.value === val));
    document.getElementById('cmdPanel')?.classList.remove('open');
    document.getElementById('cmdTrigger')?.classList.remove('open');
  });
  return item;
}

export function updateTopbarModel() {
  const val = _ddValue || document.getElementById('modelSelect')?.value || '';
  const sel = document.getElementById('modelSelect');
  const selectedOpt = sel ? Array.from(sel.options).find(o => o.value === val) : null;
  const label = selectedOpt ? selectedOpt.textContent : (val || 'Select a model');
  document.getElementById('topbarModel').textContent = label;
}

export function updateTokenCounter(used, limit = 100000) {
  const pct = Math.min((used / limit) * 100, 100);
  document.getElementById('tokenCounter').textContent = `Tokens: ${used.toLocaleString()} / ${limit.toLocaleString()}`;
  const fill = document.getElementById('tokenBarFill');
  fill.style.width = pct + '%';
  fill.className = 'token-bar-fill' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
}

export function stripBonsai(text) {
  return text
    .replace(/<\/?bonsai[^>]*>/gi, '')
    .replace(/<\/?bonsai_context[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Init Mermaid ──
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
}

// ── Render a mermaid block into a div ──
async function renderMermaid(source) {
  const id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const container = document.createElement('div');
  container.className = 'mermaid-container';
  try {
    const { svg } = await mermaid.render(id, source);
    container.innerHTML = svg;
  } catch (e) {
    container.textContent = 'Diagram error: ' + e.message;
    container.style.color = 'red';
  }
  return container;
}

// ── Render a chartjs block ──
// Expects JSON: { type, data, options }
function renderChart(source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chart-container';
  const canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);
  try {
    const config = JSON.parse(source);
    new Chart(canvas, config);
  } catch (e) {
    wrapper.textContent = 'Chart error: ' + e.message;
    wrapper.style.color = 'red';
  }
  return wrapper;
}

// ── Markdown + code rendering ──
function renderMarkdown(text) {
  marked.setOptions({ breaks: true, gfm: true });
  const html = marked.parse(text);
  const div = document.createElement('div');
  div.className = 'markdown-body';
  div.innerHTML = html;

  // Wrap all pre>code blocks with header + copy button
  const pendingMermaid = [];
  div.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = (code?.className.replace('language-', '') || 'code').toLowerCase();

    // Mermaid diagrams
    if (lang === 'mermaid') {
      const source = code.innerText;
      const placeholder = document.createElement('div');
      placeholder.className = 'mermaid-placeholder';
      pre.parentNode.replaceChild(placeholder, pre);
      pendingMermaid.push({ placeholder, source });
      return;
    }

    // Chart.js blocks (language: chart)
    if (lang === 'chart') {
      const source = code.innerText;
      const chartEl = renderChart(source);
      pre.parentNode.replaceChild(chartEl, pre);
      return;
    }

    // HTML blocks — only show Run Visual if visual mode is on
    if (lang === 'html') {
      if (!state.visualMode) {
        // Render as normal styled code block
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        const header = document.createElement('div');
        header.className = 'code-block-header';
        const langSpan = document.createElement('span');
        langSpan.textContent = 'html';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = () => { navigator.clipboard.writeText(code?.innerText || ''); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); };
        header.appendChild(langSpan);
        header.appendChild(copyBtn);
        wrapper.appendChild(header);
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        if (code) hljs.highlightElement(code);
        return;
      }
      const source = code.innerText;

      // Launch button — shown by default, click to render
      const launchBtn = document.createElement('button');
      launchBtn.className = 'html-launch-btn';
      launchBtn.title = 'Use this to render charts, graphs, animations, interactive visuals, and other rich content generated by Claude';
      launchBtn.innerHTML = `
        <span class="html-launch-icon">▶</span>
        <span class="html-launch-label">Run Visual</span>
        <span class="html-launch-hint">charts · graphs · animations · interactive</span>
      `;

      const wrapper = document.createElement('div');
      wrapper.className = 'html-preview-wrapper';
      wrapper.style.display = 'none';

      launchBtn.onclick = () => {
        launchBtn.style.display = 'none';
        wrapper.style.display = 'block';

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'html-preview-toolbar';
        toolbar.style.display = 'none';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'html-preview-title';
        titleSpan.textContent = 'Visual Preview';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'html-preview-btns';

        const expandBtn = document.createElement('button');
        expandBtn.className = 'html-preview-btn';
        expandBtn.title = 'Expand height';
        expandBtn.innerHTML = '⬍';
        let expanded = false;
        expandBtn.onclick = () => {
          expanded = !expanded;
          frame.style.height = expanded ? '90vh' : (frame._autoHeight || '300px');
          expandBtn.innerHTML = expanded ? '⬌' : '⬍';
          expandBtn.title = expanded ? 'Shrink' : 'Expand';
        };

        const fsBtn = document.createElement('button');
        fsBtn.className = 'html-preview-btn';
        fsBtn.title = 'Fullscreen';
        fsBtn.innerHTML = '⛶';
        fsBtn.onclick = () => {
          if (!document.fullscreenElement) {
            wrapper.requestFullscreen();
          } else {
            document.exitFullscreen();
          }
        };

        const closeBtn = document.createElement('button');
        closeBtn.className = 'html-preview-btn';
        closeBtn.title = 'Close preview';
        closeBtn.innerHTML = '✕';
        closeBtn.onclick = () => {
          wrapper.style.display = 'none';
          launchBtn.style.display = 'flex';
        };

        document.addEventListener('fullscreenchange', () => {
          const isFs = !!document.fullscreenElement;
          fsBtn.innerHTML = isFs ? '⤓' : '⛶';
          fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
          // Hide close btn in fullscreen to avoid two exit buttons
          closeBtn.style.display = isFs ? 'none' : 'flex';
        });

        btnGroup.appendChild(expandBtn);
        btnGroup.appendChild(fsBtn);
        btnGroup.appendChild(closeBtn);
        toolbar.appendChild(titleSpan);
        toolbar.appendChild(btnGroup);

        const loader = document.createElement('div');
        loader.className = 'html-preview-loader';
        loader.innerHTML = '<div class="html-loader-spinner"></div><span>Rendering…</span>';

        const frame = document.createElement('iframe');
        frame.className = 'html-preview-frame';
        frame.style.display = 'none';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = source;

        frame.onload = () => {
          try {
            const h = frame.contentDocument.body.scrollHeight;
            const autoH = Math.min(Math.max(h + 20, 120), 600) + 'px';
            frame._autoHeight = autoH;
            frame.style.height = autoH;
          } catch(e) { frame._autoHeight = '300px'; frame.style.height = '300px'; }
          loader.style.display = 'none';
          frame.style.display = 'block';
          toolbar.style.display = 'flex';
        };

        wrapper.appendChild(toolbar);
        wrapper.appendChild(loader);
        wrapper.appendChild(frame);
      };

      const container = document.createElement('div');
      container.appendChild(launchBtn);
      container.appendChild(wrapper);
      pre.parentNode.replaceChild(container, pre);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langSpan = document.createElement('span');
    langSpan.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(code?.innerText || '');
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1500);
    };

    header.appendChild(langSpan);
    header.appendChild(copyBtn);
    wrapper.appendChild(header);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Apply highlight.js
    if (code) hljs.highlightElement(code);
  });

  // Render mermaid async after DOM insert
  if (pendingMermaid.length) {
    setTimeout(async () => {
      for (const { placeholder, source } of pendingMermaid) {
        if (placeholder.isConnected) {
          const el = await renderMermaid(source);
          placeholder.replaceWith(el);
        }
      }
    }, 0);
  }

  // Wrap tables for horizontal scroll without breaking layout
  div.querySelectorAll('table').forEach(table => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  // KaTeX math rendering
  if (typeof renderMathInElement !== 'undefined') {
    setTimeout(() => {
      if (div.isConnected) {
        renderMathInElement(div, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      }
    }, 0);
  }

  return div;
}

// ── Append message ──
export function appendMessage(role, text = '', files = [], msgId = null, model = '') {
  const container = document.getElementById('messages');
  const welcome = container.querySelector('.welcome');
  if (welcome) welcome.remove();

  const id = msgId || ('msg-' + Date.now() + '-' + Math.random().toString(36).slice(2));

  // ── ASSISTANT: single row with avatar header + content ──
  if (role === 'assistant') {
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    row.dataset.msgId = id;

    const header = document.createElement('div');
    header.className = 'claude-header';
    const avatar = document.createElement('div');
    avatar.className = 'claude-avatar';
    const displayModel = model ? model.replace(/^colab:/, '') : '';
    const shortName = displayModel ? displayModel.split(':')[0].split('-').slice(0,2).join('-') : 'AI';
    avatar.textContent = shortName[0].toUpperCase();
    const name = document.createElement('span');
    name.className = 'claude-name';
    name.textContent = displayModel || 'AI';
    header.appendChild(avatar);
    header.appendChild(name);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'bubble-content';
    if (text) {
      const rendered = renderMarkdown(stripBonsai(text));
      contentDiv.appendChild(rendered);
    }
    bubble.appendChild(contentDiv);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => { navigator.clipboard.writeText(contentDiv.innerText); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); };
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn delete-btn';
    delBtn.textContent = 'Delete';
    delBtn.onclick = () => { row.remove(); document.dispatchEvent(new CustomEvent('deleteMessage', { detail: { id } })); };
    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);

    row.appendChild(header);
    row.appendChild(bubble);
    row.appendChild(actions);
    container.appendChild(row);
    scrollBottom();
    return { bubble, contentDiv, id };
  }

  // ── USER: separate bubbles for files and text ──
  const imageFiles = files.filter(f => f.type === 'image');
  const textFiles = files.filter(f => f.type === 'text');
  const wrapper = document.createElement('div');
  wrapper.className = 'message-row user';
  wrapper.dataset.msgId = id;

  // Files bubble (images + text files together if any)
  if (imageFiles.length > 0 || textFiles.length > 0) {
    const filesBubble = document.createElement('div');
    filesBubble.className = 'message-bubble files-bubble';

    for (const f of imageFiles) {
      const img = document.createElement('img');
      img.className = 'chat-image';
      img.src = f.data;
      img.alt = f.name;
      img.title = f.name;
      img.onclick = () => openLightbox(f.data);
      filesBubble.appendChild(img);
    }

    if (textFiles.length > 0) {
      const chipsDiv = document.createElement('div');
      chipsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      for (const f of textFiles) {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        const ext = f.name.split('.').pop().toUpperCase().slice(0,4);
        chip.innerHTML = `<div class="file-chip-icon">${ext}</div><span class="file-chip-name">${f.name}</span>`;
        chipsDiv.appendChild(chip);
      }
      filesBubble.appendChild(chipsDiv);
    }
    wrapper.appendChild(filesBubble);
  }

  // Text bubble
  if (text) {
    const textBubble = document.createElement('div');
    textBubble.className = 'message-bubble';
    textBubble.textContent = text;
    wrapper.appendChild(textBubble);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => { navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); };
  const delBtn = document.createElement('button');
  delBtn.className = 'action-btn delete-btn';
  delBtn.textContent = 'Delete';
  delBtn.onclick = () => { wrapper.remove(); document.dispatchEvent(new CustomEvent('deleteMessage', { detail: { id } })); };
  actions.appendChild(copyBtn);
  actions.appendChild(delBtn);
  wrapper.appendChild(actions);

  container.appendChild(wrapper);
  scrollBottom();

  return { bubble: wrapper, contentDiv: wrapper, id };
}

// ── Update assistant bubble while streaming ──
export function updateBubble(contentDiv, text) {
  const rendered = renderMarkdown(stripBonsai(text));
  contentDiv.innerHTML = '';
  contentDiv.appendChild(rendered);
}

function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  lb.appendChild(img);
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

export function scrollBottom(force = false) {
  const c = document.getElementById('messages');
  // Only auto-scroll if user is near bottom or force
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  if (force || nearBottom) {
    c.scrollTop = c.scrollHeight;
  }
}

export function clearMessages() {
  document.getElementById('messages').innerHTML =
    '<div class="welcome"><h2>How can I help you today?</h2><p>Select a model and start chatting.</p></div>';
}

export function setSendDisabled(v) {
  document.getElementById('sendBtn').disabled = v;
}

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

export function renderHistory(sessions, activeId, onLoad, onDelete) {
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  const ids = Object.keys(sessions).sort((a, b) => b - a);
  for (const id of ids) {
    const s = sessions[id];
    const item = document.createElement('div');
    item.className = 'history-item' + (id === activeId ? ' active' : '');
    item.dataset.id = id;

    const span = document.createElement('span');
    span.className = 'history-item-title';
    span.textContent = s.title || 'New Chat';

    const del = document.createElement('button');
    del.className = 'history-delete';
    del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); onDelete(id); };

    item.appendChild(span);
    item.appendChild(del);
    item.addEventListener('click', () => onLoad(id));
    list.appendChild(item);
  }
}

export function renderSessionMessages(messages) {
  const container = document.getElementById('messages');
  container.innerHTML = '';
  const visible = messages.filter(m => m.role !== 'system');
  if (!visible.length) {
    container.innerHTML = '<div class="welcome"><h2>How can I help you today?</h2><p>Select a model and start chatting.</p></div>';
    return;
  }
  for (const msg of visible) {
    if (msg.role === 'summary') {
      appendSystemMessage(msg.content, msg.id);
    } else {
      appendMessage(msg.role, msg.content, msg.files || [], msg.id, msg.model || '');
    }
  }
  requestAnimationFrame(() => scrollBottom(true));
}

// ── Append system message (Conversation Summary) ──
export function appendSystemMessage(text, msgId = null) {
  const container = document.getElementById('messages');
  const welcome = container.querySelector('.welcome');
  if (welcome) welcome.remove();

  const id = msgId || ('msg-' + Date.now() + '-' + Math.random().toString(36).slice(2));

  const row = document.createElement('div');
  row.className = 'message-row system';
  row.dataset.msgId = id;

  const header = document.createElement('div');
  header.className = 'system-header';
  const avatar = document.createElement('div');
  avatar.className = 'system-avatar';
  avatar.textContent = '📋';
  const name = document.createElement('span');
  name.className = 'system-name';
  name.textContent = 'Conversation Summary';
  header.appendChild(avatar);
  header.appendChild(name);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => { navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); };
  actions.appendChild(copyBtn);

  row.appendChild(header);
  row.appendChild(bubble);
  row.appendChild(actions);
  container.appendChild(row);
  scrollBottom();
  return { id };
}

// ── Show Conversation Summary Popup ──
export function showSummaryPopup(usedTokens, limitTokens, onYes, onNo) {
  // Remove any existing popup
  const existing = document.getElementById('summaryOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'summary-overlay open';
  overlay.id = 'summaryOverlay';

  const popup = document.createElement('div');
  popup.className = 'summary-popup';

  popup.innerHTML = `
    <div class="summary-popup-header">
      <div class="summary-popup-icon">📋</div>
      <span class="summary-popup-title">Conversation Getting Long</span>
    </div>
    <div class="summary-popup-body">
      <p>Your conversation has reached <strong>70% of the context limit</strong>. Would you like to summarize and compress the history?</p>
      <div class="summary-token-info">
        <span>⚡ ${usedTokens.toLocaleString()} / ${limitTokens.toLocaleString()} tokens used</span>
      </div>
      <p style="margin-top:10px;font-size:12px;">Choosing <strong>Yes</strong> will generate a summary using the active model, clear the history, and continue with the summary as context.</p>
    </div>
    <div class="summary-popup-footer">
      <button class="summary-btn-no" id="summaryBtnNo">No, Keep Going</button>
      <button class="summary-btn-yes" id="summaryBtnYes">Yes, Summarize</button>
    </div>
  `;

  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  document.getElementById('summaryBtnNo').addEventListener('click', () => {
    close();
    if (onNo) onNo();
  });

  document.getElementById('summaryBtnYes').addEventListener('click', async () => {
    const yesBtn = document.getElementById('summaryBtnYes');
    const noBtn = document.getElementById('summaryBtnNo');
    yesBtn.disabled = true;
    yesBtn.textContent = 'Summarizing...';
    noBtn.disabled = true;
    await onYes();
    close();
  });
}

// ── Model Loading Indicator ──
let _loadingRow = null;

export function showModelLoading(modelName) {
  hideModelLoading();
  const container = document.getElementById('messages');
  const welcome = container.querySelector('.welcome');
  if (welcome) welcome.remove();

  const row = document.createElement('div');
  row.className = 'message-row assistant model-loading-row';
  row.id = 'modelLoadingRow';

  const header = document.createElement('div');
  header.className = 'claude-header';
  const avatar = document.createElement('div');
  avatar.className = 'claude-avatar';
  avatar.textContent = (modelName || 'AI')[0].toUpperCase();
  const name = document.createElement('span');
  name.className = 'claude-name';
  name.textContent = modelName || 'AI';
  header.appendChild(avatar);
  header.appendChild(name);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble model-loading-bubble';
  bubble.innerHTML = `
    <div class="model-loading-inner">
      <div class="model-loading-spinner"></div>
      <span class="model-loading-text">Loading model <strong>${modelName || ''}</strong>…</span>
    </div>
  `;

  row.appendChild(header);
  row.appendChild(bubble);
  container.appendChild(row);
  _loadingRow = row;
  scrollBottom();
}

export function hideModelLoading() {
  if (_loadingRow) {
    _loadingRow.remove();
    _loadingRow = null;
  }
  const el = document.getElementById('modelLoadingRow');
  if (el) el.remove();
}

export function showAttachedFiles(files, onRemove) {
  const container = document.getElementById('attachedFiles');
  container.innerHTML = '';
  files.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'attach-preview';

    if (f.type === 'image') {
      const img = document.createElement('img');
      img.src = f.data;
      div.appendChild(img);
    } else {
      const icon = document.createElement('div');
      const ext = f.name.split('.').pop().toUpperCase().slice(0,4);
      icon.className = 'file-chip-icon small';
      icon.textContent = ext;
      div.appendChild(icon);
    }

    const name = document.createElement('span');
    name.textContent = f.name;
    div.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'remove-file';
    btn.textContent = '✕';
    btn.onclick = () => onRemove(i);
    div.appendChild(btn);

    container.appendChild(div);
  });
}

