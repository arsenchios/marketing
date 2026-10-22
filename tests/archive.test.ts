import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import {
  RecordingArchive,
  archiveKey,
  r2Transport,
} from "../server/archive.ts";
import type { Recording } from "../shared/contracts.ts";

test("R2 archive preserves local recordings on failure, retries once, and recovers pending work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-archive-"));
  const store = await Store.open(dir);
  await store.seed();
  const event = (await store.list("arslive"))[0];
  const record: Recording = {
    id: randomUUID(),
    eventId: event.id,
    companyId: event.companyId,
    state: "ready",
    createdAt: new Date().toISOString(),
    duration: 1,
    bytes: 42,
    hasFile: true,
    interrupted: false,
  };
  await store.saveRecording(record);
  let attempts = 0,
    fail = true;
  const transport = {
    async remove() {},
    async upload(file: string, key: string) {
      attempts++;
      assert.ok(file.endsWith("recording.mp4"));
      assert.equal(key, archiveKey(record));
      if (fail) throw new Error("provider unavailable");
    },
    async download() {
      return "https://example.invalid/signed";
    },
  };
  const archive = new RecordingArchive(store, () => {}, transport);
  await archive.initialize();
  try {
    await archive.enqueue(record);
    let saved = (await store.recordings(event.id))[0];
    assert.equal(saved.archive?.state, "failed");
    assert.equal(saved.hasFile, true);
    assert.equal(saved.state, "ready");
    fail = false;
    await Promise.all([archive.enqueue(saved), archive.enqueue(saved)]);
    assert.equal(attempts, 2);
    saved = (await store.recordings(event.id))[0];
    assert.equal(saved.archive?.state, "ready");
    await archive.enqueue(saved);
    assert.equal(attempts, 2);
    saved.archive = { state: "uploading" };
    await store.saveRecording(saved);
    await archive.close();
    const recovered = new RecordingArchive(store, () => {}, transport);
    await recovered.initialize();
    await recovered.enqueue(saved);
    await recovered.close();
    assert.equal((await store.recordings(event.id))[0].archive?.state, "ready");
    assert.equal(attempts, 3);
    assert.equal(r2Transport({}), null);
  } finally {
    await archive.close();
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Seven-day expiry removes only the recording files, retries cloud deletion and keeps history", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { RETENTION_MS, recordingExpired } =
    await import("../shared/retention.ts");
  const dir = mkdtempSync(join(tmpdir(), "arslive-retention-"));
  const store = await Store.open(dir);
  await store.seed();
  const event = (await store.list("arslive"))[0];
  const now = Date.now();
  const r: Recording = {
    id: randomUUID(),
    eventId: event.id,
    companyId: event.companyId,
    state: "ready",
    createdAt: new Date(now).toISOString(),
    readyAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RETENTION_MS).toISOString(),
    duration: 2,
    bytes: 10,
    hasFile: true,
    interrupted: false,
    archive: { state: "ready" },
  };
  await store.saveRecording(r);
  const folder = join(dir, "recordings", r.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "recording.mp4"), "synthetic");
  writeFileSync(join(dir, "unrelated"), "keep");
  let removes = 0;
  const archive = new RecordingArchive(store, () => {}, {
    async upload() {
      throw Error("unexpected upload");
    },
    async download() {
      return "";
    },
    async remove(key) {
      assert.equal(key, archiveKey(r));
      if (++removes === 1) throw Error("offline");
    },
  });
  try {
    await archive.sweep(now + RETENTION_MS - 1);
    assert.ok(existsSync(folder));
    assert.equal(removes, 0);
    assert.equal(recordingExpired(r, now + RETENTION_MS), true);
    await archive.sweep(now + RETENTION_MS);
    assert.equal(existsSync(folder), false);
    assert.equal((await store.recordings(event.id))[0].hasFile, false);
    assert.equal((await store.recordings(event.id))[0].purgedAt, undefined);
    await archive.sweep(now + RETENTION_MS + 1);
    assert.equal(removes, 2);
    assert.ok((await store.recordings(event.id))[0].purgedAt);
    assert.equal((await store.recordings(event.id))[0].duration, 2);
    assert.ok(existsSync(join(dir, "unrelated")));
    await archive.sweep(now + RETENTION_MS + 2);
    assert.equal(removes, 2);
  } finally {
    await archive.close();
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2 preflight writes, reads and deletes only a unique test object, including read failures", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const original = S3Client.prototype.send;
  let saved = "",
    failed = false;
  const calls: string[] = [];
  S3Client.prototype.send = (async (command: any) => {
    calls.push(command.constructor.name);
    assert.match(command.input.Key, /^_checks\/company\/test.txt$/);
    if (command.constructor.name === "PutObjectCommand")
      saved = command.input.Body;
    if (command.constructor.name === "GetObjectCommand") {
      if (failed) throw Error("read denied");
      return { Body: { transformToString: async () => saved } };
    }
    return {};
  }) as any;
  const t = r2Transport({
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "test",
    R2_ACCESS_KEY_ID: "dummy",
    R2_SECRET_ACCESS_KEY: "dummy",
  })!;
  try {
    await t.check!("_checks/company/test.txt");
    assert.deepEqual(calls, [
      "PutObjectCommand",
      "GetObjectCommand",
      "DeleteObjectCommand",
    ]);
    calls.length = 0;
    failed = true;
    await assert.rejects(t.check!("_checks/company/test.txt"));
    assert.equal(calls.at(-1), "DeleteObjectCommand");
  } finally {
    t.abort?.();
    S3Client.prototype.send = original;
  }
});

test("Legacy R2 keys remain unchanged after introducing readable new object names", () => {
  const r = { companyId: "company", eventId: "event", id: "run" } as Recording;
  assert.equal(archiveKey(r), "arslive/company/event/run/recording.mp4");
  assert.equal(
    archiveKey({ ...r, storageKey: "Company/2026-10-14_title_run.mp4" }),
    "Company/2026-10-14_title_run.mp4",
  );
});

test("Local video is removed only after verified cloud bytes, with recovery and available metadata", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "arslive-clean-"));
  const store = await Store.open(dir);
  await store.seed();
  const w = (await store.list("arslive"))[0];
  const r: Recording = {
    id: randomUUID(),
    eventId: w.id,
    companyId: w.companyId,
    state: "ready",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    duration: 1,
    bytes: 9,
    hasFile: true,
    interrupted: false,
  };
  const root = join(dir, "recordings", r.id);
  mkdirSync(join(root, "1"), { recursive: true });
  writeFileSync(join(root, "recording.mp4"), "synthetic");
  writeFileSync(join(root, "1", "segment-00000.ts"), "fragment");
  writeFileSync(join(dir, "unrelated"), "keep");
  let fail = true,
    verified = 0;
  const archive = new RecordingArchive(store, () => {}, {
    async upload() {},
    async download() {
      return "https://example.invalid/file";
    },
    async remove() {},
    async verify(file, key) {
      verified++;
      assert.equal(key, archiveKey(r));
      assert.ok(existsSync(file));
      if (fail) throw Error("read mismatch");
    },
  });
  try {
    await store.saveRecording(r);
    await archive.enqueue(r);
    assert.ok(existsSync(root));
    assert.equal(r.archive?.state, "failed");
    assert.equal(r.localRemovedAt, undefined);
    // A legacy ready marker also needs full verification before cleanup.
    r.archive = { state: "ready" };
    await store.saveRecording(r);
    fail = false;
    await archive.sweep();
    const saved = (await store.recordings(w.id))[0];
    assert.equal(existsSync(root), false);
    assert.ok(saved.localRemovedAt);
    assert.ok(saved.archive?.verifiedAt);
    assert.equal(saved.hasFile, true);
    assert.ok(existsSync(join(dir, "unrelated")));
    await archive.sweep();
    assert.equal(verified, 2);
  } finally {
    await archive.close();
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Real R2 verifier rejects equal-length corruption and accepts matching SHA-256", async () => {
  const { writeFileSync } = await import("node:fs");
  const { S3Client } = await import("@aws-sdk/client-s3");
  const dir = mkdtempSync(join(tmpdir(), "arslive-hash-"));
  const file = join(dir, "test.mp4");
  writeFileSync(file, "good");
  const original = S3Client.prototype.send;
  let body = "bad!";
  S3Client.prototype.send = (async () => ({
    ContentLength: 4,
    Body: (async function* () {
      yield Buffer.from(body);
    })(),
  })) as any;
  const t = r2Transport({
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "test",
    R2_ACCESS_KEY_ID: "dummy",
    R2_SECRET_ACCESS_KEY: "dummy",
  })!;
  try {
    await assert.rejects(t.verify!(file, "key"));
    body = "good";
    await t.verify!(file, "key");
  } finally {
    t.abort?.();
    S3Client.prototype.send = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamed R2 upload verifies full bytes and rejects a same-size corrupt cloud object", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const { Readable } = await import("node:stream");
  const original = S3Client.prototype.send;
  let body = Buffer.alloc(0),
    corrupt = false;
  S3Client.prototype.send = (async (command: any) => {
    if (command.constructor.name === "PutObjectCommand") {
      body = Buffer.from(command.input.Body);
      return { ETag: '"test"' };
    }
    if (command.constructor.name === "GetObjectCommand") {
      const response = Buffer.from(body);
      if (corrupt) response[0] ^= 1;
      return {
        ContentLength: response.length,
        Body: Readable.from([response]),
      };
    }
    throw Error("Unexpected storage operation");
  }) as any;
  const transport = r2Transport({
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "test",
    R2_ACCESS_KEY_ID: "dummy",
    R2_SECRET_ACCESS_KEY: "dummy",
  })!;
  try {
    assert.equal(
      await transport.uploadStream!(
        Readable.from([Buffer.from("synthetic video")]),
        "recording.mp4",
      ),
      15,
    );
    corrupt = true;
    await assert.rejects(
      transport.uploadStream!(
        Readable.from([Buffer.from("synthetic video")]),
        "recording.mp4",
      ),
      /checksum/,
    );
  } finally {
    transport.abort?.();
    S3Client.prototype.send = original;
  }
});
