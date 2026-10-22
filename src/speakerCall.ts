import { api, guestMode } from "./api";
export class SpeakerCall {
  private socket?: WebSocket;
  private pc?: RTCPeerConnection;
  private pair = "";
  private pending: RTCIceCandidateInit[] = [];
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private sync?: ReturnType<typeof setInterval>;
  private config: RTCConfiguration = {};
  private attempt = 0;
  private queue = Promise.resolve();
  private lastCamera: boolean | undefined;
  private relayConfigured = false;
  private configExpiresAt = Infinity;
  private network = { host: 0, public: 0, relay: 0, received: 0, iceError: 0, relayConfigured: 0 };
  constructor(
    private event: string,
    private role: "primary" | "guest",
    private tab: string,
    private stream: () => MediaStream | null,
    private remote: (stream: MediaStream | null) => void,
    private status: (text: string) => void,
    private camera: (enabled: boolean) => void = () => {},
  ) {}
  async start() {
    await this.loadConfig();
    if (this.disposed) return;
    this.connect();
    this.sync = setInterval(
      () => void this.syncTracks().catch(() => this.restart()),
      1000,
    );
  }
  private async loadConfig() {
    const c = await api(`/api/events/${this.event}/speakers`);
    if (this.disposed) return;
    this.config = { iceServers: c.iceServers };
    this.relayConfigured = !!c.relayConfigured;
    this.configExpiresAt = c.expiresAt || Infinity;
  }
  private connect() {
    if (this.disposed) return;
    this.status(this.role === "guest" ? "Ожидаем подключения главного ведущего" : "Ожидаем второго спикера");
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/speakers?event=${this.event}&role=${this.role}&tab=${this.tab}${guestMode() ? "&guest=1" : ""}`,
    );
    this.socket = ws;
    ws.onmessage = (e) => {
      this.queue = this.queue
        .then(async () => {
          if (this.disposed || this.socket !== ws) return;
          const msg = JSON.parse(e.data);
          if (msg.type === "waiting") {
            this.clearPeer();
            this.attempt = 0;
            this.status(this.role === "guest" ? "Ожидаем подключения главного ведущего" : "Ожидаем второго спикера");
            return;
          }
          if (msg.type === "paired") {
            await this.paired(msg.pair);
            return;
          }
          if (msg.type === "unavailable" && msg.pair === this.pair) {
            this.clearPeer();
            this.showFailure();
            return;
          }
          if (msg.pair !== this.pair || !this.pc) return;
          if (msg.type === "camera") {
            this.camera(msg.enabled);
            return;
          }
          const pc = this.pc;
          if (msg.type === "description") {
            await pc.setRemoteDescription(msg.description);
            for (const c of this.pending.splice(0)) await pc.addIceCandidate(c);
            if (msg.description.type === "offer") {
              await pc.setLocalDescription(await pc.createAnswer());
              if (this.pc === pc)
                this.send({
                  type: "description",
                  description: pc.localDescription,
                });
            }
          } else if (msg.type === "candidate") {
            this.network.received++;
            if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
            else this.pending.push(msg.candidate);
          }
        })
        .catch(() => {
          if (this.disposed) return;
          if (this.pc) this.restart();
          else {
            this.send({ type: "unavailable" });
            this.showFailure();
          }
        });
    };
    ws.onclose = (e) => {
      if (this.disposed || this.socket !== ws) return;
      this.clearPeer();
      if ([4003, 4009, 4008].includes(e.code)) {
        this.status(
          e.code === 4009
            ? "Это место уже занято. Отключитесь в другой вкладке и попробуйте снова"
            : "Подключение закрыто. Проверьте доступ и подключитесь заново",
        );
        return;
      }
      this.status("Связь прервалась. Подключаем снова…");
      this.retry = setTimeout(() => this.connect(), 3000);
    };
  }
  private send(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ ...message, pair: this.pair }));
  }
  private async paired(pair: string) {
    this.clearPeer();
    this.pair = pair;
    // A long preflight wait must not leave the upcoming three-hour run with expired TURN access.
    if (this.configExpiresAt - Date.now() < 3 * 3600_000) await this.loadConfig();
    if (this.disposed) return;
    this.network = { host: 0, public: 0, relay: 0, received: 0, iceError: 0, relayConfigured: Number(this.relayConfigured) };
    this.status("Соединяем спикеров…");
    const stream = this.stream();
    if (!stream) throw Error("No devices");
    const pc = new RTCPeerConnection(this.config);
    this.pc = pc;
    this.publishCamera(stream);
    for (const t of stream.getTracks()) {
      const sender = pc.addTrack(t, stream);
      const params = sender.getParameters();
      params.encodings = [
        {
          maxBitrate: t.kind === "video" ? 700000 : 96000,
          ...(t.kind === "video"
            ? {
                maxFramerate: 20,
                scaleResolutionDownBy: Math.max(
                  1,
                  (t.getSettings().width || 640) / 640,
                ),
              }
            : {}),
        },
      ];
      await sender.setParameters(params).catch(() => {});
    }
    pc.onicecandidate = (e) => {
      if (this.pc !== pc) return;
      if (e.candidate) {
        if (e.candidate.type === "host") this.network.host++;
        else if (e.candidate.type === "srflx" || e.candidate.type === "prflx") this.network.public++;
        else if (e.candidate.type === "relay") this.network.relay++;
        this.send({ type: "candidate", candidate: e.candidate.toJSON() });
      } else this.reportNetwork();
    };
    pc.onicecandidateerror = (e) => {
      if (this.pc !== pc) return;
      // Never log URLs, addresses, SDP or TURN credentials.
      this.network.iceError = e.errorCode;
      this.reportNetwork();
    };
    const incoming = new MediaStream();
    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      // Unified Plan may deliver streamless tracks (notably across Safari versions).
      if (!incoming.getTracks().includes(e.track)) incoming.addTrack(e.track);
      this.remote(new MediaStream(incoming.getTracks()));
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.send({ type: "diagnostic", stage: "ice", state: pc.iceConnectionState });
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        clearTimeout(this.watchdog);
        this.attempt = 0;
        this.status("Оба спикера подключены");
        void this.reportRoute(pc);
      } else if (pc.iceConnectionState === "failed") this.restart();
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.send({type:"diagnostic", stage:"connection", state:pc.connectionState});
      if (pc.connectionState === "connected") {
        clearTimeout(this.watchdog);
        this.attempt = 0;
        this.status("Оба спикера подключены");
        void this.reportRoute(pc);
      } else if (pc.connectionState === "failed") this.restart();
      else if (pc.connectionState === "disconnected") {
        this.status("Восстанавливаем связь со спикером…");
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => this.restart(), 8000);
      }
    };
    this.watchdog = setTimeout(() => this.restart(), 20000);
    if (this.role === "primary") {
      await pc.setLocalDescription(await pc.createOffer());
      if (this.pc === pc)
        this.send({ type: "description", description: pc.localDescription });
    }
  }
  private restart() {
    if (this.disposed || !this.pc) return;
    this.reportNetwork();
    if (++this.attempt > 3) {
      this.send({ type: "unavailable" });
      this.clearPeer();
      this.showFailure();
      return;
    }
    this.send({ type: "restart" });
    this.clearPeer();
    this.status("Восстанавливаем связь со спикером…");
  }
  private reportNetwork() {
    this.send({ type: "network-summary", values: { ...this.network } });
  }
  private async reportRoute(pc: RTCPeerConnection) {
    try {
      const stats = await pc.getStats();
      if (this.pc !== pc || !["connected", "completed"].includes(pc.iceConnectionState)) return;
      let pair: any;
      stats.forEach(s => {
        if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair) stats.forEach(s => {
        if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) pair = s;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
      if (!local || !remote) return;
      const relay = local.candidateType === "relay" || remote.candidateType === "relay";
      this.send({ type: "route", relay });
      this.reportNetwork();
      this.status(relay ? "Оба спикера подключены через резервный сервер" : "Оба спикера подключены");
    } catch { /* Stats availability must never interrupt working media. */ }
  }
  private showFailure() {
    this.status(this.relayConfigured
      ? "Не удалось установить видеосвязь. Попробуйте другую сеть и подключитесь повторно."
      : "Не удалось установить прямую видеосвязь. Попробуйте другую сеть и подключитесь повторно. Резервный сервер связи не настроен.");
  }
  private publishCamera(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    const enabled = !!track && track.enabled && track.readyState === "live";
    if (enabled === this.lastCamera) return;
    this.lastCamera = enabled;
    this.send({ type: "camera", enabled });
  }
  private async syncTracks() {
    const stream = this.stream(),
      pc = this.pc;
    if (!pc || !stream) return;
    this.publishCamera(stream);
    for (const sender of pc.getSenders()) {
      const t = stream.getTracks().find((t) => t.kind === sender.track?.kind);
      if (t && t !== sender.track) await sender.replaceTrack(t);
    }
  }
  private clearPeer() {
    clearTimeout(this.watchdog);
    const pc = this.pc;
    this.pc = undefined;
    pc?.close();
    this.pending = [];
    this.lastCamera = undefined;
    this.remote(null);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    clearInterval(this.sync);
    this.clearPeer();
    this.socket?.close();
  }
}
