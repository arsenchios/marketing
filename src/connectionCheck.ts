import { api } from "./api";
export async function checkConnection(id: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const payload = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .repeat(2);
  const rates: number[] = [];
  let local = false;
  for (let i = 0; i < 3; i++) {
    const began = performance.now();
    const r = await api(`/api/events/${id}/connection-check`, {
      method: "POST",
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(10000),
    });
    local = r.local;
    rates.push(
      (r.bytes * 8) / Math.max(0.001, (performance.now() - began) / 1000) / 1e6,
    );
  }
  const mbps = Math.min(...rates);
  return {
    mbps: local ? null : mbps,
    label: local
      ? "Локальная проверка — скорость интернета не измерена"
      : `Около ${mbps.toFixed(1)} Мбит/с · ${mbps < 2 ? "слабая связь, возможны паузы" : mbps < 5 ? "средняя связь" : "хорошая связь"}`,
  };
}
