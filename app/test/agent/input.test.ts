// Real input to a page one sequence at a time: the presence keeper of the loop and a click of the call watch never mix
// their mouse moves and keys, and a sequence that fails leaves the next one free to run.
import { describe, expect, it } from "vitest";
import { withInput } from "@/agent/teams/input";

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
