import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown.tsx";

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

describe("Markdown renders a reply as elements, never as markup", () => {
  it("escapes raw HTML", () => {
    const out = html("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only http and https", () => {
    expect(html("[ok](https://example.com/a?b=1)")).toContain('href="https://example.com/a?b=1"');
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example"]) {
      expect(html(`[click](${bad})`), bad).not.toContain("<a ");
    }
  });

  it("opens links in a new tab without leaking the opener", () => {
    const out = html("[x](https://example.com)");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
  });

  it("keeps code verbatim, markdown and HTML included", () => {
    const out = html("```\n**not bold** <b>x</b>\n```");
    expect(out).toContain("**not bold** &lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain("<strong>");
  });

  it("renders headings, lists and inline styles", () => {
    const out = html("## Title\n\n- one\n- **two**\n\n1. first\n2. `code`");
    expect(out).toContain("<h3>Title</h3>");
    expect(out).toContain("<ul><li>one</li><li><strong>two</strong></li></ul>");
    expect(out).toContain("<ol><li>first</li><li><code>code</code></li></ol>");
  });

  it("survives empty and unterminated input", () => {
    expect(html("")).toBe('<div class="markdown"></div>');
    expect(() => html("```\nnever closed")).not.toThrow();
    expect(() => html("**open [link](")).not.toThrow();
  });
});
