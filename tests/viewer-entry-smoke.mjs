// Real local API with synthetic public branding; no external services.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
const dir = mkdtempSync(join(tmpdir(), "live-entry-"));
const origin = "http://127.0.0.1:4337";
const a = await createApp(dir, origin, {
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
a.app.use(express.static(resolve("dist")));
a.app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
await new Promise((r) => a.server.listen(4337, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = resolve("test-results/entry");
mkdirSync(out, { recursive: true });
try {
  const w = (await a.store.list("arslive"))[0];
  const login = await fetch(origin + "/api/auth/local", {
    method: "POST",
    headers: { origin },
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  for (const kind of ["logo", "cover"]) {
    const buffer = await sharp({
      create: {
        width: kind === "logo" ? 160 : 800,
        height: kind === "logo" ? 80 : 450,
        channels: 3,
        background: kind === "logo" ? "#bba05d" : "#51432b",
      },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", new Blob([buffer], { type: "image/png" }), kind + ".png");
    const r = await fetch(origin + `/api/events/${w.id}/assets`, {
      method: "POST",
      headers: { origin, cookie },
      body: form,
    });
    assert.equal(r.status, 200);
  }
  await a.store.update(w.id, {
    startsAt: new Date(Date.now() + 7200000).toISOString(),
    title: "Будущий вебинар",
    brandName: "Компания",
    hostName: "Ведущий",
  });
  const saved = await a.store.event(w.id);
  const info = await (await fetch(origin + `/api/room/${w.slug}/info`)).json();
  assert.equal(info.logoId, saved.logoId);
  assert.equal(info.coverId, saved.coverId);
  for (const id of [saved.logoId, saved.coverId])
    assert.equal(
      (await fetch(origin + `/api/events/${w.id}/assets/${id}`)).status,
      200,
    );
  assert.equal(
    (await fetch(origin + `/api/events/${w.id}/assets/${saved.pdfId}`)).status,
    401,
  );
  await page.goto(origin + "/room/" + w.slug);
  await page.getByText(/До начала/).waitFor();
  await page.waitForFunction(
    () =>
      [...document.images].length === 2 &&
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.ok(await page.getByAltText("Обложка вебинара").isVisible());
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: out + `/waiting-${width}.png`,
      fullPage: true,
    });
  }
  await a.store.update(w.id, {
    state: "ended",
    ctaVisible: false,
    ctaUrl: "https://example.org/offer",
    ctaTitle: "Материалы вебинара",
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Ваше имя", { exact: true }).count(), 0);
  assert.equal(await page.locator("video,iframe").count(), 0);
  assert.equal(
    await page
      .getByRole("link", { name: "Посмотреть предложение" })
      .getAttribute("href"),
    "https://example.org/offer",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: public logo/cover, private slides, scheduled countdown, 4 widths, late arrival CTA without login",
  );
} finally {
  await browser.close();
  await a.close();
  rmSync(dir, { recursive: true, force: true });
}
