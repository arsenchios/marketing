import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight, X, Monitor, ArrowUpRight } from "lucide-react";

const steps = [
  {
    label: "Комната",
    title: "1. Создайте комнату",
    text: "Нажмите «Новый вебинар». Укажите тему, дату и имя ведущего",
    tips: [
      "Опишите в двух предложениях, что узнают участники",
      "Дата нужна зрителям для планирования. Эфир начнётся только по вашей кнопке",
    ],
  },
  {
    label: "Материалы",
    title: "2. Добавьте материалы",
    text: "Откройте «Оформление и презентация»: загрузите PDF, PowerPoint, ODP или изображение, при желании — логотип и обложку",
    tips: [
      "Курс, услугу или полезный материал добавьте в «Предложение зрителям»",
      "Нажмите «Проверить и запустить» — настройки сохранятся и откроется студия",
    ],
  },
  {
    label: "Проверка",
    title: "3. Проверьте камеру и звук",
    text: "Нажмите «Проверить камеру и звук» на экране видео и разрешите доступ в браузере",
    tips: [
      "Скажите несколько слов и запишите пробу голоса. Прослушайте её в наушниках; устройства можно выбрать под видео",
      "Закройте лишние вкладки, плееры и фоновые загрузки. Студию оставьте открытой",
      "Проверка связи оценивает отправку до сервера сейчас, но не гарантирует стабильность всего эфира",
      "Соединение и сохранение тестовой записи проверятся автоматически. Ваше видео пока видите только вы",
    ],
  },
  {
    label: "Эфир",
    title: "4. Начните вебинар",
    text: "Отправьте участникам ссылку для зрителей. Когда будете готовы, нажмите «Начать эфир»",
    tips: [
      "После отсчёта начнутся трансляция и запись. Держите студию открытой",
      "Заготовки под чатом вставляют текст в поле — проверьте его и нажмите отправить. Предложение показывается отдельной кнопкой под видео",
      "«Скрыть мой чат» меняет только ваш экран. Зрители продолжают видеть чат",
    ],
  },
  {
    label: "Запись",
    title: "5. Завершите и скачайте запись",
    text: "Нажмите «Завершить» и подтвердите. После обработки файл появится в разделе «Записи»",
    tips: [
      "Скачайте файл до даты, указанной рядом с записью: срок хранения — 7 дней",
      "Если связь оборвалась, вернитесь в студию и возобновите передачу. Если случайно завершили эфир, верните вебинар в ожидание в студии — ссылка для зрителей сохранится",
    ],
  },
];

export function GuideContent({ initialStep = 0 }: { initialStep?: number }) {
  const [step, setStep] = useState(initialStep);
  const id = useId();
  const current = steps[step];
  return (
    <div className="guide-content">
      <div className="guide-steps" aria-label="Шаги подготовки">
        {steps.map((item, index) => (
          <button
            key={item.label}
            aria-pressed={step === index}
            aria-controls={id}
            onClick={() => setStep(index)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {item.label}
          </button>
        ))}
      </div>
      <div className="guide-detail" id={id}>
        <div>
          <h3>{current.title}</h3>
          <p>{current.text}</p>
          <ul>
            {current.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          {step === 1 && (
            <a className="text-link" href="/demo/arslive-demo.pdf" download>
              Скачать тестовую презентацию <ArrowUpRight size={15} />
            </a>
          )}
        </div>
        <button
          className="guide-next"
          onClick={() => setStep((step + 1) % steps.length)}
          aria-label={step === 4 ? "Вернуться к первому шагу" : "Следующий шаг"}
        >
          <ChevronRight size={21} />
        </button>
      </div>
      <div className="guide-scope">
        <Monitor size={18} />
        <p>
          Перед запуском проверьте доступность канала и ссылки зрителя в студии.
          Не закрывайте её, пока идёт эфир
        </p>
      </div>
    </div>
  );
}

export function HelpDialog({
  onClose,
  initialStep = 0,
}: {
  onClose: () => void;
  initialStep?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="guide-dialog"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="guide-dialog-inner">
        <div className="modal-head">
          <div>
            <span className="eyebrow">ПОМОЩЬ ВЕДУЩЕМУ</span>
            <h2 id={titleId}>От подготовки до записи</h2>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Закрыть инструкцию"
          >
            <X size={22} />
          </button>
        </div>
        <GuideContent initialStep={initialStep} />
      </div>
    </dialog>
  );
}
