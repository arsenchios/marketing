import { recordingMime, studioCompatibility } from "./studio-capabilities";
import { AdaptiveQuality } from "./adaptive.ts";
import { send, api } from "./api";
import type { Compositor } from "./compositor";
export class StudioTransport {
  socket: WebSocket | null = null;
  recorder: MediaRecorder | null = null;
  stopped = false;
  timer: ReturnType<typeof setTimeout> | null = null;
  handshake: ReturnType<typeof setTimeout> | null = null;
  attempt = 0;
  runId = "";
  watchdog: ReturnType<typeof setInterval> | null = null;
  quality = new AdaptiveQuality();
  constructor(
    public event: string,
    public tabId: string,
    public compositor: Compositor,
    public notify: (s: string) => void,
  ) {}
  report(kind: string, values: Record<string, number> = {}) {
    void send(`/api/events/${this.event}/diagnostics`, { kind, values }).catch(
      () => {},
    );
  }
  async start(
    safety: {
      earlyStartConfirmed?: boolean;
      expectedReopenedAt?: string | null;
    } = {},
  ) {
    const problem = studioCompatibility();
    if (problem) throw new Error(problem);
    const { runId } = await send(`/api/events/${this.event}/start`, {
      tabId: this.tabId,
      commandId: crypto.randomUUID(),
      mode: "broadcast",
      ...safety,
    });
    this.runId = runId;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    this.notify(
      this.attempt ? "Восстанавливаем передачу…" : "Подключаем видеопоток…",
    );
    const mime = recordingMime();
    const connectedAt = Date.now();
    let sent = 0,
      acknowledged = 0;
    let adapting = false;
    let softenedAt = 0;
    let healthySince = 0;
    let lastAck = Date.now();
    let lastChunk = Date.now(),
      maxChunkGap = 0,
      lastHealth = Date.now();
    const reconnect = (reason: string) => {
      if (adapting || this.stopped) return;
      adapting = true;
      ws.close(4000, reason);
    };
    const lowerQuality = () => {
      if (!this.quality.lower()) return false;
      this.report("quality_reduced", { bitrate: this.quality.bitrate });
      return true;
    };
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/media?event=${this.event}`,
    );
    this.socket = ws;
    // The upload watchdog starts after media_ready; also bound the initial wait.
    this.handshake = setTimeout(() => {
      if (this.stopped || this.socket !== ws) return;
      this.report("sender_handshake_timeout");
      reconnect("Media handshake timeout");
    }, 15000);
    this.report("sender_connect", {
      attempt: this.attempt,
      hidden: Number(typeof document !== "undefined" && document.hidden),
    });
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          runId: this.runId,
          tabId: this.tabId,
          format: mime?.startsWith("video/mp4") ? "mp4" : "webm",
        }),
      );
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (this.stopped || this.socket !== ws) return;
      if (msg.type === "media_ack") {
        if (
          Number.isFinite(msg.bytes) &&
          msg.bytes >= acknowledged &&
          msg.bytes <= sent
        ) {
          acknowledged = msg.bytes;
          lastAck = Date.now();
        }
        if (sent === acknowledged && Date.now() - connectedAt > 15000)
          this.attempt = 0;
        return;
      }
      if (msg.type !== "media_ready" || this.recorder) return;
      if (this.handshake) clearTimeout(this.handshake);
      this.handshake = null;
      if (!mime) {
        this.notify(
          "Этот браузер не поддерживает запись. Откройте студию в Chrome.",
        );
        this.dispose();
        return;
      }
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(this.compositor.stream(), {
          mimeType: mime,
          videoBitsPerSecond: this.quality.bitrate,
          audioBitsPerSecond: 128000,
        });
      } catch {
        this.notify(
          "Не удалось запустить передачу в этом браузере. Включите камеру снова и возобновите эфир либо используйте другой браузер",
        );
        this.dispose();
        return;
      }
      this.recorder = recorder;
      this.compositor.setFrameRate?.([25, 15, 10][this.quality.level]);
      this.watchdog = setInterval(() => {
        if (sent > acknowledged && Date.now() - lastAck > 12000)
          reconnect("Upload acknowledgement timeout");
      }, 2000);
      recorder.ondataavailable = (e) => {
        const now = Date.now();
        maxChunkGap = Math.max(maxChunkGap, now - lastChunk);
        lastChunk = now;
        if (now - lastHealth >= 30000 && !this.stopped) {
          this.report("media_health", {
            chunkGapMs: maxChunkGap,
            queuedBytes: Math.max(ws.bufferedAmount, sent - acknowledged),
            sampleRate: this.compositor.audio?.sampleRate || 0,
            audioRunning: Number(this.compositor.audio?.state === "running"),
            hidden: Number(typeof document !== "undefined" && document.hidden),
          });
          lastHealth = now;
          maxChunkGap = 0;
        }
        if (e.data.size && ws.readyState === 1 && !adapting) {
          if (ws.bufferedAmount + e.data.size > 8 * 1024 * 1024) {
            this.report("sender_queue_full", {
              queuedBytes: ws.bufferedAmount,
              chunkBytes: e.data.size,
            });
            lowerQuality();
            ws.close(4000, "Restart bounded queue");
            return;
          }
          const outstanding = Math.max(ws.bufferedAmount, sent - acknowledged);
          if (outstanding < 128 * 1024) {
            healthySince ||= Date.now();
            if (softenedAt && Date.now() - healthySince > 30000) softenedAt = 0;
          } else healthySince = 0;
          if (softenedAt && !healthySince && Date.now() - softenedAt > 12000) {
            reconnect("Persistent upload congestion");
            return;
          }
          if (
            !this.stopped &&
            this.quality.sample(
              Math.max(ws.bufferedAmount, sent - acknowledged),
              Date.now(),
            )
          ) {
            softenedAt ||= Date.now();
            this.compositor.setFrameRate?.([25, 15, 10][this.quality.level]);
            this.report("quality_reduced", {
              bitrate: this.quality.bitrate,
              queuedBytes: outstanding,
            });
            this.notify("Снижаем качество видео для устойчивой передачи звука");
            // Keep this container and audio running; restart only if pressure persists.
          }
          // MediaRecorder timeslices are not guaranteed: delayed blobs can exceed a WS frame limit.
          // Preserve every byte in order without restarting the WebM container.
          sent += e.data.size;
          for (let offset = 0; offset < e.data.size; offset += 256 * 1024)
            ws.send(e.data.slice(offset, offset + 256 * 1024));
        }
      };
      recorder.onerror = () => ws.close(4000, "Capture error");
      recorder.start(500);
      this.notify(
        `Видеопоток отправляется на сервер · ${["высокое качество", "экономный режим", "слабая связь — приоритет звука"][this.quality.level]}`,
      );
    };
    ws.onclose = (e) => {
      if (this.socket === ws && this.watchdog) clearInterval(this.watchdog);
      this.report("sender_closed", {
        code: e.code,
        hidden: Number(typeof document !== "undefined" && document.hidden),
      });
      if (this.socket !== ws) return;
      if (this.handshake) clearTimeout(this.handshake);
      this.handshake = null;
      const recorder = this.recorder;
      this.recorder = null;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      if (this.stopped) return;
      if ([1000, 4003].includes(e.code)) {
        this.notify(
          e.code === 4003
            ? "Передача уже открыта в другой вкладке или сеанс истёк"
            : "Передача завершена сервером",
        );
        this.stopped = true;
        return;
      }
      if (this.attempt >= 7) {
        this.notify(
          "Связь пока недоступна. Эфир остаётся открытым — проверьте интернет и нажмите «Возобновить передачу».",
        );
        this.stopped = true;
        return;
      }
      if (this.attempt >= 2 && !adapting && e.code !== 4009) lowerQuality();
      this.notify("Связь прервана. Восстанавливаем…");
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(10000, 1000 * 2 ** this.attempt++) + Math.random() * 500,
      );
    };
  }
  async stop() {
    this.stopped = true;
    if (this.handshake) clearTimeout(this.handshake);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.timer) clearTimeout(this.timer);
    const ws = this.socket;
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          recorder.removeEventListener("stop", done);
          resolve();
        };
        const timer = setTimeout(done, 5000);
        recorder.addEventListener("stop", done, { once: true });
        try {
          recorder.stop();
        } catch {
          done();
        }
      });
    }
    if (ws?.readyState === 1) {
      // Finish follows the final media chunk on the same ordered connection.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          ws.removeEventListener("close", done);
          resolve();
        };
        const timer = setTimeout(done, 10000);
        ws.addEventListener("close", done, { once: true });
        try {
          ws.send("finish");
        } catch {
          done();
        }
      });
    }
    // An idempotent HTTP acknowledgement also covers a lost socket close/update.
    await api(`/api/events/${this.event}/stop`, {
      method: "POST",
      body: JSON.stringify({ runId: this.runId }),
      signal: AbortSignal.timeout(15000),
    });
    this.notify(
      "Эфир завершён. Готовим запись — статус обновится автоматически",
    );
  }
  dispose() {
    this.stopped = true;
    if (this.handshake) clearTimeout(this.handshake);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.timer) clearTimeout(this.timer);
    if (this.recorder && this.recorder.state !== "inactive")
      this.recorder.stop();
    this.socket?.close(4000, "Studio unmounted");
  }
}
