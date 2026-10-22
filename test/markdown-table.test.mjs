import test from "node:test";
import assert from "node:assert/strict";
import { markdownLanguage } from "@codemirror/lang-markdown";
import {
  createMarkdownTable,
  parseMarkdownTable,
} from "../src/markdown-table.ts";

test("table cell targets retain offsets and escaped pipes", () => {
  const source = "| Name | Note |\n| :--- | ---: |\n| Ada | one \\| two |";
  const table = parseMarkdownTable(source, 20);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows[1][1].text, "one | two");
  const cell = table.rows[1][1];
  assert.equal(source.slice(cell.from - 20, cell.to - 20), "one \\| two");
});

test("a column without colons starts where its text starts, so Hebrew cells align right", () => {
  const table = parseMarkdownTable("| שם | Name | Note |\n| --- | :--- | :---: |\n| דנה | Ada | x |");
  assert.deepEqual(table.align, ["start", "left", "center"]);
});

test("empty cells and missing trailing cells stay addressable", () => {
  const table = parseMarkdownTable(
    "| A | B |\n| --- | :---: |\n|   | ok |\n| only |",
  );
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[1][0].text, "");
  assert.equal(table.rows[2][1].text, "");
  assert.equal(table.align[1], "center");
  for (const row of table.rows)
    for (const cell of row) assert.ok(cell.from <= cell.to);
});

test("supports tables without outer pipes and rejects malformed separators", () => {
  assert.deepEqual(
    parseMarkdownTable("Name | Value\n--- | ---\nA | B").rows.map((r) =>
      r.map((c) => c.text),
    ),
    [
      ["Name", "Value"],
      ["A", "B"],
    ],
  );
  assert.equal(parseMarkdownTable("Name | Value\nnot | a separator"), null);
  assert.equal(parseMarkdownTable("Name | Value\n---"), null);
});

test("picker dimensions produce valid Markdown including a header-only table", () => {
  for (const [rows, columns] of [
    [1, 1],
    [3, 4],
    [6, 8],
  ]) {
    const parsed = parseMarkdownTable(createMarkdownTable(rows, columns));
    assert.equal(parsed.rows.length, rows);
    assert.ok(parsed.rows.every((row) => row.length === columns));
    const nodes = [];
    markdownLanguage.parser.parse(createMarkdownTable(rows, columns)).iterate({
      enter(node) { nodes.push(node.name); },
    });
    assert.equal(nodes.filter((name) => name === "Table").length, 1);
    // Lezer omits empty body-cell nodes, but retains each body row.
    assert.equal(nodes.filter((name) => name === "TableCell").length, columns);
    assert.equal(nodes.filter((name) => name === "TableRow").length, rows - 1);
  }
});
