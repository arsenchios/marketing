import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.ts";
test("Cabinet downloads remain available; viewer replay and old live segments are forbidden", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-download-"));
  const origin = "http://127.0.0.1:4315";
  const keys: string[] = [];
  const a = await createApp(dir, origin, {
    archiveTransport: {
      async upload() {},
      async remove() {},
      async download(key) {
        keys.push(key);
        return "https://archive.invalid/signed";
      },
    },
  });
  await new Promise<void>((r) => a.server.listen(4315, "127.0.0.1", r));
  try {
    const w = (await a.store.list("arslive"))[0];
    const id = randomUUID();
    await a.store.saveRecording({
      id,
      eventId: w.id,
      companyId: w.companyId,
      state: "ready",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      duration: 1,
      bytes: 9,
      hasFile: true,
      interrupted: false,
      localRemovedAt: new Date().toISOString(),
      storageKey: "Company/2026-10-14_named_record.mp4",
      archive: { state: "ready" },
    });
    const login = await fetch(origin + "/api/auth/local", {
      method: "POST",
      headers: { origin },
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const suffix of ["", "/download"]) {
      const url = origin + `/api/events/${w.id}/recordings/${id}` + suffix;
      assert.equal((await fetch(url, { redirect: "manual" })).status, 401);
      const r = await fetch(url, { headers: { cookie }, redirect: "manual" });
      assert.equal(r.status, 303);
      assert.equal(r.headers.get("location"), "https://archive.invalid/signed");
    }
    assert.deepEqual(keys, [
      "Company/2026-10-14_named_record.mp4",
      "Company/2026-10-14_named_record.mp4",
    ]);
    const joined = await fetch(origin + `/api/room/${w.slug}/join`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Viewer" }),
    });
    const viewerCookie = joined.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    for (const state of ["stopping", "ended"] as const) {
      await a.store.update(w.id, {
        state,
        ctaUrl: "https://example.org/offer",
        ctaVisible: false,
      });
      for (const suffix of ["", "/download"]) {
        assert.equal(
          (
            await fetch(
              origin + `/api/events/${w.id}/recordings/${id}${suffix}`,
              { headers: { cookie: viewerCookie }, redirect: "manual" },
            )
          ).status,
          401,
        );
      }
      for (const file of ["stream.m3u8", "segment-000.ts"]) {
        assert.equal(
          (
            await fetch(origin + `/api/events/${w.id}/media/${id}/1/${file}`, {
              headers: { cookie: viewerCookie },
            })
          ).status,
          403,
        );
      }
      const snapshot = await (
        await fetch(origin + `/api/room/${w.slug}`, {
          headers: { cookie: viewerCookie },
        })
      ).json();
      assert.deepEqual(snapshot.recordings, []);
      assert.equal(snapshot.media.playlist, null);
      assert.equal(snapshot.media.youtube, undefined);
      const info = await (
        await fetch(origin + `/api/room/${w.slug}/info`)
      ).json();
      assert.equal(info.ctaUrl, "https://example.org/offer");
      assert.equal(
        (
          await fetch(
            origin + `/api/events/${w.id}/recordings/${id}/download`,
            { headers: { cookie }, redirect: "manual" },
          )
        ).status,
        303,
      );
    }
    await a.store.update(w.id, { state: "draft" });
    const disabled = await fetch(origin + `/api/events/${w.id}/delivery`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "youtube" }),
    });
    assert.equal(disabled.status, 409);
  } finally {
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
