import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../server/app.ts";

test("Bad WebSocket payload and failed upgrade do not take down other viewers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-ws-resilience-"));
  const origin = "http://127.0.0.1:4342";
  const app = await createApp(dir, origin);
  await new Promise<void>((r) => app.server.listen(4342, "127.0.0.1", r));
  const sockets: WebSocket[] = [];
  try {
    const event = (await app.store.list("arslive"))[0];
    const session = await app.store.newSession(null, event, "Viewer");
    const connect = () => {
      const ws = new WebSocket(
        origin.replace("http", "ws") + `/ws/room?event=${event.id}&view=1`,
        {
          headers: { origin, cookie: `al_view_${event.slug}=${session}` },
        },
      );
      ws.on("error", () => {});
      sockets.push(ws);
      return ws;
    };
    const healthy = connect();
    await once(healthy, "message");
    const bad = connect();
    await once(bad, "message");
    const closed = once(bad, "close");
    bad.send(Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.equal((await closed)[0], 1009);
    assert.equal(healthy.readyState, WebSocket.OPEN);
    assert.equal((await fetch(origin + "/api/health")).status, 200);

    const original = app.store.event.bind(app.store);
    app.store.event = async () => {
      throw Error("temporary database outage");
    };
    const denied = connect();
    await new Promise<void>((r) => denied.once("close", () => r()));
    app.store.event = original;
    const next = connect();
    await once(next, "message");
    assert.equal(next.readyState, WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
