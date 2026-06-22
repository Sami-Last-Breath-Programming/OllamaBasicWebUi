export const TOKEN_LIMIT = 1_000_000;

export function getOllamaBase() {
  return localStorage.getItem('ollamaUrl') || 'http://localhost:11434';
}

export function _ngrokHeaders(base) {
  const isNgrok = base && !base.includes('localhost') && !base.includes('127.0.0.1');
  return isNgrok ? { 'ngrok-skip-browser-warning': 'true' } : {};
}

export function getColabOllamaBase() {
  return localStorage.getItem('ollamaColabUrl') || '';
}

export function getClaudeBase() {
  return localStorage.getItem('claudeUrl') || 'http://localhost:5000';
}

export function getProvider(model) {
  if (!model) return 'ollama';
  const m = model.toLowerCase();
  if (m.startsWith('gemini')) return 'gemini';
  if (m.includes('claude')) return 'claude';
  return 'ollama';
}

export async function fetchClaudeModels() {
  const base = getClaudeBase();
  const res = await fetch(base + '/api/tags');
  if (!res.ok) throw new Error('Claude.py ' + res.status);
  const data = await res.json();
  return (data.models || []).map(m => m.name);
}

// Vision-capable Ollama models (detected from /api/tags families)
const _visionModels = new Set();

export function modelSupportsVision(modelName) {
  if (!modelName) return false;
  const name = modelName.replace(/^colab:/, '').toLowerCase();
  // Known vision model name patterns
  if (/llava|bakllava|moondream|minicpm-v|qwen.*vl|internvl|cogvlm|phi.*vision|gemma3.*vision/.test(name)) return true;
  return _visionModels.has(name);
}

export async function fetchOllamaModels() {
  const base = getOllamaBase();
  const res = await fetch(base + '/api/tags', {
    headers: { 'Content-Type': 'application/json', ..._ngrokHeaders(base) }
  });
  if (!res.ok) throw new Error('Ollama ' + res.status);
  const data = await res.json();
  (data.models || []).forEach(m => {
    const families = m.details?.families || [];
    if (families.includes('clip') || families.includes('vision')) {
      _visionModels.add(m.name.toLowerCase());
    }
  });
  return (data.models || []).map(m => m.name);
}

export async function fetchColabOllamaModels() {
  const base = getColabOllamaBase();
  if (!base) return [];
  const res = await fetch(base + '/api/tags', {
    headers: { 'Content-Type': 'application/json', ..._ngrokHeaders(base) }
  });
  if (!res.ok) throw new Error('Colab Ollama ' + res.status);
  const data = await res.json();
  (data.models || []).forEach(m => {
    const families = m.details?.families || [];
    if (families.includes('clip') || families.includes('vision')) {
      _visionModels.add(m.name.toLowerCase());
    }
  });
  return (data.models || []).map(m => m.name);
}

export async function* streamChat(model, ollamaMessages, options = {}, base = null) {
  if (!base) base = getOllamaBase();
  const chatUrl = base + '/api/chat';

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ..._ngrokHeaders(base) },
    body: JSON.stringify({
      model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 8192
      }
    })
  });

  if (!res.ok) throw new Error('HTTP ' + res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n').filter(l => l.trim())) {
      try {
        const json = JSON.parse(line);
        if (json.message && json.message.content) yield json.message.content;
      } catch {}
    }
  }
}
