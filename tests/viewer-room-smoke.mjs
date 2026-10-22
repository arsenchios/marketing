// UI acceptance only: loopback Vite/preview, synthetic room snapshots and YouTube SDK.
// No live broadcast, provider, camera, production data or cloud credentials.
import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { initialEvent } from "../shared/contracts.ts";

const base = process.env.TEST_ORIGIN || "http://127.0.0.1:4337";
assert.equal(new URL(base).hostname, "127.0.0.1");
const output = "test-results/viewer-room";
mkdirSync(output, { recursive: true });
const event = {
  ...initialEvent,
  id: "viewer-fixture",
  slug: "viewer-fixture",
  companyId: "fixture",
  title: "Как сделать вебинар удобным для зрителя",
  description: "Короткое описание темы и пользы встречи",
  hostName: "Александр Ведущий",
  welcome:
    "Добро пожаловать! Это первое сообщение организатора, которое должно быть видно целиком при входе.",
  state: "live",
  accent: "#d5b66f",
};
const makeMessage = (i) => ({
  id: `message-${i}`,
  eventId: event.id,
  name: `Зритель ${i}`,
  role: "viewer",
  text: `Сообщение ${i}: обсуждаем эфир и задаём вопрос ведущему.`,
  at: new Date(1700000000000 + i * 1000).toISOString(),
});
const makeSnapshot = () => ({
  event: structuredClone(event),
  speakerName: "Мария Спикер",
  online: 12,
  messages: Array.from({ length: 24 }, (_, i) => makeMessage(i)),
  recordings: [
    {
      id: "run-fixture",
      createdAt: new Date(Date.now() - 65000).toISOString(),
    },
  ],
  media: {
    state: "live",
    runId: "run-fixture",
    receiving: true,
    bytes: 1000,
    lastDataAt: Date.now(),
    playlist: null,
    mode: "broadcast",
    provider: "youtube",
    youtube: { enabled: true, phase: "live", videoId: "fixture" },
  },
});
const failures = [];
async function run(engine, name) {
  const browser = await engine.launch(
    name === "chromium"
      ? { channel: "chrome", headless: true }
      : { headless: true },
  );
  try {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      window.YT = {
        Player: class {
          constructor(el, options) {
            this.el = el;
            this.options = options;
            el.removeAttribute("src");
            el.srcdoc =
              '<html lang="ru"><body style="margin:0;display:grid;place-content:center;height:100vh;background:radial-gradient(ellipse at top right,#51462d,#161b1b);color:#e8d09a;font:20px system-ui;text-align:center"><div>Тестовая трансляция</div><small style="color:#aaa;font-size:12px;margin-top:10px">Проверка интерфейса комнаты</small></body></html>';
            setTimeout(() => options.events.onReady(), 0);
          }
          playVideo() {
            this.state = 1;
            this.options.events.onStateChange({ data: 1 });
          }
          pauseVideo() {
            this.state = 2;
            this.options.events.onStateChange({ data: 2 });
          }
          getPlayerState() {
            return this.state || 0;
          }
          getCurrentTime() {
            return 65;
          }
          mute() {}
          unMute() {}
          setVolume() {}
          destroy() {
            this.el.remove();
          }
        },
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push(e.message));
    let snapshot = makeSnapshot(),
      socket;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.fulfill({ status: 200, body: "" });
      if (url.pathname.startsWith("/api/"))
        return route.fulfill({
          json: url.pathname.endsWith("/info")
            ? snapshot.event
            : url.pathname.endsWith("/analytics")
              ? { ok: true }
              : snapshot,
        });
      return route.continue();
    });
    await page.routeWebSocket("**/ws/room?**", (ws) => {
      socket = ws;
      ws.send(JSON.stringify({ type: "snapshot", ...snapshot }));
    });
    await page.goto(`${base}/room/${event.slug}`);
    await page.getByRole("group", { name: "Управление видео" }).waitFor();
    const chat = page.locator(".chat-scroll");
    await page.waitForFunction(
      () => document.querySelector(".chat-scroll")?.scrollHeight > 400,
    );
    assert.equal(
      await chat.evaluate((el) => el.scrollTop),
      0,
      `${name}: greeting visible at entry`,
    );
    assert.equal(
      await page.locator(".event-brand").count(),
      0,
      "No generic webinar brand",
    );
    await page.getByText("В эфире", { exact: true }).waitFor();
    await page.getByText("Мария Спикер", { exact: true }).waitFor();
    for (const [width, height] of [
      [320, 700],
      [360, 800],
      [375, 812],
      [393, 852],
      [430, 932],
      [768, 1024],
      [852, 393],
      [1024, 768],
      [1440, 1000],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const geometry = await page.evaluate(() => {
        const selectors = [
          ".viewer-page",
          ".viewer-header",
          ".viewer-session-bar",
          ".viewer-content",
          ".youtube-player-shell",
          ".playback-controls",
          ".chat-panel",
        ];
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          boxes: selectors.map((selector) => {
            const rect = document
              .querySelector(selector)
              .getBoundingClientRect();
            return {
              selector,
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
          }),
        };
      });
      assert.ok(
        geometry.document <= width + 1,
        `${name}/${width}: overflow ${JSON.stringify(geometry)}`,
      );
      for (const rect of geometry.boxes)
        assert.ok(
          rect.left >= -1 && rect.right <= width + 1,
          `${name}/${width}: ${JSON.stringify(rect)}`,
        );
      const fullscreen = await page
        .getByRole("button", { name: "На весь экран", exact: true })
        .boundingBox();
      assert.ok(
        fullscreen &&
          fullscreen.x >= 0 &&
          fullscreen.x + fullscreen.width <= width + 1,
        "Fullscreen button within device width",
      );
      if (width <= 1024) {
        assert.ok(
          await page.evaluate(
            () =>
              document.querySelector(".viewer-content").getBoundingClientRect()
                .y <
              document.querySelector(".chat-panel").getBoundingClientRect().y,
          ),
          "Mobile video stays above chat",
        );
      }
      if (width === 393) {
        assert.ok(
          geometry.boxes.find((r) => r.selector === ".viewer-content").width >=
            383,
          "Minimal mobile gutters",
        );
        await page.screenshot({
          path: `${output}/${name}-iphone14pro.png`,
          fullPage: true,
        });
      }
      if (width === 1440) {
        const positions = await page.evaluate(() => ({
          chat: document.querySelector(".chat-panel").getBoundingClientRect().x,
          video: document
            .querySelector(".viewer-content")
            .getBoundingClientRect().x,
        }));
        assert.ok(
          positions.chat < positions.video,
          "Desktop chat stays on the left",
        );
        await page.screenshot({
          path: `${output}/${name}-desktop.png`,
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await chat.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    const publish = async () => {
      socket.send(JSON.stringify({ type: "snapshot", ...snapshot }));
      await page.evaluate(() => new Promise(requestAnimationFrame));
    };
    snapshot.messages.push(makeMessage(24));
    await publish();
    const unread = page.getByRole("button", {
      name: "1 новое сообщение",
      exact: true,
    });
    await unread.waitFor();
    assert.equal(
      await chat.evaluate((el) => el.scrollTop),
      0,
      "Incoming message must not move the reader",
    );
    await publish();
    await unread.waitFor(); // A repeated snapshot must not count twice.
    snapshot.messages.push(makeMessage(25));
    await publish();
    await page
      .getByRole("button", { name: "2 новых сообщения", exact: true })
      .waitFor();
    await page.screenshot({
      path: `${output}/${name}-unread.png`,
      fullPage: true,
    });
    snapshot.messages[0].deleted = true;
    await publish();
    await page
      .getByRole("button", { name: "2 новых сообщения", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector(".chat-new-messages"),
    );
    assert.ok(
      await chat.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2,
      ),
      "Click reaches latest message",
    );
    snapshot.messages.push(makeMessage(26));
    await publish();
    await page.waitForFunction(() =>
      document
        .querySelector(".chat-scroll")
        .textContent.includes("Сообщение 26:"),
    );
    assert.equal(
      await page.locator(".chat-new-messages").count(),
      0,
      "Follow incoming messages at bottom",
    );
    await chat.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    snapshot.messages.push(makeMessage(27));
    await publish();
    await page
      .getByRole("button", { name: "1 новое сообщение", exact: true })
      .waitFor();
    snapshot.messages = [];
    await publish();
    await page.waitForFunction(
      () => !document.querySelector(".chat-new-messages"),
    );
    snapshot.event.brandName = "ОченьДлинныйБренд".repeat(10);
    snapshot.event.title = "ОченьДлинноеНазваниеБезПробелов".repeat(10);
    snapshot.event.description =
      "https://example.test/" + "description".repeat(50);
    snapshot.event.hostName = "ДлинноеИмя".repeat(10);
    snapshot.speakerName = undefined;
    await publish();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".viewer-presenters")
          ?.textContent.includes("Мария"),
    );
    const longCopy = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll(".viewer-page *")]
        .map((el) => ({
          tag: el.tagName,
          cls: el.className,
          x: el.getBoundingClientRect().x,
          right: el.getBoundingClientRect().right,
          scroll: el.scrollWidth,
          width: el.clientWidth,
        }))
        .filter((el) => el.right > innerWidth + 1 || el.x < -1)
        .slice(0, 16),
    }));
    await page.screenshot({
      path: `${output}/${name}-long-copy.png`,
      fullPage: true,
    });
    assert.ok(
      longCopy.scroll <= longCopy.width + 1,
      `Long copy remains bounded: ${JSON.stringify(longCopy)}`,
    );
    // HLS and waiting modes use different elements and must also fit.
    snapshot.event.brandName = "";
    snapshot.event.title = event.title;
    snapshot.event.hostName = event.hostName;
    snapshot.event.description = event.description;
    snapshot.media.provider = "railway";
    snapshot.media.youtube = undefined;
    snapshot.media.playlist = "/fixture.m3u8";
    await page.route("**/fixture.m3u8", (route) =>
      route.fulfill({ status: 404 }),
    );
    await publish();
    await page.locator(".viewer-player").waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "HLS mode fits",
    );
    snapshot.media.runId = null;
    snapshot.media.playlist = null;
    snapshot.media.receiving = false;
    snapshot.event.state = "scheduled";
    await publish();
    await page.locator(".waiting-screen").waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Waiting mode fits",
    );
    console.log(
      `PASS ${name}: 320–1440px, live YouTube controls/HLS/waiting, greeting, unread/dedup/follow/clear, long text, optional speaker`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
}
if (process.env.TEST_ENGINE !== "webkit") await run(chromium, "chromium");
if (process.env.TEST_ENGINE !== "chromium") await run(webkit, "webkit");
assert.deepEqual(failures, []);
