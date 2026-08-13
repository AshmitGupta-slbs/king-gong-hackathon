/**
 * BUDGET GOVERNOR — harness part 7.
 *
 * Hard caps on tokens, wall-clock time, and money, ENFORCED before each model call rather than
 * logged after the fact. A run that would breach a cap stops cleanly and exits with run_status
 * 'deadline'. It does not keep going and surprise you with the bill, and it does not hang.
 *
 * Deliberately vendor-neutral: it knows about tokens, seconds and dollars, not about Anthropic.
 * The pre-call input estimate is a cheap character heuristic (~3.6 chars/token for English
 * prose) — approximate on purpose, because the alternative is a network round-trip to a token
 * counter before every call, which costs latency to buy precision we do not need. Actual usage
 * is recorded after each call and gates the next one, so the estimate can never drift far.
 */
import { PRICING_USD_PER_MTOK, REGISTRY_CONFIG } from '@/lib/registry';

export class DeadlineError extends Error {
  constructor(readonly cap: string, message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

export type BudgetCaps = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
  maxUsd: number;
};

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.6);

export class BudgetGovernor {
  private readonly startedAt = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly caps: BudgetCaps;

  /**
   * Caps default to the registry config and can be overridden per run — a batch backfill wants
   * different limits from an interactive upload, and it makes the governor testable without
   * mutating global config.
   */
  constructor(overrides: Partial<BudgetCaps> = {}) {
    this.caps = { ...REGISTRY_CONFIG.budget, ...overrides };
  }

  get elapsedMs() {
    return Date.now() - this.startedAt;
  }

  get usd() {
    return (
      (this.inputTokens / 1e6) * PRICING_USD_PER_MTOK.input +
      (this.outputTokens / 1e6) * PRICING_USD_PER_MTOK.output
    );
  }

  /** Throws DeadlineError if this call must not be made. Call it BEFORE every model call. */
  preflight(estInput: number, estOutput = this.caps.maxOutputTokens) {
    if (this.elapsedMs > this.caps.maxWallClockMs) {
      throw new DeadlineError(
        'maxWallClockMs',
        `Wall clock ${(this.elapsedMs / 1000).toFixed(1)}s exceeded cap ${this.caps.maxWallClockMs / 1000}s`,
      );
    }
    const projectedIn = this.inputTokens + estInput;
    if (projectedIn > this.caps.maxInputTokens) {
      throw new DeadlineError(
        'maxInputTokens',
        `Projected input ${projectedIn} tokens exceeds cap ${this.caps.maxInputTokens}`,
      );
    }
    const projectedUsd =
      this.usd +
      (estInput / 1e6) * PRICING_USD_PER_MTOK.input +
      (estOutput / 1e6) * PRICING_USD_PER_MTOK.output;
    if (projectedUsd > this.caps.maxUsd) {
      throw new DeadlineError(
        'maxUsd',
        `Projected spend $${projectedUsd.toFixed(4)} exceeds cap $${this.caps.maxUsd.toFixed(2)}`,
      );
    }
  }

  record(u: { input_tokens?: number; output_tokens?: number }) {
    this.inputTokens += u.input_tokens ?? 0;
    this.outputTokens += u.output_tokens ?? 0;
  }

  snapshot() {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      elapsed_ms: this.elapsedMs,
      usd: Number(this.usd.toFixed(5)),
      caps: this.caps,
    };
  }
}
