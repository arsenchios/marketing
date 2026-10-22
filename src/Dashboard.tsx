import { AudienceSettings } from "./AudienceSettings";
import { platformBrand } from "../shared/brand";
import { PRESENTATION_BYTES } from "../shared/presentation";
import { DeleteWebinar } from "./DeleteWebinar";
import {
  YouTubeRecordingLink,
  RecordingStorageStatus,
} from "./BroadcastIdentity";
import { Archive, DownloadDeadline, durationLabel } from "./Archive";
import { recordingExpired, retentionText } from "../shared/retention";
import { displayLabel } from "./ui";
import { useEffect, useState } from "react";
import {
  ChevronDown,
  ArrowUpRight,
  Plus,
  Play,
  CalendarDays,
  Clock3,
  Video,
  ArrowLeft,
  Save,
  Upload,
  Check,
  ExternalLink,
  Layers,
  Download,
  Monitor,
  ChevronRight,
} from "lucide-react";
import type { Webinar, EventInput, Recording } from "../shared/contracts";
import { api, send, assetUrl, dateLabel } from "./api";
import { Header, Brand, Badge, Notice, CopyButton } from "./ui";

export function Dashboard() {
  const [authConfig, setAuthConfig] = useState<{
    mode: string;
    google: boolean;
    ready: boolean;
  } | null>(null);
  useEffect(() => {
    api("/api/auth/config")
      .then(setAuthConfig)
      .catch(() => setAuthConfig(null));
  }, []);
  const [events, setEvents] = useState<Webinar[]>([]);
  const [filter, setFilter] = useState("all");
  const [canCreate, setCanCreate] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recordings, setRecordings] = useState<
    (Recording & { title: string })[]
  >([]);
  const tab = new URLSearchParams(location.search).get("tab");
  const pendingArchive = recordings.some(
    (r) => r.archive?.state === "pending" || r.archive?.state === "uploading",
  );
  useEffect(() => {
    if (tab !== "recordings") return;
    const timer = setInterval(
      () => void load(),
      pendingArchive ||
        recordings.some(
          (r) => r.state === "processing" || r.state === "recording",
        )
        ? 2500
        : 60000,
    );
    return () => clearInterval(timer);
  }, [
    pendingArchive,
    tab,
    recordings.some((r) => r.state === "processing" || r.state === "recording"),
  ]);
  async function load() {
    try {
      const d = await api("/api/events");
      setEvents(d.events);
      setCanCreate(!!d.canCreate);
      setReady(true);
      if (tab === "recordings") {
        const all = await Promise.all(
          d.events.map(async (w: Webinar) => {
            const room = await api(`/api/events/${w.id}`);
            return room.recordings.map((r: Recording) => ({
              ...r,
              title: w.title,
            }));
          }),
        );
        setRecordings(all.flat());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function enter() {
    if (authConfig?.mode !== "local") {
      location.assign("/api/auth/google/start");
      return;
    }
    setBusy(true);
    try {
      await send("/api/auth/local");
      setError("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    try {
      const w = await send("/api/events", { title: "Новый вебинар" });
      location.href = `/event/${w.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  if (loading)
    return (
      <div className="workspace-loading">
        <Brand />
        <p role="status">Открываем ваш кабинет…</p>
      </div>
    );
  if (!ready)
    return (
      <div className="login-page">
        <Brand />
        <div className="login-art">
          <div className="orb" />
          <div className="orbit one" />
          <div className="orbit two" />
          <div className="login-art-label"><span /> ЖИВОЙ РАЗГОВОР</div>
          <div className="login-art-note"><Video size={18} /><span>Камера, слайды и чат<br /><b>В одном пространстве</b></span></div>
        </div>
        <main className="login-content">
          <div className="eyebrow">{platformBrand.tagline}</div>
          <h1>
            Ваши идеи.
            <br />
            <em>Живой разговор.</em>
          </h1>
          <p>
            Соберите людей вокруг своей темы. Подготовьте презентацию,
            пригласите спикера и начните эфир — всё уже в вашей комнате
          </p>
          <button
            className="btn primary large"
            onClick={enter}
            disabled={
              busy ||
              !authConfig ||
              (authConfig.mode !== "local" && !authConfig.google)
            }
          >
            {authConfig?.mode === "public"
              ? "Войти через Google"
              : "Войти в кабинет"}{" "}
            <ArrowUpRight size={20} />
          </button>
          <small>
            {authConfig?.ready === false
              ? "Сервис запущен — вход в кабинет ещё настраивается"
              : "Войдите, чтобы подготовить вебинар"}
          </small>
          {new URLSearchParams(location.search).has("auth_error") && (
            <Notice tone="error">
              Не удалось войти — используйте Google-аккаунт, которому
              предоставлен доступ к кабинету
            </Notice>
          )}
          {error && !error.includes("Войдите") && (
            <Notice tone="error">{error}</Notice>
          )}
        </main>
        <footer>{platformBrand.name} <span>Эфиры, в которых удобно быть</span></footer>
      </div>
    );
  return (
    <>
      <Header active={tab === "recordings" ? "recordings" : "events"} />
      <main className="page dashboard">
        <div className="page-heading">
          <div>
            <div className="eyebrow">ВАШЕ ПРОСТРАНСТВО</div>
            <h1>
              {tab === "recordings" ? (
                "Библиотека записей"
              ) : (
                <>
                  Ваши <span className="gold-text">вебинары</span>
                </>
              )}
            </h1>
            <p>
              {tab === "recordings"
                ? "Записи эфиров: голос, камера, слайды и ваши пометки"
                : "Создайте комнату и назначьте дату. Здесь будут предстоящие и завершённые вебинары"}
            </p>
          </div>
          {tab !== "recordings" && canCreate && (
            <button className="btn primary" onClick={create} disabled={busy}>
              <Plus size={18} />
              Новый вебинар
            </button>
          )}
        </div>
        {error && <Notice tone="error">{error}</Notice>}

        {tab === "recordings" ? (
          <div className="recording-list">
            {recordings.length ? (
              recordings.map((r) => (
                <article className="record-card" key={r.id}>
                  <div className="record-preview">
                    <Video size={35} />
                  </div>
                  <div>
                    <span className="eyebrow">
                      {recordingExpired(r)
                        ? "СРОК ХРАНЕНИЯ ИСТЁК"
                        : r.state === "ready"
                          ? "ГОТОВО"
                          : r.state === "incomplete"
                            ? "ЕСТЬ ПРОПУСКИ"
                            : r.assemblyPending
                              ? "СОХРАНЕНИЕ БУДЕТ ПОВТОРЕНО"
                              : r.state === "failed"
                                ? "ЗАПИСЬ НЕ УДАЛАСЬ"
                                : "ОБРАБОТКА"}
                    </span>
                    <h2>{displayLabel(r.title)}</h2>
                    <p>
                      {new Date(r.createdAt).toLocaleString("ru")} ·{" "}
                      {durationLabel(r.duration)}
                    </p>

                    <RecordingStorageStatus recording={r} />
                    <YouTubeRecordingLink youtube={r.youtube} />
                    {!recordingExpired(r) &&
                      r.archive?.state === "failed" &&
                      r.hasFile && (
                        <button
                          className="btn quiet small"
                          onClick={async () => {
                            try {
                              await send(
                                `/api/events/${r.eventId}/recordings/${r.id}/archive`,
                              );
                              await load();
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Повторить загрузку
                        </button>
                      )}
                  </div>
                  <DownloadDeadline recording={r} />
                  {r.hasFile && !recordingExpired(r) && (
                    <div className="record-actions">
                      <a
                        className="btn primary"
                        href={`/api/events/${r.eventId}/recordings/${r.id}/download`}
                      >
                        <Download size={16} />
                        Скачать запись
                      </a>
                    </div>
                  )}
                  {r.hasFile && !recordingExpired(r) && (
                    <a
                      className="btn quiet"
                      href={`/api/events/${r.eventId}/recordings/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={16} />
                      Открыть запись
                    </a>
                  )}
                </article>
              ))
            ) : (
              <div className="empty-page">
                <Video size={36} />
                <h2>Ваш первый эфир ещё впереди</h2>
                <p>После завершения эфира запись появится здесь</p>
                <a className="btn quiet" href="/">
                  К вебинарам
                </a>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="dashboard-layout">
              <section>
                <div className="webinar-filters" aria-label="Фильтр вебинаров">
                  {[
                    ["all", "Все"],
                    ["upcoming", "Предстоящие"],
                    ["ended", "Завершённые"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={filter === value ? "selected" : ""}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}{" "}
                      <span>
                        {
                          events.filter(
                            (w) =>
                              value === "all" ||
                              (value === "ended"
                                ? w.state === "ended"
                                : w.state !== "ended"),
                          ).length
                        }
                      </span>
                    </button>
                  ))}
                </div>
                <div className="event-grid">
                  {events
                    .filter(
                      (w) =>
                        filter === "all" ||
                        (filter === "ended"
                          ? w.state === "ended"
                          : w.state !== "ended"),
                    )
                    .map((w) => (
                      <article className="event-card" key={w.id}>
                        <a
                          className="event-art"
                          href={
                            w.state === "ended"
                              ? `/archive/${w.id}`
                              : `/event/${w.id}`
                          }
                          style={
                            { "--accent": w.accent } as React.CSSProperties
                          }
                        >
                          {w.coverId ? (
                            <img
                              src={assetUrl(w.id, w.coverId)}
                              alt="Обложка вебинара"
                            />
                          ) : (
                            <>
                              <div className="event-orbit" />
                              <div className="event-sphere" />
                              <div className="event-art-title">
                                {w.state === "ended" ? "Запись" : "Прямой"}
                                <br />
                                <em>
                                  {w.state === "ended" ? "эфира" : "эфир"}
                                </em>
                              </div>
                              <span className="event-art-footer">
                                {w.state === "ended"
                                  ? "Посмотреть вебинар"
                                  : "Настроить комнату"}{" "}
                                <ArrowUpRight size={17} />
                              </span>
                            </>
                          )}
                          <div className="art-badge webinar-card-status">
                            <Badge state={w.state} />
                          </div>
                        </a>
                        <div className="event-details">
                          <div className="event-date">
                            <CalendarDays size={14} />
                            {w.state === "ended" && !w.startsAt
                              ? `Создан ${dateLabel(w.createdAt, w.timezone)}`
                              : dateLabel(w.startsAt, w.timezone)}
                          </div>
                          <h3>
                            <a
                              href={
                                w.state === "ended"
                                  ? `/archive/${w.id}`
                                  : `/event/${w.id}`
                              }
                            >
                              {displayLabel(w.title)}
                            </a>
                          </h3>
                          <p>{displayLabel(w.description)}</p>
                          {canCreate && (
                            <DeleteWebinar
                              webinar={w}
                              onDeleted={() =>
                                setEvents((events) =>
                                  events.filter((item) => item.id !== w.id),
                                )
                              }
                            />
                          )}
                          {canCreate && w.state !== "ended" && (
                            <a
                              className="btn quiet small"
                              href={`/speaker/${w.id}`}
                            >
                              Подключиться вторым спикером
                            </a>
                          )}
                          <div className="event-card-bottom">
                            <span>
                              <i className="mini-avatar">
                                {(w.hostName || "В").slice(0, 1)}
                              </i>
                              {w.hostName || "Ведущий не указан"}
                            </span>
                            <a
                              className="btn quiet small"
                              href={
                                w.state === "ended"
                                  ? `/archive/${w.id}`
                                  : `/studio/${w.id}`
                              }
                            >
                              {w.state === "ended"
                                ? "Открыть историю"
                                : "Проверить и запустить"}{" "}
                              <ArrowUpRight size={16} />
                            </a>
                          </div>
                        </div>
                      </article>
                    ))}
                </div>
              </section>
            </div>
            <div className="dashboard-footer">
              <span>
                {platformBrand.name} <i /> Вебинар
              </span>
            </div>
          </>
        )}
      </main>
    </>
  );
}

export function EventEditor({ id }: { id: string }) {
  const support = new URLSearchParams(location.search).has("support");
  const [w, setW] = useState<Webinar | null>(null);
  const [draft, setDraft] = useState<EventInput | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  async function load() {
    const d = await api(`/api/events/${id}`);
    setW(d.event);
    setDraft(d.event);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [id]);
  function field<K extends keyof EventInput>(key: K, value: EventInput[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : null));
    setSaved(false);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await send(`/api/events/${id}`, draft, "PATCH");
      setW(next);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | undefined, kind: string) {
    if (!file) return;
    if (file.size > (kind === "pdf" ? PRESENTATION_BYTES : 12 * 1024 * 1024)) {
      setError(
        kind === "pdf"
          ? "Выберите презентацию до 100 МБ"
          : "Выберите изображение до 12 МБ",
      );
      return;
    }
    setUploading(kind);
    setError("");
    try {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", file);
      const { id: asset } = await api(`/api/events/${id}/assets`, {
        method: "POST",
        body: form,
      });
      setW((prev) => (prev ? { ...prev, [kind + "Id"]: asset } : null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading("");
    }
  }
  if (!w || !draft)
    return (
      <>
        <Header />
        <main className="page">
          <Notice>{error || "Загружаем вебинар…"}</Notice>
          <a href="/">На главную</a>
        </main>
      </>
    );
  if (w.state === "ended") return <Archive id={id} />;
  const disabled = ["starting", "live", "reconnecting", "stopping"].includes(
    w.state,
  );
  return (
    <>
      <Header />
      <main className="page editor">
        <div className="breadcrumb">
          <a href="/">
            <ArrowLeft size={14} />
            Вебинары
          </a>
          <span>/</span>
          <span>Подготовка</span>
        </div>
        <div className="page-heading">
          <div>
            <h1>
              Подготовка <span className="gold-text">эфира</span>
            </h1>
            <p>
              Укажите тему, дату и ведущего. Добавьте презентацию, если она
              нужна
            </p>
          </div>
          <button
            className="btn primary"
            disabled={busy || !!uploading}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                if (!disabled) await send(`/api/events/${id}`, draft, "PATCH");
                location.assign(`/${support ? "assist" : "studio"}/${id}`);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <Video size={18} />
            {disabled
              ? "Открыть студию"
              : support
                ? "Сохранить и открыть студию"
                : "Проверить и запустить"}
            <ArrowUpRight size={16} />
          </button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {disabled && (
          <Notice>Эфир идёт — завершите его перед изменением настроек</Notice>
        )}
        <div className="editor-layout">
          <form onSubmit={save}>
            <fieldset disabled={disabled || busy}>
              <section className="form-section">
                <div className="section-title">
                  <h2>
                    <span className="step-label">01</span>О вебинаре
                  </h2>
                  <Badge state={w.state} />
                </div>
                <label className="field">
                  Название
                  <input
                    required
                    maxLength={120}
                    placeholder="Например, как выбрать курс по дизайну"
                    value={draft.title}
                    onChange={(e) => field("title", e.target.value)}
                  />
                </label>
                <label className="field">
                  Описание
                  <textarea
                    rows={2}
                    maxLength={2000}
                    aria-label="Описание вебинара"
                    placeholder="О чём расскажете и что узнают участники"
                    value={draft.description}
                    onChange={(e) => field("description", e.target.value)}
                  />
                </label>
                <div className="field-grid">
                  <label className="field">
                    Ведущий
                    <input
                      maxLength={80}
                      placeholder="Имя ведущего"
                      value={draft.hostName}
                      onChange={(e) => field("hostName", e.target.value)}
                    />
                  </label>
                  <label className="field">
                    Компания или проект
                    <input
                      maxLength={60}
                      placeholder="Название вашей компании — необязательно"
                      value={draft.brandName}
                      onChange={(e) => field("brandName", e.target.value)}
                    />
                  </label>
                </div>
                <div className="field-grid">
                  <label className="field">
                    Дата и время <small>В часовом поясе этого компьютера</small>
                    <input
                      type="datetime-local"
                      value={
                        draft.startsAt
                          ? new Date(
                              new Date(draft.startsAt).getTime() -
                                new Date(draft.startsAt).getTimezoneOffset() *
                                  60000,
                            )
                              .toISOString()
                              .slice(0, 16)
                          : ""
                      }
                      onChange={(e) =>
                        field(
                          "startsAt",
                          e.target.value
                            ? new Date(e.target.value).toISOString()
                            : "",
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    Часовой пояс для зрителей
                    <select
                      value={draft.timezone}
                      onChange={(e) => field("timezone", e.target.value)}
                    >
                      {[
                        "Europe/Moscow",
                        "Europe/Kyiv",
                        "Europe/Madrid",
                        "Asia/Makassar",
                        "America/New_York",
                        "UTC",
                      ].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <small className="muted">
                  В комнате: {dateLabel(draft.startsAt, draft.timezone)} ·{" "}
                  {draft.timezone}
                </small>
              </section>
              <details className="form-section compact-section">
                <summary>
                  <span className="step-label">02</span>
                  <span className="setup-summary-text">
                    Оформление и презентация
                    <small>Логотип, обложка, слайды</small>
                  </span>
                  <span className="setup-chevron" aria-hidden="true">
                    <ChevronDown size={18} />
                  </span>
                </summary>
                <div className="setup-body">
                  <div className="upload-grid">
                    {[
                      {
                        kind: "logo",
                        title: "Логотип",
                        hint: "PNG, JPG, WebP · до 12 МБ",
                        accept: "image/png,image/jpeg,image/webp",
                      },
                      {
                        kind: "cover",
                        title: "Обложка",
                        hint: "PNG, JPG, WebP · 16:9 · до 12 МБ",
                        accept: "image/png,image/jpeg,image/webp",
                      },
                      {
                        kind: "pdf",
                        title: "Презентация",
                        hint: "PDF, PowerPoint, ODP, фото · до 100 МБ",
                        accept:
                          ".pdf,.pptx,.ppt,.ppsx,.pps,.odp,.png,.jpg,.jpeg,.webp",
                      },
                    ].map((item) => (
                      <label className="upload-zone" key={item.kind}>
                        <input
                          type="file"
                          accept={item.accept}
                          disabled={!!uploading}
                          onChange={(e) => {
                            const file = e.currentTarget.files?.[0];
                            e.currentTarget.value = "";
                            void upload(file, item.kind);
                          }}
                        />
                        {w[(item.kind + "Id") as keyof Webinar] ? (
                          <Check size={23} />
                        ) : (
                          <Upload size={23} />
                        )}
                        <strong>
                          {uploading === item.kind
                            ? "Обрабатываем…"
                            : item.title}
                        </strong>
                        <small>
                          {uploading === item.kind
                            ? "Подождите — большой файл может обрабатываться до 3 минут"
                            : w[(item.kind + "Id") as keyof Webinar]
                              ? "Загружено · нажмите для замены"
                              : item.hint}
                        </small>
                      </label>
                    ))}
                  </div>
                  <p className="field-hint">
                    До 400 слайдов. PowerPoint и ODP преобразуются в слайды без
                    анимации и встроенного видео — проверьте оформление перед
                    эфиром. Крупные изображения в PowerPoint и ODP уменьшаются
                    автоматически. Изображение станет одним слайдом. Для Keynote
                    и Google Slides выберите экспорт в PPTX или PDF
                  </p>
                  <label className="field color-field">
                    Акцентный цвет
                    <div>
                      <input
                        type="color"
                        value={draft.accent}
                        onChange={(e) => field("accent", e.target.value)}
                      />
                      <span>{draft.accent.toUpperCase()}</span>
                    </div>
                  </label>
                  <label className="field">
                    Приветствие в чате
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={draft.welcome}
                      onChange={(e) => field("welcome", e.target.value)}
                    />
                  </label>
                </div>
              </details>
              <details className="form-section compact-section">
                <summary>
                  <span className="step-label">03</span>
                  <span className="setup-summary-text">
                    Предложение зрителям<small>Необязательно</small>
                  </span>
                  <span className="setup-chevron" aria-hidden="true">
                    <ChevronDown size={18} />
                  </span>
                </summary>
                <div className="setup-body">
                  <label className="field">
                    Текст кнопки
                    <input
                      maxLength={80}
                      placeholder="Например, записаться на курс"
                      value={draft.ctaTitle}
                      onChange={(e) => field("ctaTitle", e.target.value)}
                    />
                  </label>
                  <label className="field">
                    Короткое описание
                    <input
                      maxLength={240}
                      placeholder="Что вы предлагаете зрителям"
                      value={draft.ctaDescription}
                      onChange={(e) => field("ctaDescription", e.target.value)}
                    />
                  </label>
                  <label className="field">
                    Ссылка
                    <input
                      type="url"
                      placeholder="https://…"
                      value={draft.ctaUrl}
                      onChange={(e) => field("ctaUrl", e.target.value)}
                    />
                  </label>
                  <p className="field-hint">
                    Вы сами решаете, когда показать предложение — кнопкой в
                    студии
                  </p>
                </div>
              </details>
              <details className="form-section compact-section">
                <summary>
                  <span className="step-label">04</span>
                  <span className="setup-summary-text">
                    Тестовая активность<small>Необязательно</small>
                  </span>
                  <span className="setup-chevron" aria-hidden="true">
                    <ChevronDown size={18} />
                  </span>
                </summary>
                <div className="setup-body">
                  <AudienceSettings
                    value={draft.audienceTest}
                    onChange={(v) => field("audienceTest", v)}
                  />
                </div>
              </details>
              <div className="save-bar">
                <span aria-live="polite">
                  {saved
                    ? "Изменения сохранены"
                    : support
                      ? "Изменения будут видны ведущему"
                      : "«Проверить и запустить» также сохраняет изменения"}
                </span>
                <button className="btn primary" disabled={busy}>
                  <Save size={17} />
                  {busy ? "Сохраняем…" : "Сохранить изменения"}
                </button>
              </div>
            </fieldset>
          </form>
          <aside className="editor-preview">
            <div className="eyebrow">КОМНАТА ВАШИХ ЗРИТЕЛЕЙ</div>
            <div
              className="preview-card"
              style={{ "--accent": draft.accent } as React.CSSProperties}
            >
              <div className="preview-art">
                {w.coverId ? (
                  <img src={assetUrl(id, w.coverId)} alt="Обложка" />
                ) : (
                  <>
                    <div className="event-orbit" />
                    <div className="event-sphere" />
                  </>
                )}
              </div>
              <div className="preview-card-body">
                {w.logoId && (
                  <img
                    className="preview-logo"
                    src={assetUrl(id, w.logoId)}
                    alt={draft.brandName}
                  />
                )}
                <small>{draft.brandName || "Прямой эфир"}</small>
                <h2>{displayLabel(draft.title)}</h2>
                <p>{displayLabel(draft.description)}</p>
                <div>
                  <CalendarDays size={14} />
                  {dateLabel(draft.startsAt, draft.timezone)}
                </div>
              </div>
            </div>
            <CopyButton value={`${location.origin}/room/${w.slug}`} />
            <a
              className="text-link"
              href={`/room/${w.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Открыть комнату <ExternalLink size={14} />
            </a>
            <Notice>
              <strong>Перед запуском</strong>
              <br />
              Откройте студию, проверьте камеру, звук и слайды. Эфир начнётся
              только по вашей команде
            </Notice>
          </aside>
        </div>
      </main>
    </>
  );
}
