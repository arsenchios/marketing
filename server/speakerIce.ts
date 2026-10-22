import { z } from "zod";

const serverSchema = z.object({
  urls: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(8)]),
  username: z.string().max(2048).optional(),
  credential: z.string().max(2048).optional(),
});
const serversSchema = z.array(serverSchema).max(8);
const urls = (s: RTCIceServer) => Array.isArray(s.urls) ? s.urls : [s.urls];
const hasRelay = (servers: RTCIceServer[]) => servers.some(s => urls(s).some(u => /^turns?:/i.test(u)));
const TTL_SECONDS = 4 * 3600; // Longer than the application's maximum three-hour run.
const CACHE_MS = 5 * 60_000;

export type SpeakerIceConfig = { iceServers: RTCIceServer[]; relayConfigured: boolean; expiresAt?: number };
export class SpeakerIceError extends Error {
  constructor(public providerStatus = 0) {
    super("Не удалось подготовить видеосвязь. Проверьте настройку резервного сервера и подключитесь повторно");
  }
}

/** Only authorized speaker routes may call this. Master tokens never leave the server. */
export class SpeakerIce {
  private cache = new Map<string, { until: number; config: SpeakerIceConfig }>();
  private pending = new Map<string, Promise<SpeakerIceConfig>>();
  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async get(scope: string): Promise<SpeakerIceConfig> {
    try {
      const base = serversSchema.parse(JSON.parse(this.env.SPEAKER_ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]'));
      const key = this.env.CLOUDFLARE_TURN_KEY_ID?.trim();
      const token = this.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
      if (!key && !token) return { iceServers: base, relayConfigured: hasRelay(base) };
      if (!key || !token || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw Error();
      const cached = this.cache.get(scope);
      if (cached && cached.until > this.now()) return cached.config;
      const pending = this.pending.get(scope);
      if (pending) return await pending;
      if (this.pending.size >= 32) throw Error();
      const request = this.generate(key, token, base).then(config => {
        this.cache.delete(scope);
        this.cache.set(scope, { until: this.now() + CACHE_MS, config });
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        return config;
      });
      this.pending.set(scope, request);
      try { return await request; }
      finally { this.pending.delete(scope); }
    } catch (error) {
      // Provider bodies, configuration values and request errors may contain credentials.
      throw error instanceof SpeakerIceError ? error : new SpeakerIceError();
    }
  }

  private async generate(key: string, token: string, base: RTCIceServer[]): Promise<SpeakerIceConfig> {
    const response = await this.fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${key}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new SpeakerIceError(response.status);
    const body = await response.json();
    const generated = serversSchema.parse(body.iceServers);
    // Only the documented Cloudflare ICE endpoints; discard all unrecognized response fields.
    for (const s of generated) {
      for (const u of urls(s)) {
        if (!/^(?:stun:stun|turns?:turn)\.cloudflare\.com:\d+(?:\?transport=(?:udp|tcp))?$/.test(u)) throw Error();
        if (/^turns?:/.test(u) && (!s.username || !s.credential || s.credential === token || s.username === token)) throw Error();
      }
    }
    if (!hasRelay(generated)) throw Error();
    return { iceServers: [...base, ...generated], relayConfigured: true, expiresAt: this.now() + TTL_SECONDS * 1000 };
  }
}
