// Synthetic media only, two isolated accounts/browser contexts, no providers.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.ts";
import { initialEvent } from "../shared/contracts.ts";
process.env.SPEAKER_ICE_SERVERS = "[]"; // Loopback peers: no STUN/TURN/external requests.
const origin = "http://127.0.0.1:4332",
  dir = mkdtempSync(join(tmpdir(), "two-speakers-"));
const app = await createApp(dir, origin, { archiveTransport: null });
app.app.use(express.static(resolve("dist")));
app.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
await new Promise((r) => app.server.listen(4332, "127.0.0.1", r));
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const errors = [];
try {
  const event = await app.store.create("arslive", {
    ...initialEvent,
    title: "Два тестовых спикера",
    layout: "camera",
  });
  await app.store.update(event.id, { layout: "camera" });
  const contexts = [];
  for (const [id, color, freq] of [
    ["first", "#ff0000", 440],
    ["second", "#0000ff", 880],
  ]) {
    await app.store.db
      .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
      .run(id, "arslive", id, "host");
    const session = await app.store.newSession(id, null, id);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ["camera", "microphone"],
    });
    if (id === "first") await ctx.addCookies([{ name: "al_host", value: session, url: origin }]);
    await ctx.addInitScript(
      ({ color, freq }) => {
        const Recorder = MediaRecorder;
        window.MediaRecorder = class extends Recorder {
          constructor(stream, options) {
            super(stream, options);
            window.outputStream = stream;
          }
        };
        navigator.mediaDevices.getUserMedia = async () => {
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = 360;
          const draw = () => {
            const x = c.getContext("2d");
            x.fillStyle = color;
            x.fillRect(0, 0, 640, 360);
            x.fillStyle = "white";
            x.fillText(String(Date.now()), 10, 20);
          };
          draw();
          setInterval(draw, 40);
          const ac = new AudioContext(),
            osc = ac.createOscillator(),
            gain = ac.createGain(),
            dest = ac.createMediaStreamDestination();
          osc.frequency.value = freq;
          gain.gain.value = 0.12;
          osc.connect(gain).connect(dest);
          osc.start();
          await ac.resume();
          return new MediaStream([
            ...c.captureStream(25).getVideoTracks(),
            ...dest.stream.getAudioTracks(),
          ]);
        };
      },
      { color, freq },
    );
    if (process.env.STREAMLESS_TRACKS === "1") await ctx.addInitScript(() => {
      const Peer = RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        set ontrack(handler) {
          super.ontrack = (event) => handler({ track: event.track, streams: [] });
        }
      };
    });
    contexts.push(ctx);
  }
  const p = await contexts[0].newPage(),
    g = await contexts[1].newPage();
  for (const page of [p, g])
    page.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${origin}/studio/${event.id}`);
  await p.getByRole("button", { name: "Проверить камеру и звук" }).click();
  await p
    .getByText("Сохранение проверено", { exact: true })
    .waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: "Скрыть проверку", exact: true }).click();
  await p.getByRole("button",{name:"Ссылка для спикера",exact:true}).click();
  const invitation = await p.getByLabel("Ссылка приглашения").inputValue();
  await p.getByRole("button",{name:"Закрыть",exact:true}).click();
  await g.goto(invitation);
  await g.getByLabel("Ваше имя").fill("Второй спикер");
  await g.getByRole("button",{name:"Войти",exact:false}).click();
  mkdirSync("test-results/speakers",{recursive:true});
  await g.locator(".stage-preflight").waitFor();
  await g.screenshot({path:"test-results/speakers/guest-preflight.png",fullPage:true});
  await g.getByRole("button", {name:"Проверить камеру и звук",exact:true}).click();
  await g.getByRole("button",{name:"Присоединиться к ведущему",exact:true}).click();
  await p
    .getByText("Оба спикера подключены", { exact: true })
    .waitFor({ timeout: 30000 });
  await g.getByText("Оба спикера подключены", { exact: true }).waitFor();
  assert.equal(
    await g.getByRole("button", { name: "Начать эфир", exact: true }).count(),
    0,
  );
  await p.getByRole("button",{name:"Ссылка для спикера",exact:true}).click();
  await p.getByLabel("Разрешить управление слайдами и инструментами").uncheck();
  await g.waitForFunction(()=>document.querySelector('.slide-controls')?.disabled===true);
  assert.equal(await g.getByRole('button',{name:'Микрофон',exact:true}).isEnabled(),true);
  await p.getByLabel("Разрешить управление слайдами и инструментами").check();
  await g.waitForFunction(()=>document.querySelector('.slide-controls')?.disabled===false);
  await p.getByRole("button",{name:"Закрыть",exact:true}).click();
  console.log("PASS: primary controls guest interaction; own microphone remains available");
  await p.getByRole("button",{name:"Ссылка для ассистента",exact:true}).click();
  await p.waitForFunction(old=>document.querySelector('[aria-label="Ссылка приглашения"]')?.value !== old,invitation);
  const assistantLink=await p.getByLabel("Ссылка приглашения").inputValue();
  await p.getByRole("button",{name:"Закрыть",exact:true}).click();
  const assistantContext=await browser.newContext();
  const assistant=await assistantContext.newPage();
  assistant.on("pageerror",e=>errors.push(e.message));
  await assistant.goto(assistantLink);
  await assistant.getByLabel("Ваше имя").fill("Ассистент");
  await assistant.getByRole("button",{name:"Войти в студию",exact:true}).click();
  await assistant.locator(".upload-slide input").waitFor({state:"attached"});
  assert.equal(await assistant.getByRole("button",{name:"Начать эфир",exact:true}).count(),0);
  await assistant.locator(".upload-slide input").setInputFiles(resolve("public/demo/arslive-demo.pdf"));
  await assistant.locator(".deck-library").getByRole("button",{name:"Показать",exact:true}).waitFor();
  assert.equal((await app.store.event(event.id)).pdfId,null);
  assistant.once("dialog",d=>d.accept());
  await assistant.locator(".deck-library").getByRole("button",{name:"Показать",exact:true}).click();
  await assistant.getByRole("button",{name:"На экране",exact:true}).waitFor();
  assert.ok((await app.store.event(event.id)).pdfId);
  await assistantContext.close();
  console.log("PASS: anonymous assistant stages and explicitly shows deck; cannot start broadcast");
  await p.getByRole("button", { name: "Начать эфир", exact: true }).click();
  await p.waitForFunction(
    () =>
      window.outputStream &&
      window.outputStream.getVideoTracks()[0]?.readyState === "live",
  );
  assert.equal(await p.evaluate(() => window.outputStream.getAudioTracks()[0].enabled), false,
    "All outgoing audio stays silent while delivery is preparing");
  await p.getByText("Подключаем эфир…", {exact:true}).waitFor();
  assert.deepEqual(await p.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]');
    return Array.from(canvas.getContext("2d").getImageData(50, 50, 1, 1).data);
  }), [24, 25, 22, 255], "Preparing sends a neutral slate, not either speaker's camera");

  const until = async (fn, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error("timeout");
  };
  await until(() => app.media.current?.bytes > 10000);
  const run = app.media.current.record.id;
  await p.waitForFunction(() => window.outputStream.getAudioTracks()[0].enabled);
  await p.getByText("Подключаем эфир…", {exact:true}).waitFor({state:"hidden"});
  console.log("PASS: delivery preparation mutes output; confirmed ready releases both speakers");

  // Verify BOTH video inputs in actual outbound capture, not only the guest preview.
  const colors = await p.evaluate(async () => {
    const v = document.createElement("video");
    v.muted = true;
    v.srcObject = window.outputStream;
    await v.play();
    await new Promise((r) => setTimeout(r, 800));
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    c.getContext("2d").drawImage(v, 0, 0);
    return [
      Array.from(c.getContext("2d").getImageData(320, 360, 1, 1).data),
      Array.from(c.getContext("2d").getImageData(960, 360, 1, 1).data),
    ];
  });
  assert.ok(colors[0][0] > 180 && colors[0][2] < 50, JSON.stringify(colors));
  assert.ok(colors[1][2] > 180 && colors[1][0] < 50, JSON.stringify(colors));
  // Guest uses local scene composition, receiving only primary camera/audio.
  await g.waitForFunction(() => {
    const c = document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]');
    const ctx = c.getContext("2d");
    const left = ctx.getImageData(320, 360, 1, 1).data;
    const right = ctx.getImageData(960, 360, 1, 1).data;
    return left[2] > 180 && left[0] < 50 && right[0] > 180 && right[2] < 50;
  });
  console.log("PASS: guest workspace receives raw cameras, not a returned program stream");
  const tones = await p.evaluate(async () => {
    const ac = new AudioContext(),
      a = ac.createAnalyser();
    a.fftSize = 8192;
    ac.createMediaStreamSource(window.outputStream).connect(a);
    await ac.resume();
    await new Promise((r) => setTimeout(r, 600));
    const v = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(v);
    const level = (f) =>
      Math.max(
        ...v.slice(
          Math.floor(((f - 15) * a.fftSize) / ac.sampleRate),
          Math.ceil(((f + 15) * a.fftSize) / ac.sampleRate),
        ),
      );
    const result = [level(440), level(880), level(2000)];
    await ac.close();
    return result;
  });
  assert.ok(
    tones.slice(0, 2).every((v) => v > -65 && v > tones[2] + 15),
    JSON.stringify(tones),
  );
  const returnAudio = await g.evaluate(async () => {
    const stream = document.querySelector(".speaker-connection audio").srcObject;
    const ac = new AudioContext(),
      a = ac.createAnalyser();
    a.fftSize = 8192;
    ac.createMediaStreamSource(stream).connect(a);
    await ac.resume();
    await new Promise((r) => setTimeout(r, 600));
    const v = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(v);
    const level = (f) =>
      Math.max(
        ...v.slice(
          Math.floor(((f - 15) * a.fftSize) / ac.sampleRate),
          Math.ceil(((f + 15) * a.fftSize) / ac.sampleRate),
        ),
      );
    const result = [level(440), level(880)];
    await ac.close();
    return result;
  });
  assert.ok(
    returnAudio[0] > -65 && returnAudio[0] > returnAudio[1] + 20,
    JSON.stringify(returnAudio),
  );
  console.log(
    "PASS: guest receives primary microphone only, never the mixed signal containing their own voice",
    returnAudio,
  );
  console.log(
    "PASS: primary account and anonymous invited speaker, WebRTC video and both audio tones in ONE outbound stream",
    tones,
  );
  await g.getByTitle("Выключить микрофон", {exact:true}).click();
  await new Promise(r=>setTimeout(r,500));
  const mutedTones = await p.evaluate(async () => {
    const ac = new AudioContext(),
      a = ac.createAnalyser();
    a.fftSize = 8192;
    ac.createMediaStreamSource(window.outputStream).connect(a);
    await ac.resume();
    await new Promise((r) => setTimeout(r, 600));
    const v = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(v);
    const level = (f) =>
      Math.max(
        ...v.slice(
          Math.floor(((f - 15) * a.fftSize) / ac.sampleRate),
          Math.ceil(((f + 15) * a.fftSize) / ac.sampleRate),
        ),
      );
    const result = [level(440), level(880), level(2000)];
    await ac.close();
    return result;
  });
  assert.ok(mutedTones[0]>-65 && mutedTones[0]>mutedTones[1]+20, JSON.stringify(mutedTones));
  await g.getByTitle("Включить микрофон", {exact:true}).click();
  console.log("PASS: guest mute removes only guest voice from broadcast");
  await p.getByRole("button", {name:"Презентация и камера", exact:true}).click();
  await g.waitForFunction(() => {
    const ctx = document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]').getContext("2d");
    const host = ctx.getImageData(850, 600, 1, 1).data;
    const self = ctx.getImageData(1100, 600, 1, 1).data;
    const slide = ctx.getImageData(320, 360, 1, 1).data;
    return host[0] > 180 && host[2] < 50 && self[2] > 180 && self[0] < 50 && !(slide[2] > 180 && slide[0] < 50);
  });
  await g.getByTitle("Выключить камеру", {exact:true}).click();
  await p.waitForFunction(() => {
    const ctx = document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]').getContext("2d");
    const data = ctx.getImageData(0,0,1280,720).data;
    for(let i=0;i<data.length;i+=64) if(data[i+2]>180 && data[i]<50) return false;
    return true;
  });
  await g.waitForFunction(() => {
    const ctx = document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]').getContext("2d");
    const pixel=ctx.getImageData(1100,600,1,1).data;
    return !(pixel[2]>180 && pixel[0]<50) && pixel[0]>100;
  });
  await g.getByTitle("Включить камеру", {exact:true}).click();
  await g.waitForFunction(() => {
    const pixel=document.querySelector('canvas[aria-label="Композиция: презентация, рисунки и камера"]').getContext("2d").getImageData(1100,600,1,1).data;
    return pixel[2]>180 && pixel[0]<50;
  });
  console.log("PASS: guest camera hides from host broadcast and local slides, then returns");
  assert.equal(await g.getByText("Положение камеры", {exact:true}).isVisible(), false);
  console.log("PASS: guest slides fill stage with both cameras in compact lower-right tiles");
  mkdirSync("test-results/speakers", { recursive: true });
  await g.screenshot({path:"test-results/speakers/guest-studio.png",fullPage:true});
  await p.screenshot({
    path: "test-results/speakers/primary.png",
    fullPage: true,
  });
  for (const width of [390, 768]) {
    await g.setViewportSize({ width, height: 900 });
    assert.equal(
      await g.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await g
    .getByRole("button", { name: "Микрофон", exact: true })
    .click();
  await g.getByRole("button", { name: "Отключиться", exact: true }).click();
  await p.getByText("Ожидаем второго спикера", { exact: true }).waitFor();
  assert.equal(app.media.current.record.id, run);
  await g.getByRole("button", {name:"Проверить камеру и звук",exact:true}).click();
  await g.getByRole("button",{name:"Присоединиться к ведущему",exact:true}).click();
  await p
    .getByText("Оба спикера подключены", { exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(app.media.current.record.id, run);
  console.log(
    "PASS: guest disconnect/rejoin preserves broadcast run; mobile 390/768 has no overflow",
  );
  await p.getByRole("button", { name: "Завершить эфир", exact: true }).click();
  await p
    .getByRole("button", { name: "Завершить и сохранить", exact: true })
    .click();
  const rec = await until(async () => {
    const r = (await app.store.recordings(event.id))[0];
    return r?.hasFile && r;
  }, 45000);
  assert.equal(rec.state, "ready");
  assert.ok(rec.duration > 3);
  assert.ok(rec.bytes > 1000);
  assert.deepEqual(errors, []);
  console.log("PASS: clean combined recording after guest reconnect", {
    duration: rec.duration,
    bytes: rec.bytes,
  });
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
