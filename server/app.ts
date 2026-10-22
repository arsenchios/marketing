import { platformBrand } from "../shared/brand.ts";
import { Invitations } from "./invitations.ts";
import { SpeakerRooms } from "./speakers.ts";
import { SocketHeartbeat } from "./socketHeartbeat.ts";
import { SpeakerIce, SpeakerIceError } from "./speakerIce.ts";
import { ViewerTail } from "./viewerTail.ts";
import { buildStatistics, deviceClass, sourceHost } from "./statistics.ts";
import { audienceTestSchema } from "../shared/contracts.ts";
import { audienceScenario } from "../shared/audience.ts";
import { publicMessage, viewerMessage } from "../shared/chat.ts";
import { MAX_SLIDES } from "../shared/presentation.ts";
import {
  prepareAsset,
  AssetError,
  PRESENTATION_LIMIT,
} from "./presentations.ts";
import { SegmentArchive, liveWindow } from "./segments.ts";
import { YouTubeDelivery, youtubeErrorMessage } from "./youtube.ts";
import { GoogleAuth, type GoogleConfig } from "./auth.ts";
import type { Database } from "./database.ts";
import { recordingExpired } from "../shared/retention.ts";
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import multer from "multer";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { unlinkSync } from "node:fs";
import { Store, canRead, canHost, type Session } from "./store.ts";
import { MediaManager } from "./media.ts";
import {
  archiveKey,
  RecordingArchive,
  type ArchiveTransport,
} from "./archive.ts";
import { checkRecording } from "./preflight.ts";
import {
  eventInput,
  chatTemplatesSchema,
  cameraBoxSchema,
  initialEvent,
  type Webinar,
  type RoomSnapshot,
} from "../shared/contracts.ts";

const idSchema = z.string().uuid();
function cookie(req: { headers: Request["headers"] }, name: string) {
  return (
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public recoveryUrl?: string,
  ) {
    super(message);
  }
}
export async function createApp(
  dir: string,
  origin: string,
  options: {
    publicMode?: boolean;
    localClientPreview?: boolean;
    databaseUrl?: string;
    database?: Database;
    google?: GoogleConfig;
    archiveTransport?: ArchiveTransport | null;
    speakerIce?: SpeakerIce;
  } = {},
) {
  if (options.publicMode && options.localClientPreview)
    throw new Error("Client preview is local only");
  const store = await Store.open(dir, options.databaseUrl, options.database);
  await store.seed(!options.publicMode && !options.localClientPreview);
  if (options.localClientPreview) {
    await store.db
      .prepare("INSERT OR IGNORE INTO companies VALUES (?,?)")
      .run("local-client", "Клиентский кабинет");
    await store.db
      .prepare("INSERT OR IGNORE INTO memberships VALUES (?,?,?,?)")
      .run("local-client-owner", "local-client", "Ведущий", "owner");
    if (!(await store.list("local-client")).length)
      await store.create("local-client", {
        ...initialEvent,
        title: "Мой первый вебинар",
      });
  }
  const auth = new GoogleAuth(store, origin, options.google);
  await auth.initialize();
  const app = express();
  if (options.publicMode) app.set("trust proxy", 1);
  const server = createServer(app);
  const subscriptions = new Map<
    WebSocket,
    { event: string; session: string; viewer: boolean; attendee?: string }
  >();
  const online = (id: string) =>
    new Set(
      [...subscriptions.values()]
        .filter((s) => s.event === id && s.viewer)
        .map((s) => s.attendee || s.session),
    ).size;
  const viewerTail = new ViewerTail();
  let closing = false;
  let media: MediaManager;
  let delivery: YouTubeDelivery;
  async function snapshot(w: Webinar): Promise<RoomSnapshot> {
    const status = await media.status(w.id);
    status.provider = delivery.provider(w);
    status.youtube = { ...delivery.status(w.id, status.runId) };
    const savedBroadcast = status.runId
      ? await store.db
          .prepare(
            "SELECT data FROM youtube_broadcast_details WHERE event_id=? AND run_id=?",
          )
          .get(w.id, status.runId)
      : null;
    const broadcastInfo = savedBroadcast
      ? JSON.parse(savedBroadcast.data)
      : null;
    status.youtube.channel =
      broadcastInfo?.channel ||
      (await auth.broadcastChannel(w.companyId)).channel ||
      null;
    if (broadcastInfo?.videoId && !status.youtube.videoId)
      status.youtube.videoId = broadcastInfo.videoId;
    const banned = new Set(
      (
        await store.db
          .prepare("SELECT attendee_id FROM viewer_bans WHERE event_id=?")
          .all(w.id)
      ).map((r: any) => r.attendee_id),
    );
    const connectedSessions = new Set(
      [...subscriptions.values()]
        .filter((s) => s.event === w.id && s.viewer)
        .map((s) => s.session),
    );
    const attendees = new Map<string, { attendeeId: string; name: string }>();
    for (const row of await store.db
      .prepare(
        "SELECT id,attendee_id,name FROM sessions WHERE event_id=? AND blocked=0 AND expires>?",
      )
      .all(w.id, Date.now())) {
      if (connectedSessions.has(row.id) && row.attendee_id)
        attendees.set(row.attendee_id, {
          attendeeId: row.attendee_id,
          name: publicMessage({ name: row.name, role: "viewer" }, w).name,
        });
    }
    const recordings = await store.recordings(w.id);
    const currentEvent = (await store.event(w.id))!;
    const guestSeat = speakers.guest(w.id);
    const guest = guestSeat ? await store.session(guestSeat.session) : null;
    const speakerName = guest &&
      (canHost(guest, w) || (guest.guestRole === "speaker" && canRead(guest, w))) &&
      !["stopping", "ended"].includes(currentEvent.state)
        ? publicMessage({ name: guest.name, role: "speaker" }, w).name
        : undefined;
    return {
      speakerName,
      audienceScenario: audienceScenario(currentEvent, recordings),
      attendees: [...attendees.values()],
      event: currentEvent,
      messages: (await store.messages(w.id)).map((m) => ({
        ...publicMessage(m, w),
        blocked: !!m.attendeeId && banned.has(m.attendeeId),
      })),
      recordings,
      media: status,
      online: online(w.id),
    };
  }
  function viewerSnapshot(data: RoomSnapshot, session = ""): RoomSnapshot {
    const tail = viewerTail.get(data.event.id, session);
    if (tail && ["stopping", "ended"].includes(data.event.state))
      data = {
        ...data,
        media: { ...tail.media, receiving: false, finishUntil: tail.until },
        recordings: tail.recordings,
      };
    const { chatTemplates, chatBlockedWords, audienceTest, ...event } =
      data.event;
    const { attendees, ...safe } = data;
    const closed =
      (["stopping", "ended"].includes(event.state) && !tail) ||
      !data.media.runId;
    return {
      ...safe,
      event,
      messages: data.messages.map(viewerMessage),
      recordings: data.recordings
        .filter((r) => !closed && r.id === data.media.runId)
        .map((r) => ({
          ...r,
          hasFile: false,
          storageKey: undefined,
          archive: undefined,
        })),
      media: closed
        ? { ...data.media, runId: null, playlist: null, youtube: undefined }
        : data.media,
    };
  }
  async function publish(id: string) {
    if (closing) return;
    const w = await store.event(id);
    if (!w || w.deletedAt) return;
    const data = await snapshot(w);
    viewerTail.update(
      data,
      [...subscriptions.values()]
        .filter((s) => s.event === id && s.viewer)
        .map((s) => s.session),
    );
    const payload = JSON.stringify({ type: "snapshot", ...data });
    const viewerPayload = JSON.stringify({
      type: "snapshot",
      ...viewerSnapshot(data),
    });
    let finishingPayload: string | undefined;
    for (const [ws, s] of subscriptions)
      if (s.event === id && ws.readyState === 1) {
        const member = await store.session(s.session);
        if (!(s.viewer ? canRead(member, w) : canReadRoom(member, w))) {
          ws.close(4003, "Session ended");
          continue;
        }
        if (ws.bufferedAmount > 1024 * 1024) {
          ws.close(4000, "Slow consumer");
          continue;
        }
        ws.send(
          !s.viewer
            ? member?.guestRole ? JSON.stringify({type:"snapshot",...data,recordings:[]}) : payload
            : viewerTail.get(id, s.session)
              ? (finishingPayload ??= JSON.stringify({
                  type: "snapshot",
                  ...viewerSnapshot(data, s.session),
                }))
              : viewerPayload,
        );
      }
  }
  const notify = (id: string) => {
    void publish(id).catch(() => console.error("Snapshot delivery failed"));
  };
  media = new MediaManager(store, notify);
  delivery = new YouTubeDelivery(
    media,
    auth,
    notify,
    options.localClientPreview ? false : undefined,
  );
  media.canPreserveBroadcast = () =>
    !!delivery.relay && delivery.state.phase === "live";
  const archive = new RecordingArchive(
    store,
    notify,
    options.archiveTransport,
    (r) =>
      !viewerTail.holds(r.id) &&
      !(delivery.relay && delivery.active?.run === r.id),
  );
  const segments = new SegmentArchive(store, archive.transport, media.ffmpeg);
  await segments.initialize();
  media.segments = segments;
  archive.removeParts = (r) => segments.remove(r);
  await archive.initialize();
  media.onRecording = (r) => {
    void archive
      .enqueue(r)
      .then(() => archive.cleanLocal(r))
      .catch(() => {});
  };
  await media.initialize();
  const archiveRetry = setInterval(
    () => void media.retryArchives().catch(() => {}),
    60_000,
  );
  archiveRetry.unref();
  let checking = false;
  const buckets = new Map<string, { count: number; until: number }>();
  function limit(key: string, max: number, ms = 60000) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.until < now) {
      b = { count: 0, until: now + ms };
      buckets.set(key, b);
    }
    if (++b.count > max)
      throw new HttpError(429, "Слишком много запросов. Попробуйте позже.");
  }
  const roomHeartbeat = new SocketHeartbeat();
  const housekeeping = setInterval(async () => {
    if (closing) return;
    try {
      roomHeartbeat.tick(subscriptions.keys());
      const now = Date.now();
      for (const [k, b] of buckets) if (b.until < now) buckets.delete(k);
      await store.db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
      await store.db
        .prepare("DELETE FROM viewer_devices WHERE expires<?")
        .run(now);
      await store.db
        .prepare("DELETE FROM diagnostics WHERE at<?")
        .run(new Date(now - 7 * 86400000).toISOString());
      for (const [ws, s] of subscriptions)
        if (!(await store.session(s.session)))
          ws.close(4003, "Session expired");
    } catch {
      if (!closing) console.error("Housekeeping unavailable");
    }
  }, 30000);
  housekeeping.unref();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (
      req.path !== "/api/health" &&
      req.headers.host !== new URL(origin).host
    ) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self)",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://yt3.ggpht.com https://yt3.googleusercontent.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; connect-src 'self' ws: wss:; frame-src https://www.youtube-nocookie.com https://www.youtube.com; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    ) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  async function host(req: Request) {
    const eventId = String(req.params.id || "");
    const guest = eventId ? await store.session(cookie(req, `al_guest_${eventId}`)) : undefined;
    if (req.get("X-Webinar-Guest") === "1" || req.query.guest === "1") return guest;
    const member = await store.session(cookie(req, "al_host"));
    if (member && guest) { const w=await store.event(eventId); return w && canReadRoom(member,w) ? member : guest; }
    return member || guest;
  }
  async function viewer(req: Request, w: Webinar) {
    return await store.session(cookie(req, `al_view_${w.slug}`));
  }
  async function event(req: Request) {
    const w = await store.event(String(req.params.id ?? req.params.slug));
    if (!w || w.deletedAt)
      throw new HttpError(404, "Вебинар не найден или удалён");
    return w;
  }
  const assistance = new Map<string, number>();
  function canAssist(s: Session | undefined, w: Webinar) {
    return (
      !w.deletedAt &&
      ((s?.role === "moderator" && s.companyId === w.companyId && (!s.eventId || s.eventId === w.id)) ||
        (s?.role === "owner" &&
          s.companyId === "arslive" &&
          (assistance.get(`${s.id}:${w.id}`) || 0) > Date.now()))
    );
  }
  function canReadRoom(s: Session | undefined, w: Webinar) {
    return canRead(s, w) || canAssist(s, w);
  }
  async function guard(
    req: Request,
    w: Webinar,
    write = false,
    assist = false,
  ) {
    const s = await host(req);
    if (s?.guestRole) {
      const suffix = req.path.slice(`/api/events/${w.id}`.length);
      const allowed = req.method === "GET" ? /^(|\/permissions|\/readiness|\/chat|\/decks)$/.test(suffix) :
        /^(\/stage|\/annotations|\/offer|\/chat-templates|\/chat-rules|\/chat(?:\/[a-f0-9-]+(?:\/approve)?)?|\/block|\/assets|\/decks\/[a-f0-9-]+\/show|\/connection-check)$/.test(suffix);
      if (!allowed) throw new HttpError(403, "Это действие доступно главному ведущему");
      if (write && s.guestControl === false && !["/chat","/connection-check"].includes(suffix)) throw new HttpError(403,"Ведущий временно отключил управление. Вы можете говорить и писать в чат");
    }
    if (
      !(write
        ? canHost(s, w) || (assist && canAssist(s, w))
        : canReadRoom(s, w))
    )
      throw new HttpError(s ? 403 : 401, "Нет доступа");
    return s!;
  }
  // Serialize start and deletion so a stale request cannot start a removed room.
  const eventActions = new Map<string, Promise<unknown>>();
  async function eventAction<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = eventActions.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    eventActions.set(id, task);
    try {
      return await task;
    } finally {
      if (eventActions.get(id) === task) eventActions.delete(id);
    }
  }
  async function roomGuard(req: Request, w: Webinar) {
    await checkViewerBan(req, w);
    const s = await viewer(req, w);
    if (!canRead(s, w))
      throw new HttpError(401, "Представьтесь, чтобы войти в комнату");
    return s!;
  }
  async function checkViewerBan(req: Request, w: Webinar) {
    const sid = cookie(req, `al_view_${w.slug}`);
    const previous = await store.db
      .prepare(
        "SELECT attendee_id,blocked FROM sessions WHERE id=? AND event_id=?",
      )
      .get(sid, w.id);
    // The browser cookie is an opaque device secret, never the public attendee ID.
    const device = await store.db
      .prepare(
        "SELECT attendee_id FROM viewer_devices WHERE id=? AND expires>?",
      )
      .get(cookie(req, "al_identity"), Date.now());
    const identity = previous?.attendee_id || device?.attendee_id;
    if (
      previous?.blocked ||
      (identity &&
        (await store.db
          .prepare(
            "SELECT attendee_id FROM viewer_bans WHERE event_id=? AND attendee_id=?",
          )
          .get(w.id, identity)))
    )
      throw new HttpError(
        403,
        "Организатор закрыл вам доступ к этому вебинару",
      );
    return identity as string | undefined;
  }
  const setCookie = (
    res: Response,
    name: string,
    value: string,
    maxAge = 12 * 3600 * 1000,
  ) =>
    res.cookie(name, value, {
      httpOnly: true,
      sameSite: options.publicMode ? "lax" : "strict",
      path: "/",
      maxAge,
      secure: origin.startsWith("https:"),
    });

  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      mode: options.publicMode ? "public_pilot" : "local_only",
      database: store.db.kind,
      ffmpeg: media.readiness().ffmpeg,
    }),
  );

  app.get("/api/auth/config", (_req, res) =>
    res.json({
      mode: options.publicMode ? "public" : "local",
      google: auth.configured,
      ready: true,
    }),
  );
  const owner = async (req: Request) => {
    const s = await host(req);
    if (s?.role !== "owner")
      throw new HttpError(403, "Доступно владельцу кабинета");
    return s;
  };
  app.get("/api/auth/google/start", async (req, res) => {
    limit("google-login:" + req.ip, 10);
    if (!auth.configured)
      throw new HttpError(503, "Вход через Google ещё настраивается");
    const flow = await auth.begin("login");
    res.cookie("al_oauth_login", flow.browser, {
      httpOnly: true,
      secure: options.publicMode,
      sameSite: "lax",
      maxAge: 600_000,
      path: "/api/auth/google",
    });
    res.redirect(flow.url);
  });
  app.get("/api/auth/google/callback", async (req, res) => {
    try {
      const row = await auth.consume(
        String(req.query.state || ""),
        cookie(req, "al_oauth_login"),
        "login",
      );
      if (req.query.error) throw Error("Denied");
      const user = await auth.login(String(req.query.code || ""), row);
      const old = await host(req);
      if (old)
        await store.db.prepare("DELETE FROM sessions WHERE id=?").run(old.id);
      setCookie(
        res,
        "al_host",
        await store.newSession(user.member, null, user.name),
      );
      res.clearCookie("al_oauth_login", { path: "/api/auth/google" });
      res.redirect("/");
    } catch {
      res.clearCookie("al_oauth_login", { path: "/api/auth/google" });
      res.redirect("/?auth_error=1");
    }
  });
  app.post("/api/auth/logout", async (req, res) => {
    const s = await host(req);
    if (!s) throw new HttpError(401, "Войдите в кабинет");
    if (media.current?.record.companyId === s.companyId)
      throw new HttpError(409, "Завершите эфир перед выходом из кабинета");
    await store.db.prepare("DELETE FROM sessions WHERE id=?").run(s.id);
    res.clearCookie("al_host", { path: "/" });
    res.json({ ok: true });
  });
  app.post("/api/integrations/youtube/check", async (req, res) => {
    const s = await owner(req);
    limit("youtube-check:" + s.companyId, 5);
    const source = await auth.broadcastCompany(s.companyId);
    if (!(await auth.channel(source)))
      throw new HttpError(409, "YouTube-канал ещё не подключён");
    try {
      await delivery.api.request(
        source,
        "liveStreams?part=id&mine=true&maxResults=1",
      );
      // Refresh branding only on this explicit check, not on every room heartbeat.
      try {
        const info = await delivery.api.request(
          source,
          "channels?part=snippet&mine=true",
        );
        const channel = info.items?.[0];
        if (channel) {
          await auth.cacheChannelProfile(
            source,
            channel.snippet?.thumbnails?.default?.url,
          );
          await store.db
            .prepare(
              "UPDATE youtube_channels SET title=? WHERE company_id=? AND channel_id=?",
            )
            .run(channel.snippet.title, source, channel.id);
        }
      } catch {
        /* Branding is optional; do not fail a successful access check. */
      }
      res.json({
        message:
          "YouTube отвечает, доступ к каналу есть. Теперь проведите короткий пробный эфир: проверьте запуск, видео и звук в комнате зрителя",
      });
    } catch (error) {
      throw new HttpError(409, youtubeErrorMessage(error));
    }
  });
  app.get("/api/integrations/youtube", async (req, res) => {
    const s = await host(req);
    if (!s?.role) throw new HttpError(401, "Войдите в кабинет");
    res.json({
      configured: auth.youtubeConfigured,
      deliveryEnabled: delivery.enabled,
      ...(await auth.broadcastChannel(s.companyId)),
      ownChannel: !!(await auth.channel(s.companyId)),
      canManage: s.role === "owner",
      canInvite: s.role === "owner" && s.companyId === "arslive",
    });
  });
  app.post("/api/integrations/youtube/connect", async (req, res) => {
    const s = await owner(req);
    limit("youtube-connect:" + s.id, 5);
    if (media.current || delivery.active)
      throw new HttpError(409, "Подключение можно изменить после эфира");
    if (!auth.youtubeConfigured)
      throw new HttpError(503, "Подключение YouTube ещё настраивается");
    const flow = await auth.begin("youtube", s);
    res.cookie("al_oauth_youtube", flow.browser, {
      httpOnly: true,
      secure: options.publicMode,
      sameSite: "lax",
      maxAge: 600_000,
      path: "/api/integrations/youtube",
    });
    res.json({ url: flow.url });
  });
  app.get("/api/integrations/youtube/callback", async (req, res) => {
    try {
      const s = await owner(req);
      if (media.current || delivery.active) throw Error("Broadcast active");
      const row = await auth.consume(
        String(req.query.state || ""),
        cookie(req, "al_oauth_youtube"),
        "youtube",
        s,
      );
      if (req.query.error) throw Error("Denied");
      await auth.connectYouTube(String(req.query.code || ""), row, s);
      res.clearCookie("al_oauth_youtube", {
        path: "/api/integrations/youtube",
      });
      res.redirect("/?youtube=connected");
    } catch {
      res.clearCookie("al_oauth_youtube", {
        path: "/api/integrations/youtube",
      });
      res.redirect("/?youtube=error");
    }
  });
  app.delete("/api/integrations/youtube", async (req, res) => {
    const s = await owner(req);
    if (media.current || delivery.active)
      throw new HttpError(409, "Сначала завершите эфир");
    await auth.disconnect(s.companyId);
    res.json({ ok: true });
  });
  app.get("/api/clients", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    const clients = await store.db
      .prepare(
        "SELECT c.id,c.name,a.source_company FROM companies c LEFT JOIN youtube_access a ON a.company_id=c.id WHERE c.id<>? ORDER BY c.name",
      )
      .all("arslive");
    res.json({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        platformChannel: c.source_company === "arslive",
      })),
    });
  });
  app.get("/api/admin/webinars", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    const companies = await store.db
      .prepare("SELECT id,name FROM companies ORDER BY name")
      .all();
    const webinars = (
      await Promise.all(
        companies.map(async (c) =>
          (await store.list(String(c.id))).map((w) => ({
            id: w.id,
            title: w.title,
            slug: w.slug,
            state: w.state,
            startsAt: w.startsAt,
            timezone: w.timezone,
            companyName: String(c.name),
            hostName: w.hostName,
          })),
        ),
      )
    ).flat();
    res.json({ webinars });
  });
  app.post("/api/admin/webinars/:id/assist", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    const w = await event(req);
    for (const [key, until] of assistance)
      if (until <= Date.now()) assistance.delete(key);
    assistance.set(`${s.id}:${w.id}`, Date.now() + 6 * 3600_000);
    await store.diagnostic(w.id, "support_controls_joined");
    res.json({ url: `/assist/${w.id}` });
  });
  app.post("/api/admin/webinars/:id/observe", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    const w = await event(req);
    const sid = await store.newSession(null, w, `Поддержка ${platformBrand.name}`);
    setCookie(res, `al_view_${w.slug}`, sid);
    await store.diagnostic(w.id, "support_observer_joined");
    res.json({ url: `/room/${w.slug}?observer=1` });
  });
  app.patch("/api/clients/:company/channel", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    if (media.current || delivery.active)
      throw new HttpError(409, "Измените доступ после завершения эфира");
    const { allowed } = z.object({ allowed: z.boolean() }).parse(req.body);
    const company = String(req.params.company);
    if (
      company === "arslive" ||
      !(await store.db
        .prepare("SELECT id FROM companies WHERE id=?")
        .get(company))
    )
      throw new HttpError(404, "Кабинет не найден");
    await auth.grantPlatformChannel(company, allowed);
    res.json({ ok: true });
  });
  const speakers = new SpeakerRooms(async (seat) => {
    const session = await store.session(seat.session);
    const webinar = await store.event(seat.event);
    if (
      !webinar ||
      !(canHost(session, webinar) || (session?.guestRole === "speaker" && canRead(session, webinar))) ||
      ["ended", "stopping"].includes(webinar.state)
    )
      return false;
    if (seat.role === "primary" && session?.guestRole) return false;
    const run = media.current;
    return (
      seat.role !== "primary" ||
      !run ||
      (run.record.eventId === seat.event &&
        run.owner === seat.session &&
        run.tabId === seat.tab)
    );
  }, (event, kind, values) => media.diagnostic(event, kind, values));
  const invitations = new Invitations(store);
  async function manageInvitation(req: Request) {
    const w=await event(req), s=await host(req);
    if (!s || s.guestRole || !(canHost(s,w) || canAssist(s,w))) throw new HttpError(403,"Приглашения доступны организатору");
    return w;
  }
  app.get("/api/events/:id/invitations",async(req,res)=>{
    const w=await manageInvitation(req);
    const online=new Set([...subscriptions.values()].filter(s=>s.event===w.id).map(s=>s.session));
    res.json({invitations:await invitations.list(w.id),participants:(await invitations.participants(w.id)).map(p=>({...p,online:online.has(String(p.id))}))});
  });
  app.post("/api/events/:id/invitations",async(req,res)=>{
    const w=await manageInvitation(req);
    if(['ended','stopping'].includes(w.state)) throw new HttpError(409,"Вебинар завершён");
    limit('invitation:'+w.id,12);
    const {role}=z.object({role:z.enum(['speaker','assistant'])}).strict().parse(req.body);
    await eventAction('invite:'+w.id,async()=>{
      try { const result=await invitations.create(w,role); res.json({...result,url:`${origin}/guest/${w.id}#${result.token}`}); }
      catch(e){throw new HttpError(409,(e as Error).message);}
    });
  });
  app.patch("/api/events/:id/invitations/:invitation",async(req,res)=>{
    const w=await manageInvitation(req);
    const {controls}=z.object({controls:z.boolean()}).strict().parse(req.body);
    const found=(await invitations.list(w.id)).find(i=>i.id===req.params.invitation && !i.revoked);
    if(!found) throw new HttpError(404,"Приглашение не найдено");
    await store.db.prepare("INSERT INTO invitation_controls(invite_id,allowed) VALUES (?,?) ON CONFLICT(invite_id) DO UPDATE SET allowed=excluded.allowed").run(found.id,controls?1:0);
    await publish(w.id);res.json({ok:true});
  });
  app.post("/api/events/:id/invitation-entry",async(req,res)=>{
    const w=await event(req);
    limit('invitation-entry:'+req.ip,20);
    const {token,name}=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),name:z.string().trim().min(1).max(60)}).strict().parse(req.body);
    await eventAction('invite:'+w.id,async()=>{
      try {const joined=await invitations.enter(w.id,token,name,cookie(req,`al_guest_${w.id}`));setCookie(res,`al_guest_${w.id}`,joined.session);res.json({role:joined.role});}
      catch(e){throw new HttpError(403,(e as Error).message);}
    });
  });
  app.delete("/api/events/:id/invitations/:invitation",async(req,res)=>{
    const w=await manageInvitation(req);
    await eventAction('invite:'+w.id,async()=>{
      try {
        const revoked=await invitations.revoke(w.id,String(req.params.invitation));
        speakers.revoke(revoked);
        for(const [ws,sub] of subscriptions) if(revoked.has(sub.session)) ws.close(4003,'Invitation revoked');
        res.json({ok:true});
      } catch(e){throw new HttpError(404,(e as Error).message);}
    });
  });
  const speakerIce = options.speakerIce || new SpeakerIce();
  app.get("/api/events/:id/speakers", async (req, res) => {
    const w=await event(req), s=await host(req);
    if (!(canHost(s,w) || (s?.guestRole === "speaker" && canRead(s,w)))) throw new HttpError(403,"Нет доступа спикера");
    limit(`speaker-ice:${s!.id}`, 12);
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await speakerIce.get(`${w.id}:${s!.id}`)); }
    catch (error) {
      media.diagnostic(w.id, "speaker_turn_unavailable", { status: error instanceof SpeakerIceError ? error.providerStatus : 0 });
      throw new HttpError(503, "Не удалось подготовить видеосвязь. Проверьте настройку резервного сервера и подключитесь повторно");
    }
  });
  app.get("/api/team", async (req, res) => {
    const s = await owner(req);
    const members = await store.db
      .prepare(
        "SELECT id,name,role FROM memberships WHERE company_id=? AND role IN ('moderator','host')",
      )
      .all(s.companyId);
    res.json({ members });
  });
  app.post("/api/team", async (req, res) => {
    const s = await owner(req);
    limit("team:" + s.id, 10);
    const data = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        name: z.string().trim().min(1).max(80),
        role: z.enum(["moderator", "host"]).default("moderator"),
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        await auth.inviteModerator(
          s.companyId,
          data.email,
          data.name,
          data.role,
        ),
      );
  });
  app.delete("/api/team/:member", async (req, res) => {
    const s = await owner(req);
    const member = String(req.params.member);
    const found = await store.db
      .prepare(
        "SELECT id FROM memberships WHERE id=? AND company_id=? AND role IN ('moderator','host')",
      )
      .get(member, s.companyId);
    if (!found) throw new HttpError(404, "Помощник не найден");
    // Revoke sessions and room sockets before removing identity.
    const sessions = await store.db
      .prepare("SELECT id FROM sessions WHERE member_id=?")
      .all(member);
    await store.db
      .prepare("UPDATE sessions SET blocked=1 WHERE member_id=?")
      .run(member);
    const revoked = new Set(sessions.map((row) => String(row.id)));
    speakers.revoke(revoked);
    for (const [ws, subscription] of subscriptions)
      if (revoked.has(subscription.session)) ws.close(4003, "Access revoked");
    await store.db
      .prepare("DELETE FROM host_invites WHERE member_id=?")
      .run(member);
    await store.db
      .prepare("DELETE FROM google_accounts WHERE member_id=?")
      .run(member);
    await store.db
      .prepare("DELETE FROM sessions WHERE member_id=?")
      .run(member);
    await store.db.prepare("DELETE FROM memberships WHERE id=?").run(member);
    res.json({ ok: true });
  });
  app.post("/api/clients/invite", async (req, res) => {
    const s = await owner(req);
    if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
    limit("invite:" + s.id, 10);
    const data = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        companyName: z.string().trim().min(1).max(80),
        platformChannel: z.boolean().default(false),
      })
      .parse(req.body);
    res
      .status(201)
      .json(
        await auth.inviteClient(
          data.email,
          data.companyName,
          data.platformChannel,
        ),
      );
  });

  app.post("/api/auth/local", async (req, res) => {
    if (options.publicMode) throw new HttpError(404, "Маршрут не найден");
    limit("local-login", 30);
    const current = await host(req);
    if (!current)
      setCookie(
        res,
        "al_host",
        await store.newSession(
          options.localClientPreview ? "local-client-owner" : "local-owner",
          null,
          "Ведущий",
        ),
      );
    res.json({ ok: true, mode: "local_only" });
  });
  app.get("/api/events", async (req, res) => {
    const s = await host(req);
    if (!s?.role) throw new HttpError(401, "Войдите в кабинет");
    res.json({
      events: await store.list(s.companyId),
      canCreate: s.role === "owner" || s.role === "host",
      company: { id: s.companyId, name: platformBrand.name },
    });
  });
  app.post("/api/events", async (req, res) => {
    const s = await host(req);
    if (!s || !["host", "owner"].includes(s.role || ""))
      throw new HttpError(401, "Нет доступа");
    const w = await store.create(
      s.companyId,
      eventInput.parse({ ...initialEvent, ...req.body }),
    );
    res.status(201).json(w);
  });
  app.get("/api/events/:id", async (req, res) => {
    const w = await event(req);
    await guard(req, w);
    const data = await snapshot(w);
    res.json((await host(req))?.guestRole ? {...data, recordings:[]} : data);
  });
  app.delete(
    ["/api/events/:id", "/api/admin/webinars/:id"],
    async (req, res) => {
      await eventAction(String(req.params.id), async () => {
        const w = await event(req);
        if (req.path.startsWith("/api/admin/")) {
          const s = await owner(req);
          if (s.companyId !== "arslive") throw new HttpError(403, "Нет доступа");
        } else await guard(req, w, true);
        z.object({ confirm: z.literal(true) })
          .strict()
          .parse(req.body);
        const recordings = await store.recordings(w.id);
        if (
          ["starting", "live", "reconnecting", "stopping"].includes(w.state) ||
          media.current?.record.eventId === w.id ||
          delivery.active?.event.id === w.id ||
          recordings.some(
            (r) =>
              ["recording", "processing"].includes(r.state) ||
              r.assemblyPending ||
              r.archive?.state === "pending" ||
              r.archive?.state === "uploading",
          )
        )
          throw new HttpError(
            409,
            "Сначала завершите эфир и дождитесь сохранения записи",
          );
        // Keep internal rows for recording expiry/recovery; public room access is revoked.
        await store.update(w.id, { deletedAt: new Date().toISOString() });
        for (const [ws, subscription] of subscriptions)
          if (subscription.event === w.id) ws.close(4003, "Webinar deleted");
        await store.diagnostic(w.id, "webinar_deleted");
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/events/:id/reopen", async (req, res) => {
    await eventAction(String(req.params.id), async () => {
      const w = await event(req);
      await guard(req, w, true, true);
      const { runId } = z
        .object({ runId: idSchema, confirm: z.literal(true) })
        .parse(req.body);
      if (w.state === "draft" && w.reopenedFromRunId === runId) {
        res.json({ ok: true, event: w });
        return;
      }
      const latest = (await store.recordings(w.id))[0];
      if (!latest || latest.id !== runId)
        throw new HttpError(
          409,
          "Состояние вебинара изменилось — обновите страницу",
        );
      if (
        !["ended", "failed"].includes(w.state) ||
        media.current?.record.eventId === w.id ||
        latest.state === "processing" ||
        latest.state === "recording"
      )
        throw new HttpError(
          409,
          "Дождитесь завершения эфира и подготовки записи",
        );
      const restored = await store.update(w.id, {
        state: "draft",
        ctaVisible: false,
        reopenedAt: new Date().toISOString(),
        reopenedFromRunId: runId,
      });
      await store.diagnostic(w.id, "webinar_reopened");
      await publish(w.id);
      res.json({ ok: true, event: restored });
    });
  });
  app.post("/api/events/:id/duplicate", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true);
    limit("duplicate:" + w.companyId, 10);
    res.status(201).json(await store.duplicate(w));
  });
  app.patch("/api/events/:id", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    if (w.state === "ended")
      throw new HttpError(
        409,
        "Вебинар завершён — создайте копию для нового эфира",
      );
    if (["starting", "live", "reconnecting", "stopping"].includes(w.state))
      throw new HttpError(
        409,
        "Оформление можно менять после завершения эфира",
      );
    const next = await store.update(w.id, eventInput.parse(req.body));
    await publish(w.id);
    res.json(next);
  });
  const stroke = z.object({
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    width: z.number().min(1).max(30),
    points: z
      .array(z.tuple([z.number().min(0).max(1280), z.number().min(0).max(720)]))
      .max(2000),
  });
  app.patch("/api/events/:id/offer", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    if (["ended", "stopping"].includes(w.state))
      throw new HttpError(409, "Вебинар завершён или сохраняется");
    const fields = eventInput
      .pick({ ctaTitle: true, ctaDescription: true, ctaUrl: true })
      .strict()
      .parse(req.body);
    if (fields.ctaUrl && !fields.ctaTitle.trim())
      throw new HttpError(400, "Добавьте текст кнопки предложения");
    const next = await store.update(w.id, {
      ...fields,
      ...(!fields.ctaUrl ? { ctaVisible: false } : {}),
    });
    await publish(w.id);
    res.json(next);
  });
  app.patch("/api/events/:id/chat-templates", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    if (["ended", "stopping"].includes(w.state))
      throw new HttpError(409, "Вебинар завершён или сохраняется");
    const { templates } = z
      .object({ templates: chatTemplatesSchema })
      .strict()
      .parse(req.body);
    await store.update(w.id, { chatTemplates: templates });
    await publish(w.id);
    res.json({ ok: true });
  });
  app.post("/api/events/:id/connection-check", async (req, res) => {
    const w = await event(req);
    const s = await guard(req, w, true, true);
    if (!canHost(s,w) && s.guestRole !== "speaker") throw new HttpError(403,"Проверка доступна спикеру");
    limit("connection-check:" + s.id, 12);
    if (
      (s.guestRole === "speaker" ? ["ended","stopping"] : ["ended", "starting", "live", "reconnecting", "stopping"]).includes(w.state)
    )
      throw new HttpError(409, "Проверка связи доступна до эфира");
    const { payload } = z
      .object({ payload: z.string().max(262144) })
      .strict()
      .parse(req.body);
    res.json({ bytes: Buffer.byteLength(payload), local: !options.publicMode });
  });
  app.patch("/api/events/:id/stage", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    if (w.state === "ended")
      throw new HttpError(
        409,
        "Вебинар завершён — создайте копию для нового эфира",
      );
    const data = z
      .object({
        cameraBox: cameraBoxSchema.optional(),
        slide: z.number().int().min(1).max(MAX_SLIDES).optional(),
        layout: z.enum(["slides", "camera"]).optional(),
        annotations: z
          .record(z.string().regex(/^\d{1,3}$/), z.array(stroke).max(150))
          .optional(),
        ctaVisible: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (data.ctaVisible && (!w.ctaUrl || !w.ctaTitle.trim()))
      throw new HttpError(400, "Добавьте текст кнопки и ссылку в предложении");
    res.json(await store.update(w.id, data));
    await publish(w.id);
  });
  app.post("/api/events/:id/annotations",async(req,res)=>{
    const w=await event(req);await guard(req,w,true,true);
    const change=z.object({slide:z.number().int().min(1).max(MAX_SLIDES),stroke}).strict().parse(req.body);
    await eventAction(w.id,async()=>{
      const latest=await event(req);await guard(req,latest,true,true);
      if(["ended","stopping"].includes(latest.state)) throw new HttpError(409,"Вебинар завершён");
      const key=String(change.slide),existing=latest.annotations[key] || [];
      if(existing.length>=150) throw new HttpError(409,"Очистите рисунки на слайде");
      await store.update(w.id,{annotations:{...latest.annotations,[key]:[...existing,change.stroke]}});
      await publish(w.id);res.json({ok:true});
    });
  });
  app.get("/api/events/:id/permissions", async (req, res) => {
    const w = await event(req);
    const s = await guard(req, w);
    res.json({
      broadcast: canHost(s, w),
      control: (canHost(s, w) || canAssist(s, w)) && s.guestControl !== false,
      ...(s.guestRole ? {guestRole:s.guestRole} : {}),
    });
  });
  app.get("/api/events/:id/readiness", async (req, res) => {
    await guard(req, await event(req));
    res.json({
      ffmpeg: media.readiness().ffmpeg,
      canStart:
        media.readiness().ffmpeg &&
        media.readiness().freeBytes >= 512 * 1024 * 1024,
      mode: options.publicMode ? "public_pilot" : "local_only",
    });
  });
  app.get(
    ["/api/events/:id/diagnostics", "/api/admin/webinars/:id/diagnostics"],
    async (req, res) => {
      const s = await owner(req);
      if (s.companyId !== "arslive")
        throw new HttpError(
          403,
          "Техническая сводка доступна администратору платформы",
        );
      const w = await event(req);
      if (!req.path.startsWith("/api/admin/")) await guard(req, w, true);
      const rows = await store.db
        .prepare(
          "SELECT at,kind,data FROM diagnostics WHERE event_id=? AND company_id=? AND at>=? ORDER BY at DESC,id DESC LIMIT 100",
        )
        .all(
          w.id,
          w.companyId,
          new Date(Date.now() - 7 * 86400000).toISOString(),
        );
      const viewerStats = await store.db
        .prepare(
          "SELECT kind,COUNT(*) AS count FROM analytics WHERE event_id=? AND company_id=? AND kind IN ('play_error','buffering') GROUP BY kind",
        )
        .all(w.id, w.companyId);
      res.json({
        viewerStats,
        checks: { ...media.readiness(), r2: archive.configured },
        entries: rows.map((r) => ({
          at: r.at,
          kind: r.kind,
          values: JSON.parse(r.data),
        })),
      });
    },
  );
  app.post("/api/events/:id/diagnostics", async (req, res) => {
    const w = await event(req);
    const s = await guard(req, w, true);
    limit("diagnostic:" + s.id, 30);
    const data = z
      .object({
        kind: z.enum([
          "sender_connect",
          "sender_closed",
          "sender_queue_full",
          "quality_reduced",
          "media_health",
          "tab_hidden",
          "tab_visible",
        ]),
        values: z
          .record(
            z
              .string()
              .regex(
                /^(attempt|hidden|queuedBytes|chunkBytes|code|bitrate|chunkGapMs|sampleRate|audioRunning)$/,
              ),
            z.number().finite().min(0).max(1e9),
          )
          .default({}),
      })
      .parse(req.body);
    await store.diagnostic(w.id, data.kind, data.values);
    res.json({ ok: true });
  });
  app.post("/api/events/:id/preflight", async (req, res) => {
    const w = await event(req);
    const s = await guard(req, w, true);
    if (w.state === "ended")
      throw new HttpError(
        409,
        "Вебинар завершён — создайте копию для нового эфира",
      );
    limit("preflight", 6);
    if (checking)
      throw new HttpError(409, "Проверка записи уже выполняется. Подождите немного и повторите проверку");
    const current = media.current;
    if (current) {
      const activeEvent = await store.event(current.record.eventId);
      const mayOpen = !!activeEvent && canHost(s, activeEvent);
      const message = current.stopping
        ? "Сохраняется запись предыдущего эфира. Дождитесь завершения сохранения и повторите проверку"
        : current.record.eventId === w.id
          ? "Этот эфир уже запущен. Вернитесь в его студию, чтобы продолжить или завершить эфир"
          : mayOpen
            ? "Сервер занят другим вашим эфиром. Закрытие вкладки не завершает эфир — откройте активную студию и нажмите «Завершить эфир», затем повторите проверку здесь"
            : "Сервер занят другим эфиром. Дождитесь его завершения или обратитесь к администратору";
      throw new HttpError(409, message, mayOpen ? `/studio/${current.record.eventId}` : undefined);
    }
    checking = true;
    try {
      const result = await checkRecording(media);
      try {
        const cloud = await archive.check(w.companyId);
        await store.diagnostic(w.id, "preflight_passed", {
          cloud: Number(cloud.cloud === "ready"),
        });
        res.json({ ...result, ...cloud });
      } catch {
        await store.diagnostic(w.id, "preflight_cloud_failed");
        throw new HttpError(
          503,
          "Запись работает, но облачное сохранение не прошло проверку — обратитесь к администратору платформы",
        );
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        503,
        "Не удалось проверить запись — повторите проверку перед эфиром",
      );
    } finally {
      checking = false;
    }
  });
  app.post("/api/events/:id/delivery", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    if (w.state === "ended")
      throw new HttpError(
        409,
        "Вебинар завершён — создайте копию для нового эфира",
      );
    limit("delivery:" + w.companyId, 10);
    const { provider } = z
      .object({ provider: z.enum(["railway", "youtube"]) })
      .parse(req.body);
    if (
      provider === "youtube" &&
      (!delivery.enabled || !auth.youtubeConfigured)
    )
      throw new HttpError(
        409,
        "YouTube пока выключен — сейчас используем резервный сервер",
      );
    if (
      provider === "youtube" &&
      !(await auth.broadcastChannel(w.companyId)).channel
    )
      throw new HttpError(409, "Подключите YouTube-канал компании");
    if (w.state === "stopping")
      throw new HttpError(409, "Дождитесь сохранения записи");
    await store.update(w.id, { delivery: provider });
    if (provider === "railway") delivery.stopRelay();
    else delivery.retry();
    await store.diagnostic(w.id, "delivery_selected", {
      youtube: Number(provider === "youtube"),
    });
    notify(w.id);
    res.json({ ok: true });
  });
  app.post("/api/events/:id/start", async (req, res) => {
    await eventAction(String(req.params.id), async () => {
      const w = await event(req);
      const s = await guard(req, w, true);
      if (speakers.guestSession(w.id, s.id))
        throw new HttpError(
          409,
          "Вы подключены вторым спикером. Эфир запускает первый ведущий",
        );
      if (checking)
        throw new HttpError(409, "Дождитесь окончания проверки записи");
      const data = z
        .object({
          tabId: idSchema,
          commandId: idSchema,
          mode: z.literal("broadcast"),
          earlyStartConfirmed: z.boolean().optional(),
          expectedReopenedAt: z.string().nullable().optional(),
        })
        .parse(req.body);
      const primary = speakers.primary(w.id);
      if (primary && (primary.session !== s.id || primary.tab !== data.tabId))
        throw new HttpError(
          409,
          "Комната двух спикеров открыта у другого ведущего",
        );
      if (w.reopenedAt && data.expectedReopenedAt !== w.reopenedAt)
        throw new HttpError(
          409,
          "Вебинар возвращён в ожидание — обновите студию перед запуском",
        );
      if (
        w.state === "draft" &&
        Date.parse(w.startsAt) > Date.now() + 60000 &&
        !data.earlyStartConfirmed
      )
        throw new HttpError(
          409,
          "Время вебинара ещё не наступило — подтвердите ранний запуск",
        );
      if (
        !media.current &&
        delivery.provider(w) === "youtube" &&
        delivery.active
      )
        throw new HttpError(
          409,
          "Завершается предыдущая трансляция YouTube — подождите немного и повторите запуск или выберите резервный сервер",
        );
      if (
        delivery.provider(w) === "youtube" &&
        !(await auth.broadcastChannel(w.companyId)).channel
      )
        throw new HttpError(
          409,
          "Подключите YouTube-канал в кабинете компании или выберите резерв трансляции",
        );
      try {
        res.json({
          runId: await media.start(w, s, data.tabId, data.commandId),
        });
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    });
  });
  app.post("/api/events/:id/stop", async (req, res) => {
    const w = await event(req);
    const s = await guard(req, w, true);
    if (speakers.guestSession(w.id, s.id))
      throw new HttpError(403, "Общий эфир завершает первый ведущий");
    const { runId } = z.object({ runId: idSchema }).parse(req.body);
    if (media.current?.record.id === runId && !media.current.stopping) {
      const current = await snapshot(w);
      const sessions = [...subscriptions.values()]
        .filter((s) => s.event === w.id && s.viewer)
        .map((s) => s.session);
      viewerTail.update(current, sessions);
      viewerTail.update(
        { ...current, event: { ...current.event, state: "stopping" } },
        sessions,
      );
    }
    await media.stop(w.id, false, runId, false);
    res.status(202).json({ ok: true, state: (await store.event(w.id))!.state });
  });

  app.get("/api/room/:slug/info", async (req, res) => {
    const w = await event(req);
    res.json({
      id: w.id,
      slug: w.slug,
      logoId: w.logoId,
      coverId: w.coverId,
      title: w.title,
      description: w.description,
      brandName: w.brandName,
      accent: w.accent,
      hostName: w.hostName,
      startsAt: w.startsAt,
      timezone: w.timezone,
      state: w.state,
      ...(["stopping", "ended"].includes(w.state)
        ? {
            ctaTitle: w.ctaTitle,
            ctaDescription: w.ctaDescription,
            ctaUrl: w.ctaUrl,
          }
        : {}),
    });
  });
  app.post("/api/room/:slug/join", async (req, res) => {
    const w = await event(req);
    const identity = await checkViewerBan(req, w);
    limit("join:" + req.ip, 30);
    const data = z
      .object({ name: z.string().trim().min(1).max(60) })
      .parse(req.body);
    const existing = await viewer(req, w);
    let sid = existing?.id;
    if (!sid) {
      const attendee =
        identity && /^[a-f0-9-]{36}$/.test(identity) ? identity : randomUUID();
      sid = await store.newSession(null, w, data.name, attendee);
      setCookie(res, `al_view_${w.slug}`, sid);
      const deviceId = randomUUID() + randomUUID();
      await store.db
        .prepare("INSERT INTO viewer_devices VALUES (?,?,?)")
        .run(deviceId, attendee, Date.now() + 30 * 86400000);
      setCookie(res, "al_identity", deviceId, 30 * 86400000);
      await store.analytics(w, sid, "room_entry");
    }
    res.json({ ok: true });
  });
  app.get("/api/room/:slug", async (req, res) => {
    const w = await event(req);
    await roomGuard(req, w);
    res.json(viewerSnapshot(await snapshot(w), (await viewer(req, w))?.id));
  });
  const messageRoutes = ["/api/events/:id/chat", "/api/room/:slug/chat"];
  app.get(messageRoutes, async (req, res) => {
    const w = await event(req);
    req.params.id ? await guard(req, w) : await roomGuard(req, w);
    res.json(
      (
        await store.messages(
          w.id,
          typeof req.query.before === "string" ? req.query.before : undefined,
          typeof req.query.beforeId === "string"
            ? req.query.beforeId
            : undefined,
        )
      ).map((m) =>
        req.params.id
          ? publicMessage(m, w)
          : viewerMessage(publicMessage(m, w)),
      ),
    );
  });
  app.post(messageRoutes, async (req, res) => {
    const w = await event(req);
    const s = req.params.id ? await guard(req, w) : await roomGuard(req, w);
    if (w.state === "ended")
      throw new HttpError(409, "Вебинар завершён — чат доступен для чтения");
    limit("chat:" + s.id, 20, 10000);
    const data = z
      .object({ id: idSchema, text: z.string().trim().min(1).max(1000) })
      .parse(req.body);
    await eventAction(`chat:${w.id}:${s.attendeeId || s.id}`, async () => {
      try {
        const sender =
          s.guestRole === "speaker" ? {...s,chatRole:"speaker" as const} : canAssist(s, w) && s.companyId !== w.companyId
            ? { ...s, role: "moderator" as const }
            : s;
        const message = await store.message(w, sender, data.id, data.text);
        await publish(w.id);
        res.json(
          s.role
            ? publicMessage(message, w)
            : viewerMessage(publicMessage(message, w)),
        );
      } catch (e) {
        if ((e as Error).message === "CHAT_COOLDOWN")
          throw new HttpError(
            429,
            "Следующее сообщение можно отправить через 5 секунд",
          );
        throw new HttpError(409, "Идентификатор сообщения уже использован");
      }
    });
  });
  app.patch("/api/events/:id/audience-test", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    const settings = audienceTestSchema.parse(req.body);
    await store.update(w.id, { audienceTest: settings });
    await publish(w.id);
    res.json({ ok: true });
  });
  app.patch("/api/events/:id/chat-rules", async (req, res) => {
    const w = await event(req);
    await guard(req, w, true, true);
    const { words } = z
      .object({ words: z.array(z.string().trim().min(1).max(40)).max(100) })
      .parse(req.body);
    await store.update(w.id, { chatBlockedWords: words });
    await publish(w.id);
    res.json({ ok: true });
  });
  app.post("/api/events/:id/chat/:message/approve", async (req, res) => {
    await eventAction(`message:${req.params.message}`, async () => {
      const w = await event(req);
      const s = await guard(req, w);
      if (!s.role) throw new HttpError(403, "Нет доступа");
      const row = await store.db
        .prepare(
          "SELECT data FROM messages WHERE id=? AND event_id=? AND company_id=?",
        )
        .get(String(req.params.message), w.id, w.companyId);
      if (!row) throw new HttpError(404, "Сообщение не найдено");
      const message = JSON.parse(row.data);
      if (message.deleted) throw new HttpError(409, "Сообщение уже удалено");
      message.held = false;
      delete message.moderationReason;
      await store.db
        .prepare("UPDATE messages SET data=? WHERE id=?")
        .run(JSON.stringify(message), message.id);
      await publish(w.id);
      res.json({ ok: true });
    });
  });
  app.delete("/api/events/:id/chat/:message", async (req, res) => {
    await eventAction(`message:${req.params.message}`, async () => {
      const w = await event(req);
      const s = await guard(req, w);
      if (!s.role) throw new HttpError(403, "Нет доступа");
      const row = (await store.db
        .prepare(
          "SELECT data FROM messages WHERE id=? AND event_id=? AND company_id=?",
        )
        .get(String(req.params.message), w.id, w.companyId)) as
        { data: string } | undefined;
      if (!row) throw new HttpError(404, "Сообщение не найдено");
      const m = JSON.parse(row.data);
      m.deleted = true;
      m.held = false;
      delete m.moderationReason;
      m.text = "Сообщение удалено";
      await store.db
        .prepare("UPDATE messages SET data=? WHERE id=?")
        .run(JSON.stringify(m), m.id);
      await publish(w.id);
      res.json({ ok: true });
    });
  });
  app.post("/api/events/:id/block", async (req, res) => {
    const w = await event(req);
    await guard(req, w);
    const { attendeeId } = z.object({ attendeeId: idSchema }).parse(req.body);
    const target = await store.db
      .prepare(
        "SELECT id FROM sessions WHERE attendee_id=? AND event_id=? AND company_id=? AND member_id IS NULL",
      )
      .get(attendeeId, w.id, w.companyId);
    if (!target) throw new HttpError(404, "Участник не найден");
    await store.db
      .prepare("INSERT OR IGNORE INTO viewer_bans VALUES (?,?)")
      .run(w.id, attendeeId);
    await store.db
      .prepare(
        "UPDATE sessions SET blocked=1 WHERE attendee_id=? AND event_id=? AND company_id=?",
      )
      .run(attendeeId, w.id, w.companyId);
    for (const [ws, sub] of subscriptions)
      if (sub.event === w.id && !(await store.session(sub.session))) {
        subscriptions.delete(ws);
        ws.close(4003, "Access revoked");
      }
    await publish(w.id);
    res.json({ ok: true });
  });
  app.post("/api/room/:slug/analytics", async (req, res) => {
    const w = await event(req);
    const s = await roomGuard(req, w);
    limit("analytics:" + s.id, 120);
    const data = z
      .object({
        id: idSchema,
        kind: z.enum([
          "play",
          "pause",
          "play_error",
          "buffering",
          "watch_heartbeat",
          "cta_impression",
          "cta_click",
          "room_exit",
          "room_presence",
        ]),
        tabId: z.string().uuid().optional(),
        seconds: z.number().finite().min(0).max(15).optional(),
        position: z.number().finite().min(0).max(604800).optional(),
        timezone: z.string().max(100).optional(),
        source: z.string().max(300).optional(),
      })
      .parse(req.body);
    let timezone = "";
    try {
      if (data.timezone) {
        new Intl.DateTimeFormat("en", { timeZone: data.timezone });
        timezone = data.timezone;
      }
    } catch {}
    await store.analytics(w, s.id, data.kind, data.id, {
      tabId: data.tabId,
      seconds: data.kind === "watch_heartbeat" ? data.seconds : undefined,
      position: data.position,
      timezone,
      source: sourceHost(data.source),
      device: deviceClass(req.get("user-agent") || ""),
      phase: viewerTail.get(w.id, s.id)
        ? "live"
        : ["ended", "failed"].includes(w.state)
          ? "replay"
          : w.state === "draft"
            ? "waiting"
            : "live",
    });
    res.json({ ok: true });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PRESENTATION_LIMIT, files: 1 },
  });
  // Admit one upload before buffering multipart bytes, not only one conversion afterwards.
  let assetUploadBusy = false;
  app.post("/api/events/:id/assets", async (req, res) => {
    const s = await guard(req, await event(req), true, true);
    limit("asset-upload:" + s.companyId, 12);
    if (assetUploadBusy)
      throw new HttpError(
        429,
        "Другой файл ещё загружается. Повторите через минуту",
      );
    assetUploadBusy = true;
    try {
      await new Promise<void>((resolve, reject) =>
        upload.single("file")(req, res, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const w = await event(req);
      const kind = z.enum(["pdf", "logo", "cover"]).parse(req.body.kind);
      if (s.guestRole && (kind !== 'pdf' || req.body.activate !== 'false')) throw new HttpError(403,'Можно загрузить презентацию, затем нажать «Показать»');
      if (
        ["stopping", "ended"].includes(w.state) ||
        (kind !== "pdf" &&
          ["starting", "live", "reconnecting"].includes(w.state))
      )
        throw new HttpError(
          409,
          "Загрузка недоступна в этом состоянии вебинара",
        );
      const file = req.file;
      if (!file) throw new HttpError(400, "Выберите файл");
      const prepared = await prepareAsset(file.buffer, file.originalname, kind);
      // Recheck permissions/state after conversion; retain the old deck on failure.
      const latest = await event(req);
      await guard(req, latest, true, true);
      if (
        ["stopping", "ended"].includes(latest.state) ||
        (kind !== "pdf" &&
          ["starting", "live", "reconnecting"].includes(latest.state))
      )
        throw new HttpError(
          409,
          "Вебинар уже запущен — презентация не заменена",
        );
      const id = randomUUID();
      const filename = id + "." + prepared.ext;
      mkdirSync(join(dir, "assets"), { recursive: true });
      const path = join(dir, "assets", filename);
      writeFileSync(path, prepared.buffer, { mode: 0o600 });
      try {
        await store.db
          .prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?)")
          .run(
            id,
            w.id,
            w.companyId,
            kind,
            filename,
            prepared.mime,
            prepared.buffer.length,
          );
        if (kind === 'pdf') await store.db.prepare('INSERT INTO presentation_files VALUES (?,?,?)').run(id,file.originalname.slice(0,180),prepared.pages || 1);
        if (kind !== 'pdf' || req.body.activate !== 'false') await store.update(
          w.id,
          kind === "pdf"
            ? { pdfId: id, slide: 1, annotations: {} }
            : kind === "logo"
              ? { logoId: id }
              : { coverId: id },
        );
      } catch (error) {
        unlinkSync(path);
        await store.db.prepare("DELETE FROM presentation_files WHERE asset_id=?").run(id).catch(()=>{});
        await store.db
          .prepare(
            "DELETE FROM assets WHERE id=? AND event_id=? AND company_id=?",
          )
          .run(id, w.id, w.companyId)
          .catch(() => {});
        throw error;
      }
      res.json({ id, pages: prepared.pages });
      await publish(w.id);
    } finally {
      assetUploadBusy = false;
    }
  });
  app.get('/api/events/:id/decks',async(req,res)=>{
    const w=await event(req);await guard(req,w);
    const decks=await store.db.prepare("SELECT a.id,p.name,p.pages FROM assets a LEFT JOIN presentation_files p ON p.asset_id=a.id WHERE a.event_id=? AND a.company_id=? AND a.kind='pdf'").all(w.id,w.companyId);
    res.json({decks:decks.map(d=>({...d,name:d.name || 'Презентация'})),active:w.pdfId});
  });
  app.post('/api/events/:id/decks/:asset/show',async(req,res)=>{
    const w=await event(req);await guard(req,w,true,true);
    if(['ended','stopping'].includes(w.state)) throw new HttpError(409,'Вебинар завершён или сохраняется');
    const deck=await store.db.prepare("SELECT id FROM assets WHERE id=? AND event_id=? AND company_id=? AND kind='pdf'").get(String(req.params.asset),w.id,w.companyId);
    if(!deck) throw new HttpError(404,'Презентация не найдена');
    await store.update(w.id,{pdfId:String(deck.id),slide:1,annotations:{}});await publish(w.id);res.json({ok:true});
  });
  app.get("/api/events/:id/assets/:asset", async (req, res) => {
    const w = await event(req);
    const publicBranding = [w.logoId, w.coverId]
      .filter(Boolean)
      .includes(String(req.params.asset));
    if (
      !publicBranding &&
      !canReadRoom(await host(req), w) &&
      !canRead(await viewer(req, w), w)
    )
      throw new HttpError(401, "Нет доступа");
    const a = (await store.db
      .prepare(
        "SELECT filename,mime FROM assets WHERE id=? AND event_id=? AND company_id=?",
      )
      .get(String(req.params.asset), w.id, w.companyId)) as
      { filename: string; mime: string } | undefined;
    if (!a) throw new HttpError(404, "Файл не найден");
    res.type(a.mime).sendFile(resolve(dir, "assets", a.filename));
  });
  app.get("/api/events/:id/media/:run/:part/:file", async (req, res) => {
    const w = await event(req);
    let tailAccess = false;
    const access=await host(req);
    if (access?.guestRole && (['stopping','ended'].includes(w.state) || media.current?.record.id !== req.params.run)) throw new HttpError(403,'Эфир завершён');
    if (!canReadRoom(await host(req), w)) {
      const session = await viewer(req, w);
      if (!canRead(session, w)) throw new HttpError(401, "Нет доступа");
      tailAccess = viewerTail.canRead(
        w.id,
        session!.id,
        String(req.params.run),
        String(req.params.part),
      );
      if (
        (["stopping", "ended"].includes(w.state) ||
          media.current?.record.id !== req.params.run) &&
        !tailAccess
      )
        throw new HttpError(403, "Просмотр записи недоступен");
    }
    res.setHeader("Cache-Control", "no-store");
    const r = (await store.recordings(w.id)).find(
      (r) => r.id === req.params.run && r.companyId === w.companyId,
    );
    if (
      !r ||
      recordingExpired(r) ||
      !/^\d+$/.test(String(req.params.part)) ||
      !/^(stream\.m3u8|segment-\d+\.ts)$/.test(String(req.params.file))
    )
      throw new HttpError(404, "Файл не найден");
    const partPath = resolve(dir, "recordings", r.id, String(req.params.part));
    const playlistPath = resolve(partPath, "stream.m3u8");
    if (tailAccess && req.params.file !== "stream.m3u8") {
      const window = existsSync(playlistPath)
        ? liveWindow(readFileSync(playlistPath, "utf8"), (file) =>
            existsSync(resolve(partPath, file)),
          )
        : "";
      if (!window.split("\n").includes(String(req.params.file)))
        throw new HttpError(403, "Просмотр записи недоступен");
    }
    if (
      req.params.file === "stream.m3u8" &&
      (segments.configured || tailAccess)
    ) {
      const path = resolve(
        dir,
        "recordings",
        r.id,
        String(req.params.part),
        "stream.m3u8",
      );
      if (!existsSync(path)) throw new HttpError(404, "Видео ещё готовится");
      res
        .type("application/vnd.apple.mpegurl")
        .set("Cache-Control", "no-store")
        .send(
          liveWindow(readFileSync(path, "utf8"), (file) =>
            existsSync(resolve(partPath, file)),
          ),
        );
      return;
    }
    res.sendFile(
      resolve(
        dir,
        "recordings",
        r.id,
        String(req.params.part),
        String(req.params.file),
      ),
    );
  });
  app.get("/api/events/:id/recordings/:recording", async (req, res) => {
    const w = await event(req);
    if ((await host(req))?.guestRole || !canReadRoom(await host(req), w))
      throw new HttpError(401, "Нет доступа");
    const r = (await store.recordings(w.id)).find(
      (r) => r.id === req.params.recording && r.companyId === w.companyId,
    );
    if (r && recordingExpired(r))
      throw new HttpError(410, "Срок хранения записи истёк");
    if (!r?.hasFile) throw new HttpError(404, "Запись ещё не готова");
    if (r.archive?.state === "ready" && archive.transport) {
      res.redirect(
        303,
        await archive.transport.download(
          archiveKey(r),
          req.query.download === "1" ? `recording-${r.id}.mp4` : "",
          Math.max(
            1,
            Math.min(
              10800,
              Math.floor((Date.parse(r.expiresAt || "") - Date.now()) / 1000) ||
                60,
            ),
          ),
        ),
      );
      return;
    }
    if (r.localRemovedAt)
      throw new HttpError(503, "Облачное хранилище временно недоступно");
    if (req.query.download === "1") res.attachment(`recording-${r.id}.mp4`);
    res.type("mp4").sendFile(resolve(dir, "recordings", r.id, "recording.mp4"));
  });
  app.post(
    "/api/events/:id/recordings/:recording/archive",
    async (req, res) => {
      const w = await event(req);
      await guard(req, w, true);
      limit("archive:" + w.companyId, 20);
      const r = (await store.recordings(w.id)).find(
        (r) => r.id === req.params.recording && r.companyId === w.companyId,
      );
      if (r && recordingExpired(r))
        throw new HttpError(410, "Срок хранения записи истёк");
      if (!r?.hasFile) throw new HttpError(404, "Запись ещё не готова");
      if (!archive.configured)
        throw new HttpError(409, "Облачное хранилище ещё не подключено");
      void archive.enqueue(r);
      res.status(202).json({ ok: true });
    },
  );
  app.get(
    "/api/events/:id/recordings/:recording/download",
    async (req, res) => {
      const w = await event(req);
      await guard(req, w);
      const r = (await store.recordings(w.id)).find(
        (r) => r.id === req.params.recording && r.companyId === w.companyId,
      );
      if (r && recordingExpired(r))
        throw new HttpError(410, "Срок хранения записи истёк");
      if (!r?.hasFile) throw new HttpError(404, "Запись ещё не готова");
      if (r.archive?.state === "ready" && archive.transport) {
        res.redirect(
          303,
          await archive.transport.download(
            archiveKey(r),
            `recording-${r.id}.mp4`,
            Math.max(
              1,
              Math.min(
                60,
                Math.floor(
                  (Date.parse(r.expiresAt || "") - Date.now()) / 1000,
                ) || 60,
              ),
            ),
          ),
        );
        return;
      }
      if (r.localRemovedAt)
        throw new HttpError(503, "Облачное хранилище временно недоступно");
      res.download(
        resolve(dir, "recordings", r.id, "recording.mp4"),
        `recording-${r.id}.mp4`,
      );
    },
  );
  app.get("/api/statistics", async (req, res) => {
    const s = await host(req);
    if (!s?.role) throw new HttpError(401, "Войдите в кабинет");
    limit("stats:" + s.id, 30);
    const query = z
      .object({
        event: z.string().uuid().optional(),
        run: z.string().uuid().optional(),
        days: z.coerce.number().int().min(1).max(365).default(30),
      })
      .parse(req.query);
    let selectedEvent: Webinar | null = null;
    if (query.event) {
      const target = await store.event(query.event);
      if (!target || target.deletedAt)
        throw new HttpError(404, "Вебинар не найден");
      await guard(req, target);
      selectedEvent = target;
    }
    const statsCompany = selectedEvent?.companyId || s.companyId;
    const events = selectedEvent
      ? [selectedEvent]
      : await store.list(s.companyId);
    const selected = query.event
      ? events.filter((e) => e.id === query.event)
      : events;
    if (query.event && !selected.length)
      throw new HttpError(404, "Вебинар не найден");
    if (query.run && !query.event)
      throw new HttpError(400, "Сначала выберите вебинар");
    const runs = query.event ? await store.recordings(query.event) : [];
    const run = query.run ? runs.find((r) => r.id === query.run) : undefined;
    if (query.run && !run) throw new HttpError(404, "Передача не найдена");
    const nextRun = run
      ? runs
          .filter((r) => r.createdAt > run.createdAt)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      : undefined;
    const until = run
      ? Math.min(
          Date.now(),
          Date.parse(
            run.stoppedAt || nextRun?.createdAt || new Date().toISOString(),
          ),
        )
      : Date.now();
    const since = new Date(
      Math.max(
        Date.now() - query.days * 86400000,
        run ? Date.parse(run.createdAt) : 0,
      ),
    ).toISOString();
    const rows = await store.db
      .prepare(
        `SELECT a.id,a.event_id,a.session_id,a.kind,a.at,s.attendee_id,COALESCE(s.name,'Зритель') AS name,d.data
      FROM analytics a LEFT JOIN analytics_people s ON s.id=a.session_id AND s.event_id=a.event_id AND s.company_id=a.company_id
      LEFT JOIN analytics_details d ON d.id=a.id
      WHERE a.company_id=? AND (s.id IS NOT NULL OR a.kind IN ('room_entry','room_exit','room_presence','play','pause','watch_heartbeat','buffering','play_error','cta_click','cta_impression')) AND a.at>=? AND a.at<=? ${query.event ? "AND a.event_id=?" : ""}
      ORDER BY a.at DESC LIMIT 100001`,
      )
      .all(
        statsCompany,
        since,
        new Date(until).toISOString(),
        ...(query.event ? [query.event] : []),
      );
    const allowed = new Set(selected.map((e) => e.id));
    const filtered = rows
      .slice(0, 100000)
      .filter((r) => allowed.has(r.event_id))
      .reverse();
    const recordings = await store.db
      .prepare("SELECT event_id,data FROM recordings WHERE company_id=?")
      .all(statsCompany);
    const eventInfo = selected.map((e) => ({
      id: e.id,
      title: e.title,
      startedAt:
        run?.createdAt ||
        recordings
          .filter((r) => r.event_id === e.id)
          .map((r) => JSON.parse(r.data).createdAt as string)
          .sort()[0] ||
        e.startsAt ||
        null,
    }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...buildStatistics(
        filtered as any,
        eventInfo,
        query.event || null,
        since,
        until,
        rows.length > 100000,
      ),
      selectedRunId: run?.id || null,
      runs: runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        stoppedAt: r.stoppedAt,
      })),
    });
  });
  app.get("/api/events/:id/stats", async (req, res) => {
    const w = await event(req);
    await guard(req, w);
    res.json({
      mode: "local_test",
      startedAt: w.createdAt,
      registrations: null,
      purchases: null,
      watchMinutes: null,
      events: await store.db
        .prepare(
          "SELECT kind,COUNT(*) AS count FROM analytics WHERE event_id=? AND company_id=? GROUP BY kind",
        )
        .all(w.id, w.companyId),
    });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Маршрут не найден" }),
  );
  app.use(
    (err: any, _req: Request, res: Response, _next: express.NextFunction) => {
      const status =
        err instanceof HttpError || err instanceof AssetError
          ? err.status
          : err instanceof z.ZodError || err instanceof multer.MulterError
            ? 400
            : 500;
      res.status(status).json({
        ...(err instanceof HttpError && err.recoveryUrl ? { recoveryUrl: err.recoveryUrl } : {}),
        error:
          err instanceof HttpError || err instanceof AssetError
            ? err.message
            : status === 400
              ? "Проверьте заполненные поля и размер файла"
              : "Не удалось выполнить действие",
      });
    },
  );

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", async (req, socket, head) => {
    // Vite owns its own development-only socket; do not consume that upgrade.
    if (
      process.env.NODE_ENV !== "production" &&
      req.url?.startsWith("/vite-hmr")
    )
      return;
    // Upgrade events are outside Express's async error boundary.
    socket.on("error", () => socket.destroy());
    try {
      if (
        req.headers.origin !== origin ||
        req.headers.host !== new URL(origin).host
      ) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url || "", origin);
      const w = await store.event(url.searchParams.get("event") || "");
      const view = url.searchParams.get("view") === "1";
      const s = await store.session(
        cookie(req, view && w ? `al_view_${w.slug}` : url.searchParams.get("guest") === "1" && w ? `al_guest_${w.id}` : "al_host"),
      );
      if (
        !w ||
        !(view ? canRead(s, w) : canReadRoom(s, w)) ||
        !["/ws/room", "/ws/media", "/ws/speakers"].includes(url.pathname) ||
        (url.pathname === "/ws/media" && !canHost(s,w)) ||
        (url.pathname === "/ws/speakers" && !(canHost(s,w) || (s?.guestRole === "speaker" && canRead(s,w))))
      ) {
        socket.destroy();
        return;
      }
      if (
        [...subscriptions.values()].filter((x) => x.session === s!.id).length > 8
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // ws closes invalid frames itself; an unhandled error would kill the process.
        ws.on("error", () => {});
        if (url.pathname === "/ws/speakers") {
          const role = url.searchParams.get("role");
          const tab = url.searchParams.get("tab") || "";
          const run = media.current;
          if (
            !["primary", "guest"].includes(role || "") ||
            (role === "primary" && !!s?.guestRole) ||
            !idSchema.safeParse(tab).success ||
            ["ended", "stopping"].includes(w.state) ||
            (role === "primary" &&
              run &&
              (run.record.eventId !== w.id ||
                run.owner !== s!.id ||
                run.tabId !== tab))
          ) {
            ws.close(4003, "Speaker access denied");
            return;
          }
          speakers.attach(ws, w.id, s!.id, tab, role as "primary" | "guest");
          notify(w.id);
          ws.on("close", () => notify(w.id));
        } else if (url.pathname === "/ws/room") {
          roomHeartbeat.attach(ws);
          subscriptions.set(ws, {
            event: w.id,
            session: s!.id,
            viewer: view,
            attendee: s!.attendeeId || undefined,
          });
          notify(w.id);
          ws.on("close", () => {
            subscriptions.delete(ws);
            notify(w.id);
          });
        } else {
          const timer = setTimeout(
            () => ws.close(4003, "Handshake timeout"),
            5000,
          );
          ws.once("close", () => clearTimeout(timer));
          ws.once("message", async (data, binary) => {
            clearTimeout(timer);
            try {
              if (binary) throw new Error();
              const msg = z
                .object({
                  runId: idSchema,
                  tabId: idSchema,
                  format: z.enum(["webm", "mp4"]).default("webm"),
                })
                .parse(JSON.parse(data.toString()));
              if (!(await store.session(s!.id))) throw new Error();
              await media.attach(msg.runId, msg.tabId, s!, ws, msg.format);
            } catch {
              ws.close(4003, "Invalid handshake");
            }
          });
        }
      });
    } catch {
      // A database outage or an aborted handshake must affect only this client.
      socket.destroy();
    }
  });
  const speakerHeartbeat = setInterval(
    () => void speakers.tick().catch(() => {}),
    10000,
  );
  speakerHeartbeat.unref();
  const ticker = setInterval(async () => {
    if (closing) return;
    try {
      void delivery.tick();
      if (media.current) {
        const r = media.current;
        if (!(await store.session(r.owner))) {
          void media.stop(r.record.eventId, true).catch(() => {});
          return;
        }
        await publish(r.record.eventId);
      }
    } catch {
      if (!closing) console.error("Media status unavailable");
    }
  }, 2000);
  ticker.unref();
  async function close() {
    closing = true;
    clearInterval(ticker);
    clearInterval(speakerHeartbeat);
    clearInterval(archiveRetry);
    clearInterval(housekeeping);
    if (media.current) await media.stop(media.current.record.eventId, true);
    await delivery.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
    await media.waitForStops();
    await media.waitForArchives();
    await segments.close();
    await archive.close();
    await store.db.close();
  }
  return { app, server, store, media, close };
}
