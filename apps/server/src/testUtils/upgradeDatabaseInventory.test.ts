// @effect-diagnostics nodeBuiltinImport:off -- These tests own disposable SQLite fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";

import { inventoryUpgradeDatabase } from "./prepareUpgradeSnapshot.ts";

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upgrade-inventory-"));
  return {
    filename: NodePath.join(root, "statev2.sqlite"),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("compares the same row multiset regardless of insertion order", () => {
  using first = fixture();
  using second = fixture();
  for (const [filename, reverse] of [
    [first.filename, false],
    [second.filename, true],
  ] as const) {
    const db = new NodeSqlite.DatabaseSync(filename);
    try {
      db.exec("CREATE TABLE records (value); CREATE TABLE custom_migrations (id INTEGER)");
      const insert = db.prepare("INSERT INTO records VALUES (?)");
      const values = ["z", "a", "a", null, 1, Infinity, -Infinity, new Uint8Array([0, 255])];
      for (const value of reverse ? values.toReversed() : values) insert.run(value);
    } finally {
      db.close();
    }
  }
  const inventory = inventoryUpgradeDatabase(first.filename);
  expect(inventory).toEqual(inventoryUpgradeDatabase(second.filename));
  expect(inventory.contents.map(({ name, count }) => ({ name, count }))).toEqual([
    { name: "custom_migrations", count: 0 },
    { name: "records", count: 8 },
  ]);
  expect(inventory.ledgers).toEqual([inventory.contents[0]]);
});

it("preserves exact 64-bit integers and distinguishes them from text", () => {
  using source = fixture();
  const db = new NodeSqlite.DatabaseSync(source.filename);
  try {
    db.exec("CREATE TABLE records (value)");
    const insert = db.prepare("INSERT INTO records VALUES (?)");
    const digests = [];
    for (const value of [9223372036854775807n, 9223372036854775806n, "9223372036854775807"]) {
      db.exec("DELETE FROM records");
      insert.run(value);
      digests.push(inventoryUpgradeDatabase(source.filename).contents[0]?.digest);
    }
    expect(new Set(digests).size).toBe(3);
  } finally {
    db.close();
  }
});

it("counts duplicate rows in the digest rather than cancelling equal pairs", () => {
  using source = fixture();
  const db = new NodeSqlite.DatabaseSync(source.filename);
  try {
    db.exec("CREATE TABLE records (value); INSERT INTO records VALUES ('same')");
    const once = inventoryUpgradeDatabase(source.filename).contents[0];
    db.exec("INSERT INTO records VALUES ('same'), ('same')");
    const thrice = inventoryUpgradeDatabase(source.filename).contents[0];
    expect(once?.count).toBe(1);
    expect(thrice?.count).toBe(3);
    expect(once?.digest).not.toBe(thrice?.digest);
    db.exec("DELETE FROM records; INSERT INTO records VALUES ('same'), ('same')");
    const samePair = inventoryUpgradeDatabase(source.filename).contents[0];
    db.exec("DELETE FROM records; INSERT INTO records VALUES ('other'), ('other')");
    const otherPair = inventoryUpgradeDatabase(source.filename).contents[0];
    expect(samePair?.count).toBe(otherPair?.count);
    expect(samePair?.digest).not.toBe(otherPair?.digest);
  } finally {
    db.close();
  }
});

it("distinguishes SQLite storage types including empty text and blobs", () => {
  using source = fixture();
  const db = new NodeSqlite.DatabaseSync(source.filename);
  try {
    db.exec("CREATE TABLE records (value)");
    const insert = db.prepare("INSERT INTO records VALUES (?)");
    const digests = [];
    for (const value of [1n, 1, "1", null, "", new Uint8Array()]) {
      db.exec("DELETE FROM records");
      insert.run(value);
      digests.push(inventoryUpgradeDatabase(source.filename).contents[0]?.digest);
    }
    expect(new Set(digests).size).toBe(6);
  } finally {
    db.close();
  }
});

it("distinguishes positive and negative infinity REALs from SQL NULL", () => {
  using source = fixture();
  const db = new NodeSqlite.DatabaseSync(source.filename);
  try {
    db.exec("CREATE TABLE records (value)");
    const insert = db.prepare("INSERT INTO records VALUES (?)");
    const digests = [];
    for (const value of [Infinity, -Infinity, null]) {
      db.exec("DELETE FROM records");
      insert.run(value);
      expect(db.prepare("SELECT typeof(value) AS storage_type FROM records").get()).toEqual({
        storage_type: value === null ? "null" : "real",
      });
      digests.push(inventoryUpgradeDatabase(source.filename).contents[0]?.digest);
    }
    expect(new Set(digests).size).toBe(3);
  } finally {
    db.close();
  }
});

it("includes every column and distant parts of substantial text and blob payloads", () => {
  using source = fixture();
  const db = new NodeSqlite.DatabaseSync(source.filename);
  try {
    db.exec("CREATE TABLE records (integer_value, real_value, text_value, blob_value, nullable)");
    const text = "a".repeat(256 * 1024);
    const blob = new Uint8Array(256 * 1024).fill(127);
    const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?)");
    insert.run(7n, 1.5, text, blob, null);
    const original = inventoryUpgradeDatabase(source.filename).contents[0]?.digest;
    const changed = [
      [8n, 1.5, text, blob, null],
      [7n, 1.75, text, blob, null],
      [7n, 1.5, text, blob, "present"],
      ...[0, 128 * 1024, text.length - 1].map((offset) => [
        7n,
        1.5,
        `${text.slice(0, offset)}b${text.slice(offset + 1)}`,
        blob,
        null,
      ]),
      ...[0, 128 * 1024, blob.length - 1].map((offset) => {
        const modified = blob.slice();
        modified[offset] = 128;
        return [7n, 1.5, text, modified, null];
      }),
    ];
    for (const values of changed) {
      db.exec("DELETE FROM records");
      insert.run(...values);
      expect(inventoryUpgradeDatabase(source.filename).contents[0]?.digest).not.toBe(original);
    }
  } finally {
    db.close();
  }
});
