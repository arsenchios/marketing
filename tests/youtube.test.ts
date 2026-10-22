import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../server/store.ts";
import { GoogleAuth } from "../server/auth.ts";
import {
  relayFailureCategory,
  YouTubeAPI,
  YouTubeDelivery,
  validateIngest,
  youtubeErrorMessage,
  youtubeErrorReason,
} from "../server/youtube.ts";
test("YouTube creates an unlisted bound broadcast, encrypts ingest, reuses run and finishes explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-youtube-"));
  const store = await Store.open(dir);
  await store.seed();
  const auth = new GoogleAuth(store, "http://127.0.0.1", {
    clientId: "fake",
    clientSecret: "fake",
    encryptionKey: randomBytes(32).toString("base64"),
    ownerEmail: "owner@example.invalid",
  });
  await auth.initialize();
  const api = new YouTubeAPI(auth);
  const w = (await store.list("arslive"))[0];
  const calls: { path: string; method: string; data: any }[] = [];
  api.request = async (company, path, method = "GET", data: any) => {
    assert.equal(company, w.companyId);
    calls.push({ path, method, data });
    if (path.startsWith("liveBroadcasts?part=snippet")) {
      assert.equal(data.status.privacyStatus, "unlisted");
      assert.equal(data.contentDetails.enableAutoStop, false);
      assert.equal(data.contentDetails.latencyPreference, "low");
      assert.equal(data.contentDetails.recordFromStart, true);
      return { id: "broadcast123" };
    }
    if (path.startsWith("liveStreams?")) {
      assert.equal(data.cdn.resolution, "variable");
      assert.equal(data.cdn.frameRate, "variable");
      return {
        id: "stream123",
        cdn: {
          ingestionInfo: {
            rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com:443/live2",
            streamName: "secret_key",
          },
        },
      };
    }
    if (path.startsWith("liveBroadcasts?part=status"))
      return { items: [{ status: { lifeCycleStatus: "live" } }] };
    return {};
  };
  try {
    await store.db
      .prepare("INSERT INTO youtube_channels VALUES (?,?,?,?,?)")
      .run(
        w.companyId,
        "channel-original",
        "Original channel",
        "fake",
        new Date().toISOString(),
      );
    await auth.cacheChannelProfile(
      w.companyId,
      "https://yt3.ggpht.com/example=s88",
    );
    const p = await api.prepare(w, "run-one");
    assert.equal(p.broadcastId, "broadcast123");
    const row = await store.db
      .prepare("SELECT * FROM youtube_runs WHERE event_id=?")
      .get(w.id);
    assert.ok(!row.url_cipher.includes("secret_key"));
    assert.equal((await api.prepare(w, "run-one")).ingest, p.ingest);
    assert.equal(
      calls.filter((x) => x.path.startsWith("liveStreams?")).length,
      1,
    );
    await store.saveRecording({
      id: "run-one",
      eventId: w.id,
      companyId: w.companyId,
      state: "ready",
      createdAt: new Date().toISOString(),
      duration: 10,
      bytes: 1,
      hasFile: true,
      interrupted: false,
    });
    await store.db
      .prepare(
        "UPDATE youtube_channels SET title=?,channel_id=? WHERE company_id=?",
      )
      .run("Different channel", "different", w.companyId);
    await api.prepare(w, "run-one");
    const archived = (await store.recordings(w.id))[0];
    assert.equal(archived.youtube?.channel?.title, "Original channel");
    assert.equal(archived.youtube?.videoId, "broadcast123");
    assert.ok(!JSON.stringify(archived).includes("secret_key"));
    assert.equal(
      JSON.parse(
        (
          await store.db
            .prepare(
              "SELECT data FROM youtube_broadcast_details WHERE event_id=?",
            )
            .get(w.id)
        ).data,
      ).channel.channel_id,
      "channel-original",
    );
    assert.equal(await api.finish(w.companyId, p.broadcastId), "complete");
    assert.ok(calls.some((x) => x.path.includes("broadcastStatus=complete")));
    const delivery = new YouTubeDelivery(
      { store, diagnostic: () => {} } as any,
      auth,
      () => {},
      true,
    );
    delivery.api = api;
    delivery.active = { event: w, run: "run-one", prepared: p };
    const finish = api.finish.bind(api);
    api.finish = async () => {
      throw new Error("provider unavailable");
    };
    await delivery.finish();
    let saved = (await store.recordings(w.id))[0];
    assert.equal(saved.youtube?.completion, "failed");
    assert.equal(
      saved.hasFile,
      true,
      "YouTube failure cannot remove the cabinet recording",
    );
    assert.ok(delivery.active, "failed completion is retained for retry");
    api.finish = finish;
    await delivery.finish();
    saved = (await store.recordings(w.id))[0];
    assert.equal(saved.youtube?.completion, "complete");
    assert.ok(saved.youtube?.completedAt);
    assert.equal(saved.youtube?.channel?.title, "Original channel");
    assert.equal(delivery.active, null);
  } finally {
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("YouTube flag off performs no provider calls; ingest rejects non-YouTube destinations", async () => {
  for (const address of [
    "http://a.rtmp.youtube.com/live2",
    "rtmps://evil.invalid/live2",
    "rtmps://a.rtmp.youtube.com.evil.invalid/live2",
  ])
    assert.throws(() => validateIngest(address, "key"));
  assert.equal(
    validateIngest("rtmps://a.rtmps.youtube.com:443/live2", "key"),
    "rtmps://a.rtmps.youtube.com:443/live2/key",
  );
  const d = new YouTubeDelivery({} as any, {} as any, () => {}, false);
  d.api.prepare = async () => {
    throw Error("must not call");
  };
  await d.tick();
  assert.equal(d.provider({ delivery: "youtube" } as any), "railway");
});

test(
  "Local HLS relay delivers encoded video to an isolated RTMP receiver; switching to Railway stops it",
  { timeout: 30000 },
  async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { mkdirSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "arslive-relay-"));
    const part = join(dir, "recordings", "run", "1");
    mkdirSync(part, { recursive: true });
    let receiver: any, delivery: any;
    try {
      const generated = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x180:rate=25",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-t",
          "8",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
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
          join(part, "stream.m3u8"),
        ],
        { timeout: 15000, stdio: "ignore" },
      );
      assert.equal(generated.status, 0);
      const target = join(dir, "received.flv");
      receiver = spawn(
        "ffmpeg",
        [
          "-v",
          "error",
          "-listen",
          "1",
          "-i",
          "rtmp://127.0.0.1:19357/live/test",
          "-t",
          "2",
          "-c",
          "copy",
          target,
        ],
        { stdio: "ignore" },
      );
      const done = new Promise<number | null>((resolve) => {
        receiver.once("exit", resolve);
        receiver.once("error", () => resolve(-1));
      });
      await new Promise((r) => setTimeout(r, 500));
      const w = { id: "event", companyId: "company", delivery: "youtube" };
      const r = {
        record: { id: "run", eventId: w.id },
        part: 1,
        ws: {},
        stopping: false,
      };
      const media = {
        current: r,
        ffmpeg: "ffmpeg",
        store: { dir, event: async () => w },
        diagnostic: () => {},
      } as any;
      delivery = new YouTubeDelivery(media, {} as any, () => {}, true);
      delivery.api.prepare = async () => ({
        broadcastId: "video",
        streamId: "stream",
        ingest: "rtmp://127.0.0.1:19357/live/test",
      });
      delivery.api.live = async () => "live";
      delivery.api.receiving = async () => true;
      delivery.api.finish = async () => "complete";
      await delivery.tick();
      assert.ok(delivery.relay);
      assert.equal(await done, 0);
      assert.ok(existsSync(target));
      const probe = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          target,
        ],
        { encoding: "utf8" },
      );
      assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 0);
      w.delivery = "railway";
      await delivery.tick();
      assert.equal(delivery.relay, null);
      assert.equal(delivery.provider(w as any), "railway");
    } finally {
      await delivery?.close();
      receiver?.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("YouTube loss is surfaced after two missing-input polls without automatically switching viewers", async () => {
  const w = { id: "event", companyId: "company", delivery: "youtube" } as any;
  const run = {
    record: { id: "run", eventId: w.id },
    part: 1,
    ws: {},
    stopping: false,
  };
  const media = {
    current: run,
    store: { dir: tmpdir(), event: async () => w },
    diagnostic: () => {},
  } as any;
  const delivery = new YouTubeDelivery(media, {} as any, () => {}, true);
  delivery.active = {
    event: w,
    run: "run",
    prepared: { broadcastId: "video", streamId: "stream", ingest: "unused" },
  };
  delivery.relay = {} as any;
  delivery.part = 1;
  delivery.state = { enabled: true, phase: "live" };
  delivery.api.live = async () => "live";
  delivery.api.receiving = async () => false;
  await delivery.tick();
  assert.equal(delivery.state.phase, "live");
  delivery.lastPoll = 0;
  await delivery.tick();
  assert.equal(delivery.state.phase, "error");
  assert.equal(delivery.provider(w), "youtube");
  delivery.api.receiving = async () => true;
  delivery.lastPoll = 0;
  await delivery.tick();
  assert.equal(delivery.state.phase, "live");
  delivery.relay = null;
});

test("Shared channel credentials are explicitly granted and pinned to a run, while event ownership stays isolated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-shared-"));
  const store = await Store.open(dir);
  await store.seed();
  const auth = new GoogleAuth(store, "http://127.0.0.1", {
    clientId: "test",
    clientSecret: "test",
    encryptionKey: randomBytes(32).toString("base64"),
    ownerEmail: "owner@example.test",
  });
  await auth.initialize();
  try {
    const tenant = await auth.inviteClient("new@example.test", "Client", true);
    assert.equal(await auth.broadcastCompany(tenant.companyId), "arslive");
    const w = await store.create(tenant.companyId, {
      ...(await store.list("arslive"))[0],
      title: "Client broadcast",
    });
    const api = new YouTubeAPI(auth);
    const sources: string[] = [];
    api.request = async (company, path) => {
      sources.push(company);
      if (path.startsWith("liveBroadcasts?part=snippet"))
        return { id: "shared_broadcast" };
      if (path.startsWith("liveStreams?"))
        return {
          id: "shared_stream",
          cdn: {
            ingestionInfo: {
              rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
              streamName: "private_key",
            },
          },
        };
      return {};
    };
    const prepared = await api.prepare(w, "run-shared");
    assert.equal(prepared.sourceCompany, "arslive");
    assert.ok(sources.every((x) => x === "arslive"));
    const persisted = await store.db
      .prepare("SELECT * FROM youtube_runs WHERE event_id=?")
      .get(w.id);
    assert.equal(persisted.company_id, tenant.companyId);
    await auth.grantPlatformChannel(tenant.companyId, false);
    assert.equal(
      await auth.broadcastCompany(tenant.companyId),
      tenant.companyId,
    );
    assert.equal((await api.prepare(w, "run-shared")).sourceCompany, "arslive");
    assert.equal(
      (await api.prepare(w, "run-new")).sourceCompany,
      tenant.companyId,
    );
    await auth.grantPlatformChannel(tenant.companyId, true);
    await store.db
      .prepare("INSERT INTO youtube_channels VALUES (?,?,?,?,?)")
      .run(
        tenant.companyId,
        "own-channel",
        "Own",
        "fake-cipher",
        new Date().toISOString(),
      );
    assert.equal((await auth.broadcastChannel(tenant.companyId)).shared, false);
    assert.equal(
      (await auth.broadcastChannel(tenant.companyId)).channel.title,
      "Own",
    );
  } finally {
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("YouTube errors give actionable safe activation guidance without exposing provider payload", () => {
  const error = {
    response: {
      data: {
        error: {
          errors: [{ reason: "liveStreamingNotEnabled" }],
          message: "sensitive-token",
        },
      },
    },
  };
  assert.match(youtubeErrorMessage(error), /24/);
  assert.ok(!youtubeErrorMessage(error).includes("sensitive-token"));
});

test("Failed YouTube preparation exposes an actionable state, safe diagnostic, and explicit retry", async () => {
  const w = { id: "event", companyId: "company", delivery: "youtube" } as any;
  const diagnostics: string[] = [];
  let changed = 0;
  const media = {
    current: { record: { eventId: w.id, id: "run" }, part: 0 },
    store: { event: async () => w },
    diagnostic: (_id: string, kind: string) => diagnostics.push(kind),
  } as any;
  const delivery = new YouTubeDelivery(
    media,
    {} as any,
    () => {
      changed++;
    },
    true,
  );
  let calls = 0;
  delivery.api.prepare = async () => {
    calls++;
    throw Error("Preparation rejected");
  };
  await delivery.tick();
  assert.equal(delivery.state.phase, "error");
  assert.equal(delivery.state.videoId, undefined);
  assert.equal(changed, 1);
  assert.deepEqual(diagnostics, ["youtube_prepare_failed_unknown"]);
  await delivery.tick();
  assert.equal(calls, 1);
  delivery.retry();
  assert.equal(delivery.state.phase, "waiting");
  await delivery.tick();
  assert.equal(calls, 2);
});

test("Embedding restrictions, API configuration and OAuth errors stay distinct and redact payloads", () => {
  const cases = [
    ["invalidEmbedSetting", /Продвинутые функции/],
    ["forbiddenEmbedSetting", /встраиванию/],
    ["accessNotConfigured", /YouTube Data API/],
    ["invalid_client", /Client ID/],
    ["invalid_grant", /подключить канал заново/],
  ] as const;
  for (const [reason, expected] of cases) {
    const error = {
      response: {
        data: {
          error: {
            errors: [{ reason }],
            message: "secret_token_and_ingest_key",
          },
        },
      },
    };
    assert.equal(youtubeErrorReason(error), reason);
    assert.match(youtubeErrorMessage(error), expected);
    assert.ok(!youtubeErrorMessage(error).includes("secret_token"));
  }
  assert.equal(
    youtubeErrorReason({ response: { data: { error: "invalid_grant" } } }),
    "invalid_grant",
  );
  assert.equal(
    youtubeErrorReason({
      response: { data: { error: { errors: [{ reason: "secret_token" }] } } },
    }),
    "unknown",
  );
});

test("Actual preparation preserves embedding denial and stage without retrying with embedding disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-youtube-embed-"));
  const store = await Store.open(dir);
  try {
    await store.seed();
    const w = (await store.list("arslive"))[0];
    const auth = new GoogleAuth(store, "http://127.0.0.1", {
      clientId: "fake",
      clientSecret: "fake",
      encryptionKey: randomBytes(32).toString("base64"),
      ownerEmail: "owner@example.invalid",
    });
    await auth.initialize();
    const diagnostics: { kind: string; values: unknown }[] = [];
    const delivery = new YouTubeDelivery(
      {
        current: { record: { eventId: w.id, id: "run" }, part: 0 },
        store: { ...store, event: async () => ({ ...w, delivery: "youtube" }) },
        diagnostic: (_id: string, kind: string, values: unknown) =>
          diagnostics.push({ kind, values }),
      } as any,
      auth,
      () => {},
      true,
    );
    let calls = 0;
    delivery.state = { enabled: true, phase: "live", videoId: "previous-broadcast" };
    delivery.api.request = async (_company, path, _method, data: any) => {
      assert.equal(delivery.state.videoId, undefined, "a new run must not expose the previous YouTube video during preparation");
      calls++;
      assert.match(path, /^liveBroadcasts\?part=snippet/);
      assert.equal(data.contentDetails.enableEmbed, true);
      throw {
        response: {
          status: 400,
          data: {
            error: {
              errors: [{ reason: "invalidEmbedSetting" }],
              message: "secret_ingest",
            },
          },
        },
      };
    };
    await delivery.tick();
    assert.equal(calls, 1);
    assert.equal(delivery.state.phase, "error");
    assert.equal(delivery.state.videoId, undefined);
    assert.match(delivery.state.message!, /Продвинутые функции/);
    assert.deepEqual(diagnostics, [
      { kind: "youtube_prepare_failed_invalidEmbedSetting", values: undefined },
      {
        kind: "youtube_failed_at_create_broadcast",
        values: { httpStatus: 400 },
      },
    ]);
    assert.ok(!JSON.stringify(delivery.state).includes("secret_ingest"));
    assert.equal(delivery.status(w.id, "different-run").phase, "waiting");
    assert.equal(delivery.status(w.id, null).phase, "waiting");
  } finally {
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Relay diagnostics classify failures without exposing ingest keys",()=>{
 assert.equal(relayFailureCategory("rtmps://secret.example/private-key: Connection reset by peer"),"network");
 assert.equal(relayFailureCategory("Server returned 403 Forbidden for private-key"),"access");
 assert.equal(relayFailureCategory("Error opening input file /data/private"),"input");
 assert.equal(relayFailureCategory("unrecognized private-key"),"unknown");
});
