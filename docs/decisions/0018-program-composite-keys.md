# 0018 Composite keys that carry the program

Status: proposed, for the owner's review. Resolves the recorded gap "tenant + program composite keys". Owner instruction: "go composite keys" (the scope below is my reading of the one-line gap; the choices are listed).

## The problem
Every table has `tenant_id`, and tenant-scoped foreign keys already include it. Program-scoped tables also carry `program_id`, but a child row's program was only the code's care: nothing stopped a row under run R from saying another program than R's.

## Decision
Inside each service's own schema, a foreign key between two tables that both carry `program_id` includes `program_id`. The parent gets a unique key that includes it, and the child refers to that. A child row then has its parent's tenant and program by construction.

## What changed
- **Exposure Analysis (0005):** `runs`, `exposure_groups`, `baseline_rows` gain unique keys with the program; `baseline_rows`, `exposure_groups`, `rates_used`, `hedge_rows`, `net_groups` refer to the run with its program, and `group_members` to its group and its baseline row with theirs.
- **FX Trade (0003):** an executed trade refers to its pre-trade with the program, and a matched trade must have a program (a trade with none is still stored, unmatched, and never matched).
- **Hedge Recommendation (0006):** `recommendation_parts` refer to their recommendation with the program (it had no key at all); the ratio, rounding and maximum overrides refer to their policy. Saving a policy now deletes the overrides before the policy.
- **A check:** `tenant-program` fails when a foreign key between two program-scoped tables of a service leaves out `program_id`. It reads migrations in order, so a key dropped and added again is judged as added. Run on the old migrations it reports the eight gaps this fixes.
- Tests: the database refuses a row under another program in each of the three services; the check has its own cases.

## Not done, and why (for you to decide)
- **A user's program restriction to a program the tenant has not enabled** (`identity.user_programs` to `tenant_programs`). A key would make restricting a user to a not-yet-enabled program an error. That is a behavior change, so I left it.
- **Recommendations to the policy.** A policy is replaced in place, and a recommendation outlives the policy version it was made from; a key would need the replace to be deferred. Left as is.
- **Data Source balances and mapping rules to its programs.** A balance may carry a program code the service does not know; that is how it is blocked. A key would refuse the row we want to keep and report.
- **Master Data pair mappings.** Master Data does not own programs.
- **Across services.** Not possible: services never share a schema or a key. Each keeps its own copy of the program list, fed by events.
