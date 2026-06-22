import { streamChat, getProvider, getClaudeBase, getOllamaBase } from './api.js';
import { streamGemini } from './gemini.js';
import { updateBubble, appendMessage, scrollBottom, stripBonsai, showModelLoading, hideModelLoading } from './ui.js';
import { buildOllamaMessages } from './files.js';
import { getGeminiKey } from './settings.js';

export async function sendMessage(model, history, options = {}, overrideBase = null) {
  const { state } = await import('./state.js');

  // Strip colab: prefix for display
  const _displayModel = model.startsWith('colab:') ? model.slice(6) : model;
  const _provider = getProvider(_displayModel);
  const _showLoader = _provider === 'ollama';

  let bubble = null;
  let contentDiv = null;

  function _ensureBubble() {
    if (bubble) return;
    if (_showLoader) hideModelLoading();
    ({ bubble, contentDiv } = appendMessage('assistant', '', [], null, _displayModel));
    if (!state.visualMode) bubble.classList.add('streaming-cursor');
  }

  // Ollama: show loading spinner, defer bubble until first token
  // Claude/Gemini: create bubble immediately so streaming cursor / dots show right away
  if (_showLoader) {
    showModelLoading(_displayModel);
    scrollBottom();
  } else {
    _ensureBubble();
    // In visual mode, add dots immediately for Claude/Gemini
    if (state.visualMode && contentDiv) {
      const dots = document.createElement('div');
      dots.className = 'typing-dots';
      dots.style.paddingLeft = '0';
      dots.innerHTML = '<span></span><span></span><span></span>';
      contentDiv.appendChild(dots);
    }
    scrollBottom();
  }

  let fullText = '';
  let firstToken = true;
  let userScrolledUp = false;

  const messagesEl = document.getElementById('messages');
  const onScroll = () => {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    userScrolledUp = !nearBottom;
  };
  messagesEl.addEventListener('scroll', onScroll);

  // Pick the right stream generator
  const provider = getProvider(model);
  let streamGen;

  if (provider === 'gemini') {
    const apiKey = getGeminiKey();
    if (!apiKey) {
      if (_showLoader) hideModelLoading();
      _ensureBubble();
      contentDiv.innerHTML = '';
      contentDiv.textContent = '⚠️ No Gemini API key set. Open ⚙ Settings and add your key.';
      messagesEl.removeEventListener('scroll', onScroll);
      bubble.classList.remove('streaming-cursor');
      return '';
    }
    streamGen = streamGemini(apiKey, model, history, options);
  } else if (provider === 'claude') {
    const ollamaMessages = buildOllamaMessages(history);
    streamGen = streamChat(model, ollamaMessages, options, getClaudeBase());
  } else {
    const ollamaMessages = buildOllamaMessages(history);
    const base = overrideBase || getOllamaBase();
    streamGen = streamChat(model, ollamaMessages, options, base);
  }

  if (state.visualMode) {
    try {
      for await (const token of streamGen) {
        if (firstToken) {
          // Ollama: bubble deferred, create it now with dots
          // Claude/Gemini: bubble already exists with dots, just ensure
          if (_showLoader) {
            _ensureBubble();
            const dots = document.createElement('div');
            dots.className = 'typing-dots';
            dots.style.paddingLeft = '0';
            dots.innerHTML = '<span></span><span></span><span></span>';
            contentDiv.appendChild(dots);
          }
          firstToken = false;
        }
        fullText += token;
        if (!userScrolledUp) scrollBottom();
      }
    } catch (e) {
      if (_showLoader) hideModelLoading();
      _ensureBubble();
      contentDiv.innerHTML = '';
      contentDiv.textContent = '⚠️ Error: ' + e.message;
      messagesEl.removeEventListener('scroll', onScroll);
      return '';
    }
  } else {
    let lastRender = 0;
    let renderScheduled = false;

    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        const now = Date.now();
        if (now - lastRender >= 80) {
          lastRender = now;
          updateBubble(contentDiv, fullText);
        }
      });
    };

    try {
      for await (const token of streamGen) {
        if (firstToken) { _ensureBubble(); firstToken = false; }
        fullText += token;
        scheduleRender();
        if (!userScrolledUp) scrollBottom();
      }
    } catch (e) {
      if (_showLoader) hideModelLoading();
      _ensureBubble();
      contentDiv.innerHTML = '';
      contentDiv.textContent = '⚠️ Error: ' + e.message;
      messagesEl.removeEventListener('scroll', onScroll);
      bubble.classList.remove('streaming-cursor');
      return '';
    }
  }

  if (_showLoader) hideModelLoading();
  _ensureBubble();
  messagesEl.removeEventListener('scroll', onScroll);
  bubble.classList.remove('streaming-cursor');

  const cleaned = stripBonsai(fullText);
  await new Promise(r => requestAnimationFrame(r));
  updateBubble(contentDiv, cleaned);
  scrollBottom(true);
  return cleaned;
}
