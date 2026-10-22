import { ChatDemo } from "./ChatDemo";
import type { AudienceTest } from "../shared/contracts";
import { defaultAudienceTest } from "../shared/audience";

export function AudienceSettings({
  value = defaultAudienceTest,
  onChange,
}: {
  value?: AudienceTest;
  onChange: (value: AudienceTest) => void;
}) {
  return (
    <div className="audience-settings">
      <p className="field-hint">
        Для закрытого теста с коллегами. В комнате ведущий и зритель увидят
        одинаковую активность без дополнительных подписей. Реальная статистика
        не меняется
      </p>
      <label className="audience-test-switch">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        Искусственный рост зрителей
      </label>
      {value.enabled && (
        <div className="audience-settings-grid">
          {(
            [
              ["rampTarget", "Зрителей после начального роста", 1, 10000],
              ["rampMinutes", "Начальный рост, минут", 1, 120],
              ["peak", "Пиковое число зрителей", 1, 10000],
              ["peakMinutes", "Минута достижения пика", 2, 240],
            ] as const
          ).map(([key, label, min, max]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={
                  key === "peak"
                    ? value.rampTarget
                    : key === "peakMinutes"
                      ? value.rampMinutes + 1
                      : min
                }
                max={max}
                step="1"
                value={value[key]}
                required
                onChange={(e) =>
                  onChange({ ...value, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <p className="field-hint">
            Сначала быстрый рост, затем плавно до пика и спад примерно до
            половины. Отсчёт начинается с запуска эфира
          </p>
        </div>
      )}
      <label className="audience-test-switch">
        <input
          type="checkbox"
          checked={value.greetingsEnabled}
          onChange={(e) =>
            onChange({ ...value, greetingsEnabled: e.target.checked })
          }
        />
        Стартовые сообщения зрителей
      </label>
      <p className="field-hint">
        20 приветствий и ответов о звуке появятся по очереди в первые 3 минуты.
        Для настоящего эфира выключите тестовые настройки
      </p>
      <details>
        <summary>Быстрый просмотр сценария</summary>
        <ChatDemo settings={value} />
      </details>
    </div>
  );
}
