"""Fake ComfyUI server — fixture for update-tab tests and the browser probe.

Serves the four endpoints the update runner touches:
  POST /upload/image  -> {"name": <stored filename>}
  POST /prompt        -> {"prompt_id": <id>} after capturing the graph
  GET  /history/<pid> -> completed history entry with one output image
  GET  /view          -> PNG bytes
The submitted graph is captured in `.graphs` so tests can assert placeholder
injection happened server-side (image/seed/prompt landed in the right nodes).

Run in-thread:  srv = FakeComfy(); srv.start(); srv.url
"""

import io
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image


class FakeComfy:
    def __init__(self, seed_value=42, output_dir=None):
        self.seed_value = seed_value
        self.output_dir = output_dir  # mimics the real shared comfy output root
        self.graphs = []          # captured workflow graphs, in submit order
        self.uploads = []         # uploaded filenames
        self._next = 0

    # ---- handlers -----------------------------------------------------------
    def _handle(self, handler):
        method = handler.command
        path = handler.path
        if method == "POST" and path == "/upload/image":
            length = int(handler.headers.get("Content-Length", 0))
            body = handler.rfile.read(length)
            # multipart: pull the filename out of the first part header
            m = re.search(rb'filename="([^"]+)"', body)
            name = m.group(1).decode() if m else "upload.png"
            self.uploads.append(name)
            payload = json.dumps({"name": name}).encode()
        elif method == "POST" and path == "/prompt":
            length = int(handler.headers.get("Content-Length", 0))
            body = json.loads(handler.rfile.read(length))
            self.graphs.append(body.get("prompt", {}))
            self._next += 1
            self._pid = f"fake-pid-{self._next}"
            if self.output_dir is not None:
                out = self.output_dir / "ellieedit_tmp" / "update_00001_.png"
                out.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (16, 16), (10, 120, 200)).save(out)
            payload = json.dumps({"prompt_id": self._pid}).encode()
        elif method == "GET" and re.match(r"^/history/", path):
            pid = path.rsplit("/", 1)[-1]
            payload = json.dumps({pid: {
                "status": {"status_str": "success"},
                "outputs": {"54": {"images": [
                    {"filename": "update_00001_.png",
                     "subfolder": "ellieedit_tmp", "type": "output"}]}},
            }}).encode()
        elif method == "GET" and path.startswith("/view"):
            buf = io.BytesIO()
            Image.new("RGB", (16, 16), (10, 120, 200)).save(buf, "PNG")
            payload = buf.getvalue()
        else:
            payload = b'{}'
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json"
                            if path.startswith("/view") is False else "image/png")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)

    # ---- lifecycle ----------------------------------------------------------
    def start(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), self._wrap)
        self.port = srv.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._srv = srv
        self._thread = threading.Thread(target=srv.serve_forever, daemon=True)
        self._thread.start()
        return self

    def _wrap(self):
        return None

    def stop(self):
        self._srv.shutdown()
        self._srv.server_close()


def start_fake_comfy(seed_value=42, output_dir=None):
    """Start a FakeComfy with a working handler wiring (ThreadingHTTPServer
    needs the handler bound to the instance)."""
    fake = FakeComfy(seed_value, output_dir)
    outer = fake

    class H(BaseHTTPRequestHandler):
        def _go(self):
            outer._handle(self)

        do_GET = do_POST = _go

        def log_message(self, *a):  # quiet
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    fake.port = srv.server_address[1]
    fake.url = f"http://127.0.0.1:{fake.port}"
    fake._srv = srv
    fake._thread = threading.Thread(target=srv.serve_forever, daemon=True)
    fake._thread.start()
    return fake
