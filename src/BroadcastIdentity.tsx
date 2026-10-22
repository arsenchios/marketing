import { platformBrand } from "../shared/brand";
import { Youtube, ExternalLink, Server } from "lucide-react";
import type {
  MediaStatus,
  Recording,
  YouTubeBroadcast,
  YouTubeChannel,
} from "../shared/contracts";
export function ChannelIdentity({ channel }: { channel: YouTubeChannel }) {
  return (
    <a
      className="channel-identity"
      href={`https://www.youtube.com/channel/${encodeURIComponent(channel.channel_id)}`}
      target="_blank"
      rel="noreferrer"
    >
      {channel.thumbnail ? (
        <img
          src={channel.thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <Youtube size={22} />
      )}
      <strong>Ссылка на канал {channel.title}</strong>
      <ExternalLink size={14} />
    </a>
  );
}
export function BroadcastIdentity({
  media,
  active = false,
}: {
  media: MediaStatus;
  active?: boolean;
}) {
  const youtube = media.provider === "youtube";
  const channel = media.youtube?.channel;
  const live = media.youtube?.phase === "live";
  return (
    <div className="broadcast-identity" id="delivery-status">
      <div>
        {youtube ? <Youtube size={19} /> : <Server size={19} />}
        <strong>
          {youtube
            ? media.youtube?.phase === "error"
              ? "YouTube: нужна проверка подключения"
              : live
                ? "Эфир идёт через YouTube"
                : active
                  ? "Подключаем трансляцию к YouTube"
                  : "Выбран YouTube для трансляции"
            : `Трансляция через ${platformBrand.serverLabel}`}
        </strong>
        {youtube && channel && <ChannelIdentity channel={channel} />}
        {youtube && media.youtube?.videoId && (
          <a
            target="_blank"
            rel="noreferrer"
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(media.youtube.videoId)}`}
          >
            Открыть эфир <ExternalLink size={13} />
          </a>
        )}
      </div>
      {youtube && active && !live && (
        <p className="delivery-warning" role="status">
          {media.youtube?.phase === "error"
            ? "Зрители не получают эфир через YouTube — повторите подключение или выберите резервный сервер"
            : "Подключаем YouTube — показ зрителям ещё не подтверждён"}
        </p>
      )}
      <small>
        {youtube
          ? "Запись будет доступна в кабинете для скачивания на 7 дней. Копия на этом YouTube-канале появится, если трансляция успешно запущена и записана YouTube"
          : "Запись появится в кабинете для скачивания на 7 дней. При этом способе трансляции копия на YouTube автоматически не создаётся"}
      </small>
    </div>
  );
}
export function YouTubeRecordingLink({
  youtube,
}: {
  youtube?: YouTubeBroadcast;
}) {
  if (!youtube) return null;
  return (
    <div className="youtube-recording-link">
      <a
        className="btn quiet small"
        href={`https://www.youtube.com/watch?v=${encodeURIComponent(youtube.videoId)}`}
        target="_blank"
        rel="noreferrer"
      >
        <Youtube size={17} />
        Открыть на YouTube
        <ExternalLink size={13} />
      </a>
      {youtube.channel && <span>Канал: {youtube.channel.title}</span>}
      <small>
        {youtube.completion === "complete"
          ? "YouTube подтвердил завершение эфира. Обработка записи может занять время — проверьте воспроизведение по ссылке"
          : youtube.completion === "failed"
            ? "YouTube не подтвердил завершение — повторяем запрос. Проверьте эфир в YouTube Studio; сохранение в кабинете выполняется отдельно"
            : youtube.completion === "unavailable"
              ? "YouTube не сохранил эту трансляцию. Проверьте запись в кабинете"
              : "Сохранение на YouTube пока не подтверждено. Проверьте доступность по ссылке"}
      </small>
    </div>
  );
}

export function RecordingStorageStatus({
  recording: r,
}: {
  recording: Recording;
}) {
  if (r.purgedAt || (r.expiresAt && Date.parse(r.expiresAt) <= Date.now()))
    return null;
  const cloud = r.archive?.state === "ready";
  const local = r.hasFile && !r.localRemovedAt;
  return (
    <div className="recording-storage-status" role="status">
      <p>
        <strong>Запись в кабинете: </strong>
        {cloud
          ? "сохранена в облаке"
          : local
            ? "готовый файл сохранён на сервере"
            : r.assemblyPending
              ? "сборка не завершена — повторяем обработку, готового файла пока нет"
              : r.state === "processing"
                ? "собираем файл, это может занять несколько минут"
                : r.state === "recording"
                  ? "идёт запись"
                  : "готовый файл отсутствует"}
      </p>
      {local && !cloud && (
        <p className="delivery-warning">
          <strong>Скачайте запись на компьютер сейчас</strong> — облачная копия
          ещё не подтверждена
        </p>
      )}
      {!r.youtube && r.state !== "recording" && (
        <p>YouTube: копия не подтверждена</p>
      )}
    </div>
  );
}
