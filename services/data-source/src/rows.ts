// What a connector or file sends in. Numbers arrive as text so nothing is rounded on the way.
export interface GlBalanceRow {
  readonly entityCode: string | null;
  readonly accountNumber: string | null;
  readonly currency: string | null;
  /** A signed balance, debit-positive. Or send debit and credit instead, never both. */
  readonly balance: string | null;
  readonly debit: string | null;
  readonly credit: string | null;
  /** The as-of date on the row, if the source gives one. It must equal the batch's. */
  readonly asOf: string | null;
  /** Further columns that identify a balance or narrow a rule, such as cost center. */
  readonly dimensions: Readonly<Record<string, string>>;
}

export type RuleKind = "INCLUDE" | "EXCLUDE";
export type RuleTarget =
  | { readonly type: "ACCOUNT"; readonly chartCode: string; readonly accountNumber: string }
  | { readonly type: "NODE"; readonly chartCode: string; readonly nodeCode: string };

export interface MappingRule {
  readonly ruleId: string;
  readonly programId: string;
  readonly kind: RuleKind;
  readonly target: RuleTarget;
  /** Inclusive. */
  readonly validFrom: string;
  /** Exclusive. Null means open ended. */
  readonly validTo: string | null;
  readonly sourceSystem: string | null;
  readonly entityCode: string | null;
  /** Dimension name to the values it may have. */
  readonly dimensions: Readonly<Record<string, readonly string[]>> | null;
}
