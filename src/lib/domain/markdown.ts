import MarkdownIt from 'markdown-it';
import {
  javascriptLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { copyIcon } from '../copy-icon';

/** Links are explicit external actions, never navigation in the app WebView. */
export function externalUrl(source: string): string | null {
  if (!source || source.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(source))
    return null;
  try {
    const url = new URL(source);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
      ? source
      : null;
  } catch {
    return null;
  }
}
const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});
const escape = parser.utils.escapeHtml;
function highlightCode(source: string, info: string) {
  const language = info.trim().split(/\s/)[0].toLowerCase();
  const grammar = /^(js|javascript)$/.test(language)
    ? javascriptLanguage
    : /^(ts|typescript)$/.test(language)
      ? typescriptLanguage
      : language === 'json'
        ? jsonLanguage
        : null;
  const lines = [''];
  function append(text: string, classes = '') {
    text.split('\n').forEach((part, index) => {
      if (index) lines.push('');
      lines[lines.length - 1] +=
        classes && part
          ? `<span class="${classes}">${escape(part)}</span>`
          : escape(part);
    });
  }
  let cursor = 0;
  if (grammar)
    highlightTree(
      grammar.parser.parse(source),
      classHighlighter,
      (from, to, classes) => {
        append(source.slice(cursor, from));
        append(source.slice(from, to), classes);
        cursor = to;
      },
    );
  append(source.slice(cursor));
  // A multiline syntax token must close on each line before the row wrapper.
  if (source.endsWith('\n')) lines.pop();
  return lines
    .map((line) => `<span class="code-line">${line || ' '}</span>`)
    .join('');
}
type SourceLine = { text: string; ending: string };
type CodeEnvironment = { code: string[]; lines: SourceLine[] };
type CodeToken = {
  type: string;
  content: string;
  map: [number, number] | null;
};
function codeSource(token: CodeToken, lines: SourceLine[]): string {
  if (!token.map) return token.content;
  const body = token.content.split('\n');
  if (body.at(-1) === '') body.pop();
  const start = token.map[0] + (token.type === 'fence' ? 1 : 0);
  let source = body
    .map((text, index) => {
      const raw = lines[start + index];
      const suffix = text.length ? raw?.text.slice(-text.length) : '';
      const exact = suffix?.replace(/\0/g, '\ufffd') === text ? suffix : text;
      return exact + (raw?.ending ?? '');
    })
    .join('');
  if (token.type === 'code_block' && body.length) {
    const prefix = lines[start].text.slice(
      0,
      lines[start].text.length - body[0].length,
    );
    const columns = Array.from(prefix).reduce(
      (column, char) =>
        char === '\t' ? column + 4 - (column % 4) : column + 1,
      0,
    );
    const container = prefix.replace(/[ \t]+$/, '');
    // Explicitly indented trailing blanks belong to the code; unindented separators do not.
    for (let index = token.map[1]; index < lines.length; index++) {
      const raw = lines[index];
      const blank = /^[ \t]+$/.test(raw.text);
      const containerBlank =
        container &&
        raw.text.startsWith(container) &&
        /^[ \t]+$/.test(raw.text.slice(container.length));
      if (!blank && !containerBlank) break;
      let position = 0,
        column = 0;
      while (position < raw.text.length && column < columns) {
        column += raw.text[position++] === '\t' ? 4 - (column % 4) : 1;
      }
      if (column < columns) break;
      source +=
        ' '.repeat(column - columns) + raw.text.slice(position) + raw.ending;
    }
  }
  return source;
}
function codeBlock(
  token: CodeToken,
  info: string,
  environment: object | undefined,
) {
  // This private parser is rendered only through renderMarkdownBlocks.
  const env = environment as CodeEnvironment;
  const index = env.code.push(codeSource(token, env.lines)) - 1;
  return `<pre class="code-block"><button type="button" class="code-copy" aria-label="Copy code" title="Copy code" data-code-index="${index}">${copyIcon}</button><code>${highlightCode(token.content, info)}</code></pre>\n`;
}
parser.renderer.rules.fence = (tokens, index, _options, env) =>
  codeBlock(tokens[index], tokens[index].info, env);
parser.renderer.rules.code_block = (tokens, index, _options, env) =>
  codeBlock(tokens[index], '', env);
parser.renderer.rules.image = (tokens, index) =>
  escape(`[Image: ${tokens[index].content || 'image'}]`);
parser.renderer.rules.link_open = (tokens, index) => {
  const url = externalUrl(String(tokens[index].attrGet('href') ?? ''));
  return url
    ? `<a href="${escape(url)}" data-external-url="${escape(url)}" rel="noreferrer noopener">`
    : '<span>';
};
parser.renderer.rules.link_close = (tokens, index) => {
  // Pair with the matching opening token, including nested inline formatting.
  let depth = 1;
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].type === 'link_close') depth++;
    if (tokens[i].type === 'link_open' && --depth === 0)
      return externalUrl(String(tokens[i].attrGet('href') ?? ''))
        ? '</a>'
        : '</span>';
  }
  return '</span>';
};
export function renderMarkdownBlocks(source: string): {
  html: string;
  code: string[];
} {
  const lines = Array.from(source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g))
    .filter((match) => match[0].length > 0)
    .map((match) => ({ text: match[1], ending: match[2] }));
  const env: CodeEnvironment = { code: [], lines };
  return { html: parser.render(source, env), code: env.code };
}
export function renderMarkdown(source: string): string {
  return renderMarkdownBlocks(source).html;
}
