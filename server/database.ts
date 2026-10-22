import { DatabaseSync } from "node:sqlite";
import { Client, types } from "pg";
import { join } from "node:path";
// All product SQL is scoped to this schema, including on a shared PostgreSQL database.
export const PG_SCHEMA = "arslive";
const tables = [
  "diagnostics",
  "companies",
  "memberships",
  "webinars",
  "sessions",
  "event_invites",
  "invitation_controls",
  "guest_access",
  "messages",
  "assets",
  "presentation_files",
  "recordings",
  "analytics",
  "analytics_details",
  "analytics_people",
  "viewer_bans",
  "viewer_devices",
  "channel_connections",
  "start_commands",
  "google_accounts",
  "oauth_states",
  "youtube_channels",
  "youtube_channel_profiles",
  "youtube_broadcast_details",
  "youtube_runs",
  "youtube_access",
  "youtube_run_sources",
  "host_invites",
];
export function postgresSQL(sql: string) {
  let n = 0;
  const ignore = /INSERT OR IGNORE/i.test(sql);
  sql = sql
    .replace(/PRAGMA[^;]+;/g, "")
    .replace(/INSERT OR IGNORE/gi, "INSERT")
    .replace(/\?/g, () => "$" + ++n);
  sql = sql.replace(
    /ORDER BY rowid DESC/g,
    "ORDER BY (data::jsonb->>'createdAt') DESC,id DESC",
  );
  for (const table of tables)
    sql = sql.replace(
      new RegExp("\\b" + table + "\\b", "g"),
      PG_SCHEMA + "." + table,
    );
  if (ignore) sql = sql.trim().replace(/;$/, "") + " ON CONFLICT DO NOTHING";
  return sql;
}
export type QueryEngine = {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  exec?(sql: string): Promise<unknown>;
  close?(): Promise<void>;
};
export class Database {
  private sqlite?: DatabaseSync;
  private pg?: Client;
  constructor(
    public kind: "sqlite" | "postgres",
    private engine?: QueryEngine,
  ) {}
  static async open(dir: string, url?: string) {
    if (!url) {
      const db = new Database("sqlite");
      db.sqlite = new DatabaseSync(join(dir, "live.sqlite"));
      return db;
    }
    types.setTypeParser(20, (v) => Number(v));
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: 8000,
      query_timeout: 15000,
      application_name: "arslive",
    });
    await client.connect();
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(1867252,1) AS locked",
      );
      if (!lock.rows[0].locked)
        throw new Error("Another ArsLive process owns this database");
      const db = new Database("postgres", client);
      db.pg = client;
      client.on("error", () => {
        console.error(
          "PostgreSQL connection lost; stopping to preserve single-worker ownership",
        );
        process.kill(process.pid, "SIGTERM");
      });
      await client.query("CREATE SCHEMA IF NOT EXISTS arslive");
      return db;
    } catch (e) {
      await client.end();
      throw e;
    }
  }
  // A PostgreSQL-compatible isolated engine is injected only by tests.
  static testing(engine: QueryEngine) {
    return new Database("postgres", engine);
  }
  async exec(sql: string) {
    if (this.sqlite) {
      this.sqlite.exec(sql);
      return;
    }
    const converted = postgresSQL(sql);
    if (this.engine!.exec) await this.engine!.exec(converted);
    else await this.engine!.query(converted);
  }
  prepare(sql: string) {
    const query = async (params: any[]) => {
      if (this.sqlite) {
        const stmt = this.sqlite.prepare(sql);
        return { stmt, params };
      }
      const { rows } = await this.engine!.query(postgresSQL(sql), params);
      return { rows };
    };
    return {
      all: async (...params: any[]): Promise<any[]> => {
        const r = await query(params);
        return r.rows ?? r.stmt!.all(...params);
      },
      get: async (...params: any[]): Promise<any> => {
        const r = await query(params);
        return r.rows ? r.rows[0] : r.stmt!.get(...params);
      },
      run: async (...params: any[]): Promise<any> => {
        const r = await query(params);
        return r.rows ? {} : r.stmt!.run(...params);
      },
    };
  }
  async close() {
    if (this.sqlite) this.sqlite.close();
    else if (this.pg) await this.pg.end();
    else await this.engine?.close?.();
  }
}
