import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
test("Guest invitations: anonymous scoped roles, staged decks, revocation and no privilege escalation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invites-")),
    origin = "http://127.0.0.1:4333";
  const a = await createApp(dir, origin);
  await new Promise<void>((r) => a.server.listen(4333, "127.0.0.1", r));
  const sockets: WebSocket[] = [];
  try {
    const owner =
      "al_host=" + (await a.store.newSession("local-owner", null, "Owner"));
    const w = (await a.store.list("arslive"))[0],
      other = await a.store.create("arslive", {
        ...initialEvent,
        title: "Private event",
      });
    const req = (
      path: string,
      method = "GET",
      body?: unknown,
      cookie = owner,
      guest = false,
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          "content-type": "application/json",
          ...(guest ? { "X-Webinar-Guest": "1" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const invite = await (
      await req(`/api/events/${w.id}/invitations`, "POST", { role: "speaker" })
    ).json();
    assert.ok(invite.url.includes("#"));
    assert.equal(
      (
        await req(`/api/events/${w.id}/invitations`, "POST", {
          role: "speaker",
        })
      ).status,
      409,
    );
    const entry = await req(
      `/api/events/${w.id}/invitation-entry`,
      "POST",
      { token: invite.token, name: "Спикер" },
      "",
    );
    assert.equal(entry.status, 200);
    const guest = entry.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/invitation-entry`,
          "POST",
          { token: invite.token, name: "Чужой" },
          "",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/invitation-entry`,
          "POST",
          { token: invite.token, name: "Спикер" },
          guest,
        )
      ).status,
      200,
    );
    const perms = await (
      await req(
        `/api/events/${w.id}/permissions`,
        "GET",
        undefined,
        guest,
        true,
      )
    ).json();
    assert.equal(perms.broadcast, false);
    assert.equal(perms.guestRole, "speaker");
    for (const path of [
      `/api/events/${other.id}`,
      `/api/events/${w.id}/invitations`,
      `/api/events/${w.id}/recordings/${randomUUID()}`,
      `/api/events/${w.id}/recordings/${randomUUID()}/download`,
      "/api/events",
      "/api/team",
    ])
      assert.ok(
        [401, 403].includes(
          (await req(path, "GET", undefined, guest, true)).status,
        ),
        path,
      );
    for (const suffix of [
      "/start",
      "/stop",
      "/reopen",
      "/duplicate",
      "/delivery",
    ])
      assert.equal(
        (await req(`/api/events/${w.id}${suffix}`, "POST", {}, guest, true))
          .status,
        403,
        suffix,
      );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}`,
          "PATCH",
          { title: "Changed" },
          guest,
          true,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/stage`,
          "PATCH",
          { slide: 2 },
          guest,
          true,
        )
      ).status,
      200,
    );
    const msg = await (
      await req(
        `/api/events/${w.id}/chat`,
        "POST",
        { id: randomUUID(), text: "Привет" },
        guest,
        true,
      )
    ).json();
    assert.equal(msg.role, "speaker");
    assert.equal(msg.name, "Спикер");
    const viewerCookie = `al_view_${w.slug}=` +
      await a.store.newSession(null, w, "Тестовый зритель");
    const guestCall = new WebSocket(
      origin.replace("http", "ws") +
        `/ws/speakers?event=${w.id}&guest=1&role=guest&tab=${randomUUID()}`,
      { headers: { origin, cookie: guest } },
    );
    sockets.push(guestCall);
    await new Promise<void>((resolve, reject) => {
      guestCall.once("error", reject);
      guestCall.once("message", (raw) => {
        assert.equal(JSON.parse(String(raw)).type, "waiting");
        resolve();
      });
    });
    const viewerRoom = () => req(`/api/room/${w.slug}`, "GET", undefined, viewerCookie)
      .then((r) => r.json());
    assert.equal((await viewerRoom()).speakerName, "Спикер");
    assert.equal((await (await req(`/api/room/${other.slug}`, "GET", undefined, viewerCookie)).json()).speakerName, undefined);
    assert.equal((await req(`/api/events/${w.id}/invitations/${invite.id}`, "PATCH", {controls:false})).status,200);
    assert.equal((await req(`/api/events/${w.id}/stage`, "PATCH", {slide:2},guest)).status,403);
    assert.equal((await (await req(`/api/events/${w.id}/permissions`, "GET",undefined,guest)).json()).control,false);
    assert.equal((await req(`/api/events/${w.id}/invitations/${invite.id}`, "PATCH", {controls:true})).status,200);
    const pen={color:"#ffffff",width:4,points:[[1,1],[2,2]]};
    const drawings=await Promise.all([req(`/api/events/${w.id}/annotations`,"POST",{slide:1,stroke:pen},guest),req(`/api/events/${w.id}/annotations`,"POST",{slide:1,stroke:{...pen,color:"#ff0000"}})]);
    assert.ok(drawings.every(r=>r.status===200));
    assert.equal((await a.store.event(w.id))?.annotations["1"].length,2);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const form = new FormData();
    form.append("kind", "pdf");
    form.append("activate", "false");
    form.append(
      "file",
      new Blob([bytes as BlobPart], { type: "application/pdf" }),
      "Guest deck.pdf",
    );
    const upload = await fetch(`${origin}/api/events/${w.id}/assets`, {
      method: "POST",
      headers: { origin, cookie: guest, "X-Webinar-Guest": "1" },
      body: form,
    });
    assert.equal(upload.status, 200);
    const deck = await upload.json();
    assert.equal((await a.store.event(w.id))?.pdfId, null);
    assert.equal(
      (
        await req(
          `/api/events/${other.id}/decks/${deck.id}/show`,
          "POST",
          {},
          guest,
          true,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/decks/${deck.id}/show`,
          "POST",
          {},
          guest,
          true,
        )
      ).status,
      200,
    );
    assert.equal((await a.store.event(w.id))?.pdfId, deck.id);
    const assistantInvite = await (
      await req(`/api/events/${w.id}/invitations`, "POST", {
        role: "assistant",
      })
    ).json();
    const assistantEntry = await req(
      `/api/events/${w.id}/invitation-entry`,
      "POST",
      { token: assistantInvite.token, name: "Помощник" },
      "",
    );
    const assistant = assistantEntry.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/speakers`,
          "GET",
          undefined,
          assistant,
          true,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/chat`,
          "POST",
          { id: randomUUID(), text: "Здравствуйте" },
          assistant,
          true,
        )
      ).status,
      200,
    );
    const ws = new WebSocket(
      origin.replace("http", "ws") + `/ws/room?event=${w.id}&guest=1`,
      { headers: { origin, cookie: guest } },
    );
    sockets.push(ws);
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    const closed = new Promise<number>((r) => ws.once("close", r));
    assert.equal(
      (await req(`/api/events/${w.id}/invitations/${invite.id}`, "DELETE", {}))
        .status,
      200,
    );
    assert.equal(await closed, 4003);
    assert.equal((await viewerRoom()).speakerName, undefined, "Revoked speaker disappears from public identity");
    assert.equal(
      (await req(`/api/events/${w.id}`, "GET", undefined, guest, true)).status,
      401,
    );
    assert.equal(
      (
        await req(
          `/api/events/${w.id}/invitation-entry`,
          "POST",
          { token: invite.token, name: "Again" },
          "",
        )
      ).status,
      403,
    );
    // Other invitation survives; host identity is not replaced by guest cookies.
    assert.equal(
      (await req(`/api/events/${w.id}`, "GET", undefined, assistant, true))
        .status,
      200,
    );
    assert.equal(
      (await req("/api/events", "GET", undefined, owner + "; " + guest)).status,
      200,
    );
    await a.store.db
      .prepare("UPDATE event_invites SET expires=0 WHERE id=?")
      .run(assistantInvite.id);
    assert.equal(
      (await req(`/api/events/${w.id}`, "GET", undefined, assistant, true))
        .status,
      401,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
