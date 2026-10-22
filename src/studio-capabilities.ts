export const recordingTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];
export function recordingMime() {
  return typeof MediaRecorder !== "undefined"
    ? recordingTypes.find((type) => MediaRecorder.isTypeSupported(type))
    : undefined;
}
export function studioCompatibility() {
  if (!window.isSecureContext)
    return "Для камеры нужен защищённый адрес сайта (HTTPS)";
  if (!navigator.mediaDevices?.getUserMedia)
    return "Этот браузер не даёт доступ к камере. Откройте ссылку в отдельном браузере, а не внутри мессенджера";
  if (!HTMLCanvasElement.prototype.captureStream || !recordingMime())
    return "Этот браузер пока не поддерживает передачу из студии. Обновите браузер или откройте студию на другом устройстве. Просмотр эфира остаётся доступен";
  return "";
}
