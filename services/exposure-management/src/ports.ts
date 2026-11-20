// What Exposure Management asks of other services. Wired in app/; nothing here imports another service's code.
import type { HedgeRecommendationQuestions } from "@services/hedge-recommendation/contract";

/** Who decided hedges on a cycle, for segregation of duties at Approve Cycle. */
export type DecisionsPort = Pick<HedgeRecommendationQuestions, "deciders">;
