/** Simple in-memory per-IP rate limiter. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max = 10,
    private windowMs = 60_000,
  ) {}

  check(ip: string): boolean {
    const now = Date.now();
    const w = this.windows.get(ip);
    if (!w || now > w.resetAt) {
      this.windows.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (w.count >= this.max) return false;
    w.count++;
    return true;
  }

  reset(ip?: string): void {
    if (ip) {
      this.windows.delete(ip);
    } else {
      this.windows.clear();
    }
  }
}
