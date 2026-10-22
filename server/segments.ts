import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Store } from "./store.ts";
import type { ArchiveTransport } from "./archive.ts";
import type { Recording } from "../shared/contracts.ts";
import { RETENTION_MS } from "../shared/retention.ts";

type Segment = {
  recording_id: string;
  part: number;
  seq: number;
  duration: number;
  object_key: string;
  verified: number;
  lost: number;
};
/** Immutable closed segments, durable upload acknowledgements, bounded live working set.
 * Only the playlist-published .ts files are eligible: never upload a growing .tmp file.
 */
export class SegmentArchive {
  private tails = new Map<string, Promise<void>>();
  constructor(
    public store: Store,
    public transport: ArchiveTransport | null,
    public ffmpeg: string,
  ) {}
  get configured() {
    return !!(this.transport?.uploadStream && this.transport.verify);
  }
  async initialize() {
    await this.store.db.exec(`CREATE TABLE IF NOT EXISTS recording_segments(
      recording_id TEXT NOT NULL REFERENCES recordings(id), part INTEGER NOT NULL, seq INTEGER NOT NULL,
      duration REAL NOT NULL, object_key TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      lost INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(recording_id,part,seq));`);
    // Crash recovery removes temporary signed manifests, never media source files.
    const records = (await this.store.db
      .prepare("SELECT id FROM recordings")
      .all()) as { id: string }[];
    for (const { id } of records) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
      const root = join(this.store.dir, "recordings", id);
      if (!existsSync(root)) continue;
      for (const file of readdirSync(root))
        if (/^cloud-(?:parts\.txt|\d+\.m3u8)$/.test(file))
          unlinkSync(join(root, file));
    }
  }
  root(r: Recording) {
    return join(this.store.dir, "recordings", r.id);
  }
  file(r: Recording, s: Segment) {
    return join(
      this.root(r),
      String(s.part),
      `segment-${String(s.seq).padStart(5, "0")}.ts`,
    );
  }
  async rows(r: Recording): Promise<Segment[]> {
    return (await this.store.db
      .prepare(
        "SELECT * FROM recording_segments WHERE recording_id=? ORDER BY part,seq",
      )
      .all(r.id)) as Segment[];
  }
  async discover(r: Recording) {
    const root = this.root(r);
    if (!existsSync(root)) return;
    for (const part of readdirSync(root).filter((x) => /^\d+$/.test(x))) {
      const file = join(root, part, "stream.m3u8");
      if (!existsSync(file)) continue;
      const playlist = readFileSync(file, "utf8");
      const latest = await this.store.db
        .prepare(
          "SELECT MAX(seq) AS seq FROM recording_segments WHERE recording_id=? AND part=?",
        )
        .get(r.id, Number(part));
      const lastSeq = latest?.seq ?? -1;
      for (const match of playlist.matchAll(
        /#EXTINF:([\d.]+),[^\n]*\n(segment-(\d+)\.ts)/g,
      )) {
        if (Number(match[3]) <= lastSeq) continue;
        const duration = Number(match[1]);
        if (!Number.isFinite(duration) || duration <= 0) continue;
        const key = `_segments/${r.companyId}/${r.eventId}/${r.id}/${part}/${match[2]}`;
        await this.store.db
          .prepare(
            "INSERT OR IGNORE INTO recording_segments(recording_id,part,seq,duration,object_key) VALUES (?,?,?,?,?)",
          )
          .run(r.id, Number(part), Number(match[3]), duration, key);
      }
    }
  }
  sync(r: Recording, all = false): Promise<void> {
    const previous = this.tails.get(r.id);
    if (previous && !all) return previous;
    const work = (previous || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.discover(r);
        if (!this.configured) return;
        const rows = await this.rows(r);
        let uploaded = 0;
        for (const s of rows) {
          if (s.verified || s.lost) continue;
          const file = this.file(r, s);
          if (!existsSync(file)) {
            await this.store.db
              .prepare(
                "UPDATE recording_segments SET lost=1 WHERE recording_id=? AND part=? AND seq=?",
              )
              .run(r.id, s.part, s.seq);
            continue;
          }
          // Failure stops this batch, retaining the original and retrying at the next tick.
          await this.transport!.upload(file, s.object_key);
          await this.transport!.verify!(file, s.object_key);
          await this.store.db
            .prepare(
              "UPDATE recording_segments SET verified=1 WHERE recording_id=? AND part=? AND seq=?",
            )
            .run(r.id, s.part, s.seq);
          s.verified = 1;
          if (!all && ++uploaded >= 12) break;
        }
        // Keep six minutes available for HLS viewers and the YouTube relay.
        let tailSeconds = 0;
        for (const s of rows.toReversed()) {
          tailSeconds += s.duration;
          if (tailSeconds > 360 && s.verified && existsSync(this.file(r, s)))
            unlinkSync(this.file(r, s));
        }
      });
    this.tails.set(r.id, work);
    void work
      .finally(() => {
        if (this.tails.get(r.id) === work) this.tails.delete(r.id);
      })
      .catch(() => {});
    return work;
  }
  relievePressure(r: Recording): Promise<boolean> {
    if (this.tails.has(r.id)) return Promise.resolve(false);
    const work = this.pruneUnderPressure(r);
    const tail = work.then(() => {});
    this.tails.set(r.id, tail);
    void tail
      .finally(() => {
        if (this.tails.get(r.id) === tail) this.tails.delete(r.id);
      })
      .catch(() => {});
    return work;
  }
  private async pruneUnderPressure(r: Recording) {
    // Degrade the independent archive explicitly, never silently stop a healthy YouTube relay.
    // Do not race a reader currently uploading the local source.
    await this.discover(r);
    const rows = await this.rows(r);
    let seconds = 0,
      removed = false;
    for (const s of rows.toReversed()) {
      seconds += s.duration;
      if (seconds <= 90 || !existsSync(this.file(r, s))) continue;
      if (!s.verified) {
        await this.store.db
          .prepare(
            "UPDATE recording_segments SET lost=1 WHERE recording_id=? AND part=? AND seq=?",
          )
          .run(r.id, s.part, s.seq);
        r.interrupted = true;
        await this.store.saveRecording(r);
      }
      unlinkSync(this.file(r, s));
      removed = true;
    }
    return removed;
  }
  async remove(r: Recording) {
    const rows = await this.rows(r);
    if (!rows.length) return;
    if (!this.transport) throw Error("Storage unavailable");
    if (this.transport.removeMany)
      await this.transport.removeMany(rows.map((s) => s.object_key));
    else for (const s of rows) await this.transport.remove(s.object_key);
    await this.store.db
      .prepare("DELETE FROM recording_segments WHERE recording_id=?")
      .run(r.id);
  }
  /** Stream fragmented MP4 to R2. No full final MP4 or re-downloaded source copy on disk. */
  async finalize(r: Recording) {
    if (!this.configured) throw Error("Streaming archive unavailable");
    await this.sync(r, true);
    const rows = await this.rows(r);
    const good = rows.filter((s) => s.verified && !s.lost);
    if (!good.length || rows.some((s) => !s.verified && !s.lost))
      throw Error("Archive fragments pending");
    r.interrupted ||= rows.some((s) => !!s.lost);
    const root = this.root(r);
    mkdirSync(root, { recursive: true });
    const parts: string[] = [];
    try {
      for (const part of [...new Set(good.map((s) => s.part))]) {
        const group = good.filter((s) => s.part === part);
        const lines = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...group.map((s) => s.duration)))}`,
          "#EXT-X-MEDIA-SEQUENCE:0",
        ];
        let previous = -1;
        for (const s of group) {
          if (previous >= 0 && s.seq !== previous + 1)
            lines.push("#EXT-X-DISCONTINUITY");
          lines.push(
            `#EXTINF:${s.duration},`,
            await this.transport!.download(s.object_key, "", 10800),
          );
          previous = s.seq;
        }
        lines.push("#EXT-X-ENDLIST");
        const name = `cloud-${part}.m3u8`;
        writeFileSync(join(root, name), lines.join("\n"), { mode: 0o600 });
        parts.push(name);
      }
      const list = join(root, "cloud-parts.txt");
      writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"), {
        mode: 0o600,
      });
      r.storageKey ||= `${r.companyId}/${r.createdAt.slice(0, 10)}_${r.eventId}_${r.id}.mp4`;
      r.archive = { state: "uploading" };
      await this.store.saveRecording(r); // Retention can remove even an interrupted final upload.
      const child = spawn(
        this.ffmpeg,
        [
          "-v",
          "warning",
          "-xerror",
          "-protocol_whitelist",
          "file,http,https,tcp,tls,crypto,data",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-af",
          "aresample=async=1",
          "-movflags",
          "+frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // FFmpeg can exit 0 after skipping a missing HLS segment. Treat reported
      // input errors as a failed assembly; never persist raw signed URLs from stderr.
      let mediaError = false;
      child.stderr.on("data", () => {
        mediaError = true;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(Error("Archive encoder unavailable")));
        child.once("close", (code) =>
          code === 0 && !mediaError
            ? resolve()
            : reject(Error("Archive encoding failed")),
        );
      });
      // Attach rejection handlers immediately; failed encoding aborts the multipart stream.
      void done.catch((error) => child.stdout.destroy(error));
      try {
        const [bytes] = await Promise.all([
          this.transport!.uploadStream!(child.stdout, r.storageKey),
          done,
        ]);
        const now = new Date().toISOString();
        Object.assign(r, {
          hasFile: true,
          bytes,
          duration: good.reduce((n, s) => n + s.duration, 0),
          readyAt: now,
          expiresAt:
            r.expiresAt || new Date(Date.now() + RETENTION_MS).toISOString(),
          state: r.interrupted ? "incomplete" : "ready",
          assemblyPending: false,
          archive: { state: "ready", storedAt: now, verifiedAt: now },
        });
        // A durable pointer to the verified final file must precede any source deletion.
        await this.store.saveRecording(r);
      } finally {
        clearTimeout(timeout);
        child.kill("SIGKILL");
      }
    } finally {
      for (const name of [...parts, "cloud-parts.txt"]) {
        const file = join(root, name);
        if (existsSync(file)) unlinkSync(file); // Never leave signed URLs in the volume.
      }
    }
  }
  async close() {
    await Promise.allSettled([...this.tails.values()]);
  }
}

/** Viewer playlist exposes only the retained working window, never already evicted history. */
export function liveWindow(
  playlist: string,
  available: (file: string) => boolean = () => true,
): string {
  const entries = [
    ...playlist.matchAll(/#EXTINF:([\d.]+),[^\n]*\n(segment-(\d+)\.ts)/g),
  ]
    .slice(-180)
    .filter((entry) => available(entry[2]));
  if (!entries.length) return "#EXTM3U\n#EXT-X-TARGETDURATION:2\n";
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...entries.map((e) => Number(e[1]))))}`,
    `#EXT-X-MEDIA-SEQUENCE:${Number(entries[0][3])}`,
    ...entries.map((e) => `#EXTINF:${e[1]},\n${e[2]}`),
    ...(playlist.includes("#EXT-X-ENDLIST") ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}
