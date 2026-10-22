import express from "express";
import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { googleConfig } from "./auth.ts";
import { resolve } from "node:path";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  closeSync,
} from "node:fs";
try {
  process.loadEnvFile();
} catch {
  /* optional local environment */
}
const publicMode =
  process.env.APP_MODE === "public" || !!process.env.RAILWAY_ENVIRONMENT_ID;
const port = Number(process.env.PORT || 4350);
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
const url = new URL(origin);
if (
  origin !== url.origin ||
  (publicMode
    ? url.protocol !== "https:"
    : url.hostname !== "127.0.0.1" || url.port !== String(port))
)
  throw Error(
    "APP_ORIGIN must be the canonical HTTPS origin (or matching loopback port in local mode)",
  );
const config = googleConfig();
const missing = publicMode
  ? [
      !process.env.DATABASE_URL && "DATABASE_URL",
      !config.clientId && "GOOGLE_CLIENT_ID",
      !config.clientSecret && "GOOGLE_CLIENT_SECRET",
      !config.ownerEmail && "OWNER_EMAIL",
      Buffer.from(config.encryptionKey, "base64").length !== 32 &&
        "TOKEN_ENCRYPTION_KEY",
      !process.env.DATA_DIR && "DATA_DIR",
    ].filter(Boolean)
  : [];
// A published but unconfigured service must never expose local-login or seed demo data.
let instance: {
  app: express.Express;
  server: ReturnType<typeof createServer>;
  close(): Promise<void>;
};
let lock: string | undefined;
if (missing.length) {
  const app = express(),
    server = createServer(app);
  app.disable("x-powered-by");
  app.get("/api/health", (_req, res) =>
    res.json({ status: "setup_required", mode: "public_pilot" }),
  );
  app.get("/api/auth/config", (_req, res) =>
    res.json({ mode: "public", google: false, ready: false }),
  );
  app.use("/api", (_req, res) =>
    res
      .status(503)
      .json({ error: "Сервис запущен — вход в кабинет ещё настраивается" }),
  );
  instance = {
    app,
    server,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  console.log(
    "Public setup pending; missing variable names: " + missing.join(", "),
  );
} else {
  const dir = resolve(process.env.DATA_DIR || ".data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // PostgreSQL owns the cross-process lock in public mode; local mode uses a PID lock.
  if (!publicMode) {
    lock = resolve(dir, "server.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      try {
        process.kill(pid, 0);
        throw Error("Another process owns this data directory");
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
        unlinkSync(lock);
      }
    }
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  instance = await createApp(dir, origin, {
    publicMode,
    databaseUrl: publicMode ? process.env.DATABASE_URL : undefined,
    google: config,
  });
}
if (process.env.NODE_ENV === "production") {
  instance.app.use(express.static(resolve("dist")));
  instance.app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/index.html")),
  );
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: {
      middlewareMode: true,
      hmr: { server: instance.server, path: "/vite-hmr" },
    },
    appType: "spa",
  });
  instance.app.use(vite.middlewares);
}
instance.server.listen(port, publicMode ? "0.0.0.0" : "127.0.0.1", () =>
  console.log(
    `ArsLive — ${origin} (${publicMode ? "public pilot" : "local only"})`,
  ),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await instance.close();
  if (lock && existsSync(lock)) unlinkSync(lock);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => {
  if (lock)
    try {
      unlinkSync(lock);
    } catch {}
});
