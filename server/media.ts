import type { SegmentArchive } from "./segments.ts";
import { RETENTION_MS } from "../shared/retention.ts";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  writeFileSync,
  statSync,
  statfsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Store, Session } from "./store.ts";
import type { Webinar, Recording, MediaStatus } from "../shared/contracts.ts";

type Run = {
  record: Recording;
  tabId: string;
  commandId: string;
  owner: string;
  part: number;
  ws: WebSocket | null;
  proc: ChildProcessWithoutNullStreams | null;
  closed: Promise<void> | null;
  lastData: number;
  bytes: number;
  stopping: boolean;
  timer: NodeJS.Timeout;
  disconnectedAt: number | null;
};
export class MediaManager {
  current: Run | null = null;
  segments?: SegmentArchive;
  canPreserveBroadcast: () => boolean = () => false;
  private checkingDisk = false;
  private stopJobs = new Map<
    string,
    { accepted: Promise<void>; finished: Promise<void> }
  >();
  archiveWarning: string | null = null;
  private recovery: Promise<void> | null = null;
  onRecording?: (record: Recording) => void;
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  available: boolean;
  constructor(
    public store: Store,
    public changed: (event: string) => void,
  ) {
    this.available =
      spawnSync(this.ffmpeg, ["-version"], { stdio: "ignore", timeout: 5000 })
        .status === 0;
  }
  diagnostic(event: string, kind: string, values: Record<string, number> = {}) {
    void this.store.diagnostic(event, kind, values).catch(() => {});
  }
  async initialize() {
    const store = this.store;
    // A stopped process cannot still own a sender. Interrupted output is never called ready.
    const old = (await store.db
      .prepare(
        "SELECT data FROM recordings WHERE state IN ('recording','processing')",
      )
      .all()) as { data: string }[];
    for (const row of old) {
      const r: Recording = JSON.parse(row.data);
      r.interrupted = true;
      r.state = "failed";
      r.assemblyPending = true;
      r.expiresAt ||= new Date(Date.now() + RETENTION_MS).toISOString();
      await store.saveRecording(r);
      await store.update(r.eventId, { state: "failed" });
    }
  }
  readiness() {
    const disk = statfsSync(this.store.dir);
    return {
      ffmpeg: this.available,
      freeBytes: disk.bavail * disk.bsize,
      youtube: "not_configured",
      mode: "local_only",
    };
  }
  async start(w: Webinar, s: Session, tabId: string, commandId: string) {
    const previous = (await this.store.db
      .prepare("SELECT * FROM start_commands WHERE id=?")
      .get(commandId)) as
      | {
          event_id: string;
          company_id: string;
          session_id: string;
          tab_id: string;
          run_id: string;
        }
      | undefined;
    if (previous) {
      if (
        previous.event_id !== w.id ||
        previous.company_id !== w.companyId ||
        previous.session_id !== s.id ||
        previous.tab_id !== tabId
      )
        throw new Error("Команда запуска уже использована");
      if (this.current?.record.id !== previous.run_id || this.current.stopping)
        throw new Error(
          "Эта команда относится к завершённой передаче — обновите студию",
        );
      return previous.run_id;
    }
    if (w.state === "ended")
      throw new Error("Вебинар завершён — сначала верните его в ожидание");
    const remember = async (runId: string) => {
      await this.store.db
        .prepare("INSERT INTO start_commands VALUES (?,?,?,?,?,?)")
        .run(commandId, w.id, w.companyId, s.id, tabId, runId);
      return runId;
    };
    if (!this.available) throw new Error("FFmpeg недоступен");
    if (this.readiness().freeBytes < 512 * 1024 * 1024)
      throw new Error("Недостаточно свободного места");
    if (this.current) {
      if (
        this.current.record.eventId === w.id &&
        this.current.owner === s.id &&
        this.current.tabId === tabId &&
        !this.current.stopping
      )
        return remember(this.current.record.id);
      // A disconnected studio can be resumed by an authorized host in another tab/session.
      // Reserve ownership synchronously, before remember() awaits the database.
      const r = this.current;
      if (
        r.record.eventId === w.id &&
        r.record.companyId === s.companyId &&
        (s.role === "owner" || s.role === "host") &&
        !r.ws &&
        !r.stopping &&
        r.part > 0 &&
        r.disconnectedAt !== null &&
        Date.now() - r.disconnectedAt >= 2000
      ) {
        r.owner = s.id;
        r.tabId = tabId;
        r.disconnectedAt = Date.now();
        this.diagnostic(w.id, "studio_resumed");
        return remember(r.record.id);
      }
      throw new Error(
        "Уже есть активная студия. Завершите её перед новым запуском.",
      );
    }
    const record: Recording = {
      id: randomUUID(),
      eventId: w.id,
      companyId: w.companyId,
      state: "recording",
      createdAt: new Date().toISOString(),
      duration: null,
      bytes: null,
      hasFile: false,
      interrupted: false,
    };
    await this.store.saveRecording(record);
    mkdirSync(join(this.store.dir, "recordings", record.id), {
      recursive: true,
    });
    const run: Run = {
      record,
      tabId,
      commandId,
      owner: s.id,
      part: 0,
      ws: null,
      proc: null,
      closed: null,
      lastData: Date.now(),
      bytes: 0,
      stopping: false,
      timer: null!,
      disconnectedAt: Date.now(),
    };
    run.timer = setInterval(() => {
      if (run.stopping) return;
      if (this.segments?.configured && !this.checkingDisk) {
        this.checkingDisk = true;
        void (async () => {
          if (
            this.readiness().freeBytes < 1024 ** 3 &&
            this.canPreserveBroadcast()
          ) {
            if (await this.segments!.relievePressure(run.record)) {
              this.archiveWarning =
                "Эфир YouTube продолжается, но резервная запись может содержать пропуски — не хватает места на сервере";
              this.diagnostic(w.id, "archive_disk_pressure");
            }
          }
          await this.segments!.sync(run.record);
        })()
          .catch(() => {
            this.archiveWarning =
              "Облачное хранилище временно недоступно — запись сохраняется на сервере, загрузку повторяем";
          })
          .finally(() => {
            this.checkingDisk = false;
          });
      }
      if (this.readiness().freeBytes < 1024 ** 3 && !this.archiveWarning)
        this.archiveWarning =
          "Мало места на сервере — сохранение записи под угрозой";
      if (run.ws && Date.now() - run.lastData > 15_000) {
        this.diagnostic(w.id, "media_timeout", {
          gapMs: Date.now() - run.lastData,
        });
        if (Date.now() - run.lastData > 20_000) run.ws.terminate();
        else run.ws.close(4000, "Media timeout");
      }
      if (
        this.readiness().freeBytes < 256 * 1024 * 1024 ||
        Date.now() - Date.parse(record.createdAt) > 3 * 3600_000 ||
        run.bytes > 8 * 1024 ** 3
      )
        void this.stop(w.id, true).catch(() => {});
    }, 2000);
    this.archiveWarning = null;
    this.current = run;
    await this.setState(w.id, "starting");
    return remember(record.id);
  }
  async attach(
    runId: string,
    tabId: string,
    s: Session,
    ws: WebSocket,
    format: "webm" | "mp4" = "webm",
  ) {
    const r = this.current;
    if (
      !r ||
      r.record.id !== runId ||
      r.tabId !== tabId ||
      r.owner !== s.id ||
      r.stopping
    ) {
      ws.close(4003, "Sender unavailable");
      return;
    }
    if (r.ws) {
      // A valid owner may retry while the old socket is still closing.
      // Never replace a live sender, and never treat this as revoked access.
      this.diagnostic(r.record.eventId, "sender_busy");
      ws.close(4009, "Sender still closing; retry");
      return;
    }
    r.ws = ws; // Reserve before waiting: a second tab cannot race this await.
    if (r.closed) await r.closed;
    if (r.stopping || ws.readyState !== 1) {
      if (r.ws === ws) r.ws = null;
      return;
    }
    r.part++;
    r.disconnectedAt = null;
    r.lastData = Date.now();
    const dir = join(this.store.dir, "recordings", r.record.id, String(r.part));
    mkdirSync(dir, { recursive: true });
    const proc = spawn(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-stats_period",
        "10",
        "-progress",
        "pipe:1",
        "-probesize",
        "1000000",
        "-analyzeduration",
        "1000000",
        "-f",
        format === "mp4" ? "mov" : "webm",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "25",
        "-g",
        "50",
        "-keyint_min",
        "50",
        "-sc_threshold",
        "0",
        "-crf",
        "20",
        "-threads",
        "2",
        "-maxrate",
        "3500k",
        "-bufsize",
        "7000k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        join(dir, "segment-%05d.ts"),
        join(dir, "stream.m3u8"),
      ],
      { stdio: "pipe" },
    );
    r.proc = proc;
    this.diagnostic(r.record.eventId, "encoder_started", { part: r.part });
    let forced: NodeJS.Timeout | null = null;
    r.closed = new Promise((resolve) => {
      proc.once("close", (code) => {
        this.diagnostic(r.record.eventId, "encoder_closed", {
          code: code ?? -1,
          part: r.part,
        });
        if (forced) clearTimeout(forced);
        r.proc = null;
        resolve();
      });
      proc.once("error", () => {
        r.record.interrupted = true;
        ws.close(1011, "Encoder unavailable");
      });
    });
    let encoderErrorLogged = false;
    proc.stderr.on("data", () => {
      if (!encoderErrorLogged) {
        encoderErrorLogged = true;
        this.diagnostic(r.record.eventId, "encoder_error", { part: r.part });
      }
    }); // Never log raw process arguments or source payloads.
    let progress = "";
    proc.stdout.on("data", (b) => {
      progress = (progress + b.toString()).slice(-8192);
      if (progress.includes("progress=")) {
        const speed = Number(progress.match(/speed=([0-9.]+)x/)?.[1]);
        const fps = Number(progress.match(/fps=([0-9.]+)/)?.[1]);
        if (Number.isFinite(speed) && Number.isFinite(fps))
          this.diagnostic(r.record.eventId, "encoder_progress", {
            speed,
            fps,
            queuedBytes: proc.stdin.writableLength,
          });
        progress = "";
      }
    });
    proc.stdin.on("error", () => {
      if (!r.stopping) ws.close(1011, "Encoder stopped");
    });
    proc.once("close", () => {
      if (!r.stopping && r.ws === ws) ws.close(1011, "Encoder stopped");
    });
    let receivedBytes = 0;
    ws.on("message", (data, binary) => {
      if (this.current !== r || r.ws !== ws || r.stopping) return;
      if (!binary) {
        if (data.toString() === "finish") {
          void this.stop(r.record.eventId, false).catch(() => {});
        }
        return;
      }
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      if (
        buf.length > 2 * 1024 * 1024 ||
        proc.stdin.writableLength > 4 * 1024 * 1024
      ) {
        r.record.interrupted = true;
        this.diagnostic(r.record.eventId, "encoder_queue_full", {
          queuedBytes: proc.stdin.writableLength,
          chunkBytes: buf.length,
        });
        ws.close(4000, "Media queue full");
        return;
      }
      r.lastData = Date.now();
      r.bytes += buf.length;
      receivedBytes += buf.length;
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "media_ack", bytes: receivedBytes }));
      if (!proc.stdin.write(buf)) {
        ws.pause();
        proc.stdin.once("drain", () => {
          if (ws.readyState === 1) ws.resume();
        });
      }
    });
    ws.once("close", (code) => {
      this.diagnostic(r.record.eventId, "media_closed", {
        code,
        part: r.part,
        gapMs: Date.now() - r.lastData,
      });
      if (r.ws !== ws) return;
      r.ws = null;
      proc.stdin.end();
      forced = setTimeout(() => proc.kill("SIGKILL"), 5000);
      if (!r.stopping) {
        r.record.interrupted = true;
        r.disconnectedAt = Date.now();
        void this.setState(r.record.eventId, "reconnecting").catch(() => {
          console.error("Unable to persist media reconnect state");
        });
      }
    });
    ws.send(
      JSON.stringify({ type: "media_ready", runId: r.record.id, part: r.part }),
    );
    await this.setState(r.record.eventId, "starting");
  }
  async setState(id: string, state: Webinar["state"]) {
    await this.store.update(id, { state });
    await this.store.analytics(
      (await this.store.event(id))!,
      "system",
      "state_" + state,
    );
    this.changed(id);
  }
  async status(event: string): Promise<MediaStatus> {
    const r = this.current?.record.eventId === event ? this.current : null;
    const playlist =
      r &&
      existsSync(
        join(
          this.store.dir,
          "recordings",
          r.record.id,
          String(r.part),
          "stream.m3u8",
        ),
      )
        ? `/api/events/${event}/media/${r.record.id}/${r.part}/stream.m3u8`
        : null;
    const e = (await this.store.event(event))!;
    if (r && !r.stopping && r.ws && playlist && e.state === "starting")
      await this.setState(event, "live");
    return {
      runId: r?.record.id ?? null,
      receiving: !!r?.ws && Date.now() - r.lastData < 5000,
      bytes: r?.bytes ?? 0,
      lastDataAt: r?.lastData ?? null,
      playlist,
      state: (await this.store.event(event))!.state,
      mode: "broadcast",
      provider: "railway",
      archiveWarning: this.archiveWarning,
    };
  }
  async stop(
    event: string,
    interrupted = false,
    expectedRunId?: string,
    waitForRecording = true,
  ) {
    const r = this.current;
    if (
      !r ||
      r.record.eventId !== event ||
      (expectedRunId && r.record.id !== expectedRunId)
    )
      return;
    let job = this.stopJobs.get(r.record.id);
    if (!job) {
      r.stopping = true;
      const accepted = this.prepareStop(r, interrupted);
      const finished = accepted
        .then(() => this.finishStop(r))
        .finally(() => {
          this.stopJobs.delete(r.record.id);
        });
      // HTTP callers wait only for durable acceptance. Always observe background failures.
      void finished.catch(() =>
        this.diagnostic(event, "recording_finalize_failed"),
      );
      job = { accepted, finished };
      this.stopJobs.set(r.record.id, job);
    }
    await (waitForRecording ? job.finished : job.accepted);
  }
  private async prepareStop(r: Run, interrupted: boolean) {
    try {
      r.record.interrupted ||= interrupted;
      r.record.state = "processing";
      r.record.stoppedAt ||= new Date().toISOString();
      await this.store.saveRecording(r.record);
      await this.setState(r.record.eventId, "stopping");
      clearInterval(r.timer);
      if (r.ws) {
        r.ws.close(1000, "Finished");
        r.ws = null;
      }
      this.diagnostic(r.record.eventId, "stop_accepted");
    } catch (error) {
      r.stopping = false;
      throw error;
    }
  }
  private async finishStop(r: Run) {
    try {
      if (r.proc) {
        const proc = r.proc;
        proc.stdin.end();
        const kill = setTimeout(() => proc.kill("SIGKILL"), 7000);
        try {
          await r.closed;
        } finally {
          clearTimeout(kill);
        }
      } else if (r.closed) await r.closed;
      await this.finalizeRecord(r.record, r.part);
    } catch (error) {
      // Keep the sources and a durable recovery marker even after unexpected failures.
      r.record.state = "failed";
      r.record.assemblyPending = true;
      r.record.expiresAt ||= new Date(Date.now() + RETENTION_MS).toISOString();
      await this.store.saveRecording(r.record);
      this.diagnostic(r.record.eventId, "recording_finalize_failed");
    } finally {
      if (this.current === r) this.current = null;
    }
    await this.setState(
      r.record.eventId,
      r.record.hasFile ? "ended" : "failed",
    );
    this.diagnostic(r.record.eventId, "recording_finalize_finished", {
      ready: Number(r.record.hasFile),
      cloud: Number(r.record.archive?.state === "ready"),
      interrupted: Number(r.record.interrupted),
    });
    if (r.record.hasFile) this.onRecording?.(r.record);
  }
  async waitForStops() {
    await Promise.allSettled(
      [...this.stopJobs.values()].map((job) => job.finished),
    );
  }
  async finalizeRecord(record: Recording, partCount: number) {
    try {
      if (this.segments?.configured) {
        await this.segments.finalize(record);
        return;
      }
      const root = join(this.store.dir, "recordings", record.id);
      const parts: string[] = [];
      for (let p = 1; p <= partCount; p++) {
        const dir = join(root, String(p));
        const ts = readdirSync(dir)
          .filter((f) => /^segment-\d+\.ts$/.test(f))
          .sort();
        if (!ts.length) continue;
        // Read each finalized HLS generation directly: avoid an extra full-size part.mp4 copy.
        parts.push(`${p}/stream.m3u8`);
      }
      if (!parts.length) throw new Error("No complete media");
      const list = join(root, "parts.txt");
      writeFileSync(list, parts.map((f) => `file '${f}'`).join("\n"));
      const out = join(root, "recording.mp4");
      let sourceBytes = 0;
      for (let p = 1; p <= partCount; p++) {
        const dir = join(root, String(p));
        if (existsSync(dir))
          for (const f of readdirSync(dir).filter((f) =>
            /^segment-\d+\.ts$/.test(f),
          ))
            sourceBytes += statSync(join(dir, f)).size;
      }
      if (this.readiness().freeBytes < sourceBytes * 1.1 + 256 * 1024 ** 2)
        throw Error("Insufficient assembly space");
      await this.command(this.ffmpeg, [
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,crypto,data",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        list,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        out,
      ]);
      const probe = await this.command(this.ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        out,
      ]);
      const duration = Number(JSON.parse(probe).format.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Invalid recording");
      Object.assign(record, {
        hasFile: true,
        assemblyPending: false,
        readyAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
        duration,
        bytes: statSync(out).size,
        state: record.interrupted ? "incomplete" : "ready",
      });
    } catch {
      record.state = "failed";
      record.assemblyPending = true;
      if (record.archive) record.archive = { state: "failed" };
    }
    record.expiresAt ||= new Date(Date.now() + RETENTION_MS).toISOString();
    await this.store.saveRecording(record);
  }
  retryArchives(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.current) return Promise.resolve();
    this.recovery = this.recoverArchives().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }
  async waitForArchives() {
    await this.recovery;
  }
  private async recoverArchives() {
    const rows = (await this.store.db
      .prepare("SELECT data FROM recordings WHERE state='failed'")
      .all()) as { data: string }[];
    for (const row of rows) {
      const record: Recording = JSON.parse(row.data);
      if (
        !record.assemblyPending ||
        (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
      )
        continue;
      const root = join(this.store.dir, "recordings", record.id);
      const parts = existsSync(root)
        ? readdirSync(root)
            .filter((p) => /^\d+$/.test(p))
            .map(Number)
        : [];
      await this.finalizeRecord(record, Math.max(0, ...parts));
      if (record.hasFile) {
        const event = await this.store.event(record.eventId);
        const latest = (await this.store.recordings(record.eventId))[0];
        if (event?.state === "failed" && latest?.id === record.id)
          await this.setState(event.id, "ended");
        this.onRecording?.(record);
      }
      this.changed(record.eventId);
    }
  }

  command(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      p.stdout.on("data", (b) => {
        if (output.length < 10000) output += b;
      });
      const timeout = setTimeout(() => p.kill("SIGKILL"), 30000);
      p.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Media tool failed"));
      });
      p.once("close", (code) => {
        clearTimeout(timeout);
        code === 0
          ? resolve(output)
          : reject(new Error("Media processing failed"));
      });
    });
  }
}
