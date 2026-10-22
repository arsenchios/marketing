import { platformBrand } from "../shared/brand";
import { createPortal } from "react-dom";
import { useMiniPlayer } from "./useMiniPlayer";
import { startWatchTelemetry, type PlaybackEvent } from "./watchTelemetry";
import { useEffect, useRef, useState } from "react";
import { PlaybackControls } from "./PlaybackControls";
type YouTubeInstance = {
  getCurrentTime?(): number;
  getPlayerState?(): number;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(v: number): void;
  destroy(): void;
};
type YouTubeSDK = {
  Player: new (el: HTMLElement, options: any) => YouTubeInstance;
};
declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options: {
        width: number;
        height: number;
      }): Promise<Window>;
    };
    YT?: YouTubeSDK;
    onYouTubeIframeAPIReady?: () => void;
  }
}
const sdks = new WeakMap<Window, Promise<YouTubeSDK>>();
function loadSDK(window: Window) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  const cached = sdks.get(window);
  if (cached) return cached;
  const result = new Promise<YouTubeSDK>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(
      () => reject(new Error("YouTube controls unavailable")),
      10000,
    );
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timer);
      if (window.YT) resolve(window.YT);
    };
    const script = window.document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("YouTube controls unavailable"));
    };
    window.document.head.append(script);
  });
  sdks.set(window, result);
  void result.catch(() => sdks.delete(window));
  return result;
}
export function YouTubePlayer({
  id,
  onEvent,
  onEnded,
  live = true,
  contextWindow = window,
  initialMuted = false,
  initialVolume = 1,
  autostart = true,
  onIntentChange,
  onAudioChange,
}: {
  id: string;
  live?: boolean;
  contextWindow?: Window;
  initialMuted?: boolean;
  initialVolume?: number;
  autostart?: boolean;
  onIntentChange?: (playing: boolean) => void;
  onAudioChange?: (muted: boolean, volume: number) => void;
  onEvent?: PlaybackEvent;
  onEnded?: () => void;
}) {
  const detached = contextWindow !== window;
  const ownerDocument = contextWindow.document;
  const wantsPlayback = useRef(autostart);
  const liveRef = useRef(live);
  liveRef.current = live;
  const muteRef = useRef(initialMuted);
  const pipRef = useRef<Window | null>(null);
  const pipOpening = useRef(false);
  const currentId = useRef(id);
  currentId.current = id;
  const resumeAfterPip = useRef(true);
  const alive = useRef(true);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [blocked, setBlocked] = useState(false);
  const blockedRef = useRef(false);
  const permanentError = useRef(false);
  const endCallback = useRef(onEnded);
  endCallback.current = onEnded;
  const emit = useRef(onEvent);
  emit.current = onEvent;
  useEffect(
    () =>
      startWatchTelemetry(
        () => ({
          playing: player.current?.getPlayerState?.() === 1,
          position: player.current?.getCurrentTime?.() || 0,
        }),
        (kind, details) => emit.current?.(kind, details),
        contextWindow,
      ),
    [],
  );
  const shell = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    player = useRef<YouTubeInstance | null>(null);
  const [mobilePlayer, setMobilePlayer] = useState(() => contextWindow.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const media = contextWindow.matchMedia("(max-width: 700px)");
    const change = () => setMobilePlayer(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [contextWindow]);
  const [started, setStarted] = useState(false);
  const [mini, setMini] = useState(false);
  const floating = useMiniPlayer(mini && !detached);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMini(false);
    };
    const change = () =>
      setFullscreen(ownerDocument.fullscreenElement === shell.current);
    ownerDocument.addEventListener("keydown", key);
    ownerDocument.addEventListener("fullscreenchange", change);
    return () => {
      ownerDocument.removeEventListener("keydown", key);
      ownerDocument.removeEventListener("fullscreenchange", change);
    };
  }, []);
  async function toggleMini() {
    if (ownerDocument.fullscreenElement) {
      try {
        await ownerDocument.exitFullscreen();
      } catch {
        return;
      }
    }
    setMini((value) => !value);
  }
  const [ready, setReady] = useState(false),
    [fallback, setFallback] = useState(false),
    [playing, setPlaying] = useState(false),
    [muted, setMuted] = useState(initialMuted),
    [volume, setVolume] = useState(initialVolume),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const fallbackTimer = setTimeout(() => {
      if (!disposed) {
        player.current?.destroy();
        player.current = null;
        setFallback(true);
      }
    }, 15000);
    blockedRef.current = false;
    setBlocked(false);
    setReady(false);
    setStarted(false);
    setFallback(false);
    setError("");
    wantsPlayback.current = autostart;
    permanentError.current = false;
    const recover = () => {
      if (
        !disposed &&
        !pipRef.current &&
        !permanentError.current &&
        liveRef.current &&
        wantsPlayback.current &&
        !blockedRef.current
      ) {
        const state = player.current?.getPlayerState?.();
        if (state !== undefined && [-1, 2, 5].includes(state))
          player.current?.playVideo();
      }
    };
    const recoveryTimer = contextWindow.setInterval(recover, 3000);
    contextWindow.addEventListener("online", recover);
    ownerDocument.addEventListener("visibilitychange", recover);
    void loadSDK(contextWindow)
      .then((YT) => {
        if (disposed) return;
        // Set identity policy before the first navigation. The SDK-created
        // iframe inherits our page's same-origin policy and triggers error 153.
        const target = ownerDocument.createElement("iframe");
        target.title = "Прямой эфир YouTube";
        target.referrerPolicy = "strict-origin-when-cross-origin";
        target.allow =
          "autoplay; encrypted-media; picture-in-picture; fullscreen";
        target.allowFullscreen = true;
        const params = new URLSearchParams({
          enablejsapi: "1",
          controls: mobilePlayer ? "1" : "0",
          playsinline: "1",
          rel: "0",
          origin: location.origin,
          autoplay: "0",
        });
        target.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;
        mount.current!.append(target);
        player.current = new YT.Player(target, {
          events: {
            onReady: () => {
              clearTimeout(fallbackTimer);
              if (!disposed) {
                setReady(true);
                if (initialVolume !== 1)
                  player.current?.setVolume(initialVolume * 100);
                if (muteRef.current) player.current?.mute();
                if (wantsPlayback.current && !pipRef.current)
                  player.current?.playVideo();
                mount.current
                  ?.querySelector("iframe")
                  ?.setAttribute("title", "Прямой эфир YouTube");
              }
            },
            onStateChange: (e: { data: number }) => {
              if (!disposed) {
                setPlaying(e.data === 1);
                if (e.data === 0 && !liveRef.current) endCallback.current?.();
                if (e.data === 1) {
                  setStarted(true);
                  setError("");
                  setBlocked(false);
                  blockedRef.current = false;
                }
                if (!pipRef.current && [1, 2, 3].includes(e.data))
                  emit.current?.(
                    e.data === 1
                      ? "play"
                      : e.data === 2
                        ? "pause"
                        : "buffering",
                  );
              }
            },
            onAutoplayBlocked: () => {
              if (disposed || !wantsPlayback.current || pipRef.current) return;
              if (!muteRef.current) {
                muteRef.current = true;
                setMuted(true);
                onAudioChange?.(true, volume);
                player.current?.mute();
                player.current?.playVideo();
              } else {
                blockedRef.current = true;
                setBlocked(true);
              }
            },
            onError: (e: { data: number }) => {
              if (disposed) return;
              permanentError.current = [2, 100, 101, 150, 153].includes(e.data);
              emit.current?.("play_error");
              setError(
                e.data === 153
                  ? "YouTube не получил адрес сайта (ошибка 153) — откройте комнату в обычном браузере и обновите страницу"
                  : [101, 150].includes(e.data)
                    ? "YouTube запретил просмотр этого видео на сайте — сообщите организатору"
                    : e.data === 100
                      ? "Видео YouTube недоступно или закрыто для просмотра — сообщите организатору"
                      : `YouTube не смог открыть видео (ошибка ${e.data}) — попробуйте обновить страницу`,
              );
            },
          },
        });
      })
      .catch(() => {
        if (!disposed) setFallback(true);
      });
    return () => {
      disposed = true;
      clearTimeout(fallbackTimer);
      contextWindow.clearInterval(recoveryTimer);
      contextWindow.removeEventListener("online", recover);
      ownerDocument.removeEventListener("visibilitychange", recover);
      player.current?.destroy();
      player.current = null;
      mount.current?.replaceChildren();
    };
  }, [id, contextWindow]);
  function playManually() {
    wantsPlayback.current = true;
    blockedRef.current = false;
    setBlocked(false);
    permanentError.current = false;
    onIntentChange?.(true);
    player.current?.playVideo();
  }
  async function openPip() {
    if (pipOpening.current) return;
    if (pipRef.current) {
      pipRef.current.focus();
      return;
    }
    pipOpening.current = true;
    try {
      const win = await window.documentPictureInPicture!.requestWindow({
        width: 640,
        height: 440,
      });
      if (!alive.current || currentId.current !== id) {
        win.close();
        return;
      }
      resumeAfterPip.current = wantsPlayback.current;
      pipRef.current = win;
      blockedRef.current = false;
      setBlocked(false);
      player.current?.pauseVideo();
      for (const style of document.querySelectorAll(
        'link[rel="stylesheet"],style',
      ))
        win.document.head.append(style.cloneNode(true));
      win.document.title = `Вебинар · ${platformBrand.name}`;
      win.document.body.className = "detached-player-page";
      win.addEventListener(
        "pagehide",
        () => {
          pipRef.current = null;
          if (!alive.current) return;
          setPipWindow(null);
          wantsPlayback.current = resumeAfterPip.current;
          if (wantsPlayback.current) player.current?.playVideo();
        },
        { once: true },
      );
      setMini(false);
      setPipWindow(win);
    } catch {
      pipRef.current?.close();
      setError(
        "Окно поверх вкладок недоступно — используйте мини-плеер на странице",
      );
    } finally {
      pipOpening.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pipRef.current?.close();
      pipRef.current = null;
    };
  }, []);
  useEffect(() => {
    pipRef.current?.close();
  }, [id]);
  return (
    <div className="youtube-player-position">
      {pipWindow &&
        createPortal(
          <YouTubePlayer
            id={id}
            live={live}
            contextWindow={pipWindow}
            initialMuted={muted}
            initialVolume={volume}
            onAudioChange={(m, v) => {
              muteRef.current = m;
              setMuted(m);
              setVolume(v);
              player.current?.setVolume(v * 100);
              if (m) player.current?.mute();
              else player.current?.unMute();
            }}
            autostart={resumeAfterPip.current}
            onIntentChange={(v) => {
              resumeAfterPip.current = v;
            }}
            onEvent={onEvent}
            onEnded={onEnded}
          />,
          pipWindow.document.body,
        )}
      {pipWindow && (
        <div className="youtube-mini-placeholder">
          <span>Видео открыто поверх вкладок</span>
          <button onClick={() => pipWindow.close()}>
            Вернуть видео на место
          </button>
        </div>
      )}
      {mini && (
        <div className="youtube-mini-placeholder">
          <span>Видео в мини-плеере — можно читать чат</span>
          <button onClick={() => setMini(false)}>Вернуть видео на место</button>
        </div>
      )}
      <div
        key="player"
        ref={shell}
        hidden={!!pipWindow}
        style={floating.style}
        className={`youtube-player-shell${mini ? " youtube-mini" : ""}`}
      >
        {mini && (
          <div className="mini-drag-bar">
            <span {...floating.drag}>Переместить</span>
            <button
              aria-label="Уменьшить мини-плеер"
              onClick={() => floating.grow(-60)}
            >
              −
            </button>
            <button
              aria-label="Увеличить мини-плеер"
              onClick={() => floating.grow(60)}
            >
              +
            </button>
          </div>
        )}
        {fallback ? (
          <iframe
            title="Прямой эфир YouTube"
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div ref={mount} className="youtube-mount" />
        )}
        {!fallback && !started && !blocked && !error && (
          <div className="broadcast-loading" role="status"><span className="broadcast-spinner" /><strong>Трансляция запускается</strong><span>Оставайтесь в комнате — видео скоро появится</span></div>
        )}
        {!fallback && ready && (
          <PlaybackControls
            onMini={detached || mobilePlayer ? undefined : () => void toggleMini()}
            onPip={
              !detached && window.documentPictureInPicture
                ? () => void openPip()
                : undefined
            }
            mini={mini}
            fullscreen={fullscreen}
            playing={playing}
            muted={muted}
            volume={volume}
            onPlay={() => {
              if (playing) {
                wantsPlayback.current = false;
                onIntentChange?.(false);
                player.current?.pauseVideo();
              } else playManually();
            }}
            onMute={() => {
              if (muted) player.current?.unMute();
              else player.current?.mute();
              muteRef.current = !muted;
              setMuted(!muted);
              onAudioChange?.(!muted, volume);
            }}
            onVolume={(v) => {
              player.current?.setVolume(v * 100);
              player.current?.unMute();
              setVolume(v);
              muteRef.current = false;
              setMuted(false);
              onAudioChange?.(false, v);
            }}
            onFullscreen={() => {
              const el = shell.current;
              if (ownerDocument.fullscreenElement)
                void ownerDocument.exitFullscreen();
              else if (el?.requestFullscreen)
                void el
                  .requestFullscreen()
                  .catch(() =>
                    setError("Полный экран недоступен в этом браузере"),
                  );
              else
                setError("Для полного экрана поверните телефон горизонтально");
            }}
          />
        )}
        {mini && (
          <button
            className="mini-resize-grip"
            aria-label="Изменить размер мини-плеера"
            {...floating.resize}
          >
            ◢
          </button>
        )}
        {blocked && (
          <button className="btn quiet" onClick={playManually}>
            Продолжить просмотр
          </button>
        )}
        {muted && ready && (
          <button
            className="player-sound-hint"
            onClick={() => {
              player.current?.unMute();
              muteRef.current = false;
              setMuted(false);
              onAudioChange?.(false, volume);
              playManually();
            }}
          >
            Включить звук
          </button>
        )}
        {fallback && !detached && !mobilePlayer && (
          <div className="youtube-mini-actions">
            <button onClick={() => void toggleMini()} aria-pressed={mini}>
              {mini ? "Вернуть видео на место" : "Мини-плеер"}
            </button>
          </div>
        )}
        {error && (
          <p className="player-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
