import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { encrypt, decrypt, type GoogleAuth } from "./auth.ts";
import type { MediaManager } from "./media.ts";
import type { Webinar } from "../shared/contracts.ts";

// Never return stderr itself: RTMPS errors may contain the private stream key.
export function relayFailureCategory(stderr:string) {
  if(/401|403|unauthorized|forbidden|authentication failed/i.test(stderr)) return "access";
  if(/connection refused|connection reset|timed out|network is unreachable|broken pipe|temporary failure in name resolution|failed to resolve/i.test(stderr)) return "network";
  if(/invalid data|error opening input|failed to open segment|no such file|could not find codec|non.monoton/i.test(stderr)) return "input";
  return "unknown";
}

export type YouTubeState = {
  enabled: boolean;
  phase: "off" | "waiting" | "sending" | "live" | "error";
  videoId?: string;
  message?: string;
};
type Prepared = {
  broadcastId: string;
  streamId: string;
  ingest: string;
  sourceCompany?: string;
};
export function validateIngest(address: string, key: string) {
  const u = new URL(address);
  if (
    u.protocol !== "rtmps:" ||
    !/^(?:[a-z0-9-]+\.)*rtmps?\.youtube\.com$/.test(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^[a-zA-Z0-9_-]+$/.test(key)
  )
    throw Error("Invalid YouTube ingest");
  return address.replace(/\/$/, "") + "/" + key;
}
export function youtubeErrorReason(error: unknown): string {
  const reason = (
    error as {
      response?: { data?: { error?: { errors?: { reason?: string }[] } } };
    }
  )?.response?.data?.error?.errors?.[0]?.reason;
  const known = [
    "liveStreamingNotEnabled",
    "livePermissionBlocked",
    "quotaExceeded",
    "invalidFrameRate",
    "invalidResolution",
    "invalidValue",
    "insufficientLivePermissions",
    "insufficientPermissions",
    "insufficientPermission",
    "liveEmbeddingNotAllowed",
    "invalidEmbedSetting",
    "forbiddenEmbedSetting",
    "accessNotConfigured",
    "SERVICE_DISABLED",
    "invalid_client",
    "unauthorized_client",
    "authError",
    "invalidTitle",
    "invalidAutoStart",
    "invalidAutoStop",
    "invalidScheduledStartTime",
    "userBroadcastsExceedLimit",
    "userRequestsExceedRateLimit",
    "backendError",
    "invalid_grant",
  ];
  const code = reason || (error as any)?.response?.data?.error;
  return typeof code === "string" && known.includes(code) ? code : "unknown";
}
function safeHttpStatus(error: unknown): number {
  const status = (error as { response?: { status?: unknown } })?.response
    ?.status;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
    ? status
    : 0;
}
class YouTubeSetupError extends Error {
  constructor(
    public reason: string,
    message: string,
    public step:
      | "create_broadcast"
      | "create_stream"
      | "validate_ingest"
      | "bind"
      | "save",
    public httpStatus: number,
  ) {
    super(message);
  }
}
export function youtubeErrorMessage(error: unknown) {
  const reason =
    error instanceof YouTubeSetupError
      ? error.reason
      : youtubeErrorReason(error);
  if (reason === "liveStreamingNotEnabled")
    return "На канале ещё не разрешены прямые эфиры. Владелец канала должен открыть YouTube Studio → Создать → Начать трансляцию. Первая активация может занять до 24 часов";
  if (reason === "livePermissionBlocked")
    return "YouTube ограничил прямые эфиры на этом канале. Проверьте ограничения в YouTube Studio или используйте резервный сервер";
  if (reason === "quotaExceeded")
    return "Лимит запросов YouTube исчерпан. Обратитесь к организатору или используйте резервный сервер";
  if (
    ["invalidFrameRate", "invalidResolution", "invalidValue"].includes(reason)
  )
    return "YouTube отклонил параметры видеопотока. Повторите подключение после обновления платформы или выберите резервный сервер";
  if (
    [
      "liveEmbeddingNotAllowed",
      "invalidEmbedSetting",
      "forbiddenEmbedSetting",
    ].includes(reason)
  )
    return "YouTube не разрешил показывать эфир на нашем сайте. Владелец канала: YouTube Studio → Настройки → Канал → Доступность функций → Продвинутые функции. Проверьте доступ к встраиванию прямых трансляций. Обычного разрешения на эфиры недостаточно. Пока можно использовать резервный сервер";
  if (["accessNotConfigured", "SERVICE_DISABLED"].includes(reason))
    return "YouTube Data API не включён для Google-приложения. Администратору платформы нужно включить YouTube Data API v3 в Google Cloud";
  if (["invalid_client", "unauthorized_client"].includes(reason))
    return "Google отклонил настройки приложения. Администратору платформы нужно проверить Google Client ID и Client Secret";
  if (
    [
      "invalidTitle",
      "invalidAutoStart",
      "invalidAutoStop",
      "invalidScheduledStartTime",
    ].includes(reason)
  )
    return (
      "YouTube отклонил настройки вебинара. Передайте организатору код: " +
      reason
    );
  if (
    ["userBroadcastsExceedLimit", "userRequestsExceedRateLimit"].includes(
      reason,
    )
  )
    return "YouTube ограничил создание новых трансляций. Проверьте незавершённые эфиры в YouTube Studio и повторите позже или выберите резервный сервер";
  if (reason === "backendError")
    return "Сервис YouTube временно не отвечает. Повторите подключение позже или выберите резервный сервер";
  if (
    [
      "insufficientLivePermissions",
      "insufficientPermissions",
      "insufficientPermission",
      "invalid_grant",
      "authError",
    ].includes(reason)
  )
    return "Нет действующего разрешения YouTube. Владелец кабинета должен подключить канал заново и разрешить доступ к трансляциям";
  return "YouTube не готов: проверьте активацию эфиров, права канала и разрешение встраивания. Доступен резервный сервер";
}
export class YouTubeAPI {
  constructor(public auth: GoogleAuth) {}
  async request(
    company: string,
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<any> {
    const client = await this.auth.authorizedClient(company);
    const response = await client.request({
      url: "https://www.googleapis.com/youtube/v3/" + path,
      method: method as any,
      data,
      timeout: 15000,
      retry: false,
    });
    return response.data;
  }
  async remember(w: Webinar, run: string, videoId: string, source: string) {
    const channel = await this.auth.channel(source);
    await this.auth.store.db
      .prepare(
        "INSERT OR IGNORE INTO youtube_broadcast_details VALUES (?,?,?,?)",
      )
      .run(
        w.id,
        run,
        w.companyId,
        JSON.stringify({
          videoId,
          channel: channel
            ? {
                channel_id: channel.channel_id,
                title: channel.title,
                thumbnail: channel.thumbnail,
              }
            : null,
        }),
      );
  }
  async prepare(w: Webinar, run: string): Promise<Prepared> {
    const db = this.auth.store.db;
    const old = await db
      .prepare("SELECT * FROM youtube_runs WHERE event_id=? AND company_id=?")
      .get(w.id, w.companyId);
    const pinned = await db
      .prepare(
        "SELECT source_company FROM youtube_run_sources WHERE event_id=? AND run_id=?",
      )
      .get(w.id, run);
    // Legacy runs always belonged to the event company; do not redirect them after a grant.
    const sourceCompany =
      pinned?.source_company ||
      (old?.state === run
        ? w.companyId
        : await this.auth.broadcastCompany(w.companyId));
    await db
      .prepare("INSERT OR IGNORE INTO youtube_run_sources VALUES (?,?,?)")
      .run(w.id, run, sourceCompany);
    if (old && old.state === run) {
      const result = {
        sourceCompany,
        broadcastId: old.broadcast_id,
        streamId: old.stream_id,
        ingest: decrypt(
          old.url_cipher,
          this.auth.config.encryptionKey,
          w.companyId,
        ),
      };
      await this.request(
        sourceCompany,
        `liveBroadcasts/bind?id=${result.broadcastId}&streamId=${result.streamId}&part=id`,
        "POST",
      );
      await this.remember(w, run, result.broadcastId, sourceCompany);
      return result;
    }
    let broadcastId = "",
      streamId = "";
    let step: YouTubeSetupError["step"] = "create_broadcast";
    try {
      const b = await this.request(
        sourceCompany,
        "liveBroadcasts?part=snippet,status,contentDetails",
        "POST",
        {
          snippet: {
            title: w.title,
            scheduledStartTime: new Date(Date.now() + 60000).toISOString(),
          },
          status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: false,
            enableDvr: true,
            latencyPreference: "low",
            recordFromStart: true,
            enableEmbed: true,
            monitorStream: { enableMonitorStream: false },
          },
        },
      );
      broadcastId = b.id;
      step = "create_stream";
      const s = await this.request(
        sourceCompany,
        "liveStreams?part=snippet,cdn,contentDetails",
        "POST",
        {
          snippet: { title: w.title },
          cdn: {
            ingestionType: "rtmp",
            // YouTube requires both dimensions to be variable for automatic detection.
            resolution: "variable",
            frameRate: "variable",
          },
          contentDetails: { isReusable: false },
        },
      );
      streamId = s.id;
      step = "validate_ingest";
      const ingest = validateIngest(
        s.cdn.ingestionInfo.rtmpsIngestionAddress,
        s.cdn.ingestionInfo.streamName,
      );
      if (!/^[\w-]+$/.test(broadcastId) || !/^[\w-]+$/.test(streamId))
        throw Error("Invalid provider IDs");
      step = "bind";
      await this.request(
        sourceCompany,
        `liveBroadcasts/bind?id=${broadcastId}&streamId=${streamId}&part=id`,
        "POST",
      );
      step = "save";
      await db
        .prepare(
          "INSERT INTO youtube_runs VALUES (?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET broadcast_id=excluded.broadcast_id,stream_id=excluded.stream_id,url_cipher=excluded.url_cipher,state=excluded.state",
        )
        .run(
          w.id,
          w.companyId,
          broadcastId,
          streamId,
          encrypt(ingest, this.auth.config.encryptionKey, w.companyId),
          run,
        );
      await this.remember(w, run, broadcastId, sourceCompany);
      return { broadcastId, streamId, ingest, sourceCompany };
    } catch (error) {
      // Only clean up resources created by this failed preparation, never an existing customer broadcast.
      if (broadcastId)
        await this.request(
          sourceCompany,
          `liveBroadcasts?id=${broadcastId}`,
          "DELETE",
        ).catch(() => {});
      if (streamId)
        await this.request(
          sourceCompany,
          `liveStreams?id=${streamId}`,
          "DELETE",
        ).catch(() => {});
      throw new YouTubeSetupError(
        youtubeErrorReason(error),
        youtubeErrorMessage(error),
        step,
        safeHttpStatus(error),
      );
    }
  }
  async live(company: string, id: string) {
    const r = await this.request(
      company,
      `liveBroadcasts?part=status&id=${id}`,
    );
    return r.items?.[0]?.status?.lifeCycleStatus || "unknown";
  }
  async receiving(company: string, stream: string) {
    const response = await this.request(
      company,
      `liveStreams?part=status&id=${stream}`,
    );
    const status = response.items?.[0]?.status;
    return (
      status?.streamStatus === "active" &&
      status?.healthStatus?.status !== "noData"
    );
  }
  async finish(company: string, id: string) {
    const state = await this.live(company, id);
    if (state === "complete") return "complete" as const;
    if (state === "revoked") return "unavailable" as const;
    if (["ready", "created"].includes(state)) {
      await this.request(company, `liveBroadcasts?id=${id}`, "DELETE");
      return "unavailable" as const;
    } else
      await this.request(
        company,
        `liveBroadcasts/transition?id=${id}&broadcastStatus=complete&part=status`,
        "POST",
      );
    return "complete" as const;
  }
}

/** Separate relay failure cannot stop the primary local capture/recording process. */
export class YouTubeDelivery {
  enabled: boolean;
  api: YouTubeAPI;
  state: YouTubeState;
  active: {
    event: Webinar;
    run: string;
    prepared?: Prepared;
    failed?: boolean;
    startedAt?: number;
  } | null = null;
  relay: ChildProcess | null = null;
  part = 0;
  lastPoll = 0;
  missingPolls = 0;
  retryAt = 0;
  finishAfter = 0;
  busy: Promise<void> | null = null;
  constructor(
    public media: MediaManager,
    auth: GoogleAuth,
    public changed: (event: string) => void,
    enabled = process.env.YOUTUBE_LIVE_ENABLED === "true",
  ) {
    this.enabled = enabled;
    this.api = new YouTubeAPI(auth);
    this.state = { enabled, phase: enabled ? "waiting" : "off" };
  }
  provider(w: Webinar) {
    return this.enabled && w.delivery !== "railway"
      ? ("youtube" as const)
      : ("railway" as const);
  }
  status(event: string, runId?: string | null) {
    return this.active?.event.id === event &&
      (runId === undefined || this.active.run === runId)
      ? this.state
      : {
          enabled: this.enabled,
          phase: this.enabled ? ("waiting" as const) : ("off" as const),
        };
  }
  stopRelay() {
    const relay = this.relay;
    this.relay = null;
    this.part = 0;
    this.missingPolls = 0;
    if (relay) {
      relay.kill("SIGTERM");
      const t = setTimeout(() => relay.kill("SIGKILL"), 3000);
      t.unref();
      relay.once("exit", () => clearTimeout(t));
    }
  }
  async finish() {
    this.stopRelay();
    const a = this.active;
    if (!a) return;
    if (a.prepared) {
      try {
        const completion = await this.api.finish(
          a.prepared.sourceCompany || a.event.companyId,
          a.prepared.broadcastId,
        );
        await this.saveCompletion(a.event.id, a.run, completion);
        this.media.diagnostic(a.event.id, "youtube_finish_confirmed", {
          complete: Number(completion === "complete"),
        });
      } catch {
        await this.saveCompletion(a.event.id, a.run, "failed").catch(() => {});
        this.media.diagnostic(a.event.id, "youtube_finish_failed");
        this.retryAt = Date.now() + 10000;
        return;
      }
    }
    if (this.active === a) {
      this.active = null;
      this.finishAfter = 0;
    }
  }
  private async saveCompletion(
    event: string,
    run: string,
    completion: "complete" | "failed" | "unavailable",
  ) {
    const db = this.media.store.db;
    const row = await db
      .prepare(
        "SELECT data FROM youtube_broadcast_details WHERE event_id=? AND run_id=?",
      )
      .get(event, run);
    if (!row) return;
    const detail = {
      ...JSON.parse(String(row.data)),
      completion,
      completedAt:
        completion === "complete" ? new Date().toISOString() : undefined,
    };
    await db
      .prepare(
        "UPDATE youtube_broadcast_details SET data=? WHERE event_id=? AND run_id=?",
      )
      .run(JSON.stringify(detail), event, run);
    this.changed(event);
  }
  retry() {
    if (this.active) {
      this.active.failed = false;
      this.active.startedAt = Date.now();
    }
    this.state = {
      ...this.state,
      phase: "waiting",
      message: "Повторяем подключение к YouTube",
    };
    this.retryAt = 0;
  }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.update()
      .catch(() => {
        if (this.active && this.state.phase !== "error")
          this.media.diagnostic(this.active.event.id, "youtube_status_failed");
        this.state = {
          ...this.state,
          phase: "error",
          message:
            "YouTube недоступен — можно переключить зрителей на резервный сервер",
        };
        if (this.active) this.changed(this.active.event.id);
      })
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }
  private async update() {
    if (!this.enabled) return;
    const r = this.media.current;
    if (!r || r.stopping || (this.active && this.active.run !== r.record.id)) {
      // Let the relay consume the final HLS fragments before completing the YouTube broadcast.
      if (this.active && this.relay) {
        this.finishAfter ||= Date.now() + 12000;
        if (Date.now() < this.finishAfter) return;
      }
      if (Date.now() >= this.retryAt) {
        await this.finish();
        this.retryAt = Date.now() + 10000;
      }
      return;
    }
    const w = (await this.media.store.event(r.record.eventId))!;
    if (this.provider(w) === "railway") {
      this.stopRelay();
      return;
    }
    if (!this.active) {
      this.active = { event: w, run: r.record.id, startedAt: Date.now() };
      this.state = { enabled: true, phase: "waiting" };
      this.lastPoll = this.retryAt = this.finishAfter = 0;
    }
    const a = this.active;
    if (a.failed) return;
    if (!a.prepared) {
      try {
        a.prepared = await this.api.prepare(w, r.record.id);
      } catch (error) {
        a.failed = true;
        const reason =
          error instanceof YouTubeSetupError ? error.reason : "unknown";
        this.media.diagnostic(w.id, "youtube_prepare_failed_" + reason);
        if (error instanceof YouTubeSetupError)
          this.media.diagnostic(w.id, "youtube_failed_at_" + error.step, {
            httpStatus: error.httpStatus,
          });
        this.state = {
          enabled: true,
          phase: "error",
          message:
            error instanceof Error ? error.message : youtubeErrorMessage(error),
        };
        this.changed(w.id);
        return;
      }
      this.state = {
        enabled: true,
        phase: "waiting",
        videoId: a.prepared.broadcastId,
      };
      this.media.diagnostic(w.id, "youtube_prepared");
      this.changed(w.id);
    }
    if (this.media.current !== r || r.stopping) return;
    const latest = (await this.media.store.event(w.id))!;
    if (this.provider(latest) !== "youtube") return;
    const path = join(
      this.media.store.dir,
      "recordings",
      r.record.id,
      String(r.part),
      "stream.m3u8",
    );
    if (this.part !== r.part && this.relay) this.stopRelay();
    if (!this.relay && r.ws && existsSync(path) && Date.now() >= this.retryAt) {
      const child = spawn(
        this.media.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-live_start_index",
          "-1",
          "-i",
          path,
          "-c",
          "copy",
          "-f",
          "flv",
          a.prepared.ingest,
        ],
        { stdio: ["ignore","ignore","pipe"] },
      );
      let stderr="";
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});
      this.relay = child;
      this.part = r.part;
      this.state = {
        ...this.state,
        phase: "sending",
        message: "Отправляем видео в YouTube",
      };
      const failed = (code:number|null = null) => {
        if (this.relay !== child) return;
        this.relay = null;
        if (r.stopping && code === 0) {
          this.media.diagnostic(w.id, "youtube_relay_drained");
          this.changed(w.id);
          return;
        }
        this.retryAt = Date.now() + 10000;
        this.state = {
          ...this.state,
          phase: "error",
          message:
            "Передача в YouTube прервалась — повторяем подключение, доступен резервный сервер",
        };
        this.media.diagnostic(w.id, "youtube_relay_closed");
        this.media.diagnostic(w.id,"youtube_relay_failure_"+relayFailureCategory(stderr),{exitCode:code ?? -1,part:r.part});
        stderr="";
        this.changed(w.id);
      };
      child.once("error",()=>failed());
      child.once("exit", failed);
    }
    if (Date.now() - this.lastPoll > 10000) {
      this.lastPoll = Date.now();
      const status = await this.api.live(
        a.prepared.sourceCompany || w.companyId,
        a.prepared.broadcastId,
      );
      if (status === "live" && this.relay) {
        const receiving = await this.api.receiving(
          a.prepared.sourceCompany || w.companyId,
          a.prepared.streamId,
        );
        this.missingPolls = receiving ? 0 : this.missingPolls + 1;
        if (receiving)
          this.state = {
            ...this.state,
            phase: "live",
            message: "YouTube получает видео — эфир доступен зрителям",
          };
        else if (this.missingPolls >= 2)
          this.state = {
            ...this.state,
            phase: "error",
            message:
              "YouTube не подтверждает получение видео — проверьте эфир и при необходимости включите резервный сервер",
          };
      } else if (
        !["complete", "revoked"].includes(status) &&
        a.startedAt &&
        Date.now() - a.startedAt > 90000
      ) {
        if (this.state.phase !== "error")
          this.media.diagnostic(w.id, "youtube_start_timeout");
        this.state = {
          ...this.state,
          phase: "error",
          message:
            "YouTube пока не запустил эфир для зрителей. Проверьте эфир по ссылке или переключитесь на резервный сервер",
        };
      } else if (["complete", "revoked"].includes(status)) {
        this.stopRelay();
        a.failed = true;
        this.state = {
          ...this.state,
          phase: "error",
          message:
            "Эфир YouTube завершён — выберите резервный сервер для продолжения",
        };
      }
      this.changed(w.id);
    }
  }
  async close() {
    if (this.busy) await this.busy;
    await this.finish();
    this.stopRelay();
  }
}
