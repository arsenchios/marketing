import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Run only against an isolated local server. Camera/audio are synthetic.
const base = process.env.TEST_ORIGIN || "http://127.0.0.1:4312";
assert.equal(new URL(base).hostname, "127.0.0.1");
const out = resolve("test-results/browser");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const host = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["camera", "microphone"],
});
const viewerContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await host.addInitScript(() => {
  const Recorder = window.MediaRecorder;
  window.MediaRecorder = class extends Recorder {
    constructor(stream, options) {
      super(stream, options);
      window.recordedStream = stream;
    }
  };
});
let page = await host.newPage();
const viewer = await viewerContext.newPage();
const errors = [];
for (const p of [page, viewer])
  p.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "warning") console.log(m.text());
});
const report = {};
async function json(page, path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      return d;
    },
    { path, method, body },
  );
}
async function poll(page, path, predicate, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const d = await json(page, path);
    if (predicate(d)) return d;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout: " + path);
}
try {
  await page.goto(base);
  await page.getByRole("button", { name: "Войти в кабинет" }).click();
  await page.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
  let w = await json(page, "/api/events", "POST", {
    title: "Проверка платформы",
    ctaTitle: "Открыть материал",
    ctaUrl: "https://example.com/",
    description:
      "Синтетическая репетиция. Реальные устройства и внешние сервисы не используются.",
  });
  let endpoint = `/api/events/${w.id}`;
  await page.goto(`${base}/event/${w.id}`);
  await page.getByText("Оформление и презентация", { exact: false }).click();
  await page
    .locator("input[type=file]")
    .nth(2)
    .setInputFiles(
      resolve(process.env.TEST_PRESENTATION || "public/demo/arslive-demo.pdf"),
    );
  await poll(page, endpoint, (d) => !!d.event.pdfId, 200000);
  await page.screenshot({ path: out + "/event-desktop.png", fullPage: true });
  await page.goto(`${base}/studio/${w.id}`);
  await page.getByRole("button", { name: "Проверить камеру и звук" }).waitFor();
  await page.getByAltText("Слайд 1").waitFor();
  if (process.env.LARGE_DECK_SMOKE === "1") {
    assert.equal(await page.locator(".slide-thumb").count(), 400);
    for (const n of [400, 200, 50, 350, 100, 1]) {
      await page
        .getByRole("spinbutton", { name: "Перейти к слайду" })
        .fill(String(n));
      await page
        .getByRole("spinbutton", { name: "Перейти к слайду" })
        .press("Enter");
      await poll(page, endpoint, (d) => d.event.slide === n);
      await page.getByAltText(`Слайд ${n}`, { exact: true }).waitFor();
      assert.ok((await page.locator(".slide-thumb img").count()) <= 24);
    }
    for (const n of [398, 399, 400, 2, 1])
      await page
        .locator(".slide-thumb")
        .nth(n - 1)
        .click({ force: true });
    await poll(page, endpoint, (d) => d.event.slide === 1);
    await page.getByAltText("Слайд 1", { exact: true }).waitFor();
    report.largeDeck = {
      slides: 400,
      thumbnailImages: await page.locator(".slide-thumb img").count(),
    };
    console.log(
      "PASS: 400-slide PPTX upload, direct/rapid navigation, thumbnail working set <= 24",
    );
  }
  await page.screenshot({ path: out + "/studio-desktop.png", fullPage: true });
  const cb = await page.locator(".chat-panel").boundingBox();
  const sb = await page.locator(".studio-main").boundingBox();
  assert.ok(cb.x < sb.x);
  await page
    .getByRole("button", { name: "Большой экран", exact: true })
    .click();
  assert.ok(await page.locator(".studio-page.is-focused").count());
  await page.getByRole("slider", { name: "Ширина чата" }).fill("400");
  const wideChat = await page.locator(".chat-panel").boundingBox();
  assert.ok(wideChat.width >= 395);
  await page
    .getByRole("button", { name: "Скрыть мой чат", exact: true })
    .click();
  assert.equal(await page.locator(".chat-panel").isVisible(), false);
  await page.getByRole("button", { name: /Показать мой чат/ }).click();
  await page.screenshot({ path: out + "/studio-focus.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".studio-page.is-focused").count(), 0);
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `studio overflow ${width}`,
    );
    assert.equal(await page.locator(".studio-chat").isVisible(), false);
    await page.getByRole("button", { name: /Показать мой чат/ }).click();
    const mobileChat = await page.locator(".studio-chat").boundingBox();
    assert.ok(
      mobileChat.height < 900 && mobileChat.y >= 0,
      `chat sheet ${width}`,
    );
    await page
      .getByRole("button", { name: "Закрыть чат", exact: true })
      .click();
  }
  await page.screenshot({ path: out + "/studio-tablet.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("slider", { name: "Ширина чата" }).fill("290");
  console.log(
    "PASS: focus mode, hide chat, resize chat, Escape, 320/390/768/1024 responsive studio",
  );

  await page.getByRole("button", { name: "Проверить камеру и звук" }).click();
  await page.getByText("Сохранение проверено", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Проверить микрофон" }).click();
  await page.locator(".microphone-check audio").waitFor({ timeout: 10000 });
  const voice = page.locator(".microphone-check audio");
  await voice.evaluate(async (audio) => {
    await audio.play();
  });
  await page.waitForFunction(() => {
    const audio = document.querySelector(".microphone-check audio");
    return audio && audio.currentTime > 0.2 && audio.readyState >= 2;
  });
  await voice.evaluate((audio) => audio.pause());
  console.log(
    "PASS: microphone sample records and plays locally before broadcast",
  );
  let preflight = await json(page, endpoint);
  assert.equal(preflight.recordings.length, 0);
  assert.equal(preflight.media.runId, null);
  assert.equal(preflight.event.state, "draft");
  await page
    .getByRole("button", { name: "Скрыть проверку", exact: true })
    .click();
  await page.locator(".camera-settings > summary").click();
  await page.getByRole("button", { name: "Слева сверху", exact: true }).click();
  await poll(page, endpoint, (d) => d.event.cameraBox?.x === 0.03);
  await page.locator(".camera-position").scrollIntoViewIfNeeded();
  const camera = await page.locator(".camera-position").boundingBox();
  await page.mouse.move(
    camera.x + camera.width / 2,
    camera.y + camera.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    camera.x + camera.width / 2 + 70,
    camera.y + camera.height / 2 + 30,
    { steps: 5 },
  );
  await page.mouse.up();
  await poll(page, endpoint, (d) => d.event.cameraBox?.x > 0.05);
  await page.getByLabel("Размер камеры", { exact: true }).press("End");
  await poll(page, endpoint, (d) => d.event.cameraBox?.width === 0.55);
  await page.getByRole("button", { name: "Справа снизу", exact: true }).click();
  await page.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await page
    .getByRole("button", { name: "Отменить запуск", exact: true })
    .click();
  // Delivery-gated start sends a muted slate immediately. Cancelling closes that
  // run; it no longer cancels a local countdown without creating a recording.
  preflight = await poll(page, endpoint, d => !d.media.runId && ["ended", "failed"].includes(d.event.state));
  assert.equal(preflight.recordings.length, 1);
  assert.equal(preflight.media.runId, null);
  console.log(
    "PASS: preflight creates no recording; cancelled delivery start closes its run; camera drag/resize persists",
  );
  await page.getByRole("button", { name: "Вернуть в ожидание", exact: true }).click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.getByRole("button", { name: "Вернуть с прежней ссылкой" }).click(),
  ]);
  preflight = await json(page, endpoint);
  await page.getByRole("button", { name: "Проверить камеру и звук" }).click();
  await page.getByText("Сохранение проверено", { exact: true }).waitFor();
  await json(page, endpoint, "PATCH", {
    ...preflight.event,
    startsAt: new Date(Date.now() + 7200000).toISOString(),
  });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await page
    .getByRole("heading", { name: "Начать раньше назначенного времени?" })
    .waitFor();
  await page.getByRole("button", { name: "Продолжить подготовку" }).click();
  assert.equal((await json(page, endpoint)).media.runId, null);
  await page.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await page
    .getByRole("button", { name: "Начать сейчас", exact: true })
    .click();
  console.log(
    "PASS: early start explicitly confirmed; cancelling does not create a run",
  );
  let stream = await poll(
    page,
    endpoint,
    (d) => !!d.media.playlist && d.media.bytes > 0,
  );
  report.firstRun = stream.media.runId;
  console.log("PASS: PDF + camera/audio → FFmpeg → HLS");
  const helper = await host.newPage();
  helper.on("pageerror", (e) => errors.push(e.message));
  await helper.goto(`${base}/assist/${w.id}`);
  await helper.locator(".upload-slide input").waitFor({ state: "attached" });
  assert.equal(
    await helper
      .getByRole("button", { name: "Завершить эфир", exact: true })
      .count(),
    0,
  );
  assert.equal(await helper.evaluate(() => !!window.recordedStream), false);
  const oldDeck = stream.event.pdfId;
  helper.once("dialog", (d) => d.accept());
  await helper
    .locator(".upload-slide input")
    .setInputFiles(resolve("public/demo/arslive-demo.pdf"));
  await helper.locator(".deck-library").getByRole("button", {name:"Показать",exact:true}).last().click();
  await poll(
    page,
    endpoint,
    (d) => d.event.pdfId !== oldDeck && d.media.runId === report.firstRun,
  );
  await helper
    .getByRole("button", { name: "Следующий слайд", exact: true })
    .click();
  await poll(page, endpoint, (d) => d.event.slide === 2);
  await page
    .getByRole("button", { name: "Предыдущий слайд", exact: true })
    .click();
  await poll(helper, endpoint, (d) => d.event.slide === 1);
  await helper.close();
  console.log(
    "PASS: helper replaces live deck and shares slide controls without acquiring camera or replacing run",
  );

  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  const rect = await page.locator("canvas").boundingBox();
  await page.mouse.move(rect.x + 100, rect.y + rect.height * 0.54);
  await page.mouse.down();
  await page.mouse.move(rect.x + 300, rect.y + rect.height * 0.55, {
    steps: 20,
  });
  await page.mouse.up();
  await poll(page, endpoint, (d) => d.event.annotations["1"]?.length === 1);
  await page.getByRole("button", { name: "Следующий слайд" }).click();
  await poll(page, endpoint, (d) => d.event.slide === 2);
  await page.getByRole("button", { name: "Предыдущий слайд" }).click();
  await page.getByRole("button", { name: "Показать предложение" }).click();
  await viewer.goto(`${base}/room/${w.slug}`);
  await viewer.getByLabel("Ваше имя").fill("Тестовый зритель");
  await viewer.getByRole("button", { name: "Войти в комнату" }).click();
  await viewer.locator("video").waitFor();
  // Live playback starts without a manual click.
  await viewer.waitForFunction(
    () => document.querySelector("video")?.currentTime > 0,
  );
  assert.ok(
    await viewer
      .locator("video")
      .evaluate((v) => v.videoWidth === 1280 && v.videoHeight === 720),
  );
  // Rendering must continue even when requestAnimationFrame stops (hidden-tab behavior).
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  const frameA = await page.locator("canvas").evaluate((c) => c.toDataURL());
  await new Promise((r) => setTimeout(r, 1500));
  assert.notEqual(
    await page.locator("canvas").evaluate((c) => c.toDataURL()),
    frameA,
  );
  const timeBefore = await viewer
    .locator("video")
    .evaluate((v) => v.currentTime);
  await new Promise((r) => setTimeout(r, 30000));
  const continuous = await json(page, endpoint);
  assert.equal(continuous.media.runId, report.firstRun);
  assert.ok(continuous.media.playlist.includes("/1/"));
  assert.equal(continuous.recordings[0].interrupted, false);
  assert.ok(
    await viewer
      .locator("video")
      .evaluate((v, t) => !v.paused && v.currentTime > t + 15, timeBefore),
  );
  await viewer.getByRole("button", { name: "Пауза", exact: true }).click();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await viewer.locator("video").evaluate((v) => v.paused), true);
  await viewer.locator("video").evaluate((v) => v.play());
  console.log(
    "PASS: composition without RAF, continuous playback for 30 seconds, deliberate pause preserved",
  );
  await viewer.getByRole("link", { name: "Открыть материал" }).waitFor();
  await viewer.getByLabel("Сообщение в чат").fill("<b>Проверка чата</b>");
  await viewer.getByRole("button", { name: "Отправить сообщение" }).click();
  await page.getByText("<b>Проверка чата</b>", { exact: true }).waitFor();
  assert.equal(await viewer.locator(".message p b").count(), 0);
  await viewer.screenshot({
    path: out + "/viewer-desktop.png",
    fullPage: true,
  });
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.screenshot({ path: out + "/viewer-mobile.png", fullPage: true });
  assert.equal(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  const vb = await viewer.locator(".viewer-content").boundingBox();
  const chat = await viewer.locator(".chat-panel").boundingBox();
  assert.ok(vb.y < chat.y);
  report.chatAndMobile = "passed";
  console.log(
    "PASS: viewer playback, shared chat as text, CTA, desktop/mobile ordering",
  );
  await page
    .getByRole("button", { name: "Завершить эфир", exact: true })
    .click();
  await page.getByRole("timer").waitFor();
  const privateOutput = await page.evaluate(async () => {
    const stream = window.recordedStream;
    const canvas = document.querySelector('canvas[aria-label^="Композиция"]');
    const rgb = [...canvas.getContext("2d").getImageData(640, 360, 1, 1).data];
    const audio = new AudioContext();
    await audio.resume();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    source.connect(analyser);
    await new Promise((r) => setTimeout(r, 250));
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const peak = Math.max(...samples.map(Math.abs));
    source.disconnect();
    await audio.close();
    return { disabled: stream.getTracks().every((t) => !t.enabled), rgb, peak };
  });
  assert.equal(privateOutput.disabled, true);
  assert.deepEqual(privateOutput.rgb, [0, 0, 0, 255]);
  assert.ok(
    privateOutput.peak < 0.00001,
    "recorded audio is silent during finish grace",
  );
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Вернуться в эфир" }).click();
  assert.equal(
    await page.evaluate(() =>
      window.recordedStream.getTracks().every((t) => t.enabled),
    ),
    true,
  );
  await page.waitForTimeout(10000);
  assert.equal((await json(page, endpoint)).media.runId, report.firstRun);
  assert.equal((await json(page, endpoint)).event.state, "live");
  console.log(
    "PASS: first finish click gates audio/video immediately; explicit return restores the same recording",
  );
  await page
    .getByRole("button", { name: "Завершить эфир", exact: true })
    .click();
  let lostStopReply = false;
  let finishLostReply;
  const lostReplyDone = new Promise((resolve) => {
    finishLostReply = resolve;
  });
  await page.route(`**${endpoint}/stop`, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 202);
    lostStopReply = true;
    await route.abort("failed");
    finishLostReply();
  });
  await page.getByRole("button", { name: "Завершить и сохранить" }).click();
  const finished = await poll(
    page,
    endpoint,
    (d) => !d.media.runId && d.recordings[0]?.hasFile,
  );
  assert.equal(finished.recordings[0].state, "ready");
  await page.locator(".archive-layout").waitFor({ timeout: 20000 });
  // The WebSocket can finalize and publish the archive before the HTTP acknowledgement arrives.
  await Promise.race([
    lostReplyDone,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Missing stop acknowledgement")),
        20000,
      ),
    ),
  ]);
  assert.equal(
    lostStopReply,
    true,
    "finish response was lost but the room recovered",
  );
  await page.unroute(`**${endpoint}/stop`);
  assert.ok(finished.recordings[0].duration > 1);
  report.cleanRecording = finished.recordings[0];
  const tailSnapshot = await (
    await viewer.request.get(base + `/api/room/${finished.event.slug}`)
  ).json();
  assert.ok(tailSnapshot.media.finishUntil > Date.now());
  const tailResponse = await viewer.request.get(
    base + tailSnapshot.media.playlist,
  );
  assert.equal(tailResponse.status(), 200);
  assert.match(await tailResponse.text(), /#EXT-X-ENDLIST/);
  const lateContext = await browser.newContext();
  const lateJoin = await lateContext.request.post(
    base + `/api/room/${finished.event.slug}/join`,
    { headers: { origin: base }, data: { name: "Поздний зритель" } },
  );
  assert.equal(lateJoin.status(), 200);
  assert.equal(
    (
      await lateContext.request.get(base + tailSnapshot.media.playlist)
    ).status(),
    403,
  );
  const lateSnapshot = await (
    await lateContext.request.get(base + `/api/room/${finished.event.slug}`)
  ).json();
  assert.equal(lateSnapshot.media.playlist, null);
  assert.deepEqual(lateSnapshot.recordings, []);
  await lateContext.close();

  await viewer
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  assert.equal(await viewer.locator("video, iframe").count(), 0);
  const recordingUrl = `${endpoint}/recordings/${finished.recordings[0].id}`;
  assert.equal((await viewer.request.get(base + recordingUrl)).status(), 401);
  const archivePlayer = await host.newPage();
  await archivePlayer.goto(base);
  await archivePlayer.evaluate(async (src) => {
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    document.body.append(video);
    await video.play();
  }, recordingUrl);
  await archivePlayer.waitForFunction(
    () => document.querySelector("video")?.currentTime > 0,
  );
  await archivePlayer.close();
  console.log(
    "PASS: finished MP4 plays for host; viewer finishes buffered tail and cannot replay",
  );
  const publicLink = viewer.url();
  const anonymous = await browser.newPage();
  await anonymous.goto(`${base}/room/${finished.event.slug}`);
  await anonymous
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Вернуть в ожидание", exact: true })
    .click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.getByRole("button", { name: "Вернуть с прежней ссылкой" }).click(),
  ]);
  w = (await json(page, endpoint)).event;
  assert.equal(w.slug, finished.event.slug);
  assert.equal(w.state, "draft");
  assert.equal(
    (await json(page, endpoint)).recordings[0].id,
    report.cleanRecording.id,
  );
  await viewer
    .getByRole("heading", { name: "Вебинар завершён", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(viewer.url(), publicLink);
  assert.equal(await viewer.locator("video,iframe").count(), 0);
  await anonymous.getByLabel("Ваше имя").waitFor({ timeout: 15000 });
  await anonymous.close();
  console.log(
    "PASS: same link returns joined and anonymous viewers to waiting without reload; first recording retained",
  );
  await page.getByRole("button", { name: "Проверить камеру и звук" }).click();
  await page.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await page
    .getByRole("button", { name: "Начать сейчас", exact: true })
    .click();
  const before = await poll(
    page,
    endpoint,
    (d) => !!d.media.playlist && d.media.bytes > 0,
  );
  const runId = before.media.runId;
  assert.notEqual(runId, report.firstRun);
  assert.equal(before.recordings.length, 3);
  assert.equal(before.recordings[1].id, report.cleanRecording.id);
  assert.equal(viewer.url(), publicLink);
  await viewer.locator("video").waitFor();
  await viewer.waitForFunction(
    () => document.querySelector("video")?.currentTime > 0,
  );
  // Close the original tab completely, then return with the same login cookies.
  const studioUrl = page.url();
  await page.close();
  page = await host.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "warning") console.log(m.text());
  });
  await page.goto(studioUrl);
  await page
    .getByRole("button", { name: "Включить камеру и микрофон" })
    .waitFor();
  await poll(page, endpoint, (d) => d.event.state === "reconnecting");
  await new Promise((r) => setTimeout(r, 65000));
  // More than the former one-minute timeout: a new tab can resume the same run.
  assert.equal((await json(page, endpoint)).media.runId, runId);
  await page
    .getByRole("button", { name: "Включить камеру и микрофон" })
    .click();
  const response = await json(page, endpoint + "/start", "POST", {
    expectedReopenedAt: w.reopenedAt,
    tabId: await page.evaluate(
      (id) => sessionStorage.getItem("studio-tab:" + id),
      w.id,
    ),
    commandId: crypto.randomUUID(),
    mode: "broadcast",
  });
  assert.equal(response.runId, runId);
  // UI resume is tested below once the corresponding control is visible.
  await page.getByRole("button", { name: "Возобновить передачу" }).click();
  const resumed = await poll(
    page,
    endpoint,
    (d) => d.media.playlist?.includes("/2/") && d.media.receiving,
  );
  assert.equal(resumed.media.runId, runId);
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && !v.paused && v.currentTime > 0;
    },
    {},
    { timeout: 30000 },
  );
  console.log("PASS: viewer automatically resumes after sender reconnect");
  // Simulate a sustained browser upload queue, retaining real MediaRecorder/FFmpeg/HLS.
  await page.evaluate(() => {
    const get = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "bufferedAmount",
    ).get;
    window.testCongestion = true;
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      configurable: true,
      get() {
        return window.testCongestion && this.url.includes("/ws/media")
          ? 2 * 1024 * 1024
          : get.call(this);
      },
    });
  });
  await poll(page, endpoint + "/diagnostics", (d) =>
    d.entries.some((e) => e.kind === "quality_reduced"),
  );
  // Persistent pressure must eventually start a fresh lower-bitrate container.
  const adaptive = await poll(
    page,
    endpoint,
    (d) => d.media.playlist?.includes("/3/") && d.media.receiving,
  );
  await page.evaluate(() => {
    window.testCongestion = false;
  });
  assert.equal(adaptive.media.runId, runId);
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && !v.paused && v.currentTime > 0 && v.readyState >= 3;
    },
    {},
    { timeout: 30000 },
  );
  console.log(
    "PASS: sustained upload queue reduces quality and viewer resumes on the same run",
  );
  await new Promise((r) => setTimeout(r, 5000));
  await page
    .getByRole("button", { name: "Завершить эфир", exact: true })
    .click();
  await page.getByRole("timer").waitFor(); // Allow automatic completion after 10 seconds.
  const gap = await poll(
    page,
    endpoint,
    (d) => !d.media.runId && d.recordings[0]?.hasFile,
  );
  assert.equal(gap.recordings[0].state, "incomplete");
  report.recoveredRecording = gap.recordings[0];
  console.log(
    "PASS: new tab + 65-second source gap resumes a single run; final recording marked incomplete",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Создать копию", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Включить камеру и микрофон" })
      .count(),
    0,
  );
  assert.equal(await page.locator(".chat-compose").count(), 0);
  const persisted = await json(page, endpoint);
  assert.deepEqual(persisted.event.annotations, finished.event.annotations); // Restoring preserves materials and drawings.
  assert.deepEqual(errors, []);
  const diagnostics = await json(page, endpoint + "/diagnostics");
  assert.ok(diagnostics.entries.some((e) => e.kind === "encoder_started"));
  assert.ok(diagnostics.entries.some((e) => e.kind === "media_closed"));
  await page.screenshot({ path: out + "/archive.png", fullPage: true });
  report.errors = errors;
  report.passed = true;
  writeFileSync(out + "/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(e);
  report.viewer = await viewer
    .locator("video")
    .evaluate((v) => ({
      time: v.currentTime,
      paused: v.paused,
      ready: v.readyState,
      network: v.networkState,
      error: v.error?.message,
      nativeHls: v.canPlayType("application/vnd.apple.mpegurl"),
    }))
    .catch(() => null);
  console.error("Viewer state", report.viewer);
  report.error = e.message;
  report.errors = errors;
  writeFileSync(out + "/report.json", JSON.stringify(report, null, 2));
  await page.screenshot({ path: out + "/failure.png", fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
}
