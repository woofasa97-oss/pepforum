import { describe, expect, it } from "vitest";
import { PostgresRepo } from "./repo.ts";
import { isTransientDbError, withRetry } from "./retry.ts";

const transient = (message = "read ETIMEDOUT", code = "ETIMEDOUT") => Object.assign(new Error(message), { code });
const noSleep = async () => {};

describe("withRetry — one more try for a dropped connection, and only for that", () => {
  it("repeats a statement once after a connection-class failure", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      if (++calls === 1) throw transient();
      return "ok";
    }, { sleep: noSleep });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up after the one retry and throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw transient(`read ETIMEDOUT #${calls}`);
      }, { sleep: noSleep }),
    ).rejects.toThrow("#2");
    expect(calls).toBe(2);
  });

  it("never repeats a statement the database answered: a constraint violation is not a blip", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }, { sleep: noSleep }),
    ).rejects.toThrow("duplicate key");
    expect(calls).toBe(1);
  });

  it("waits before trying again", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      if (++calls === 1) throw transient("write ECONNRESET", "ECONNRESET");
    }, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([500]);
  });

  it("recognises connection-class errors by code or message, and nothing else", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "EPIPE", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"]) {
      expect(isTransientDbError(Object.assign(new Error("x"), { code })), code).toBe(true);
    }
    expect(isTransientDbError(new Error("read ETIMEDOUT"))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("permission denied for table offers"), { code: "42501" }))).toBe(false);
    expect(isTransientDbError(new Error("canceling statement due to statement timeout"))).toBe(false);
    expect(isTransientDbError("ETIMEDOUT")).toBe(false);
  });
});

describe("PostgresRepo — which statements get the second try", () => {
  /** A stand-in for the `sql` tag: fails the first call with a dropped connection, then answers. */
  const flaky = (answer: unknown) => {
    const state = { calls: 0 };
    const tag = () => (++state.calls === 1 ? Promise.reject(transient()) : Promise.resolve(answer));
    return { state, tag };
  };
  const repoWith = (tag: unknown): PostgresRepo => {
    const repo = new PostgresRepo("postgresql://nobody@127.0.0.1:1/none", { sleep: noSleep });
    Object.defineProperty(repo, "sql", { value: tag });
    return repo;
  };

  it("a read is repeated", async () => {
    const { state, tag } = flaky([]);
    expect(await repoWith(tag).listCompounds()).toEqual([]);
    expect(state.calls).toBe(2);
  });

  it("claiming an attempt IS repeated — with the same client-made id, so a second insert cannot be a second ledger row", async () => {
    const ids: unknown[] = [];
    let calls = 0;
    const tag = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      ids.push(values[0]);
      return ++calls === 1 ? Promise.reject(transient()) : Promise.resolve([]);
    };
    const id = await repoWith(tag).claimAttempt({ run_id: "r", vendor_id: "v" });
    expect(calls).toBe(2);
    expect(ids).toEqual([id, id]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appending observations is NOT repeated", async () => {
    const { state, tag } = flaky([]);
    const sql = Object.assign(tag, { json: (v: unknown) => v });
    const callable = Object.assign((...args: unknown[]) => (Array.isArray(args[0]) && "raw" in (args[0] as object) ? sql() : "fragment"), sql);
    await expect(repoWith(callable).insertObservations([{ vendor_id: "v", compound_id: "c", product_key: "k" } as never], { offerIds: new Map(), runLabel: "r" })).rejects.toThrow("ETIMEDOUT");
    expect(state.calls).toBe(1);
  });

  it("the quarantine move is NOT repeated", async () => {
    const { state, tag } = flaky([{ n: 1 }]);
    await expect(repoWith(tag).quarantine(["id-1"], "outlier", "run-1")).rejects.toThrow("ETIMEDOUT");
    expect(state.calls).toBe(1);
  });
});
