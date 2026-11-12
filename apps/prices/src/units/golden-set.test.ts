// GUARD GOLDEN-SET GATE. Every fixture in golden-set.json is a real or historically observed
// input with its expected verdict; a guard edit that flips any of them fails the suite. To change
// a guard's behaviour legitimately, update the fixture IN THE SAME COMMIT with a note. Never
// delete an ESCAPE-tagged fixture. The `classify` and `product-match` guards are wired up when
// the gate and reconcile modules exist (Phase B1 Task 9); until then those fixtures are skipped
// by name so their count stays visible.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalVialMg } from "./canonical-unit.ts";
import { isBlendProduct } from "./blend.ts";

interface Fixture {
  id: string;
  guard: "blend" | "canonical-unit" | "classify" | "product-match";
  input: unknown;
  expect: unknown;
  note?: string;
}

const { fixtures } = JSON.parse(readFileSync(new URL("./golden-set.json", import.meta.url), "utf8")) as {
  fixtures: Fixture[];
};

const WIRED: ReadonlySet<Fixture["guard"]> = new Set(["blend", "canonical-unit"]);

function runGuard(f: Fixture): unknown {
  switch (f.guard) {
    case "blend":
      return isBlendProduct(f.input as string);
    case "canonical-unit": {
      const r = canonicalVialMg(f.input as string) as unknown as Record<string, unknown>;
      // Compare only the keys the fixture pins, so additive result fields don't break the set.
      const exp = f.expect as Record<string, unknown>;
      return Object.fromEntries(Object.keys(exp).map((k) => [k, r[k] ?? null]));
    }
    default:
      throw new Error(`guard ${f.guard} is not wired yet`);
  }
}

describe("guard golden-set (regression gate)", () => {
  const byGuard = new Map<Fixture["guard"], Fixture[]>();
  for (const f of fixtures) {
    const list = byGuard.get(f.guard) ?? [];
    list.push(f);
    byGuard.set(f.guard, list);
  }
  for (const [guard, list] of byGuard) {
    describe(guard, () => {
      for (const f of list) {
        if (WIRED.has(guard)) it(f.id, () => expect(runGuard(f)).toEqual(f.expect));
        else it.skip(f.id, () => {});
      }
    });
  }

  it("keeps every historical blend escape in the set", () => {
    const escapes = fixtures.filter((f) => f.guard === "blend" && f.id.includes("ESCAPE"));
    expect(escapes.length).toBeGreaterThanOrEqual(2);
  });

  it("holds all four guards' fixtures, wired or not", () => {
    expect([...byGuard.keys()].sort()).toEqual(["blend", "canonical-unit", "classify", "product-match"]);
  });
});
