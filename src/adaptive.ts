// Lower only during this studio visit: repeated upgrades would risk oscillation.
export const VIDEO_RATES = [3_500_000, 1_800_000, 900_000] as const;
export class AdaptiveQuality {
  level = 0;
  congestedAt: number | null = null;
  get bitrate() {
    return VIDEO_RATES[this.level];
  }
  sample(outstanding: number, now: number) {
    const threshold = Math.max(256 * 1024, (this.bitrate / 8) * 2);
    if (outstanding < threshold) {
      this.congestedAt = null;
      return false;
    }
    this.congestedAt ??= now;
    if (now - this.congestedAt < 3000) return false;
    return this.lower();
  }
  lower() {
    this.congestedAt = null;
    if (this.level === VIDEO_RATES.length - 1) return false;
    this.level++;
    return true;
  }
}
