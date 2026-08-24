import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_STATE_VALUES,
  AUTO_SUMMARY_ENTRY_TYPE,
  AUTO_SUMMARY_LIMIT,
  AUTO_SUMMARY_MAX_CHARS,
  buildSummaryInput,
  latestExchange,
  normalizeAutoSummary,
  restoreAutoSummaryState,
  shouldSummarize,
} from "./agent-id";

describe("activity state contract", () => {
  test("exposes stable lifecycle values", () => {
    expect(ACTIVITY_STATE_VALUES).toEqual([
      "working",
      "idle",
      "waiting",
      "blocked",
      "stopped",
    ]);
  });
});

describe("latestExchange", () => {
  test("pairs the newest real request with the newest assistant reply", () => {
    const exchange = latestExchange([
      { role: "user", content: "first request", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: "  second request  ", timestamp: 2 },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hidden" },
          { type: "text", text: "second reply" },
        ],
      },
    ]);

    expect(exchange).toEqual({
      turnKey: "2",
      request: "second request",
      response: "second reply",
    });
  });

  test("ignores synthetic and steering user messages", () => {
    const exchange = latestExchange([
      { role: "user", content: "real request", timestamp: 7 },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "auto continue", timestamp: 8, synthetic: true },
      { role: "user", content: "steer", timestamp: 9, steering: true },
    ]);

    expect(exchange?.turnKey).toBe("7");
    expect(exchange?.request).toBe("real request");
  });

  test("returns null without a usable request", () => {
    expect(latestExchange([])).toBeNull();
    expect(
      latestExchange([
        { role: "user", content: "   ", timestamp: 1 },
        { role: "toolResult", content: "output" },
      ]),
    ).toBeNull();
  });
});

describe("normalizeAutoSummary", () => {
  test("keeps a single clean line", () => {
    expect(normalizeAutoSummary('  "Fixing checkout retries."\n\nextra ')).toBe(
      "Fixing checkout retries",
    );
    expect(normalizeAutoSummary("Reviewing\tindex   design")).toBe(
      "Reviewing index design",
    );
  });

  test("clips overlong output at a word boundary", () => {
    const summary = normalizeAutoSummary(`${"alpha ".repeat(30)}omega`);

    expect(summary).not.toBeNull();
    expect(summary?.length).toBeLessThanOrEqual(AUTO_SUMMARY_MAX_CHARS);
    expect(summary?.endsWith("alpha")).toBe(true);
  });

  test("rejects empty output", () => {
    expect(normalizeAutoSummary("")).toBeNull();
    expect(normalizeAutoSummary("\n  \n")).toBeNull();
    expect(normalizeAutoSummary('"..."')).toBeNull();
  });
});

describe("restoreAutoSummaryState", () => {
  test("returns the newest valid record", () => {
    const state = restoreAutoSummaryState([
      { type: "message" },
      {
        type: "custom",
        customType: AUTO_SUMMARY_ENTRY_TYPE,
        data: { version: 1, generations: 1, turnKey: "1", summary: "old" },
      },
      { type: "custom", customType: "other", data: { version: 1 } },
      {
        type: "custom",
        customType: AUTO_SUMMARY_ENTRY_TYPE,
        data: { version: 1, generations: 2, turnKey: "2", summary: "new" },
      },
    ]);

    expect(state).toEqual({
      version: 1,
      generations: 2,
      turnKey: "2",
      summary: "new",
    });
  });

  test("ignores malformed records", () => {
    expect(
      restoreAutoSummaryState([
        {
          type: "custom",
          customType: AUTO_SUMMARY_ENTRY_TYPE,
          data: { version: 2, generations: 1, turnKey: "1", summary: "x" },
        },
        {
          type: "custom",
          customType: AUTO_SUMMARY_ENTRY_TYPE,
          data: { version: 1, generations: "1", turnKey: "1" },
        },
      ]),
    ).toBeNull();
  });
});

describe("shouldSummarize", () => {
  test("generates until the limit, once per turn", () => {
    expect(shouldSummarize(null, "1")).toBe(true);

    const first = {
      version: 1 as const,
      generations: 1,
      turnKey: "1",
      summary: "first",
    };
    expect(shouldSummarize(first, "1")).toBe(false);
    expect(shouldSummarize(first, "2")).toBe(true);

    expect(
      shouldSummarize(
        { ...first, generations: AUTO_SUMMARY_LIMIT, turnKey: "3" },
        "4",
      ),
    ).toBe(false);
  });
});

describe("buildSummaryInput", () => {
  test("includes the previous summary and omits an empty reply", () => {
    const exchange = { turnKey: "1", request: "do the thing", response: "" };

    expect(buildSummaryInput(exchange, "earlier summary")).toBe(
      "Previous summary:\nearlier summary\n\nLatest request:\ndo the thing",
    );
    expect(buildSummaryInput({ ...exchange, response: "did it" }, null)).toBe(
      "Latest request:\ndo the thing\n\nLatest response:\ndid it",
    );
  });
});
