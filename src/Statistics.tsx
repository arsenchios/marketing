import { csvCell } from "../shared/statistics";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Download,
  RefreshCw,
  Users,
  Clock,
  MessageCircle,
  MousePointerClick,
} from "lucide-react";
import { Header, Notice } from "./ui";
import { api } from "./api";
import type { StatsReport, StatsTimeline } from "../shared/statistics";
const duration = (seconds: number) =>
  `${Math.floor(Math.round(seconds) / 60)} мин ${Math.round(seconds) % 60} с`;
const date = (value: string) =>
  new Date(value).toLocaleString("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const devices: Record<string, string> = {
  mobile: "Телефон",
  tablet: "Планшет",
  desktop: "Компьютер",
  unknown: "Не определено",
};
export function Statistics() {
  const [event, setEvent] = useState(
    new URLSearchParams(location.search).get("event") || "",
  );
  const [run, setRun] = useState(
    new URLSearchParams(location.search).get("run") || "",
  );
  const [days, setDays] = useState(event ? 365 : 30),
    [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<StatsReport | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<{ id: string; title: string }[]>([]);
  const [metric, setMetric] = useState<
    "present" | "watching" | "messages" | "clicks" | "entries" | "exits"
  >("present");
  const [selected, setSelected] = useState<StatsTimeline | null>(null),
    [page, setPage] = useState(0),
    [search, setSearch] = useState("");
  useEffect(() => {
    void api("/api/events")
      .then((d) => setOptions(d.events))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setSelected(null);
    setPage(0);
    void api(
      `/api/statistics?days=${days}${event ? "&event=" + encodeURIComponent(event) : ""}${run ? "&run=" + encodeURIComponent(run) : ""}`,
      { signal: abort.signal },
    )
      .then((d) => {
        if (!abort.signal.aborted) setReport(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [event, run, days, refresh]);
  const current =
    report &&
    report.selectedId === (event || null) &&
    (report.selectedRunId || null) === (run || null)
      ? report
      : null;
  const exportCSV = () => {
    if (!current) return;
    const rows = [
      [
        "Вебинар",
        "Зритель",
        "Первый вход",
        "Последняя активность",
        "Просмотр, секунд",
        "В комнате, секунд (оценка)",
        "Сообщения",
        "Клики",
        "Устройство",
        "Часовой пояс",
        "Источник",
        "Последняя позиция видео, секунд",
      ],
      ...current.people.map((p) => [
        current.events.find((e) => e.id === p.eventId)?.title,
        p.name,
        p.firstAt,
        p.lastAt,
        Math.round(p.watchSeconds),
        Math.round(p.roomSeconds),
        p.messages,
        p.clicks,
        devices[p.device],
        p.timezone,
        p.source,
        p.lastPosition,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(
        ["\ufeff" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "webinar-statistics.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const visitors =
    current?.people.filter((p) =>
      p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) || [];
  const max = Math.max(1, ...(current?.timeline.map((b) => b[metric]) || []));
  return (
    <>
      <Header active="statistics" />
      <main className="page statistics-page">
        <div className="page-heading">
          <div>
            <h1>
              Статистика <span className="gold-text">вебинаров</span>
            </h1>
            <p>
              {run
                ? "Активность от запуска до завершения этой передачи. Отклики после завершения — в общей статистике вебинара"
                : "Реальные зрители, просмотр и отклик на ваше предложение"}
            </p>
          </div>
          <div className="stats-actions">
            <button
              className="btn small"
              disabled={loading}
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw size={16} />
              Обновить
            </button>
            <button
              className="btn small"
              disabled={!current || loading}
              onClick={exportCSV}
            >
              <Download size={16} />
              Скачать CSV
            </button>
          </div>
        </div>
        <div className="stats-filters">
          <label>
            Вебинар
            <select
              aria-label="Вебинар"
              value={event}
              onChange={(e) => {
                setEvent(e.target.value);
                setRun("");
                history.replaceState(
                  null,
                  "",
                  e.target.value
                    ? "/statistics?event=" + e.target.value
                    : "/statistics",
                );
              }}
            >
              <option value="">Все вебинары</option>
              {[
                ...options,
                ...(report?.events || []).filter(
                  (e) => !options.some((o) => o.id === e.id),
                ),
              ].map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </label>
          {event && !!report?.runs?.length && (
            <label>
              Передача
              <select
                aria-label="Передача"
                value={run}
                onChange={(e) => {
                  setRun(e.target.value);
                  history.replaceState(
                    null,
                    "",
                    `/statistics?event=${event}${e.target.value ? `&run=${e.target.value}` : ""}`,
                  );
                }}
              >
                <option value="">Все передачи вебинара</option>
                {report.runs.map((r, i, all) => (
                  <option value={r.id} key={r.id}>
                    Передача {all.length - i} · {date(r.createdAt)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            Период
            <select
              aria-label="Период"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[7, 30, 90, 365].map((n) => (
                <option key={n} value={n}>
                  Последние {n} дней
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            {loading
              ? "Обновляем…"
              : current
                ? "Обновлено " + date(current.generatedAt)
                : ""}
          </span>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {current && (
          <>
            {current.truncated && (
              <Notice tone="error">
                Показаны последние 100 000 событий. Сократите период или
                выберите один вебинар для полного отчёта
              </Notice>
            )}
            <div className="stats-cards">
              {[
                [
                  Users,
                  event ? "Зрители" : "Участия в вебинарах",
                  current.summary.viewers,
                  "Уникальные браузеры в каждом вебинаре",
                ],
                [
                  Users,
                  "Пик одновременно",
                  current.summary.peak,
                  "Оценка по сигналам присутствия",
                ],
                [
                  Clock,
                  "Время просмотра",
                  current.summary.watchSeconds
                    ? duration(current.summary.watchSeconds)
                    : "—",
                  "Фактически проигранное и измеренное время",
                ],
                [
                  Clock,
                  "Средний просмотр",
                  current.summary.averageSeconds
                    ? duration(current.summary.averageSeconds)
                    : "—",
                  "Среди зрителей с измеренным просмотром",
                ],
                [
                  MessageCircle,
                  "Сообщения",
                  current.summary.messages,
                  "Только зрители, без сценарных заготовок",
                ],
                [
                  MousePointerClick,
                  "Клики по предложению",
                  current.summary.clicks,
                  `${current.summary.clickers} зрителей нажали кнопку`,
                ],
              ].map(([Icon, label, value, hint]) => {
                const I = Icon as typeof Users;
                return (
                  <section className="stats-card" key={String(label)}>
                    <I size={19} />
                    <span>{String(label)}</span>
                    <strong>{String(value)}</strong>
                    <small>{String(hint)}</small>
                  </section>
                );
              })}
            </div>
            <section className="stats-section">
              <div className="stats-section-heading">
                <div>
                  <h2>
                    <BarChart3 size={20} />
                    Активность {event ? "по минутам" : "по дням"}
                  </h2>
                  <p className="muted">
                    {event
                      ? "Минута 0 — начало записи. Отрицательные минуты — ожидание до эфира"
                      : "Дни показаны по UTC. Выберите вебинар для поминутного анализа"}
                  </p>
                </div>
                <select
                  aria-label="Показатель графика"
                  value={metric}
                  onChange={(e) => {
                    setMetric(e.target.value as typeof metric);
                    setSelected(null);
                  }}
                >
                  {Object.entries({
                    present: "В комнате",
                    watching: "Смотрели видео",
                    messages: "Сообщения",
                    clicks: "Клики",
                    entries: "Входы",
                    exits: "Уходы",
                  }).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {!current.timeline.length ? (
                <p className="stats-empty">
                  Пока нет данных за выбранный период
                </p>
              ) : (
                <>
                  <div className="stats-chart" aria-label="График активности">
                    {current.timeline.map((b, i) => (
                      <button
                        key={i}
                        style={{
                          height: Math.max(2, (b[metric] / max) * 100) + "%",
                        }}
                        title={`${b.label}: ${b[metric]}`}
                        aria-label={`${b.label}: ${b[metric]}`}
                        onClick={() => setSelected(b)}
                      />
                    ))}
                  </div>
                  <div className="stats-chart-labels">
                    <span>{current.timeline[0]?.label}</span>
                    <span>{current.timeline.at(-1)?.label}</span>
                  </div>
                  <p className="stats-chart-detail">
                    {selected
                      ? `${selected.label} · В комнате: ${selected.present} · Смотрели: ${selected.watching} · Входы: ${selected.entries} · Уходы: ${selected.exits} · Сообщения: ${selected.messages} · Клики: ${selected.clicks}`
                      : "Нажмите на столбец, чтобы увидеть показатели этого момента"}
                  </p>
                </>
              )}
              <details>
                <summary>Таблица активности</summary>
                <div className="stats-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Момент</th>
                        <th>В комнате</th>
                        <th>Смотрели</th>
                        <th>Входы</th>
                        <th>Уходы</th>
                        <th>Сообщения</th>
                        <th>Клики</th>
                      </tr>
                    </thead>
                    <tbody>
                      {current.timeline.map((b, i) => (
                        <tr key={i}>
                          <td>{b.label}</td>
                          <td>{b.present}</td>
                          <td>{b.watching}</td>
                          <td>{b.entries}</td>
                          <td>{b.exits}</td>
                          <td>{b.messages}</td>
                          <td>{b.clicks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
            <div className="stats-breakdowns">
              {[
                ["Устройства", current.devices],
                ["Часовые пояса", current.timezones],
                ["Источники перехода", current.sources],
              ].map(([title, values]) => (
                <section className="stats-section" key={String(title)}>
                  <h2>{String(title)}</h2>
                  {Object.entries(values as Record<string, number>)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([key, n]) => (
                      <div className="stats-breakdown" key={key}>
                        <span>
                          {title === "Устройства"
                            ? devices[key]
                            : key === "unknown"
                              ? "Не определено"
                              : key}
                        </span>
                        <b>{n}</b>
                      </div>
                    ))}
                </section>
              ))}
            </div>
            <section className="stats-section">
              <h2>Просмотр и предложение</h2>
              <div className="stats-inline">
                <span>
                  Запустили видео <b>{current.summary.played}</b>
                </span>
                <span>
                  Просмотр эфира <b>{duration(current.summary.liveSeconds)}</b>
                </span>
                <span>
                  Просмотр записи{" "}
                  <b>{duration(current.summary.replaySeconds)}</b>
                </span>
                <span>
                  Увидели предложение <b>{current.summary.offerViewers}</b>
                </span>
                <span>
                  Буферизация <b>{current.summary.buffering}</b>
                </span>
                <span>
                  Ошибки видео <b>{current.summary.errors}</b>
                </span>
              </div>
            </section>
            {!event && (
              <section className="stats-section">
                <h2>Сравнение вебинаров</h2>
                <div className="stats-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Вебинар</th>
                        <th>Зрители</th>
                        <th>Просмотр</th>
                        <th>Сообщения</th>
                        <th>Клики</th>
                      </tr>
                    </thead>
                    <tbody>
                      {current.webinars.map((w) => (
                        <tr key={w.id}>
                          <td>
                            <button
                              className="stats-link"
                              onClick={() => setEvent(w.id)}
                            >
                              {w.title}
                            </button>
                          </td>
                          <td>{w.viewers}</td>
                          <td>{duration(w.watchSeconds)}</td>
                          <td>{w.messages}</td>
                          <td>{w.clicks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <section className="stats-section">
              <div className="stats-section-heading">
                <h2>Зрители · {visitors.length}</h2>
                <input
                  aria-label="Найти зрителя"
                  placeholder="Поиск по имени"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
              </div>
              <div className="stats-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Зритель</th>
                      <th>Первый вход</th>
                      <th>Последняя активность</th>
                      <th>Просмотр</th>
                      <th>Сообщения / клики</th>
                      <th>Устройство</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitors.slice(page * 50, (page + 1) * 50).map((p) => (
                      <tr key={p.key}>
                        <td>
                          <strong>{p.name}</strong>
                          <details>
                            <summary>Подробнее</summary>
                            <p>
                              {
                                current.events.find((w) => w.id === p.eventId)
                                  ?.title
                              }
                            </p>
                            <p>В комнате ≈ {duration(p.roomSeconds)}</p>
                            <p>Часовой пояс: {p.timezone || "не определён"}</p>
                            <p>Источник: {p.source || "не определён"}</p>
                            <p>
                              Последняя активность относительно начала:{" "}
                              {(() => {
                                const start = current.events.find(
                                  (w) => w.id === p.eventId,
                                )?.startedAt;
                                return start
                                  ? duration(
                                      Math.max(
                                        0,
                                        (Date.parse(p.lastAt) -
                                          Date.parse(start)) /
                                          1000,
                                      ),
                                    )
                                  : "нет данных";
                              })()}
                            </p>
                            <p>
                              Позиция плеера:{" "}
                              {p.lastPosition === null
                                ? "нет данных"
                                : duration(p.lastPosition)}
                            </p>
                          </details>
                        </td>
                        <td>{date(p.firstAt)}</td>
                        <td>{date(p.lastAt)}</td>
                        <td>
                          {p.watchSeconds ? duration(p.watchSeconds) : "—"}
                        </td>
                        <td>
                          {p.messages} / {p.clicks}
                        </td>
                        <td>{devices[p.device]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="stats-actions">
                <button
                  className="btn small"
                  disabled={!page}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Назад
                </button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(visitors.length / 50))}
                </span>
                <button
                  className="btn small"
                  disabled={(page + 1) * 50 >= visitors.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Далее
                </button>
              </div>
            </section>
            <details className="stats-section stats-method">
              <summary>Как считаются показатели</summary>
              <p>
                Искусственный счётчик, заготовленные сообщения и действия
                ведущего не учитываются. Один браузер в разных вкладках
                объединяется в одного зрителя внутри вебинара. В общем отчёте
                один человек на двух вебинарах — два участия
              </p>
              <p>
                Присутствие оценивается по сигналам каждые 15 секунд; без
                сигнала выхода погрешность около 20 секунд. «Уход» может
                означать разрыв связи. На графике — уникальные активные зрители
                в каждом интервале, а не число одновременных подключений
              </p>
              <p>
                Просмотр считается только при движении видео в видимой вкладке,
                без пауз, буферизации и перемотки. Фоновое аудио, внешний
                YouTube и резервный iframe без API не измеряются. Исторические
                события до обновления сохраняются, но их длительность и
                устройства восстановить нельзя — ноль здесь может означать
                отсутствие измерений
              </p>
              <p>
                Источник — только домен перехода, если браузер его передал.
                Часовой пояс не определяет точное местоположение. IP-адреса не
                сохраняются. Это статистика браузерных событий, а не
                подтверждённые личности
              </p>
            </details>
          </>
        )}
      </main>
    </>
  );
}
