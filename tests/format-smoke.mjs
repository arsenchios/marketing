import { chromium } from "playwright";
import assert from "node:assert/strict";
// Real MediaRecorder/FFmpeg on an isolated server; this is not an iOS device test.
const base = process.env.TEST_ORIGIN || "http://127.0.0.1:4316";
assert.equal(new URL(base).hostname, "127.0.0.1");
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  for (const format of ["webm", "mp4"]) {
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 390, height: 844 },
    });
    if (format === "mp4")
      await context.addInitScript(() => {
        const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
        MediaRecorder.isTypeSupported = (type) =>
          !type.includes("webm") && supported(type);
      });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const handshakes = [];
    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws/media"))
        ws.on("framesent", (frame) => {
          try {
            const msg = JSON.parse(String(frame.payload));
            if (msg.format) handshakes.push(msg.format);
          } catch {}
        });
    });
    await page.goto(base);
    await page
      .getByRole("button", { name: "Войти в кабинет", exact: true })
      .click();
    await page.getByRole("heading", { name: "Ваши вебинары" }).waitFor();
    const event = await page.evaluate(
      async (format) =>
        (
          await fetch("/api/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: `Synthetic ${format}` }),
          })
        ).json(),
      format,
    );
    const url = `/api/events/${event.id}`;
    const room = () =>
      page.evaluate(async (url) => (await fetch(url)).json(), url);
    const poll = async (pred) => {
      for (let i = 0; i < 100; i++) {
        const r = await room();
        if (pred(r)) return r;
        await page.waitForTimeout(500);
      }
      throw Error("Media timeout " + format);
    };
    await page.goto(`${base}/studio/${event.id}`);
    await page
      .getByRole("button", { name: "Проверить камеру и звук", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Начать эфир", exact: true })
      .click();
    await poll((r) => r.media.bytes > 0 && r.media.playlist);
    assert.equal(handshakes[0], format);
    const viewer = await context.newPage();
    await viewer.goto(`${base}/room/${event.slug}`);
    await viewer.getByLabel("Ваше имя").fill("Synthetic viewer");
    await viewer
      .getByRole("button", { name: "Войти в комнату", exact: true })
      .click();
    await viewer.locator("video").waitFor();
    await viewer.locator("video").evaluate((v) => v.play());
    await viewer.waitForFunction(
      () => document.querySelector("video")?.currentTime > 2,
    );
    await page.waitForTimeout(7000);
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await page
      .getByRole("button", { name: "Завершить и сохранить", exact: true })
      .click();
    const final = await poll((r) => !r.media.runId && r.recordings[0]?.hasFile);
    assert.equal(final.recordings[0].state, "ready");
    assert.ok(final.recordings[0].duration > 5);
    await viewer.waitForFunction(
      () =>
        document
          .querySelector("video")
          ?.getAttribute("src")
          ?.includes("recordings") ||
        document.querySelector("video")?.currentTime > 0,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        format,
        recording: final.recordings[0].state,
        duration: final.recordings[0].duration,
        errors,
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
}
