import { describe, expect, it } from "vitest";
import { queryResultsCsv } from "../src/features/explore/queryResults";

describe("query result downloads", () => {
  it("preserves column order, Unicode, quotes, commas, multiline literals and unbound values", () => {
    expect(queryResultsCsv(["label", "value", "unbound"], [{ value: 'a,b\n"quoted"', label: "Mätning" }])).toBe(
      '\uFEFF"label","value","unbound"\r\n"Mätning","a,b\n""quoted""",""',
    );
  });
  it("exports formula-like graph literals as spreadsheet text", () => {
    expect(queryResultsCsv(["value"], [{ value: "=1+1" }, { value: " @SUM(1)" }, { value: "-2" }, { value: "https://example.com" }])).toBe(
      '\uFEFF"value"\r\n"\'=1+1"\r\n"\' @SUM(1)"\r\n"\'-2"\r\n"https://example.com"',
    );
  });
});
