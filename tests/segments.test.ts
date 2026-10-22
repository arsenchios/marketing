import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Readable } from "node:stream";
import { Store } from "../server/store.ts";
import { MediaManager } from "../server/media.ts";
import { SegmentArchive, liveWindow } from "../server/segments.ts";
import type { Recording } from "../shared/contracts.ts";

test(
  "durable segment upload recovers outages, evicts only verified old files and streams a playable final MP4",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "arslive-segments-"));
    const store = await Store.open(dir);
    await store.seed();
    const event = (await store.list("arslive"))[0];
    const r: Recording = {
      id: randomUUID(),
      eventId: event.id,
      companyId: event.companyId,
      state: "recording",
      createdAt: new Date().toISOString(),
      duration: null,
      bytes: null,
      hasFile: false,
      interrupted: false,
    };
    await store.saveRecording(r);
    const part = join(dir, "recordings", r.id, "1");
    mkdirSync(part, { recursive: true });
    const generated = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "364",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-g",
        "50",
        "-c:a",
        "aac",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        join(part, "segment-%05d.ts"),
        join(part, "stream.m3u8"),
      ],
      { timeout: 30000 },
    );
    assert.equal(generated.status, 0, generated.stderr.toString());
    const second = join(dir, "recordings", r.id, "2");
    mkdirSync(second, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const name = `segment-${String(i).padStart(5, "0")}.ts`;
      writeFileSync(join(second, name), readFileSync(join(part, name)));
    }
    writeFileSync(
      join(second, "stream.m3u8"),
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n" +
        [0, 1, 2]
          .map((i) => `#EXTINF:2,\nsegment-${String(i).padStart(5, "0")}.ts`)
          .join("\n") +
        "\n#EXT-X-ENDLIST\n",
    );
    const objects = new Map<string, Buffer>();
    let offline = true;
    const server = createServer((req, res) => {
      const data = objects.get(decodeURIComponent(req.url!.slice(1)));
      if (!data) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("Content-Length", data.length);
      res.end(data);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const transport = {
      async upload(file: string, key: string) {
        if (offline) throw Error("offline");
        objects.set(key, readFileSync(file));
      },
      async verify(file: string, key: string) {
        assert.deepEqual(objects.get(key), readFileSync(file));
      },
      async download(key: string) {
        return `http://127.0.0.1:${port}/${encodeURIComponent(key)}`;
      },
      async remove(key: string) {
        objects.delete(key);
      },
      async uploadStream(stream: Readable, key: string) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        objects.set(key, bytes);
        return bytes.length;
      },
    };
    const spool = new SegmentArchive(store, transport, "ffmpeg");
    try {
      await spool.initialize();
      await assert.rejects(spool.sync(r, true));
      assert.ok(existsSync(join(part, "segment-00000.ts")));
      offline = false;
      // New instance uses the durable manifest, not any in-memory queue.
      const recovered = new SegmentArchive(store, transport, "ffmpeg");
      await recovered.initialize();
      await recovered.sync(r, true);
      assert.equal(existsSync(join(part, "segment-00000.ts")), false);
      assert.ok(existsSync(join(part, "segment-00051.ts")));
      assert.equal((await recovered.rows(r)).length, 185);
      // A missing remote input must never be published as a successful complete recording.
      const first = (await recovered.rows(r))[0];
      const backup = objects.get(first.object_key)!;
      objects.delete(first.object_key);
      await assert.rejects(recovered.finalize(r));
      assert.equal(r.hasFile, false);
      objects.set(first.object_key, backup);
      const media = new MediaManager(store, () => {});
      media.segments = recovered;
      await media.initialize();
      const interrupted = (await store.recordings(event.id))[0];
      assert.equal(interrupted.assemblyPending, true);
      assert.equal(interrupted.state, "failed");
      await media.retryArchives();
      Object.assign(r, (await store.recordings(event.id))[0]);
      assert.equal(r.state, "incomplete");
      assert.equal(r.archive?.state, "ready");
      assert.ok(r.archive?.verifiedAt);
      assert.equal(
        existsSync(join(dir, "recordings", r.id, "recording.mp4")),
        false,
      );
      const out = join(dir, "verified.mp4");
      writeFileSync(out, objects.get(r.storageKey!)!);
      const probe = spawnSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        out,
      ]);
      assert.equal(probe.status, 0);
      assert.ok(
        Number(JSON.parse(probe.stdout.toString()).format.duration) > 109,
      );
      assert.equal(
        existsSync(join(dir, "recordings", r.id, "cloud-1.m3u8")),
        false,
      );
      await recovered.remove(r);
      assert.equal((await recovered.rows(r)).length, 0);
      assert.equal(objects.size, 1); // Final MP4 remains after source cleanup.
    } finally {
      await spool.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("disk pressure keeps the live window and explicitly marks lost unuploaded archive parts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-pressure-"));
  const store = await Store.open(dir);
  await store.seed();
  const event = (await store.list("arslive"))[0];
  const r: Recording = {
    id: randomUUID(),
    eventId: event.id,
    companyId: event.companyId,
    state: "recording",
    createdAt: new Date().toISOString(),
    duration: null,
    bytes: null,
    hasFile: false,
    interrupted: false,
  };
  await store.saveRecording(r);
  const part = join(dir, "recordings", r.id, "1");
  mkdirSync(part, { recursive: true });
  const names = Array.from(
    { length: 60 },
    (_, i) => `segment-${String(i).padStart(5, "0")}.ts`,
  );
  for (const name of names) writeFileSync(join(part, name), "synthetic");
  writeFileSync(
    join(part, "stream.m3u8"),
    "#EXTM3U\n" + names.map((name) => `#EXTINF:2,\n${name}`).join("\n"),
  );
  const spool = new SegmentArchive(store, null, "ffmpeg");
  try {
    await spool.initialize();
    assert.equal(await spool.relievePressure(r), true);
    assert.equal(r.interrupted, true);
    const rows = await spool.rows(r);
    assert.equal(rows.filter((s) => s.lost).length, 15);
    assert.equal(existsSync(join(part, names[0])), false);
    assert.equal(existsSync(join(part, names[15])), true);
    assert.equal(existsSync(join(part, names[59])), true);
    assert.equal((await store.recordings(event.id))[0].interrupted, true);
  } finally {
    await spool.close();
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live playlist advances sequence and never advertises evicted history", () => {
  const playlist =
    "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n" +
    Array.from(
      { length: 200 },
      (_, i) => `#EXTINF:2,\nsegment-${String(i).padStart(5, "0")}.ts`,
    ).join("\n");
  const result = liveWindow(playlist);
  assert.ok(result.includes("#EXT-X-MEDIA-SEQUENCE:20"));
  assert.equal(result.includes("segment-00019.ts"), false);
  assert.ok(result.includes("segment-00199.ts"));
  assert.equal(result.includes("PLAYLIST-TYPE:EVENT"), false);
});
