import { useState } from "react";
import { api } from "./api";
const labels: Record<string, string> = {
  local_recording_removed:
    "Облачная копия проверена — локальные видеофайлы удалены",
  delivery_selected: "Выбран источник для зрителей",
  archive_disk_pressure:
    "Освобождено место для продолжения YouTube, проверьте полноту резервной записи",
  youtube_relay_closed: "Прервалась передача в YouTube",
  youtube_finish_failed:
    "Не удалось завершить эфир на YouTube — проверьте Studio",
  quality_reduced: "Снижено качество для устойчивой связи",
  studio_resumed: "Ведущий вернулся в студию",
  sender_connect: "Подключение ведущего",
  sender_closed: "Соединение ведущего закрыто",
  sender_queue_full: "Не успеваем отправлять видео",
  tab_hidden: "Вкладка студии в фоне",
  tab_visible: "Возврат в студию",
  encoder_started: "Кодировщик запущен",
  encoder_closed: "Кодировщик остановлен",
  encoder_error: "Ошибка кодирования",
  encoder_queue_full: "Сервер не успевает обрабатывать видео",
  media_timeout: "Нет данных от ведущего 15 секунд",
  media_closed: "Передача закрыта",
  encoder_progress: "Скорость кодирования",
  preflight_passed: "Проверка записи завершена",
  preflight_cloud_failed: "Проверка хранилища не пройдена",
};
export function Diagnostics({ id }: { id: string }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setData(await api(`/api/admin/webinars/${id}/diagnostics`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="preflight-panel"
      style={{ margin: "16px 0" }}
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>Диагностика эфира</summary>
      <p>
        Последние технические события этого вебинара · хранение 7 дней ·
        содержимое сообщений и ключи не записываются
      </p>
      <button className="btn quiet" disabled={busy} onClick={load}>
        Обновить диагностику
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            Кодировщик: {data.checks.ffmpeg ? "готов" : "недоступен"} · На диске
            сервера свободно: {(data.checks.freeBytes / 1024 ** 3).toFixed(1)}{" "}
            ГБ · Хранилище:{" "}
            {data.checks.r2
              ? "настроено — доступ проверяется перед эфиром"
              : "не настроен"}
          </p>
          <p>
            У зрителей за этот вебинар:{" "}
            {data.viewerStats
              ?.map(
                (r: any) =>
                  `${r.kind === "buffering" ? "буферизация" : "ошибки видео"}: ${r.count}`,
              )
              .join(" · ") || "ошибок и ожиданий пока не зафиксировано"}
          </p>
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            {data.entries.length ? (
              data.entries.map((r: any, i: number) => (
                <p key={i}>
                  <time>{new Date(r.at).toLocaleTimeString("ru")}</time> —{" "}
                  {labels[r.kind] || r.kind}
                  {Object.keys(r.values).length > 0 && (
                    <small>
                      {" "}
                      ·{" "}
                      {Object.entries(r.values)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ")}
                    </small>
                  )}
                </p>
              ))
            ) : (
              <p>Событий пока нет — запустите проверку или короткий эфир</p>
            )}
          </div>
        </>
      )}
    </details>
  );
}
