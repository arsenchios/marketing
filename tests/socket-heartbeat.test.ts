import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { SocketHeartbeat } from "../server/socketHeartbeat.ts";

test("Room heartbeat removes a lost connection and keeps responsive viewers", () => {
  class Socket extends EventEmitter {
    readyState = 1;
    pings = 0;
    terminated = false;
    ping() {
      this.pings++;
    }
    terminate() {
      this.terminated = true;
    }
  }
  const healthy = new Socket(),
    lost = new Socket();
  const sockets = [healthy, lost] as unknown as WebSocket[];
  const heartbeat = new SocketHeartbeat();
  sockets.forEach((ws) => heartbeat.attach(ws));
  heartbeat.tick(sockets);
  assert.equal(lost.terminated, false);
  healthy.emit("pong");
  heartbeat.tick(sockets);
  assert.equal(lost.terminated, true);
  assert.equal(healthy.terminated, false);
  assert.equal(healthy.pings, 2);
});
