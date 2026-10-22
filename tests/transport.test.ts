import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioTransport } from "../src/transport.ts";

test("A stalled media handshake retries, while ready or disposed transports cancel the deadline", (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const keys = ["WebSocket", "location", "MediaRecorder"];
  const descriptors = keys.map((k) =>
    Object.getOwnPropertyDescriptor(globalThis, k),
  );
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    onclose?: (e: { code: number }) => void;
    onmessage?: (e: { data: string }) => void;
    closed = false;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close(code: number) {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    start() {}
  }
  let transport: StudioTransport | undefined;
  try {
    [Socket, { protocol: "https:", host: "test.invalid" }, Recorder].forEach(
      (value, i) =>
        Object.defineProperty(globalThis, keys[i], {
          configurable: true,
          value,
        }),
    );
    transport = new StudioTransport(
      "event",
      "tab",
      { stream: () => ({}) } as any,
      () => {},
    );
    transport.report = () => {};
    transport.connect();
    ctx.mock.timers.tick(15000);
    assert.equal(sockets[0].closed, true);
    assert.equal(transport.stopped, false);
    ctx.mock.timers.tick(1500);
    assert.equal(sockets.length, 2);
    sockets[1].onmessage?.({ data: JSON.stringify({ type: "media_ready" }) });
    ctx.mock.timers.tick(30000);
    assert.equal(
      sockets[1].closed,
      false,
      "Healthy transmission must outlive the handshake deadline",
    );
    transport.dispose();
    ctx.mock.timers.tick(60000);
    assert.equal(sockets.length, 2, "Disposal must not reconnect");
  } finally {
    transport?.dispose();
    keys.forEach((key, i) => {
      if (descriptors[i])
        Object.defineProperty(globalThis, key, descriptors[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
test("Media transport uses secure WebSocket on HTTPS and retains local HTTP support", () => {
  const ws = Object.getOwnPropertyDescriptor(globalThis, "WebSocket"),
    loc = Object.getOwnPropertyDescriptor(globalThis, "location");
  const urls: string[] = [];
  class Socket {
    constructor(url: string) {
      urls.push(url);
    }
    close() {}
  }
  try {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: Socket,
    });
    for (const [protocol, host] of [
      ["https:", "live.example.com"],
      ["http:", "127.0.0.1:4312"],
    ]) {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { protocol, host },
      });
      const transport = new StudioTransport(
        "event-id",
        "tab",
        {} as any,
        () => {},
      );
      transport.report = () => {};
      transport.connect();
      transport.dispose();
    }
    assert.deepEqual(urls, [
      "wss://live.example.com/ws/media?event=event-id",
      "ws://127.0.0.1:4312/ws/media?event=event-id",
    ]);
  } finally {
    if (ws) Object.defineProperty(globalThis, "WebSocket", ws);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    if (loc) Object.defineProperty(globalThis, "location", loc);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("A delayed MediaRecorder blob is split losslessly instead of disconnecting at 2 MB", async () => {
  const keys = ["WebSocket", "location", "MediaRecorder"];
  const descriptors = keys.map((k) =>
    Object.getOwnPropertyDescriptor(globalThis, k),
  );
  const chunks: Blob[] = [];
  let closed = false;
  let recorder: any;
  const rates: number[] = [];
  const frames: number[] = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    onmessage: any;
    onclose: any;
    send(b: Blob) {
      chunks.push(b);
    }
    close() {
      closed = true;
    }
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    ondataavailable: any;
    constructor(_stream: unknown, options: any) {
      rates.push(options.videoBitsPerSecond);
      recorder = this;
    }
    start() {}
    state = "inactive";
  }
  try {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: Socket,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "test.invalid" },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: Recorder,
    });
    const t = new StudioTransport(
      "event",
      "tab",
      {
        stream: () => ({}),
        setFrameRate: (fps: number) => frames.push(fps),
      } as any,
      () => {},
    );
    t.report = () => {};
    t.attempt = 3;
    t.connect();
    t.socket!.onmessage!({
      data: JSON.stringify({ type: "media_ready" }),
    } as any);
    assert.equal(
      t.attempt,
      3,
      "Handshake alone must not reset the reconnect budget",
    );
    const bytes = new Uint8Array(3 * 1024 * 1024 + 27);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    recorder.ondataavailable({ data: new Blob([bytes]) });
    assert.equal(closed, false);
    assert.ok(chunks.every((b) => b.size <= 256 * 1024));
    assert.deepEqual(
      new Uint8Array(await new Blob(chunks).arrayBuffer()),
      bytes,
    );
    // Initial pressure lowers frame rate without dropping audio/container bytes.
    t.quality.congestedAt = Date.now() - 4000;
    recorder.ondataavailable({ data: new Blob([new Uint8Array(200)]) });
    assert.equal(closed, false);
    assert.equal(t.quality.bitrate, 1_800_000);
    assert.equal(chunks.at(-1)!.size, 200);
    assert.deepEqual(frames, [25, 15]);
    // Retry a temporary busy sender; this must not become a permanent auth failure.
    t.socket!.onclose!({ code: 4009 } as any);
    assert.equal(t.stopped, false);
    assert.ok(t.timer);
    if (t.timer) clearTimeout(t.timer);
    t.connect();
    t.socket!.onmessage!({
      data: JSON.stringify({ type: "media_ready" }),
    } as any);
    assert.deepEqual(rates, [3_500_000, 1_800_000]);
    t.dispose();
  } finally {
    keys.forEach((k, i) => {
      if (descriptors[i]) Object.defineProperty(globalThis, k, descriptors[i]!);
      else Reflect.deleteProperty(globalThis, k);
    });
  }
});
