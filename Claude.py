import json
import re
import time
import uuid
import base64
from flask import Flask, request, jsonify, Response, stream_with_context, send_from_directory
from flask_cors import CORS
import requests as req

app = Flask(__name__)
CORS(app)

API_KEY = ''

API_URL = "https://go.trybons.ai/v1/messages?beta=true"
HEADERS = {
    "host": "go.trybons.ai",
    "authorization": f"Bearer {API_KEY}",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,adaptive-thinking-2026-01-28",
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.50 (external, cli)",
    "x-app": "cli"
}

BONSAI_MARKERS = [
    '<bonsai>',
    '</bonsai>',
    '</bonsai_context>',
    '@bonsai:',
    'routing to stealth',
    'free premium model'
]

# ── Bonsai filtering ─────────────────────────────────────

def is_bonsai_line(text):
    t = text.lower().strip()
    return any(m.lower() in t for m in BONSAI_MARKERS)

def strip_bonsai(text):
    text = re.sub(r'🌱\s*`?@bonsai:[^`\n]*`?', '', text)
    text = re.sub(r'</?bonsai[^>]*>', '', text)
    text = re.sub(r'</?bonsai_context[^>]*>', '', text)
    lines = text.split('\n')
    cleaned = [l for l in lines if not is_bonsai_line(l)]
    result = re.sub(r'\n{3,}', '\n\n', '\n'.join(cleaned))
    return result.strip()

# ── Image detection ──────────────────────────────────────

def detect_image_type(b64_string):
    try:
        padding = 4 - len(b64_string) % 4
        padded = b64_string + ('=' * padding) if padding != 4 else b64_string
        header = base64.b64decode(padded[:20])
        if header[:8] == b'\x89PNG\r\n\x1a\n':
            return "image/png"
        elif header[:3] == b'\xff\xd8\xff':
            return "image/jpeg"
        elif header[:6] in (b'GIF87a', b'GIF89a'):
            return "image/gif"
        elif b'WEBP' in header[:12]:
            return "image/webp"
    except Exception:
        pass
    return "image/jpeg"

# ── Message conversion ───────────────────────────────────

def ollama_to_claude_messages(ollama_messages):
    system_text = ""
    messages = []

    for msg in ollama_messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        images = msg.get("images", [])

        if role == "system":
            system_text = content
            continue

        if role == "assistant":
            messages.append({
                "role": "assistant",
                "content": [{"type": "text", "text": content}]
            })
            continue

        # User message — build content blocks
        content_blocks = []

        # Images first
        for img_b64 in images:
            media_type = detect_image_type(img_b64)
            print(f"  [image] {media_type}, data[:20]={img_b64[:20]}")
            content_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": img_b64
                }
            })

        # Then text
        if content:
            content_blocks.append({"type": "text", "text": content})

        if not content_blocks:
            content_blocks = [{"type": "text", "text": "Hello"}]

        messages.append({"role": "user", "content": content_blocks})

    return system_text, messages


def fix_messages(claude_messages):
    fixed = []
    for msg in claude_messages:
        if fixed and fixed[-1]["role"] == msg["role"]:
            if isinstance(fixed[-1]["content"], list) and isinstance(msg["content"], list):
                fixed[-1]["content"].extend(msg["content"])
            else:
                fixed[-1]["content"] = str(fixed[-1]["content"]) + "\n" + str(msg["content"])
        else:
            fixed.append(msg)

    if not fixed:
        fixed = [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
    while fixed and fixed[0]["role"] != "user":
        fixed.pop(0)
    return fixed


def build_payload(messages, system_text="", max_tokens=32000):
    system_blocks = [
        {
            "type": "text",
            "text": "x-anthropic-billing-header: cc_version=2.1.50.b97; cc_entrypoint=cli; cch=00000;"
        },
        {
            "type": "text",
            "text": "You are Claude Code, Anthropic's official CLI for Claude.",
            "cache_control": {"type": "ephemeral"}
        },
        {
            "type": "text",
            "text": (
                "CRITICAL INSTRUCTION: You are a helpful AI assistant (claude-opus-4-6) "
                "interacting with the user through a standard web chat interface, NOT a CLI.\n\n"
                "IMPORTANT: You are STRICTLY FORBIDDEN from using ANY tools.\n\n"
                "Rules:\n"
                "1. NEVER use any tools.\n"
                "2. Answer directly and helpfully.\n"
                "3. When images are provided, analyze and describe them in detail.\n"
                "4. Format responses in Markdown when appropriate."
            ),
            "cache_control": {"type": "ephemeral"}
        }
    ]

    if system_text:
        system_blocks.append({
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"}
        })

    return {
        "model": "claude-opus-4-6",
        "messages": messages,
        "system": system_blocks,
        "tools": [],
        "metadata": {"user_id": "user_proxy_session"},
        "max_tokens": max_tokens,
        "thinking": {"type": "adaptive"},
        "stream": True
    }


def stream_text_chunks(r):
    stream_buf = ""
    for raw_line in r.iter_lines():
        if not raw_line:
            continue
        decoded = raw_line.decode('utf-8')
        if not decoded.startswith("data: "):
            continue
        body = decoded[6:]
        if body.strip() == "[DONE]":
            break
        try:
            chunk = json.loads(body)
            if chunk.get("type") == "content_block_delta":
                delta = chunk.get("delta", {})
                if delta.get("type") == "text_delta":
                    text = delta.get("text", "")
                    stream_buf += text
                    while '\n' in stream_buf:
                        line_text, stream_buf = stream_buf.split('\n', 1)
                        full_line = line_text + '\n'
                        if not is_bonsai_line(full_line):
                            yield full_line
        except Exception as e:
            print(f"Parse error: {e}")

    if stream_buf and not is_bonsai_line(stream_buf):
        yield stream_buf

# ── Routes ───────────────────────────────────────────────

@app.route("/api/tags", methods=["GET"])
def list_models():
    return jsonify({
        "models": [
            {"name": "claude-opus-4-6",   "model": "claude-opus-4-6",   "modified_at": "2025-01-01T00:00:00Z", "size": 1000000000, "digest": "sha256:aaa", "details": {"family": "claude", "parameter_size": "200B"}},
            {"name": "claude-sonnet-4-5", "model": "claude-sonnet-4-5", "modified_at": "2025-01-01T00:00:00Z", "size": 800000000,  "digest": "sha256:bbb", "details": {"family": "claude", "parameter_size": "100B"}},
            {"name": "claude-haiku-3-5",  "model": "claude-haiku-3-5",  "modified_at": "2025-01-01T00:00:00Z", "size": 400000000,  "digest": "sha256:ccc", "details": {"family": "claude", "parameter_size": "20B"}}
        ]
    })


@app.route("/api/show", methods=["POST"])
def show_model():
    data = request.json or {}
    model = data.get("name", "claude-opus-4-6")
    return jsonify({
        "modelfile": f"FROM {model}",
        "parameters": "",
        "template": "",
        "details": {"parent_model": "", "format": "gguf", "family": "claude", "parameter_size": "200B"}
    })


@app.route("/api/chat", methods=["POST"])
def ollama_chat():
    data = request.json or {}
    messages = data.get("messages", [])
    stream = data.get("stream", True)
    model = data.get("model", "claude-opus-4-6")
    options = data.get("options", {})

    # Debug incoming
    print("\n===== INCOMING /api/chat =====")
    for i, msg in enumerate(messages):
        role = msg.get("role")
        content = str(msg.get("content", ""))[:80]
        images = msg.get("images", [])
        print(f"  [{i}] role={role} content={content!r}")
        if images:
            print(f"       {len(images)} image(s), type={detect_image_type(images[0])}, data[:20]={images[0][:20]!r}")
        else:
            print(f"       no images")
    print("==============================\n")

    system_text, claude_messages = ollama_to_claude_messages(messages)
    fixed_messages = fix_messages(claude_messages)

    # Debug outgoing
    print("===== SENDING TO API =====")
    for m in fixed_messages:
        if isinstance(m.get('content'), list):
            for block in m['content']:
                if block.get('type') == 'image':
                    print(f"  -> IMAGE {block['source']['media_type']} data[:20]={block['source']['data'][:20]}")
                elif block.get('type') == 'text':
                    print(f"  -> TEXT {block['text'][:60]!r}")
    print("==========================\n")

    api_payload = build_payload(
        messages=fixed_messages,
        system_text=system_text,
        max_tokens=options.get("num_predict", 32000)
    )

    if stream:
        def generate():
            try:
                r = req.post(API_URL, headers=HEADERS, json=api_payload, stream=True, timeout=120)
                print(f"[chat] response: {r.status_code}")
                if r.status_code != 200:
                    err = r.text
                    print(f"[chat] error: {err}")
                    yield json.dumps({
                        "model": model,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "message": {"role": "assistant", "content": f"API Error {r.status_code}: {err}"},
                        "done": True
                    }) + "\n"
                    return

                full_reply = ""
                for chunk in stream_text_chunks(r):
                    full_reply += chunk
                    yield json.dumps({
                        "model": model,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "message": {"role": "assistant", "content": chunk},
                        "done": False
                    }) + "\n"

                yield json.dumps({
                    "model": model,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "message": {"role": "assistant", "content": ""},
                    "done_reason": "stop",
                    "done": True,
                    "total_duration": 1000000000,
                    "eval_count": len(full_reply) // 4
                }) + "\n"

            except Exception as e:
                print(f"[chat] exception: {e}")
                yield json.dumps({
                    "model": model,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "message": {"role": "assistant", "content": f"Error: {str(e)}"},
                    "done": True
                }) + "\n"

        return Response(stream_with_context(generate()), mimetype="application/x-ndjson")

    else:
        try:
            api_payload["stream"] = False
            r = req.post(API_URL, headers=HEADERS, json=api_payload, timeout=120)
            result = r.json()
            content = "".join(b.get("text", "") for b in result.get("content", []) if b.get("type") == "text")
            content = strip_bonsai(content)
            return jsonify({
                "model": model,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "message": {"role": "assistant", "content": content},
                "done_reason": "stop",
                "done": True
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500


@app.route("/api/generate", methods=["POST"])
def ollama_generate():
    data = request.json or {}
    prompt = data.get("prompt", "")
    model = data.get("model", "claude-opus-4-6")
    stream = data.get("stream", True)
    system = data.get("system", "")

    messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
    api_payload = build_payload(messages=messages, system_text=system, max_tokens=32000)

    if stream:
        def generate():
            try:
                r = req.post(API_URL, headers=HEADERS, json=api_payload, stream=True, timeout=120)
                if r.status_code != 200:
                    yield json.dumps({"response": f"Error: {r.status_code}", "done": True}) + "\n"
                    return
                for chunk in stream_text_chunks(r):
                    yield json.dumps({"model": model, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "response": chunk, "done": False}) + "\n"
                yield json.dumps({"model": model, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "response": "", "done": True, "done_reason": "stop"}) + "\n"
            except Exception as e:
                yield json.dumps({"response": f"Error: {e}", "done": True}) + "\n"
        return Response(stream_with_context(generate()), mimetype="application/x-ndjson")

    return jsonify({"response": "Use stream=true", "done": True})


@app.route("/v1/models", methods=["GET"])
def openai_models():
    return jsonify({
        "object": "list",
        "data": [
            {"id": "claude-opus-4-6",   "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-sonnet-4-5", "object": "model", "created": 1700000000, "owned_by": "anthropic"},
            {"id": "claude-haiku-3-5",  "object": "model", "created": 1700000000, "owned_by": "anthropic"}
        ]
    })


@app.route("/v1/chat/completions", methods=["POST"])
def openai_chat():
    data = request.json or {}
    messages = data.get("messages", [])
    model = data.get("model", "claude-opus-4-6")
    stream = data.get("stream", False)

    system_text, claude_messages = ollama_to_claude_messages(messages)
    fixed_messages = fix_messages(claude_messages)
    api_payload = build_payload(
        messages=fixed_messages,
        system_text=system_text,
        max_tokens=data.get("max_tokens", 32000)
    )

    if stream:
        def generate():
            try:
                r = req.post(API_URL, headers=HEADERS, json=api_payload, stream=True, timeout=120)
                rid = f"chatcmpl-{uuid.uuid4().hex[:8]}"
                for chunk in stream_text_chunks(r):
                    yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model, 'choices': [{'index': 0, 'delta': {'content': chunk}, 'finish_reason': None}]})}\n\n"
                yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
        return Response(stream_with_context(generate()), mimetype="text/event-stream")

    else:
        try:
            api_payload["stream"] = False
            r = req.post(API_URL, headers=HEADERS, json=api_payload, timeout=120)
            result = r.json()
            content = strip_bonsai("".join(b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"))
            return jsonify({
                "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": len(content) // 4, "total_tokens": 100 + len(content) // 4}
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500


@app.route("/ui")
def serve_ui():
    return send_from_directory('ollama-arena', 'index.html')

@app.route("/ui/<path:path>")
def serve_static(path):
    return send_from_directory('ollama-arena', path)



OLLAMA_PROXY_HEADERS = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
    "User-Agent": "OllamaClient/1.0"
}

@app.route("/ollama/api/tags", methods=["GET"])
def ollama_proxy_tags():
    ollama_url = request.args.get("base", "").rstrip("/")
    if not ollama_url:
        return jsonify({"error": "No base URL provided"}), 400
    try:
        r = req.get(f"{ollama_url}/api/tags", headers=OLLAMA_PROXY_HEADERS, timeout=10)
        return Response(r.content, status=r.status_code, content_type="application/json")
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/ollama/api/chat", methods=["POST"])
def ollama_proxy_chat():
    ollama_url = request.args.get("base", "").rstrip("/")
    if not ollama_url:
        return jsonify({"error": "No base URL provided"}), 400
    data = request.get_data()
    try:
        r = req.post(f"{ollama_url}/api/chat", data=data, headers=OLLAMA_PROXY_HEADERS, stream=True, timeout=120)
        return Response(stream_with_context(r.iter_content(chunk_size=None)), status=r.status_code, content_type=r.headers.get("Content-Type", "application/x-ndjson"))
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/claude/api/chat", methods=["POST"])
def claude_proxy_chat():
    return ollama_chat()


@app.route("/ollama/pull", methods=["POST"])
def ollama_pull():
    data = request.get_json() or {}
    model = data.get("model", "").strip()
    ollama_url = request.args.get("base", "").rstrip("/") or data.get("base", "").rstrip("/") or "http://localhost:11435"
    if not model:
        return jsonify({"error": "No model name"}), 400

    def generate():
        try:
            r = req.post(
                f"{ollama_url}/api/pull",
                json={"name": model, "stream": True},
                headers={"Content-Type": "application/json"},
                stream=True, timeout=600
            )
            for line in r.iter_lines():
                if line:
                    yield line.decode("utf-8") + "\n"
        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n"

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")

@app.route("/chat")
def serve_chat():
    return send_from_directory('/home/lbs/Desktop/Webui', 'index.html')

@app.route("/chat/<path:path>")
def serve_chat_static(path):
    return send_from_directory('/home/lbs/Desktop/Webui', path)

@app.route("/", methods=["GET"])
def root():
    return jsonify({"status": "running", "models": ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-3-5"]})


if __name__ == "__main__":
    print("=" * 50)
    print("  TryBons -> Ollama/OpenAI Proxy")
    print("=" * 50)
    print("  Claude URL : http://localhost:5000")
    print("  OpenAI URL : http://localhost:5000/v1")
    print("  Web UI     : http://localhost:11434/ui")
    print("=" * 50)
    print("\nTesting API connection...")
    test_payload = build_payload([{"role": "user", "content": [{"type": "text", "text": "Hi"}]}])
    test_payload["stream"] = False
    try:
        r = req.post(API_URL, headers=HEADERS, json=test_payload, timeout=30)
        print(f"API Test: {r.status_code}")
        if r.status_code == 200:
            print("✓ API connection OK!")
        else:
            print(f"Error: {r.text[:200]}")
    except Exception as e:
        print(f"API Test failed: {e}")
    print("\nStarting server...")
    app.run(host="0.0.0.0", port=5000, debug=False)