// How the Flow CLI prints node and page links (pure, unit tested).
//
// Stored links (`[[node:ID]]`, `((ID))`, `[[Label|node:ID?hidetags]]`,
// `[[page:ID]]`, ...) print in a readable form that keeps the id:
//
//   [target text](node:ID)            unlabeled link
//   [Label → target text](node:ID)    labeled link
//   [Page title](page:ID)             page link
//   [(missing)](node:ID)              target deleted or never existed
//   [(hidden)](node:ID)               target excluded from data dumps
//
// Options follow the id (`node:ID?hidetags`). Write commands turn this form
// back into stored link syntax (toStoredLinkText), so copying printed text
// into `add` or `update --text` keeps the link.
import {
  extractLinkMatches,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
  type ExtractedLinkMatch,
} from "../lib/domain/links";

export type NodeTarget = { id: string; found: boolean; hidden: boolean; archived: boolean; pageId: string | null; text: string | null };
export type PageTarget = { id: string; found: boolean; hidden: boolean; archived: boolean; title: string | null };
export type LinkTargets = { nodes: NodeTarget[]; pages: PageTarget[] };

export type DisplayLink = {
  raw: string;
  kind: "node" | "page";
  id: string;
  label: string | null;
  options: string[];
  // The target's text (node) or title (page); null when missing or hidden.
  target: string | null;
  missing: boolean;
  hidden: boolean;
  archived: boolean;
};

const TARGET_MAX_CHARS = 60;
const ARROW = " → ";

type IdLink = { start: number; end: number; raw: string; kind: "node" | "page"; id: string; label: string | null; options: string[] };

function optionsOf(match: ExtractedLinkMatch): string[] {
  const link = match.link;
  if (link.kind === "node") {
    return [
      ...(link.includeParent ? ["showparent"] : []),
      ...(link.hideTags ? ["hidetags"] : []),
      ...(link.showChildren ? ["showchildren"] : []),
    ];
  }
  return link.kind === "page" && link.showChildren ? ["showchildren"] : [];
}

// Node links and id-based page links, in text order, without overlaps.
// Title links (`[[Page Title]]`) and external links are left as stored.
function idLinks(text: string): IdLink[] {
  const result: IdLink[] = [];
  let cursor = 0;
  for (const match of extractLinkMatches(text)) {
    if (match.start < cursor) continue;
    const { link } = match;
    const id = link.kind === "node" ? link.targetNodeRef : link.kind === "page" ? link.targetPageRef : undefined;
    if (!id || link.kind === "external") continue;
    cursor = match.end;
    result.push({
      start: match.start,
      end: match.end,
      raw: text.slice(match.start, match.end),
      kind: link.kind,
      id,
      label: getExplicitWikiLinkPreviewText(link.label) || null,
      options: optionsOf(match),
    });
  }
  return result;
}

// Every node and page id linked from these texts, for one bulk lookup.
export function collectLinkTargetIds(texts: Iterable<string>) {
  const nodeIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const text of texts) {
    for (const link of idLinks(text)) (link.kind === "node" ? nodeIds : pageIds).add(link.id);
  }
  return { nodeIds: [...nodeIds], pageIds: [...pageIds] };
}

const escapeText = (value: string) => value.replace(/[\\[\]]/g, (char) => `\\${char}`);
const escapeLabel = (value: string) => escapeText(value).replace(/→/g, "\\→");

function shortTarget(value: string) {
  const flat = replaceLinkMarkupWithLabels(value).replace(/→/g, "->");
  if (!flat) return "(no text)";
  return flat.length > TARGET_MAX_CHARS ? `${flat.slice(0, TARGET_MAX_CHARS - 1).trimEnd()}…` : flat;
}

function suffix(link: { kind: string; id: string; options: string[] }) {
  return `${link.kind}:${link.id}${link.options.length ? `?${link.options.join("&")}` : ""}`;
}

export type LinkLookup = { nodes: Map<string, NodeTarget>; pages: Map<string, PageTarget> };

export function linkLookup(targets: LinkTargets): LinkLookup {
  return {
    nodes: new Map(targets.nodes.map((target) => [target.id, target])),
    pages: new Map(targets.pages.map((target) => [target.id, target])),
  };
}

// Readable text plus the links in it. Text outside links is unchanged.
export function renderLinks(text: string, lookup: LinkLookup): { displayText: string; links: DisplayLink[] } {
  const links: DisplayLink[] = [];
  let displayText = "";
  let cursor = 0;
  for (const link of idLinks(text)) {
    const target = link.kind === "node" ? lookup.nodes.get(link.id) : lookup.pages.get(link.id);
    const missing = !target || !target.found;
    const hidden = !missing && target!.hidden;
    const value = missing || hidden ? null : link.kind === "node" ? (target as NodeTarget).text : (target as PageTarget).title;
    const archived = !missing && !hidden && target!.archived;
    links.push({ raw: link.raw, kind: link.kind, id: link.id, label: link.label, options: link.options, target: value, missing, hidden, archived });

    const shown = missing ? "(missing)" : hidden ? "(hidden)" : `${escapeText(shortTarget(value ?? ""))}${archived ? " (archived)" : ""}`;
    displayText += text.slice(cursor, link.start);
    displayText += `[${link.label ? `${escapeLabel(link.label)}${ARROW}` : ""}${shown}](${suffix(link)})`;
    cursor = link.end;
  }
  return { displayText: displayText + text.slice(cursor), links };
}

// ---- write-back ----

const READABLE_LINK = /\[((?:\\.|[^\\\]])*)\]\((node|page):([A-Za-z0-9_-]+)((?:\?[A-Za-z]+(?:[?&][A-Za-z]+)*)?)\)/g;

const unescape = (value: string) => value.replace(/\\(.)/g, "$1");

// The label part of a readable link's brackets (before an unescaped " → ").
function readableLabel(inner: string) {
  const parts = inner.split(/(?<!\\) → /);
  return parts.length > 1 ? unescape(parts[0]).trim() || null : null;
}

const linkKey = (kind: string, id: string, label: string | null, options: string[]) =>
  JSON.stringify([kind, id, label, [...options].sort()]);

// Turns links printed in the readable form back into stored link syntax. With
// `original` (the item's current stored text), a link that matches one of its
// links (same kind, id, label and options) gets that link's exact stored form
// back, so editing printed text leaves untouched links byte-for-byte equal.
// Otherwise it becomes `[[node:ID]]` / `[[Label|node:ID?opts]]` (or page:),
// which the app reads the same way. Text inside the brackets of an unlabeled
// link is display only and is dropped.
export function toStoredLinkText(text: string, original?: string) {
  const originals = new Map<string, string[]>();
  for (const link of original ? idLinks(original) : []) {
    const key = linkKey(link.kind, link.id, link.label, link.options);
    originals.set(key, [...(originals.get(key) ?? []), link.raw]);
  }
  return text.replace(READABLE_LINK, (token, inner: string, kind: string, id: string, optionText: string) => {
    // Stored as an external markdown link already: leave it.
    if (original?.includes(token)) return token;
    const options = optionText ? optionText.slice(1).split(/[?&]/).map((option) => option.toLowerCase()) : [];
    const label = readableLabel(inner);
    const queue = originals.get(linkKey(kind, id, label, options));
    if (queue?.length) return queue.length > 1 ? queue.shift()! : queue[0];
    return `[[${label ? `${label}|` : ""}${kind}:${id}${optionText}]]`;
  });
}

// True when text has a link in the readable form (so a write will convert it).
export const hasReadableLinks = (text: string) => new RegExp(READABLE_LINK.source).test(text);
