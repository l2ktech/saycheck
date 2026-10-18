// Two physical signals, no machine learning:
//   audio  — RMS level in dBFS from an AnalyserNode
//   video  — mean absolute grayscale difference between consecutive frames
//
// Both are cheap and deterministic, which is the whole point: a verdict you
// cannot reproduce is not a measurement.
//
// Echo caveat: the microphone also hears the clip this page just played. Audio
// samples taken before playback ends are therefore recorded for the level meter
// but excluded from the verdict. Motion detection is unaffected, so a robot that
// reacts mid-sentence is still caught.

const SAMPLE_MS = 40;
const FRAME_W = 64;
const FRAME_H = 48;

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function rmsToDb(rms) {
  // dBFS: 0 dB is full scale, silence approaches -160.
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

export class Sensor {
  constructor() {
    this.audioStream = null;
    this.videoStream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.sampleBuf = null;
    this.videoEl = null;
    this.frameCanvas = null;
    this.frameCtx = null;
    this.prevGray = null;

    this.timer = null;
    this.window = null;
    this.status = { audio: false, video: false, reason: "" };
    this.levels = { rmsDb: -100, frameDiff: 0 };
  }

  /**
   * Request devices. Never throws: a denied camera degrades to audio-only, and
   * both denied degrades to manual verdicts. The caller reads `status`.
   */
  async init({ audio = true, video = true, timeoutMs = 9000 } = {}) {
    const reasons = [];

    if (audio) {
      try {
        // Processing must be off, otherwise the browser "helpfully" normalises
        // the level we are trying to measure.
        this.audioStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }),
          timeoutMs,
          "Microphone"
        );
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
        const source = this.audioCtx.createMediaStreamSource(this.audioStream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0;
        source.connect(this.analyser);
        this.sampleBuf = new Float32Array(this.analyser.fftSize);
        this.status.audio = true;
      } catch (err) {
        reasons.push(`microphone: ${err.message}`);
      }
    }

    if (video) {
      try {
        this.videoStream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
          }),
          timeoutMs,
          "Camera"
        );
        this.videoEl = document.createElement("video");
        this.videoEl.muted = true;
        this.videoEl.playsInline = true;
        this.videoEl.autoplay = true;
        this.videoEl.srcObject = this.videoStream;
        await withTimeout(this.videoEl.play(), timeoutMs, "Camera start");

        this.frameCanvas = document.createElement("canvas");
        this.frameCanvas.width = FRAME_W;
        this.frameCanvas.height = FRAME_H;
        this.frameCtx = this.frameCanvas.getContext("2d", { willReadFrequently: true });
        this.prevGray = null;
        this.status.video = true;
      } catch (err) {
        reasons.push(`camera: ${err.message}`);
      }
    }

    this.status.reason = reasons.join("; ");
    return this.status;
  }

  get canSenseAudio() {
    return this.status.audio;
  }

  get canSenseMotion() {
    return this.status.video;
  }

  /** Attach the live video element somewhere so the user can aim the camera. */
  attachPreview(container) {
    if (!this.videoEl || !container) return;
    this.videoEl.style.width = "100%";
    this.videoEl.style.borderRadius = "12px";
    this.videoEl.style.transform = "scaleX(-1)"; // mirror, so aiming feels natural
    container.replaceChildren(this.videoEl);
  }

  /** Sample the room for `ms` and return the median noise floor in dBFS. */
  async calibrate(ms = 1500) {
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < ms) {
      const db = this.readAudioDb();
      if (db !== null) samples.push(db);
      await sleep(SAMPLE_MS);
    }
    if (!samples.length) return null;
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  /**
   * Open a measuring window.
   * @param {object} opts
   * @param {number} opts.windowMs   give up after this long if nothing happens
   * @param {number} opts.settleMs   quiet gap after playback before audio counts
   * @param {number} opts.silenceMs  end early after this much quiet following a hit
   * @param {number} opts.rmsPeakDb  dBFS considered "the robot spoke"
   * @param {number} opts.frameDiff  frame difference considered "the robot moved"
   */
  startWindow({
    windowMs = 5000,
    settleMs = 900,
    silenceMs = 1000,
    rmsPeakDb = -34,
    frameDiff = 3,
  } = {}) {
    this.stopWindow();
    this.window = {
      startedAt: performance.now(),
      playbackEndedAt: null,
      windowMs,
      settleMs,
      silenceMs,
      rmsPeakDb,
      frameDiff,
      peakRmsDb: -100,
      maxFrameDiff: 0,
      firstAudioHitAt: null,
      firstMotionHitAt: null,
      lastHitAt: null,
      samples: 0,
      closed: false,
    };

    this.prevGray = null;
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    return this.window;
  }

  /** Call when the clip finishes; audio before this point is ignored. */
  markPlaybackEnd() {
    if (this.window && this.window.playbackEndedAt === null) {
      this.window.playbackEndedAt = performance.now();
    }
  }

  sample() {
    const w = this.window;
    if (!w) return;
    const now = performance.now();
    const sinceEnd = w.playbackEndedAt === null ? -1 : now - w.playbackEndedAt;

    const db = this.readAudioDb();
    if (db !== null) {
      this.levels.rmsDb = db;
      // Audio is judged only after the clip's own tail has died down.
      const judgeable = sinceEnd >= w.settleMs;
      if (judgeable) {
        w.samples += 1;
        if (db > w.peakRmsDb) w.peakRmsDb = db;
        if (db > w.rmsPeakDb) {
          if (w.firstAudioHitAt === null) w.firstAudioHitAt = now;
          w.lastHitAt = now;
        }
      }
    }

    const diff = this.readFrameDiff();
    if (diff !== null) {
      this.levels.frameDiff = diff;
      if (diff > w.maxFrameDiff) w.maxFrameDiff = diff;
      // Motion needs no settle: the microphone cannot see it, so there is no
      // echo to exclude. A robot that reacts mid-sentence is still caught.
      if (diff > w.frameDiff) {
        if (w.firstMotionHitAt === null) w.firstMotionHitAt = now;
        w.lastHitAt = now;
      }
    }

    if (sinceEnd < 0) return;
    const quietEnough = w.lastHitAt !== null && now - w.lastHitAt >= w.silenceMs;
    if (quietEnough || sinceEnd > w.windowMs) {
      w.closed = true;
    }
  }

  /** True once the window has either timed out or gone quiet after a hit. */
  get windowElapsed() {
    const w = this.window;
    return !!(w && w.closed);
  }

  /** Close the window and describe what was observed. */
  stopWindow() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const w = this.window;
    this.window = null;
    if (!w) return null;

    const base = w.playbackEndedAt ?? w.startedAt;
    const hits = [w.firstAudioHitAt, w.firstMotionHitAt].filter((x) => x !== null);
    const latencyMs = hits.length ? Math.max(0, Math.round(Math.min(...hits) - base)) : null;

    return {
      peakRmsDb: w.samples ? round1(w.peakRmsDb) : null,
      frameDiff: round1(w.maxFrameDiff),
      latencyMs,
      audioHit: w.firstAudioHitAt !== null,
      motionHit: w.firstMotionHitAt !== null,
      samples: w.samples,
      thresholds: {
        rmsPeakDb: w.rmsPeakDb,
        frameDiff: w.frameDiff,
        windowMs: w.windowMs,
        settleMs: w.settleMs,
        silenceMs: w.silenceMs,
      },
    };
  }

  readAudioDb() {
    if (!this.analyser || !this.sampleBuf) return null;
    this.analyser.getFloatTimeDomainData(this.sampleBuf);
    let sum = 0;
    for (let i = 0; i < this.sampleBuf.length; i += 1) {
      const v = this.sampleBuf[i];
      sum += v * v;
    }
    return rmsToDb(Math.sqrt(sum / this.sampleBuf.length));
  }

  readFrameDiff() {
    if (!this.frameCtx || !this.videoEl || this.videoEl.readyState < 2) return null;
    this.frameCtx.drawImage(this.videoEl, 0, 0, FRAME_W, FRAME_H);
    const { data } = this.frameCtx.getImageData(0, 0, FRAME_W, FRAME_H);
    const n = FRAME_W * FRAME_H;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i += 1, p += 4) {
      gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    }
    const prev = this.prevGray;
    this.prevGray = gray;
    if (!prev) return 0;
    let diff = 0;
    for (let i = 0; i < n; i += 1) diff += Math.abs(gray[i] - prev[i]);
    return diff / n;
  }

  stop() {
    this.stopWindow();
    for (const stream of [this.audioStream, this.videoStream]) {
      if (stream) for (const track of stream.getTracks()) track.stop();
    }
    this.audioStream = null;
    this.videoStream = null;
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.analyser = null;
    this.status = { audio: false, video: false, reason: "stopped" };
  }
}

/**
 * Combine the sensor reading with the configured rule.
 * @param {object} reading  result of stopWindow()
 * @param {object} opts
 * @param {"any"|"motion"|"sound"} opts.rule  what counts as a response
 * @param {number} opts.minMotion             frame difference floor for "moved"
 */
export function classify(reading, { rule = "any", minMotion = 3 } = {}) {
  if (!reading) return { verdict: "skip", reason: "no reading" };

  const spoke = reading.audioHit;
  const moved = reading.motionHit || (reading.frameDiff || 0) > minMotion;

  if (rule === "motion") {
    return moved
      ? { verdict: "pass", reason: "motion detected" }
      : { verdict: "fail", reason: "no motion (rule requires movement)" };
  }
  if (rule === "sound") {
    return spoke
      ? { verdict: "pass", reason: "sound detected" }
      : { verdict: "fail", reason: "no sound (rule requires speech)" };
  }

  if (spoke && moved) return { verdict: "pass", reason: "sound and motion detected" };
  if (spoke) return { verdict: "pass", reason: "sound detected" };
  if (moved) return { verdict: "pass", reason: "motion detected" };

  if (reading.peakRmsDb === null && reading.frameDiff === null) {
    return { verdict: "inconclusive", reason: "no sensors active" };
  }
  return { verdict: "fail", reason: "no sound or motion within the window" };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
