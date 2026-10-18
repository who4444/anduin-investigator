import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertCounts,
  buildDecisionCounts,
  type DecisionCounts,
  type Fact,
  type PromiseRecord,
} from "../lib/report/decision";
import type { SourceKind } from "../lib/types";

export interface DecisionFixture {
  investigationId: string;
  scenario: string;
  title: string;
  declaredClient: string | null;
  scope: unknown;
  scopeOverrides: string[];
  events: { id: string }[];
  claims: { id: string }[];
  commitments: { id: string }[];
  gaps: { id: string }[];
  skepticNotes: { id: string }[];
  stages: { stage: string }[];
  issues: { id: string }[];
}

const FIXTURE_DIR = path.resolve(__dirname, "fixtures/decision");

function loadFixture(name: string): DecisionFixture {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as DecisionFixture;
}

describe("decision regression fixtures", () => {
  test("the five recorded scenarios exist with their expected record counts", () => {
    const expected: Record<string, number> = { demo: 41, realistic: 276, multi: 50, vague: 276, sparse: 3 };
    for (const [scenario, eventCount] of Object.entries(expected)) {
      const file = path.join(FIXTURE_DIR, `${scenario}.json`);
      expect(existsSync(file), `${scenario}.json should exist`).toBe(true);
      const fixture = loadFixture(scenario);
      expect(fixture.events).toHaveLength(eventCount);
      expect(fixture.claims.length).toBeGreaterThan(0);
      expect(fixture.stages.length).toBeGreaterThan(0);
    }
  });
});

function fact(overrides: Partial<Fact> & Pick<Fact, "id" | "state">): Fact {
  return {
    category: "cause",
    statement: "The invoice totals were caused by the UTC change",
    actorId: null,
    ts: "2024-09-10T10:00:00Z",
    source: "jira" as SourceKind,
    eventIds: ["e1"],
    claimIds: ["c1"],
    clientSafe: true,
    flags: [],
    basis: ["c1"],
    ...overrides,
  };
}

function promise(overrides: Partial<PromiseRecord> & Pick<PromiseRecord, "id" | "status">): PromiseRecord {
  return {
    promisorActorId: "a1",
    promisee: "Northwind Logistics",
    object: "fix the invoice totals in the Sep 24 release",
    deadlineIso: "2024-09-24T00:00:00Z",
    statusBasis: ["c1"],
    claimIds: ["c1"],
    contested: false,
    ...overrides,
  };
}

describe("buildDecisionCounts", () => {
  test("counts equal the exact lists they summarize", () => {
    const facts = [
      fact({ id: "f1", state: "verified" }),
      fact({ id: "f2", state: "supported" }),
      fact({ id: "f3", state: "supported" }),
    ];
    const verifiedFacts = facts.filter((f) => f.state === "verified");
    const needsCheckFacts = facts.filter((f) => f.state === "supported");
    const promises = [
      promise({ id: "p1", status: "broken" }),
      promise({ id: "p2", status: "kept" }),
      promise({ id: "p3", status: "unclear" }),
    ];
    const counts: DecisionCounts = buildDecisionCounts({
      facts,
      verifiedFacts,
      needsCheckFacts,
      questions: [{ id: "q1" }, { id: "q2" }],
      questionGroups: [{ id: "g1" }],
      promises,
    });

    expect(counts).toEqual({
      findings: 3,
      verified: 1,
      needsCheck: 2,
      questions: 2,
      questionGroups: 1,
      promises: 3,
      broken: 1,
      kept: 1,
      unclear: 1,
    });
  });

  test("assertCounts throws when any count disagrees with its list", () => {
    const facts = [fact({ id: "f1", state: "verified" })];
    expect(() =>
      assertCounts(
        {
          facts,
          verifiedFacts: [facts[0]],
          needsCheckFacts: [],
          questions: [],
          questionGroups: [],
          promises: [],
        },
        { findings: 2, verified: 1, needsCheck: 0, questions: 0, questionGroups: 0, promises: 0, broken: 0, kept: 0, unclear: 0 },
      ),
    ).toThrowError(/findings/);
  });
});
