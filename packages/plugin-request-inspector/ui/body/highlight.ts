import hljs from "highlight.js/lib/core";
import css from "highlight.js/lib/languages/css";
import graphql from "highlight.js/lib/languages/graphql";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";

import type { HighlightLanguage } from "./pretty.ts";

hljs.registerLanguage("css", css);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);

/** Colors `text` into `element`. highlight.js escapes the text; its markup is only spans. */
export function highlightInto(element: HTMLElement, text: string, language: HighlightLanguage) {
  element.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

export const highlightStyles = `
:root {
  --hl-keyword: #c792ea;
  --hl-string: #a5d6a7;
  --hl-number: #f78c6c;
  --hl-name: #82aaff;
  --hl-attr: #ffcb6b;
  --hl-comment: var(--text-faint);
}
:root[data-theme="light"] {
  --hl-keyword: #7c3aed;
  --hl-string: #15803d;
  --hl-number: #c2410c;
  --hl-name: #1d4ed8;
  --hl-attr: #a16207;
}
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-built_in, .hljs-type { color: var(--hl-keyword); }
.hljs-string, .hljs-regexp, .hljs-template-variable { color: var(--hl-string); }
.hljs-number, .hljs-symbol, .hljs-bullet { color: var(--hl-number); }
.hljs-name, .hljs-tag, .hljs-title, .hljs-section, .hljs-selector-id, .hljs-selector-class { color: var(--hl-name); }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-params { color: var(--hl-attr); }
.hljs-comment, .hljs-meta, .hljs-doctag, .hljs-punctuation { color: var(--hl-comment); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
`;
