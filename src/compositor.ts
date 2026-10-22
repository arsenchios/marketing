import { MAX_SLIDES } from "../shared/presentation";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { defaultCameraBox, type CameraBox } from "../shared/camera";
import type { Stroke, Webinar } from "../shared/contracts";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const WIDTH = 1280,
  HEIGHT = 720;
export class Compositor {
  video = document.createElement("video");
  readonly broadcastCanvas = document.createElement("canvas");
  micStream: MediaStream | null = null;
  cameraStream: MediaStream | null = null;
  audio: AudioContext | null = null;
  destination: MediaStreamAudioDestinationNode | null = null;
  source: MediaStreamAudioSourceNode | null = null;
  gain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  muted = false;
  private privacyPaused = false;
  private awaitingDelivery = false;
  private cameraEnabled = true;
  get cameraOn() {
    return this.cameraEnabled;
  }
  set cameraOn(value: boolean) {
    this.cameraEnabled = value;
    this.applyPrivacy();
  }
  guestVideo = document.createElement("video");
  guestCameraOn = true;
  private guestSource: MediaStreamAudioSourceNode | null = null;
  private guestStream: MediaStream | null = null;
  peerStream() {
    if (!this.cameraStream || !this.micStream) return null;
    return new MediaStream([
      ...this.cameraStream.getVideoTracks(),
      ...this.micStream.getAudioTracks(),
    ]);
  }
  setGuest(stream: MediaStream | null) {
    this.guestSource?.disconnect();
    this.guestSource = null;
    this.guestStream = stream;
    this.guestVideo.muted = true;
    this.guestVideo.playsInline = true;
    this.guestVideo.srcObject = stream;
    if (stream) {
      void this.guestVideo.play().catch(() => {});
      if (this.audio && this.destination && stream.getAudioTracks().length) {
        this.guestSource = this.audio.createMediaStreamSource(stream);
        // Only to the recording bus; speakers hear each other through a separate audio element.
        this.guestSource.connect(this.destination);
      }
    }
  }
  cameraBox: CameraBox = { ...defaultCameraBox };
  private get renderCameraBox() {
    // Guest workspace is local: two compact tiles over the slides, independent
    // from the primary's camera placement in the actual broadcast.
    if (this.guestWorkspace) return { x: 0.78, y: 0.76, width: 0.20 };
    return this.guestStream
      ? { ...this.cameraBox, width: Math.min(this.cameraBox.width, 0.32) }
      : this.cameraBox;
  }
  strokes: Stroke[] = [];
  slideCanvas: HTMLCanvasElement | null = null;
  slide = 1;
  layout: "slides" | "camera" = "slides";
  pdf: pdfjs.PDFDocumentProxy | null = null;
  pages = 3;
  clock: Worker | null = null;
  private outputFps = 25;
  private lastFrame = 0;
  setFrameRate(fps: number) {
    this.outputFps = Math.max(10, Math.min(25, fps));
  }
  capture: MediaStream | null = null;
  renderGeneration = 0;
  private renderQueue: Promise<unknown> = Promise.resolve();
  private renderTask: pdfjs.RenderTask | null = null;
  disposed = false;
  constructor(
    public canvas: HTMLCanvasElement,
    public event: Webinar,
    public mirrorPreview = true,
    public guestWorkspace = false,
  ) {
    this.cameraBox = event.cameraBox || { ...defaultCameraBox };
    this.video.muted = true;
    this.video.playsInline = true;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.broadcastCanvas.width = WIDTH;
    this.broadcastCanvas.height = HEIGHT;
    this.clock = new Worker(new URL("./frame-clock.ts", import.meta.url), {
      type: "module",
    });
    this.clock.onmessage = () => {
      const now = performance.now();
      if (now - this.lastFrame < 1000 / this.outputFps - 2) return;
      this.lastFrame = now;
      this.draw();
    };
    this.draw();
  }
  async devices(camera?: string, mic?: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 25, max: 30 },
        facingMode: { ideal: "user" },
        ...(camera ? { deviceId: { exact: camera } } : {}),
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(mic ? { deviceId: { exact: mic } } : {}),
      },
    });
    try {
      if (this.disposed) throw new Error("Студия закрыта");
      if (!this.audio) {
        this.audio = new AudioContext({
          latencyHint: "playback",
          sampleRate: 48000,
        });
        this.destination = this.audio.createMediaStreamDestination();
        this.gain = this.audio.createGain();
        this.analyser = this.audio.createAnalyser();
        this.gain.connect(this.analyser);
        this.analyser.connect(this.destination);
      }
      await this.audio.resume();
      if (this.disposed) throw new Error("Студия закрыта");
      this.source?.disconnect();
      this.cameraStream?.getTracks().forEach((t) => t.stop());
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.cameraStream = new MediaStream(stream.getVideoTracks());
      this.micStream = new MediaStream(stream.getAudioTracks());
      this.source = this.audio.createMediaStreamSource(this.micStream);
      this.source.connect(this.gain!);
      this.applyPrivacy();
      if (this.guestStream) this.setGuest(this.guestStream);
      this.video.srcObject = this.cameraStream;
      await this.video.play();
      return await navigator.mediaDevices.enumerateDevices().catch(() => []);
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      throw error;
    }
  }
  mute(value: boolean) {
    this.muted = value;
    this.applyPrivacy();
  }
  // This is an output gate, independent of ordinary mute/camera controls.
  // Apply synchronously before opening any finish UI; device replacement and
  // transport reconnect must never bypass it.
  pauseForFinish(value: boolean) {
    this.privacyPaused = value;
    this.applyPrivacy();
    this.draw();
  }
  waitForDelivery(value: boolean) {
    this.awaitingDelivery = value;
    this.applyPrivacy();
    this.draw();
  }
  private applyPrivacy() {
    if (this.gain)
      this.gain.gain.value = this.privacyPaused || this.muted ? 0 : 1;
    this.destination?.stream.getAudioTracks().forEach((t) => {
      t.enabled = !this.privacyPaused && !this.awaitingDelivery;
    });
    this.micStream?.getAudioTracks().forEach((t) => {
      t.enabled = !this.privacyPaused && !this.muted;
    });
    this.cameraStream?.getVideoTracks().forEach((t) => {
      t.enabled = !this.privacyPaused && this.cameraOn;
    });
    this.capture?.getVideoTracks().forEach((t) => {
      t.enabled = !this.privacyPaused;
    });
  }
  volume() {
    if (!this.analyser) return 0;
    const values = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(values);
    return Math.min(
      1,
      Math.sqrt(
        values.reduce((a, v) => a + (v - 128) ** 2, 0) / values.length,
      ) / 35,
    );
  }
  private pdfGeneration = 0;
  async loadPdf(url: string) {
    const request = ++this.pdfGeneration;
    const pdf = await pdfjs.getDocument({ url, enableXfa: false }).promise;
    if (this.disposed || request !== this.pdfGeneration) {
      await pdf.loadingTask.destroy();
      return;
    }
    if (pdf.numPages > MAX_SLIDES) {
      await pdf.loadingTask.destroy();
      throw new Error("Максимум 400 страниц. Сократите PDF.");
    }
    const previous = this.pdf;
    this.renderTask?.cancel();
    this.pdf = pdf;
    this.pages = pdf.numPages;
    await this.setSlide(Math.min(this.slide, this.pages));
    if (previous !== pdf) await previous?.loadingTask.destroy();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.renderQueue.catch(() => {}).then(work);
    this.renderQueue = task.catch(() => {});
    return task;
  }
  async setSlide(n: number) {
    this.slide = n;
    const generation = ++this.renderGeneration;
    this.renderTask?.cancel();
    if (!this.pdf) {
      this.slideCanvas = null;
      return;
    }
    return this.enqueue(async () => {
      if (this.disposed || generation !== this.renderGeneration || !this.pdf)
        return;
      const page = await this.pdf.getPage(n);
      const canvas = document.createElement("canvas");
      try {
        if (this.disposed || generation !== this.renderGeneration) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(WIDTH / base.width, HEIGHT / base.height, 3),
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        this.renderTask = page.render({ canvas, viewport });
        await this.renderTask.promise;
        if (!this.disposed && generation === this.renderGeneration) {
          if (this.slideCanvas)
            this.slideCanvas.width = this.slideCanvas.height = 0;
          this.slideCanvas = canvas;
        }
      } catch (error) {
        if (
          (error as Error).name !== "RenderingCancelledException" &&
          !this.disposed
        )
          throw error;
      } finally {
        this.renderTask = null;
        if (this.slideCanvas !== canvas) canvas.width = canvas.height = 0;
        page.cleanup();
      }
    });
  }
  async thumbnail(n: number) {
    return this.enqueue(async () => {
      if (!this.pdf || this.disposed) return "";
      const page = await this.pdf.getPage(n);
      const canvas = document.createElement("canvas");
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(200 / base.width, 112 / base.height),
        });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        return canvas.toDataURL("image/jpeg", 0.7);
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    });
  }
  stream() {
    if (!this.destination)
      throw new Error("Сначала включите камеру и микрофон");
    this.capture?.getVideoTracks().forEach((t) => t.stop());
    this.capture = this.broadcastCanvas.captureStream(25);
    this.applyPrivacy();
    return new MediaStream([
      ...this.capture.getVideoTracks(),
      ...this.destination.stream.getAudioTracks(),
    ]);
  }
  draw() {
    const c = this.broadcastCanvas.getContext("2d")!;
    const guestVisible = !!this.guestStream && this.guestCameraOn && this.guestVideo.readyState >= 2;
    if (this.privacyPaused) {
      c.fillStyle = "#000";
      c.fillRect(0, 0, WIDTH, HEIGHT);
      this.canvas.getContext("2d")!.drawImage(this.broadcastCanvas, 0, 0);
      return;
    }
    if (this.awaitingDelivery) {
      c.fillStyle = "#181916";
      c.fillRect(0, 0, WIDTH, HEIGHT);
      c.save();
      c.fillStyle = "#e7dba9";
      c.textAlign = "center";
      c.font = "36px sans-serif";
      c.fillText("Трансляция скоро начнётся", WIDTH / 2, HEIGHT / 2);
      c.restore();
      this.canvas.getContext("2d")!.drawImage(this.broadcastCanvas, 0, 0);
      return;
    }
    c.fillStyle = "#eee9dc";
    c.fillRect(0, 0, WIDTH, HEIGHT);
    if (this.layout === "camera") {
      c.fillStyle = "#292b27";
      c.fillRect(0, 0, WIDTH, HEIGHT);
      if (this.video.readyState >= 2 && this.cameraOn)
        this.drawCamera(c, 0, 0, guestVisible ? WIDTH / 2 : WIDTH, HEIGHT);
    } else {
      if (this.slideCanvas) {
        const img = this.slideCanvas;
        const scale = Math.min(WIDTH / img.width, HEIGHT / img.height);
        c.drawImage(
          img,
          (WIDTH - img.width * scale) / 2,
          (HEIGHT - img.height * scale) / 2,
          img.width * scale,
          img.height * scale,
        );
      } else this.drawDemo(c);
      for (const s of this.strokes) {
        if (!s.points.length) continue;
        c.save();
        c.strokeStyle = s.color;
        c.lineWidth = s.width;
        c.lineCap = "round";
        c.lineJoin = "round";
        c.globalAlpha = s.width >= 10 ? 0.5 : 0.95;
        c.beginPath();
        s.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
        c.restore();
      }
      if (this.cameraOn) {
      const { x: nx, y: ny, width } = this.renderCameraBox;
      const x = nx * WIDTH,
        y = ny * HEIGHT,
        cw = width * WIDTH,
        ch = width * HEIGHT;
      c.save();
      c.beginPath();
      c.roundRect(x, y, cw, ch, 14);
      c.clip();
      c.fillStyle = "#292b27";
      c.fillRect(x, y, cw, ch);
      if (this.video.readyState >= 2 && this.cameraOn)
        this.drawCamera(c, x, y, cw, ch);
      else {
        c.fillStyle = "#d5b66f";
        c.font = "32px Georgia";
        c.textAlign = "center";
        c.fillText(
          this.event.hostName.slice(0, 1).toUpperCase(),
          x + cw / 2,
          y + ch / 2,
        );
        c.font = "12px sans-serif";
        c.fillStyle = "#b6b8ad";
        c.fillText("Камера выключена", x + cw / 2, y + ch / 2 + 30);
        c.textAlign = "left";
      }
      c.restore();
      }
    }
    if (guestVisible) {
      const full = this.layout === "camera";
      const width = this.renderCameraBox.width * WIDTH;
      const height = this.renderCameraBox.width * HEIGHT;
      const x = full
        ? (this.cameraOn ? WIDTH / 2 : 0)
        : this.renderCameraBox.x * WIDTH >= width + 12
          ? Math.max(0, this.renderCameraBox.x * WIDTH - width - 12)
          : Math.min(
              WIDTH - width,
              this.renderCameraBox.x * WIDTH + width + 12,
            );
      const y = full ? 0 : this.renderCameraBox.y * HEIGHT;
      c.save();
      c.beginPath();
      c.roundRect(
        x,
        y,
        full ? (this.cameraOn ? WIDTH / 2 : WIDTH) : width,
        full ? HEIGHT : height,
        full ? 0 : 14,
      );
      c.clip();
      this.drawCamera(
        c,
        x,
        y,
        full ? (this.cameraOn ? WIDTH / 2 : WIDTH) : width,
        full ? HEIGHT : height,
        this.guestVideo,
      );
      c.restore();
    }
    const preview = this.canvas.getContext("2d")!;
    preview.drawImage(this.broadcastCanvas, 0, 0);
    // Mirror only the local camera region; slides and the captured stream stay normal.
    if (this.mirrorPreview && this.cameraOn && this.video.readyState >= 2) {
      const full = this.layout === "camera";
      const x = full ? 0 : this.renderCameraBox.x * WIDTH;
      const y = full ? 0 : this.renderCameraBox.y * HEIGHT;
      const w = full
        ? guestVisible
          ? WIDTH / 2
          : WIDTH
        : this.renderCameraBox.width * WIDTH;
      const h = full ? HEIGHT : this.renderCameraBox.width * HEIGHT;
      preview.save();
      preview.beginPath();
      preview.roundRect(x, y, w, h, full ? 0 : 14);
      preview.clip();
      preview.translate(2 * x + w, 0);
      preview.scale(-1, 1);
      this.drawCamera(preview, x, y, w, h);
      preview.restore();
    }
  }
  drawCamera(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    v: HTMLVideoElement = this.video,
  ) {
    const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
    const sw = w / scale,
      sh = h / scale;
    c.drawImage(
      v,
      (v.videoWidth - sw) / 2,
      (v.videoHeight - sh) / 2,
      sw,
      sh,
      x,
      y,
      w,
      h,
    );
  }
  drawDemo(c: CanvasRenderingContext2D) {
    const accent = this.event.accent;
    c.fillStyle = "#eee9dc";
    c.fillRect(0, 0, WIDTH, HEIGHT);
    c.strokeStyle = "#c9c2ad";
    c.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      c.beginPath();
      c.arc(1100, 285, 170 + i * 43, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = accent;
    c.beginPath();
    c.arc(1040, 285, 78, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#232720";
    c.font = "500 19px sans-serif";
    c.fillText(
      this.event.brandName
        ? this.event.brandName.toUpperCase() + "  /  LIVE"
        : "ПРЯМОЙ ЭФИР",
      70,
      72,
    );
    const titles = [
      ["Тема вашего", "вебинара"],
      ["Основные", "вопросы"],
      ["Ответы на", "вопросы"],
    ];
    const title = titles[(this.slide - 1) % 3];
    c.font = "76px Georgia";
    c.fillText(title[0], 70, 275);
    c.fillText(title[1], 70, 365);
    c.fillStyle = "#666b60";
    c.font = "21px sans-serif";
    c.fillText("Пример слайда — загрузите свою презентацию", 73, 430);
    c.fillStyle = "#697060";
    c.font = "14px sans-serif";
    c.fillText("ТЕСТОВАЯ ПРЕЗЕНТАЦИЯ  ·  ЗАМЕНИТЕ СВОИМ PDF", 73, 650);
    c.fillText(`0${this.slide} / 03`, 735, 650);
  }
  dispose() {
    this.disposed = true;
    this.setGuest(null);
    ++this.renderGeneration;
    this.renderTask?.cancel();
    if (this.slideCanvas) this.slideCanvas.width = this.slideCanvas.height = 0;
    this.clock?.terminate();
    this.cameraStream?.getTracks().forEach((t) => t.stop());
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.capture?.getTracks().forEach((t) => t.stop());
    void this.audio?.close();
    void this.pdf?.loadingTask.destroy();
  }
}
