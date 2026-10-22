// Separate loopback origin and real tenant session; no OAuth or cloud credentials.
import express from "express";
import { resolve } from "node:path";
import { createApp } from "../server/app.ts";
const port = 4351;
const origin = `http://localhost:${port}`;
const instance = await createApp(
  resolve("test-results/client-preview"),
  origin,
  {
    localClientPreview: true,
    archiveTransport: null,
    google: {
      clientId: "",
      clientSecret: "",
      encryptionKey: "",
      ownerEmail: "",
    },
  },
);
instance.app.use(express.static(resolve("dist")));
instance.app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/index.html")),
);
instance.server.listen(port, "127.0.0.1", () =>
  console.log(`Client preview — ${origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await instance.close();
    process.exit(0);
  });
