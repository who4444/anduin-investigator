import { describe, expect, it } from "vitest";

import { buildReportView } from "../lib/report/build";
import { duplicatePromise, sharedChannel } from "./fixtures/p0";

/* Structural snapshots for the report views built from the P0 fixtures.
   These lock the whole rendered view while the trust gaps (G-01..G-08) are
   fixed: any accidental change to timeline/ledger/metrics/trust shows up as
   a snapshot diff, and the intentional changes of each increment are
   reviewed one by one. Per-issue and client-pack views join these snapshots
   as those land. */
describe("report view snapshots (P0 fixtures)", () => {
  it("duplicate-promise view", () => {
    expect(buildReportView(duplicatePromise)).toMatchSnapshot();
  });

  it("shared-channel view", () => {
    expect(buildReportView(sharedChannel)).toMatchSnapshot();
  });
});
