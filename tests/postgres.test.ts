import { GoogleAuth } from "../server/auth.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Database } from "../server/database.ts";
import { Store } from "../server/store.ts";
import { initialEvent } from "../shared/contracts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("PostgreSQL schema stays separate from existing public product tables", async () => {
  const pg = new PGlite();
  const dir = mkdtempSync(join(tmpdir(), "arslive-pg-"));
  await pg.exec(
    "CREATE SCHEMA arslive; CREATE TABLE public.webinars(id text primary key,data text);INSERT INTO public.webinars VALUES('existing','keep');",
  );
  const store = await Store.open(dir, undefined, Database.testing(pg));
  try {
    await store.seed(false);
    const auth = new GoogleAuth(store, "https://example.test", {
      clientId: "",
      clientSecret: "",
      encryptionKey: "",
      ownerEmail: "",
    });
    await auth.initialize();
    const tenant = await auth.inviteClient(
      "pg@example.test",
      "PG Client",
      true,
    );
    assert.equal(await auth.broadcastCompany(tenant.companyId), "arslive");
    assert.equal(
      (
        await pg.query<{ value: string | null }>(
          "SELECT to_regclass('public.youtube_access') AS value",
        )
      ).rows[0].value,
      null,
    );
    for (const table of [
      "analytics_details",
      "analytics_people",
      "viewer_bans",
      "viewer_devices",
      "youtube_channel_profiles",
      "youtube_broadcast_details",
    ]) {
      assert.equal(
        (
          await pg.query<{ value: string | null }>(
            `SELECT to_regclass('public.${table}') AS value`,
          )
        ).rows[0].value,
        null,
      );
      assert.ok(
        (
          await pg.query<{ value: string | null }>(
            `SELECT to_regclass('arslive.${table}') AS value`,
          )
        ).rows[0].value,
      );
    }
    assert.equal((await store.list("arslive")).length, 0);
    const w = await store.create("arslive", initialEvent);
    assert.equal((await store.event(w.id))?.companyId, "arslive");
    await store.update(w.id, { title: "Updated" });
    assert.equal((await store.list("arslive"))[0].title, "Updated");
    const cloned = await store.duplicate((await store.event(w.id))!);
    assert.equal(cloned.state, "draft");
    assert.equal(cloned.companyId, "arslive");
    assert.deepEqual(
      await store.messages(cloned.id, new Date().toISOString(), "cursor"),
      [],
    );
    assert.deepEqual((await pg.query("SELECT * FROM public.webinars")).rows, [
      { id: "existing", data: "keep" },
    ]);
    await store.db
      .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
      .run("host", "arslive", "Host", "owner");
    const sid = await store.newSession("host", null, "Host");
    assert.equal((await store.session(sid))?.role, "owner");
    await store.diagnostic(w.id, "encoder_progress", { fps: 25, speed: 1 });
    assert.equal(
      (
        await pg.query<{ kind: string }>(
          "SELECT kind FROM arslive.diagnostics",
        )
      ).rows[0].kind,
      "encoder_progress",
    );
    await store.analytics(w, sid, "room_entry");
    assert.equal(
      (await store.db.prepare("SELECT COUNT(*) AS n FROM analytics").get()).n,
      1,
    );
  } finally {
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
