import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.ts";
const dir = mkdtempSync(join(tmpdir(), "live-client-"));
const origin = "http://127.0.0.1:4321";
const app = await createApp(dir, origin, {
  localClientPreview: true,
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
app.app.use(express.static(resolve("dist")));
app.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => app.server.listen(4321, "127.0.0.1", r));
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const context = await browser.newContext({
  permissions: ["camera", "microphone"],
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = resolve("test-results/client-studio");
mkdirSync(out, { recursive: true });
try {
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Войти в кабинет", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Ваши вебинары", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: /Вебинары \d/ }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      async () => (await fetch("/api/admin/webinars")).status,
    ),
    403,
  );
  const events = await page.evaluate(
    async () => (await (await fetch("/api/events")).json()).events,
  );
  assert.ok(events.every((e) => e.companyId === "local-client"));
  const w = events[0];
  assert.equal(w.hostName, "");
  assert.equal(w.brandName, "");
  assert.equal(w.description, "");
  await page.goto(origin + "/event/" + w.id);
  assert.equal(
    await page.getByText("Диагностика эфира", { exact: true }).count(),
    0,
  );
  await page.getByText("Оформление и презентация", { exact: false }).click();
  await page
    .locator("input[type=file]")
    .nth(2)
    .setInputFiles(resolve("tests/fixtures/presentation.pptx"));
  await page
    .getByText("Обрабатываем…", { exact: true })
    .waitFor({ state: "hidden", timeout: 90000 });
  const imported = await page.evaluate(
    async (id) => (await (await fetch(`/api/events/${id}`)).json()).event.pdfId,
    w.id,
  );
  assert.ok(
    imported,
    "PowerPoint was imported through the authenticated upload form",
  );
  await page.screenshot({ path: out + "/editor.png", fullPage: true });
  await page.goto(origin + "/studio/" + w.id);
  await page
    .getByRole("button", { name: "Проверить камеру и звук", exact: true })
    .click();
  await page.getByText("Сохранение проверено", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Можно начинать" }).waitFor();
  assert.equal(
    await page.getByText("Диагностика эфира", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Выбрать устройства" }).count(),
    0,
  );
  for (const label of ["Выбрать микрофон", "Выбрать камеру"]) {
    await page.locator(`summary[aria-label="${label}"]`).click();
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("button")
      .nth(1)
      .click();
    await page.getByRole("heading", { name: "Можно начинать" }).waitFor();
  }
  await page.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await page
    .getByRole("button", { name: "Отменить запуск", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Микрофон", exact: true }).click();
  await page
    .getByRole("button", { name: "Отменить запуск", exact: true })
    .waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Микрофон выкл", exact: true })
    .click();
  await page.getByRole("heading", { name: "Можно начинать" }).waitFor();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    ) {
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .map((e) => ({
              tag: e.tagName,
              cls: e.className,
              x: e.getBoundingClientRect().x,
              width: e.getBoundingClientRect().width,
            }))
            .filter((e) => e.x + e.width > innerWidth + 1)
            .slice(0, 25),
        ),
      );
      await page.screenshot({ path: out + "/overflow.png", fullPage: true });
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `${out}/preflight-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Скрыть проверку" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Большой экран", exact: true })
    .click();
  await page.getByRole("button", { name: /Показать мой чат/ }).click();
  await page
    .getByLabel("Сообщение в чат", { exact: true })
    .fill("Черновик для мобильного чата");
  await page.screenshot({ path: out + "/mobile-chat-sheet.png" });
  await page.getByRole("button", { name: "Закрыть чат", exact: true }).click();
  assert.equal(await page.locator(".studio-chat").isVisible(), false);
  await page.getByRole("button", { name: /Показать мой чат/ }).click();
  assert.equal(
    await page.getByLabel("Сообщение в чат", { exact: true }).inputValue(),
    "Черновик для мобильного чата",
  );
  await page.getByLabel("Сообщение в чат", { exact: true }).fill("");
  await page.keyboard.press("Escape");
  const startButton = await page
    .getByRole("button", { name: "Начать эфир", exact: true })
    .boundingBox();
  const previewCanvas = await page
    .locator(".canvas-shell canvas")
    .boundingBox();
  assert.ok(
    startButton.y >= previewCanvas.y + previewCanvas.height - 1,
    "mobile start below presentation",
  );
  await page.screenshot({ path: out + "/mobile-controls.png", fullPage: true });
  assert.equal(await page.locator(".studio-page.is-focused").count(), 1);
  await page.getByRole("button", { name: "Обычный вид", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".studio-chat").waitFor({ state: "visible" });
  const navigation = await page.locator(".slide-controls").boundingBox();
  const drawing = await page.locator(".drawing-group").boundingBox();
  const devices = await page.locator(".av-controls").boundingBox();
  assert.ok(navigation.x < drawing.x && drawing.x < devices.x, "toolbar order");
  assert.ok(Math.abs(navigation.y - devices.y) < 40, "one toolbar row");
  await page.locator('summary[aria-label="Выбрать микрофон"]').click();
  await page.screenshot({ path: out + "/device-menu.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.locator(".camera-settings > summary").click();
  await page.getByLabel("Размер камеры", { exact: true }).press("End");
  assert.equal(
    await page.getByLabel("Размер камеры", { exact: true }).inputValue(),
    "55",
  );
  await page.locator(".camera-settings > summary").click();
  const normalCanvas = await page.locator(".canvas-shell canvas").boundingBox();
  await page
    .getByRole("button", { name: "Большой экран", exact: true })
    .click();
  const focusCanvas = await page.locator(".canvas-shell canvas").boundingBox();
  assert.ok(
    focusCanvas.width >= normalCanvas.width,
    "focus must not shrink video",
  );
  assert.ok(Math.abs(focusCanvas.width / focusCanvas.height - 16 / 9) < 0.02);
  const thumbBefore = await page.locator(".slide-thumb").first().boundingBox();
  await page.getByRole("button", { name: "Увеличить слайды" }).click();
  const thumbAfter = await page.locator(".slide-thumb").first().boundingBox();
  assert.ok(thumbAfter.width > thumbBefore.width);
  await page.getByRole("button", { name: "Следующий слайд" }).click();
  await page
    .locator('.slide-thumb[aria-label="Слайд 2"][aria-current="step"]')
    .waitFor();
  await page.getByRole("button", { name: "Настроить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Заготовки сообщений" });
  await dialog.waitFor();
  assert.equal(
    await dialog.evaluate((el) => el.matches(":modal")),
    true,
    "editor must be above video in top layer",
  );
  await page.screenshot({ path: out + "/templates-modal-focus.png" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".studio-page.is-focused").count(),
    1,
    "Escape closes dialog before focus mode",
  );
  await page
    .getByRole("button", { name: "Скрыть инструменты", exact: true })
    .click();
  assert.equal(await page.locator(".slide-controls").isVisible(), false);
  assert.equal(await page.locator(".chat-panel").isVisible(), true);
  await page
    .locator(".engagement-templates")
    .screenshot({ path: out + "/chat-templates.png" });
  await page.screenshot({ path: out + "/focus.png", fullPage: true });
  await page
    .getByRole("button", { name: "Показать инструменты", exact: true })
    .click();
  await page.getByRole("button", { name: "Обычный вид", exact: true }).click();
  await page
    .getByText("Если возникли неполадки с трансляцией", { exact: true })
    .click();
  await page.screenshot({ path: out + "/studio-help.png", fullPage: true });

  await page.getByRole("button", { name: "Настроить предложение" }).click();
  await page.getByLabel("Текст кнопки", { exact: true }).fill("Новый материал");
  await page
    .getByLabel("Описание", { exact: true })
    .fill("Описание во время вебинара");
  await page
    .getByLabel("Ссылка", { exact: true })
    .fill("https://example.com/new");
  await page.getByRole("button", { name: "Сохранить предложение" }).click();
  await page
    .getByRole("heading", { name: "Новый материал", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Показать предложение" }).click();
  await page.getByText("Сейчас видно зрителям", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Вставить в чат", exact: true })
    .click();
  assert.equal(
    await page.locator('.message a[href="https://example.com/new"]').count(),
    0,
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#chat-message")
      ?.value.includes("https://example.com/new"),
  );
  assert.match(
    await page.getByLabel("Сообщение в чат", { exact: true }).inputValue(),
    /https:\/\/example.com\/new/,
  );
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page.locator('.message a[href="https://example.com/new"]').waitFor();
  await page.getByRole("button", { name: "Настроить", exact: true }).click();
  await page
    .getByLabel("Название", { exact: true })
    .nth(0)
    .fill("Наша проверка");
  await page
    .getByLabel("Сообщение", { exact: true })
    .nth(0)
    .fill("Приватная заготовка");
  await page.getByRole("button", { name: "Сохранить заготовки" }).click();
  await page
    .getByRole("button", { name: "Наша проверка", exact: true })
    .waitFor();
  assert.equal(
    (await app.store.event(w.id)).chatTemplates[0].text,
    "Приватная заготовка",
  );
  await page
    .getByRole("button", { name: "Наша проверка", exact: true })
    .click();
  assert.equal(
    await page
      .locator(".message p")
      .filter({ hasText: "Приватная заготовка" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Вопросы", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#chat-message")
      ?.value.includes("Задавайте вопросы"),
  );
  const composed = await page
    .getByLabel("Сообщение в чат", { exact: true })
    .inputValue();
  assert.match(composed, /Приватная заготовка/);
  assert.match(composed, /Задавайте вопросы/);
  await page
    .getByLabel("Сообщение в чат", { exact: true })
    .fill(composed + " https://example.com/questions");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await page
    .locator(".message p")
    .filter({ hasText: "Приватная заготовка" })
    .waitFor();
  const viewer = await browser.newPage();
  await viewer.goto(origin + "/room/" + w.slug);
  await viewer.getByLabel("Ваше имя").fill("Зритель");
  await viewer.getByRole("button", { name: "Войти в комнату" }).click();
  await viewer.locator('.message a[href="https://example.com/new"]').waitFor();
  assert.equal(
    await viewer
      .getByRole("button", { name: "Настроить", exact: true })
      .count(),
    0,
  );
  await page
    .getByLabel("Реальных зрителей сейчас: 1", { exact: true })
    .waitFor();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await viewer.setViewportSize({ width, height: 1000 });
    await viewer.screenshot({
      path: `${out}/viewer-${width}.png`,
      fullPage: true,
    });
    if (
      await viewer.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      console.log(
        await viewer.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .map((el) => ({
              cls: el.className,
              x: el.getBoundingClientRect().x,
              right: el.getBoundingClientRect().right,
            }))
            .filter((el) => el.right > innerWidth + 1),
        ),
      );
    assert.equal(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `viewer overflow ${width}`,
    );
    const heading = await viewer.locator(".viewer-header-title").boundingBox();
    assert.ok(
      Math.abs(heading.x + heading.width / 2 - width / 2) < 2,
      "viewer title centered",
    );
    await viewer.screenshot({
      path: `${out}/viewer-${width}.png`,
      fullPage: true,
    });
  }
  await viewer.close();
  await page
    .getByLabel("Реальных зрителей сейчас: 0", { exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Наша проверка", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  assert.equal((await app.store.recordings(w.id)).length, 0);
  console.log(
    "PASS: actual client permissions, automatic preflight/no recordings, device changes, five widths, offer editor/show/send, saved templates, clickable viewer links",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
