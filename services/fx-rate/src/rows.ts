// What a provider file or a manual entry sends in. Numbers arrive as text so nothing is rounded on the way.
export interface RateRow {
  readonly base: string;
  readonly quote: string;
  readonly type: "SPOT" | "FORWARD";
  /** "SPOT" for spot; a tenor code for a forward. */
  readonly tenor: string;
  readonly valueDate: string | null;
  readonly allIn: string;
  readonly spot: string | null;
  readonly forwardPoints: string | null;
  readonly bid: string | null;
  readonly mid: string | null;
  readonly ask: string | null;
  /** ISO timestamp of the observation. */
  readonly observedAt: string;
}
