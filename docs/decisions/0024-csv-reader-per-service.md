# 0024 CSV reader: one copy per file-reading service

Date: 2026-11-20. Status: decided (Release 1 workstream D, step D2). Sources: AGENTS.md (shared/kernel holds only the seven identifiers), decision 0009 (FX Trade's file reader), Release 1 instructions decision row #10.

## Question
Master Data, Data Source and FX Rate need the same CSV reader FX Trade already has (`splitCsv`). A service cannot import another service's `src/`. Where does the reader live?

## Options
1. **Option A — one small `csv.ts` in each of the four services.** Copy the reader and the same test cases into each. FX Trade keeps its copy in `file.ts` unchanged for this step.
2. **A new `shared/csv` package.** Shared code outside the seven identifiers; needs an architecture decision that amends AGENTS.md.

## Decided
**Option A**, confirmed by Fikre on 2026-11-20 (Release 1 instructions row #10). Each of master-data, data-source, fx-rate and fx-trade keeps its own reader. Every copy carries a one-line comment that it is one of four and a change is made in all four. The same test cases run in each copy so drift fails a test.

## Cost
Four places to change when the reader changes; a forgotten copy shows up as a failing test rather than a shared package. Avoids amending AGENTS.md for a fifth shared thing. A later move into `shared/csv` remains open if the cost of four copies becomes too high.
