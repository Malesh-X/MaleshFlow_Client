import test from "node:test";
import assert from "node:assert/strict";
import { applyLinkPasteOverSelection } from "../lib/domain/links";

const NODE = "k17e2ywyk102hrq9bx9pn0eqk98gc42c";
const NODE_LINK = `[[node:${NODE}?hidetags]]`;

function paste(text: string, selected: string, clipboard: string) {
  const start = text.indexOf(selected);
  assert.notEqual(start, -1);
  return applyLinkPasteOverSelection(text, start, start + selected.length, clipboard);
}

test("pasting a node link over a selection uses the selection as its label", () => {
  const result = paste("a test b", "test", NODE_LINK);
  assert.equal(result?.value, `a [[test|node:${NODE}?hidetags]] b`);
  assert.equal(result?.linkKind, "node");
  const end = `a [[test|node:${NODE}?hidetags]]`.length;
  assert.equal(result?.selectionStart, end);
  assert.equal(result?.selectionEnd, end);
});

test("link paste keeps every option and trims the clipboard", () => {
  assert.equal(
    paste("test", "test", `  [[node:${NODE}?hidetags&showchildren]]\n`)?.value,
    `[[test|node:${NODE}?hidetags&showchildren]]`,
  );
  assert.equal(
    paste("test", "test", `[[node:${NODE}]]?showparent`)?.value,
    `[[test|node:${NODE}]]?showparent`,
  );
});

test("link paste replaces a label the copied link already has", () => {
  assert.equal(
    paste("test", "test", `[[Old label|node:${NODE}?hidetags]]`)?.value,
    `[[test|node:${NODE}?hidetags]]`,
  );
});

test("link paste keeps whitespace around the selection outside the link", () => {
  assert.equal(
    paste("a test b", "test ", NODE_LINK)?.value,
    `a [[test|node:${NODE}?hidetags]] b`,
  );
  assert.equal(
    paste("a  test  b", " test ", NODE_LINK)?.value,
    `a  [[test|node:${NODE}?hidetags]]  b`,
  );
});

test("link paste works for bare node refs, (( )) node refs and page links", () => {
  assert.equal(paste("test", "test", `[[${NODE}?hidetags]]`)?.value, `[[test|node:${NODE}?hidetags]]`);
  assert.equal(paste("test", "test", `((${NODE}))`)?.value, `[[test|node:${NODE}]]`);
  const page = paste("test", "test", "[[page:abc123]]");
  assert.equal(page?.value, "[[test|page:abc123]]");
  assert.equal(page?.linkKind, "page");
  assert.equal(
    paste("test", "test", "[[Old|page:abc123?showchildren]]")?.value,
    "[[test|page:abc123?showchildren]]",
  );
});

test("link paste falls back to a normal paste", () => {
  // Nothing selected, or only whitespace.
  assert.equal(applyLinkPasteOverSelection("a test", 2, 2, NODE_LINK), null);
  assert.equal(paste("a   b", "   ", NODE_LINK), null);
  // Clipboard is not exactly one node or page link.
  assert.equal(paste("test", "test", "plain text"), null);
  assert.equal(paste("test", "test", `${NODE_LINK} more`), null);
  assert.equal(paste("test", "test", `${NODE_LINK} ${NODE_LINK}`), null);
  assert.equal(paste("test", "test", `${NODE_LINK}\n${NODE_LINK}`), null);
  assert.equal(paste("test", "test", "[[Some page]]"), null);
  assert.equal(paste("test", "test", "https://example.com"), null);
  assert.equal(paste("test", "test", "[x](https://example.com)"), null);
  // Selection spans a newline.
  assert.equal(paste("one\ntwo", "one\ntwo", NODE_LINK), null);
  // Selection holds link syntax or overlaps an existing link.
  assert.equal(paste("a [[b]] c", "a [[b]] c", NODE_LINK), null);
  assert.equal(paste("x [[Page]] y", "Pa", NODE_LINK), null);
  assert.equal(paste("x [[Page]] y", "x [[", NODE_LINK), null);
  assert.equal(paste("see example.com now", "example", NODE_LINK), null);
  // Characters the label syntax can't hold.
  assert.equal(paste("a|b", "a|b", NODE_LINK), null);
  assert.equal(paste("a]b", "a]b", NODE_LINK), null);
  assert.equal(paste("a[b", "a[b", NODE_LINK), null);
});
