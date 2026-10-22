import { spawnSync } from "node:child_process";
// Isolated snapshots and a stub iframe: tests routing/status UI, not real YouTube delivery.
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { initialEvent } from "../shared/contracts.ts";
const mediaFile = resolve("test-results/viewer-status/replay.mp4");
mkdirSync(resolve("test-results/viewer-status"), { recursive: true });
const ffmpeg = spawnSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x333544:s=320x180:r=25",
  "-t",
  "3",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-y",
  mediaFile,
]);
assert.equal(ffmpeg.status, 0);
const app = express();
// Match production's privacy policy: the player must explicitly send only
// the site origin to YouTube, never the viewer URL or query parameters.
app.use((_req, res, next) => {
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json());
const telemetryEvents = [];
app.post("/api/room/ui/analytics", (req, res) => {
  telemetryEvents.push(req.body);
  res.json({ ok: true });
});
app.get("/api/events/viewer-status-test/recordings/recording", (_req, res) =>
  res.sendFile(mediaFile),
);
const server = createServer(app);
const sockets = new WebSocketServer({ server });
const event = {
  ...initialEvent,
  id: "viewer-status-test",
  slug: "ui",
  state: "live",
  title: "Проверка эфира",
  description: "Как подготовиться к международному рынку",
  hostName: "Анна",
  annotations: {},
  pdfId: null,
  logoId: null,
  coverId: null,
};
const data = {
  event,
  messages: [],
  recordings: [],
  online: 1,
  media: {
    provider: "youtube",
    runId: "run",
    receiving: true,
    playlist: null,
    state: "live",
    youtube: { enabled: true, phase: "waiting" },
  },
};
app.get("/api/room/ui/info", (_req, res) => res.json(event));
app.get("/api/room/ui", (_req, res) => res.json(data));
app.use(express.static(resolve("dist")));
app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
await new Promise((r) => server.listen(4327, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
const youtubeReferrers = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.context().route("https://www.youtube-nocookie.com/**", async (r) => {
  youtubeReferrers.push((await r.request().allHeaders()).referer);
  await r.fulfill({
    contentType: "text/html",
    body: "<p>YouTube player stub</p>",
  });
});
const youtubeStub = `
window.ytCalls = [];
window.YT = { Player: class {
 constructor(el, options) { this.state=-1; this.options=options; window.ytState=(state)=>{this.state=state;options.events.onStateChange({data:state});}; window.ytBlocked=()=>options.events.onAutoplayBlocked(); window.ytError=(code)=>options.events.onError({data:code}); if (el.tagName==='IFRAME') { this.frame=el; if(window.__pipTest) el.src="about:blank"; } else { this.frame=document.createElement('iframe'); this.frame.src='https://www.youtube-nocookie.com/embed/'+options.videoId+'?controls='+options.playerVars.controls; el.replaceWith(this.frame); } setTimeout(()=>options.events.onReady(), 10); }
 getPlayerState() { return this.state; }
 playVideo() { this.state=1; window.ytCalls.push('play'); this.options.events.onStateChange({data:1}); }
 pauseVideo() { this.state=2; window.ytCalls.push('pause'); this.options.events.onStateChange({data:2}); }
 mute() { window.ytCalls.push('mute'); } unMute() { window.ytCalls.push('unmute'); } setVolume(v) { window.ytCalls.push(v); }
 destroy() { this.frame.remove(); }
} }; window.onYouTubeIframeAPIReady?.();`;
await page
  .context()
  .route("https://www.youtube.com/iframe_api", (r) =>
    r.fulfill({ contentType: "application/javascript", body: youtubeStub }),
  );

const out = resolve("test-results/viewer-status");
mkdirSync(out, { recursive: true });
async function push() {
  for (const ws of sockets.clients)
    ws.send(JSON.stringify({ type: "snapshot", ...data }));
}
try {
  await page.goto(
    "http://127.0.0.1:4327/room/ui?private-test-value=not-for-youtube",
  );
  await page
    .getByText("Подключаем эфир — оставайтесь в комнате", { exact: true })
    .waitFor();
  await page.getByText("Чат работает", { exact: true }).waitFor();
  assert.equal(await page.locator(".viewer-header h1").innerText(), data.event.title);
  assert.equal(
    await page.locator(".event-heading p").innerText(),
    data.event.description,
  );
  const shortTitle = data.event.title;
  data.event.title = "Очень длинное название вебинара ".repeat(8);
  data.event.description = "Подробное описание ".repeat(40);
  await push();
  await page.waitForFunction(() => document.querySelector('.event-heading h1')?.textContent.length > 90);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.locator('.event-heading p').count(), 0);
    assert.equal(await page.locator('.compact-event-header').count(), 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path: out + `/header-long-${width}.png`, fullPage: true});
  }
  data.event.title = shortTitle; data.event.description = "Как подготовиться к международному рынку";
  await push();
  data.media.youtube.phase = "error";
  await push();
  await page.getByText("Эфир временно недоступен", { exact: true }).waitFor();
  assert.equal(await page.locator("iframe, video").count(), 0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: out + "/youtube-error-mobile.png",
    fullPage: true,
  });
  data.media.youtube.phase = "live";
  data.media.youtube.videoId = "synthetic123";
  await push();
  await page.getByText("Прямой эфир", { exact: true }).waitFor();
  assert.match(
    await page.locator("iframe").getAttribute("src"),
    /synthetic123/,
  );
  await page.getByRole("button", { name: "Пауза", exact: true }).waitFor();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await page
    .getByRole("button", { name: "Выключить звук", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.ytCalls), [
    "play",
    "pause",
    "mute",
  ]);
  assert.match(await page.locator("iframe").getAttribute("src"), /controls=1/);
  for (const width of [320, 390, 393, 430]) {
    await page.setViewportSize({width,height:852});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.getByRole("button", {name: "Мини-плеер", exact:true}).count(), 0);
    await page.screenshot({path:out+`/live-mobile-${width}.png`,fullPage:true});
  }

  await page.waitForFunction(
    () => document.querySelector("iframe")?.contentWindow,
  );
  assert.deepEqual(youtubeReferrers, ["http://127.0.0.1:4327/"]);
  const embedUrl = new URL(await page.locator("iframe").getAttribute("src"));
  assert.equal(embedUrl.searchParams.get("enablejsapi"), "1");
  assert.equal(embedUrl.searchParams.get("origin"), "http://127.0.0.1:4327");
  await page.evaluate(() => window.ytError(153));
  await page.getByRole("alert").filter({ hasText: "ошибка 153" }).waitFor();
  await page
    .getByRole("button", { name: "Продолжить просмотр", exact: true })
    .click();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".viewer-live-dot")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  for (const width of [1025, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const stageBox = await page.locator(".viewer-stage").boundingBox();
    const chatBox = await page.locator(".chat-panel").boundingBox();
    assert.ok(Math.abs(stageBox.y - chatBox.y) < 2);
    assert.ok(Math.abs(stageBox.height - chatBox.height) < 2);
  }
  // Layout-only mini-player keeps the exact iframe and playback instance alive.
  await page.evaluate(() => {
    window.originalIframe = document.querySelector("iframe");
  });
  const callsBeforeMini = await page.evaluate(() => [...window.ytCalls]);
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Мини-плеер", exact: true }).click();
    const box = await page.locator("iframe").boundingBox();
    assert.ok(box.width >= 200 && box.height >= 200);
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    assert.ok(
      await page.evaluate(
        () => window.originalIframe === document.querySelector("iframe"),
      ),
    );
    await page.screenshot({ path: out + `/mini-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".youtube-mini"));
  }
  assert.deepEqual(await page.evaluate(() => window.ytCalls), callsBeforeMini);
  assert.equal(youtubeReferrers.length, 1);
  // Technical pause restarts; a deliberate pause through our control remains paused.
  await page.evaluate(() => window.ytState(2));
  await page
    .getByRole("button", { name: "Продолжить просмотр", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Пауза", exact: true }).waitFor();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await page
    .getByRole("button", { name: "Продолжить просмотр", exact: true })
    .waitFor();
  const pausedCalls = await page.evaluate(() => window.ytCalls.length);
  await page.waitForTimeout(3400);
  assert.equal(await page.evaluate(() => window.ytCalls.length), pausedCalls);
  await page
    .getByRole("button", { name: "Продолжить просмотр", exact: true })
    .click();
  await page.evaluate(() => window.ytBlocked());
  await page
    .getByRole("button", { name: "Включить звук", exact: true })
    .last()
    .waitFor();
  await page.getByRole("button", { name: "Мини-плеер", exact: true }).click();
  const miniBefore = await page.locator(".youtube-mini").boundingBox();
  await page.getByRole("button", { name: "Увеличить мини-плеер" }).click();
  const miniAfter = await page.locator(".youtube-mini").boundingBox();
  assert.ok(miniAfter.width > miniBefore.width);
  const handle = await page.locator(".mini-drag-bar > span").boundingBox();
  await page.mouse.move(handle.x + 30, handle.y + 15);
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + 95, { steps: 8 });
  await page.mouse.up();
  const moved = await page.locator(".youtube-mini").boundingBox();
  assert.ok(moved.x < miniAfter.x && moved.y > miniAfter.y);
  assert.equal(
    await page.evaluate(
      () => window.originalIframe === document.querySelector("iframe"),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  if (await page.evaluate(() => !!window.documentPictureInPicture)) {
    // Playwright routing stalls external scripts in a native Document PiP target.
    // Install the same provider stub in that window; the native window and app
    // lifecycle remain real. Official SDK loading is a separate network check.
    await page.evaluate((stub) => {
      const api = window.documentPictureInPicture;
      const open = api.requestWindow.bind(api);
      api.requestWindow = async (options) => {
        const win = await open(options);
        win.__pipTest = true;
        win.eval(stub);
        return win;
      };
    }, youtubeStub);
    await page
      .getByRole("button", { name: "Картинка в картинке", exact: true })
      .click();
    await page.waitForFunction(() =>
      documentPictureInPicture.window?.document.querySelector(
        ".playback-controls",
      ),
    );
    assert.equal(await page.locator(".youtube-player-shell").isHidden(), true);
    assert.ok(
      await page.evaluate(() =>
        documentPictureInPicture.window.ytCalls.includes("play"),
      ),
    );
    await page.evaluate(() => {
      const win = documentPictureInPicture.window;
      win.document.querySelector('button[aria-label="Пауза"]').click();
    });
    await page.waitForFunction(() =>
      documentPictureInPicture.window.document.querySelector(
        'button[aria-label="Продолжить просмотр"]',
      ),
    );
    await page.evaluate(() => documentPictureInPicture.window.close());
    await page.locator(".youtube-player-shell").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "Продолжить просмотр", exact: true })
      .waitFor();
    await page.waitForTimeout(3400);
    assert.equal(
      await page.getByRole("button", { name: "Пауза", exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Продолжить просмотр", exact: true })
      .click();
    console.log(
      "PASS: native Document PiP opens with a separate SDK, pauses original and resumes on close",
    );
  }
  await page.getByRole("button", { name: "Мини-плеер", exact: true }).click();
  data.event.state = "stopping";
  data.media.finishUntil = Date.now() + 300000;
  await push();
  await page.getByText("Досматриваем эфир", { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(
      () => window.originalIframe === document.querySelector("iframe"),
    ),
  );
  if (await page.evaluate(() => !!window.documentPictureInPicture)) {
    await page
      .getByRole("button", { name: "Картинка в картинке", exact: true })
      .click();
    await page.waitForFunction(() =>
      documentPictureInPicture.window?.document.querySelector(
        ".playback-controls",
      ),
    );
  }
  // Exhausting the grace period must close even a paused/minimized video.
  data.media.finishUntil = Date.now() - 1;
  await push();
  await page
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  assert.equal(await page.locator("iframe, .youtube-mini").count(), 0);
  assert.equal(
    await page.evaluate(() => !!window.documentPictureInPicture?.window),
    false,
  );
  data.event.state = "live";
  delete data.media.finishUntil;
  await page.setViewportSize({ width: 390, height: 844 });
  data.media.provider = "railway";
  data.media.playlist = "/api/events/viewer-status-test/recordings/recording";
  await push();
  await page.locator("video").waitFor();
  assert.equal(await page.locator(".chat-compose").count(), 1);
  assert.equal(await page.locator(".viewer-live-dot").count(), 1);
  await page.locator("video").evaluate((el) => {
    window.playbackEvents = [];
    for (const name of [
      "play",
      "playing",
      "pause",
      "ended",
      "emptied",
      "loadeddata",
    ])
      el.addEventListener(name, () =>
        window.playbackEvents.push({ name, time: el.currentTime }),
      );
  });
  // Playback should start without a click (muted fallback if required).
  await page.waitForFunction(
    () => document.querySelector("video")?.currentTime > 0,
  );
  assert.equal(
    await page.locator("video").evaluate((el) => el.controls),
    false,
  );
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  assert.equal(await page.locator("video").evaluate((el) => el.paused), true);
  await page
    .getByRole("button", { name: "Продолжить просмотр", exact: true })
    .click();
  await page.screenshot({ path: out + "/replay-mobile.png", fullPage: true });
  await page.evaluate(() => {
    window.oldVideo = document.querySelector("video");
    window.pipExited = false;
    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: window.oldVideo,
    });
    document.exitPictureInPicture = async () => {
      window.pipExited = true;
    };
  });
  data.event.state = "stopping";
  data.event.ctaVisible = false;
  data.event.ctaUrl = "https://example.org/offer";
  data.event.ctaTitle = "Специальное предложение";
  data.event.ctaDescription = "Условия для участников вебинара";
  await push();
  await page
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  assert.equal(await page.locator("video, iframe").count(), 0);
  assert.equal(await page.locator(".chat-compose").count(), 0);
  assert.ok(
    await page.evaluate(() => window.oldVideo.paused && window.pipExited),
  );
  await page.getByRole("link", { name: "Посмотреть предложение" }).waitFor();
  data.event.state = "ended";
  data.media.runId = null;
  data.recordings = [
    {
      id: "recording",
      hasFile: true,
      state: "ready",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  ];
  await push();
  await page.reload();
  await page
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  assert.equal(await page.locator("video, iframe").count(), 0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: out + `/finished-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator(".viewer-end-offer").scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  assert.ok(telemetryEvents.some((e) => e.kind === "cta_impression"));
  data.event.ctaUrl = "";
  await push();
  await page
    .getByText("Спасибо за участие! До встречи на следующих вебинарах")
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Посмотреть предложение" }).count(),
    0,
  );
  // Scheduled room waits for the presenter's explicit launch, never auto-starts.
  data.event.state = "scheduled";
  data.event.startsAt = new Date(Date.now() + 2 * 3600000).toISOString();
  data.media.playlist = null;
  await push();
  await page.getByText(/До начала/).waitFor();
  assert.equal(await page.locator("video, iframe").count(), 0);
  data.event.startsAt = new Date(Date.now() - 1000).toISOString();
  await push();
  await page.getByText("Начнём, как только подключится ведущий").waitFor();
  assert.equal(await page.locator("video, iframe").count(), 0);
  assert.ok(telemetryEvents.some((e) => e.kind === "room_presence"));
  assert.ok(telemetryEvents.some((e) => e.kind === "play"));
  data.event.state = "live";
  data.media.runId = "fallback-run";
  data.media.provider = "youtube";
  const fallbackPage = await browser.newPage();
  fallbackPage.on("pageerror", (e) => errors.push(e.message));
  await fallbackPage.route("https://www.youtube.com/iframe_api", (r) =>
    r.abort(),
  );
  const fallbackReferrers = [];
  await fallbackPage.route("https://www.youtube-nocookie.com/**", async (r) => {
    fallbackReferrers.push((await r.request().allHeaders()).referer);
    await r.fulfill({
      contentType: "text/html",
      body: "<p>Standard player fallback</p>",
    });
  });
  await fallbackPage.goto("http://127.0.0.1:4327/room/ui");
  await fallbackPage.getByTitle("Прямой эфир YouTube").waitFor();
  assert.equal(await fallbackPage.locator(".playback-controls").count(), 0);
  assert.doesNotMatch(
    await fallbackPage.locator("iframe").getAttribute("src"),
    /controls=0/,
  );
  assert.deepEqual(fallbackReferrers, ["http://127.0.0.1:4327/"]);
  await fallbackPage
    .getByRole("button", { name: "Мини-плеер", exact: true })
    .click();
  await fallbackPage.locator(".youtube-mini").waitFor();
  await fallbackPage
    .locator(".youtube-mini-actions")
    .getByRole("button", { name: "Вернуть видео на место" })
    .click();
  assert.equal(await fallbackPage.locator(".youtube-mini").count(), 0);
  await fallbackPage.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: YouTube waiting/error/live, iframe selection, end CTA, no replay/PiP teardown, countdown, read-only chat, 4 widths, reduced motion",
  );
} catch (error) {
  console.error(error);
  console.log(
    await page.evaluate(() => {
      const w = window.documentPictureInPicture?.window;
      return w
        ? {
            body: w.document.body.outerHTML,
            yt: !!w.YT,
            scripts: [...w.document.scripts].map((s) => s.src),
            calls: w.ytCalls,
          }
        : null;
    }),
  );
  console.log(await page.evaluate(() => window.playbackEvents));
  console.log(
    await page
      .locator("video")
      .evaluate(
        (el) => ({
          src: el.currentSrc,
          error: el.error?.message,
          readyState: el.readyState,
          paused: el.paused,
          time: el.currentTime,
        }),
        undefined,
        { timeout: 1000 },
      )
      .catch(() => null),
  );
  await page.screenshot({ path: out + "/failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
  for (const ws of sockets.clients) ws.terminate();
  sockets.close();
  await new Promise((r) => server.close(r));
}
