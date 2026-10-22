import { platformBrand } from "../shared/brand.ts";
import type { AnalyticsDetail } from "../shared/statistics.ts";
import { publicMessage } from "../shared/chat.ts";
import { moderationReason, normalizedChat } from "../shared/moderation.ts";
import { Database } from "./database.ts";
import { randomUUID } from "node:crypto";
import { copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  initialEvent,
  eventInput,
  type Webinar,
  type EventInput,
  type Message,
  type Recording,
} from "../shared/contracts.ts";

export class Store {
  db!: Database;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  static async open(dir: string, url?: string, db?: Database) {
    const store = new Store(dir);
    store.db = db ?? (await Database.open(dir, url));
    await store.initialize();
    return store;
  }
  async initialize() {
    await this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','host','moderator')));
      CREATE TABLE IF NOT EXISTS webinars(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), slug TEXT UNIQUE NOT NULL, data TEXT NOT NULL, UNIQUE(id,company_id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, member_id TEXT REFERENCES memberships(id), event_id TEXT, company_id TEXT, attendee_id TEXT, name TEXT NOT NULL, expires BIGINT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS event_invites(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES webinars(id),role TEXT NOT NULL CHECK(role IN ('speaker','assistant')),token_hash TEXT UNIQUE NOT NULL,expires BIGINT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitation_controls(invite_id TEXT PRIMARY KEY REFERENCES event_invites(id) ON DELETE CASCADE,allowed INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS guest_access(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,invite_id TEXT NOT NULL REFERENCES event_invites(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, company_id TEXT NOT NULL, sender_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS viewer_bans(event_id TEXT NOT NULL REFERENCES webinars(id), attendee_id TEXT NOT NULL, PRIMARY KEY(event_id,attendee_id));
      CREATE TABLE IF NOT EXISTS viewer_devices(id TEXT PRIMARY KEY, attendee_id TEXT NOT NULL, expires BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_sender_time ON messages(event_id,sender_id,at);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, company_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, bytes BIGINT NOT NULL, FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS presentation_files(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,name TEXT NOT NULL,pages INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, company_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS youtube_broadcast_details(event_id TEXT NOT NULL,run_id TEXT NOT NULL,company_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(event_id,run_id),FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_recording ON recordings((1)) WHERE state IN ('recording','processing');
      CREATE TABLE IF NOT EXISTS analytics(id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, event_id TEXT NOT NULL, company_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS channel_connections(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), provider TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,company_id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE INDEX IF NOT EXISTS diagnostic_time ON diagnostics(at);
      CREATE INDEX IF NOT EXISTS diagnostic_event_time ON diagnostics(event_id,at);
      CREATE TABLE IF NOT EXISTS analytics_people(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,company_id TEXT NOT NULL,attendee_id TEXT,name TEXT NOT NULL,FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
      CREATE TABLE IF NOT EXISTS analytics_details(id TEXT PRIMARY KEY REFERENCES analytics(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_company_time ON analytics(company_id,at);
      CREATE INDEX IF NOT EXISTS analytics_event_time ON analytics(event_id,at);
      CREATE TABLE IF NOT EXISTS start_commands(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, company_id TEXT NOT NULL, session_id TEXT NOT NULL, tab_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES recordings(id), FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));
    `);
    await this.db.exec(
      "INSERT OR IGNORE INTO analytics_people SELECT id,event_id,company_id,attendee_id,name FROM sessions WHERE member_id IS NULL AND event_id IS NOT NULL AND attendee_id IS NOT NULL;",
    );
  }
  async diagnostic(
    eventId: string,
    kind: string,
    values: Record<string, number> = {},
  ) {
    const w = await this.event(eventId);
    if (!w) return;
    const at = new Date().toISOString();
    await this.db
      .prepare("INSERT INTO diagnostics VALUES (?,?,?,?,?,?)")
      .run(
        randomUUID(),
        eventId,
        w.companyId,
        at,
        kind,
        JSON.stringify(values),
      );
    await this.db
      .prepare("DELETE FROM diagnostics WHERE at<?")
      .run(new Date(Date.now() - 7 * 86400000).toISOString());
    await this.db
      .prepare(
        "DELETE FROM diagnostics WHERE event_id=? AND id NOT IN (SELECT id FROM diagnostics WHERE event_id=? ORDER BY at DESC,id DESC LIMIT 500)",
      )
      .run(eventId, eventId);
    console.info(
      JSON.stringify({ type: "live_diagnostic", eventId, kind, values, at }),
    );
  }
  async seed(local = true) {
    await this.db
      .prepare("INSERT OR IGNORE INTO companies VALUES (?,?)")
      .run("arslive", platformBrand.name);
    if (!local) return;
    await this.db
      .prepare("INSERT OR IGNORE INTO memberships VALUES (?,?,?,?)")
      .run("local-owner", "arslive", "Ведущий", "owner");
    if (!(await this.list("arslive")).length)
      await this.create("arslive", initialEvent);
  }
  async list(company: string): Promise<Webinar[]> {
    return (
      (await this.db
        .prepare(
          "SELECT data FROM webinars WHERE company_id=? ORDER BY rowid DESC",
        )
        .all(company)) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data))
      .filter((w: Webinar) => !w.deletedAt);
  }
  async event(id: string): Promise<Webinar | undefined> {
    const r = (await this.db
      .prepare("SELECT data FROM webinars WHERE id=? OR slug=?")
      .get(id, id)) as { data: string } | undefined;
    return r && JSON.parse(r.data);
  }
  async create(company: string, input: EventInput) {
    const id = randomUUID();
    const w: Webinar = {
      ...input,
      id,
      slug: id.slice(0, 8),
      companyId: company,
      state: "draft",
      createdAt: new Date().toISOString(),
      ctaVisible: false,
      pdfId: null,
      logoId: null,
      coverId: null,
      slide: 1,
      layout: "slides",
      annotations: {},
    };
    await this.db
      .prepare("INSERT INTO webinars VALUES (?,?,?,?)")
      .run(id, company, w.slug, JSON.stringify(w));
    return w;
  }
  async duplicate(source: Webinar) {
    // New asset identities keep file access scoped to the new webinar.
    const files: string[] = [];
    let copy: Webinar | undefined;
    try {
      copy = await this.create(
        source.companyId,
        eventInput.parse({
          ...source,
          title: `${source.title.slice(0, 110)} — копия`,
          startsAt: "",
          audienceTest: undefined,
        }),
      );
      const changes: Partial<Webinar> = {};
      for (const kind of ["pdf", "logo", "cover"] as const) {
        const sourceId = source[`${kind}Id`];
        if (!sourceId) continue;
        const asset = await this.db
          .prepare(
            "SELECT filename,mime,bytes FROM assets WHERE id=? AND event_id=? AND company_id=?",
          )
          .get(sourceId, source.id, source.companyId);
        if (!asset) throw new Error("Материал исходного вебинара не найден");
        const id = randomUUID();
        const filename = `${id}.${String(asset.filename).split(".").pop()}`;
        const target = join(this.dir, "assets", filename);
        copyFileSync(join(this.dir, "assets", String(asset.filename)), target);
        files.push(target);
        await this.db
          .prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?)")
          .run(
            id,
            copy.id,
            copy.companyId,
            kind,
            filename,
            asset.mime,
            asset.bytes,
          );
        changes[`${kind}Id`] = id;
      }
      return await this.update(copy.id, changes);
    } catch (error) {
      if (copy) {
        await this.db
          .prepare("DELETE FROM assets WHERE event_id=?")
          .run(copy.id);
        await this.db.prepare("DELETE FROM webinars WHERE id=?").run(copy.id);
      }
      for (const file of files) {
        try {
          unlinkSync(file);
        } catch {}
      }
      throw error;
    }
  }
  private updates = new Map<string, Promise<any>>();
  update(id: string, changes: Partial<Webinar>): Promise<Webinar> {
    const task = (this.updates.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.updateUnlocked(id, changes));
    this.updates.set(id, task);
    void task
      .finally(() => {
        if (this.updates.get(id) === task) this.updates.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private async updateUnlocked(id: string, changes: Partial<Webinar>) {
    const w = await this.event(id);
    if (!w) throw new Error("Event missing");
    const next = {
      ...w,
      ...changes,
      id: w.id,
      companyId: w.companyId,
      slug: w.slug,
    };
    await this.db
      .prepare("UPDATE webinars SET data=? WHERE id=?")
      .run(JSON.stringify(next), id);
    return next;
  }
  async messages(
    event: string,
    before?: string,
    beforeId?: string,
  ): Promise<Message[]> {
    return (
      (await this.db
        .prepare(
          "SELECT data FROM messages WHERE event_id=? AND (at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT 80",
        )
        .all(event, before || "9999", before || "9999", beforeId || "")) as {
        data: string;
      }[]
    )
      .map((r) => JSON.parse(r.data))
      .reverse();
  }
  async message(
    w: Webinar,
    s: Session,
    id: string,
    text: string,
  ): Promise<Message> {
    const old = (await this.db
      .prepare("SELECT data,sender_id,event_id FROM messages WHERE id=?")
      .get(id)) as
      { data: string; sender_id: string; event_id: string } | undefined;
    if (old) {
      if (old.sender_id !== s.id || old.event_id !== w.id)
        throw new Error("Message ID conflict");
      return JSON.parse(old.data);
    }
    const recent = !s.role
      ? await this.db
          .prepare(
            "SELECT m.data,m.at FROM messages m JOIN sessions s ON s.id=m.sender_id WHERE m.event_id=? AND s.attendee_id=? ORDER BY m.at DESC LIMIT 1",
          )
          .get(w.id, s.attendeeId)
      : null;
    if (recent && Date.now() - Date.parse(recent.at) < 5000)
      throw new Error("CHAT_COOLDOWN");
    const reason = !s.role
      ? moderationReason(text, w.chatBlockedWords) ||
        (recent &&
        Date.now() - Date.parse(recent.at) < 60000 &&
        normalizedChat(JSON.parse(recent.data).text) === normalizedChat(text)
          ? "Повтор сообщения"
          : undefined)
      : undefined;
    const msg: Message = {
      id,
      name: publicMessage({ name: s.name, role: s.chatRole || s.role || "viewer" }, w).name,
      text,
      role: s.chatRole || s.role || "viewer",
      attendeeId: s.attendeeId,
      at: new Date().toISOString(),
      deleted: false,
      held: !!reason,
      moderationReason: reason,
    };
    await this.db
      .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)")
      .run(id, w.id, w.companyId, s.id, msg.at, JSON.stringify(msg));
    await this.analytics(w, s.id, "chat_sent", id);
    return msg;
  }
  async recordings(event: string): Promise<Recording[]> {
    const records = (await this.db
      .prepare(
        "SELECT data FROM recordings WHERE event_id=? ORDER BY rowid DESC",
      )
      .all(event)) as { data: string }[];
    const details = await this.db
      .prepare(
        "SELECT run_id,data FROM youtube_broadcast_details WHERE event_id=?",
      )
      .all(event);
    return records.map((row) => {
      const record = JSON.parse(row.data) as Recording;
      const info = details.find((d) => d.run_id === record.id);
      return info ? { ...record, youtube: JSON.parse(info.data) } : record;
    });
  }

  async saveRecording(r: Recording) {
    await this.db
      .prepare(
        "INSERT INTO recordings VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(r.id, r.eventId, r.companyId, r.state, JSON.stringify(r));
  }
  async analytics(
    w: Webinar,
    session: string,
    kind: string,
    id: string = randomUUID(),
    detail?: AnalyticsDetail,
  ) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO analytics(id,event_id,company_id,session_id,kind,at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, w.id, w.companyId, session, kind, new Date().toISOString());
    if (detail) {
      const own = await this.db
        .prepare(
          "SELECT id FROM analytics WHERE id=? AND event_id=? AND company_id=? AND session_id=? AND kind=?",
        )
        .get(id, w.id, w.companyId, session, kind);
      if (own)
        await this.db
          .prepare("INSERT OR IGNORE INTO analytics_details VALUES (?,?)")
          .run(id, JSON.stringify(detail));
    }
  }
  async newSession(
    memberId: string | null,
    w: Webinar | null,
    name: string,
    attendeeId?: string,
  ) {
    const id = randomUUID() + randomUUID();
    await this.db
      .prepare(
        "INSERT INTO sessions(id,member_id,event_id,company_id,attendee_id,name,expires) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        memberId,
        w?.id ?? null,
        w?.companyId ?? null,
        memberId ? null : attendeeId || randomUUID(),
        name,
        Date.now() + 12 * 3600 * 1000,
      );
    if (!memberId && w)
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO analytics_people SELECT id,event_id,company_id,attendee_id,name FROM sessions WHERE id=?",
        )
        .run(id);
    return id;
  }
  async session(id: string): Promise<Session | undefined> {
    const r = (await this.db
      .prepare(
        `SELECT s.*,m.company_id AS member_company,m.role,i.role AS guest_role,COALESCE(ic.allowed,1) AS guest_control FROM sessions s LEFT JOIN memberships m ON m.id=s.member_id LEFT JOIN guest_access g ON g.session_id=s.id LEFT JOIN event_invites i ON i.id=g.invite_id LEFT JOIN invitation_controls ic ON ic.invite_id=i.id WHERE s.id=? AND s.expires>? AND s.blocked=0 AND (g.session_id IS NULL OR (i.revoked=0 AND i.expires>?))`,
      )
      .get(id, Date.now(), Date.now())) as Record<string, any> | undefined;
    return r
      ? {
          id: r.id,
          companyId: r.member_company ?? r.company_id,
          eventId: r.event_id,
          attendeeId: r.attendee_id,
          name: r.name,
          role: r.guest_role ? "moderator" : r.role ?? null,
          guestRole: r.guest_role || undefined,
          guestControl: !!r.guest_control,
        }
      : undefined;
  }
}
export type Session = {
  guestRole?: "speaker" | "assistant";
  guestControl?: boolean;
  chatRole?: "speaker";
  id: string;
  companyId: string;
  eventId: string | null;
  attendeeId: string | null;
  name: string;
  role: "owner" | "host" | "moderator" | null;
};
export function canRead(s: Session | undefined, w: Webinar) {
  return (
    !w.deletedAt &&
    !!s &&
    s.companyId === w.companyId &&
    (s.eventId ? s.eventId === w.id : !!s.role)
  );
}
export function canHost(s: Session | undefined, w: Webinar) {
  return canRead(s, w) && !s?.guestRole && (s!.role === "owner" || s!.role === "host");
}
