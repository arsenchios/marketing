import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Store, Session } from "./store.ts";
export type Identity = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  nonce?: string;
};
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  ownerEmail: string;
};
export const googleConfig = (): GoogleConfig => ({
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || "",
  ownerEmail: (process.env.OWNER_EMAIL || "").trim().toLowerCase(),
});
export const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export function encrypt(value: string, key: string, context: string) {
  const k = Buffer.from(key, "base64");
  if (k.length !== 32) throw Error("Encryption key must contain 32 bytes");
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), encrypted]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decrypt(value: string, key: string, context: string) {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const c = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  c.setAAD(Buffer.from(context));
  c.setAuthTag(tag);
  return Buffer.concat([c.update(encrypted), c.final()]).toString("utf8");
}
export class GoogleAuth {
  constructor(
    public store: Store,
    public origin: string,
    public config: GoogleConfig = googleConfig(),
  ) {}
  get configured() {
    return !!this.config.clientId && !!this.config.clientSecret;
  }
  get youtubeConfigured() {
    return (
      this.configured &&
      Buffer.from(this.config.encryptionKey, "base64").length === 32
    );
  }
  client(kind: "login" | "youtube") {
    return new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri:
        this.origin +
        (kind === "login"
          ? "/api/auth/google/callback"
          : "/api/integrations/youtube/callback"),
    });
  }
  async initialize() {
    await this.store.db.exec(`
 CREATE TABLE IF NOT EXISTS google_accounts(sub TEXT PRIMARY KEY,email TEXT NOT NULL,member_id TEXT UNIQUE NOT NULL REFERENCES memberships(id));
 CREATE TABLE IF NOT EXISTS host_invites(email TEXT PRIMARY KEY,member_id TEXT UNIQUE NOT NULL REFERENCES memberships(id));
 CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires BIGINT NOT NULL);
 CREATE TABLE IF NOT EXISTS youtube_channels(company_id TEXT PRIMARY KEY REFERENCES companies(id),channel_id TEXT NOT NULL,title TEXT NOT NULL,token_cipher TEXT NOT NULL,connected_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS youtube_channel_profiles(company_id TEXT PRIMARY KEY REFERENCES companies(id),thumbnail TEXT);
 CREATE TABLE IF NOT EXISTS youtube_access(company_id TEXT PRIMARY KEY REFERENCES companies(id),source_company TEXT NOT NULL REFERENCES companies(id));
 CREATE TABLE IF NOT EXISTS youtube_run_sources(event_id TEXT NOT NULL,run_id TEXT NOT NULL,source_company TEXT NOT NULL REFERENCES companies(id),PRIMARY KEY(event_id,run_id));
 CREATE TABLE IF NOT EXISTS youtube_runs(event_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,broadcast_id TEXT NOT NULL,stream_id TEXT NOT NULL,url_cipher TEXT NOT NULL,state TEXT NOT NULL,FOREIGN KEY(event_id,company_id) REFERENCES webinars(id,company_id));`);
  }
  async begin(kind: "login" | "youtube", session?: Session) {
    if (!this.configured || (kind === "youtube" && !this.youtubeConfigured))
      throw Error("Google connection is not configured");
    if (kind === "youtube" && session?.role !== "owner")
      throw Error("Owner access required");
    const state = randomBytes(32).toString("base64url"),
      browser = randomBytes(32).toString("base64url"),
      nonce = randomBytes(24).toString("base64url");
    const client = this.client(kind),
      pkce = await client.generateCodeVerifierAsync();
    await this.store.db
      .prepare("DELETE FROM oauth_states WHERE expires<?")
      .run(Date.now());
    await this.store.db
      .prepare("INSERT INTO oauth_states VALUES (?,?,?,?,?,?,?)")
      .run(
        sha(state),
        sha(browser),
        kind,
        session?.id ?? null,
        nonce,
        pkce.codeVerifier,
        Date.now() + 600_000,
      );
    const url = client.generateAuthUrl({
      state,
      nonce,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      scope:
        kind === "login"
          ? ["openid", "email", "profile"]
          : ["https://www.googleapis.com/auth/youtube.force-ssl"],
      access_type: kind === "youtube" ? "offline" : "online",
      prompt: kind === "youtube" ? "consent select_account" : "select_account",
      include_granted_scopes: false,
    });
    return { url, browser };
  }
  async consume(
    state: string,
    browser: string,
    kind: "login" | "youtube",
    session?: Session,
  ) {
    if (!state || !browser) throw Error("Invalid OAuth state");
    const row = await this.store.db
      .prepare(
        "DELETE FROM oauth_states WHERE id=? AND browser_hash=? AND kind=? AND expires>? RETURNING *",
      )
      .get(sha(state), sha(browser), kind, Date.now());
    if (
      !row ||
      (kind === "youtube" &&
        (!session || session.role !== "owner" || row.session_id !== session.id))
    )
      throw Error("OAuth session expired");
    return row as { nonce: string; verifier: string };
  }
  async memberForIdentity(identity: Identity) {
    if (!identity.sub || !identity.email_verified || !identity.email)
      throw Error("Verified Google account required");
    const bound = await this.store.db
      .prepare("SELECT member_id FROM google_accounts WHERE sub=?")
      .get(identity.sub);
    if (bound) return bound.member_id as string;
    const email = identity.email.toLowerCase();
    let invite = await this.store.db
      .prepare("SELECT member_id FROM host_invites WHERE email=?")
      .get(email);
    if (!invite && email === this.config.ownerEmail) {
      // The bootstrap owner may only be claimed once. Existing identity cannot be replaced by an email change.
      const existing = await this.store.db
        .prepare("SELECT sub FROM google_accounts WHERE member_id=?")
        .get("platform-owner");
      if (existing) throw Error("Owner is already registered");
      await this.store.db
        .prepare("INSERT OR IGNORE INTO memberships VALUES (?,?,?,?)")
        .run("platform-owner", "arslive", identity.name || "Владелец", "owner");
      invite = { member_id: "platform-owner" };
    }
    if (!invite) throw Error("No invitation for this account");
    await this.store.db
      .prepare("INSERT INTO google_accounts VALUES (?,?,?)")
      .run(identity.sub, email, invite.member_id);
    await this.store.db
      .prepare("DELETE FROM host_invites WHERE email=?")
      .run(email);
    return invite.member_id as string;
  }
  async login(code: string, row: { nonce: string; verifier: string }) {
    const client = this.client("login");
    const { tokens } = await client.getToken({
      code,
      codeVerifier: row.verifier,
    });
    if (!tokens.id_token) throw Error("ID token missing");
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.config.clientId,
    });
    const id = ticket.getPayload() as Identity | undefined;
    if (!id || id.nonce !== row.nonce) throw Error("Invalid nonce");
    return {
      member: await this.memberForIdentity(id),
      name: id.name || "Ведущий",
    };
  }
  async connectYouTube(
    code: string,
    row: { verifier: string },
    session: Session,
  ) {
    const client = this.client("youtube");
    const { tokens } = await client.getToken({
      code,
      codeVerifier: row.verifier,
    });
    if (!tokens.refresh_token) throw Error("Offline consent required");
    client.setCredentials(tokens);
    const result = await client.request<{
      items?: Array<{
        id: string;
        snippet: { title: string; thumbnails?: { default?: { url: string } } };
      }>;
    }>({
      url: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      timeout: 15000,
    });
    const channel = result.data.items?.[0];
    if (!channel) throw Error("YouTube channel not found");
    await this.cacheChannelProfile(
      session.companyId,
      channel.snippet.thumbnails?.default?.url,
    );
    const cipher = encrypt(
      tokens.refresh_token,
      this.config.encryptionKey,
      session.companyId,
    );
    await this.store.db
      .prepare(
        "INSERT INTO youtube_channels VALUES (?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET channel_id=excluded.channel_id,title=excluded.title,token_cipher=excluded.token_cipher,connected_at=excluded.connected_at",
      )
      .run(
        session.companyId,
        channel.id,
        channel.snippet.title,
        cipher,
        new Date().toISOString(),
      );
  }
  async cacheChannelProfile(company: string, thumbnail?: string) {
    let safe = "";
    try {
      const u = new URL(thumbnail || "");
      if (
        u.protocol === "https:" &&
        ["yt3.ggpht.com", "yt3.googleusercontent.com"].includes(u.hostname)
      )
        safe = u.href;
    } catch {
      /* Missing channel image is optional. */
    }
    await this.store.db
      .prepare(
        "INSERT INTO youtube_channel_profiles VALUES (?,?) ON CONFLICT(company_id) DO UPDATE SET thumbnail=excluded.thumbnail",
      )
      .run(company, safe);
  }
  async channel(company: string) {
    return await this.store.db
      .prepare(
        "SELECT c.channel_id,c.title,c.connected_at,p.thumbnail FROM youtube_channels c LEFT JOIN youtube_channel_profiles p ON p.company_id=c.company_id WHERE c.company_id=?",
      )
      .get(company);
  }
  // A platform grant changes delivery credentials only, never tenant data access.
  async broadcastCompany(company: string) {
    if (await this.channel(company)) return company;
    const grant = await this.store.db
      .prepare("SELECT source_company FROM youtube_access WHERE company_id=?")
      .get(company);
    return grant?.source_company || company;
  }
  async broadcastChannel(company: string) {
    const source = await this.broadcastCompany(company);
    return { channel: await this.channel(source), shared: source !== company };
  }
  async grantPlatformChannel(company: string, allowed: boolean) {
    if (company === "arslive") throw Error("Это кабинет платформы");
    if (allowed)
      await this.store.db
        .prepare(
          "INSERT INTO youtube_access VALUES (?,?) ON CONFLICT(company_id) DO UPDATE SET source_company=excluded.source_company",
        )
        .run(company, "arslive");
    else
      await this.store.db
        .prepare("DELETE FROM youtube_access WHERE company_id=?")
        .run(company);
  }
  async authorizedClient(company: string) {
    const row = await this.store.db
      .prepare("SELECT token_cipher FROM youtube_channels WHERE company_id=?")
      .get(company);
    if (!row) throw Error("Сначала подключите YouTube-канал");
    const c = this.client("youtube");
    c.setCredentials({
      refresh_token: decrypt(
        row.token_cipher,
        this.config.encryptionKey,
        company,
      ),
    });
    return c;
  }
  async disconnect(company: string) {
    const c = await this.authorizedClient(company);
    await c.revokeCredentials();
    await this.store.db
      .prepare("DELETE FROM youtube_channels WHERE company_id=?")
      .run(company);
  }
  async inviteModerator(
    company: string,
    email: string,
    name: string,
    role: "moderator" | "host" = "moderator",
  ) {
    if (
      (await this.store.db
        .prepare("SELECT sub FROM google_accounts WHERE email=?")
        .get(email)) ||
      (await this.store.db
        .prepare("SELECT email FROM host_invites WHERE email=?")
        .get(email))
    )
      throw Error("Этот Google-аккаунт уже подключён или приглашён");
    const member = randomUUID();
    await this.store.db
      .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
      .run(member, company, name, role);
    try {
      await this.store.db
        .prepare("INSERT INTO host_invites VALUES (?,?)")
        .run(email, member);
    } catch (error) {
      await this.store.db
        .prepare("DELETE FROM memberships WHERE id=?")
        .run(member);
      throw error;
    }
    return { id: member };
  }
  async inviteClient(email: string, name: string, platformChannel = false) {
    if (
      await this.store.db
        .prepare("SELECT sub FROM google_accounts WHERE email=?")
        .get(email)
    )
      throw Error("Аккаунт уже подключён");
    if (
      await this.store.db
        .prepare("SELECT email FROM host_invites WHERE email=?")
        .get(email)
    )
      throw Error("Приглашение уже подготовлено");
    const company = randomUUID(),
      member = randomUUID();
    await this.store.db
      .prepare("INSERT INTO companies VALUES (?,?)")
      .run(company, name);
    await this.store.db
      .prepare("INSERT INTO memberships VALUES (?,?,?,?)")
      .run(member, company, name, "owner");
    await this.store.db
      .prepare("INSERT INTO host_invites VALUES (?,?)")
      .run(email, member);
    if (platformChannel) await this.grantPlatformChannel(company, true);
    return { companyId: company };
  }
}
