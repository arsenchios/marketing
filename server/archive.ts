import { createReadStream, statSync, rmSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { recordingExpired, RETENTION_MS } from "../shared/retention.ts";
import type { Recording } from "../shared/contracts.ts";
import type { Store } from "./store.ts";

export interface ArchiveTransport {
  upload(file: string, key: string): Promise<void>;
  uploadStream?(stream: Readable, key: string): Promise<number>;
  download(key: string, filename: string, ttl?: number): Promise<string>;
  remove(key: string): Promise<void>;
  removeMany?(keys: string[]): Promise<void>;
  check?(key: string): Promise<void>;
  verify?(file: string, key: string): Promise<void>;
  abort?(): void;
}
export function r2Transport(env = process.env): ArchiveTransport | null {
  const {
    R2_ACCOUNT_ID: account,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (
    !account ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !/^[a-f0-9]{32}$/i.test(account)
  )
    return null;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
  });
  const active = new Set<Upload>();
  return {
    async check(key) {
      const body = "ArsLive storage check " + randomUUID();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "text/plain",
          }),
        );
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if ((await result.Body?.transformToString()) !== body)
          throw Error("Storage read verification failed");
      } finally {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      }
    },
    async upload(file, key) {
      const bytes = statSync(file).size;
      const task = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: createReadStream(file),
          ContentType: key.endsWith(".ts") ? "video/mp2t" : "video/mp4",
          ContentLength: bytes,
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false,
      });
      active.add(task);
      try {
        await task.done();
        const stored = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (stored.ContentLength !== bytes)
          throw new Error("Archive verification failed");
      } finally {
        active.delete(task);
      }
    },
    async uploadStream(stream, key) {
      let bytes = 0;
      const hash = createHash("sha256");
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      stream.once("error", (error) => counter.destroy(error));
      const task = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: stream.pipe(counter),
          ContentType: "video/mp4",
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false,
      });
      active.add(task);
      try {
        await task.done();
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!bytes || response.ContentLength !== bytes || !response.Body)
          throw Error("Archive size mismatch");
        const remote = createHash("sha256");
        let received = 0;
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          remote.update(chunk);
          received += chunk.length;
        }
        if (received !== bytes || remote.digest("hex") !== hash.digest("hex"))
          throw Error("Archive checksum mismatch");
        return bytes;
      } finally {
        active.delete(task);
        stream.unpipe(counter);
        counter.destroy();
      }
    },
    async verify(file, key) {
      const local = createHash("sha256");
      for await (const chunk of createReadStream(file)) local.update(chunk);
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (response.ContentLength !== statSync(file).size || !response.Body)
        throw Error("Archive size verification failed");
      const remote = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        remote.update(chunk);
        bytes += chunk.length;
      }
      if (
        bytes !== statSync(file).size ||
        remote.digest("hex") !== local.digest("hex")
      )
        throw Error("Archive content verification failed");
    },
    async removeMany(keys) {
      for (let i = 0; i < keys.length; i += 500) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: keys.slice(i, i + 500).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        if (result.Errors?.length)
          throw Error("Archive source cleanup incomplete");
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async download(key, filename, ttl = 60) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: filename
            ? `attachment; filename="${filename}"`
            : "inline",
        }),
        { expiresIn: ttl },
      );
    },
    abort() {
      for (const task of active) void task.abort().catch(() => {});
      client.destroy();
    },
  };
}
export function archiveKey(r: Recording) {
  return (
    r.storageKey ||
    `arslive/${r.companyId}/${r.eventId}/${r.id}/recording.mp4`
  );
}

/** Private archive with seven-day retention; legacy object keys are never migrated implicitly. */
export class RecordingArchive {
  private queued = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private timer!: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    public changed: (id: string) => void,
    public transport: ArchiveTransport | null = r2Transport(),
    public canClean: (record: Recording) => boolean = () => true,
    public removeParts: (record: Recording) => Promise<void> = async () => {},
  ) {}
  async initialize() {
    const { store, transport } = this;
    // Legacy recordings receive a full seven days from policy activation.
    const legacy = (await store.db
      .prepare(
        "SELECT data FROM recordings WHERE state NOT IN ('recording','processing')",
      )
      .all()) as { data: string }[];
    for (const row of legacy) {
      const r: Recording = JSON.parse(row.data);
      if (!r.expiresAt) {
        r.expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
        await store.saveRecording(r);
      }
    }
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 60_000);
    this.timer.unref();
    if (transport) {
      const rows = (await store.db
        .prepare(
          "SELECT data FROM recordings WHERE state IN ('ready','incomplete')",
        )
        .all()) as { data: string }[];
      for (const row of rows) {
        const r: Recording = JSON.parse(row.data);
        if (
          r.hasFile &&
          ["pending", "uploading", "failed"].includes(r.archive?.state || "")
        )
          void this.enqueue(r);
      }
    }
  }
  get configured() {
    return !!this.transport;
  }
  async check(companyId: string) {
    if (!this.transport?.check) return { cloud: "not_configured" as const };
    await this.transport.check(`_checks/${companyId}/${randomUUID()}.txt`);
    return { cloud: "ready" as const };
  }
  enqueue(record: Recording): Promise<void> {
    if (
      recordingExpired(record) ||
      !record.hasFile ||
      this.closing ||
      this.queued.has(record.id) ||
      record.archive?.state === "ready"
    )
      return this.tail;
    this.queued.add(record.id);
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closing) {
          this.queued.delete(record.id);
          return;
        }
        try {
          if (!record.storageKey && !record.archive) {
            const event = await this.store.event(record.eventId);
            const company = await this.store.db
              .prepare("SELECT name FROM companies WHERE id=?")
              .get(record.companyId);
            const slug = (s: string) =>
              s
                .normalize("NFKC")
                .replace(/[^\p{L}\p{N}_-]+/gu, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 70) || "webinar";
            record.storageKey = `${slug(company?.name || "company")}-${record.companyId}/${record.createdAt.slice(0, 10)}_${slug(event?.title || "webinar")}_${record.id}.mp4`;
          }
          record.archive = {
            state: this.transport ? "uploading" : "not_configured",
          };
          await this.store.saveRecording(record);
          this.changed(record.eventId);
          if (this.transport) {
            await this.transport.upload(
              join(this.store.dir, "recordings", record.id, "recording.mp4"),
              archiveKey(record),
            );
            if (this.transport.verify)
              await this.transport.verify(
                join(this.store.dir, "recordings", record.id, "recording.mp4"),
                archiveKey(record),
              );
            record.archive = {
              state: "ready",
              storedAt: new Date().toISOString(),
              ...(this.transport.verify
                ? { verifiedAt: new Date().toISOString() }
                : {}),
            };
          }
        } catch {
          record.archive = { state: this.closing ? "pending" : "failed" };
        } finally {
          await this.store.saveRecording(record);
          this.queued.delete(record.id);
          this.changed(record.eventId);
        }
        await this.cleanLocal(record);
      });
    return this.tail;
  }
  async cleanLocal(r: Recording) {
    if (
      !this.canClean(r) ||
      r.archive?.state !== "ready" ||
      r.localRemovedAt ||
      !this.transport?.verify ||
      !["ready", "incomplete"].includes(r.state) ||
      !/^[a-f0-9-]{36}$/i.test(r.id)
    )
      return;
    const root = join(this.store.dir, "recordings", r.id);
    const file = join(root, "recording.mp4");
    try {
      // Never trust a successful upload or an old ready label alone before deleting the local copy.
      if (!r.archive.verifiedAt) {
        if (!existsSync(file)) return;
        await this.transport.verify(file, archiveKey(r));
        r.archive.verifiedAt = new Date().toISOString();
        await this.store.saveRecording(r); // Durable cloud proof precedes deletion.
      }
      rmSync(root, { recursive: true, force: true });
      r.localRemovedAt = new Date().toISOString();
      void this.store
        .diagnostic(r.eventId, "local_recording_removed")
        .catch(() => {});
      await this.store.saveRecording(r);
      this.changed(r.eventId);
    } catch {
      if (!r.archive?.verifiedAt) {
        r.archive = { state: "failed" };
        await this.store.saveRecording(r);
        this.changed(r.eventId);
      }
      // A failed cloud verification keeps the original; failed local removal retries next sweep.
    }
  }
  sweep(now = Date.now()): Promise<void> {
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closing) return;
        const rows = (await this.store.db
          .prepare(
            "SELECT data FROM recordings WHERE state NOT IN ('recording','processing')",
          )
          .all()) as { data: string }[];
        for (const row of rows) {
          const r: Recording = JSON.parse(row.data);
          if (!recordingExpired(r, now)) {
            await this.cleanLocal(r);
            if (
              this.transport &&
              r.hasFile &&
              !r.localRemovedAt &&
              ["failed", "pending"].includes(r.archive?.state || "")
            )
              void this.enqueue(r).catch(() => {});
            if (r.archive?.state === "ready" && r.archive.verifiedAt)
              await this.removeParts(r).catch(() => {});
          }
          if (
            !recordingExpired(r, now) ||
            r.purgedAt ||
            !/^[a-f0-9-]{36}$/i.test(r.id)
          )
            continue;
          r.hasFile = false;
          await this.store.saveRecording(r);
          this.changed(r.eventId);
          try {
            rmSync(join(this.store.dir, "recordings", r.id), {
              recursive: true,
              force: true,
            });
            // A failed multipart request can still have completed remotely: delete its exact key too.
            if (r.archive && r.archive.state !== "not_configured") {
              if (!this.transport) continue;
              await this.transport.remove(archiveKey(r));
            }
            await this.removeParts(r);
            r.purgedAt = new Date(now).toISOString();
            await this.store.saveRecording(r);
            this.changed(r.eventId);
          } catch {
            /* Retry on next sweep; downloads stay closed after expiry. */
          }
        }
      });
    return this.tail;
  }
  async close() {
    clearInterval(this.timer);
    this.closing = true;
    this.transport?.abort?.();
    await this.tail;
  }
}
