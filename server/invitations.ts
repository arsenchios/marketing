import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Webinar } from "../shared/contracts.ts";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class Invitations {
  constructor(private store: Store) {}
  async create(w: Webinar, role: "speaker" | "assistant") {
    const rows = await this.list(w.id);
    if (rows.filter((r) => !r.revoked && r.expires > Date.now()).length >= 8)
      throw Error("Сначала отзовите одно из прежних приглашений");
    if (
      role === "speaker" &&
      rows.some(
        (r) => r.role === "speaker" && !r.revoked && r.expires > Date.now(),
      )
    )
      throw Error(
        "Приглашение спикера уже есть. Для новой ссылки отзовите прежнее",
      );
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const scheduled = Date.parse(w.startsAt);
    const expires = Math.min(
      Date.now() + 30 * 86400000,
      Math.max(
        Date.now() + 86400000,
        (Number.isFinite(scheduled) ? scheduled : Date.now()) + 86400000,
      ),
    );
    await this.store.db
      .prepare(
        "INSERT INTO event_invites(id,event_id,role,token_hash,expires,revoked) VALUES (?,?,?,?,?,0)",
      )
      .run(id, w.id, role, hash(token), expires);
    return { id, role, token, expires };
  }
  async list(event: string) {
    return (await this.store.db
      .prepare(
        "SELECT i.id,i.role,i.expires,i.revoked,COALESCE(c.allowed,1) AS controls FROM event_invites i LEFT JOIN invitation_controls c ON c.invite_id=i.id WHERE i.event_id=? ORDER BY i.expires DESC",
      )
      .all(event)) as {
      id: string;
      role: string;
      expires: number;
      revoked: number;
    }[];
  }
  async enter(event: string, token: string, name: string, existing: string) {
    const invite = await this.store.db
      .prepare(
        "SELECT id,role,expires FROM event_invites WHERE event_id=? AND token_hash=? AND revoked=0 AND expires>?",
      )
      .get(event, hash(token), Date.now());
    if (!invite)
      throw Error(
        "Приглашение недействительно или отозвано. Попросите новую ссылку",
      );
    const old = await this.store.session(existing);
    const linked = await this.store.db
      .prepare("SELECT invite_id FROM guest_access WHERE session_id=?")
      .get(existing);
    if (old && linked?.invite_id === invite.id)
      return { session: old.id, role: invite.role };
    const claimed = await this.store.db
      .prepare(
        "SELECT s.id FROM guest_access g JOIN sessions s ON s.id=g.session_id WHERE g.invite_id=? AND s.expires>? AND s.blocked=0",
      )
      .get(invite.id, Date.now());
    if (claimed)
      throw Error(
        "По этой ссылке уже вошёл участник. Вернитесь в прежний браузер или попросите новое приглашение",
      );
    const w = await this.store.event(event);
    if (!w || w.deletedAt || ["ended", "stopping"].includes(w.state))
      throw Error("Вебинар завершён");
    const session = randomUUID() + randomUUID();
    await this.store.db
      .prepare(
        "INSERT INTO sessions(id,member_id,event_id,company_id,attendee_id,name,expires) VALUES (?,NULL,?,?,NULL,?,?)",
      )
      .run(
        session,
        event,
        w.companyId,
        name,
        Math.min(Number(invite.expires), Date.now() + 12 * 3600000),
      );
    await this.store.db
      .prepare("INSERT INTO guest_access VALUES (?,?)")
      .run(session, invite.id);
    return { session, role: invite.role };
  }
  async revoke(event: string, id: string) {
    const invite = await this.store.db
      .prepare("SELECT id FROM event_invites WHERE id=? AND event_id=?")
      .get(id, event);
    if (!invite) throw Error("Приглашение не найдено");
    await this.store.db
      .prepare("UPDATE event_invites SET revoked=1 WHERE id=?")
      .run(id);
    const rows = await this.store.db
      .prepare("SELECT session_id FROM guest_access WHERE invite_id=?")
      .all(id);
    for (const r of rows)
      await this.store.db
        .prepare("UPDATE sessions SET blocked=1 WHERE id=?")
        .run(r.session_id);
    return new Set(rows.map((r) => String(r.session_id)));
  }
  async participants(event: string) {
    return this.store.db
      .prepare(
        "SELECT s.id,s.name,i.id AS invitation,i.role FROM sessions s JOIN guest_access g ON g.session_id=s.id JOIN event_invites i ON i.id=g.invite_id WHERE i.event_id=? AND i.revoked=0 AND i.expires>? AND s.expires>? AND s.blocked=0",
      )
      .all(event, Date.now(), Date.now());
  }
}
