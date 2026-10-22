import { MicrophoneCheck } from "./MicrophoneCheck";
import {
  Check,
  LoaderCircle,
  Video,
  Mic,
  ShieldCheck,
  Wifi,
  Play,
  RefreshCw,
} from "lucide-react";
export function StudioPreflight({
  ready,
  heard,
  muted,
  camera,
  volume,
  record,
  network,
  networkLabel,
  running,
  countdown,
  canStart,
  onCheck,
  onStart,
  onHide,
  problem,
  audioStream,
  onMicBusy,
  guest = false,
  recoveryUrl,
}: {
  guest?: boolean;
  recoveryUrl?: string;
  audioStream: () => MediaStream | undefined;
  onMicBusy: (busy: boolean) => void;
  ready: boolean;
  heard: boolean;
  muted: boolean;
  camera: boolean;
  volume: number;
  record: string;
  network: string;
  networkLabel: string;
  running: boolean;
  countdown: boolean;
  canStart: boolean;
  onCheck: () => void;
  onStart: () => void;
  onHide: () => void;
  problem: string;
}) {
  const items = [
    {
      name: "Камера",
      icon: Video,
      done: ready && camera,
      waiting: running && !ready,
      detail: ready
        ? camera
          ? "Изображение включено"
          : "Включите камеру"
        : "Разрешите доступ",
    },
    {
      name: "Микрофон",
      icon: Mic,
      done: ready && heard && !muted,
      waiting: ready && !heard && !muted,
      detail: muted
        ? "Включите микрофон"
        : heard
          ? "Звук поступает"
          : "Скажите несколько слов",
    },
    {
      name: guest ? "Общий эфир" : "Запись",
      icon: ShieldCheck,
      done: guest || record === "ready",
      waiting: record === "checking",
      detail: guest
        ? "Запускает главный ведущий"
        : record === "ready"
          ? "Сохранение проверено"
          : record === "failed"
            ? "Нужно повторить"
            : "Проверим автоматически",
    },
    {
      name: "Соединение",
      icon: Wifi,
      done: network === "ready",
      waiting: network === "checking",
      detail: networkLabel || "Проверим отправку данных",
    },
  ];
  return (
    <section
      className={`stage-preflight ${ready ? "has-preview" : ""}`}
      aria-label="Проверка перед эфиром"
    >
      <div className="preflight-heading">
        <div>
          <span className="eyebrow">ПЕРЕД НАЧАЛОМ</span>
          <h2>{canStart ? "Можно начинать" : "Проверим всё перед эфиром"}</h2>
        </div>
        <span className="preflight-private">Видно только вам</span>
      </div>
      <div className="preflight-steps">
        {items.map(({ name, icon: Icon, done, waiting, detail }) => (
          <div
            key={name}
            className={`preflight-step ${done ? "done" : ""} ${waiting ? "checking" : ""}`}
          >
            <span className="preflight-step-icon">
              {done ? (
                <Check size={17} />
              ) : waiting ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Icon size={17} />
              )}
            </span>
            <div>
              <strong>{name}</strong>
              <small>{detail}</small>
            </div>
            {name === "Микрофон" && ready && (
              <span className="check-volume" aria-label="Уровень микрофона">
                <i style={{ height: `${Math.max(4, volume * 100)}%` }} />
              </span>
            )}
          </div>
        ))}
      </div>
      {ready && !muted && (
        <MicrophoneCheck stream={audioStream} onBusy={onMicBusy} />
      )}
      <p className="preflight-tip">
        Перед эфиром закройте лишние вкладки, плееры и фоновые загрузки.
        Оставьте студию открытой.
      </p>
      {problem && (
        <p className="preflight-problem" role="alert">
          {problem}
        </p>
      )}
      {recoveryUrl && <p><a className="btn quiet small" href={recoveryUrl} target="_blank" rel="noreferrer">Открыть активную студию</a></p>}
      <div className="preflight-actions">
        {!ready ||
        record !== "ready" ||
        network === "failed" ||
        network === "idle" ? (
          <button
            className="btn primary"
            disabled={running || countdown}
            onClick={onCheck}
          >
            {running ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ShieldCheck size={16} />
            )}{" "}
            {running
              ? "Проверяем…"
              : ready
                ? "Повторить проверку"
                : "Проверить камеру и звук"}
          </button>
        ) : (
          <button
            className="btn quiet small"
            disabled={running || countdown}
            onClick={onCheck}
          >
            <RefreshCw size={15} />
            Проверить ещё раз
          </button>
        )}
        {ready && (
          <button
            className="btn primary"
            disabled={!canStart || countdown}
            onClick={onStart}
          >
            <Play size={16} />
            {guest ? "Присоединиться к ведущему" : "Начать эфир"}
          </button>
        )}
      </div>
      {ready && !running && (
        <button className="preflight-hide" onClick={onHide}>
          Скрыть проверку
        </button>
      )}
    </section>
  );
}
