import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaManager } from "../server/media.ts";

test("Busy same-owner sender is retryable without replacing it; other owners remain denied", async () => {
  const manager = Object.create(MediaManager.prototype) as MediaManager;
  const existing = { readyState: 2 };
  manager.current = {
    record: { id: "run", eventId: "event" },
    tabId: "tab",
    owner: "session",
    stopping: false,
    ws: existing,
  } as any;
  manager.diagnostic = () => {};
  const codes: number[] = [];
  const socket = { close: (code: number) => codes.push(code) } as any;
  await manager.attach("run", "tab", { id: "session" } as any, socket);
  assert.deepEqual(codes, [4009]);
  assert.equal(manager.current!.ws, existing);
  await manager.attach("run", "other-tab", { id: "session" } as any, socket);
  await manager.attach("run", "tab", { id: "other-session" } as any, socket);
  await manager.attach("old-run", "tab", { id: "session" } as any, socket);
  assert.deepEqual(codes, [4009, 4003, 4003, 4003]);
});
