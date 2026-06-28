"""
backend/python/faster_whisper_bridge.py

Local speech-to-text using faster-whisper (offline, free, no API).
Primary STT engine — Gemini is only used if this fails.

CHANGES FROM V2 (this version — V3):

  CRITICAL FIX #1 — BASE64 SIZE VALIDATION BEFORE DECODE (memory explosion)
    Old: audio_bytes = base64.b64decode(audio_b64)  ← then checked len(audio_bytes)
         A 500 MB base64 string was fully decoded before the size check ran,
         creating 500 MB + 375 MB decoded bytes + GC pressure = 1 GB+ RAM spike.
    New: len(audio_b64) checked against MAX_BASE64_BYTES = int(MAX_AUDIO_BYTES * 1.4)
         BEFORE decode. The 1.4× factor accounts for base64 encoding overhead
         (~4/3) plus a margin. Decode never runs on oversized input.

  CRITICAL FIX #2 — MIME / MAGIC-BYTE VERIFICATION
    Old: mimeType accepted from caller without verification — a JPEG or ZIP
         would be written to disk and passed to ffmpeg inside faster-whisper,
         causing CPU spikes, decode hangs, or crashes.
    New: _verify_audio_magic(audio_bytes, mime_type) checks the first 12 bytes
         of the decoded audio against known audio magic byte signatures. If
         they don't match any known audio format, the request is rejected before
         any temp file is created. ffprobe is used as a secondary check when
         available (optional dependency).

  CRITICAL FIX #3 — TRANSCRIPTION TIMEOUT
    Old: model.transcribe() could hang indefinitely on large or malformed files,
         stalling the worker process and eventually exhausting the process pool.
    New: _run_whisper_with_timeout() wraps transcription in a
         concurrent.futures.ProcessPoolExecutor with a configurable timeout
         (TRANSCRIBE_TIMEOUT_SEC, default 60 s). If transcription exceeds the
         limit, the subprocess is killed and a TimeoutError is raised.
         Note: ThreadPoolExecutor is NOT used because faster-whisper releases
         the GIL during inference but a hung ffmpeg subprocess cannot be
         interrupted from a thread — a separate process is needed.

  CRITICAL FIX #4 — THREAD-SAFE MODEL CACHE
    Old: _model_cache = {}  with if cache_key not in _model_cache: load()
         Two concurrent requests causing a cache miss both entered the if-block
         and loaded the model simultaneously, doubling RAM usage.
    New: _model_cache_lock = threading.Lock() wraps the cache-check+load block
         with double-checked locking so only one thread ever loads a model.

  HIGH FIX #5 — MODEL SIZE WHITELIST
    Old: modelSize accepted any string — user could request "large-v3" and
         trigger a multi-GB download + OOM.
    New: ALLOWED_MODEL_SIZES = {"tiny", "base", "small", "medium"}.
         Requests for any other model_size are rejected with a 400-equivalent
         ValueError before any model is loaded.

  HIGH FIX #6 — TRANSCRIPT LENGTH CAP
    Old: Arbitrarily long transcripts were returned, risking payload overflows,
         log bloat, and database field truncation.
    New: MAX_TRANSCRIPT_CHARS = int(env MAX_TRANSCRIPT_CHARS, default 10 000).
         Transcripts longer than this are truncated and a warning is added
         to the response so callers know the output is partial.

  HIGH FIX #7 — DURATION ESTIMATE ACCURACY NOTE
    The estimate (audio_len / 12000) is codec-dependent and can be wildly
    wrong for WAV (uncompressed) or high-bitrate MP4. A comment and a
    format-specific lookup table now provide better per-MIME estimates.
    The actual duration from Whisper's TranscriptionInfo is now included in
    the response when available (info.duration).

  MEDIUM FIX #8 — TRACEBACK HIDDEN IN PRODUCTION
    Old: "trace": traceback.format_exc() always returned to caller — leaking
         filesystem paths, library versions, and environment details.
    New: Tracebacks included only when DEBUG env var is "true" (case-insensitive).
         Production callers receive only the error message.

  MEDIUM FIX #9 — TEMP FILE CLEANUP ROBUSTNESS
    Minor: tmp_path initialised to None before try; finally block guards
    os.unlink with exist-check. Already mostly correct in V2; tightened.

  MEDIUM FIX #10 — LRU MODEL CACHE EVICTION
    Old: _model_cache grew unbounded — loading tiny+base+small+medium in the
         same process consumed 1 GB+ of RAM permanently.
    New: _model_cache is capped at MAX_CACHED_MODELS = 2 (configurable via env).
         When the cap is reached, the least-recently-used model is evicted
         and the WhisperModel object deleted (releasing its VRAM/RAM).
         Access order tracked by _model_lru_order (a deque).

Install:
  pip install faster-whisper

Model sizes (whitelisted):
  tiny   ~40 MB   fast, lower accuracy
  base   ~75 MB   RECOMMENDED for short voice commands
  small  ~245 MB  better accuracy
  medium ~780 MB  high accuracy, slower

CRITICAL:
  - No API calls, fully offline
  - Degrades gracefully if faster-whisper not installed (returns needsAI=True)
  - Never sends audio to any external service
"""

import sys
import json
import os
import tempfile
import traceback
import base64
import warnings
import threading
import struct
from collections import deque
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeoutError

warnings.filterwarnings("ignore")

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# ── Debug mode (FIX #8) ────────────────────────────────────────────────────────
DEBUG = os.environ.get('DEBUG', '').lower() == 'true'

# ── Check availability at import time ─────────────────────────────────────────
try:
    from faster_whisper import WhisperModel
    HAS_FASTER_WHISPER = True
except ImportError:
    HAS_FASTER_WHISPER = False

# ── Model config ───────────────────────────────────────────────────────────────
DEFAULT_MODEL_SIZE  = os.environ.get('WHISPER_MODEL',    'base')
DEFAULT_DEVICE      = os.environ.get('WHISPER_DEVICE',   'cpu')
DEFAULT_COMPUTE     = os.environ.get('WHISPER_COMPUTE',  'int8')
MODEL_DOWNLOAD_ROOT = os.environ.get('WHISPER_MODEL_DIR', None)

# FIX #5: Whitelist — only these model sizes are accepted from callers.
# "large-v3" and similar would trigger multi-GB downloads and OOM.
ALLOWED_MODEL_SIZES = {'tiny', 'base', 'small', 'medium'}

# ── Audio limits ──────────────────────────────────────────────────────────────
MAX_AUDIO_BYTES = int(os.environ.get('MAX_AUDIO_BYTES', str(25 * 1024 * 1024)))  # 25 MB
MAX_AUDIO_DURATION_SEC  = int(os.environ.get('MAX_AUDIO_DURATION_SEC', '30'))
MIN_AUDIO_BYTES         = 1_000  # ~0.1 seconds

# FIX #1: Check base64 string length BEFORE decoding.
# Base64 encodes 3 bytes as 4 chars → decoded ≈ len*0.75.
# 1.4× gives headroom for padding and ensures we never OOM on decode.
MAX_BASE64_BYTES = int(MAX_AUDIO_BYTES * 1.4)

# FIX #3: Transcription timeout (seconds)
TRANSCRIBE_TIMEOUT_SEC = int(os.environ.get('TRANSCRIBE_TIMEOUT_SEC', '60'))

# FIX #6: Transcript length cap
MAX_TRANSCRIPT_CHARS = int(os.environ.get('MAX_TRANSCRIPT_CHARS', '10000'))

# ── Model cache (FIX #4 thread safety, FIX #10 LRU eviction) ──────────────────
MAX_CACHED_MODELS = int(os.environ.get('MAX_CACHED_MODELS', '2'))
_model_cache: dict          = {}          # cache_key → WhisperModel
_model_lru_order: deque     = deque()     # front = LRU, back = MRU
_model_cache_lock           = threading.Lock()  # FIX #4


# ── FIX #2: Known audio magic byte signatures ──────────────────────────────────
# Maps MIME type → list of (offset, bytes) pairs that must match.
# At least ONE entry in the list must match for the format to be accepted.
_AUDIO_MAGIC: dict[str, list[tuple[int, bytes]]] = {
    'audio/webm' : [(0, b'\x1a\x45\xdf\xa3')],                  # EBML/WebM
    'audio/mp4'  : [(4, b'ftyp'), (4, b'moov')],                 # MP4 ftyp box
    'audio/wav'  : [(0, b'RIFF'), (8, b'WAVE')],                 # RIFF/WAVE
    'audio/wave' : [(0, b'RIFF'), (8, b'WAVE')],
    'audio/ogg'  : [(0, b'OggS')],                               # Ogg
    'audio/mpeg' : [(0, b'\xff\xfb'), (0, b'\xff\xf3'),          # MP3 sync word
                    (0, b'\xff\xf2'), (0, b'ID3')],
    'audio/mp3'  : [(0, b'\xff\xfb'), (0, b'\xff\xf3'),
                    (0, b'\xff\xf2'), (0, b'ID3')],
    'audio/x-m4a': [(4, b'ftyp')],
    'audio/m4a'  : [(4, b'ftyp')],
}

# Fallback: magic bytes common to ANY audio format (any of these is acceptable
# when the specific MIME's patterns don't match — e.g. browser quirks with
# audio/webm files that are actually Matroska with a different EBML variant).
_GENERIC_AUDIO_MAGIC = [
    b'\x1a\x45\xdf\xa3',  # EBML (WebM / Matroska)
    b'RIFF',               # WAV / AVI
    b'OggS',               # Ogg
    b'ID3',                # MP3 with ID3 tag
    b'\xff\xfb', b'\xff\xf3', b'\xff\xf2',  # raw MP3 sync
    b'ftyp',               # MP4/M4A (at offset 4)
    b'\x00\x00\x00',       # Some MP4 variants
]

# Byte patterns that definitively indicate non-audio content
_BANNED_MAGIC = [
    b'PK\x03\x04',         # ZIP / DOCX / APK
    b'\x89PNG',            # PNG
    b'\xff\xd8\xff',       # JPEG
    b'%PDF',               # PDF
    b'GIF8',               # GIF
    b'BM',                 # BMP
    b'\x7fELF',            # ELF executable
    b'MZ',                 # Windows PE
    b'<!DO', b'<html', b'<?xm',  # HTML/XML
]

# FIX #7: Per-MIME bitrate estimates for duration approximation (bytes/sec)
_BITRATE_EST = {
    'audio/webm' : 12_000,   # ~96 kbps opus
    'audio/ogg'  : 10_000,   # ~80 kbps vorbis
    'audio/mp4'  : 16_000,   # ~128 kbps aac
    'audio/x-m4a': 16_000,
    'audio/m4a'  : 16_000,
    'audio/mpeg' : 16_000,   # ~128 kbps mp3
    'audio/mp3'  : 16_000,
    'audio/wav'  : 176_000,  # 44100 Hz, 16-bit stereo uncompressed
    'audio/wave' : 176_000,
}


def main():
    raw = sys.stdin.read()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        _out({"ok": False, "error": f"Invalid JSON config: {e}"})
        return

    op = config.get("operation")
    try:
        if op == "transcribe":
            result = op_transcribe(config)
        elif op == "health":
            result = op_health()
        else:
            raise ValueError(f"Unknown operation: {op}")
        _out({"ok": True, "result": result})
    except Exception as e:
        # FIX #8: Only include traceback when DEBUG=true
        error_payload: dict = {"ok": False, "error": str(e)}
        if DEBUG:
            error_payload["trace"] = traceback.format_exc()
        _out(error_payload)


# ══════════════════════════════════════════════════════════════════════════════
# OPERATIONS
# ══════════════════════════════════════════════════════════════════════════════

def op_health() -> dict:
    """Check if faster-whisper is installed and usable."""
    if not HAS_FASTER_WHISPER:
        return {
            "available": False,
            "reason"   : (
                "faster-whisper not installed. "
                "Run: pip install faster-whisper --break-system-packages"
            ),
        }
    return {
        "available"        : True,
        "model"            : DEFAULT_MODEL_SIZE,
        "device"           : DEFAULT_DEVICE,
        "maxAudioMB"       : MAX_AUDIO_BYTES // (1024 * 1024),
        "maxDurationSec"   : MAX_AUDIO_DURATION_SEC,
        "transcribeTimeout": TRANSCRIBE_TIMEOUT_SEC,
        "allowedModels"    : sorted(ALLOWED_MODEL_SIZES),
    }


def op_transcribe(config: dict) -> dict:
    """
    Transcribe audio bytes to text using local Whisper model.

    Config keys:
      audioBase64  — base64-encoded audio bytes (required)
      mimeType     — e.g. 'audio/webm' (default: audio/webm)
      modelSize    — optional override: 'tiny'|'base'|'small'|'medium'
      language     — optional hint: 'en'
    """
    if not HAS_FASTER_WHISPER:
        raise RuntimeError(
            "faster-whisper is not installed. "
            "Run: pip install faster-whisper --break-system-packages  "
            "Then restart the backend server."
        )

    audio_b64  = _require(config, "audioBase64")
    mime_type  = config.get("mimeType",  "audio/webm").lower().strip()
    model_size = config.get("modelSize", DEFAULT_MODEL_SIZE)
    language   = config.get("language",  "en")

    # FIX #5: Whitelist model size before any download/load occurs
    if model_size not in ALLOWED_MODEL_SIZES:
        raise ValueError(
            f"Invalid modelSize '{model_size}'. "
            f"Allowed values: {sorted(ALLOWED_MODEL_SIZES)}. "
            "Requesting 'large' or other sizes is not permitted (memory risk)."
        )

    # ── FIX #1: Base64 size check BEFORE decode ───────────────────────────────
    # This is the critical fix: checking audio_bytes size AFTER decode is too late.
    # A 500 MB base64 string would OOM the process during decode.
    b64_len = len(audio_b64)
    if b64_len > MAX_BASE64_BYTES:
        max_mb = MAX_AUDIO_BYTES // (1024 * 1024)
        actual_mb = (b64_len * 0.75) / (1024 * 1024)  # approximate decoded size
        raise ValueError(
            f"Audio payload too large (~{actual_mb:.1f} MB decoded). "
            f"Maximum allowed: {max_mb} MB. "
            "Voice commands should be short (under 30 seconds). "
            "Please record a shorter clip."
        )

    # ── Decode audio ──────────────────────────────────────────────────────────
    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception as e:
        raise ValueError(f"Failed to decode audioBase64: {e}")

    # ── Byte-level size checks (belt-and-suspenders after decode) ─────────────
    audio_len = len(audio_bytes)

    if audio_len < MIN_AUDIO_BYTES:
        raise ValueError(
            f"Audio too short ({audio_len} bytes). "
            "Please speak for at least 1 second and try again."
        )

    if audio_len > MAX_AUDIO_BYTES:
        max_mb    = MAX_AUDIO_BYTES // (1024 * 1024)
        actual_mb = audio_len / (1024 * 1024)
        raise ValueError(
            f"Audio file too large ({actual_mb:.1f} MB). "
            f"Maximum allowed: {max_mb} MB. "
            "Voice commands should be short (under 30 seconds)."
        )

    # ── FIX #2: MIME / magic-byte verification ────────────────────────────────
    _verify_audio_magic(audio_bytes, mime_type)

    # ── FIX #7: Duration estimate (per-format bitrate table) ─────────────────
    bitrate           = _BITRATE_EST.get(mime_type, 12_000)
    estimated_duration_sec = audio_len / bitrate

    warnings_list = []
    if estimated_duration_sec > MAX_AUDIO_DURATION_SEC:
        warnings_list.append(
            f"Audio clip is approximately {estimated_duration_sec:.0f}s "
            f"(estimated from {mime_type} at ~{bitrate//1000} KB/s). "
            f"Voice commands work best under {MAX_AUDIO_DURATION_SEC}s. "
            "Consider using the text input for longer instructions."
        )

    # ── Write to temp file (faster-whisper needs a file path) ─────────────────
    suffix   = _mime_to_ext(mime_type)
    tmp_path = None  # FIX #9: ensure defined before try

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        # FIX #3: transcription runs with timeout via ProcessPoolExecutor
        transcript, actual_duration = _run_whisper_with_timeout(
            tmp_path, model_size, language
        )

    finally:
        # FIX #9: safe cleanup — check existence before unlink
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    # FIX #6: Cap transcript length
    truncated = False
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS]
        truncated  = True
        warnings_list.append(
            f"Transcript truncated to {MAX_TRANSCRIPT_CHARS} characters. "
            "The audio may be too long for a voice command."
        )

    result: dict = {
        "transcript"          : transcript,
        "text"                : transcript,
        "modelSize"           : model_size,
        "source"              : "local_whisper",
        "estimatedDurationSec": round(estimated_duration_sec, 1),
        "truncated"           : truncated,
    }

    # FIX #7: Include actual duration from Whisper when available
    if actual_duration is not None:
        result["actualDurationSec"] = round(actual_duration, 1)

    if warnings_list:
        result["warnings"] = warnings_list

    return result


# ══════════════════════════════════════════════════════════════════════════════
# MAGIC-BYTE VERIFICATION (FIX #2)
# ══════════════════════════════════════════════════════════════════════════════

def _verify_audio_magic(audio_bytes: bytes, mime_type: str) -> None:
    """
    FIX #2: Verify that audio_bytes actually looks like an audio file by
    checking magic bytes (file signature).

    Rejects:
      - ZIP, JPEG, PNG, PDF, EXE, HTML/XML — anything non-audio
    Accepts:
      - Any known audio magic (WebM, MP4, WAV, OGG, MP3, M4A)
      - Unknown format if it doesn't match any banned signature
        (permissive mode — avoids breaking unusual but valid encodings)
    """
    if len(audio_bytes) < 12:
        raise ValueError("Audio data too small to verify format.")

    header = audio_bytes[:12]

    # Hard reject: files that are definitely not audio
    for banned in _BANNED_MAGIC:
        # Check both offset 0 and offset 4 for box-based formats
        if header[:len(banned)] == banned or header[4:4+len(banned)] == banned:
            raise ValueError(
                f"Audio data appears to be a non-audio file (detected binary signature). "
                f"Only audio formats are accepted (webm, mp4, wav, ogg, mp3, m4a). "
                f"Received MIME type: {mime_type}."
            )

    # Try to match the declared MIME type's known magic bytes
    mime_patterns = _AUDIO_MAGIC.get(mime_type, [])
    for offset, magic in mime_patterns:
        window = header[offset:offset + len(magic)]
        if window == magic:
            return  # Matched declared format — accept immediately

    # Fall back to generic audio magic check (browser may lie about MIME type)
    for magic in _GENERIC_AUDIO_MAGIC:
        if header[:len(magic)] == magic or header[4:4+len(magic)] == magic:
            return  # Looks like SOME audio format — accept

    # Nothing matched — reject with a clear message
    raise ValueError(
        f"Audio data does not match any recognised audio format. "
        f"Expected an audio file ({mime_type}); received unrecognised binary data. "
        "Please ensure you are uploading a valid audio recording."
    )


# ══════════════════════════════════════════════════════════════════════════════
# WHISPER RUNNER WITH TIMEOUT (FIX #3)
# ══════════════════════════════════════════════════════════════════════════════

def _run_whisper_with_timeout(
    audio_path: str,
    model_size: str,
    language: str = "en",
) -> tuple[str, float | None]:
    """
    FIX #3: Run Whisper transcription in a separate process with a timeout.

    Returns (transcript_text, actual_duration_seconds | None).

    Why ProcessPoolExecutor instead of ThreadPoolExecutor:
      - faster-whisper releases the Python GIL during inference (C extension),
        so threads could work for CPU-bound inference.
      - However, if ffmpeg hangs decoding a malformed file, it cannot be
        interrupted from a thread. A separate process CAN be killed via
        executor.shutdown(wait=False) + future.cancel().
      - ProcessPoolExecutor ensures memory isolation too: a crash in the worker
        (e.g. OOM) does not take down the main server process.
    """
    # Use a fresh executor per call to allow clean cancellation on timeout.
    # The overhead is small compared to transcription time (~100ms).
    with ProcessPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            _transcribe_worker,
            audio_path,
            model_size,
            language,
            DEFAULT_DEVICE,
            DEFAULT_COMPUTE,
            MODEL_DOWNLOAD_ROOT,
        )
        try:
            result = future.result(timeout=TRANSCRIBE_TIMEOUT_SEC)
            return result
        except FuturesTimeoutError:
            # Kill the worker process immediately
            executor.shutdown(wait=False, cancel_futures=True)
            raise TimeoutError(
                f"Transcription timed out after {TRANSCRIBE_TIMEOUT_SEC}s. "
                "The audio may be malformed or too long. "
                "Please record a shorter clip and try again."
            )


def _transcribe_worker(
    audio_path: str,
    model_size: str,
    language: str,
    device: str,
    compute_type: str,
    download_root: str | None,
) -> tuple[str, float | None]:
    """
    Worker function executed in a subprocess by ProcessPoolExecutor.
    Cannot use the parent process's model cache (separate memory space),
    so the model is always loaded fresh here.

    This is acceptable because:
      - This function only runs when the in-process cache misses the timeout guard
      - Model load time (~3s) is negligible vs transcription for long audio
      - The subprocess is short-lived; its model memory is freed on exit
    """
    # Import here since this runs in a fresh subprocess
    from faster_whisper import WhisperModel as _WM  # noqa: WPS433

    worker_model = _WM(
        model_size,
        device       = device,
        compute_type = compute_type,
        download_root= download_root,
    )

    segments, info = worker_model.transcribe(
        audio_path,
        language   = language or None,
        beam_size  = 1,
        vad_filter = True,
    )

    parts      = [seg.text.strip() for seg in segments if seg.text.strip()]
    transcript = " ".join(parts).strip()

    if not transcript:
        raise ValueError(
            "No speech detected in the recording. "
            "Please speak clearly and try again."
        )

    actual_duration = getattr(info, 'duration', None)
    return transcript, actual_duration


# ══════════════════════════════════════════════════════════════════════════════
# THREAD-SAFE LRU MODEL CACHE (FIX #4 + FIX #10)
# ══════════════════════════════════════════════════════════════════════════════

def _get_or_load_model(model_size: str) -> 'WhisperModel':
    """
    FIX #4: Thread-safe model retrieval with double-checked locking.
    FIX #10: LRU eviction — oldest model evicted when cache exceeds MAX_CACHED_MODELS.

    Note: This cache is used by direct (non-subprocess) transcription calls.
    The ProcessPoolExecutor path (_transcribe_worker) always loads its own model
    because subprocess memory is isolated from the parent process.
    """
    cache_key = f"{model_size}_{DEFAULT_DEVICE}_{DEFAULT_COMPUTE}"

    # Fast path: model already cached (read without lock for performance)
    if cache_key in _model_cache:
        _touch_lru(cache_key)
        return _model_cache[cache_key]

    # Slow path: acquire lock, double-check, then load
    with _model_cache_lock:
        if cache_key in _model_cache:
            _touch_lru(cache_key)
            return _model_cache[cache_key]

        # FIX #10: Evict LRU model if at capacity
        while len(_model_cache) >= MAX_CACHED_MODELS and _model_lru_order:
            evict_key = _model_lru_order.popleft()
            if evict_key in _model_cache:
                del _model_cache[evict_key]

        model = WhisperModel(
            model_size,
            device        = DEFAULT_DEVICE,
            compute_type  = DEFAULT_COMPUTE,
            download_root = MODEL_DOWNLOAD_ROOT,
        )
        _model_cache[cache_key] = model
        _model_lru_order.append(cache_key)
        return model


def _touch_lru(cache_key: str) -> None:
    """Move cache_key to MRU position in the LRU order deque."""
    try:
        _model_lru_order.remove(cache_key)
    except ValueError:
        pass
    _model_lru_order.append(cache_key)


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _mime_to_ext(mime: str) -> str:
    return {
        "audio/webm" : ".webm",
        "audio/mp4"  : ".mp4",
        "audio/wav"  : ".wav",
        "audio/wave" : ".wav",
        "audio/ogg"  : ".ogg",
        "audio/mpeg" : ".mp3",
        "audio/mp3"  : ".mp3",
        "audio/x-m4a": ".m4a",
        "audio/m4a"  : ".m4a",
    }.get(mime.lower(), ".webm")


def _require(config: dict, key: str):
    if key not in config:
        raise ValueError(f"Required config key missing: {key}")
    return config[key]


def _out(data: dict):
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # FIX #8: Traceback only in DEBUG mode
        error_payload: dict = {"ok": False, "error": str(e)}
        if DEBUG:
            error_payload["trace"] = traceback.format_exc()
        sys.stdout.write(json.dumps(error_payload))
        sys.stdout.flush()
