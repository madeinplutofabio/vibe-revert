// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  findSentinelBlock,
  removeSentinelBlock,
  renderSentinelBlock,
  replaceOrAppendSentinelBlock,
  SENTINEL_BEGIN_PREFIX,
  SENTINEL_END_PREFIX,
  type SentinelAnchor,
} from "../src/sentinel.js";

describe("sentinel constants", () => {
  it("SENTINEL_BEGIN_PREFIX is the locked string", () => {
    expect(SENTINEL_BEGIN_PREFIX).toBe("# viberevert:begin:");
  });

  it("SENTINEL_END_PREFIX is the locked string", () => {
    expect(SENTINEL_END_PREFIX).toBe("# viberevert:end:");
  });
});

describe("renderSentinelBlock", () => {
  it("wraps content in BEGIN/END markers with LF separators", () => {
    const out = renderSentinelBlock("test-id", "hello\nworld");
    expect(out).toBe("# viberevert:begin:test-id\nhello\nworld\n# viberevert:end:test-id\n");
  });

  it("normalizes a single trailing newline on content", () => {
    expect(renderSentinelBlock("id", "x\n")).toBe(renderSentinelBlock("id", "x"));
  });

  it("normalizes multiple trailing newlines on content", () => {
    expect(renderSentinelBlock("id", "x\n\n\n")).toBe(renderSentinelBlock("id", "x"));
  });

  it("handles empty content", () => {
    expect(renderSentinelBlock("id", "")).toBe("# viberevert:begin:id\n\n# viberevert:end:id\n");
  });

  it("always ends with a trailing newline", () => {
    expect(renderSentinelBlock("id", "content").endsWith("\n")).toBe(true);
    expect(renderSentinelBlock("id", "").endsWith("\n")).toBe(true);
  });
});

describe("findSentinelBlock", () => {
  it("locates a complete block and returns the removable string range and interior content", () => {
    const haystack = "before\n# viberevert:begin:foo\ninner\n# viberevert:end:foo\nafter\n";
    const found = findSentinelBlock(haystack, "foo");
    expect(found).not.toBeNull();
    if (found === null) return;
    expect(haystack.slice(found.start, found.end)).toBe(
      "# viberevert:begin:foo\ninner\n# viberevert:end:foo\n",
    );
    expect(found.content).toBe("inner");
  });

  it("returns null when blockId is absent", () => {
    expect(findSentinelBlock("nothing here\n", "foo")).toBeNull();
  });

  it("returns null on orphan BEGIN without matching END", () => {
    expect(findSentinelBlock("# viberevert:begin:foo\ncontent\n", "foo")).toBeNull();
  });

  it("returns null on orphan END without preceding BEGIN", () => {
    expect(findSentinelBlock("# viberevert:end:foo\n", "foo")).toBeNull();
  });

  it("ignores BEGIN-marker-shaped substrings inside longer lines", () => {
    // The first BEGIN appears as a prefix of a longer line (with trailing
    // text) and must NOT match. The second, on its own line, is the real
    // marker.
    const haystack = [
      "# viberevert:begin:foo extra-text",
      "noise",
      "# viberevert:begin:foo",
      "real-inner",
      "# viberevert:end:foo",
      "",
    ].join("\n");
    const found = findSentinelBlock(haystack, "foo");
    expect(found?.content).toBe("real-inner");
  });

  it("ignores END-marker-shaped substrings inside longer lines", () => {
    // The first END appears as a prefix of a longer line and must NOT
    // close the block. The block stays open until the real END marker
    // line, so the captured interior includes the fake-END line.
    const haystack = [
      "# viberevert:begin:foo",
      "real-inner",
      "# viberevert:end:foo extra-text",
      "more-noise",
      "# viberevert:end:foo",
      "",
    ].join("\n");
    const found = findSentinelBlock(haystack, "foo");
    expect(found?.content).toBe("real-inner\n# viberevert:end:foo extra-text\nmore-noise");
  });

  it("locates the first block when multiple BEGIN/END pairs share a blockId", () => {
    const haystack = [
      "# viberevert:begin:foo",
      "first",
      "# viberevert:end:foo",
      "# viberevert:begin:foo",
      "second",
      "# viberevert:end:foo",
      "",
    ].join("\n");
    const found = findSentinelBlock(haystack, "foo");
    expect(found?.content).toBe("first");
  });

  it("distinguishes blocks by blockId", () => {
    const haystack = [
      "# viberevert:begin:alpha",
      "one",
      "# viberevert:end:alpha",
      "# viberevert:begin:beta",
      "two",
      "# viberevert:end:beta",
      "",
    ].join("\n");
    expect(findSentinelBlock(haystack, "alpha")?.content).toBe("one");
    expect(findSentinelBlock(haystack, "beta")?.content).toBe("two");
    expect(findSentinelBlock(haystack, "gamma")).toBeNull();
  });
});

describe("replaceOrAppendSentinelBlock", () => {
  const appendAnchor: SentinelAnchor = { mode: "append" };

  it("appends a new block to existing content with trailing newline", () => {
    const out = replaceOrAppendSentinelBlock("existing\n", "foo", "new", appendAnchor);
    expect(out).toBe("existing\n# viberevert:begin:foo\nnew\n# viberevert:end:foo\n");
  });

  it("inserts a separating newline when existing lacks a trailing newline", () => {
    const out = replaceOrAppendSentinelBlock("existing", "foo", "new", appendAnchor);
    expect(out).toBe("existing\n# viberevert:begin:foo\nnew\n# viberevert:end:foo\n");
  });

  it("does not add a leading newline when existing is empty", () => {
    const out = replaceOrAppendSentinelBlock("", "foo", "new", appendAnchor);
    expect(out).toBe("# viberevert:begin:foo\nnew\n# viberevert:end:foo\n");
  });

  it("replaces an existing block's content in place, preserving surrounding text", () => {
    const before = "header\n# viberevert:begin:foo\nold\n# viberevert:end:foo\nfooter\n";
    const out = replaceOrAppendSentinelBlock(before, "foo", "new", appendAnchor);
    expect(out).toBe("header\n# viberevert:begin:foo\nnew\n# viberevert:end:foo\nfooter\n");
  });

  it("inserts immediately after the marker line when anchor.mode === 'after-marker'", () => {
    const before = "line-1\ncommands:\nline-3\n";
    const anchor: SentinelAnchor = { mode: "after-marker", marker: "commands:" };
    const out = replaceOrAppendSentinelBlock(before, "foo", "x", anchor);
    expect(out).toBe(
      "line-1\ncommands:\n# viberevert:begin:foo\nx\n# viberevert:end:foo\nline-3\n",
    );
  });

  it("degrades to append when after-marker's marker line is absent", () => {
    const anchor: SentinelAnchor = { mode: "after-marker", marker: "missing:" };
    const out = replaceOrAppendSentinelBlock("no-marker-here\n", "foo", "x", anchor);
    expect(out).toBe("no-marker-here\n# viberevert:begin:foo\nx\n# viberevert:end:foo\n");
  });

  it("after-marker does not match substring-shaped lines and degrades to append", () => {
    // "commands: extra" contains "commands:" as a prefix but is NOT a
    // whole-line match. Insertion must NOT happen after that line; the
    // helper degrades to append at end of input. Catches future "helpful"
    // fuzzy marker matching.
    const anchor: SentinelAnchor = { mode: "after-marker", marker: "commands:" };
    const out = replaceOrAppendSentinelBlock(
      "before\ncommands: extra\nafter\n",
      "foo",
      "x",
      anchor,
    );
    expect(out).toBe(
      "before\ncommands: extra\nafter\n# viberevert:begin:foo\nx\n# viberevert:end:foo\n",
    );
  });
});

describe("removeSentinelBlock", () => {
  it("removes the block and leaves surrounding content intact", () => {
    const before = "header\n# viberevert:begin:foo\ninner\n# viberevert:end:foo\nfooter\n";
    expect(removeSentinelBlock(before, "foo")).toBe("header\nfooter\n");
  });

  it("returns existing unchanged when block is absent (idempotent)", () => {
    expect(removeSentinelBlock("just text\n", "foo")).toBe("just text\n");
  });

  it("removing twice equals removing once", () => {
    const before = "a\n# viberevert:begin:foo\nx\n# viberevert:end:foo\nb\n";
    const once = removeSentinelBlock(before, "foo");
    const twice = removeSentinelBlock(once, "foo");
    expect(twice).toBe(once);
  });
});

describe("round-trip: append -> find -> replace -> remove", () => {
  it("render -> find returns the same content the caller passed", () => {
    const content = "a\nb\nc";
    const block = renderSentinelBlock("foo", content);
    const found = findSentinelBlock(block, "foo");
    expect(found?.content).toBe(content);
  });

  it("full lifecycle restores the original surrounding text exactly", () => {
    const original = "user content\n";
    const appendAnchor: SentinelAnchor = { mode: "append" };
    let s = original;
    s = replaceOrAppendSentinelBlock(s, "foo", "v1", appendAnchor);
    expect(findSentinelBlock(s, "foo")?.content).toBe("v1");
    s = replaceOrAppendSentinelBlock(s, "foo", "v2", appendAnchor);
    expect(findSentinelBlock(s, "foo")?.content).toBe("v2");
    s = removeSentinelBlock(s, "foo");
    expect(findSentinelBlock(s, "foo")).toBeNull();
    expect(s).toBe(original);
  });

  it("preserves non-ASCII content exactly across render / find / remove", () => {
    // Mix of multi-code-unit UTF-16 (emoji = surrogate pair), non-ASCII
    // text (é / ñ), and a Unicode escape that resolves to é. The helpers
    // must treat the input as opaque JavaScript strings and never mangle
    // code units.
    const content = "café 🚀 é";
    const block = renderSentinelBlock("foo", content);
    const found = findSentinelBlock(block, "foo");
    expect(found?.content).toBe(content);

    const surrounding = `before 🎉\n${block}after ñ\n`;
    expect(removeSentinelBlock(surrounding, "foo")).toBe("before 🎉\nafter ñ\n");
  });
});
