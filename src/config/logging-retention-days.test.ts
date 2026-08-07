// Covers logging retention-days config validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.retentionDays config", () => {
  it("accepts a positive retentionDays", () => {
    const res = validateConfigObject({
      logging: {
        retentionDays: 14,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-positive retentionDays", () => {
    const res = validateConfigObject({
      logging: {
        retentionDays: 0,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([
        {
          path: "logging.retentionDays",
          message: "Too small: expected number to be >0 (must be greater than 0)",
        },
      ]);
    }
  });
});
