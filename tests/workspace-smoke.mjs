// Isolated synthetic companies: no production accounts, provider credentials or external calls.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
const origin = "http://127.0.0.1:4318";
const dir = mkdtempSync(join(tmpdir(), "arslive-workspace-"));
const out = resolve("test-results/workspace");
mkdirSync(out, { recursive: true });
const server = await createApp(dir, origin, {
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
server.app.use(express.static(resolve("dist")));
server.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => server.server.listen(4318, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  const draft = await server.store.create("arslive", {
    ...initialEvent,
    title: "Новый вебинар",
  });
  const ended = await server.store.create("arslive", {
    ...initialEvent,
    title: "Вебинар о новых возможностях",
  });
  await server.store.update(ended.id, { state: "ended" });
  await server.store.saveRecording({
    id: randomUUID(),
    eventId: ended.id,
    companyId: "arslive",
    state: "failed",
    createdAt: new Date().toISOString(),
    duration: 3723,
    bytes: null,
    hasFile: false,
    interrupted: false,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  await server.store.db
    .prepare("INSERT INTO companies VALUES (?,?)")
    .run("synthetic-client", "Тестовая компания");
  await server.store.db
    .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
    .run("synthetic-owner", "synthetic-client", "Клиент", "owner");
  const clientWebinar = await server.store.create("synthetic-client", {
    ...initialEvent,
    title: "Вебинар клиента",
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "Войти в кабинет" }).waitFor();
  assert.equal(
    await page.locator(".orb").evaluate((el) => getComputedStyle(el).width),
    "154px",
  );
  assert.equal(
    await page
      .locator(".orb")
      .evaluate((el) => getComputedStyle(el).animationDuration),
    "2.4s",
  );
  await page.screenshot({ path: out + "/login.png", fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".orb")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Войти в кабинет" }).click();
  await page.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
  await page.getByRole("button", { name: /Завершённые/ }).click();
  assert.equal(await page.locator(".event-card").count(), 1);
  assert.equal(
    await page.getByRole("link", { name: /Проверить и запустить/ }).count(),
    0,
  );
  await page.screenshot({ path: out + "/completed-list.png", fullPage: true });
  await page.getByRole("link", { name: /Открыть историю/ }).click();
  await page
    .getByRole("button", { name: "Создать копию", exact: true })
    .waitFor();
  assert.equal(await page.locator(".chat-compose").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: /Начать эфир|Включить камеру/ })
      .count(),
    0,
  );
  await page.getByText("Скачать до", { exact: true }).waitFor();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [path, name] of [
      [`/archive/${ended.id}`, "archive"],
      ["/?tab=recordings", "recordings"],
      [`/event/${draft.id}`, "editor"],
    ]) {
      await page.goto(origin + path);
      await page
        .locator(
          name === "archive"
            ? ".archive-layout"
            : name === "recordings"
              ? ".record-card"
              : ".editor-layout",
        )
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${name} overflow ${width}`,
      );
      if (name === "editor")
        assert.equal(
          await page.getByText("Канал трансляции", { exact: true }).count(),
          0,
        );
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: `${out}/${name}-${width}.png`,
          fullPage: true,
        });
    }
  }
  await page.goto(origin + "/admin");
  await page
    .getByRole("heading", { name: clientWebinar.title, exact: true })
    .waitFor();
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: clientWebinar.title,
        exact: true,
      }),
    })
    .getByRole("button", { name: "Наблюдать за вебинаром" })
    .click();
  await page.getByText("Наблюдение за вебинаром", { exact: true }).waitFor();
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(
    await page
      .getByRole("button", {
        name: /Начать эфир|Завершить эфир|Включить камеру/,
      })
      .count(),
    0,
  );
  await page.screenshot({ path: out + "/observer.png", fullPage: true });
  const client = await browser.newContext();
  await client.addCookies([
    {
      name: "al_host",
      value: await server.store.newSession("synthetic-owner", null, "Клиент"),
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const cp = await client.newPage();
  await cp.goto(origin);
  await cp.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
  assert.equal(await cp.locator(".event-card").count(), 1);
  await cp.getByRole("button", { name: "Настройки кабинета" }).click();
  await cp.locator(".connection-settings").waitFor();
  assert.equal(
    await cp.getByText("Предоставить кабинет клиенту", { exact: true }).count(),
    0,
  );
  assert.equal(
    await cp
      .getByRole("link", { name: "Вебинары клиентов", exact: true })
      .count(),
    0,
  );
  await cp.screenshot({ path: out + "/client-settings.png", fullPage: true });
  await cp.goto(`${origin}/studio/${clientWebinar.id}`);
  await cp
    .getByRole("heading", { name: clientWebinar.title, exact: true })
    .waitFor();
  await page.goto(`${origin}/admin`);
  const clientCard = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: clientWebinar.title,
      exact: true,
    }),
  });
  await clientCard
    .getByRole("button", { name: "Ссылка зрителя", exact: true })
    .waitFor();
  assert.equal(
    await clientCard
      .getByRole("link", { name: "Как видит зритель" })
      .getAttribute("href"),
    `/room/${clientWebinar.slug}`,
  );
  await page.addInitScript(() => {
    window.supportCaptureAttempts = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.supportCaptureAttempts++;
      throw Error("Support must not capture");
    };
  });
  await clientCard.getByRole("link", { name: "Помочь в студии" }).click();
  await page.getByText("ПОМОЩЬ ВЕДУЩЕМУ", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: /Начать эфир|Завершить эфир|Включить камеру|Возобновить передачу/,
      })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Слайд 2", exact: true }).click();
  await cp.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Слайд 2"]')
        ?.getAttribute("aria-current") === "step",
  );
  await cp.getByRole("button", { name: "Слайд 3", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Слайд 3"]')
        ?.getAttribute("aria-current") === "step",
  );
  assert.equal(await page.evaluate(() => window.supportCaptureAttempts), 0);
  assert.equal((await server.store.event(clientWebinar.id)).state, "draft");
  assert.equal(
    (await server.store.event(clientWebinar.id)).title,
    clientWebinar.title,
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: `${out}/assistance-${width}.png`,
      fullPage: true,
    });
  }
  console.log(
    "PASS: explicit client assistance, shareable draft link, bidirectional slide controls, no camera capture, draft preserved",
  );
  await server.store.update(clientWebinar.id, { state: "ended" });
  const completedRun = {
    id: randomUUID(),
    eventId: clientWebinar.id,
    companyId: "synthetic-client",
    state: "ready",
    createdAt: new Date().toISOString(),
    duration: 20,
    bytes: 0,
    hasFile: false,
    interrupted: false,
  };
  await server.store.saveRecording(completedRun);
  await page.reload();
  await page
    .getByRole("button", { name: "Вернуть в ожидание", exact: true })
    .click();
  await page.getByRole("button", { name: "Вернуть с прежней ссылкой" }).click();
  await page.getByText("ПОМОЩЬ ВЕДУЩЕМУ", { exact: true }).waitFor();
  assert.equal((await server.store.event(clientWebinar.id)).state, "draft");
  assert.equal(
    (await server.store.event(clientWebinar.id)).slug,
    clientWebinar.slug,
  );
  assert.equal(await page.evaluate(() => window.supportCaptureAttempts), 0);
  console.log(
    "PASS: platform administrator reopens client webinar in assistance mode without taking the camera",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: workspace UI 320/390/768/1024/1440, archive/deadline/editor, pulse/reduced motion, actual client session, admin observer",
  );
  await browser.close();
  if (process.env.MEDIA_SMOKE === "1") {
    const code = await new Promise((resolveCode) => {
      const child = spawn(process.execPath, ["tests/browser-smoke.mjs"], {
        env: { ...process.env, TEST_ORIGIN: origin },
        stdio: "inherit",
      });
      child.on("exit", resolveCode);
      child.on("error", () => resolveCode(1));
    });
    assert.equal(code, 0, "media smoke");
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
