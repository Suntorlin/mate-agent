/**
 * Just enough Markdown for chat replies, rendered as React elements (never as HTML, so a reply
 * cannot inject markup): headings, paragraphs, lists, fenced code, inline code, bold, italics
 * and links.
 */

import type { ReactNode } from "react";
import "./markdown.css";

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    const key = `${index}`;
    if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("[")) {
      nodes.push(
        <a key={key} href={match[2]} target="_blank" rel="noreferrer">
          {token.slice(1, token.indexOf("]"))}
        </a>
      );
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!next) break;
        items.push(next[2]);
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s)/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {parseBlocks(source).map((block, index) => {
        switch (block.kind) {
          case "code":
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            );
          case "heading":
            return block.level <= 2 ? (
              <h3 key={index}>{inline(block.text)}</h3>
            ) : (
              <h4 key={index}>{inline(block.text)}</h4>
            );
          case "list": {
            const items = block.items.map((item, j) => <li key={j}>{inline(item)}</li>);
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          default:
            return <p key={index}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
