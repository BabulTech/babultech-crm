import { describe, expect, it } from "vitest";
import { envKeys, parseEnvFile } from "./env-file";

describe("parseEnvFile", () => {
  it("reads variables, skipping comments and blank lines", () => {
    const { variables, invalidLines } = parseEnvFile("# top\nA=1\n\nexport B = two\nC=\"x = y\"\nD='q'\nE=\nnot a var\r\n=nokey");
    expect(variables.map((v) => [v.key, v.value])).toEqual([["A", "1"], ["B", "two"], ["C", "x = y"], ["D", "q"], ["E", ""]]);
    expect(invalidLines).toEqual([8, 9]);
  });

  it("lists each name once, in file order", () => {
    expect(envKeys("B=1\nA=2\nB=3")).toEqual(["B", "A"]);
  });
});
