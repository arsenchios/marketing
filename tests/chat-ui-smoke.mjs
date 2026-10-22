import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.ts";
const dir = mkdtempSync(join(tmpdir(), "live-chat-")),
  origin = "http://127.0.0.1:4328";
const app = await createApp(dir, origin, {
  archiveTransport: null,
  google: { clientId: "", clientSecret: "", encryptionKey: "", ownerEmail: "" },
});
app.app.use(express.static(resolve("dist")));
app.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => app.server.listen(4328, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hostContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const viewerContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const host = await hostContext.newPage(),
  viewer = await viewerContext.newPage();
const errors = [];
for (const page of [host, viewer])
  page.on("pageerror", (e) => errors.push(e.message));
const out = resolve("test-results/chat");
mkdirSync(out, { recursive: true });
try {
  await host.goto(origin);
  await host
    .getByRole("button", { name: "Войти в кабинет", exact: true })
    .click();
  const w = (await app.store.list("arslive"))[0];
  await host.goto(origin + "/studio/" + w.id);
  await viewer.goto(origin + "/room/" + w.slug);
  await viewer.getByLabel("Ваше имя", { exact: true }).fill("Анна");
  await viewer.getByRole("button", { name: "Войти в комнату" }).click();
  await host
    .getByRole("button", { name: "Зрители: 1. Открыть список", exact: true })
    .click();
  await host.getByRole("dialog").getByText("Анна", { exact: true }).waitFor();
  await host.getByRole("button", { name: "Закрыть", exact: true }).click();
  // Settings stay below composer/templates and immediately above width.
  const hierarchy = await host.locator(".chat-panel").evaluate((el) => {
    const settings = el.querySelector(".chat-settings-row");
    return {
      afterComposer: !!(
        el.querySelector(".chat-compose").compareDocumentPosition(settings) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ),
      beforeWidth: !!(
        settings.compareDocumentPosition(
          el.querySelector(".studio-chat-width"),
        ) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
    };
  });
  assert.deepEqual(hierarchy, { afterComposer: true, beforeWidth: true });
  // Host tools must never shrink the conversation, including focused/mobile layouts.
  for (const width of [1440, 390]) {
    await host.setViewportSize({ width, height: 1000 });
    if (width === 390) {
      const show = host.getByRole("button", { name: /Показать мой чат/ });
      await show.waitFor({state: "visible"});
      await show.click();
      await host.locator(".chat-conversation").waitFor({state: "visible"});
    }
    const boxes = await host.locator(".chat-panel").evaluate(el => ({
      dialog: el.querySelector(".chat-conversation").getBoundingClientRect().toJSON(),
      tools: el.querySelector(".chat-host-tools").getBoundingClientRect().toJSON(),
      messages: el.querySelector(".chat-scroll").getBoundingClientRect().height,
    }));
    assert(boxes.tools.top >= boxes.dialog.bottom);
    assert(boxes.messages > 250, JSON.stringify({width,...boxes}));
  }
  await host.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await viewer.locator(".chat-reactions button").count(), 6);
  // The range has a fixed track, independent of the changing chat column.
  const range = host.getByRole("slider", { name: "Ширина чата" });
  await range.scrollIntoViewIfNeeded();
  const track = await range.boundingBox();
  await host.mouse.move(track.x + 20, track.y + track.height / 2);
  await host.mouse.down();
  await host.mouse.move(track.x + track.width - 2, track.y + track.height / 2, {
    steps: 12,
  });
  await host.mouse.up();
  assert.equal(await range.inputValue(), "440");
  const trackAfter = await range.boundingBox();
  assert.ok(
    Math.abs(trackAfter.x - track.x) < 1 &&
      Math.abs(trackAfter.width - track.width) < 1,
  );
  assert.ok(
    Math.abs((await host.locator(".studio-chat").boundingBox()).width - 440) <
      1,
  );
  await range.focus();
  await host.keyboard.press("Home");
  assert.equal(await range.inputValue(), "240");
  assert.ok(
    Math.abs((await host.locator(".studio-chat").boundingBox()).width - 240) <
      1,
  );
  await viewer.getByLabel("Сообщение в чат").fill("хуй");
  await viewer.getByRole("button", { name: "Отправить сообщение" }).click();
  await host
    .getByRole("button", { name: "Показать всем", exact: true })
    .waitFor();
  assert.equal(await viewer.getByText("хуй", { exact: true }).count(), 0);
  await host.getByText("Посмотреть сообщение", { exact: true }).click();
  await host.getByText("хуй", { exact: true }).waitFor();
  await host.screenshot({
    path: out + "/moderation-desktop.png",
    fullPage: true,
  });
  await host
    .getByRole("button", { name: "Показать всем", exact: true })
    .click();
  await viewer.getByText("хуй", { exact: true }).waitFor();
  await host
    .getByRole("button", { name: "Удалить сообщение", exact: true })
    .click();
  await viewer.getByText("Сообщение удалено", { exact: true }).waitFor();
  await viewer.getByRole("button", { name: "Сердце", exact: true }).click();
  assert.equal(await viewer.getByLabel("Сообщение в чат").inputValue(), "❤️");
  await viewer.getByLabel("Сообщение в чат").fill("Всем привет ❤️");
  await viewer.getByRole("button", { name: "Отправить сообщение" }).click();
  await host.getByText("Всем привет ❤️", { exact: true }).waitFor();
  await viewer.getByText("Чат работает", { exact: true }).waitFor();
  assert.equal(await viewer.getByText(/Отправка через/).count(), 0);
  assert.ok(
    await viewer
      .getByRole("button", { name: "Отправить сообщение" })
      .isDisabled(),
  );
  assert.match(await viewer.locator(".cooldown-number").innerText(), /^[1-5]$/);
  assert.match(
    await viewer
      .getByRole("button", { name: "Отправить сообщение" })
      .innerText(),
    /^[1-5]$/,
  );
  await viewer.screenshot({ path: out + "/chat-mobile.png", fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await viewer.setViewportSize({ width, height: 900 });
    assert.ok(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  // Configure the same fields clients see in webinar preparation and save them.
  await host.goto(origin + "/event/" + w.id);
  await host
    .locator("summary")
    .filter({ hasText: "Тестовая активность" })
    .click();
  await host
    .getByRole("checkbox", { name: "Искусственный рост зрителей" })
    .check();
  await host
    .getByRole("checkbox", { name: "Стартовые сообщения зрителей" })
    .check();
  await host.getByLabel("Пиковое число зрителей").fill("440");
  await host
    .getByRole("button", { name: "Сохранить изменения", exact: true })
    .click();
  await host.getByText("Изменения сохранены", { exact: true }).waitFor();
  await host.reload();
  await host
    .locator("summary")
    .filter({ hasText: "Тестовая активность" })
    .click();
  assert.equal(
    await host.getByLabel("Пиковое число зрителей").inputValue(),
    "440",
  );
  for (const width of [320, 390, 768, 1440]) {
    await host.setViewportSize({ width, height: 1000 });
    assert.ok(
      await host.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  await host.screenshot({
    animations: "disabled",
    path: out + "/audience-test-settings.png",
    fullPage: true,
  });
  const settings = (await app.store.event(w.id)).audienceTest;
  assert.equal(settings.enabled, true);
  assert.equal(settings.greetingsEnabled, true);
  assert.equal(await viewer.locator(".online").innerText(), "Зрителей: 1");
  const denied = await viewerContext.request.patch(
    origin + `/api/events/${w.id}/audience-test`,
    {
      headers: { origin },
      data: settings,
    },
  );
  assert.ok([401, 403].includes(denied.status()));
  await app.store.db
    .prepare("INSERT INTO companies VALUES (?,?)")
    .run("other", "Other");
  await app.store.db
    .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
    .run("other-owner", "other", "Other", "owner");
  const otherCookie =
    "al_host=" + (await app.store.newSession("other-owner", null, "Other"));
  const crossTenant = await fetch(
    origin + `/api/events/${w.id}/audience-test`,
    {
      method: "PATCH",
      headers: {
        origin,
        cookie: otherCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(settings),
    },
  );
  assert.ok([403, 404].includes(crossTenant.status));
  const run = {
    id: "audience-test-run",
    eventId: w.id,
    companyId: w.companyId,
    createdAt: new Date(Date.now() - 600000).toISOString(),
    state: "recording",
    duration: null,
    bytes: null,
    hasFile: false,
    interrupted: false,
  };
  await app.store.saveRecording(run);
  await app.store.update(w.id, { state: "live" });
  await host.goto(origin + "/studio/" + w.id);
  async function configure(enabled, greetingsEnabled) {
    await host
      .getByRole("button", { name: "Тестовая активность", exact: true })
      .click();
    await host
      .getByRole("checkbox", { name: "Искусственный рост зрителей" })
      .setChecked(enabled);
    await host
      .getByRole("checkbox", { name: "Стартовые сообщения зрителей" })
      .setChecked(greetingsEnabled);
    if (enabled)
      await host
        .getByRole("dialog")
        .screenshot({ path: out + "/audience-modal.png" });
    await host
      .getByRole("button", { name: "Сохранить настройки", exact: true })
      .click();
    await host.getByRole("dialog").waitFor({ state: "hidden" });
  }
  await configure(true, true); // publishes live fixture to both real sockets
  await viewer.waitForFunction(
    () =>
      Number(
        document.querySelector(".online")?.textContent.replace(/\D/g, ""),
      ) >= 250,
  );
  const count = async (page = viewer) =>
    Number((await page.locator(".online").innerText()).replace(/\D/g, ""));
  const before = await count();
  assert.ok(Math.abs(before - (await count(host))) <= 1);
  await host
    .getByLabel("Реальных зрителей сейчас: 1", { exact: true })
    .waitFor();
  await viewer.getByText("Москва на связи 👋", { exact: true }).waitFor();
  assert.equal(await viewer.locator(".message").count(), 22);
  await viewer.waitForTimeout(8000);
  assert.notEqual(await count(), before);
  await viewer.reload();
  await viewer.waitForFunction(
    () =>
      Number(
        document.querySelector(".online")?.textContent.replace(/\D/g, ""),
      ) >= 250,
  );
  assert.ok(Math.abs((await count()) - before) < 25);
  assert.equal(await viewer.locator(".message").count(), 22);
  assert.equal(
    await viewer.getByText(/демонстрация|условных зрителей/i).count(),
    0,
  );
  assert.equal((await app.store.messages(w.id)).length, 2);
  await viewer.screenshot({
    path: out + "/audience-test-viewer.png",
    fullPage: true,
  });
  for (const width of [320, 390, 768, 1440]) {
    await viewer.setViewportSize({ width, height: 900 });
    assert.ok(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    if (width === 390)
      await viewer.screenshot({
        path: out + "/audience-test-mobile.png",
        fullPage: true,
        animations: "disabled",
      });
  }
  const copy = await app.store.duplicate(await app.store.event(w.id));
  assert.equal(copy.audienceTest, undefined);
  await configure(false, true);
  await viewer.waitForFunction(
    () =>
      document.querySelector(".online")?.textContent.trim() === "Зрителей: 1",
  );
  assert.equal(await viewer.locator(".message").count(), 22);
  await configure(true, false);
  await viewer.waitForFunction(
    () => document.querySelectorAll(".message").length === 2,
  );
  assert.ok((await count()) >= 250);
  await app.store.update(w.id, { state: "ended" });
  await app.store.saveRecording({ ...run, state: "failed" });
  await configure(true, true);
  await viewer.getByRole("heading", { name: "История чата" }).waitFor();
  assert.equal(await viewer.locator(".online").innerText(), "Зрителей: 1");
  assert.equal(await viewer.locator(".message").count(), 2);
  await app.store.update(w.id, { state: "draft", audienceTest: undefined });
  await host.reload();
  await viewer.reload();
  await host
    .getByRole("button", { name: "Заблокировать участника", exact: true })
    .click();
  await host
    .getByRole("dialog")
    .getByRole("button", { name: "Заблокировать", exact: true })
    .click();
  await viewer
    .getByText("Доступ к комнате закрыт или срок входа истёк", { exact: true })
    .waitFor();
  assert.equal(await viewer.locator("video, iframe, .chat-compose").count(), 0);
  await viewer.reload();
  await viewer.getByLabel("Ваше имя", { exact: true }).fill("Другое имя");
  await viewer.getByRole("button", { name: "Войти в комнату" }).click();
  await viewer
    .getByText("Организатор закрыл вам доступ к этому вебинару", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: held messages, approve/delete, emoji draft, opt-in shared-clock audience, tenant isolation, reload/disable/end/reset, mobile layout, ban unmount and rejoin denial",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
