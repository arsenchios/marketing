export type PlaybackSample = { playing: boolean; position: number };
export type PlaybackEvent = (
  kind: string,
  details?: { seconds?: number; position?: number },
) => void;
// Measure advancing video, not open tabs, buffering time or seek jumps.
export function measurePlayback(
  previous: number | null,
  current: PlaybackSample,
  wallSeconds: number,
  visible: boolean,
) {
  if (
    !visible ||
    !current.playing ||
    previous === null ||
    !Number.isFinite(current.position)
  )
    return 0;
  const delta = current.position - previous;
  return delta > 0 && delta <= 2.5 && wallSeconds > 0 && wallSeconds <= 2.5
    ? Math.min(delta, wallSeconds)
    : 0;
}
export function startWatchTelemetry(
  read: () => PlaybackSample,
  emit: PlaybackEvent,
  context: Window = window,
) {
  let previous: number | null = null,
    last = context.performance.now(),
    accumulated = 0,
    ticks = 0,
    position = 0;
  const flush = () => {
    if (accumulated >= 0.25)
      emit("watch_heartbeat", { seconds: Math.min(15, accumulated), position });
    accumulated = 0;
  };
  const timer = context.setInterval(() => {
    const now = context.performance.now(),
      sample = read();
    accumulated += measurePlayback(
      previous,
      sample,
      (now - last) / 1000,
      !context.document.hidden || !!context.document.pictureInPictureElement,
    );
    previous =
      sample.playing &&
      (!context.document.hidden || !!context.document.pictureInPictureElement)
        ? sample.position
        : null;
    position = Number.isFinite(sample.position)
      ? Math.max(0, sample.position)
      : 0;
    last = now;
    if (++ticks >= 15) {
      flush();
      ticks = 0;
    }
  }, 1000);
  return () => {
    context.clearInterval(timer);
    flush();
  };
}
