import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeInvalid, fieldLabel } from "@/lib/form-errors";

const schema = z.object({
  name: z.string().min(1),
  service: z.string(),
  ownerUserId: z.string().uuid(),
  email: z.string().email(),
  rotationDays: z.coerce.number().int().positive(),
  custom: z.string().min(3, "Write at least three letters."),
});

describe("validation messages", () => {
  it("lists the missing fields by name, then anything else wrong", () => {
    const result = schema.safeParse({ name: "", ownerUserId: "", email: "nope", rotationDays: -1, custom: "ab" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeInvalid(result.error)).toBe(
      "Please fill in: Name, Service, Owner. Email: enter a valid email address. Rotation days must be more than 0. Write at least three letters.",
    );
    expect(result.error.flatten().fieldErrors.name).toEqual(["Name is required."]);
  });

  it("names fields from their keys", () => {
    expect(fieldLabel(["projectManagerId"])).toBe("Project manager");
    expect(fieldLabel(["lines", 0, "hours"])).toBe("Hours");
  });
});
