import { request as httpRequest } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
import { WebSocket } from "ws";

test("Local API: access, tenant boundaries, idempotency and media lifecycle", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-api-"));
  const origin = "http://127.0.0.1:4313";
  const a = await createApp(dir, origin);
  await new Promise<void>((r) => a.server.listen(4313, "127.0.0.1", r));
  let host = "";
  let viewer = "";
  const w = (await a.store.list("arslive"))[0];
  await a.store.db
    .prepare("INSERT INTO companies VALUES (?,?)")
    .run("other", "Other");
  await a.store.db
    .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
    .run("other-owner", "other", "Other", "owner");
  const other = await a.store.create("other", {
    ...initialEvent,
    title: "Other tenant private title",
  });
  const otherCookie =
    "al_host=" + (await a.store.newSession("other-owner", null, "Other"));
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = host,
    customOrigin = origin,
  ) {
    return fetch(origin + path, {
      method,
      headers: {
        origin: customOrigin,
        cookie,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    await t.test(
      "Private API requires authentication and rejects wrong Origin",
      async () => {
        assert.equal((await request("/api/events")).status, 401);
        assert.equal(
          (
            await request(
              "/api/auth/local",
              "POST",
              {},
              "",
              "https://evil.invalid",
            )
          ).status,
          403,
        );
        const r = await request("/api/auth/local", "POST", {});
        host = r.headers.get("set-cookie")!.split(";")[0];
        assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
        assert.match(r.headers.get("set-cookie")!, /SameSite=Strict/i);
        assert.equal((await request("/api/events")).status, 200);
      },
    );
    await t.test(
      "Company helpers control shared materials without broadcast rights and can be revoked",
      async () => {
        const invited = await request("/api/team", "POST", {
          email: "helper@example.test",
          name: "Helper",
        });
        assert.equal(invited.status, 201);
        const { id: member } = (await invited.json()) as any;
        const helper =
          "al_host=" + (await a.store.newSession(member, null, "Helper"));
        assert.equal(
          (
            await request(
              `/api/events/${w.id}/permissions`,
              "GET",
              undefined,
              helper,
            )
          ).status,
          200,
        );
        assert.deepEqual(
          await (
            await request(
              `/api/events/${w.id}/permissions`,
              "GET",
              undefined,
              helper,
            )
          ).json(),
          { broadcast: false, control: true },
        );
        assert.equal(
          (
            await request(
              `/api/events/${w.id}/stage`,
              "PATCH",
              { slide: 2 },
              helper,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              `/api/events/${other.id}/stage`,
              "PATCH",
              { slide: 2 },
              helper,
            )
          ).status,
          403,
        );
        assert.equal(
          (await request(`/api/events/${w.id}/start`, "POST", {}, helper))
            .status,
          403,
        );
        assert.equal(
          (await request(`/api/events/${w.id}/stop`, "POST", {}, helper))
            .status,
          403,
        );
        assert.equal(
          (
            await request(
              "/api/team",
              "POST",
              { email: "bad@example.test", name: "Bad" },
              helper,
            )
          ).status,
          403,
        );
        await Promise.all([
          request(`/api/events/${w.id}/stage`, "PATCH", {slide: 2}, helper),
          request(`/api/events/${w.id}/stage`, "PATCH", {layout: "camera"}),
        ]);
        const shared = await a.store.event(w.id);
        assert.equal(shared!.slide, 2); assert.equal(shared!.layout, "camera");
        await a.store.update(w.id, {layout: "slides"});
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.create();
        pdf.addPage();
        await a.store.update(w.id, { state: "live" });
        const form = new FormData();
        form.append("kind", "pdf");
        form.append(
          "file",
          new Blob([(await pdf.save()) as any], { type: "application/pdf" }),
          "helper.pdf",
        );
        const upload = await fetch(origin + `/api/events/${w.id}/assets`, {
          method: "POST",
          headers: { origin, cookie: helper },
          body: form,
        });
        assert.equal(upload.status, 200);
        assert.equal((await a.store.event(w.id))!.slide, 1);
        await a.store.update(w.id, { state: "draft" });
        assert.equal(
          (await request(`/api/team/${member}`, "DELETE", {}, otherCookie))
            .status,
          404,
        );
        assert.equal(
          (await request(`/api/team/${member}`, "DELETE", {})).status,
          200,
        );
        assert.equal(
          (await request(`/api/events/${w.id}`, "GET", undefined, helper))
            .status,
          401,
        );
      },
    );
    await t.test(
      "Concurrent large uploads are rejected before buffering; an aborted upload releases the slot",
      async () => {
        const endpoint = `/api/events/${w.id}/assets`;
        const before = (await a.store.event(w.id))!.pdfId;
        const pending = httpRequest(origin + endpoint, {
          method: "POST",
          headers: {
            origin,
            cookie: host,
            "content-type": "multipart/form-data; boundary=large-deck",
            "content-length": "1000000",
          },
        });
        pending.on("error", () => {});
        pending.write(
          '--large-deck\r\nContent-Disposition: form-data; name="kind"\r\n\r\npdf\r\n--large-deck\r\nContent-Disposition: form-data; name="file"; filename="partial.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-',
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal((await request(endpoint, "POST", {})).status, 429);
        } finally {
          pending.destroy();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        const body = new FormData();
        body.append("kind", "pdf");
        body.append("file", new Blob(["broken"]), "bad.pdf");
        const response = await fetch(origin + endpoint, {
          method: "POST",
          headers: { origin, cookie: host },
          body,
        });
        assert.equal(response.status, 400);
        assert.equal((await a.store.event(w.id))!.pdfId, before);
      },
    );
    await t.test(
      "Webinar deletion is confirmed, tenant-scoped and revokes public access without deleting archives",
      async () => {
        const item = await a.store.create("arslive", initialEvent);
        assert.equal(
          (
            await request(
              `/api/events/${item.id}`,
              "DELETE",
              { confirm: true },
              otherCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (await request(`/api/events/${item.id}`, "DELETE", {})).status,
          400,
        );
        await a.store.update(item.id, { state: "live" });
        assert.equal(
          (await request(`/api/events/${item.id}`, "DELETE", { confirm: true }))
            .status,
          409,
        );
        await a.store.update(item.id, { state: "ended" });
        const record = {
          id: randomUUID(),
          eventId: item.id,
          companyId: item.companyId,
          state: "ready" as const,
          createdAt: new Date().toISOString(),
          duration: 1,
          bytes: 10,
          hasFile: true,
          interrupted: false,
          archive: { state: "uploading" as const },
        };
        await a.store.saveRecording(record);
        assert.equal(
          (await request(`/api/events/${item.id}`, "DELETE", { confirm: true }))
            .status,
          409,
        );
        await a.store.saveRecording({ ...record, archive: { state: "ready" } });
        const sid = await a.store.newSession(null, item, "Test viewer");
        const ws = new WebSocket(
          `ws://127.0.0.1:4313/ws/room?event=${item.id}&view=1`,
          { headers: { origin, cookie: `al_view_${item.slug}=${sid}` } },
        );
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        const closed = new Promise<number>((resolve) =>
          ws.once("close", resolve),
        );
        assert.equal(
          (await request(`/api/events/${item.id}`, "DELETE", { confirm: true }))
            .status,
          200,
        );
        assert.equal(await closed, 4003);
        assert.ok((await a.store.event(item.id))!.deletedAt);
        assert.ok(
          !(await a.store.list("arslive")).some((w) => w.id === item.id),
        );
        assert.equal(
          (await request(`/api/room/${item.slug}/info`)).status,
          404,
        );
        assert.equal(
          (
            await request(`/api/room/${item.slug}/join`, "POST", {
              name: "Test",
            })
          ).status,
          404,
        );
        assert.equal(
          (await request(`/api/events/${item.id}/recordings/${record.id}`))
            .status,
          404,
        );
        assert.equal((await a.store.recordings(item.id)).length, 1);
        const clientItem = await a.store.create("other", initialEvent);
        assert.equal(
          (
            await request(
              `/api/admin/webinars/${clientItem.id}`,
              "DELETE",
              { confirm: true },
              otherCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(`/api/admin/webinars/${clientItem.id}`, "DELETE", {
              confirm: true,
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "Concurrent start and delete cannot both succeed",
      async () => {
        const item = await a.store.create("arslive", initialEvent);
        const [deleted, started] = await Promise.all([
          request(`/api/events/${item.id}`, "DELETE", { confirm: true }),
          request(`/api/events/${item.id}/start`, "POST", {
            tabId: randomUUID(),
            commandId: randomUUID(),
            mode: "broadcast",
          }),
        ]);
        assert.ok(!(deleted.ok && started.ok));
        if (started.ok) {
          const run = await started.json();
          await request(`/api/events/${item.id}/stop`, "POST", {
            runId: run.runId,
          });
        } else assert.equal(deleted.status, 200);
      },
    );
    await t.test(
      "Public chat uses the webinar presenter name, including historical messages, never the Google profile",
      async () => {
        const session = await a.store.session(host.split("=")[1]);
        assert.ok(session);
        const event = await a.store.create("arslive", {
          ...initialEvent,
          hostName: "Имя для вебинара",
        });
        const messageId = randomUUID();
        const message = await a.store.message(
          event,
          { ...session, name: "Private Google Name" },
          messageId,
          "Test",
        );
        assert.equal(message.name, "Имя для вебинара");
        await a.store.db
          .prepare("UPDATE messages SET data=? WHERE id=?")
          .run(
            JSON.stringify({ ...message, name: "Legacy Google Name" }),
            messageId,
          );
        const snapshot = await (
          await request(`/api/events/${event.id}`)
        ).json();
        assert.equal(snapshot.messages[0].name, "Имя для вебинара");
        const history = await (
          await request(`/api/events/${event.id}/chat`)
        ).json();
        assert.equal(history[0].name, "Имя для вебинара");
        const blank = await a.store.update(event.id, { hostName: "" });
        const posted = await a.store.message(
          blank,
          { ...session, name: "Private Google Name" },
          randomUUID(),
          "Again",
        );
        assert.equal(posted.name, "Ведущий");
      },
    );
    await t.test(
      "Live offer and private templates are scoped, validated and copied",
      async () => {
        const item = await a.store.create("other", {
          ...initialEvent,
          title: "Client controls",
        });
        const path = `/api/events/${item.id}`;
        const templates = [
          {
            id: "private",
            title: "Questions",
            text: "Private draft before sending",
          },
        ];
        const offer = {
          ctaTitle: "Join",
          ctaDescription: "Details",
          ctaUrl: "https://example.com/offer",
        };
        assert.equal(
          (await request(path + "/offer", "PATCH", offer)).status,
          403,
        );
        assert.equal(
          (await request(path + "/chat-templates", "PATCH", { templates }))
            .status,
          403,
        );
        assert.equal(
          (await request(path + "/diagnostics", "GET", undefined, otherCookie))
            .status,
          403,
        );
        assert.equal(
          (await request(`/api/admin/webinars/${item.id}/diagnostics`)).status,
          200,
        );
        const readiness = await (
          await request(path + "/readiness", "GET", undefined, otherCookie)
        ).json();
        assert.equal("freeBytes" in readiness, false);
        assert.equal(
          (
            await request(
              path + "/connection-check",
              "POST",
              { payload: "x".repeat(262144) },
              otherCookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              path + "/connection-check",
              "POST",
              { payload: "x".repeat(262145) },
              otherCookie,
            )
          ).status,
          400,
        );
        await a.store.update(item.id, { state: "live" });
        assert.equal(
          (await request(path + "/offer", "PATCH", offer, otherCookie)).status,
          200,
        );
        assert.equal(
          (
            await request(
              path + "/offer",
              "PATCH",
              { ...offer, ctaUrl: "javascript:alert(1)" },
              otherCookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              path + "/offer",
              "PATCH",
              { ...offer, companyId: "arslive" },
              otherCookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              path + "/chat-templates",
              "PATCH",
              { templates },
              otherCookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              path + "/chat-templates",
              "PATCH",
              { templates: [...templates, ...templates] },
              otherCookie,
            )
          ).status,
          400,
        );
        const room = await request(
          `/api/room/${item.slug}/join`,
          "POST",
          { name: "Guest" },
          "",
        );
        const guest = room.headers.get("set-cookie")!.split(";")[0];
        const snapshot = await (
          await request(`/api/room/${item.slug}`, "GET", undefined, guest)
        ).json();
        assert.equal(snapshot.event.chatTemplates, undefined);
        assert.equal(snapshot.event.ctaTitle, "Join");
        assert.equal(
          (await request(path + "/offer", "PATCH", offer, guest)).status,
          401,
        );
        const ws = new WebSocket(
          origin.replace("http", "ws") + `/ws/room?event=${item.id}&view=1`,
          { headers: { origin, cookie: guest } },
        );
        try {
          const live = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("snapshot timeout")),
              5000,
            );
            ws.once("message", (raw) => {
              clearTimeout(timeout);
              resolve(JSON.parse(raw.toString()));
            });
            ws.once("error", reject);
          });
          assert.equal(live.event.chatTemplates, undefined);
        } finally {
          ws.close();
        }
        await a.store.update(item.id, { state: "ended" });
        assert.equal(
          (await request(path + "/offer", "PATCH", offer, otherCookie)).status,
          409,
        );
        assert.equal(
          (
            await request(
              path + "/chat-templates",
              "PATCH",
              { templates },
              otherCookie,
            )
          ).status,
          409,
        );
        const copy = await (
          await request(path + "/duplicate", "POST", {}, otherCookie)
        ).json();
        assert.deepEqual(copy.chatTemplates, templates);
      },
    );
    await t.test(
      "Completed webinar is immutable; duplication copies assets, not history or recordings",
      async () => {
        const original = await a.store.create("arslive", {
          ...initialEvent,
          title: "Archived webinar",
        });
        mkdirSync(join(dir, "assets"), { recursive: true });
        const assetId = randomUUID();
        const filename = `${assetId}.png`;
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        writeFileSync(join(dir, "assets", filename), bytes);
        await a.store.db
          .prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?)")
          .run(
            assetId,
            original.id,
            "arslive",
            "cover",
            filename,
            "image/png",
            bytes.length,
          );
        await a.store.message(
          original,
          (await a.store.session(host.slice("al_host=".length)))!,
          randomUUID(),
          "Old chat",
        );
        await a.store.update(original.id, {
          state: "ended",
          coverId: assetId,
          slide: 4,
          ctaVisible: true,
        });
        for (const [suffix, method, body] of [
          ["", "PATCH", { ...initialEvent, title: "Overwrite" }],
          ["/stage", "PATCH", { slide: 2 }],
          [
            "/start",
            "POST",
            { mode: "broadcast", tabId: randomUUID(), commandId: randomUUID() },
          ],
          ["/chat", "POST", { id: randomUUID(), text: "Late message" }],
          ["/preflight", "POST", {}],
          ["/delivery", "POST", { provider: "railway" }],
        ] as const)
          assert.equal(
            (await request(`/api/events/${original.id}${suffix}`, method, body))
              .status,
            409,
          );
        assert.equal(
          (
            await request(
              `/api/events/${original.id}/duplicate`,
              "POST",
              {},
              otherCookie,
            )
          ).status,
          403,
        );
        const response = await request(
          `/api/events/${original.id}/duplicate`,
          "POST",
          {},
        );
        assert.equal(response.status, 201);
        const copy = await response.json();
        assert.equal(copy.state, "draft");
        assert.notEqual(copy.slug, original.slug);
        assert.equal(copy.startsAt, "");
        assert.equal(copy.slide, 1);
        assert.equal(copy.ctaVisible, false);
        assert.deepEqual(copy.annotations, {});
        assert.notEqual(copy.coverId, assetId);
        assert.deepEqual(await a.store.messages(copy.id), []);
        assert.deepEqual(await a.store.recordings(copy.id), []);
        const asset = await request(
          `/api/events/${copy.id}/assets/${copy.coverId}`,
        );
        assert.equal(asset.status, 200);
        assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
        assert.equal(
          (await request(`/api/events/${copy.id}/assets/${assetId}`)).status,
          404,
        );
        assert.equal((await a.store.messages(original.id)).length, 1);
        const missing = await a.store.create("arslive", initialEvent);
        await a.store.update(missing.id, { pdfId: randomUUID() });
        const count = (await a.store.list("arslive")).length;
        await assert.rejects(
          a.store.duplicate((await a.store.event(missing.id))!),
        );
        assert.equal((await a.store.list("arslive")).length, count);
      },
    );
    await t.test(
      "Archive chat pagination retains messages sharing the cursor timestamp",
      async () => {
        const archive = await a.store.create("arslive", initialEvent);
        const at = new Date().toISOString();
        for (let n = 0; n < 85; n++) {
          const id = randomUUID();
          const data = {
            id,
            at,
            name: "Test",
            text: `Message ${n}`,
            role: "viewer",
            attendeeId: null,
            deleted: false,
          };
          await a.store.db
            .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)")
            .run(
              id,
              archive.id,
              archive.companyId,
              "test",
              at,
              JSON.stringify(data),
            );
        }
        const first = await a.store.messages(archive.id);
        const next = await (
          await request(
            `/api/events/${archive.id}/chat?before=${encodeURIComponent(first[0].at)}&beforeId=${first[0].id}`,
          )
        ).json();
        assert.equal(first.length, 80);
        assert.equal(next.length, 5);
        assert.equal(new Set([...first, ...next].map((m) => m.id)).size, 85);
      },
    );
    await t.test(
      "Platform observation is explicit and grants spectator access only",
      async () => {
        assert.equal(
          (await request("/api/admin/webinars", "GET", undefined, otherCookie))
            .status,
          403,
        );
        assert.equal(
          (
            await request(
              `/api/admin/webinars/${w.id}/observe`,
              "POST",
              {},
              otherCookie,
            )
          ).status,
          403,
        );
        const list = await (await request("/api/admin/webinars")).json();
        assert.ok(list.webinars.some((row: any) => row.id === other.id));
        assert.ok(!JSON.stringify(list).includes("token"));
        const r = await request(
          `/api/admin/webinars/${other.id}/observe`,
          "POST",
          {},
        );
        assert.equal(r.status, 200);
        const spectator = r.headers.get("set-cookie")!.split(";")[0];
        const cookies = host + "; " + spectator;
        assert.equal(
          (await request(`/api/room/${other.slug}`, "GET", undefined, cookies))
            .status,
          200,
        );
        assert.equal(
          (await request(`/api/room/${w.slug}`, "GET", undefined, spectator))
            .status,
          401,
        );
        assert.equal(
          (await request(`/api/events/${other.id}`, "GET", undefined, cookies))
            .status,
          403,
        );
        for (const action of ["start", "stop", "delivery"]) {
          assert.equal(
            (
              await request(
                `/api/events/${other.id}/${action}`,
                "POST",
                {},
                cookies,
              )
            ).status,
            403,
          );
        }
        assert.equal(
          (
            await request(
              `/api/events/${other.id}/stage`,
              "PATCH",
              { slide: 2 },
              cookies,
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "Explicit event-scoped assistance permits room controls, never sender takeover",
      async () => {
        const help = await a.store.create("other", {
          ...initialEvent,
          title: "Client draft to preserve",
        });
        assert.equal((await request(`/api/events/${help.id}`)).status, 403);
        assert.equal(
          (
            await request(
              `/api/admin/webinars/${help.id}/assist`,
              "POST",
              {},
              otherCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (await request(`/api/admin/webinars/${help.id}/assist`, "POST", {}))
            .status,
          200,
        );
        const room = await (await request(`/api/events/${help.id}`)).json();
        assert.equal(room.event.title, "Client draft to preserve");
        assert.equal(room.event.state, "draft");
        assert.equal(
          (
            await request(`/api/events/${help.id}/stage`, "PATCH", {
              slide: 2,
              layout: "camera",
            })
          ).status,
          200,
        );
        assert.equal((await a.store.event(help.id))!.slide, 2);
        assert.equal(
          (
            await request(`/api/events/${help.id}/delivery`, "POST", {
              provider: "railway",
            })
          ).status,
          200,
        );
        const chat = await (
          await request(`/api/events/${help.id}/chat`, "POST", {
            id: randomUUID(),
            text: "Помогаю ведущему",
          })
        ).json();
        assert.equal(chat.role, "moderator");
        assert.equal(chat.name, "Модератор");
        for (const action of [
          "start",
          "stop",
          "preflight",
          "connection-check",
        ]) {
          assert.equal(
            (
              await request(`/api/events/${help.id}/${action}`, "POST", {
                runId: randomUUID(),
              })
            ).status,
            403,
            action,
          );
        }
        assert.equal(
          (await request(`/api/events/${other.id}`)).status,
          403,
          "grant must not spread to other webinars",
        );
        const ws = new WebSocket(
          origin.replace("http", "ws") + `/ws/room?event=${help.id}`,
          { headers: { origin, cookie: host } },
        );
        const snapshot = await new Promise<any>((resolve, reject) => {
          ws.once("message", (b) => resolve(JSON.parse(String(b))));
          ws.once("error", reject);
        });
        assert.equal(snapshot.event.slide, 2);
        ws.close();
        const denied = new WebSocket(
          origin.replace("http", "ws") + `/ws/media?event=${help.id}`,
          { headers: { origin, cookie: host } },
        );
        await new Promise<void>((resolve, reject) => {
          denied.once("error", () => resolve());
          denied.once("open", () => {
            denied.close();
            reject(Error("support must not capture"));
          });
        });
        const list = await (await request("/api/admin/webinars")).json();
        assert.equal(
          list.webinars.find((w: any) => w.id === help.id).slug,
          help.slug,
        );
      },
    );
    await t.test(
      "Only the platform owner can grant its channel, without granting tenant data or tokens",
      async () => {
        assert.equal(
          (await request("/api/clients", "GET", undefined, otherCookie)).status,
          403,
        );
        assert.equal(
          (
            await request(
              "/api/clients/other/channel",
              "PATCH",
              { allowed: true },
              otherCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/api/clients/other/channel", "PATCH", {
              allowed: true,
            })
          ).status,
          200,
        );
        const info = await (
          await request(
            "/api/integrations/youtube",
            "GET",
            undefined,
            otherCookie,
          )
        ).json();
        assert.equal(info.shared, true);
        assert.equal(info.ownChannel, false);
        assert.equal(
          (await request(`/api/events/${w.id}`, "GET", undefined, otherCookie))
            .status,
          403,
        );
        assert.equal(
          (
            await request("/api/clients/arslive/channel", "PATCH", {
              allowed: true,
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request("/api/clients/other/channel", "PATCH", {
              allowed: false,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await (
              await request(
                "/api/integrations/youtube",
                "GET",
                undefined,
                otherCookie,
              )
            ).json()
          ).shared,
          false,
        );
      },
    );
    await t.test(
      "Diagnostics are tenant scoped and reject arbitrary text",
      async () => {
        assert.equal(
          (await request(`/api/events/${other.id}/diagnostics`)).status,
          403,
        );
        assert.equal(
          (
            await request(`/api/events/${w.id}/diagnostics`, "POST", {
              kind: "sender_closed",
              values: { code: 1006 },
            })
          ).status,
          200,
        );
        const r = await (
          await request(`/api/events/${w.id}/diagnostics`)
        ).json();
        assert.equal(r.entries[0].kind, "sender_closed");
        assert.equal(
          (
            await request(`/api/events/${w.id}/diagnostics`, "POST", {
              kind: "secret-value",
              values: {},
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "Expired files are blocked before physical cleanup",
      async () => {
        const id = randomUUID();
        await a.store.saveRecording({
          id,
          eventId: w.id,
          companyId: w.companyId,
          state: "ready",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          hasFile: true,
          interrupted: false,
          duration: 2,
          bytes: 100,
        });
        for (const suffix of [id, id + "/download"])
          assert.equal(
            (await request(`/api/events/${w.id}/recordings/${suffix}`)).status,
            410,
          );
        assert.equal(
          (
            await request(
              `/api/events/${w.id}/recordings/${id}/archive`,
              "POST",
              {},
            )
          ).status,
          410,
        );
        assert.equal(
          (await request(`/api/events/${w.id}/media/${id}/1/stream.m3u8`))
            .status,
          404,
        );
        await a.store.db.prepare("DELETE FROM recordings WHERE id=?").run(id);
      },
    );
    await t.test(
      "Company A cannot read/update/start company B or forge companyId",
      async () => {
        for (const [path, method, body] of [
          [`/api/events/${other.id}`, "GET", undefined],
          [
            `/api/events/${other.id}`,
            "PATCH",
            { ...initialEvent, companyId: "arslive" },
          ],
          [
            `/api/events/${other.id}/start`,
            "POST",
            { tabId: randomUUID(), commandId: randomUUID(), mode: "broadcast" },
          ],
        ] as const)
          assert.equal((await request(path, method, body)).status, 403);
        assert.equal(
          (await request(`/api/events/${w.id}`, "GET", undefined, otherCookie))
            .status,
          403,
        );
        const list = await (await request("/api/events")).json();
        assert.equal(
          list.events.some((e: any) => e.id === other.id),
          false,
        );
      },
    );
    await t.test(
      "Viewer session is scoped to a single event and cannot host",
      async () => {
        const r = await request(
          `/api/room/${w.slug}/join`,
          "POST",
          { name: "Synthetic viewer" },
          "",
        );
        viewer = r.headers.get("set-cookie")!.split(";")[0];
        assert.equal(
          (await request(`/api/room/${w.slug}`, "GET", undefined, viewer))
            .status,
          200,
        );
        assert.equal(
          (await request(`/api/room/${other.slug}`, "GET", undefined, viewer))
            .status,
          401,
        );
        assert.equal(
          (
            await request(
              `/api/events/${w.id}/start`,
              "POST",
              {
                tabId: randomUUID(),
                commandId: randomUUID(),
                mode: "broadcast",
              },
              viewer,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "Preflight and camera geometry are host-only and create no broadcast",
      async () => {
        assert.equal(
          (await request(`/api/events/${w.id}/preflight`, "POST", {}, viewer))
            .status,
          401,
        );
        assert.equal(
          (await request(`/api/events/${other.id}/readiness`)).status,
          403,
        );
        assert.equal(
          (
            await request(`/api/events/${w.id}/stage`, "PATCH", {
              cameraBox: { x: 0.9, y: 0.9, width: 0.5 },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(`/api/events/${w.id}/stage`, "PATCH", {
              cameraBox: { x: 0.1, y: 0.2, width: 0.3 },
            })
          ).status,
          200,
        );
        assert.equal(
          (await request(`/api/events/${w.id}/stage`, "PATCH", { slide: 400 }))
            .status,
          200,
        );
        assert.equal(
          (await request(`/api/events/${w.id}/stage`, "PATCH", { slide: 401 }))
            .status,
          400,
        );
        assert.equal((await a.store.event(w.id))!.slide, 400);
        assert.equal(
          (await request(`/api/events/${w.id}/stage`, "PATCH", { slide: 1 }))
            .status,
          200,
        );
        assert.deepEqual((await a.store.event(w.id))!.cameraBox, {
          x: 0.1,
          y: 0.2,
          width: 0.3,
        });
        assert.equal((await a.store.recordings(w.id)).length, 0);
        assert.equal((await a.media.status(w.id)).runId, null);
        assert.equal(
          (
            await request(
              `/api/events/${other.id}/recordings/${randomUUID()}/download`,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              `/api/events/${w.id}/recordings/${randomUUID()}/archive`,
              "POST",
              {},
              viewer,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "Retry of chat and telemetry is idempotent; text is not HTML",
      async () => {
        const id = randomUUID();
        const msg = { id, text: "<img src=x onerror=alert(1)>" };
        for (let n = 0; n < 2; n++)
          assert.equal(
            (await request(`/api/room/${w.slug}/chat`, "POST", msg, viewer))
              .status,
            200,
          );
        assert.equal((await a.store.messages(w.id)).length, 1);
        assert.equal((await a.store.messages(w.id))[0].text, msg.text);
        const eventId = randomUUID();
        for (let n = 0; n < 2; n++)
          await request(
            `/api/room/${w.slug}/analytics`,
            "POST",
            { id: eventId, kind: "play" },
            viewer,
          );
        assert.equal(
          (
            (await a.store.db
              .prepare("SELECT COUNT(*) AS n FROM analytics WHERE id=?")
              .get(eventId)) as any
          ).n,
          1,
        );
      },
    );
    await t.test(
      "Chat quarantine, cooldown, approval and persistent room ban are tenant scoped",
      async () => {
        const item = await a.store.create("arslive", {
          ...initialEvent,
          title: "Moderation test",
        });
        const joined = await request(
          `/api/room/${item.slug}/join`,
          "POST",
          { name: "Test viewer" },
          "",
        );
        assert.equal(joined.status, 200);
        const cookies = joined.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        const identity = joined.headers
          .getSetCookie()
          .find((c) => c.startsWith("al_identity="))!
          .split(";")[0];
        const path = `/api/events/${item.id}`;
        assert.equal(
          (
            await request(path + "/chat-rules", "PATCH", {
              words: ["spamword"],
            })
          ).status,
          200,
        );
        const posts = [
          { id: randomUUID(), text: "хуй" },
          { id: randomUUID(), text: "блять" },
        ];
        const responses = await Promise.all(
          posts.map((m) =>
            request(`/api/room/${item.slug}/chat`, "POST", m, cookies),
          ),
        );
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
        const accepted = responses.findIndex((r) => r.status === 200);
        const result = await responses[accepted].json();
        assert.equal(result.held, true);
        assert.equal(result.text, "Сообщение заблокировано");
        assert.equal(
          (
            await request(
              `/api/room/${item.slug}/chat`,
              "POST",
              posts[accepted],
              cookies,
            )
          ).status,
          200,
        );
        const hostView = await (await request(path)).json();
        assert.equal(hostView.messages[0].text, posts[accepted].text);
        const viewerView = await (
          await request(`/api/room/${item.slug}`, "GET", undefined, cookies)
        ).json();
        assert.equal(viewerView.messages[0].text, "Сообщение заблокировано");
        assert.equal(viewerView.event.chatBlockedWords, undefined);
        assert.equal(viewerView.attendees, undefined);
        const history = await (
          await request(
            `/api/room/${item.slug}/chat`,
            "GET",
            undefined,
            cookies,
          )
        ).json();
        assert.equal(history[0].text, "Сообщение заблокировано");
        const approve = path + `/chat/${result.id}/approve`;
        assert.equal(
          (await request(approve, "POST", {}, otherCookie)).status,
          403,
        );
        assert.equal((await request(approve, "POST", {}, cookies)).status, 401);
        assert.equal((await request(approve, "POST")).status, 200);
        const approved = await (
          await request(`/api/room/${item.slug}`, "GET", undefined, cookies)
        ).json();
        assert.equal(approved.messages[0].text, posts[accepted].text);
        const race = await Promise.all([
          request(approve, "POST"),
          request(path + `/chat/${result.id}`, "DELETE"),
        ]);
        assert.ok(race.every((r) => r.status === 200));
        assert.equal((await request(approve, "POST")).status, 409);
        assert.equal(
          (await a.store.messages(item.id))[0].text,
          "Сообщение удалено",
        );
        const ws = new WebSocket(
          `ws://127.0.0.1:4313/ws/room?event=${item.id}&view=1`,
          { headers: { Cookie: cookies, Origin: origin } },
        );
        await new Promise<void>((resolve, reject) => {
          ws.once("message", () => resolve());
          ws.once("error", reject);
        });
        const closed = new Promise<number>((resolve) =>
          ws.once("close", (code) => resolve(code)),
        );
        assert.equal(
          (
            await request(
              path + "/block",
              "POST",
              { attendeeId: result.attendeeId },
              otherCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(path + "/block", "POST", {
              attendeeId: result.attendeeId,
            })
          ).status,
          200,
        );
        assert.equal(await closed, 4003);
        assert.equal(
          (await request(`/api/room/${item.slug}`, "GET", undefined, cookies))
            .status,
          403,
        );
        assert.equal(
          (
            await request(
              `/api/room/${item.slug}/join`,
              "POST",
              { name: "New name" },
              cookies,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await request(
              `/api/room/${item.slug}/join`,
              "POST",
              { name: "New name" },
              identity,
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "Composite FK forbids cross-company asset associations",
      async () => {
        await assert.rejects(
          async () =>
            await a.store.db
              .prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?)")
              .run(
                randomUUID(),
                other.id,
                "arslive",
                "pdf",
                "x.pdf",
                "application/pdf",
                10,
              ),
          /FOREIGN KEY/,
        );
      },
    );
    await t.test("Unauthorized WebSocket handshake is rejected", async () => {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:4313/ws/room?event=${other.id}`,
          { headers: { origin, cookie: host } },
        );
        ws.on("open", () => reject(new Error("Cross tenant socket opened")));
        ws.on("error", () => resolve());
      });
    });
    await t.test(
      "Only one sender can start; stop releases singleton; no fake ready recording",
      async () => {
        const body = {
          tabId: randomUUID(),
          commandId: randomUUID(),
          mode: "broadcast",
        };
        const r = await request(`/api/events/${w.id}/start`, "POST", body);
        assert.equal(r.status, 200);
        const run = (await r.json()).runId;
        const blockedEvent = await a.store.create("arslive", { ...initialEvent, title: "Waiting for previous studio" });
        const blocked = await request(`/api/events/${blockedEvent.id}/preflight`, "POST", {});
        assert.equal(blocked.status, 409);
        const conflict = await blocked.json();
        assert.match(conflict.error, /Закрытие вкладки не завершает эфир/);
        assert.equal(conflict.recoveryUrl, `/studio/${w.id}`);
        assert.equal(a.media.current?.record.id, run, "Preflight must never stop the existing broadcast");
        const privateConflict = await request(`/api/events/${other.id}/preflight`, "POST", {}, otherCookie);
        assert.equal(privateConflict.status, 409);
        assert.equal((await privateConflict.json()).recoveryUrl, undefined, "Another tenant must not discover the active event");
        const retry = await (
          await request(`/api/events/${w.id}/start`, "POST", body)
        ).json();
        assert.equal(retry.runId, run);
        assert.equal(
          (
            await request(`/api/events/${w.id}/start`, "POST", {
              ...body,
              tabId: randomUUID(),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await request(
              `/api/events/${other.id}/start`,
              "POST",
              { ...body, tabId: randomUUID() },
              otherCookie,
            )
          ).status,
          409,
        );
        // A host returning in a new tab after a real media part retains the run.
        a.media.current!.part = 1;
        a.media.current!.disconnectedAt = Date.now() - 65000;
        const returningTab = randomUUID();
        const resumed = await request(`/api/events/${w.id}/start`, "POST", {
          tabId: returningTab,
          commandId: randomUUID(),
          mode: "broadcast",
        });
        assert.equal(resumed.status, 200);
        assert.equal((await resumed.json()).runId, run);
        assert.equal(a.media.current!.tabId, returningTab);
        const competing = await request(`/api/events/${w.id}/start`, "POST", {
          tabId: randomUUID(),
          commandId: randomUUID(),
          mode: "broadcast",
        });
        assert.equal(
          competing.status,
          409,
          "New ownership is reserved before another tab can join",
        );
        const originalFinalize = a.media.finalizeRecord.bind(a.media);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let finalizations = 0;
        a.media.finalizeRecord = async (...args) => {
          finalizations++;
          await gate;
          await originalFinalize(...args);
        };
        try {
          const accepted = await request(`/api/events/${w.id}/stop`, "POST", {
            runId: run,
          });
          assert.equal(accepted.status, 202);
          assert.equal((await accepted.json()).state, "stopping");
          assert.equal((await a.store.recordings(w.id))[0].state, "processing");
          assert.equal(
            (
              await request(`/api/events/${w.id}/reopen`, "POST", {
                runId: run,
                confirm: true,
              })
            ).status,
            409,
            "restoring cannot interrupt recording assembly",
          );
          assert.ok(
            a.media.current?.stopping,
            "stop accepts before a slow archive completes",
          );
          const saving = await request(`/api/events/${blockedEvent.id}/preflight`, "POST", {});
          assert.equal(saving.status, 409);
          assert.match((await saving.json()).error, /Сохраняется запись предыдущего эфира/);
          assert.equal(
            (await request(`/api/events/${w.id}/stop`, "POST", { runId: run }))
              .status,
            202,
          );
          assert.equal(
            finalizations,
            1,
            "duplicate stop cannot start a second assembly",
          );
          const finished = a.media.stop(w.id, false, run);
          release();
          await finished;
          assert.equal(a.media.current, null);
          assert.equal((await a.store.recordings(w.id))[0].state, "failed");
          assert.equal((await a.store.recordings(w.id))[0].hasFile, false);
          assert.equal(
            (await request(`/api/events/${w.id}/stop`, "POST", { runId: run }))
              .status,
            202,
          );
        } finally {
          release();
          a.media.finalizeRecord = originalFinalize;
        }
        const lateStart = await request(
          `/api/events/${w.id}/start`,
          "POST",
          body,
        );
        assert.equal(lateStart.status, 409);
        assert.equal(a.media.current, null);
        const next = await (
          await request(`/api/events/${w.id}/start`, "POST", {
            ...body,
            commandId: randomUUID(),
          })
        ).json();
        assert.notEqual(next.runId, run);
        await request(`/api/events/${w.id}/stop`, "POST", { runId: run });
        assert.equal((await a.media.status(w.id)).runId, next.runId);
        await request(`/api/events/${w.id}/stop`, "POST", {
          runId: next.runId,
        });
        await a.media.stop(w.id, false, next.runId);
        assert.equal(a.media.current, null);
      },
    );
    await t.test(
      "Reopen retains link and archives, rejects stale commands, tenant access and live reset",
      async () => {
        const e = await a.store.create("other", {
          ...initialEvent,
          title: "Reopen",
          startsAt: new Date(Date.now() + 7200000).toISOString(),
        });
        const runId = randomUUID();
        const record = {
          id: runId,
          eventId: e.id,
          companyId: "other",
          state: "ready" as const,
          createdAt: new Date(Date.now() - 60000).toISOString(),
          stoppedAt: new Date().toISOString(),
          duration: 10,
          bytes: 100,
          hasFile: true,
          interrupted: false,
        };
        await a.store.saveRecording(record);
        await a.store.update(e.id, { state: "ended", ctaVisible: true });
        const path = `/api/events/${e.id}/reopen`;
        assert.equal(
          (await request(path, "POST", { runId, confirm: true })).status,
          403,
        );
        assert.equal(
          (await request(path, "POST", { runId, confirm: true }, viewer))
            .status,
          401,
        );
        assert.equal(
          (
            await request(
              path,
              "POST",
              { runId: randomUUID(), confirm: true },
              otherCookie,
            )
          ).status,
          409,
        );
        const result = await request(
          path,
          "POST",
          { runId, confirm: true },
          otherCookie,
        );
        assert.equal(result.status, 200);
        const restored = (await result.json()).event;
        assert.equal(restored.slug, e.slug);
        assert.equal(restored.state, "draft");
        assert.equal(restored.ctaVisible, false);
        assert.equal(restored.startsAt, e.startsAt);
        assert.deepEqual((await a.store.recordings(e.id))[0], record);
        const duplicate = await request(
          path,
          "POST",
          { runId, confirm: true },
          otherCookie,
        );
        assert.equal(
          (await duplicate.json()).event.reopenedAt,
          restored.reopenedAt,
        );
        const start = {
          commandId: randomUUID(),
          tabId: randomUUID(),
          mode: "broadcast",
          expectedReopenedAt: restored.reopenedAt,
        };
        assert.equal(
          (
            await request(
              `/api/events/${e.id}/start`,
              "POST",
              { ...start, expectedReopenedAt: null, earlyStartConfirmed: true },
              otherCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await request(
              `/api/events/${e.id}/start`,
              "POST",
              start,
              otherCookie,
            )
          ).status,
          409,
          "early launch requires confirmation",
        );
        const started = await request(
          `/api/events/${e.id}/start`,
          "POST",
          { ...start, earlyStartConfirmed: true },
          otherCookie,
        );
        assert.equal(started.status, 200);
        const next = (await started.json()).runId;
        assert.notEqual(next, runId);
        assert.equal((await a.store.recordings(e.id)).length, 2);
        assert.equal(
          (await request(path, "POST", { runId, confirm: true }, otherCookie))
            .status,
          409,
        );
        await request(
          `/api/events/${e.id}/stop`,
          "POST",
          { runId },
          otherCookie,
        );
        assert.equal(
          a.media.current?.record.id,
          next,
          "late stop never stops new generation",
        );
        await a.media.stop(e.id, false, next);
        await request(`/api/admin/webinars/${e.id}/assist`, "POST", {});
        const [adminReset, hostReset] = await Promise.all([
          request(path, "POST", { runId: next, confirm: true }),
          request(path, "POST", { runId: next, confirm: true }, otherCookie),
        ]);
        assert.equal(adminReset.status, 200);
        assert.equal(hostReset.status, 200);
        const adminResult = (await adminReset.json()).event;
        assert.equal(
          (await hostReset.json()).event.reopenedAt,
          adminResult.reopenedAt,
        );
        assert.equal(
          (await request(path, "POST", { runId, confirm: true })).status,
          409,
        );
        assert.equal((await a.store.event(e.id))?.slug, e.slug);
      },
    );
    await t.test(
      "Per-transmission statistics isolate time windows and require event access",
      async () => {
        const e = await a.store.create("other", {
          ...initialEvent,
          title: "Runs statistics",
        });
        const sid = await a.store.newSession(null, e, "Viewer");
        const now = Date.now();
        const records = [240000, 120000].map((ago) => ({
          id: randomUUID(),
          eventId: e.id,
          companyId: "other",
          state: "ready" as const,
          createdAt: new Date(now - ago).toISOString(),
          stoppedAt: new Date(now - ago + 60000).toISOString(),
          duration: 60,
          bytes: 1,
          hasFile: false,
          interrupted: false,
        }));
        for (const r of records) {
          await a.store.saveRecording(r);
          const id = randomUUID();
          await a.store.analytics(e, sid, "cta_click", id);
          await a.store.db
            .prepare("UPDATE analytics SET at=? WHERE id=?")
            .run(new Date(Date.parse(r.createdAt) + 10000).toISOString(), id);
        }
        const route = `/api/statistics?event=${e.id}`;
        const total = await (
          await request(route, "GET", undefined, otherCookie)
        ).json();
        assert.equal(total.people[0].clicks, 2);
        const single = await (
          await request(
            `${route}&run=${records[1].id}`,
            "GET",
            undefined,
            otherCookie,
          )
        ).json();
        assert.equal(single.people[0].clicks, 1);
        assert.equal(single.selectedRunId, records[1].id);
        assert.equal(single.events[0].startedAt, records[1].createdAt);
        assert.equal(single.runs.length, 2);
        assert.equal(
          (await request(`${route}&run=${records[0].id}`)).status,
          403,
        );
        await request(`/api/admin/webinars/${e.id}/assist`, "POST", {});
        assert.equal(
          (await request(`${route}&run=${records[0].id}`)).status,
          200,
        );
        assert.equal(
          (
            await request(
              `${route}&run=${randomUUID()}`,
              "GET",
              undefined,
              otherCookie,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "Blocked participant immediately loses HTTP and socket access",
      async () => {
        const room = await (
          await request(`/api/room/${w.slug}`, "GET", undefined, viewer)
        ).json();
        const attendeeId = room.messages[0].attendeeId;
        assert.equal(
          (await request(`/api/events/${w.id}/block`, "POST", { attendeeId }))
            .status,
          200,
        );
        assert.equal(
          (await request(`/api/room/${w.slug}`, "GET", undefined, viewer))
            .status,
          403,
        );
      },
    );
    await t.test(
      "Logout invalidates the host session and missing YouTube connection gives an actionable response",
      async () => {
        const tempCookie =
          "al_host=" + (await a.store.newSession("other-owner", null, "Other"));
        assert.equal(
          (
            await request(
              "/api/integrations/youtube/check",
              "POST",
              {},
              tempCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (await request("/api/auth/logout", "POST", {}, tempCookie)).status,
          200,
        );
        assert.equal(
          (await request("/api/events", "GET", undefined, tempCookie)).status,
          401,
        );
      },
    );
  } finally {
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
