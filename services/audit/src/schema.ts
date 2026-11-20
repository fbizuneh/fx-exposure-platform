// Row types for this service's tables. Positions (bigint) come back as strings (see db.ts).
export interface AuditDatabase {
  records: {
    tenant_id: string; seq: string; record_id: string; source: string; program_id: string | null; actor: string; action: string; target_type: string; target_id: string;
    fields: string[]; occurred_at: Date; recorded_at: Date; prev_hash: string; hash: string;
  };
  chain_heads: { tenant_id: string; last_seq: string; last_hash: string };
}
