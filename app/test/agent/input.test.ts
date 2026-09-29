// Real input to a page one sequence at a time: the presence keeper of the loop and a click of the call watch never mix
// their mouse moves and keys, and a sequence that fails leaves the next one free to run.
import { describe, expect, it } from "vitest";
import { asAgent, byAgent, TAIL_MS, withInput } from "@/agent/teams/input";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withInput", () => {
  it("runs the sequences of one page one after the other, in the order they came", async () => {
    const page = {};
    const steps: string[] = [];
    const seq = (name: string) => async () => {
      steps.push(`${name}1`);
      await tick();
      steps.push(`${name}2`);
      return name;
    };
    expect(await Promise.all([withInput(page, seq("a")), withInput(page, seq("b"))])).toEqual(["a", "b"]);
    expect(steps).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("lets two pages run at once", async () => {
    const steps: string[] = [];
    const seq = (name: string) => async () => {
      steps.push(`${name}1`);
      await tick();
      steps.push(`${name}2`);
    };
    await Promise.all([withInput({}, seq("a")), withInput({}, seq("b"))]);
    expect(steps.slice(0, 2).sort()).toEqual(["a1", "b1"]);
  });

  it("goes on after a sequence that failed", async () => {
    const page = {};
    await expect(withInput(page, async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
    expect(await withInput(page, async () => "next")).toBe("next");
  });
});

// The page sees the agent's own CDP input as trusted input, as the owner's: input while the agent runs something that
// sends input, or shortly after, is the agent's
describe("the agent's own input", () => {
  it("is the input of its spans and of the second after each, on that page only", async () => {
    const page = {};
    let inside = 0;
    expect(await asAgent(page, async () => {
      inside = Date.now();
      await tick();
      return "done";
    })).toBe("done");
    const end = Date.now();
    expect(byAgent(page, inside)).toBe(true);
    expect(byAgent(page, end + TAIL_MS - 5)).toBe(true);
    expect(byAgent(page, end + TAIL_MS + 5)).toBe(false);
    expect(byAgent(page, inside - 1000)).toBe(false);
    expect(byAgent({}, inside)).toBe(false);
  });

  it("covers a span still running, a span that failed, and the sequences of withInput", async () => {
    const page = {};
    let during = 0;
    const running = asAgent(page, async () => {
      during = Date.now();
      await new Promise((r) => setTimeout(r, 50));
    });
    await tick();
    expect(byAgent(page, Date.now())).toBe(true);
    await running;
    expect(byAgent(page, during)).toBe(true);
    const other = {};
    let failedAt = 0;
    await expect(asAgent(other, async () => {
      failedAt = Date.now();
      throw new Error("gone");
    })).rejects.toThrow("gone");
    expect(byAgent(other, failedAt)).toBe(true);
    const third = {};
    let keyAt = 0;
    await withInput(third, async () => {
      keyAt = Date.now();
    });
    expect(byAgent(third, keyAt)).toBe(true);
  });
});
