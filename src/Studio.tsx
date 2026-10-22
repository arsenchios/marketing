import { platformBrand } from "../shared/brand";
import { InvitationsPanel } from "./InvitationsPanel";
import { DeckLibrary } from "./DeckLibrary";
import { guestMode } from "./api";
import { SpeakerPanel } from "./Speakers";
import { FinishConfirmation, ReopenWebinar } from "./BroadcastSafety";
import { Player } from "./Viewer";
import { YouTubePlayer } from "./YouTubePlayer";
import {
  MAX_SLIDES,
  thumbnailWindow,
  cacheThumbnail,
} from "../shared/presentation";
import {
  BroadcastIdentity,
  RecordingStorageStatus,
  YouTubeRecordingLink,
} from "./BroadcastIdentity";
import { DevicePicker } from "./DevicePicker";
import { ArchiveContent } from "./Archive";
import { studioCompatibility } from "./studio-capabilities";
import { useStudioLayout } from "./useStudioLayout";
import { StudioPreflight } from "./StudioPreflight";
import { StudioEngagement } from "./StudioEngagement";
import { recordingExpired, retentionText } from "../shared/retention";
import { displayLabel } from "./ui";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  Mic,
  Users,
  Plus,
  Minus,
  MicOff,
  Video,
  VideoOff,
  Play,
  Square,
  Pencil,
  Hand,
  X,
  Eraser,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Presentation,
  Camera,
  SlidersHorizontal,
  CheckCircle2,
  Circle,
  Upload,
  Radio,
  Download,
  CircleHelp,
  Highlighter,
  Maximize2,
  Minimize2,
  MessageSquare,
} from "lucide-react";
import { Compositor, WIDTH, HEIGHT } from "./compositor";
import { StudioTransport } from "./transport";
import { api, useRoom, send, assetUrl, dateLabel } from "./api";
import { Header, Chat, Badge, Notice, CopyButton, Modal } from "./ui";
import { HelpDialog } from "./Guide";
import {
  defaultCameraBox,
  fitCameraBox,
  type CameraBox,
} from "../shared/camera";
import type { Stroke, Webinar } from "../shared/contracts";
import { CameraPosition } from "./CameraPosition";
const ignorePlayback = () => {};
export function Studio({
  id,
  support = false,
  coSpeaker = false,
}: {
  id: string;
  support?: boolean;
  coSpeaker?: boolean;
}) {
  const room = useRoom(id);
  const invited=guestMode();
  const [permissions, setPermissions] = useState<{
    broadcast: boolean;
    control: boolean;
  } | null>(null);
  const [permissionError, setPermissionError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () => api(`/api/events/${id}/permissions`)
      .then((p) => {
        if (!cancelled) setPermissions(p);
      })
      .catch(() => {
        if (!cancelled)
          setPermissionError("Не удалось проверить доступ. Обновите страницу");
      });
    void load();
    const timer=setInterval(load,3000);
    return () => {
      clearInterval(timer);
      cancelled = true;
    };
  }, [id]);
  if (!permissions)
    return (
      <main className="page">{permissionError || "Открываем студию…"}</main>
    );
  support = support || !permissions.broadcast;
  if (invited && room.data?.event.state === "ended") return <main className="page"><h1>Вебинар завершён</h1><p>Спасибо за участие</p></main>;
  if (room.data?.event.state === "ended")
    return (
      <ArchiveContent
        data={room.data}
        connected={room.connected}
        support={support}
      />
    );
  return (
    <ActiveStudio
      key={room.data?.event.reopenedAt || id}
      id={id}
      room={room}
      coSpeaker={coSpeaker}
      support={support}
      control={permissions.control}
    />
  );
}
function ActiveStudio({
  id,
  room,
  support,
  coSpeaker,
  control,
}: {
  id: string;
  room: ReturnType<typeof useRoom>;
  support: boolean;
  coSpeaker: boolean;
  control: boolean;
}) {
  const { data, error, connected, refresh } = room;
  const invited=guestMode();
  const [deckRevision,setDeckRevision]=useState(0);
  const [guestJoined,setGuestJoined]=useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const slideStrip = useRef<HTMLDivElement>(null);
  const compositor = useRef<Compositor | null>(null);
  const transport = useRef<StudioTransport | null>(null);
  const [watchLive, setWatchLive] = useState(!coSpeaker);
  const [toolsVisible, setToolsVisible] = useState(true);
  const [thumbSize, setThumbSize] = useState(112);
  const [chatDraft, setChatDraft] = useState<{ id: string; text: string }>();
  const [ready, setReady] = useState(false);
  const [cameraBox, setCameraBox] = useState<CameraBox>({
    ...defaultCameraBox,
  });
  const [awaitingDelivery, setAwaitingDelivery] = useState(false);
  const [heard, setHeard] = useState(false);
  const [cloudCheck, setCloudCheck] = useState("");
  const [recordCheck, setRecordCheck] = useState<
    "idle" | "checking" | "ready" | "failed"
  >("idle");
  const [recordBlocker, setRecordBlocker] = useState<{ message: string; url: string } | null>(null);
  const [readiness, setReadiness] = useState<{
    ffmpeg: boolean;
    canStart: boolean;
    mode: string;
  } | null>(null);
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [checksVisible, setChecksVisible] = useState(true);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [network, setNetwork] = useState("idle");
  const [networkLabel, setNetworkLabel] = useState("");
  const [micTesting, setMicTesting] = useState(false);
  const uploadMbps = useRef<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [earlyWarning, setEarlyWarning] = useState(false);
  const earlyApproved = useRef<string | null>(null);
  const [help, setHelp] = useState(false);
  const thumbnailCache = useRef(new Map<number, string>());
  const [deckLoaded, setDeckLoaded] = useState(false);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [pages, setPages] = useState(3);
  const [slide, setSlide] = useState(1);
  const [layout, setLayout] = useState<"slides" | "camera">("slides");
  const [tool, setTool] = useState<"pointer" | "pen" | "marker">("pointer");
  const [color, setColor] = useState("#d09232");
  const [volume, setVolume] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const stroke = useRef<Stroke | null>(null);
  const annotations = useRef<Webinar["annotations"]>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabId = useRef(
    sessionStorage.getItem(`studio-tab:${id}`) || crypto.randomUUID(),
  );
  const w = data?.event;
  const active = !!data?.media.runId;
  const processing = w?.state === "stopping";
  useEffect(() => {
    if (!awaitingDelivery || !data || data.media.runId !== transport.current?.runId) return;
    if (["stopping", "ended", "failed"].includes(data.event.state)) {
      setAwaitingDelivery(false);
      return;
    }
    const media = data.media;
    const available = media.receiving && (media.provider === "youtube"
      ? media.youtube?.phase === "live"
      : !!media.playlist);
    if (available) {
      compositor.current?.waitForDelivery(false);
      setAwaitingDelivery(false);
      setMessage("Эфир начался — можно говорить. Зрители получают видео с небольшой задержкой");
    }
  }, [awaitingDelivery, data]);

  const view = useStudioLayout(active);
  const compatibility = studioCompatibility();
  const canLaunch = !!(
    ready &&
    (coSpeaker || (camera && heard && !muted)) &&
    (coSpeaker || recordCheck === "ready") &&
    ["ready", "warn"].includes(network) &&
    (coSpeaker || readiness?.canStart) &&
    !micTesting &&
    !checking &&
    !busy &&
    !compatibility
  );
  useEffect(() => {
    sessionStorage.setItem(`studio-tab:${id}`, tabId.current);
  }, [id]);
  useEffect(() => {
    if (!w || !canvas.current || compositor.current) return;
    const c = new Compositor(canvas.current, w, !support || coSpeaker, coSpeaker);
    compositor.current = c;
    setCameraBox(c.cameraBox);
    c.slide = w.slide;
    c.layout = w.layout;
    setSlide(w.slide);
    setLayout(w.layout);
    annotations.current = w.annotations;
    c.strokes = w.annotations[String(w.slide)] || [];
    const meter = setInterval(() => {
      const level = c.volume();
      setVolume(level);
      if (level > 0.035) setHeard(true);
      setTick(Date.now());
      if (c.micStream?.getAudioTracks().some((t) => t.readyState === "ended")) {
        setReady(false);
        setProblem("Микрофон отключён. Выберите устройство снова");
      }
    }, 300);
    return () => {
      clearInterval(meter);
      transport.current?.dispose();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      c.dispose();
      compositor.current = null;
    };
  }, [!!w, id]);
  useEffect(() => {
    const c = compositor.current;
    if (!c || !w?.pdfId) return;
    let cancelled = false;
    setDeckLoaded(false);
    thumbnailCache.current.clear();
    setThumbs({});
    c.loadPdf(assetUrl(id, w.pdfId))
      .then(() => {
        if (!cancelled && !c.disposed) {
          setPages(c.pages);
          setDeckLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setProblem(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [w?.pdfId, id]);
  useEffect(() => {
    const c = compositor.current;
    if (!w || !c) return;
    setSlide(w.slide);
    setLayout(w.layout);
    c.layout = w.layout;
    annotations.current = w.annotations;
    c.strokes = w.annotations[String(w.slide)] || [];
    if (w.cameraBox) {
      c.cameraBox = fitCameraBox(w.cameraBox);
      setCameraBox(c.cameraBox);
    }
    void c.setSlide(w.slide).catch((e) => setProblem(e.message));
  }, [
    w?.slide,
    w?.layout,
    JSON.stringify(w?.annotations),
    JSON.stringify(w?.cameraBox),
    deckLoaded,
  ]);
  useEffect(() => {
    const c = compositor.current;
    if (!deckLoaded || !c) return;
    let cancelled = false;
    void (async () => {
      for (const n of thumbnailWindow(slide, pages)) {
        if (cancelled || c.disposed) return;
        if (!thumbnailCache.current.has(n)) {
          const thumb = await c.thumbnail(n);
          if (cancelled || c.disposed) return;
          if (thumb) cacheThumbnail(thumbnailCache.current, n, thumb);
        } else
          cacheThumbnail(
            thumbnailCache.current,
            n,
            thumbnailCache.current.get(n)!,
          );
        setThumbs(Object.fromEntries(thumbnailCache.current));
      }
    })().catch((e) => {
      if (!cancelled && !c.disposed) setProblem((e as Error).message);
    });
    return () => {
      cancelled = true;
    };
  }, [deckLoaded, slide, pages]);
  useEffect(() => {
    const listener = () => {
      setHidden(document.hidden);
      if (transport.current && !transport.current.stopped)
        transport.current.report(
          document.hidden ? "tab_hidden" : "tab_visible",
        );
    };
    document.addEventListener("visibilitychange", listener);
    const before = (e: BeforeUnloadEvent) => {
      if (transport.current && !transport.current.stopped) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      document.removeEventListener("visibilitychange", listener);
      window.removeEventListener("beforeunload", before);
    };
  }, []);
  useEffect(() => {
    const devicesChanged = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    };
    navigator.mediaDevices?.addEventListener("devicechange", devicesChanged);
    return () =>
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        devicesChanged,
      );
  }, []);
  useEffect(() => {
    api(`/api/events/${id}/readiness`)
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }, [id]);
  function updateCameraBox(next: CameraBox) {
    const box = fitCameraBox(next);
    setCameraBox(box);
    if (compositor.current) compositor.current.cameraBox = box;
  }
  function insertChat(text: string) {
    view.setChatVisible(true);
    setChatDraft({ id: crypto.randomUUID(), text });
  }
  async function testRecording() {
    setRecordBlocker(null);
    setRecordCheck("checking");
    setProblem("");
    try {
      const result = await send(`/api/events/${id}/preflight`);
      setCloudCheck(
        result.cloud === "ready"
          ? "Сохранение и скачивание записи проверены"
          : "Сохранение на сервере проверено",
      );
      setRecordCheck("ready");
    } catch (e) {
      setRecordCheck("failed");
      setProblem((e as Error).message);
      const failure = e as Error & { recoveryUrl?: string };
      if (failure.recoveryUrl) setRecordBlocker({ message: failure.message, url: failure.recoveryUrl });
    }
  }
  async function activate(cam = cameraId, mic = micId) {
    if (support && !coSpeaker) return;
    if (compatibility) {
      setProblem(compatibility);
      return;
    }
    setProblem("");
    setBusy(true);
    try {
      const list = await compositor.current!.devices(cam, mic);
      setDevices(list);
      setReady(true);
      setCameraId(cam);
      setMicId(mic);
      setHeard(false);
      setMessage("Камера и микрофон готовы");
      const c = compositor.current!;
      for (const track of [
        ...(c.cameraStream?.getTracks() || []),
        ...(c.micStream?.getTracks() || []),
      ]) {
        track.addEventListener(
          "ended",
          () => {
            setReady(false);
            setProblem(
              "Камера или микрофон отключились. Подключите устройство и включите его снова — завершать эфир не нужно",
            );
          },
          { once: true },
        );
      }
      return true;
    } catch (error) {
      setReady(
        !!compositor.current?.micStream
          ?.getAudioTracks()
          .some((t) => t.readyState === "live"),
      );
      console.warn("Device activation failed", error);
      setProblem(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Нет доступа к камере или микрофону. Разрешите их в настройках браузера и повторите"
          : "Не удалось включить устройства. Попробуйте ещё раз или выберите другую камеру и микрофон",
      );
    } finally {
      setBusy(false);
    }
  }
  async function runChecks() {
    if (checkingRef.current || (active && !coSpeaker)) return;
    checkingRef.current = true;
    setChecking(true);
    setProblem("");
    try {
      if (!ready && !(await activate())) return;
      setNetwork("checking");
      setNetworkLabel("Отправляем тестовый пакет…");
      try {
        const rates: number[] = [];
        let local = false;
        // Random content prevents intermediary compression from inflating the estimate.
        const bytes = crypto.getRandomValues(new Uint8Array(65536));
        const payload = Array.from(bytes, (b) =>
          b.toString(16).padStart(2, "0"),
        )
          .join("")
          .repeat(2);
        for (let i = 0; i < 3; i++) {
          const began = performance.now();
          const result = await api(`/api/events/${id}/connection-check`, {
            method: "POST",
            body: JSON.stringify({ payload }),
            signal: AbortSignal.timeout(10000),
          });
          local = result.local;
          rates.push(
            (result.bytes * 8) /
              Math.max(0.001, (performance.now() - began) / 1000) /
              1e6,
          );
          setNetworkLabel(`Проверяем отправку… ${i + 1}/3`);
        }
        const speed = Math.min(...rates);
        uploadMbps.current = local ? null : speed;
        setNetwork(!local && speed < 5 ? "warn" : "ready");
        setNetworkLabel(
          local
            ? "Локальная проверка — скорость интернета не измерена"
            : `Около ${speed.toFixed(1)} Мбит/с · ${speed < 2 ? "слабая связь, возможны паузы" : speed < 5 ? "средняя связь, снизим качество видео" : "хорошая связь"}`,
        );
      } catch {
        setNetwork("failed");
        setNetworkLabel("Нет ответа — повторите проверку");
      }
      if (!coSpeaker) await testRecording();
      setReadiness(await api(`/api/events/${id}/readiness`));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }
  useEffect(()=>{
    if(coSpeaker && (processing || w?.state === "ended")) {
      compositor.current?.cameraStream?.getTracks().forEach(t=>t.stop());
      compositor.current?.micStream?.getTracks().forEach(t=>t.stop());
      setReady(false);setGuestJoined(false);
    }
  },[coSpeaker,processing,w?.state]);
  async function stage(changes: object) {
    if (!control) return;
    try {
      await send(`/api/events/${id}/stage`, changes, "PATCH");
    } catch (e) {
      setProblem((e as Error).message);
    }
  }
  async function changeSlide(n: number) {
    const c = compositor.current;
    if (!control || n < 1 || n > pages || !c) return;
    setSlide(n);
    c.strokes = annotations.current[String(n)] || [];
    try {
      await c.setSlide(n);
      if (!c.disposed && c.slide === n) void stage({ slide: n });
    } catch (e) {
      if (!c.disposed) setProblem((e as Error).message);
    }
  }
  function changeLayout(l: "slides" | "camera") {
    if (!control) return;
    setLayout(l);
    if (compositor.current) compositor.current.layout = l;
    void stage({ layout: l });
  }
  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(WIDTH, ((e.clientX - r.left) / r.width) * WIDTH)),
      Math.max(0, Math.min(HEIGHT, ((e.clientY - r.top) / r.height) * HEIGHT)),
    ];
  }
  function persist() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void stage({ annotations: annotations.current }),
      500,
    );
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!control || tool === "pointer" || layout === "camera" || !compositor.current)
      return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const list = annotations.current[String(slide)] || [];
    if (list.length >= 150) {
      setProblem("Очистите рисунки на этом слайде, чтобы продолжить");
      return;
    }
    stroke.current = {
      color,
      width: tool === "marker" ? 18 : 4,
      points: [point(e)],
    };
    annotations.current[String(slide)] = [...list, stroke.current];
    compositor.current.strokes = annotations.current[String(slide)];
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (stroke.current && stroke.current.points.length < 2000)
      stroke.current.points.push(point(e));
  }
  function up() {
    if (stroke.current) {
      const finished=stroke.current;
      stroke.current = null;
      if(control) void send(`/api/events/${id}/annotations`,{slide,stroke:finished}).catch(e=>setProblem(e.message));
    }
  }
  function requestLaunch() {
    if (Date.parse(w!.startsAt) > Date.now() + 60000) setEarlyWarning(true);
    else void start();
  }
  async function start() {
    if (support) return;
    setProblem("");
    setBusy(true);
    setAwaitingDelivery(true);
    compositor.current?.waitForDelivery(true);
    try {
      const previousQuality = transport.current?.quality.level || 0;
      transport.current?.dispose();
      const t = new StudioTransport(
        id,
        tabId.current,
        compositor.current!,
        setMessage,
      );
      if (uploadMbps.current !== null) {
        t.quality.level =
          uploadMbps.current < 2 ? 2 : uploadMbps.current < 5 ? 1 : 0;
      }
      t.quality.level = Math.max(previousQuality, t.quality.level);
      transport.current = t;
      await t.start({
        earlyStartConfirmed: earlyApproved.current === w!.startsAt,
        expectedReopenedAt: w!.reopenedAt || null,
      });
    } catch (e) {
      setAwaitingDelivery(false);
      compositor.current?.waitForDelivery(false);
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (support) return;
    compositor.current?.pauseForFinish(true);
    setAwaitingDelivery(false);
    setConfirm(false);
    setProblem("");
    setBusy(true);
    try {
      if (transport.current && !transport.current.stopped)
        await transport.current.stop();
      else
        await api(`/api/events/${id}/stop`, {
          method: "POST",
          body: JSON.stringify({ runId: data!.media.runId }),
          signal: AbortSignal.timeout(15000),
        });
      await refresh();
    } catch {
      const current = await refresh();
      if (
        current &&
        ["stopping", "ended", "failed"].includes(current.event.state)
      ) {
        setMessage("Эфир завершён. Состояние записи показано ниже");
      } else {
        setProblem(
          "Не удалось подтвердить завершение. Проверьте интернет и нажмите «Завершить эфир» ещё раз — повторное нажатие безопасно. Повторное завершение не удаляет запись",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const latest = data?.recordings[0];
  const duration =
    active && latest
      ? Math.max(
          0,
          Math.floor(
            ((latest.stoppedAt ? Date.parse(latest.stoppedAt) : tick) -
              Date.parse(latest.createdAt)) /
              1000,
          ),
        )
      : 0;
  const clock = `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
  useEffect(() => {
    const strip = slideStrip.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!strip || !current || !toolsVisible) return;
    const box = strip.getBoundingClientRect();
    const thumb = current.getBoundingClientRect();
    if (thumb.left < box.left + 8)
      strip.scrollLeft -= box.left + 8 - thumb.left;
    else if (thumb.right > box.right - 8)
      strip.scrollLeft += thumb.right - box.right + 8;
  }, [slide, thumbSize, toolsVisible]);
  if (!data)
    return (
      <>
        {!invited && <Header studio />}
        <main className="page">
          <Notice>{error || "Открываем студию…"}</Notice>
          <a href="/">Вернуться к вебинарам</a>
        </main>
      </>
    );
  return (
    <>
      {!invited && <Header studio />}
      <main
        className={`studio-page ${view.focused ? "is-focused" : ""}`}
        style={{ "--chat-width": `${view.chatWidth}px` } as React.CSSProperties}
      >
        {!invited && <div className="breadcrumb">
          <a href={coSpeaker ? "/" : support ? "/admin" : `/event/${id}`}>
            <ArrowLeft size={14} /> Вебинар
          </a>
          <span>/</span>
          <span>
            {coSpeaker
              ? "Второй спикер"
              : support
                ? "Помощь ведущему"
                : "Студия ведущего"}
          </span>
        </div>
        }
        <div className="page-heading studio-heading">
          <div>
            <div className="eyebrow">
              {coSpeaker
                ? "ВТОРОЙ СПИКЕР"
                : support
                  ? "ПОМОЩЬ ВЕДУЩЕМУ"
                  : "СТУДИЯ ВЕДУЩЕГО"}
            </div>
            <h1>{displayLabel(w!.title)}</h1>
          </div>
        </div>
        {support && !invited && (
          <Notice>
            Вы помогаете ведущему: слайды, предложение, чат и выбор сервера
            доступны. Камеру, микрофон и запуск эфира контролирует ведущий
          </Notice>
        )}
        {!invited && w?.state === "failed" && (
          <ReopenWebinar
            event={w}
            latest={data.recordings[0]}
            support={support}
          />
        )}
        {!support && compatibility && (
          <Notice tone="error">{compatibility}</Notice>
        )}
        {(problem || error) && <Notice tone="error">{problem || error}
          {recordBlocker?.message === problem && <p><a className="btn quiet small" href={recordBlocker.url} target="_blank" rel="noreferrer">Открыть активную студию</a></p>}
        </Notice>}
        {hidden && active && (
          <Notice>
            Держите студию на переднем плане. Фоновая вкладка и сон компьютера
            могут прервать видео
          </Notice>
        )}
        <div className="studio-view-controls">
          <button
            className="btn quiet"
            aria-pressed={view.focused}
            onClick={() => view.setFocused(!view.focused)}
          >
            {view.focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}{" "}
            {view.focused ? "Обычный вид" : "Большой экран"}
          </button>
          <button
            className="btn quiet"
            aria-pressed={view.chatVisible}
            onClick={() => view.setChatVisible(!view.chatVisible)}
          >
            <MessageSquare size={17} />{" "}
            {view.chatVisible
              ? "Скрыть мой чат"
              : `Показать мой чат · ${data.messages.length}`}
          </button>
          <button
            className="btn quiet"
            aria-pressed={toolsVisible}
            onClick={() => setToolsVisible(!toolsVisible)}
          >
            <SlidersHorizontal size={16} />
            {toolsVisible ? "Скрыть инструменты" : "Показать инструменты"}
          </button>
          <div className="studio-audience-links">
            {!invited && <InvitationsPanel id={id}/>}
            <CopyButton
              label="Ссылка для зрителей"
              value={`${location.origin}/room/${w!.slug}`}
            />
            <a
              className="btn quiet"
              href={`/room/${w!.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              Посмотреть как зритель
            </a>
          {!support && active ? (
            <button
              className="btn danger"
              disabled={busy || processing}
              onClick={() => {
                compositor.current?.pauseForFinish(true);
                setConfirm(true);
              }}
            >
              <Square size={15} />
              {processing ? "Сохраняем…" : "Завершить эфир"}
            </button>
          ) : null}
          </div>
        </div>
        <div className="studio-session-status">
            {coSpeaker && <div className="speaker-session-bar"><span>{guestJoined ? "Вы в студии как спикер" : "Вы — спикер"}{!control && " · Ведущий временно отключил управление"}</span>{guestJoined && <button className="btn quiet small" onClick={()=>{setGuestJoined(false);setChecksVisible(true);compositor.current?.cameraStream?.getTracks().forEach(t=>t.stop());compositor.current?.micStream?.getTracks().forEach(t=>t.stop());setReady(false);}}>Отключиться</button>}</div>}
            {(!support || coSpeaker) && (
              <SpeakerPanel
                id={id}
                tab={tabId.current}
                compositor={compositor}
                ready={ready && (!coSpeaker || guestJoined)}
                role={coSpeaker ? "guest" : "primary"}
              />
            )}
        </div>
        <div
          className={`broadcast-grid ${view.chatVisible ? "" : "chat-hidden"}`}
          style={
            { "--chat-width": `${view.chatWidth}px` } as React.CSSProperties
          }
        >
          <div
            className={`studio-chat ${view.mobile && view.chatVisible ? "mobile-chat-open" : ""}`}
            hidden={!view.chatVisible}
            data-mobile-chat={
              view.mobile && view.chatVisible ? "open" : undefined
            }
          >
            <div className="mobile-chat-bar">
              <strong>Чат вебинара</strong>
              <button
                className="icon-btn"
                aria-label="Закрыть чат"
                onClick={() => view.setChatVisible(false)}
              >
                <X size={18} />
              </button>
            </div>
            <Chat
              event={w!}
              messages={data.messages}
              online={data.online}
              audienceScenario={data.audienceScenario}
              attendees={data.attendees}
              connected={connected}
              draftRequest={chatDraft}
              shortcuts={
                <>
                  <StudioEngagement
                    event={w!}
                    refresh={refresh}
                    section="templates"
                    onInsert={insertChat}
                  />
                </>
              }
              footer={
                !view.mobile && (
                  <label className="chat-width-control studio-chat-width">
                    <span>
                      Ширина чата <output>{view.chatWidth}</output>
                    </span>
                    <input
                      type="range"
                      aria-label="Ширина чата"
                      min="240"
                      max="440"
                      step="5"
                      value={view.chatWidth}
                      onChange={(e) =>
                        view.setChatWidth(Number(e.target.value))
                      }
                    />
                  </label>
                )
              }
            />
          </div>
          <section className="studio-main">
            <div className="stage-heading">
              <div>
                {active &&
                data.media.provider === "youtube" &&
                data.media.youtube?.phase !== "live" ? (
                  <a className="badge" href="#delivery-status">
                    {data.media.youtube?.phase === "error"
                      ? "YouTube: нет трансляции"
                      : "Подключаем YouTube"}
                  </a>
                ) : (
                  <Badge state={w!.state} />
                )}
                <span className="stage-caption">
                  {processing
                    ? "Сохраняем запись"
                    : active
                      ? "Запись идёт"
                      : support
                        ? "Подготовка вместе с ведущим"
                        : "Видно только вам"}
                </span>
              </div>
              <span
                className="studio-audience"
                title="Реальные зрители, подключённые к комнате сейчас"
                aria-label={`Реальных зрителей сейчас: ${data.online}`}
              >
                <Users size={15} />
                Сейчас в комнате <b>{data.online}</b>
              </span>
              <span className="timer">
                <span className={active ? "record-dot" : ""} />
                {clock}
              </span>
            </div>
            {support && !coSpeaker && active && (
              <button
                className="btn quiet small"
                onClick={() => setWatchLive(!watchLive)}
              >
                {watchLive ? "Показать слайды для управления" : "Смотреть эфир"}
              </button>
            )}
            <div
              className={`canvas-shell tool-${tool} ${support && active && watchLive ? "support-live-preview" : ""}`}
            >
              {support && active && watchLive && (
                <div className="support-stream">
                  {data.media.provider === "youtube" &&
                  data.media.youtube?.videoId ? (
                    <YouTubePlayer
                      id={data.media.youtube.videoId}
                      onEvent={ignorePlayback}
                    />
                  ) : data.media.playlist ? (
                    <Player
                      src={data.media.playlist}
                      title={w!.title}
                      onEvent={ignorePlayback}
                    />
                  ) : (
                    <Notice>Ожидаем видео от ведущего</Notice>
                  )}
                </div>
              )}
              <canvas
                ref={canvas}
                aria-label="Композиция: презентация, рисунки и камера"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              />
              {layout === "slides" && tool === "pointer" && (ready || support) && control && !coSpeaker && (
                <CameraPosition
                  canvas={canvas}
                  box={cameraBox}
                  onChange={updateCameraBox}
                  onCommit={(box) => void stage({ cameraBox: box })}
                />
              )}
              {awaitingDelivery && (
                <div className="launch-countdown" role="status">
                  <strong style={{fontSize: "clamp(20px, 3vw, 36px)"}}>Подключаем эфир…</strong>
                  <span>{data?.media.youtube?.phase === "error" ? data.media.youtube.message : "Пока передаём заставку без звука. Дождитесь сообщения «Можно говорить»"}</span>
                  <button className="btn quiet" disabled={busy} onClick={() => void stop()}>Отменить запуск</button>
                </div>
              )}
              {((!support && !active) || (coSpeaker && !guestJoined)) && !awaitingDelivery && checksVisible && (
                <StudioPreflight
                  guest={coSpeaker}
                  recoveryUrl={recordBlocker?.message === problem ? recordBlocker.url : undefined}
                  audioStream={() => compositor.current?.destination?.stream}
                  onMicBusy={setMicTesting}
                  ready={ready}
                  heard={heard}
                  muted={muted}
                  camera={camera}
                  volume={volume}
                  record={recordCheck}
                  network={network}
                  networkLabel={networkLabel}
                  running={checking || busy}
                  countdown={awaitingDelivery}
                  canStart={canLaunch}
                  onHide={() => setChecksVisible(false)}
                  onCheck={() => void runChecks()}
                  onStart={coSpeaker ? () => {setGuestJoined(true);setChecksVisible(false);} : requestLaunch}
                  problem={
                    problem || (recordCheck === "ready" ? cloudCheck : "")
                  }
                />
              )}
              {((!support && !active) || (coSpeaker && !guestJoined)) && !awaitingDelivery && !checksVisible && (
                <div className="preflight-summary">
                  <button
                    className="btn quiet small"
                    onClick={() => setChecksVisible(true)}
                  >
                    <CheckCircle2 size={16} />
                    {canLaunch
                      ? "Камера, звук и запись проверены"
                      : "Проверка перед эфиром"}
                  </button>
                  <button
                    className="btn primary small"
                    disabled={!canLaunch}
                    onClick={coSpeaker ? () => setGuestJoined(true) : requestLaunch}
                  >
                    {coSpeaker ? "Присоединиться к ведущему" : "Начать эфир"}
                  </button>
                </div>
              )}
              {!support && active && !ready && (
                <button
                  className="enable-camera"
                  onClick={() => activate()}
                  disabled={busy}
                >
                  <Video size={18} />
                  Включить камеру и микрофон
                </button>
              )}
            </div>

            <div className="studio-control-dock">
              <fieldset className="slide-controls" disabled={!control} hidden={!toolsVisible}>
                {" "}
                <div className="pager">
                  <button
                    className="icon-btn"
                    aria-label="Предыдущий слайд"
                    disabled={slide <= 1}
                    onClick={() => changeSlide(slide - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span>
                    <input
                      className="slide-number"
                      key={slide}
                      type="number"
                      min={1}
                      max={pages}
                      aria-label="Перейти к слайду"
                      title="Введите номер слайда"
                      defaultValue={slide}
                      onBlur={(e) => {
                        const n = Number(e.currentTarget.value);
                        if (
                          Number.isInteger(n) &&
                          n >= 1 &&
                          n <= pages &&
                          n !== slide
                        )
                          void changeSlide(n);
                        else e.currentTarget.value = String(slide);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />{" "}
                    / {String(pages).padStart(2, "0")}
                  </span>
                  <button
                    className="icon-btn"
                    aria-label="Следующий слайд"
                    disabled={slide >= pages}
                    onClick={() => changeSlide(slide + 1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
                <div className="layout-switch">
                  <button
                    className={layout === "slides" ? "selected" : ""}
                    title="Презентация и камера"
                    aria-label="Презентация и камера"
                    onClick={() => changeLayout("slides")}
                  >
                    <Presentation size={18} />
                  </button>
                  <button
                    className={layout === "camera" ? "selected" : ""}
                    title="Только камера"
                    aria-label="Только камера"
                    onClick={() => changeLayout("camera")}
                  >
                    <Camera size={17} />
                  </button>
                </div>
              </fieldset>{" "}
              <fieldset className="drawing-group" disabled={!control} hidden={!toolsVisible}>
                {" "}
                <div className="drawing-tools">
                  <button
                    className={`icon-btn ${tool === "pointer" ? "selected" : ""}`}
                    aria-label="Не рисовать"
                    title="Не рисовать — перемещение камеры. Курсор зрителям не виден"
                    onClick={() => setTool("pointer")}
                  >
                    <Hand size={17} />
                  </button>
                  <button
                    className={`icon-btn ${tool === "pen" ? "selected" : ""}`}
                    aria-label="Карандаш"
                    onClick={() => setTool("pen")}
                  >
                    <Pencil size={17} />
                  </button>
                  <button
                    className={`icon-btn ${tool === "marker" ? "selected" : ""}`}
                    aria-label="Маркер"
                    onClick={() => setTool("marker")}
                  >
                    <Highlighter size={17} />
                  </button>
                  <label className="color-button" title="Цвет рисунка">
                    <input
                      aria-label="Цвет рисунка"
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                  <button
                    className="icon-btn"
                    aria-label="Очистить рисунки"
                    onClick={() => {
                      annotations.current[String(slide)] = [];
                      compositor.current!.strokes = [];
                      persist();
                    }}
                  >
                    <Eraser size={17} />
                  </button>
                </div>
              </fieldset>
              <div className="av-controls" hidden={support && !coSpeaker}>
                <div className="device-control">
                  {" "}
                  <button
                    className={`control-btn ${muted ? "off" : ""}`}
                    aria-pressed={!muted}
                    title={muted ? "Включить микрофон" : "Выключить микрофон"}
                    disabled={!ready}
                    onClick={() => {
                      compositor.current!.mute(!muted);
                      setMuted(!muted);
                    }}
                  >
                    {muted ? <MicOff size={18} /> : <Mic size={18} />}
                    <span>{muted ? "Микрофон выкл" : "Микрофон"}</span>
                    <div className="audio-meter">
                      <i style={{ height: `${Math.max(3, volume * 20)}px` }} />
                      <i style={{ height: `${Math.max(4, volume * 26)}px` }} />
                      <i style={{ height: `${Math.max(3, volume * 16)}px` }} />
                    </div>
                  </button>
                  <DevicePicker
                    label="Выбрать микрофон"
                    value={micId}
                    devices={devices.filter((d) => d.kind === "audioinput")}
                    disabled={!ready || busy || checking || awaitingDelivery}
                    onChange={(value) => void activate(cameraId, value)}
                  />
                </div>
                <div className="device-control">
                  {" "}
                  <button
                    className={`control-btn ${!camera ? "off" : ""}`}
                    aria-pressed={camera}
                    title={camera ? "Выключить камеру" : "Включить камеру"}
                    disabled={!ready}
                    onClick={() => {
                      compositor.current!.cameraOn = !camera;
                      setCamera(!camera);
                    }}
                  >
                    {camera ? <Video size={18} /> : <VideoOff size={18} />}
                    <span>Камера</span>
                  </button>
                  <DevicePicker
                    label="Выбрать камеру"
                    value={cameraId}
                    devices={devices.filter((d) => d.kind === "videoinput")}
                    disabled={!ready || busy || checking || awaitingDelivery}
                    onChange={(value) => void activate(value, micId)}
                  />
                </div>
              </div>
              <details
                className="camera-settings"
                hidden={!toolsVisible || layout !== "slides" || !control || coSpeaker}
              >
                <summary title="Размер и положение камеры">
                  <SlidersHorizontal size={15} />
                  Положение камеры
                  <ChevronDown size={14} />
                </summary>{" "}
                {layout === "slides" && (
                  <div className="camera-adjustments">
                    <label>
                      Размер камеры{" "}
                      <input
                        aria-label="Размер камеры"
                        type="range"
                        min="12"
                        max="55"
                        value={Math.round(cameraBox.width * 100)}
                        onChange={(e) =>
                          updateCameraBox({
                            ...cameraBox,
                            width: Number(e.target.value) / 100,
                          })
                        }
                        onPointerUp={() => void stage({ cameraBox })}
                        onKeyUp={() => void stage({ cameraBox })}
                      />
                      <span>{Math.round(cameraBox.width * 100)}%</span>
                    </label>
                    <button
                      onClick={() => {
                        const next = fitCameraBox({
                          ...cameraBox,
                          x: 0.03,
                          y: 0.03,
                        });
                        updateCameraBox(next);
                        void stage({ cameraBox: next });
                      }}
                    >
                      Слева сверху
                    </button>
                    <button
                      onClick={() => {
                        const next = fitCameraBox({
                          ...cameraBox,
                          x: 1 - cameraBox.width - 0.03,
                          y: 1 - cameraBox.width - 0.03,
                        });
                        updateCameraBox(next);
                        void stage({ cameraBox: next });
                      }}
                    >
                      Справа снизу
                    </button>
                    <span>Перетащите камеру или потяните за угол</span>
                  </div>
                )}
              </details>
            </div>
            <fieldset className="slides-row" disabled={!control} hidden={!toolsVisible}>
              {" "}
              <div className="thumbnail-size" aria-label="Размер миниатюр">
                <button
                  className="icon-btn"
                  aria-label="Увеличить слайды"
                  disabled={thumbSize >= 208}
                  onClick={() => setThumbSize((n) => Math.min(208, n + 24))}
                >
                  <Plus size={15} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="Уменьшить слайды"
                  disabled={thumbSize <= 88}
                  onClick={() => setThumbSize((n) => Math.max(88, n - 24))}
                >
                  <Minus size={15} />
                </button>
              </div>
              <div
                ref={slideStrip}
                className="slide-strip"
                style={
                  { "--thumb-size": `${thumbSize}px` } as React.CSSProperties
                }
              >
                {Array.from({ length: Math.min(pages, MAX_SLIDES) }, (_, i) => (
                  <button
                    className={`slide-thumb ${slide === i + 1 ? "current" : ""}`}
                    aria-label={`Слайд ${i + 1}`}
                    aria-current={slide === i + 1 ? "step" : undefined}
                    key={i}
                    onClick={() => changeSlide(i + 1)}
                  >
                    <span className="thumb-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {thumbs[i + 1] && (
                      <img src={thumbs[i + 1]} alt={`Слайд ${i + 1}`} />
                    )}
                    <span>
                      {w!.pdfId
                        ? "Страница " + (i + 1)
                        : [
                            "Тема вебинара",
                            "Основные вопросы",
                            "Ответы на вопросы",
                          ][i % 3]}
                    </span>
                  </button>
                ))}
                <label
                  className="upload-slide"
                  aria-label="Загрузить презентацию"
                >
                  <Upload size={18} />
                  <span>Загрузить презентацию</span>
                  <input
                    type="file"
                    hidden
                    accept=".pdf,.ppt,.pptx,.pps,.ppsx,.odp,.png,.jpg,.jpeg,.webp"
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      setBusy(true);
                      setProblem("");
                      try {
                        const form = new FormData();
                        form.append("kind", "pdf");
                        form.append("activate", "false");
                        form.append("file", file);
                        await api(`/api/events/${id}/assets`, {
                          method: "POST",
                          body: form,
                        });
                        setDeckRevision(v=>v+1);
                        setMessage("Презентация загружена. Нажмите «Показать», когда будете готовы");
                        await refresh();
                      } catch (error) {
                        setProblem((error as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </label>
              </div>
            </fieldset>{" "}
            <fieldset className="shared-materials" disabled={!control}><DeckLibrary id={id} active={w!.pdfId || null} revision={deckRevision} onShow={()=>void refresh()}/>
            <StudioEngagement
              event={w!}
              refresh={refresh}
              section="offer"
              onInsert={insertChat}
            /></fieldset>
            <div className="studio-bottom" hidden={!active}>
              {" "}
              {!support && active && w!.state === "reconnecting" && (
                <button
                  className="btn primary"
                  disabled={!ready || busy}
                  onClick={start}
                >
                  <Play size={15} />
                  Возобновить передачу
                </button>
              )}
            </div>
            <div className="signal-bar">
              {!support && (
                <span>
                  <i className={ready ? "connection-on" : "connection-off"} />
                  Камера и звук {ready ? "готовы" : "не включены"}
                </span>
              )}
              <span>
                <i
                  className={
                    data.media.receiving ? "connection-on" : "connection-off"
                  }
                />
                {data.media.receiving
                  ? coSpeaker ? "Видео ведущего передаётся на сервер" : "Видео передаётся"
                  : processing
                    ? "Сохраняем запись"
                    : active
                      ? "Ожидаем связь с ведущим"
                      : "Ожидаем запуск"}
              </span>
              <span>
                <i className={(data.media.provider === "youtube" ? data.media.youtube?.phase === "live" : data.media.receiving) ? "connection-on" : "connection-off"} />
                {data.media.provider === "youtube"
                  ? "Трансляция: YouTube"
                  : `Трансляция: ${platformBrand.serverLabel}`}
              </span>
              {!support && (
                <button onClick={() => setHelp(true)}>
                  <CircleHelp size={14} />
                  Как проверить эфир
                </button>
              )}
            </div>
            <BroadcastIdentity media={data.media} active={active} />

            {!support && active && (
              <p className="transport-note">
                При обрыве или закрытии вкладки эфир остаётся открытым —
                вернитесь в эту студию, включите камеру и нажмите «Возобновить
                передачу». После завершения можно вернуть комнату в ожидание с
                прежней ссылкой; следующий запуск создаст отдельную запись
              </p>
            )}
            {data.media.archiveWarning && (
              <Notice>{data.media.archiveWarning}</Notice>
            )}
            {data.media.youtube?.phase === "error" && (
              <Notice>
                {data.media.youtube.message || "YouTube не отвечает"} — откройте
                раздел помощи ниже
              </Notice>
            )}
            {!invited && <details
              open={data.media.youtube?.phase === "error" ? true : undefined}
              className="broadcast-help"
            >
              <summary>
                <ChevronDown size={15} />
                Если возникли неполадки с трансляцией
              </summary>
              <p className="field-hint">
                Попросите зрителя обновить страницу. Если видео по-прежнему не
                работает, попробуйте другой сервер. Возможна короткая пауза
              </p>
              <div className="record-actions">
                <button
                  className="btn quiet"
                  disabled={
                    busy || processing || data.media.provider === "railway"
                  }
                  onClick={async () => {
                    if (
                      !window.confirm(
                        "Переключить зрителей на резервный сервер? Возможна пауза из-за разной задержки источников",
                      )
                    )
                      return;
                    try {
                      setBusy(true);
                      await send(`/api/events/${id}/delivery`, {
                        provider: "railway",
                      });
                      await refresh();
                    } catch (e) {
                      setProblem((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Переключить на резервный сервер
                </button>
                <button
                  className="btn quiet"
                  disabled={busy || processing || !data.media.youtube?.enabled}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        "Передавать эфир в YouTube и показывать его зрителям? Трансляция будет создана на подключённом канале с доступом по ссылке",
                      )
                    )
                      return;
                    try {
                      setBusy(true);
                      await send(`/api/events/${id}/delivery`, {
                        provider: "youtube",
                      });
                      await refresh();
                    } catch (e) {
                      setProblem((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {data.media.provider === "youtube"
                    ? "Повторить подключение YouTube"
                    : "Основной канал YouTube"}
                </button>
              </div>
            </details>}
            {message && (
              <p className="transport-note" aria-live="polite">
                {message}
              </p>
            )}
          </section>
        </div>
        <div className="below-stage">
          {latest &&
            (!active || processing) &&
            ["processing", "ready", "incomplete", "failed"].includes(
              latest.state,
            ) && (
              <section className="recording-ready" role="status">
                <CheckCircle2 size={21} />
                <div>
                  <h3>
                    {latest.assemblyPending
                      ? "Эфир завершён — повторяем сохранение записи"
                      : latest.state === "failed"
                        ? "Эфир завершён, но запись сохранить не удалось"
                        : latest.state === "incomplete"
                          ? "Спасибо за эфир — проверьте запись с пропусками"
                          : "Вы справились — спасибо за эфир!"}
                  </h3>
                  <p>
                    {recordingExpired(latest)
                      ? retentionText(latest)
                      : latest.hasFile
                        ? "Запись готова — скачайте её в разделе «Записи» вашего кабинета"
                        : latest.state === "processing" ||
                            latest.assemblyPending
                          ? "Готовим запись — кнопка скачивания появится здесь и в разделе «Записи», когда обработка закончится"
                          : "Готовый файл отсутствует"}
                  </p>
                  {!recordingExpired(latest) && latest.state !== "failed" && (
                    <p>{retentionText(latest)}</p>
                  )}
                  <RecordingStorageStatus recording={latest} />
                  <YouTubeRecordingLink youtube={latest.youtube} />
                </div>
              </section>
            )}
          {latest?.hasFile && !recordingExpired(latest) && (
            <section className="recording-ready">
              <CheckCircle2 size={21} />
              <div>
                <h3>
                  {latest.state === "incomplete"
                    ? "Запись с пропусками"
                    : "Запись готова"}
                </h3>
                <p>
                  {Math.round(latest.duration || 0)} сек. · камера, презентация
                  и рисунки
                  <br />
                  {latest.archive?.state === "ready"
                    ? "Копия сохранена в облаке"
                    : latest.archive?.state === "uploading" ||
                        latest.archive?.state === "pending"
                      ? "Загружаем в облако…"
                      : latest.archive?.state === "failed"
                        ? "Не удалось загрузить в облако — файл сохранён на сервере"
                        : "Файл сохранён на сервере · облачное хранилище не подключено"}
                </p>
              </div>
              <a
                className="btn quiet"
                href={`/api/events/${id}/recordings/${latest.id}/download`}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={16} />
                Скачать запись
              </a>
            </section>
          )}
        </div>
      </main>
      {confirm && active && !processing && (
        <FinishConfirmation
          onResume={() => {
            compositor.current?.pauseForFinish(false);
            setConfirm(false);
          }}
          onFinish={() => {
            void stop();
          }}
        />
      )}
      {earlyWarning && !active && (
        <Modal
          title="Начать раньше назначенного времени?"
          onClose={() => setEarlyWarning(false)}
        >
          <p>
            Вебинар запланирован на {dateLabel(w!.startsAt, w!.timezone)}. До
            начала —{" "}
            {Math.max(
              1,
              Math.ceil((Date.parse(w!.startsAt) - Date.now()) / 60000),
            )}{" "}
            мин
          </p>
          <p>
            Если начать сейчас, зрители увидят видео и начнётся запись.
            Проверять камеру и звук можно без запуска эфира
          </p>
          <div className="modal-actions">
            <button
              className="btn quiet"
              onClick={() => setEarlyWarning(false)}
            >
              Продолжить подготовку
            </button>
            <button
              className="btn primary"
              onClick={() => {
                earlyApproved.current = w!.startsAt;
                setEarlyWarning(false);
                void start();
              }}
            >
              Начать сейчас
            </button>
          </div>
        </Modal>
      )}
      {help && <HelpDialog initialStep={2} onClose={() => setHelp(false)} />}
    </>
  );
}
