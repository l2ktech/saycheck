#!/usr/bin/env python3
"""SayCheck TTS proxy — an OpenAI-compatible /v1/audio/speech front end.

Why this exists: the runner needs audio files. Any TTS engine can produce them,
but every engine has its own API. This proxy gives them all one shape, so the
runner (and anything else that speaks OpenAI) can use them interchangeably.

Two provider types cover almost everything:

  http     Forwards to an upstream that already speaks POST /v1/audio/speech.
           Use this for Irodori-TTS-Server, Chatterbox-TTS-Server, LocalAI, etc.

  command  Runs a program. Sends JSON on stdin, reads audio bytes on stdout.
           Use this for any script you can write in five lines:
               {"text": "...", "voice": "default", "language": "ja", "speed": 1.0}

No third-party dependencies, no build step: python3 server/app.py

Endpoints
  POST /v1/audio/speech   {model, input, voice, response_format, speed, language}
  GET  /v1/models         lists configured providers
  GET  /health            readiness + cache stats
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

DEFAULT_CONFIG = {
    "listen": "127.0.0.1",
    "port": 8000,
    "token": "",
    "maxConcurrency": 1,
    "defaultProvider": "",
    "cache": {"enabled": True, "dir": "cache", "maxEntries": 2000},
    "providers": [],
}


def log(*args) -> None:
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


# ----------------------------------------------------------------- providers


class Provider:
    name = ""
    kind = ""
    languages: list[str] = []
    timeout = 120

    def synth(self, req: dict) -> tuple[bytes, str, str]:
        """Return (audio_bytes, mime_type, file_extension)."""
        raise NotImplementedError


class HttpProvider(Provider):
    """Forward to an upstream that already speaks OpenAI audio/speech."""

    def __init__(self, cfg: dict):
        self.name = cfg["name"]
        self.kind = "http"
        self.languages = cfg.get("languages", [])
        self.timeout = cfg.get("timeout", 120)
        self.base_url = cfg["baseUrl"].rstrip("/")
        self.upstream_model = cfg.get("upstreamModel") or cfg["name"]
        self.api_key = cfg.get("apiKey", "")

    def synth(self, req: dict) -> tuple[bytes, str, str]:
        body = {
            "model": self.upstream_model,
            "input": req["input"],
            "voice": req.get("voice") or "default",
            "response_format": req.get("response_format") or "wav",
        }
        if req.get("speed") is not None:
            body["speed"] = req["speed"]
        if req.get("language"):
            body["language"] = req["language"]

        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        url = self.base_url
        if not url.endswith("/v1/audio/speech"):
            url = url + "/v1/audio/speech"

        r = urlrequest.Request(url, data=data, headers=headers, method="POST")
        try:
            with urlrequest.urlopen(r, timeout=self.timeout) as resp:
                audio = resp.read()
                mime = resp.headers.get("Content-Type", "audio/wav").split(";")[0]
        except urlerror.HTTPError as exc:
            detail = exc.read()[:400].decode("utf-8", "replace")
            raise RuntimeError(f"upstream {exc.code}: {detail}") from exc
        except urlerror.URLError as exc:
            raise RuntimeError(f"upstream unreachable: {exc.reason}") from exc

        ext = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3",
               "audio/ogg": "ogg", "audio/flac": "flac", "audio/aac": "aac"}.get(mime, "wav")
        return audio, mime, ext


class CommandProvider(Provider):
    """Run a program: JSON on stdin, audio bytes on stdout."""

    def __init__(self, cfg: dict):
        self.name = cfg["name"]
        self.kind = "command"
        self.languages = cfg.get("languages", [])
        self.timeout = cfg.get("timeout", 180)
        self.command = cfg["command"]
        if isinstance(self.command, str):
            self.command = ["/bin/sh", "-c", self.command]
        self.cwd = cfg.get("cwd") or None
        self.env_extra = cfg.get("env") or {}

    def synth(self, req: dict) -> tuple[bytes, str, str]:
        payload = json.dumps({
            "text": req["input"],
            "voice": req.get("voice") or "default",
            "language": req.get("language") or "",
            "speed": req.get("speed", 1.0),
        }).encode("utf-8")

        env = os.environ.copy()
        env.update({k: str(v) for k, v in self.env_extra.items()})

        try:
            proc = subprocess.run(
                self.command,
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout,
                cwd=self.cwd,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"provider '{self.name}' timed out after {self.timeout}s") from exc
        except FileNotFoundError as exc:
            raise RuntimeError(f"command not found: {self.command[0]}") from exc

        if proc.returncode != 0:
            tail = proc.stderr.decode("utf-8", "replace")[-500:]
            raise RuntimeError(f"provider '{self.name}' exited {proc.returncode}: {tail}")
        if not proc.stdout:
            raise RuntimeError(f"provider '{self.name}' produced no audio")

        audio = proc.stdout
        if audio[:4] == b"RIFF":
            return audio, "audio/wav", "wav"
        if audio[:3] == b"ID3" or audio[:2] == b"\xff\xfb":
            return audio, "audio/mpeg", "mp3"
        return audio, "audio/wav", "wav"


def build_provider(cfg: dict) -> Provider:
    kind = cfg.get("type")
    if kind == "http":
        return HttpProvider(cfg)
    if kind == "command":
        return CommandProvider(cfg)
    raise ValueError(f"unknown provider type: {kind!r} (expected 'http' or 'command')")


# --------------------------------------------------------------------- cache


class Cache:
    def __init__(self, cfg: dict):
        self.enabled = bool(cfg.get("enabled", True))
        self.dir = Path(cfg.get("dir", "cache"))
        self.max_entries = int(cfg.get("maxEntries", 2000))
        self.lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        if self.enabled:
            self.dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(req: dict) -> str:
        material = json.dumps({
            "model": req.get("model"),
            "input": req.get("input"),
            "voice": req.get("voice"),
            "speed": req.get("speed", 1.0),
            "language": req.get("language", ""),
        }, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def get(self, key: str):
        if not self.enabled:
            return None
        meta_p = self.dir / f"{key}.json"
        if not meta_p.exists():
            with self.lock:
                self.misses += 1
            return None
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            audio = (self.dir / meta["file"]).read_bytes()
        except Exception:
            return None
        with self.lock:
            self.hits += 1
        try:
            os.utime(meta_p, None)  # touch for LRU
        except OSError:
            pass
        return audio, meta["mime"], meta["ext"]

    def put(self, key: str, audio: bytes, mime: str, ext: str, req: dict) -> None:
        if not self.enabled:
            return
        fname = f"{key}.{ext}"
        try:
            (self.dir / fname).write_bytes(audio)
            (self.dir / f"{key}.json").write_text(json.dumps({
                "file": fname, "mime": mime, "ext": ext,
                "bytes": len(audio), "createdAt": time.time(),
                "text": req.get("input", "")[:200],
                "model": req.get("model", ""),
            }, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            log("cache write failed:", exc)
            return
        self._evict()

    def _evict(self) -> None:
        metas = sorted(self.dir.glob("*.json"), key=lambda p: p.stat().st_mtime)
        excess = len(metas) - self.max_entries
        for meta_p in metas[:max(0, excess)]:
            try:
                meta = json.loads(meta_p.read_text(encoding="utf-8"))
                (self.dir / meta["file"]).unlink(missing_ok=True)
            except Exception:
                pass
            meta_p.unlink(missing_ok=True)

    def stats(self) -> dict:
        return {"enabled": self.enabled, "hits": self.hits, "misses": self.misses,
                "entries": len(list(self.dir.glob("*.json"))) if self.enabled else 0}


# -------------------------------------------------------------------- server


class App:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.providers: dict[str, Provider] = {}
        for pc in cfg.get("providers", []):
            p = build_provider(pc)
            self.providers[p.name] = p
        if not self.providers:
            raise SystemExit("no providers configured — see server/config.example.json")

        self.default = cfg.get("defaultProvider") or next(iter(self.providers))
        if self.default not in self.providers:
            raise SystemExit(f"defaultProvider {self.default!r} is not configured")

        self.cache = Cache(cfg.get("cache", {}))
        self.sem = threading.Semaphore(int(cfg.get("maxConcurrency", 1)))
        self.token = cfg.get("token") or os.environ.get("SAYCHECK_TOKEN", "")
        self.started_at = time.time()

    def pick(self, model: str) -> Provider:
        if model in self.providers:
            return self.providers[model]
        # Accept "provider/voice" and "provider:anything" forms.
        head = str(model or "").split("/")[0].split(":")[0]
        if head in self.providers:
            return self.providers[head]
        return self.providers[self.default]

    def synthesize(self, req: dict):
        provider = self.pick(req.get("model"))
        key = Cache.key({**req, "model": provider.name})

        cached = self.cache.get(key)
        if cached:
            return cached, True

        with self.sem:  # one GPU, one job at a time by default
            audio, mime, ext = provider.synth(req)
        self.cache.put(key, audio, mime, ext, {**req, "model": provider.name})
        return (audio, mime, ext), False


class Handler(BaseHTTPRequestHandler):
    app: App = None  # injected
    server_version = "saycheck-tts/0.3"

    def log_message(self, fmt, *args):
        log(fmt % args)

    # -- plumbing ---------------------------------------------------------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not self.app.token:
            return True
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {self.app.token}"

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/healthz"):
            return self._json(200, {
                "ok": True,
                "uptimeSec": round(time.time() - self.app.started_at),
                "providers": list(self.app.providers),
                "default": self.app.default,
                "cache": self.app.cache.stats(),
                "concurrency": self.app.cfg.get("maxConcurrency", 1),
            })
        if path == "/v1/models":
            return self._json(200, {
                "object": "list",
                "data": [
                    {"id": p.name, "object": "model", "owned_by": "saycheck",
                     "languages": p.languages, "kind": p.kind}
                    for p in self.app.providers.values()
                ],
            })
        return self._json(404, {"error": {"message": f"unknown path {path}", "type": "invalid_request_error"}})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/v1/audio/speech", "/tts"):
            return self._json(404, {"error": {"message": f"unknown path {path}", "type": "invalid_request_error"}})
        if not self._authorized():
            return self._json(401, {"error": {"message": "invalid token", "type": "authentication_error"}})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw or b"{}")
        except Exception as exc:
            return self._json(400, {"error": {"message": f"bad JSON body: {exc}", "type": "invalid_request_error"}})

        text = (req.get("input") or req.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": {"message": "'input' is required", "type": "invalid_request_error"}})
        if len(text) > 2000:
            return self._json(400, {"error": {"message": "'input' exceeds 2000 characters", "type": "invalid_request_error"}})
        req["input"] = text

        t0 = time.time()
        try:
            (audio, mime, ext), cached = self.app.synthesize(req)
        except Exception as exc:
            log("synthesis failed:", exc)
            traceback.print_exc(file=sys.stderr)
            return self._json(502, {"error": {"message": str(exc), "type": "upstream_error"}})

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-SayCheck-Cache", "hit" if cached else "miss")
        self.send_header("X-SayCheck-Elapsed-Ms", str(int((time.time() - t0) * 1000)))
        self.send_header("X-SayCheck-Provider", req.get("model") or self.app.default)
        self._cors()
        self.end_headers()
        self.wfile.write(audio)


def load_config(path: Path | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if path:
        if not path.exists():
            raise SystemExit(f"config not found: {path}")
        user = json.loads(path.read_text(encoding="utf-8"))
        cfg.update({k: v for k, v in user.items() if k != "cache"})
        if "cache" in user:
            cfg["cache"] = {**DEFAULT_CONFIG["cache"], **user["cache"]}
    # Env overrides so the same file works locally and in Docker.
    if os.environ.get("SAYCHECK_PORT"):
        cfg["port"] = int(os.environ["SAYCHECK_PORT"])
    if os.environ.get("SAYCHECK_LISTEN"):
        cfg["listen"] = os.environ["SAYCHECK_LISTEN"]
    return cfg


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="OpenAI-compatible TTS proxy for SayCheck")
    ap.add_argument("--config", type=Path, help="path to config.json")
    ap.add_argument("--host", help="override listen address")
    ap.add_argument("--port", type=int, help="override port")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    if args.host:
        cfg["listen"] = args.host
    if args.port:
        cfg["port"] = args.port

    app = App(cfg)
    Handler.app = app
    srv = ThreadingHTTPServer((cfg["listen"], cfg["port"]), Handler)
    srv.daemon_threads = True

    log(f"providers: {', '.join(app.providers)} (default {app.default})")
    log(f"cache: {'on' if app.cache.enabled else 'off'} -> {app.cache.dir}")
    log(f"listening on http://{cfg['listen']}:{cfg['port']}")
    log(f"try: curl -s http://{cfg['listen']}:{cfg['port']}/v1/models")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
