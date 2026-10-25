// The ledger over node:sqlite: the store the Node host runs on, and what a restart reads back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBudget } from "../../src/core/budget";
import { createKeepAlive } from "../../src/core/keepalive";
import { openLedger } from "../../src/core/ledger-store";
import { type NodeSqlStore, openSqlite } from "../../src/node/sqlite";

const opened: NodeSqlStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  opened.splice(0).forEach((sql) => sql.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-sqlite-"));
  dirs.push(dir);
  return join(dir, "data", "gateway.sqlite");
}

function open(path: string): NodeSqlStore {
  const sql = openSqlite(path);
  opened.push(sql);
  return sql;
}

test("exec returns the rows of a read or RETURNING, and nothing for other writes", () => {
  const sql = open(":memory:");
  expect(sql.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)")).toEqual([]);
  expect(sql.exec("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1)).toEqual([]);
  expect(sql.exec("INSERT INTO t (id, n) VALUES (?, ?) RETURNING n", "b", 2)).toEqual([{ n: 2 }]);
  expect(sql.exec("SELECT id, n FROM t ORDER BY id")).toEqual([
    { id: "a", n: 1 },
    { id: "b", n: 2 },
  ]);
  expect(sql.exec("SELECT MIN(n) AS low FROM t WHERE n > ?", 5)).toEqual([{ low: null }]);
});

test("a transaction lands whole or not at all", () => {
  const sql = open(":memory:");
  sql.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  sql.transaction(() => {
    sql.exec("INSERT INTO t (id) VALUES ('a')");
    sql.exec("INSERT INTO t (id) VALUES ('b')");
  });
  expect(() =>
    sql.transaction(() => {
      sql.exec("INSERT INTO t (id) VALUES ('c')");
      sql.exec("INSERT INTO t (id) VALUES ('a')"); // a duplicate key: the whole write goes
    })
  ).toThrow();
  expect(sql.exec("SELECT id FROM t ORDER BY id").map((row) => row.id)).toEqual(["a", "b"]);
});

test("the ledger in a file outlives the process: spend, limits, settings, pending calls, pings", () => {
  const path = scratchFile();
  const clock = Date.UTC(2026, 9, 15);
  const make = (sql: NodeSqlStore) =>
    createBudget({
      budgetUsd: 25,
      userBudgetUsd: 5,
      userBudgetPeriod: "month",
      ledger: openLedger(sql),
      fetchKeyUsage: async () => 100,
      now: () => clock,
      log: () => {},
    });
  const first = open(path);
  const budget = make(first);
  budget.record("s1", "u1", { cost: 1.25, input_tokens: 3 }, { id: "gen-1", model: "m" });
  budget.record("s1", "u1", { input_tokens: 2 }, { id: "gen-pending", model: "m" });
  budget.setLimit("u2", { blocked: true }, "admin-1");
  budget.setSettings({ monthly_budget_usd: 40 }, "admin-1");
  createKeepAlive({ sql: first, now: () => clock }).waiting(
    {
      sid: "s1",
      sub: "u1",
      model: "m",
      url: "https://openrouter.test/api/v1/messages",
      headers: {},
      body: "{}",
    },
    2
  );
  first.close();
  opened.splice(opened.indexOf(first), 1);

  const second = open(path);
  const restarted = make(second);
  expect(restarted.usageFor("u1")).toMatchObject({ spent_usd: 1.25, requests: 1 });
  expect(restarted.pendingRequests().map((call) => call.id)).toEqual(["gen-pending"]);
  expect(restarted.adminUser("u2").blocked).toBe(true);
  expect(restarted.adminSettings().monthly_budget_usd).toBe(40);
  const keepAlive = createKeepAlive({ sql: second, now: () => clock });
  expect(keepAlive.nextDueAt()).toBeGreaterThan(clock);
});
