import test from "node:test";
import assert from "node:assert/strict";
import { collectLinkTargetIds, linkLookup, renderLinks, toStoredLinkText, type LinkTargets } from "../scripts/flowLinks";

const NODE = "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GONE = "k17bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET = "k17ccccccccccccccccccccccccccccc";
const OLD = "k17ddddddddddddddddddddddddddddd";
const PAGE = "k57eeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HIDDEN_PAGE = "k57fffffffffffffffffffffffffffff";

const targets: LinkTargets = {
  nodes: [
    { id: NODE, found: true, hidden: false, archived: false, pageId: PAGE, text: "Dentist appointment #health" },
    { id: GONE, found: false, hidden: false, archived: false, pageId: null, text: null },
    { id: SECRET, found: true, hidden: true, archived: false, pageId: null, text: null },
    { id: OLD, found: true, hidden: false, archived: true, pageId: PAGE, text: "Old plan" },
  ],
  pages: [
    { id: PAGE, found: true, hidden: false, archived: false, title: "Health" },
    { id: HIDDEN_PAGE, found: true, hidden: true, archived: false, title: null },
  ],
};
const lookup = linkLookup(targets);
const show = (text: string) => renderLinks(text, lookup).displayText;

test("collects node and page ids from every link form", () => {
  const ids = collectLinkTargetIds([
    `a [[node:${NODE}]] b ((${GONE})) [[${SECRET}]]`,
    `[[Label|page:${PAGE}]] [[Page Title]] https://example.com [x](https://y.z)`,
  ]);
  assert.deepEqual(ids, { nodeIds: [NODE, GONE, SECRET], pageIds: [PAGE] });
});

test("renders each link kind", () => {
  assert.equal(show(`See [[node:${NODE}]] today`), `See [Dentist appointment #health](node:${NODE}) today`);
  assert.equal(show(`See ((${NODE}))`), `See [Dentist appointment #health](node:${NODE})`);
  assert.equal(show(`See [[${NODE}]]`), `See [Dentist appointment #health](node:${NODE})`);
  assert.equal(show(`On [[page:${PAGE}]]`), `On [Health](page:${PAGE})`);
  assert.equal(show(`[[Teeth|node:${NODE}]]`), `[Teeth → Dentist appointment #health](node:${NODE})`);
  assert.equal(show(`[[Topic|page:${PAGE}]]`), `[Topic → Health](page:${PAGE})`);
  assert.equal(show(`[[node:${NODE}?hidetags]]`), `[Dentist appointment #health](node:${NODE}?hidetags)`);
  assert.equal(show(`[[node:${NODE}]]?showparent?hidetags`), `[Dentist appointment #health](node:${NODE}?showparent&hidetags)`);
  assert.equal(show(`[[page:${PAGE}?showchildren]]`), `[Health](page:${PAGE}?showchildren)`);
  assert.equal(show(`[[node:${OLD}]]`), `[Old plan (archived)](node:${OLD})`);
  // Title links and external links stay as stored.
  assert.equal(show("[[Some Page]] and [docs](https://x.y)"), "[[Some Page]] and [docs](https://x.y)");
});

test("missing and hidden targets show no text", () => {
  assert.equal(show(`[[node:${GONE}]]`), `[(missing)](node:${GONE})`);
  assert.equal(show(`[[node:${SECRET}]]`), `[(hidden)](node:${SECRET})`);
  assert.equal(show(`[[Label|node:${SECRET}]]`), `[Label → (hidden)](node:${SECRET})`);
  assert.equal(show(`[[page:${HIDDEN_PAGE}]]`), `[(hidden)](page:${HIDDEN_PAGE})`);
  const { links } = renderLinks(`[[node:${SECRET}]] [[node:${GONE}]]`, lookup);
  assert.deepEqual(
    links.map((link) => [link.target, link.hidden, link.missing]),
    [
      [null, true, false],
      [null, false, true],
    ],
  );
});

test("long, linked and bracketed target text is shortened and escaped", () => {
  const long = "x".repeat(100);
  const many = linkLookup({ nodes: [{ id: NODE, found: true, hidden: false, archived: false, pageId: PAGE, text: `${long} [a] → b` }], pages: [] });
  const out = renderLinks(`[[node:${NODE}]]`, many).displayText;
  assert.equal(out, `[${"x".repeat(59)}…](node:${NODE})`);
  const nested = linkLookup({ nodes: [{ id: NODE, found: true, hidden: false, archived: false, pageId: PAGE, text: "[a] → b" }], pages: [] });
  assert.equal(renderLinks(`[[node:${NODE}]]`, nested).displayText, `[\\[a\\] -> b](node:${NODE})`);
});

test("links array keeps raw text, kind, id, label and options", () => {
  const { links } = renderLinks(`[[Teeth|node:${NODE}?hidetags]] [[page:${PAGE}]]`, lookup);
  assert.deepEqual(links, [
    { raw: `[[Teeth|node:${NODE}?hidetags]]`, kind: "node", id: NODE, label: "Teeth", options: ["hidetags"], target: "Dentist appointment #health", missing: false, hidden: false, archived: false },
    { raw: `[[page:${PAGE}]]`, kind: "page", id: PAGE, label: null, options: [], target: "Health", missing: false, hidden: false, archived: false },
  ]);
});

test("round trip: printed text written back stores exactly the original", () => {
  const originals = [
    `See [[node:${NODE}]] and ((${NODE})) and [[${NODE}]]`,
    `[[Teeth|node:${NODE}?hidetags]] then [[node:${NODE}]]?showparent?hidetags`,
    `[[Topic|page:${PAGE}]] [[page:${PAGE}?showchildren]] [[Some Page]]`,
    `[[node:${GONE}]] [[Label|node:${SECRET}]] [[node:${OLD}]]`,
    `plain [docs](https://x.y) #tag`,
    `odd [x](node:${NODE}) stored as an external link`,
  ];
  for (const original of originals) {
    assert.equal(toStoredLinkText(show(original), original), original);
  }
});

test("printed links in new text become stored links", () => {
  assert.equal(toStoredLinkText(`Call about [Dentist appointment](node:${NODE})`), `Call about [[node:${NODE}]]`);
  assert.equal(toStoredLinkText(`[Teeth → Dentist](node:${NODE}?hidetags)`), `[[Teeth|node:${NODE}?hidetags]]`);
  assert.equal(toStoredLinkText(`[Health](page:${PAGE}?showchildren)`), `[[page:${PAGE}?showchildren]]`);
  assert.equal(toStoredLinkText(`[(hidden)](node:${SECRET})`), `[[node:${SECRET}]]`);
  assert.equal(toStoredLinkText(`[A \\→ B → x](node:${NODE})`), `[[A → B|node:${NODE}]]`);
  // Edited text keeps the unchanged links' stored form and converts new ones.
  const original = `Before ((${NODE}))`;
  assert.equal(toStoredLinkText(`After [Dentist](node:${NODE}) and [Health](page:${PAGE})`, original), `After ((${NODE})) and [[page:${PAGE}]]`);
  // Stored syntax and other text pass through untouched.
  const stored = `[[node:${NODE}]] ((${NODE})) [docs](https://x.y)`;
  assert.equal(toStoredLinkText(stored), stored);
});

test("converted links parse back to the same targets", () => {
  for (const original of [`[[Teeth|node:${NODE}?hidetags]]`, `((${NODE}))`, `[[page:${PAGE}?showchildren]]`]) {
    const written = toStoredLinkText(show(original));
    const parsed = (text: string) => renderLinks(text, lookup).links.map((link) => [link.kind, link.id, link.label, link.options]);
    const before = parsed(original);
    const after = parsed(written);
    assert.deepEqual(after, before);
  }
});
