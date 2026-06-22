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

API_KEY = ""

# Removed manual 'host' header to prevent SNI conflicts
HEADERS = {
    "authorization": f"Bearer {API_KEY}",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,adaptive-thinking-2026-01-28",
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.50 (external, cli)",
    "x-app": "cli"
}

MAX_RETRIES = 3
RETRY_DELAY = 2

# Use a Session for better connection stability
session = req.Session()

# ── Helpers ──────────────────────────────────────────────

def detect_image_type(b64_string):
    try:
        padding = 4 - len(b64_string) % 4
        padded = b64_string + ('=' * padding) if padding != 4 else b64_string
        header = base64.b64decode(padded[:20])
        if header[:8] == b'\x89PNG\r\n\x1a\n': return "image/png"
        elif header[:3] == b'\xff\xd8\xff': return "image/jpeg"
        elif header[:6] in (b'GIF87a', b'GIF89a'): return "image/gif"
        elif b'WEBP' in header[:12]: return "image/webp"
    except: pass
    return "image/jpeg"

def parse_data_uri(data_uri):
    match = re.match(r'data:(image/[^;]+);base64,(.+)', data_uri)
    if match: return match.group(1), match.group(2)
    return None, data_uri

def ollama_to_claude_messages(ollama_messages):
    system_text = ""
    messages = []
    for msg in ollama_messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        images = msg.get("images", [])

        if role == "system":
            if isinstance(content, list):
                system_text = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
            else:
                system_text = str(content)
            continue

        if role == "assistant":
            if isinstance(content, list):
                text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
            else:
                text = str(content)
            messages.append({"role": "assistant", "content": [{"type": "text", "text": text}]})
            continue

        content_blocks = []
        if isinstance(content, list):
            for block in content:
                if isinstance(block, str):
                    content_blocks.append({"type": "text", "text": block})
                elif isinstance(block, dict):
                    btype = block.get("type", "")
                    if btype == "text":
                        content_blocks.append({"type": "text", "text": block.get("text", "")})
                    elif btype == "image_url":
                        img_url = block.get("image_url", {})
                        url = img_url if isinstance(img_url, str) else img_url.get("url", "")
                        if url.startswith("data:"):
                            media_type, b64_data = parse_data_uri(url)
                            if not media_type: media_type = detect_image_type(b64_data)
                            content_blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64_data}})
                        elif url.startswith("http"):
                            try:
                                img_resp = session.get(url, timeout=15)
                                b64_data = base64.b64encode(img_resp.content).decode()
                                ct = img_resp.headers.get("Content-Type", "image/jpeg")
                                content_blocks.append({"type": "image", "source": {"type": "base64", "media_type": ct.split(";")[0], "data": b64_data}})
                            except:
                                content_blocks.append({"type": "text", "text": f"[Image: {url}]"})
                    elif btype == "image":
                        content_blocks.append(block)
        else:
            for img_b64 in images:
                media_type = detect_image_type(img_b64)
                content_blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": img_b64}})
            if content:
                content_blocks.append({"type": "text", "text": str(content)})

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
            elif isinstance(fixed[-1]["content"], list):
                fixed[-1]["content"].append({"type": "text", "text": str(msg["content"])})
            else:
                fixed[-1]["content"] = str(fixed[-1]["content"]) + "\n" + str(msg["content"])
        else:
            fixed.append(msg)
    while fixed and fixed[0]["role"] != "user": fixed.pop(0)
    if not fixed: fixed = [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
    return fixed

def build_payload(messages, system_text="", max_tokens=32000, model="claude-opus-4-6"):
    # Critical headers for beta API
    system_blocks = [
        {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.50.b97; cc_entrypoint=cli; cch=00000;"},
        {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": {"type": "ephemeral"}}
    ]
    
    if system_text:
        system_blocks.append({"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}})

    return {
        "model": model,
        "messages": messages,
        "system": system_blocks,
        "tools": [],
        "metadata": {"user_id": "user_proxy_session"},
        "max_tokens": max_tokens,
        "thinking": {"type": "adaptive"},
        "stream": True
    }

# ── Streaming with Crash Protection ──────────────────────

def api_post_with_retry(url, headers, json_payload, stream=True, timeout=300):
    for attempt in range(MAX_RETRIES):
        try:
            r = session.post(url, headers=headers, json=json_payload, stream=stream, timeout=timeout)
            if r.status_code in (502, 503):
                print(f"[retry] HTTP {r.status_code}, waiting...")
                time.sleep(RETRY_DELAY * (attempt + 1))
                continue
            return r
        except Exception as e:
            print(f"[retry] Connection Error: {e}")
            time.sleep(RETRY_DELAY)
    class FakeResponse:
        status_code = 502
        text = "Max retries exceeded"
        def json(self): return {"error": self.text}
        def iter_lines(self): return iter([])
    return FakeResponse()

def stream_text_chunks(r):
    # FALLBACK: If API returns JSON (common with errors or short replies)
    ct = r.headers.get("Content-Type", "").lower()
    if "application/json" in ct:
        try:
            data = r.json()
            if "error" in data:
                err = data['error']
                print(f"[stream] JSON Error: {err}")
                yield f"Error: {err}"
                return
            # Extract content from Anthropic JSON format
            content_list = data.get("content", [])
            text = "".join(c.get("text", "") for c in content_list if c.get("type") == "text")
            if text: yield text
            else: print(f"[stream] JSON body empty: {data}")
        except: pass
        return

    # Normal SSE parsing with Crash Protection
    try:
        for raw_line in r.iter_lines():
            if not raw_line: continue
            decoded = raw_line.decode('utf-8').strip()
            if not decoded.startswith("data:"): continue
            
            body = decoded[5:].strip()
            if body == "[DONE]": break
            
            try:
                chunk = json.loads(body)
                if chunk.get("type") == "content_block_delta":
                    delta = chunk.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        yield text
                elif chunk.get("type") == "error":
                    print(f"[stream] Error event: {chunk}")
            except: pass
    except (req.exceptions.ChunkedEncodingError, req.exceptions.ConnectionError, Exception) as e:
        print(f"\n[stream] CRITICAL: Stream died prematurely! {e}")
        yield "\n\n[Network Error: Connection to Claude was lost mid-stream. Please try again.]"

# ── Endpoints ────────────────────────────────────────────

@app.route("/", methods=["GET"])
def root(): return "Ollama is running"

@app.route("/api/tags", methods=["GET"])
def list_models():
    return jsonify({"models": [{"name": "claude-opus-4-6", "model": "claude-opus-4-6", "details": {"family": "claude"}}]})

@app.route("/api/chat", methods=["POST"])
def ollama_chat():
    data = request.json or {}
    messages = data.get("messages", [])
    model = data.get("model", "claude-opus-4-6")
    
    print(f"\n===== INCOMING /api/chat ({len(messages)} msgs) =====")
    for i, m in enumerate(messages):
        c = m.get("content", "")
        print(f"  [{i}] {m.get('role')}: {str(c)[:60]}...")

    system, claude_msgs = ollama_to_claude_messages(messages)
    fixed_msgs = fix_messages(claude_msgs)
    payload = build_payload(fixed_msgs, system_text=system, max_tokens=32000, model=model)

    def generate():
        r = api_post_with_retry(API_URL, HEADERS, payload, stream=True)
        print(f"[chat] Upstream status: {r.status_code}")
        
        if r.status_code != 200:
            err = r.text[:200]
            print(f"[chat] Error: {err}")
            yield json.dumps({"model": model, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), 
                             "message": {"role": "assistant", "content": f"Error {r.status_code}: {err}"}, "done": True}) + "\n"
            return

        for chunk in stream_text_chunks(r):
            yield json.dumps({"model": model, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), 
                             "message": {"role": "assistant", "content": chunk}, "done": False}) + "\n"
        
        yield json.dumps({"model": model, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), 
                         "message": {"role": "assistant", "content": ""}, "done": True}) + "\n"

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")

@app.route("/v1/chat/completions", methods=["POST"])
def openai_chat():
    data = request.json or {}
    messages = data.get("messages", [])
    model = data.get("model", "claude-opus-4-6")

    system, claude_msgs = ollama_to_claude_messages(messages)
    fixed_msgs = fix_messages(claude_msgs)
    payload = build_payload(fixed_msgs, system_text=system, max_tokens=32000, model=model)

    def generate():
        r = api_post_with_retry(API_URL, HEADERS, payload, stream=True)
        rid = f"chatcmpl-{uuid.uuid4().hex[:8]}"
        
        if r.status_code != 200:
            yield f"data: {json.dumps({'error': f'Error {r.status_code}'})}\n\n"
            return

        first = True
        for chunk in stream_text_chunks(r):
            delta = {"role": "assistant", "content": chunk} if first else {"content": chunk}
            first = False
            yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]})}\n\n"
        
        yield f"data: {json.dumps({'id': rid, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")

# ── Static/Proxy ─────────────────────────────────────────
@app.route("/ui")
def serve_ui(): return send_from_directory('ollama-arena', 'index.html')
@app.route("/ui/<path:path>")
def serve_static(path): return send_from_directory('ollama-arena', path)
@app.route("/ollama/api/tags", methods=["GET"])
def ollama_tags_proxy():
    try: return Response(req.get(f"{request.args.get('base')}/api/tags").content)
    except: return jsonify({"error": "proxy fail"}), 500

if __name__ == "__main__":
    print(f"Starting Proxy on port 5000...")
    app.run(host="0.0.0.0", port=5000, debug=False)