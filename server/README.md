# TTS proxy (v0.3)

One OpenAI-compatible endpoint in front of however many TTS engines you run.

```
runner / New API ──▶ POST /v1/audio/speech ──▶ this proxy ──▶ engine A (http)
                                                          ├─▶ engine B (http)
                                                          └─▶ engine C (command)
```

Zero dependencies. `python3 server/app.py --config server/config.json`.

---

## Why a proxy instead of calling engines directly

Three concrete reasons:

1. **One shape.** Irodori, Chatterbox, Kokoro and whatever ships next week all
   get the same request. The runner never learns a new API.
2. **A cache.** Test suites repeat the same 45 phrases across ten rounds. The
   cache turns round 2–10 into a disk read instead of a GPU job.
3. **New API can sit in front of it.** Point a New API channel at this proxy and
   you get quotas, per-key usage, and failover for free.

---

## Run it

```bash
cp server/config.example.json server/config.json
# edit the providers you actually have
python3 server/app.py --config server/config.json
```

```bash
curl -s http://127.0.0.1:8000/health | python3 -m json.tool
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool

curl -s -X POST http://127.0.0.1:8000/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"irodori","input":"こんにちは","voice":"default"}' \
  --output hello.wav
```

---

## Two provider types

### `http`

For engines that already expose `POST /v1/audio/speech`.

```json
{
  "name": "irodori",
  "type": "http",
  "baseUrl": "http://127.0.0.1:8765",
  "upstreamModel": "irodori",
  "languages": ["ja"],
  "timeout": 120
}
```

Works with Irodori-TTS-Server, Chatterbox-TTS-Server, LocalAI, vLLM-TTS, or any
gateway that speaks the OpenAI audio shape. If the engine is already loaded and
warm, this is the one to use — the model stays in VRAM between requests.

### `command`

For everything else. Your program gets JSON on stdin and writes audio to stdout.

```json
{
  "name": "my-engine",
  "type": "command",
  "command": ["python3", "providers/silence.py"],
  "languages": ["ja"],
  "timeout": 180
}
```

stdin:

```json
{"text": "こんにちは", "voice": "default", "language": "ja", "speed": 1.0}
```

stdout: raw audio bytes. WAV is detected by its `RIFF` header, MP3 by its frame
header. Anything else is treated as WAV.

**The trade-off is honest:** a command provider cold-starts the process on every
call. For a 0.5B model that is several seconds of pure loading. Use `command` for
small models or one-shot scripts, and `http` for anything you want warm.

`providers/silence.py` is a working example — 20 lines, emits a WAV of silence
sized to the input. Copy it as the starting point for a real engine.

---

## Cache

Keyed on `model + input + voice + speed + language`. Written to `cache/` as the
audio file plus a JSON sidecar. LRU by mtime, trimmed to `maxEntries`.

Look for `X-SayCheck-Cache: hit` in the response headers. On a 45×10 run this
turns 450 syntheses into 45.

To disable: `"cache": {"enabled": false}`.

---

## Concurrency

`maxConcurrency` defaults to **1**. A single 5060 Ti running Irodori plus
Chatterbox is already using ~9.5 GB, and PyTorch's allocator fragments under
parallel load. Raise it only after you have measured your own card.

Requests beyond the limit queue on a semaphore rather than failing.

---

## Putting New API in front

Add a channel of type **OpenAI**, base URL `http://<proxy-host>:8000`, and set
your token here as well. Then all traffic to this proxy shows up in New API's
usage logs, and you can set per-key quotas.

Verified on `new-api v1.0.0-rc.23`: the `/v1/audio/speech` route forwards to an
OpenAI-type channel and streams the audio back unchanged.

---

## Error behaviour

| Situation | Response |
|---|---|
| Missing `input` | 400 with a JSON error |
| `input` over 2000 chars | 400 |
| Engine unreachable or non-2xx | 502, upstream body included (truncated to 400 bytes) |
| Engine exits non-zero | 502, last 500 bytes of its stderr |
| No `Authorization` when a token is set | 401 |
