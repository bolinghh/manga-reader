"""Loopback-only RapidOCR service. Page images and OCR results stay in memory."""
import argparse
import base64
import io
import json
import os
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from tencent_bridge import BridgeError, forward_tencent
from ocr_layout import result_blocks

MODEL_DIR = Path(os.environ.get("MANGAREADER_OCR_MODELS", str(Path(__file__).resolve().parent / "models")))
ENGINES = OrderedDict()
ENGINE_LOCK = threading.Lock()
MODEL_STATUS = {}
STATUS_LOCK = threading.Lock()
LANGUAGES = {"ja": "japan", "en": "en", "ko": "korean", "zh-Hans": "ch", "zh-Hant": "chinese_cht", "fr": "latin", "es": "latin", "de": "latin"}


def prepare_model(language):
    if language not in LANGUAGES:
        raise ValueError("Unsupported OCR language")
    name = LANGUAGES[language]
    with STATUS_LOCK:
        if MODEL_STATUS.get(name, {}).get("state") == "loading":
            return {"state": "loading"}
        MODEL_STATUS[name] = {"state": "loading", "stage": "下载或加载模型"}

    def prepare():
        try:
            with ENGINE_LOCK:
                get_engine(language)
            with STATUS_LOCK:
                MODEL_STATUS[name] = {"state": "ready", "stage": "模型已就绪"}
        except Exception:
            with STATUS_LOCK:
                MODEL_STATUS[name] = {"state": "error", "stage": "准备失败，请检查网络后重试"}
    threading.Thread(target=prepare, daemon=True).start()
    return {"state": "loading"}


def get_engine(language):
    from rapidocr import RapidOCR, LangRec, OCRVersion, ModelType
    name = LANGUAGES.get(language)
    if not name:
        raise ValueError("Unsupported OCR language")
    if name in ENGINES:
        ENGINES.move_to_end(name)
        return ENGINES[name]
    engine = RapidOCR(params={
        "Global.model_root_dir": str(MODEL_DIR),
        "Global.text_score": 0.45,
        "Global.log_level": "warning",
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Rec.ocr_version": OCRVersion.PPOCRV4 if name in ("japan", "chinese_cht") else OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec(name),
        "Cls.ocr_version": OCRVersion.PPOCRV4,
        "Cls.model_type": ModelType.MOBILE,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })
    ENGINES[name] = engine
    while len(ENGINES) > 3:
        ENGINES.popitem(last=False)
    return engine


def decode_image(value):
    from PIL import Image
    if not isinstance(value, str) or not value.startswith(("data:image/jpeg;base64,", "data:image/png;base64,")):
        raise ValueError("Expected a local JPEG or PNG data URL")
    encoded = value.split(",", 1)[1]
    if len(encoded) > 18_000_000:
        raise ValueError("Image too large")
    raw = base64.b64decode(encoded, validate=True)
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > 4_500_000 or min(image.size) < 1:
        raise ValueError("Image dimensions exceed the OCR limit")
    return image.convert("RGB")


def recognize(body):
    if body.get("language") not in LANGUAGES or body.get("readingDirection") not in ("ltr", "rtl"):
        raise ValueError("Invalid language or reading direction")
    image = decode_image(body.get("image"))
    import numpy as np
    with ENGINE_LOCK:
        result = get_engine(body["language"])(np.asarray(image))
    with STATUS_LOCK:
        MODEL_STATUS[LANGUAGES[body["language"]]] = {"state": "ready", "stage": "模型已就绪"}
    return {"blocks": result_blocks(result, image, body["readingDirection"], body["language"])}


def allowed_origin(origin):
    if not origin:
        return True
    if origin in ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"):
        return True
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and parsed.hostname in ("localhost", "127.0.0.1", "::1")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Request paths and image data are never logged.

    def write_json(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        origin = self.headers.get("Origin")
        if origin and allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.write_json(200 if allowed_origin(self.headers.get("Origin")) else 403, {})

    def do_GET(self):
        if not allowed_origin(self.headers.get("Origin")):
            return self.write_json(403, {"error": "Origin not allowed"})
        if self.path != "/health":
            return self.write_json(404, {"error": "Unknown endpoint"})
        try:
            import rapidocr, onnxruntime, PIL  # noqa: F401
            with STATUS_LOCK:
                models = dict(MODEL_STATUS)
            self.write_json(200, {"ok": True, "engine": "RapidOCR 3.9.2 / ONNX Runtime CPU", "languages": list(LANGUAGES), "models": models, "translationRelay": True, "modelPreparation": True})
        except ImportError:
            self.write_json(503, {"ok": False, "error": "Run setup-ocr.cmd first"})

    def do_POST(self):
        self.connection.settimeout(20)
        if not allowed_origin(self.headers.get("Origin")):
            return self.write_json(403, {"error": "Origin not allowed"})
        if self.path not in ("/ocr", "/translate/tencent", "/models/prepare"):
            return self.write_json(404, {"error": "Unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (80_000 if self.path == "/translate/tencent" else 20_000_000):
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Expected JSON object")
            self.write_json(200, forward_tencent(body) if self.path == "/translate/tencent" else prepare_model(body.get("language")) if self.path == "/models/prepare" else recognize(body))
        except BridgeError as error:
            self.write_json(400 if error.code == "invalid_request" else 502, {"bridgeError": error.code})
        except (ValueError, TypeError, OSError):
            self.write_json(400, {"error": "Invalid image or OCR request; select a smaller region"})
        except Exception:
            self.write_json(503, {"error": "OCR model unavailable; run setup or check model download connection"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--setup", help="Preload comma-separated language models, e.g. ja,en,zh-Hans")
    args = parser.parse_args()
    if args.setup:
        for language in args.setup.split(","):
            print(f"Preparing local OCR: {language}", flush=True)
            with ENGINE_LOCK:
                get_engine(language)
        print("Local OCR models ready.", flush=True)
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Local OCR: http://127.0.0.1:{args.port} (CPU, images stay on this computer)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
