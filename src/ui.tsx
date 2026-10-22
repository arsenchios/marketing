import { useAudience } from "./useAudience";
import { platformBrand } from "../shared/brand";
import { AudienceSettings } from "./AudienceSettings";
import { scriptedGreetings, defaultAudienceTest } from "../shared/audience";
import { nameColor } from "./ChatDemo";
import { createPortal } from "react-dom";
import { type ReactNode, useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  ArrowUpRight,
  ArrowDown,
  Radio,
  ChevronLeft,
  Check,
  Copy,
  X,
  MessageCircle,
  Send,
  Trash2,
  Ban,
  Users,
  BookOpen,
  Settings2,
} from "lucide-react";
import type { Webinar, Message, RoomSnapshot } from "../shared/contracts";
import { send, guestMode } from "./api";
import { SettingsDialog } from "./Connections";
import { HelpDialog } from "./Guide";
export function displayLabel(value: string) {
  return value.replace(/(?<!\.)\.(\s*)$/u, "$1");
}

export function Brand({ name = platformBrand.name }: { name?: string }) {
  name = name || platformBrand.name;
  return (
    <a
      className={`brand ${name === platformBrand.name ? "arslive-brand" : "custom-brand"}`}
      href="/"
      aria-label={name}
    >
      {name === platformBrand.name ? (
        <img
          src={platformBrand.logo}
          alt={platformBrand.name}
          width={platformBrand.logoWidth}
          height={platformBrand.logoHeight}
        />
      ) : (
        <span className="brand-name">{name}</span>
      )}
    </a>
  );
}
export function Header({
  active = "events",
  studio = false,
}: {
  active?: string;
  studio?: boolean;
}) {
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(() =>
    new URLSearchParams(location.search).has("youtube"),
  );
  return (
    <>
      <header className="topbar">
        <Brand />
        <nav>
          <a className={active === "events" ? "active" : ""} href="/">
            Вебинары
          </a>
          <a
            className={active === "recordings" ? "active" : ""}
            href="/?tab=recordings"
          >
            Записи
          </a>
          <a
            className={active === "statistics" ? "active" : ""}
            href="/statistics"
          >
            Статистика
          </a>
        </nav>
        <div className="topbar-end">
          <button
            className="settings-button"
            aria-label="Настройки кабинета"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={19} />
            <span>Кабинет</span>
          </button>
          <button className="help-button" onClick={() => setHelp(true)}>
            <BookOpen size={17} />
            Инструкция
          </button>
        </div>
      </header>
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {help && (
        <HelpDialog
          initialStep={studio ? 2 : 0}
          onClose={() => setHelp(false)}
        />
      )}
    </>
  );
}
export function Badge({ state }: { state: string }) {
  const labels: Record<string, string> = {
    draft: "Черновик",
    starting: "Подключение",
    live: "В эфире",
    reconnecting: "Восстановление",
    stopping: "Сохраняем запись",
    ended: "Вебинар завершён",
    failed: "Нужна проверка",
  };
  return (
    <span className={`badge ${state}`}>
      <i />
      {labels[state] || state}
    </span>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <div className={`notice ${tone}`}>{children}</div>;
}
export function CopyButton({
  value,
  label = "Ссылка зрителя",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn quiet"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Скопируйте ссылку", value);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
      {copied ? "Скопировано" : label}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="modal app-modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          close.current();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function Chat({
  event,
  messages,
  online,
  audienceScenario,
  attendees = [],
  connected,
  viewer = false,
  readOnly = false,
  draftRequest,
  shortcuts,
  footer,
}: {
  event: Webinar;
  messages: Message[];
  online: number;
  audienceScenario?: RoomSnapshot["audienceScenario"];
  attendees?: { attendeeId: string; name: string }[];
  connected: boolean;
  viewer?: boolean;
  readOnly?: boolean;
  draftRequest?: { id: string; text: string };
  shortcuts?: ReactNode;
  footer?: ReactNode;
}) {
  const archived = readOnly || ["stopping", "ended"].includes(event.state);
  const { seconds: scenarioSeconds, count: displayedOnline } = useAudience(
    online,
    archived ? undefined : audienceScenario,
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testSettings, setTestSettings] = useState(
    event.audienceTest || defaultAudienceTest,
  );
  const [testError, setTestError] = useState("");
  const simulatedMessages =
    audienceScenario?.settings.greetingsEnabled && !archived
      ? scriptedGreetings(event.id, audienceScenario.startedAt, scenarioSeconds)
      : [];
  const visibleMessages = [...messages, ...simulatedMessages].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );

  const [banTarget, setBanTarget] = useState<Pick<
    Message,
    "name" | "attendeeId"
  > | null>(null);
  const [audience, setAudience] = useState(false);
  const [rules, setRules] = useState(false);
  const [demo, setDemo] = useState(false);
  const [words, setWords] = useState((event.chatBlockedWords || []).join(", "));
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ id: string; text: string } | null>(
    null,
  );
  const compose = useRef<HTMLTextAreaElement>(null);
  const inserted = useRef("");
  useEffect(() => {
    if (!draftRequest || inserted.current === draftRequest.id || archived)
      return;
    inserted.current = draftRequest.id;
    setText((current) =>
      current.trim() ? `${current}\n${draftRequest.text}` : draftRequest.text,
    );
    setError("");
    compose.current?.focus();
    compose.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [draftRequest, archived]);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(!viewer);
  const history = useRef<{ event: string; ids: Set<string> } | null>(null);
  const unreadIds = useRef(new Set<string>());
  const [unread, setUnread] = useState(0);
  const latest = () => {
    follow.current = true;
    unreadIds.current.clear();
    setUnread(0);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  useLayoutEffect(() => {
    // Follow before the browser dispatches scroll events for the new message height.
    const ids = new Set(visibleMessages.filter((m) => !m.deleted).map((m) => m.id));
    if (history.current?.event !== event.id) {
      history.current = { event: event.id, ids };
      unreadIds.current.clear();
      setUnread(0);
      follow.current = !viewer;
      if (scroll.current)
        scroll.current.scrollTop = viewer || archived ? 0 : scroll.current.scrollHeight;
      return;
    }
    for (const id of unreadIds.current)
      if (!ids.has(id)) unreadIds.current.delete(id);
    if (follow.current && !archived) {
      unreadIds.current.clear();
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    } else if (viewer && !archived) {
      for (const id of ids)
        if (!history.current.ids.has(id)) unreadIds.current.add(id);
    }
    history.current.ids = ids;
    setUnread(unreadIds.current.size);
  }, [messages, simulatedMessages.length, archived, event.id, viewer]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy || cooldown) return;
    if (text.length > 1000) {
      setError("Сократите сообщение до 1000 символов");
      return;
    }
    setBusy(true);
    setError("");
    const msg =
      pending?.text === text ? pending : { id: crypto.randomUUID(), text };
    setPending(msg);
    try {
      await send(
        viewer
          ? `/api/room/${event.slug}/chat`
          : `/api/events/${event.id}/chat`,
        msg,
      );
      setText((current) => (current === msg.text ? "" : current));
      setPending(null);
      if (viewer) setCooldown(5);
      follow.current = true;
    } catch (e) {
      if (viewer && (e as Error & { status?: number }).status === 429)
        setCooldown(5);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moderate(path: string, body: any = {}, method = "POST") {
    try {
      await send(path, body, method);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <aside className="chat-panel">
      <div className="chat-conversation">
      <div className="chat-heading">
        <div>
          <MessageCircle size={17} />
          <h2>{archived ? "История чата" : "Чат эфира"}</h2>
        </div>
        {!viewer && !readOnly ? (
          <button
            className="online audience-button"
            onClick={() => setAudience(true)}
            aria-label={`Зрители: ${displayedOnline}. Открыть список`}
          >
            <Users size={14} />
            <span>
              <small>Зрителей:</small> {displayedOnline}
            </span>
          </button>
        ) : (
          <span className="online">
            <Users size={14} />
            <span>
              <small>Зрителей:</small> {displayedOnline}
            </span>
          </span>
        )}
      </div>
      <div className="chat-message-area">
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 70;
          if (follow.current) {
            unreadIds.current.clear();
            setUnread(0);
          }
        }}
      >
        <div className="welcome-message">
          <span className="tiny-label">
            {event.brandName
              ? `${event.brandName} · ОРГАНИЗАТОР`
              : "ОРГАНИЗАТОР"}
          </span>
          <p>{displayLabel(event.welcome || "Добро пожаловать на эфир")}</p>
        </div>
        {visibleMessages.length === 0 ? (
          <div className="chat-empty">
            <MessageCircle size={28} />
            <p>Пока нет сообщений</p>
            {!archived && <small>Задайте вопрос ведущему</small>}
          </div>
        ) : (
          visibleMessages.map((m) => (
            <div
              className={`message ${m.deleted ? "deleted" : ""} ${m.held ? "held" : ""}`}
              key={m.id}
            >
              <div className="message-top">
                <strong style={{ color: nameColor(m) }}>{m.name}</strong>
                {m.role !== "viewer" && (
                  <span className="host-label">{m.role === "speaker" ? "спикер" : m.role === "moderator" ? "модератор" : "ведущий"}</span>
                )}
                <time>
                  {new Date(m.at).toLocaleTimeString("ru", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {m.held && !m.deleted ? (
                <div className="held-message">
                  <span>
                    Заблокировано
                    {!viewer && m.moderationReason
                      ? ` · ${m.moderationReason}`
                      : ""}
                  </span>
                  {!viewer && (
                    <details>
                      <summary>Посмотреть сообщение</summary>
                      <p>{m.text}</p>
                    </details>
                  )}
                </div>
              ) : (
                <p>
                  {m.text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
                    /^https?:\/\//.test(part) ? (
                      <a
                        key={i}
                        href={part}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {part}
                      </a>
                    ) : (
                      part
                    ),
                  )}
                </p>
              )}
              {!readOnly &&
                !viewer &&
                !m.deleted &&
                !m.id.startsWith("scenario-") && (
                  <div className="moderate">
                    {m.held && (
                      <button
                        aria-label="Показать всем"
                        onClick={() =>
                          moderate(
                            `/api/events/${event.id}/chat/${m.id}/approve`,
                          )
                        }
                      >
                        <Check size={14} /> Показать всем
                      </button>
                    )}
                    <button
                      title="Удалить сообщение"
                      aria-label="Удалить сообщение"
                      onClick={() =>
                        moderate(
                          `/api/events/${event.id}/chat/${m.id}`,
                          {},
                          "DELETE",
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                    {m.attendeeId && (
                      <button
                        disabled={m.blocked}
                        title="Закрыть участнику доступ к вебинару"
                        aria-label={
                          m.blocked
                            ? "Участник заблокирован"
                            : "Заблокировать участника"
                        }
                        onClick={() => setBanTarget(m)}
                      >
                        <Ban size={14} /> {m.blocked ? "Заблокирован" : "Бан"}
                      </button>
                    )}
                  </div>
                )}
            </div>
          ))
        )}
      </div>
      {viewer && unread > 0 && !archived && (
        <button className="chat-new-messages" onClick={latest} aria-live="polite">
          {unread} {unread % 10 === 1 && unread % 100 !== 11
            ? "новое сообщение"
            : unread % 10 >= 2 && unread % 10 <= 4 && (unread % 100 < 12 || unread % 100 > 14)
              ? "новых сообщения"
              : "новых сообщений"} <ArrowDown size={15} />
        </button>
      )}
      </div>
      {!archived && (
        <form className="chat-compose" onSubmit={submit}>
          {error && (
            <small className="error-text" role="alert">
              {error}
            </small>
          )}
          <div className="chat-reactions" aria-label="Быстрые смайлики">
            {[
              ["❤️", "Сердце"],
              ["👍", "Поддержать"],
              ["✅", "Всё понятно"],
              ["👏", "Аплодисменты"],
              ["😂", "Смех"],
              ["🔥", "Огонь"],
            ].map(([emoji, label]) => (
              <button
                key={emoji}
                type="button"
                aria-label={label}
                onClick={() => {
                  setText((t) => (t + emoji).slice(0, 1000));
                  compose.current?.focus();
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="chat-message">
            Сообщение в чат
          </label>
          <textarea
            ref={compose}
            id="chat-message"
            placeholder="Напишите сообщение…"
            title={
              viewer ? "Можно отправлять сообщение раз в 5 секунд" : undefined
            }
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {text.length > 900 && (
            <small className={text.length > 1000 ? "error-text" : "muted"}>
              {text.length} / 1000
            </small>
          )}
          <div className="chat-send-row">
            <span role="status">
              <i className={connected ? "connection-on" : "connection-off"} />
              {connected ? "Чат работает" : "Подключаем чат"}
            </span>
            <button
              aria-label="Отправить сообщение"
              disabled={
                busy || cooldown > 0 || !text.trim() || text.length > 1000
              }
            >
              {cooldown ? (
                <span className="cooldown-number">{cooldown}</span>
              ) : (
                <Send size={16} />
              )}
              {!cooldown && <span>{busy ? "Отправляем…" : "Отправить"}</span>}
            </button>
          </div>
        </form>
      )}
      </div>
      {(shortcuts || footer || (!viewer && !readOnly)) && <div className="chat-host-tools">
      {!archived && shortcuts}
      {!viewer && !readOnly && (
        <div className="chat-settings-row">
          <button className="btn quiet small" onClick={() => setRules(true)}>
            <Settings2 size={14} /> Защита чата
          </button>
          {!guestMode() && <button
            className="btn quiet small"
            onClick={() => {
              setTestSettings(event.audienceTest || defaultAudienceTest);
              setTestError("");
              setDemo(true);
            }}
          >
            Тестовая активность
          </button>}
        </div>
      )}
      {!archived && footer}
      </div>}
      {audience && (
        <Modal title="Зрители в комнате" onClose={() => setAudience(false)}>
          <p>Сейчас подключено: {online}</p>
          {attendees.length === 0 ? (
            <p>Пока никто не подключился</p>
          ) : (
            <div className="audience-list">
              {attendees.map((a) => (
                <div key={a.attendeeId}>
                  <strong>{a.name}</strong>
                  <button
                    className="btn quiet small"
                    onClick={() => {
                      setAudience(false);
                      setBanTarget(a);
                    }}
                  >
                    <Ban size={14} /> Заблокировать
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {banTarget && (
        <Modal
          title="Закрыть доступ участнику?"
          onClose={() => setBanTarget(null)}
        >
          <p>
            <strong>{banTarget.name}</strong> больше не сможет смотреть этот
            вебинар и писать в чат из текущего браузера
          </p>
          <div className="modal-actions">
            <button className="btn quiet" onClick={() => setBanTarget(null)}>
              Отмена
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await moderate(`/api/events/${event.id}/block`, {
                  attendeeId: banTarget.attendeeId,
                });
                setBanTarget(null);
              }}
            >
              Заблокировать
            </button>
          </div>
        </Modal>
      )}
      {rules && (
        <Modal title="Защита чата" onClose={() => setRules(false)}>
          <p>
            Мат, подозрительные ссылки и повторные сообщения скрываются до вашей
            проверки. Зрители могут отправлять сообщение раз в 5 секунд
          </p>
          <label>
            Дополнительные слова через запятую
            <textarea
              value={words}
              maxLength={4000}
              onChange={(e) => setWords(e.target.value)}
              placeholder="Слова и фразы, которые нужно скрывать"
            />
          </label>
          <p className="muted">
            Фильтр может ошибаться — скрытое сообщение можно показать всем
            вручную
          </p>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await send(
                  `/api/events/${event.id}/chat-rules`,
                  {
                    words: words
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                  "PATCH",
                );
                setRules(false);
              } catch (e) {
                setError((e as Error).message);
                setRules(false);
              }
            }}
          >
            Сохранить
          </button>
        </Modal>
      )}
      {demo && (
        <Modal title="Тестовая активность" onClose={() => setDemo(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setTestBusy(true);
              setTestError("");
              try {
                await send(
                  `/api/events/${event.id}/audience-test`,
                  testSettings,
                  "PATCH",
                );
                setDemo(false);
              } catch (e) {
                setTestError((e as Error).message);
              } finally {
                setTestBusy(false);
              }
            }}
          >
            <fieldset disabled={testBusy}>
              <AudienceSettings
                value={testSettings}
                onChange={setTestSettings}
              />
            </fieldset>
            {testError && <p role="alert">{testError}</p>}
            <button className="btn primary" disabled={testBusy}>
              {testBusy ? "Сохраняем…" : "Сохранить настройки"}
            </button>
          </form>
        </Modal>
      )}
    </aside>
  );
}
