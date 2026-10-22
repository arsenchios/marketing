import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createApp } from "../server/app.ts";
import { SpeakerIce } from "../server/speakerIce.ts";

test("Two-speaker signaling is tenant scoped, bounded, revocable and cannot replace a sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "speaker-test-")),
    origin = "http://127.0.0.1:4331";
  let credentialsIssued = 0;
  const master = "local-test-master";
  const speakerIce = new SpeakerIce({ CLOUDFLARE_TURN_KEY_ID: "test-key", CLOUDFLARE_TURN_API_TOKEN: master },
    (async () => {
      credentialsIssued++;
      return Response.json({ iceServers: [{ urls: "turns:turn.cloudflare.com:443?transport=tcp", username: "temporary", credential: "short-lived" }] });
    }) as typeof fetch);
  const a = await createApp(dir, origin, { speakerIce });
  await new Promise<void>((r) => a.server.listen(4331, "127.0.0.1", r));
  const sockets: WebSocket[] = [];
  try {
    const event = (await a.store.list("arslive"))[0];
    const sessions: Record<string, string> = {};
    for (const [id, company, role] of [
      ["p", "arslive", "host"],
      ["g", "arslive", "host"],
      ["m", "arslive", "moderator"],
      ["o", "other", "host"],
    ]) {
      if (company === "other")
        await a.store.db
          .prepare("INSERT INTO companies VALUES (?,?)")
          .run("other", "Other");
      await a.store.db
        .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
        .run(id, company, id, role);
      sessions[id] = await a.store.newSession(id, null, id);
    }
    const connect = (id: string, role: string) => {
      const ws = new WebSocket(
        `${origin.replace("http", "ws")}/ws/speakers?event=${event.id}&role=${role}&tab=${randomUUID()}`,
        { headers: { origin, cookie: `al_host=${sessions[id]}` } },
      );
      const messages: any[] = [];
      ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      ws.on("error", () => {});
      sockets.push(ws);
      return { ws, messages };
    };
    const configUrl = `${origin}/api/events/${event.id}/speakers`;
    assert.equal((await fetch(configUrl)).status, 403);
    for (const id of ["m", "o"]) {
      assert.ok([403, 404].includes((await fetch(configUrl, { headers: { cookie: `al_host=${sessions[id]}` } })).status));
    }
    assert.equal(credentialsIssued, 0, "Denied callers must not mint billable TURN credentials");
    const config = await fetch(configUrl, { headers: { cookie: `al_host=${sessions.p}` } });
    assert.equal(config.status, 200);
    assert.equal(config.headers.get("cache-control"), "no-store");
    const issued = await config.json();
    assert.equal(issued.relayConfigured, true);
    assert.equal(JSON.stringify(issued).includes(master), false);
    assert.equal(credentialsIssued, 1);
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("timeout");
    };
    for (const id of ["m", "o"]) {
      const c = connect(id, "guest");
      await until(() => c.ws.readyState === WebSocket.CLOSED);
      assert.equal(c.messages.length, 0);
    }
    const p = connect("p", "primary");
    await until(() => p.messages.length > 0);
    const g = connect("g", "guest");
    await until(() => g.messages.some((m) => m.type === "paired"));
    const pair = g.messages.find((m) => m.type === "paired").pair;
    assert.equal(p.messages.at(-1).pair, pair);
    const duplicate = connect("g", "guest");
    let close = 0;
    duplicate.ws.on("close", (c) => (close = c));
    await until(() => close !== 0);
    assert.equal(close, 4009);
    p.ws.send(
      JSON.stringify({
        type: "description",
        pair,
        description: { type: "offer", sdp: "test-offer" },
      }),
    );
    await until(() => g.messages.some((m) => m.type === "description"));
    assert.equal(g.messages.at(-1).description.sdp, "test-offer");
    p.ws.send(JSON.stringify({ type: "candidate", pair, candidate: {
      candidate: "candidate:test", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null,
    } }));
    await until(() => g.messages.some((m) => m.type === "candidate"));
    assert.equal(g.messages.at(-1).candidate.usernameFragment, null,
      "Nullable ICE fields from browsers must not close signaling");
    const values = { host: 2, public: 0, relay: 0, received: 3, iceError: 701, relayConfigured: 0 };
    g.ws.send(JSON.stringify({ type: "network-summary", pair, values }));
    g.ws.send(JSON.stringify({ type: "route", pair, relay: true }));
    await until(() => p.ws.readyState === WebSocket.OPEN && g.ws.readyState === WebSocket.OPEN);
    // A following message is ordered behind diagnostic persistence dispatch.
    g.ws.send(JSON.stringify({ type: "unavailable", pair }));
    await until(() => p.messages.some((m) => m.type === "unavailable"));
    await until(() => g.messages.some((m) => m.type === "unavailable"));
    const summaries = await a.store.db.prepare("SELECT data FROM diagnostics WHERE event_id=? AND kind=?")
      .all(event.id, "speaker_guest_network");
    // Persistence runs asynchronously after forwarding; wait separately below.
    for (let i = 0; summaries.length === 0 && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      summaries.push(...await a.store.db.prepare("SELECT data FROM diagnostics WHERE event_id=? AND kind=?")
        .all(event.id, "speaker_guest_network"));
    }
    assert.deepEqual(JSON.parse(summaries[0].data), values);
    const routes = await a.store.db.prepare("SELECT data FROM diagnostics WHERE event_id=? AND kind=?")
      .all(event.id, "speaker_guest_route");
    for (let i = 0; routes.length === 0 && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      routes.push(...await a.store.db.prepare("SELECT data FROM diagnostics WHERE event_id=? AND kind=?")
        .all(event.id, "speaker_guest_route"));
    }
    assert.deepEqual(JSON.parse(routes[0].data), { relay: 1 });
    assert.equal(p.messages.some((m) => m.type === "network-summary"), false);
    const pairedBefore = p.messages.filter((m) => m.type === "paired").length;
    p.ws.send(JSON.stringify({ type: "restart", pair }));
    // A valid ordered diagnostic gives the server queue time to consume the stale restart.
    p.ws.send(JSON.stringify({ type: "diagnostic", pair, stage: "ice", state: "failed" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.messages.filter((m) => m.type === "paired").length, pairedBefore,
      "An exhausted connection must not be restarted by the other peer's stale watchdog");
    // Guest must not acquire the media sender by calling the start endpoint.
    const start = await fetch(origin + `/api/events/${event.id}/start`, {
      method: "POST",
      headers: {
        origin,
        cookie: `al_host=${sessions.g}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tabId: randomUUID(),
        commandId: randomUUID(),
        mode: "broadcast",
      }),
    });
    assert.equal(start.status, 409);
    assert.equal(a.media.current, null);
    await a.store.db
      .prepare("UPDATE sessions SET blocked=1 WHERE id=?")
      .run(sessions.g);
    g.ws.send(
      JSON.stringify({
        type: "candidate",
        pair,
        candidate: { candidate: "candidate:test" },
      }),
    );
    await until(() => g.ws.readyState === WebSocket.CLOSED);
    await until(() => p.messages.at(-1).type === "waiting");
    assert.equal(
      p.messages.some((m) => m.type === "candidate"),
      false,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
