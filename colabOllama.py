# ============================================================
# Ollama + Flask CORS Proxy + ngrok Setup for Google Colab
# GPU-enabled version — uses official install.sh
# ============================================================

import subprocess
import os
import time
import requests
import threading
import json
import logging
import glob

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── 1. Install dependencies ──────────────────────────────────
print("📦 Installing dependencies...")
subprocess.run(["pip", "install", "pyngrok", "flask", "flask-cors", "-q"], check=True)

from pyngrok import ngrok # type: ignore
from flask import Flask, request, Response
from flask_cors import CORS

OLLAMA_BIN = "/usr/local/bin/ollama"

# ── 2. GPU check ─────────────────────────────────────────────
print("\n🔍 Checking GPU...")
gpu_check = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
has_gpu = gpu_check.returncode == 0
if has_gpu:
    print(f"✅ GPU detected: {gpu_check.stdout.strip()}")
else:
    print("⚠️  No GPU! Go to Runtime → Change runtime type → T4 GPU")

# ── 3. Build LD_LIBRARY_PATH with all CUDA paths ─────────────
cuda_lib_paths = [
    "/usr/lib64-nvidia",                    # real libcuda.so.1 on Colab T4
    "/usr/local/lib/ollama/cuda_v12",       # ollama's own CUDA runner
    "/usr/local/cuda-12.8/lib64",
    "/usr/local/cuda-12/lib64",
    "/usr/local/cuda/lib64",
    "/usr/lib/x86_64-linux-gnu",
]
for pattern in ["/usr/local/cuda*/lib64", "/root/.julia/artifacts/*/lib"]:
    cuda_lib_paths += glob.glob(pattern)
torch_lib = subprocess.run(["python3", "-c", "import torch; print(torch.__file__)"], capture_output=True, text=True)
if torch_lib.returncode == 0:
    td = os.path.dirname(torch_lib.stdout.strip()) + "/lib"
    if os.path.isdir(td): cuda_lib_paths.append(td)
existing_ld = os.environ.get("LD_LIBRARY_PATH", "")
all_paths = list(dict.fromkeys([p for p in cuda_lib_paths if os.path.isdir(p)]))
os.environ["LD_LIBRARY_PATH"] = ":".join(all_paths) + (":" + existing_ld if existing_ld else "")
print(f"📚 LD_LIBRARY_PATH: {os.environ['LD_LIBRARY_PATH'][:180]}")

# ── 4. Install Ollama via official script (includes GPU runner) ──
ollama_cuda_runner = "/usr/local/lib/ollama/cuda_v12/libggml-cuda.so"
if os.path.isfile(OLLAMA_BIN) and os.path.isfile(ollama_cuda_runner):
    ver = subprocess.run([OLLAMA_BIN, "--version"], capture_output=True, text=True)
    print(f"✅ Ollama + GPU runner already installed: {ver.stdout.strip()}")
else:
    if os.path.isfile(OLLAMA_BIN):
        print("⚠️  Ollama binary exists but GPU runner missing — reinstalling...")
        os.remove(OLLAMA_BIN)
    else:
        print("\n📥 Installing Ollama (official install.sh with GPU support)...")
    # Install lspci so installer can detect GPU
    subprocess.run(["apt-get", "install", "-y", "-q", "pciutils"], capture_output=True)
    result = subprocess.run(
        "curl -fsSL https://ollama.com/install.sh | sh",
        shell=True,
        env={**os.environ, "HOME": "/root"},
        capture_output=True, text=True
    )
    print(result.stdout[-1500:])
    if result.returncode != 0:
        print("STDERR:", result.stderr[-500:])
        raise RuntimeError("Ollama install failed")
    ver = subprocess.run([OLLAMA_BIN, "--version"], capture_output=True, text=True)
    print(f"✅ Ollama installed: {ver.stdout.strip()}")
    # Confirm GPU runner
    if os.path.isfile(ollama_cuda_runner):
        print("✅ GPU runner (libggml-cuda.so) confirmed!")
    else:
        print("⚠️  GPU runner not found — will try CPU fallback")

# ── 5. Start Ollama server ────────────────────────────────────
print("\n🚀 Starting Ollama server...")
# Kill any leftover ollama processes
subprocess.run(["pkill", "-9", "-f", "ollama serve"], capture_output=True)
time.sleep(1)

ollama_env = os.environ.copy()
ollama_env["OLLAMA_HOST"] = "0.0.0.0"
ollama_env["OLLAMA_ORIGINS"] = "*"
ollama_env["HOME"] = "/root"
ollama_env["CUDA_VISIBLE_DEVICES"] = "0"
ollama_env["OLLAMA_NUM_GPU"] = "99"
ollama_env["OLLAMA_FLASH_ATTENTION"] = "1"
ollama_env["OLLAMA_GPU_OVERHEAD"] = "0"

server_log = open("/tmp/ollama_server.log", "w")
server_process = subprocess.Popen(
    [OLLAMA_BIN, "serve"],
    env=ollama_env,
    stdout=server_log,
    stderr=server_log
)

# ── Live Ollama log tailer ───────────────────────────────────
def tail_ollama_logs():
    import time as _time
    _time.sleep(3)  # wait for file to get content
    try:
        with open("/tmp/ollama_server.log", "r") as f:
            f.seek(0, 2)  # seek to end
            while True:
                line = f.readline()
                if line:
                    print(f"[OLLAMA] {line.rstrip()}")
                else:
                    _time.sleep(0.3)
    except Exception as e:
        print(f"[OLLAMA LOG ERROR] {e}")

threading.Thread(target=tail_ollama_logs, daemon=True).start()

print("⏳ Waiting for Ollama to be ready...")
ready = False
for i in range(40):
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=2)
        if r.status_code == 200:
            print("✅ Ollama server is ready!")
            ready = True
            break
    except Exception:
        pass
    time.sleep(2)
    print(f"  waiting... ({(i+1)*2}s)", end="\r")

if not ready:
    print("\n❌ Ollama failed to start. Logs:")
    subprocess.run(["cat", "/tmp/ollama_server.log"])
    server_process.terminate()
    raise RuntimeError("Ollama did not start in time.")

# ── 6. Pull models ───────────────────────────────────────────
MODELS = ["qwen3:8b"]  # T4 GPU = 16GB VRAM — 8b models run great!

# Check which models are already pulled
try:
    tags_resp = requests.get("http://localhost:11434/api/tags", timeout=5)
    installed_models = [m['name'] for m in tags_resp.json().get('models', [])]
except Exception:
    installed_models = []

for model in MODELS:
    already = model in installed_models
    if already:
        print(f"✅ {model} already installed — skipping pull.")
    else:
        print(f"\n📥 Pulling model: {model}  (this may take a while...)")
        result = subprocess.run(
            [OLLAMA_BIN, "pull", model],
            env={**os.environ, "HOME": "/root"}
        )
        if result.returncode == 0:
            print(f"✅ {model} ready!")
        else:
            print(f"⚠️  Failed to pull {model}")

# ── 7. Flask CORS Proxy ──────────────────────────────────────
# Kill any process already using port 11435
try:
    result = subprocess.run(["fuser", "-k", "11435/tcp"], capture_output=True)
    if result.returncode == 0:
        print("⚠️  Killed old process on port 11435.")
        time.sleep(1)
except Exception:
    pass

print("\n🔧 Starting Flask CORS proxy on port 11435...")

app = Flask(__name__)
CORS(app, origins="*", allow_headers="*", methods=["GET","POST","PUT","DELETE","OPTIONS"])

OLLAMA_BASE = "http://localhost:11434"

# Session with no read timeout for streaming
proxy_session = requests.Session()
proxy_session.headers.update({'Connection': 'keep-alive'})

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
}

@app.route('/', defaults={'path': ''}, methods=['GET','POST','PUT','DELETE','OPTIONS'])
@app.route('/<path:path>', methods=['GET','POST','PUT','DELETE','OPTIONS'])
def proxy(path):
    # Handle preflight
    if request.method == 'OPTIONS':
        resp = Response('', 204)
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Headers'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS'
        resp.headers['Access-Control-Max-Age'] = '86400'
        return resp

    url = f"{OLLAMA_BASE}/{path}"
    is_stream = False

    try:
        # Check if this is a streaming request
        body = request.get_data()
        if body:
            try:
                parsed = json.loads(body)
                is_stream = parsed.get('stream', False)
            except Exception:
                pass

        # Use no read timeout for streaming, 30s for regular requests
        timeout = (10, None) if is_stream else (10, 60)

        # For chat requests, patch body to disable thinking & limit context
        if path == 'api/chat' and body:
            try:
                parsed_body = json.loads(body)
                # Disable thinking mode (qwen3 uses it by default, very slow on CPU)
                if 'options' not in parsed_body:
                    parsed_body['options'] = {}
                parsed_body['options'].setdefault('num_ctx', 4096)
                parsed_body['think'] = False
                body = json.dumps(parsed_body).encode()
            except Exception:
                pass

        resp = proxy_session.request(
            method=request.method,
            url=url,
            headers={k: v for k, v in request.headers if k.lower() not in ('host', 'content-length')},
            data=body,
            stream=True,
            timeout=timeout
        )

        def generate():
            try:
                for chunk in resp.iter_lines(decode_unicode=False):
                    if chunk:
                        yield chunk + b'\n'
            except Exception as e:
                logger.error(f'Stream error: {e}')
                yield json.dumps({'error': str(e)}).encode() + b'\n'

        response_headers = dict(CORS_HEADERS)
        response_headers['Content-Type'] = resp.headers.get('Content-Type', 'application/json')
        # Remove transfer-encoding to let Flask handle it
        if 'X-Accel-Buffering' not in response_headers:
            response_headers['X-Accel-Buffering'] = 'no'

        return Response(
            generate(),
            status=resp.status_code,
            headers=response_headers
        )
    except requests.exceptions.ConnectionError as e:
        logger.error(f'Connection error: {e}')
        return Response(
            json.dumps({'error': 'Cannot connect to Ollama. Is it running?'}),
            status=502,
            headers={**CORS_HEADERS, 'Content-Type': 'application/json'}
        )
    except Exception as e:
        logger.error(f'Proxy error on /{path}: {e}')
        return Response(
            json.dumps({'error': str(e)}),
            status=502,
            headers={**CORS_HEADERS, 'Content-Type': 'application/json'}
        )

threading.Thread(
    target=lambda: app.run(host='0.0.0.0', port=11435, threaded=True),
    daemon=True
).start()

time.sleep(2)
print("✅ Flask CORS proxy running on port 11435")

# ── 8. ngrok tunnel ──────────────────────────────────────────
print("\n🌐 Setting up ngrok tunnel...")

NGROK_AUTH_TOKEN = "39LeyUhtzRIwvRvN46HnaD3crY6_6zaS2wwsFs3hX3dRh3DKg"
ngrok.set_auth_token(NGROK_AUTH_TOKEN)

# Kill any existing tunnels
ngrok.kill()
time.sleep(1)

tunnel = ngrok.connect(11435, "http")
public_url = tunnel.public_url

print("\n" + "="*55)
print(f"🔗 Paste this URL in Settings → OLLAMA LOCAL:")
print(f"   {public_url}")
print("="*55)
print(f"\ncurl {public_url}/api/tags")

# ── 9. Keep-alive ────────────────────────────────────────────
try:
    print("\n🟢 Tunnel is live. Interrupt kernel to stop.\n")
    while True:
        time.sleep(60)
        print(f"💓 Tunnel active: {public_url}")
except KeyboardInterrupt:
    print("\n🛑 Shutting down...")
    ngrok.disconnect(public_url)
    server_process.terminate()
    server_log.close()
    print("Done.")
