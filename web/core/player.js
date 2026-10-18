// Sequential audio playback with preloading.
//
// Playback must be initiated by a user gesture at least once, otherwise the
// browser's autoplay policy blocks every clip after the first. The runner
// always starts from a click, so this is satisfied by construction.

export class Player {
  constructor() {
    /** @type {Map<string, HTMLAudioElement>} */
    this.cache = new Map();
    this.current = null;
    this.volume = 1;
    this.unlocked = false;
  }

  /**
   * Spend the user gesture on a silent clip so later programmatic play() calls
   * are allowed. Browsers only grant playback rights inside a real gesture, and
   * the first awaited step of a run is already outside it.
   * Must be called synchronously from a click handler.
   */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const a = new Audio(
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="
      );
      a.volume = 0;
      a.play().catch(() => {});
    } catch {
      /* nothing to do; play() will report the real problem */
    }
  }

  /** Warm the cache so the first round is not delayed by a network fetch. */
  async preload(urls, concurrency = 4) {
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const url = queue.shift();
        if (!url || this.cache.has(url)) continue;
        const audio = new Audio();
        audio.preload = "auto";
        audio.src = url;
        this.cache.set(url, audio);
        try {
          await new Promise((resolve) => {
            const done = () => resolve();
            audio.addEventListener("canplaythrough", done, { once: true });
            audio.addEventListener("error", done, { once: true });
            setTimeout(done, 8000);
            audio.load();
          });
        } catch {
          /* a missing clip surfaces at play() time with a clear message */
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Play one clip. Resolves with its duration in ms once playback ends.
   * Rejects with a readable message if the file is missing or unplayable.
   */
  async play(url) {
    const audio = this.cache.get(url) || new Audio(url);
    this.cache.set(url, audio);
    audio.volume = this.volume;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      };
      const onEnded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.current = null;
        resolve(Math.round((audio.duration || 0) * 1000));
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.current = null;
        reject(new Error(`Cannot play ${url.split("/").pop()} — file missing or unsupported format`));
      };

      audio.addEventListener("ended", onEnded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      audio.currentTime = 0;
      this.current = audio;

      audio.play().catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.current = null;
        const blocked = /not allowed|user didn't interact|gesture/i.test(err.message);
        reject(new Error(
          blocked
            ? "浏览器拦截了自动播放。点一下页面任意位置，然后按 ↻ 重播。"
            : err.message
        ));
      });
    });
  }

  /** Play the same clip again without advancing the round counter. */
  replay(url) {
    return this.play(url);
  }

  stop() {
    if (this.current) {
      this.current.pause();
      this.current.currentTime = 0;
      this.current = null;
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.current) this.current.volume = this.volume;
  }
}
