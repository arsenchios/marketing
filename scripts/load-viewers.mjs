// Opt-in bounded test: real authenticated HLS downloads + room sockets, no media saved.
import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
const allowedOrigin = process.env.LOAD_TEST_ORIGIN;
if (!allowedOrigin) throw Error("Set LOAD_TEST_ORIGIN to the explicit test server origin");
const room = new URL(process.argv[2] || "http://invalid");
if (
  room.origin !== allowedOrigin ||
  (room.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(room.hostname)) ||
  !/^\/room\/[a-z0-9-]+$/.test(room.pathname)
)
  throw Error("Explicit ArsLive room URL required");
const slug = room.pathname.split("/").pop();
const count = Math.min(50, Math.max(1, Number(process.argv[3] || 50)));
const holdMs =
  Math.min(180, Math.max(30, Number(process.argv[4] || 180))) * 1000;
if (!Number.isInteger(count) || !Number.isFinite(holdMs))
  throw Error("Viewer count must be an integer and duration must be finite");
const startedAt = new Date().toISOString();
const started = performance.now();
const clients = [];
const errors = {};
const latencies = [];
let bytes = 0,
  manifests = 0,
  segments = 0,
  stopping = false,
  reason = "",
  steadyAt = null,
  peakSockets = 0;
const controller = new AbortController();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stop(why) {
  if (!stopping) {
    reason = why;
    stopping = true;
    controller.abort();
    for (const c of clients) c.ws?.close();
  }
}
function error(kind) {
  errors[kind] = (errors[kind] || 0) + 1;
  if (Object.values(errors).reduce((a, b) => a + b, 0) > 50)
    stop("error_budget");
}
function safeURL(path) {
  const u = new URL(path, room);
  if (u.origin !== room.origin || !u.pathname.startsWith("/api/"))
    throw Error("Unexpected media URL");
  return u;
}
async function get(path, cookie, json = false) {
  const time = performance.now();
  const res = await fetch(safeURL(path), {
    headers: { cookie },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    redirect: "error",
  });
  if (!res.ok) throw Error("http_" + res.status);
  const body = await res.arrayBuffer();
  bytes += body.byteLength;
  if (bytes > 8e9) stop("byte_budget");
  if (json) return JSON.parse(new TextDecoder().decode(body));
  return { body, ms: performance.now() - time };
}
async function watch(c) {
  while (!stopping) {
    try {
      if (c.playlist) {
        const r = await get(c.playlist, c.cookie);
        manifests++;
        const lines = new TextDecoder()
          .decode(r.body)
          .split("\n")
          .filter((s) => s && !s.startsWith("#"));
        const paths = lines.map((s) => new URL(s, safeURL(c.playlist)).href);
        const batch = paths.slice(-3);
        c.initial = true;
        for (const path of batch) {
          if (c.seen.has(path)) continue;
          const data = await get(path, c.cookie);
          c.seen.add(path);
          c.lastSegment = performance.now();
          c.segments++;
          segments++;
          latencies.push(data.ms);
        }
        if (performance.now() - c.lastSegment > 15000) {
          c.stalls++;
          c.lastSegment = performance.now();
        }
      }
    } catch (e) {
      if (!stopping)
        error(e.message.startsWith("http_") ? e.message : "request_failed");
    }
    await sleep(2000);
  }
}
async function join(i) {
  const res = await fetch(room.origin + `/api/room/${slug}/join`, {
    method: "POST",
    headers: { origin: room.origin, "content-type": "application/json" },
    body: JSON.stringify({
      name: `Нагрузочный тест ${String(i + 1).padStart(2, "0")}`,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw Error("join_http_" + res.status);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  if (!cookie) throw Error("viewer_cookie_missing");
  const snapshot = await get(`/api/room/${slug}`, cookie, true);
  if (
    snapshot.media.provider !== "railway" ||
    !snapshot.media.runId ||
    !snapshot.media.playlist
  )
    throw Error("room_not_live_on_railway");
  const c = {
    cookie,
    seen: new Set(),
    initial: false,
    segments: 0,
    stalls: 0,
    lastSegment: performance.now(),
    playlist: snapshot.media.playlist,
  };
  clients.push(c);
  c.ws = new WebSocket(
    `wss://${room.host}/ws/room?event=${snapshot.event.id}&view=1`,
    { headers: { cookie, origin: room.origin } },
  );
  c.ws.on("open", () => {
    peakSockets = Math.max(
      peakSockets,
      clients.filter((x) => x.ws?.readyState === 1).length,
    );
  });
  c.ws.on("error", () => {
    if (!stopping) error("socket_error");
  });
  c.ws.on("close", () => {
    if (!stopping) error("socket_closed");
  });
  c.ws.on("message", (raw) => {
    try {
      const d = JSON.parse(raw);
      if (d.type !== "snapshot") return;
      if (!d.media.runId || d.event.state === "stopping") {
        stop("presenter_ended");
        return;
      }
      if (d.media.provider !== "railway") {
        stop("provider_changed");
        return;
      }
      c.playlist = d.media.playlist || c.playlist;
    } catch {
      error("invalid_snapshot");
    }
  });
  c.task = watch(c);
}
const deadline = setTimeout(
  () => stop("time_budget"),
  count * 2500 + holdMs + 30000,
);
const progress = setInterval(
  () =>
    console.log(
      JSON.stringify({
        elapsedSeconds: Math.round((performance.now() - started) / 1000),
        clients: clients.length,
        sockets: clients.filter((c) => c.ws?.readyState === 1).length,
        segments,
        GB: Number((bytes / 1e9).toFixed(3)),
        errors,
      }),
    ),
  30000,
);
process.once("SIGINT", () => stop("interrupted"));
try {
  for (let i = 0; i < count && !stopping; i++) {
    await join(i);
    if (i < count - 1) await sleep(2500);
  }
  if (!stopping) {
    steadyAt = new Date().toISOString();
    console.log(
      JSON.stringify({
        phase: "steady",
        clients: clients.length,
        at: steadyAt,
      }),
    );
    await sleep(holdMs);
    stop("completed");
  }
} catch (e) {
  stop(e.message);
} finally {
  clearTimeout(deadline);
  clearInterval(progress);
  stopping = true;
  controller.abort();
  for (const c of clients) c.ws?.terminate();
  await Promise.allSettled(clients.map((c) => c.task));
  latencies.sort((a, b) => a - b);
  const percentile = (p) =>
    Math.round(
      latencies[
        Math.min(latencies.length - 1, Math.floor(latencies.length * p))
      ] || 0,
    );
  const report = {
    startedAt,
    steadyAt,
    endedAt: new Date().toISOString(),
    requestedViewers: count,
    connectedViewers: clients.length,
    peakSockets,
    reason,
    elapsedSeconds: Math.round((performance.now() - started) / 1000),
    bytes,
    manifests,
    segments,
    segmentLatencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: percentile(1),
    },
    stalls: clients.reduce((s, c) => s + c.stalls, 0),
    minSegmentsPerViewer: Math.min(...clients.map((c) => c.segments)),
    errors,
    scope:
      "HTTP HLS consumers + room WebSockets, not 50 independently decoded browser players",
  };
  mkdirSync("test-results/load", { recursive: true });
  writeFileSync(
    "test-results/load/railway-50.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (reason !== "completed" || Object.keys(errors).length || report.stalls)
    process.exitCode = 1;
}
