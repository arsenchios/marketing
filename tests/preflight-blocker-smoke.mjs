// Local synthetic state only; no real camera, provider, broadcast or production data.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";

const dir = mkdtempSync(join(tmpdir(), "preflight-blocker-"));
const origin = "http://127.0.0.1:4334";
const app = await createApp(dir, origin, { archiveTransport: null });
app.app.use(express.static(resolve("dist")));
app.app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
await new Promise((r) => app.server.listen(4334, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  const sessionId = await app.store.newSession("local-owner", null, "Owner");
  const session = await app.store.session(sessionId);
  const old = (await app.store.list("arslive"))[0];
  const next = await app.store.create("arslive", { ...initialEvent, title: "Следующий тест" });
  const run = await app.media.start(old, session, randomUUID(), randomUUID());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["camera", "microphone"] });
  await ctx.addCookies([{ name: "al_host", value: sessionId, url: origin }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/studio/${next.id}`);
  await page.getByRole("button", { name: "Проверить камеру и звук", exact: true }).click();
  const panel = page.locator(".stage-preflight");
  const link = panel.getByRole("link", { name: "Открыть активную студию", exact: true });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), `/studio/${old.id}`);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await panel.innerText(), /Закрытие вкладки не завершает эфир/);
  assert.equal(await panel.getByRole("button", { name: "Начать эфир", exact: true }).isEnabled(), false);
  assert.equal(app.media.current.record.id, run);
  mkdirSync("test-results/preflight-blocker", { recursive: true });
  await page.screenshot({ path: "test-results/preflight-blocker/blocked.png", fullPage: true });
  await app.media.stop(old.id);
  await panel.getByRole("button", { name: "Повторить проверку", exact: true }).click();
  await panel.getByText("Сохранение проверено", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await link.count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "test-results/preflight-blocker/recovered.png", fullPage: true });
  console.log("PASS: active studio is preserved and linked; completing it releases preflight and removes recovery link");
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
