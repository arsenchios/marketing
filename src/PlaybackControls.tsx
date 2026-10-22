import {
  Maximize,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  PictureInPicture2,
} from "lucide-react";
export function PlaybackControls({
  playing,
  muted,
  volume,
  onPlay,
  onMute,
  onVolume,
  onFullscreen,
  onPip,
  onMini,
  mini = false,
  fullscreen = false,
}: {
  playing: boolean;
  muted: boolean;
  volume: number;
  onPlay: () => void;
  onMute: () => void;
  onVolume: (value: number) => void;
  onFullscreen: () => void;
  onPip?: () => void;
  onMini?: () => void;
  mini?: boolean;
  fullscreen?: boolean;
}) {
  return (
    <div
      className="playback-controls"
      role="group"
      aria-label="Управление видео"
    >
      <button
        onClick={onPlay}
        aria-label={playing ? "Пауза" : "Продолжить просмотр"}
        title={playing ? "Пауза" : "Продолжить просмотр"}
      >
        {playing ? <Pause size={19} /> : <Play size={19} />}
      </button>
      <button
        onClick={onMute}
        aria-label={muted ? "Включить звук" : "Выключить звук"}
        title={muted ? "Включить звук" : "Выключить звук"}
      >
        {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={muted ? 0 : volume}
        aria-label="Громкость"
        onChange={(e) => onVolume(Number(e.target.value))}
      />
      <span className="playback-spacer" />
      {onMini && (
        <button
          onClick={onMini}
          aria-label={mini ? "Вернуть видео на место" : "Мини-плеер"}
          title={mini ? "Вернуть видео на место" : "Мини-плеер внутри страницы"}
          aria-pressed={mini}
        >
          {mini ? <Minimize2 size={19} /> : <PictureInPicture2 size={19} />}
        </button>
      )}
      {onPip && (
        <button
          onClick={onPip}
          aria-label="Картинка в картинке"
          title="Картинка в картинке"
        >
          <PictureInPicture2 size={19} />
        </button>
      )}
      <button
        onClick={onFullscreen}
        aria-label={fullscreen ? "Выйти из полного экрана" : "На весь экран"}
        title="На весь экран"
      >
        {fullscreen ? <Minimize2 size={19} /> : <Maximize size={19} />}
      </button>
    </div>
  );
}
