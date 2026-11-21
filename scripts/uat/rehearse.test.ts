import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetExposureGroup } from "@services/exposure-analysis/contract";
import { compareExposure } from "./rehearse.ts";

test("E7 reports a changed amount or missing group with its identifying key", () => {
  const expected = [{
    program_id: "BS-ENT", netting_level: "ENTITY", region: "", entity_code: "LE01", pair: "EUR-USD", exposure_currency: "EUR", period: "2026-11-20",
    gross_currency1: "100.00", gross_currency2: "-110.00", gross_exposure: "100.00", gross_display: "110.00",
    hedge_currency1: "-40.00", hedge_currency2: "44.00", hedge_exposure: "-40.00", hedge_display: "-44.00",
    net_currency1: "60.00", net_currency2: "-66.00", net_exposure: "60.00", net_display: "66.00",
  }];
  const actual = [{
    nettingLevel: "ENTITY", region: null, entityCode: "LE01", currencyPair: "EUR-USD", exposureCurrency: "EUR", period: "2026-11-20",
    gross: { net1: "100.00", net2: "-110.00", exposureAmount: "100.00", displayAmount: "110.00" },
    hedges: { net1: "-40.00", net2: "44.00", exposureAmount: "-40.00", displayAmount: "-44.00" },
    net: { net1: "60.00", net2: "-66.00", exposureAmount: "60.00", displayAmount: "66.00" },
  }] as NetExposureGroup[];
  compareExposure("BS-ENT", expected, actual);
  assert.throws(() => compareExposure("BS-ENT", expected, [{ ...actual[0]!, net: { ...actual[0]!.net, displayAmount: "65.99" } }]), /LE01\|EUR-USD.*net_display: expected 66\.00, got 65\.99/);
  assert.throws(() => compareExposure("BS-ENT", expected, []), /LE01\|EUR-USD.*missing platform group/);
});
