import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
test("Public host API disables demo login, seeds no events and protects integration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-public-")),
    origin = "http://127.0.0.1:4314";
  const a = await createApp(dir, origin, {
    publicMode: true,
    google: {
      clientId: "test",
      clientSecret: "test",
      ownerEmail: "owner@example.test",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    },
  });
  await new Promise<void>((r) => a.server.listen(4314, "127.0.0.1", r));
  try {
    assert.equal((await a.store.list("arslive")).length, 0);
    const req = (path: string, method = "GET") =>
      fetch(origin + path, { method, headers: { origin }, redirect: "manual" });
    assert.equal((await req("/api/auth/local", "POST")).status, 404);
    assert.equal((await req("/api/events")).status, 401);
    assert.equal((await req("/api/integrations/youtube")).status, 401);
    assert.equal((await req("/api/clients/invite", "POST")).status, 403);
    const start = await req("/api/auth/google/start");
    assert.equal(start.status, 302);
    assert.match(start.headers.get("set-cookie")!, /Secure/);
    assert.match(start.headers.get("location")!, /code_challenge=/);
    const callback = await req(
      "/api/auth/google/callback?state=forged&code=forged",
    );
    assert.equal(callback.headers.get("location"), "/?auth_error=1");
    assert.doesNotMatch(callback.headers.get("set-cookie") || "", /al_host=/);
  } finally {
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
