import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
const dir = mkdtempSync(join(tmpdir(), "live-stats-")),
  origin = "http://127.0.0.1:4342";
const a = await createApp(dir, origin, {
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
a.app.use(express.static(resolve("dist")));
a.app.get("/{*path}", (_q, r) => r.sendFile(resolve("dist/index.html")));
await new Promise((r) => a.server.listen(4342, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Войти в кабинет", exact: true })
    .click();
  const w = (await a.store.list("arslive"))[0];
  const base = Date.now() - 600000;
  const firstRun = randomUUID(),
    secondRun = randomUUID();
  await a.store.saveRecording({
    id: firstRun,
    eventId: w.id,
    companyId: w.companyId,
    state: "ready",
    createdAt: new Date(base).toISOString(),
    stoppedAt: new Date(base + 300000).toISOString(),
    duration: 600,
    bytes: 0,
    hasFile: false,
    interrupted: false,
  });
  await a.store.saveRecording({
    id: secondRun,
    eventId: w.id,
    companyId: w.companyId,
    state: "ready",
    createdAt: new Date(base + 300000).toISOString(),
    stoppedAt: new Date(base + 600000).toISOString(),
    duration: 300,
    bytes: 0,
    hasFile: false,
    interrupted: false,
  });
  const sid = await a.store.newSession(
    null,
    w,
    "Тестовый зритель",
    randomUUID(),
  );
  const cookie = `al_view_${w.slug}=${sid}`;
  async function viewerPost(kind, detail = {}) {
    return fetch(origin + `/api/room/${w.slug}/analytics`, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        "user-agent": "Test iPhone Mobile",
      },
      body: JSON.stringify({
        id: randomUUID(),
        kind,
        tabId: randomUUID(),
        ...detail,
      }),
    });
  }
  const heartbeat = await viewerPost("watch_heartbeat", {
    seconds: 10,
    position: 22,
    timezone: "Europe/Moscow",
    source: "https://example.org/page?token=secret",
  });
  assert.equal(heartbeat.status, 200);
  const invalid = await viewerPost("watch_heartbeat", { seconds: 50000 });
  assert.equal(invalid.status, 400);
  for (let minute = 0; minute < 10; minute++) {
    for (const kind of [
      "room_presence",
      "watch_heartbeat",
      ...(minute === 3 ? ["cta_click"] : []),
    ]) {
      const id = randomUUID();
      await a.store.analytics(w, sid, kind, id, {
        tabId: "same-tab",
        seconds: 15,
        device: "mobile",
        phase: "live",
      });
      await a.store.db
        .prepare("UPDATE analytics SET at=? WHERE id=?")
        .run(new Date(base + minute * 60000).toISOString(), id);
    }
  }
  await a.store.db
    .prepare("INSERT INTO companies VALUES (?,?)")
    .run("other", "Other");
  const other = await a.store.create("other", initialEvent);
  const otherSid = await a.store.newSession(
    null,
    other,
    "Чужой зритель",
    randomUUID(),
  );
  await a.store.analytics(other, otherSid, "room_entry");
  const guest = await fetch(origin + "/api/statistics");
  assert.equal(guest.status, 401);
  const asViewer = await fetch(origin + "/api/statistics", {
    headers: { cookie },
  });
  assert.equal(asViewer.status, 401);
  const cross = await context.request.get(
    origin + "/api/statistics?event=" + other.id,
  );
  assert.equal(cross.status(), 403);
  // Historical statistics survive normal removal of the expired login session.
  await a.store.db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
  const response = await context.request.get(
    origin + "/api/statistics?event=" + w.id,
  );
  assert.equal(response.status(), 200);
  const stats = await response.json();
  assert.equal(stats.summary.viewers, 1);
  assert.equal(stats.summary.clicks, 1);
  assert.equal(stats.summary.watchSeconds, 160);
  assert.equal(stats.devices.mobile, 1);
  assert.equal(stats.sources["example.org"], 1);
  assert.equal(JSON.stringify(stats).includes("secret"), false);
  assert.equal(JSON.stringify(stats).includes(sid), false);
  await page.goto(origin + "/statistics?event=" + w.id);
  await page.getByRole("heading", { name: "Статистика вебинаров" }).waitFor();
  await page.getByText("Тестовый зритель", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Чужой зритель", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Показатель графика").selectOption("clicks");
  await page.getByRole("button", { name: /^3 мин:/ }).click();
  await page.getByText(/3 мин · В комнате/).waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать CSV" }).click();
  assert.equal((await download).suggestedFilename(), "webinar-statistics.csv");
  const filtered = page.waitForResponse((r) =>
    r.url().includes(`run=${secondRun}`),
  );
  await page.getByLabel("Передача", { exact: true }).selectOption(secondRun);
  const byRun = await (await filtered).json();
  assert.equal(byRun.summary.clicks, 0);
  assert.equal(byRun.selectedRunId, secondRun);
  await page.getByText("Тестовый зритель", { exact: true }).waitFor();
  mkdirSync("test-results/statistics", { recursive: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    if ([390, 1440].includes(width))
      await page.screenshot({
        path: `test-results/statistics/${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
  }
  await page.getByLabel("Вебинар", { exact: true }).selectOption("");
  await page.getByRole("heading", { name: "Сравнение вебинаров" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS statistics API tenant/auth/metadata and dashboard chart/export/mobile",
  );
} finally {
  await browser.close();
  await a.close();
  rmSync(dir, { recursive: true, force: true });
}
