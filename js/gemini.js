// Gemini API streaming support

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
];

function toGeminiMessages(history) {
  const messages = [];
  for (const msg of history) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (msg.files && msg.files.length > 0) {
      for (const f of msg.files) {
        if (f.type === 'image' && f.data) {
          const match = f.data.match(/^data:([^;]+);base64,(.+)$/);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
        // text files (PDFs extracted as text, .txt, etc.) are already embedded
        // in msg.content by buildFileMessage — no extra parts needed
      }
    }
    if (msg.content) parts.push({ text: msg.content });
    messages.push({ role, parts });
  }
  return messages;
}

function getSystemInstruction(history) {
  const sys = history.find(m => m.role === 'system');
  return sys ? sys.content : null;
}

export async function* streamGemini(apiKey, model, history, options = {}) {
  const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const body = {
    contents: toGeminiMessages(history),
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 8192,
    }
  };
  const sysInstruction = getSystemInstruction(history);
  if (sysInstruction) body.systemInstruction = { parts: [{ text: sysInstruction }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) throw new Error('Rate limit reached for this Gemini model. Try a different model or wait a moment.');
    if (res.status === 403) throw new Error('Gemini API key is invalid or lacks permission.');
    if (res.status === 404) throw new Error(`Gemini model "${model}" not found. Try a different model.`);
    throw new Error(`Gemini error ${res.status}: ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const parsed = JSON.parse(json);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {}
    }
  }
}