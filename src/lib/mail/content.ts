import sanitize from "sanitize-html";

export function safeHtml(html: string) {
  return sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "span",
      "div",
    ],
    allowedAttributes: {},
    allowedSchemes: [],
    allowProtocolRelative: false,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "noscript",
      "iframe",
      "object",
      "template",
      "svg",
      "math",
    ],
  });
}
export function plainText(html: string) {
  return sanitize(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
export function readerDocument(html: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:15px/1.7 system-ui,sans-serif;color:#26352f;overflow-wrap:anywhere;margin:20px}table{max-width:100%;border-collapse:collapse}td,th{padding:6px;border:1px solid #d9e3dc}pre{white-space:pre-wrap}blockquote{border-left:3px solid #d9e3dc;margin-left:0;padding-left:16px}h1{font-size:26px}</style></head><body>${safeHtml(html)}</body></html>`;
}
