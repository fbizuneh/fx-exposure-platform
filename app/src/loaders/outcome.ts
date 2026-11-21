// Shared result of a file load: parse problems, a service refusal, a held Master Data snapshot, or a completed apply.

export interface FileProblem {
  readonly rowNo: number | null;
  readonly column: string | null;
  readonly message: string;
}

export type LoadOutcome =
  | { readonly kind: "INVALID_FILE"; readonly problems: readonly FileProblem[] }
  | { readonly kind: "REFUSED"; readonly message: string }
  | { readonly kind: "HELD"; readonly batchId: string; readonly reason: string }
  | {
      readonly kind: "DONE";
      readonly status: "APPLIED" | "DUPLICATE";
      readonly counts: Readonly<Record<string, number>>;
    };
