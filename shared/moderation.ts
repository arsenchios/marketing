// Conservative, reviewable rules. This is not a semantic hate-speech classifier.
export function normalizedChat(text: string) {
  const letters: Record<string, string> = {
    a: "а",
    e: "е",
    o: "о",
    p: "р",
    c: "с",
    x: "х",
    y: "у",
    k: "к",
    m: "м",
    t: "т",
    b: "в",
    "0": "о",
    "3": "з",
  };
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/ё/g, "е")
    .replace(/[aeopсcxykmtb03]/g, (c) => letters[c] || c);
}
export function moderationReason(
  text: string,
  words: string[] = [],
): string | undefined {
  const normalized = normalizedChat(text);
  if (/\b(?:fuck\w*|shit|bitch)\b/i.test(text)) return "Ненормативная лексика";
  const tokens = normalized.match(/[а-яa-z]+/g) || [];
  const obscene =
    /^(?:хуй[а-я]*|ху[еяию][а-я]*|пизд[а-я]*|[её]б[ауи][а-я]*|[её]бан[а-я]*|еблан[а-я]*|бля(?:д[а-я]*|ть)?|сука|суки|мудак[а-я]*|мудил[а-я]*|гандон[а-я]*|гондон[а-я]*|долбо[её]б[а-я]*|идиот[а-я]*|дебил[а-я]*|сдохни)$/;
  if (
    tokens.some((t) => obscene.test(t)) ||
    /(?<![а-яa-z])(?:х[\s.*_\-]{0,3}у[\s.*_\-]{0,3}й|п[\s.*_\-]{0,3}и[\s.*_\-]{0,3}з[\s.*_\-]{0,3}д[\s.*_\-]{0,3}а)(?![а-яa-z])/u.test(
      normalized,
    ) ||
    obscene.test(normalized.replace(/[\s.*_\-]+/g, ""))
  )
    return "Ненормативная лексика";
  if (
    words.some((w) => w.trim() && normalized.includes(normalizedChat(w.trim())))
  )
    return "Слово из списка организатора";
  if (
    /(?:https?:\/\/|www\.|t\.me\/|[a-zа-я0-9-]+\.(?:com|ru|ai|net|org)\b)/i.test(
      text,
    )
  )
    return "Ссылка — нужна проверка";
  if (/(.)\1{14,}/u.test(text) || (text.match(/@\w+/g) || []).length > 3)
    return "Похоже на спам";
  return undefined;
}
