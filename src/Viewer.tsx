import { platformBrand } from "../shared/brand";
import { startWatchTelemetry, type PlaybackEvent } from "./watchTelemetry";
import { PlaybackControls } from "./PlaybackControls";
import { YouTubePlayer } from "./YouTubePlayer";
import { displayLabel } from "./ui";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  ArrowUpRight,
  CalendarDays,
  Radio,
  Play,
  Video,
  Clock3,
} from "lucide-react";
import { api, send, useRoom, dateLabel, assetUrl } from "./api";
import { Brand, Chat, Notice } from "./ui";
import type { Webinar } from "../shared/contracts";

function EndScreen({
  event,
  onClick,
}: {
  event: Webinar;
  onClick?: () => void;
}) {
  return (
    <section className="webinar-end-screen">
      <span className="eyebrow">СПАСИБО, ЧТО БЫЛИ С НАМИ</span>
      <h2>Вебинар завершён</h2>
      {event.ctaUrl ? (
        <>
          <p>Специальные условия для зрителей вебинара</p>
          <div className="webinar-end-offer">
            <h3>
              {displayLabel(event.ctaTitle || "Предложение для зрителей")}
            </h3>
            {event.ctaDescription && (
              <p>{displayLabel(event.ctaDescription)}</p>
            )}
            <a
              className="btn primary large"
              href={event.ctaUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClick}
            >
              Посмотреть предложение <ArrowUpRight size={19} />
            </a>
          </div>
        </>
      ) : (
        <p>Спасибо за участие! До встречи на следующих вебинарах</p>
      )}
    </section>
  );
}
function StartCountdown({ startsAt }: { startsAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = startsAt
    ? Math.max(0, Math.ceil((Date.parse(startsAt) - now) / 1000))
    : 0;
  if (!startsAt || !Number.isFinite(remaining)) return null;
  const days = Math.floor(remaining / 86400);
  const time = [
    Math.floor(remaining / 3600) % 24,
    Math.floor(remaining / 60) % 60,
    remaining % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return (
    <span className="start-countdown">
      <Clock3 size={16} />
      {remaining
        ? `До начала ${days ? `${days} дн · ` : ""}${time}`
        : "Начнём, как только подключится ведущий"}
    </span>
  );
}

export function Viewer({ slug }: { slug: string }) {
  const [joined, setJoined] = useState(false);
  const [info, setInfo] = useState<Webinar | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (joined) return;
    let cancelled = false;
    const load = () =>
      api(`/api/room/${slug}/info`)
        .then((info) => {
          if (!cancelled) {
            setInfo(info);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    api(`/api/room/${slug}`)
      .then(() => {
        if (!cancelled) setJoined(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [slug, joined]);
  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await send(`/api/room/${slug}/join`, { name });
      setJoined(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (joined) return <JoinedRoom slug={slug} />;
  if (info && ["ended", "stopping"].includes(info.state))
    return (
      <div className="join-page">
        <header>
          <Brand name={info.brandName} />
        </header>
        <main className="ended-entry">
          <EndScreen event={info} />
        </main>
      </div>
    );
  return (
    <div
      className="join-page"
      style={{ "--accent": info?.accent } as React.CSSProperties}
    >
      <header>
        {info?.logoId ? (
          <a className="viewer-logo" href={`/room/${slug}`}>
            <img
              src={assetUrl(info.id, info.logoId)}
              alt={info.brandName || "Логотип вебинара"}
            />
            <span>{info.brandName}</span>
          </a>
        ) : (
          <Brand name={info?.brandName} />
        )}
        <span className="local-tag">
          <span />
          Вебинар
        </span>
      </header>
      <main className="join-layout">
        <div className="join-intro">
          <h1>{displayLabel(info?.title || "Добро пожаловать")}</h1>
          <p>{displayLabel(info?.description || "")}</p>
          <span className="join-date">
            <CalendarDays size={17} />
            {info ? dateLabel(info.startsAt, info.timezone) : ""}
            {info?.startsAt && ` · ${info.timezone}`}
          </span>
          {info && <StartCountdown startsAt={info.startsAt} />}
          <div className={`join-art ${info?.coverId ? "has-cover" : ""}`}>
            {info?.coverId && (
              <img
                className="join-cover"
                src={assetUrl(info.id, info.coverId)}
                alt="Обложка вебинара"
              />
            )}
            <div className="event-orbit" />
            <div className="event-sphere" />
            <span>
              Встречаемся
              <br />
              <em>в прямом эфире</em>
            </span>
          </div>
        </div>
        <form className="join-form" onSubmit={join}>
          <span className="outline-icon">
            <Radio size={25} />
          </span>
          <h2>Рады вас видеть</h2>
          <p>
            Представьтесь, чтобы присоединиться
            <br />к разговору
          </p>
          <label className="field">
            Ваше имя
            <input
              autoComplete="given-name"
              autoFocus
              required
              maxLength={60}
              placeholder="Как к вам обращаться?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="btn primary large" disabled={!name.trim() || busy}>
            Войти в комнату <ArrowUpRight size={19} />
          </button>
          <small>
            Имя будет видно в чате. Сообщения и события просмотра сохраняются
            организатором вебинара
          </small>
          {error && <Notice tone="error">{error}</Notice>}
        </form>
      </main>
      <footer>{platformBrand.footer}</footer>
    </div>
  );
}
export function Player({
  src,
  onEvent,
  title,
  onEnded,
  live = true,
}: {
  live?: boolean;
  title: string;
  onEnded?: () => void;
  src: string;
  onEvent: PlaybackEvent;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  useEffect(() => setHasFrame(false), [src]);
  const [playing, setPlaying] = useState(false),
    [muted, setMuted] = useState(false),
    [volume, setVolume] = useState(1),
    [pip, setPip] = useState(false);
  type SafariVideo = HTMLVideoElement & {
    webkitSupportsPresentationMode?: (mode: string) => boolean;
    webkitSetPresentationMode?: (mode: string) => void;
    webkitPresentationMode?: string;
    webkitEnterFullscreen?: () => void;
  };
  const play = () => {
    wantsPlayback.current = true;
    void video.current
      ?.play()
      .catch(() => setError("Нажмите воспроизведение ещё раз"));
  };
  useEffect(() => {
    const el = video.current as SafariVideo;
    const check = () =>
      setPip(
        !!document.pictureInPictureEnabled ||
          !!el.webkitSupportsPresentationMode?.("picture-in-picture"),
      );
    check();
    el.addEventListener("loadedmetadata", check);
    el.addEventListener("playing", check);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: "Вебинар",
      });
      for (const [action, handler] of [
        ["play", play],
        [
          "pause",
          () => {
            wantsPlayback.current = false;
            el.pause();
          },
        ],
      ] as const) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {
          /* Browser may expose only some actions. */
        }
      }
    }
    return () => {
      el.removeEventListener("loadedmetadata", check);
      el.removeEventListener("playing", check);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
      }
    };
  }, [title]);
  const wantsPlayback = useRef(true);
  const liveRef = useRef(live);
  liveRef.current = live;
  const lastBuffering = useRef(0);
  const eventCallback = useRef(onEvent);
  eventCallback.current = onEvent;
  const [error, setError] = useState("");
  const [needsPlay, setNeedsPlay] = useState(true);
  useEffect(() => {
    const el = video.current!;
    setError("");
    let disposed = false;
    let hls: Hls | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let trying = false;
    const resume = async () => {
      if (
        disposed ||
        trying ||
        !wantsPlayback.current ||
        !el.paused ||
        el.ended
      )
        return;
      trying = true;
      try {
        await el.play();
      } catch (e) {
        if (
          !disposed &&
          wantsPlayback.current &&
          (e as Error).name === "NotAllowedError"
        ) {
          el.muted = true;
          try {
            await el.play();
          } catch {
            if (!disposed) setNeedsPlay(true);
          }
        }
      } finally {
        trying = false;
      }
    };
    const played = () => {
      wantsPlayback.current = true;
      setNeedsPlay(false);
      setPlaying(true);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "playing";
      setError("");
      eventCallback.current("play");
    };
    const paused = () => {
      setPlaying(false);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "paused";
      if (!wantsPlayback.current) {
        eventCallback.current("pause");
      }
    };
    el.addEventListener("play", played);
    el.addEventListener("pause", paused);
    el.addEventListener("canplay", resume);
    const recover = setInterval(() => {
      if (liveRef.current) void resume();
    }, 2500);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    if (
      src.includes(".m3u8") &&
      !(
        el.canPlayType("application/vnd.apple.mpegurl") &&
        /Safari/.test(navigator.userAgent) &&
        !/Chrome|Chromium|Android/.test(navigator.userAgent)
      ) &&
      Hls.isSupported()
    ) {
      hls = new Hls({
        liveSyncDurationCount: 3,
        initialLiveManifestSize: 3,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 30,
        backBufferLength: 30,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, resume);
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setError("");
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        eventCallback.current("play_error");
        setError("Связь с видеопотоком прервалась — восстанавливаем просмотр");
        if (attempts++ >= 5) {
          setError("Не удалось восстановить видео — обновите комнату");
          return;
        }
        clearTimeout(retry);
        retry = setTimeout(
          () => {
            if (disposed) return;
            if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad(-1);
            else if (d.type === Hls.ErrorTypes.MEDIA_ERROR)
              hls?.recoverMediaError();
          },
          Math.min(8000, 1000 * attempts),
        );
      });
      hls.loadSource(src);
      hls.attachMedia(el);
    } else el.src = src;
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(recover);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      el.removeEventListener("play", played);
      el.removeEventListener("pause", paused);
      el.removeEventListener("canplay", resume);
      if (document.pictureInPictureElement === el)
        void document.exitPictureInPicture().catch(() => {});
      const safari = el as SafariVideo;
      if (safari.webkitPresentationMode === "picture-in-picture")
        safari.webkitSetPresentationMode?.("inline");
      el.pause();
      hls?.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [src]);
  useEffect(
    () =>
      startWatchTelemetry(
        () => {
          const el = video.current;
          return {
            playing: !!el && !el.paused && !el.ended && el.readyState >= 3,
            position: el?.currentTime || 0,
          };
        },
        (kind, details) => eventCallback.current(kind, details),
      ),
    [],
  );
  return (
    <div className="viewer-player" ref={shell}>
      <video
        onLoadedData={() => setHasFrame(true)}
        ref={video}
        onEnded={() => {
          setPlaying(false);
          if (!liveRef.current) onEnded?.();
        }}
        onVolumeChange={() => {
          if (video.current) {
            setMuted(video.current.muted);
            setVolume(video.current.volume);
          }
        }}
        playsInline
        onWaiting={() => {
          if (Date.now() - lastBuffering.current > 10000) {
            lastBuffering.current = Date.now();
            onEvent("buffering");
          }
        }}
        onError={() =>
          setError("Не удалось открыть видео. Попробуйте обновить комнату")
        }
      />
      {!hasFrame && !needsPlay && !error && (
        <div className="broadcast-loading" role="status">
          <span className="broadcast-spinner" />
          <strong>Трансляция запускается</strong>
          <span>Видео скоро появится</span>
        </div>
      )}
      {needsPlay && (
        <button
          className="btn primary viewer-play-button"
          onClick={() => {
            play();
          }}
        >
          <Play size={19} />
          Смотреть видео
        </button>
      )}
      {muted && playing && (
        <button
          className="player-sound-hint"
          onClick={() => {
            if (video.current) video.current.muted = false;
          }}
        >
          Включить звук
        </button>
      )}
      <PlaybackControls
        playing={playing}
        muted={muted}
        volume={volume}
        onPlay={() => {
          if (playing) {
            wantsPlayback.current = false;
            video.current?.pause();
          } else play();
        }}
        onMute={() => {
          if (video.current) video.current.muted = !video.current.muted;
        }}
        onVolume={(v) => {
          if (video.current) {
            video.current.volume = v;
            video.current.muted = v === 0;
            setVolume(v);
            setMuted(v === 0);
          }
        }}
        onFullscreen={() => {
          const el = video.current as SafariVideo;
          if (document.fullscreenElement) void document.exitFullscreen();
          else if (shell.current?.requestFullscreen)
            void shell.current
              .requestFullscreen()
              .catch(() => setError("Не удалось открыть полный экран"));
          else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
          else setError("Полный экран недоступен в этом браузере");
        }}
        onPip={
          pip
            ? () => {
                const el = video.current as SafariVideo;
                if (document.pictureInPictureElement)
                  void document.exitPictureInPicture().catch(() => {});
                else if (
                  document.pictureInPictureEnabled &&
                  el.requestPictureInPicture
                )
                  void el
                    .requestPictureInPicture()
                    .catch(() =>
                      setError(
                        "Сначала включите видео, затем откройте картинку в картинке",
                      ),
                    );
                else if (el.webkitSetPresentationMode)
                  el.webkitSetPresentationMode(
                    el.webkitPresentationMode === "picture-in-picture"
                      ? "inline"
                      : "picture-in-picture",
                  );
              }
            : undefined
        }
      />
      {error && <div className="player-error">{error}</div>}
    </div>
  );
}
function JoinedRoom({ slug }: { slug: string }) {
  const { data, error, connected } = useRoom(slug, true);
  const [ctaSeen, setCtaSeen] = useState(false);
  const offer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState(0);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setStageHeight(entry.contentRect.height),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [!!data]);
  const lastLive = useRef("");
  const lastRun = useRef<string | null>(null);
  if (lastRun.current !== (data?.media.runId || null)) {
    lastRun.current = data?.media.runId || null;
    lastLive.current = "";
  }
  const watchedRun = useRef<string | null>(null);
  const [endedRun, setEndedRun] = useState<string | null>(null);
  useEffect(() => {
    setCtaSeen(false);
    watchedRun.current = null;
    setEndedRun(null);
  }, [data?.event.reopenedAt]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const tabId = useRef(crypto.randomUUID());
  const telemetry: PlaybackEvent = (kind, details) => {
    if (kind === "play") {
      watchedRun.current = data?.media.runId || null;
      setEndedRun(null);
    }
    void send(`/api/room/${slug}/analytics`, {
      id: crypto.randomUUID(),
      kind,
      ...details,
      tabId: tabId.current,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source: document.referrer ? new URL(document.referrer).origin : "",
    }).catch(() => {});
  };
  const entered = !!data;
  useEffect(() => {
    if (!entered) return;
    const presence = () => telemetry("room_presence");
    presence();
    const timer = setInterval(presence, 15000);
    const exit = () => {
      void fetch(`/api/room/${slug}/analytics`, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          kind: "room_exit",
          tabId: tabId.current,
        }),
      }).catch(() => {});
    };
    window.addEventListener("pagehide", exit);
    window.addEventListener("pageshow", presence);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", exit);
      window.removeEventListener("pageshow", presence);
      exit();
    };
  }, [entered, slug]);
  useEffect(() => {
    if (
      !data?.event.ctaUrl ||
      (!data.event.ctaVisible &&
        !["stopping", "ended"].includes(data.event.state))
    ) {
      setCtaSeen(false);
      return;
    }
    if (ctaSeen || !offer.current) return;
    const el = offer.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !document.hidden &&
          entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.25)
        ) {
          telemetry("cta_impression");
          setCtaSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    const observe = () => {
      observer.unobserve(el);
      observer.observe(el);
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", observe);
    };
  }, [
    data?.event.ctaVisible,
    data?.event.ctaUrl,
    data?.event.state,
    ctaSeen,
    endedRun,
    now >= (data?.media.finishUntil || Infinity),
  ]);

  if (!data)
    return (
      <main className="page">
        <Notice>{error || "Открываем комнату…"}</Notice>
      </main>
    );
  const w = data.event;
  const stopped = ["stopping", "ended"].includes(w.state);
  const finishing =
    stopped &&
    watchedRun.current === data.media.runId &&
    endedRun !== data.media.runId &&
    (data.media.finishUntil || 0) > now;
  const finished = stopped && !finishing;
  if (finished) lastLive.current = "";
  else if (data.media.playlist) lastLive.current = data.media.playlist;
  const youtubeActive =
    !finished && !!data.media.runId && data.media.provider === "youtube";
  const youtubeError = youtubeActive && data.media.youtube?.phase === "error";
  const isLive =
    !stopped &&
    (youtubeActive
      ? data.media.youtube?.phase === "live"
      : !!data.media.playlist && data.media.receiving);
  const currentRecording = data.recordings.find(
    (r) => r.id === data.media.runId,
  );
  const elapsedSeconds = currentRecording
    ? Math.max(
        0,
        Math.floor(
          ((stopped
            ? Math.min(now, (data.media.finishUntil || now) - 300000)
            : now) -
            Date.parse(currentRecording.createdAt)) /
            1000,
        ),
      )
    : 0;
  const elapsed = [
    Math.floor(elapsedSeconds / 3600),
    Math.floor(elapsedSeconds / 60) % 60,
    elapsedSeconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const src =
    !finished && data.media.runId
      ? data.media.playlist || lastLive.current
      : "";
  return (
    <div
      className="viewer-page"
      style={
        {
          "--accent": w.accent,
          "--viewer-stage-height": `${stageHeight}px`,
        } as React.CSSProperties
      }
    >
      <header
        className={`viewer-header compact-event-header${w.logoId || w.brandName?.trim() ? " has-event-brand" : ""}`}
      >
        {(w.logoId || w.brandName?.trim()) && (
          <a className="event-brand" href={`/room/${slug}`}>
            {w.logoId && (
              <img
                src={assetUrl(w.id, w.logoId)}
                alt={w.brandName || "Логотип"}
              />
            )}
            {w.brandName?.trim() && <span>{w.brandName}</span>}
          </a>
        )}
        <div className="event-heading">
          <h1 title={w.title}>{displayLabel(w.title)}</h1>
          {w.description?.trim() && (
            <p title={w.description}>{displayLabel(w.description)}</p>
          )}
        </div>
        <div className="viewer-session-bar">
          <div
            className={`viewer-stream-status ${isLive ? "is-live" : ""}`}
            role="status"
          >
            <span className={isLive ? "viewer-live-dot" : ""} />
            <strong>
              {finished
                ? "Вебинар завершён"
                : finishing
                  ? "Досматриваем эфир"
                  : isLive
                    ? "В эфире"
                    : youtubeError
                      ? "Эфир временно недоступен"
                      : w.state === "stopping"
                        ? "Вебинар завершён"
                        : data.media.runId
                          ? "Подключаем эфир"
                          : "Ожидаем ведущего"}
            </strong>
            {(isLive || finishing) && (
              <span
                className="live-elapsed"
                aria-label={`Длительность эфира ${elapsed}`}
              >
                {elapsed}
              </span>
            )}
          </div>
          {(w.hostName?.trim() || data.speakerName?.trim()) && (
            <div className="viewer-presenters">
              {w.hostName?.trim() && (
                <span>
                  <small>Ведущий</small> <strong>{w.hostName}</strong>
                </span>
              )}
              {data.speakerName?.trim() && (
                <span>
                  <small>Спикер</small> <strong>{data.speakerName}</strong>
                </span>
              )}
            </div>
          )}
        </div>
      </header>
      <main className="viewer-main">
        {new URLSearchParams(location.search).has("observer") && (
          <Notice>
            <strong>Наблюдение за вебинаром</strong> · Камера и микрофон не
            подключаются, управление эфиром остаётся у ведущего ·{" "}
            <a href="/admin">К вебинарам клиентов</a>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="broadcast-grid viewer-grid">
          <Chat
            event={w}
            messages={data.messages}
            online={data.online}
            audienceScenario={data.audienceScenario}
            connected={connected}
            viewer
          />
          <section className="viewer-content">
            <div ref={stage} className="viewer-stage">
              {youtubeError && (
                <Notice>
                  Организатор восстанавливает трансляцию. Оставайтесь в комнате
                  — видео появится после подключения
                </Notice>
              )}
              {finished ? (
                <div ref={offer} className="viewer-end-offer">
                  <EndScreen event={w} onClick={() => telemetry("cta_click")} />
                </div>
              ) : youtubeActive ? (
                data.media.youtube?.videoId ? (
                  <YouTubePlayer
                    id={data.media.youtube.videoId}
                    live={!finishing}
                    onEvent={telemetry}
                    onEnded={() => setEndedRun(data.media.runId)}
                  />
                ) : (
                  <div className="waiting-screen">
                    <p>
                      {youtubeError
                        ? "Видеопоток пока недоступен. Организатор проверяет подключение"
                        : "Подключаем эфир — оставайтесь в комнате"}
                    </p>
                  </div>
                )
              ) : src ? (
                <Player
                  src={src}
                  live={!finishing}
                  title={w.title}
                  onEvent={telemetry}
                  onEnded={() => setEndedRun(data.media.runId)}
                />
              ) : (
                <div className="waiting-screen">
                  {w.coverId && (
                    <img
                      className="waiting-cover"
                      src={assetUrl(w.id, w.coverId)}
                      alt="Обложка вебинара"
                    />
                  )}
                  <div className="waiting-decor">
                    <div className="event-orbit" />
                    <div className="event-sphere" />
                  </div>
                  <div className="waiting-copy">
                    <span className="waiting-icon">
                      <Radio size={27} />
                    </span>
                    <span className="eyebrow">
                      {w.brandName
                        ? `${w.brandName.toUpperCase()} · LIVE`
                        : "ПРЯМОЙ ЭФИР"}
                    </span>
                    <h2>
                      {w.state === "failed"
                        ? "Передача прервалась"
                        : "Ожидаем начало вебинара"}
                    </h2>
                    <p>
                      {w.state === "failed"
                        ? "Организатор проверяет подключение. Чат остаётся доступным"
                        : displayLabel(w.description)}
                    </p>
                    <span className="waiting-date">
                      <CalendarDays size={16} />
                      {dateLabel(w.startsAt, w.timezone)}
                    </span>
                    <StartCountdown startsAt={w.startsAt} />
                  </div>
                </div>
              )}
            </div>
            {!finished && w.ctaVisible && w.ctaUrl && (
              <div className="viewer-offer" ref={offer}>
                <div>
                  <span className="eyebrow">ВАШ СЛЕДУЮЩИЙ ШАГ</span>
                  <h3>{displayLabel(w.ctaTitle)}</h3>
                  <p>{displayLabel(w.ctaDescription)}</p>
                </div>
                <a
                  className="btn primary"
                  href={w.ctaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => telemetry("cta_click")}
                >
                  {displayLabel(w.ctaTitle)}
                  <ArrowUpRight size={17} />
                </a>
              </div>
            )}
            <p className="viewer-hint">
              <Clock3 size={14} />
              {finished
                ? "Вебинар завершён · сообщения чата сохранены"
                : "Видео идёт с небольшой задержкой. Чат доставляется сразу"}
            </p>
          </section>
        </div>
      </main>
      <footer className="viewer-footer">
        {w.brandName && (
          <span className="viewer-footer-brand">{w.brandName}</span>
        )}
        <span>
          Работает на <b>{platformBrand.name}</b>
        </span>
      </footer>
    </div>
  );
}
