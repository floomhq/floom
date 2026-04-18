/**
 * Tiny timing helper. Records named phases and returns wall-time in ms.
 * Used by the runtime to report per-phase cold-start / build / run timings,
 * matching the H2 report format.
 */
export class Timer {
  private readonly phases = new Map<string, number>();
  private readonly starts = new Map<string, number>();

  start(phase: string): void {
    this.starts.set(phase, Date.now());
  }

  end(phase: string): number {
    const started = this.starts.get(phase);
    if (started === undefined) {
      throw new Error(`Timer.end called for "${phase}" without a matching start`);
    }
    const ms = Date.now() - started;
    this.phases.set(phase, ms);
    this.starts.delete(phase);
    return ms;
  }

  async measure<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    this.start(phase);
    try {
      return await fn();
    } finally {
      this.end(phase);
    }
  }

  get(phase: string): number | undefined {
    return this.phases.get(phase);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.phases);
  }
}
