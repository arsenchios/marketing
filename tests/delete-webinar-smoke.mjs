import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.ts";

const dir = mkdtempSync(join(tmpdir(), "live-delete-"));
const origin = "http://127.0.0.1:4327";
const app = await createApp(dir, origin, {
  localClientPreview: true,
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
app.app.use(express.static(resolve("dist")));
app.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => app.server.listen(4327, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Войти в кабинет", exact: true })
    .click();
  const remove = page
    .getByRole("button", { name: "Удалить", exact: true })
    .first();
  await remove.click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("heading", { name: "Удалить вебинар?" }).waitFor();
  await modal.getByRole("button", { name: "Отмена", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.ok(await remove.isVisible());
  await remove.click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  mkdirSync(resolve("test-results/delete-webinar"), { recursive: true });
  await page.screenshot({
    path: resolve("test-results/delete-webinar/confirm-mobile.png"),
  });
  await modal
    .getByRole("button", { name: "Удалить вебинар", exact: true })
    .click();
  await modal.waitFor({ state: "detached" });
  await remove.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Удалить", exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: client deletion confirmation/cancel, 390px layout, card removal persists after reload",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
