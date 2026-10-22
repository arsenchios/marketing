// Local, isolated host session; simulate lost responses without touching production.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
const origin = "http://127.0.0.1:4331";
const dir = mkdtempSync(join(tmpdir(), "arslive-reconnect-"));
const server = await createApp(dir, origin, {
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
server.app.use(express.static(resolve("dist")));
server.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => server.server.listen(4331, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const event = await server.store.create("arslive", {
    ...initialEvent,
    title: "Восстановление связи",
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.testSockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.testSockets.push(this);
      }
    };
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Войти в кабинет", exact: true })
    .click();
  await page.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
  let failures = 1,
    requests = 0,
    forbidden = false;
  await page.route(`**/api/events/${event.id}`, async (route) => {
    requests++;
    if (forbidden)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Доступ закрыт" }),
      });
    if (failures-- > 0) return route.abort("failed");
    return route.continue();
  });
  await page.goto(`${origin}/studio/${event.id}`);
  await page
    .getByRole("heading", { name: event.title, exact: true })
    .waitFor({ timeout: 15000 });
  assert.ok(requests >= 2, "initial Load failed must retry automatically");
  await page.waitForFunction(() =>
    window.testSockets.some((s) => s.readyState === 1),
  );
  failures = 2;
  const before = requests;
  await server.store.update(event.id, { state: "ended" });
  await page.evaluate(() => window.testSockets.forEach((s) => s.close()));
  await page.locator(".archive-layout").waitFor({ timeout: 20000 });
  assert.ok(
    requests >= before + 3,
    "failed reconnect snapshots must retry until the finished state arrives",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Завершить эфир", exact: true })
      .count(),
    0,
  );
  mkdirSync(resolve("test-results/reconnect"), { recursive: true });
  await page.screenshot({
    path: resolve("test-results/reconnect/recovered.png"),
    fullPage: true,
  });
  forbidden = true;
  await page.evaluate(() => window.testSockets.forEach((s) => s.close()));
  await page
    .getByText("Доступ закрыт", { exact: true })
    .waitFor({ timeout: 10000 });
  const deniedCount = requests;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2200);
  assert.equal(
    requests,
    deniedCount,
    "explicit access denial must not trigger retry or restore old data",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: initial fetch recovery, failed reconnect recovery to ended, denied access stays closed, no page errors",
  );
} finally {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
