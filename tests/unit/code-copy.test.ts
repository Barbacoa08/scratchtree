import { describe, expect, it } from 'vitest';
import { renderMarkdownBlocks } from '../../src/lib/domain/markdown';

describe('code clipboard payloads', () => {
  it('preserves explicit trailing blanks inside quoted indented code', () => {
    expect(renderMarkdownBlocks('>     code\r\n>     \r\n').code).toEqual([
      'code\r\n\r\n',
    ]);
  });
  it('retains literal source characters that rendering normalizes', () => {
    expect(renderMarkdownBlocks('```\ncode\u0000value\n```').code).toEqual([
      'code\u0000value\n',
    ]);
  });
  it('preserves CRLF and mixed separators without fence markers', () => {
    expect(
      renderMarkdownBlocks('```ts\r\nconst x = 1;\r\n\n  use(x);\r\n```').code,
    ).toEqual(['const x = 1;\r\n\n  use(x);\r\n']);
  });
  it('preserves an explicitly indented trailing blank code row', () => {
    expect(renderMarkdownBlocks('    code\r\n    \r\n').code).toEqual([
      'code\r\n\r\n',
    ]);
  });
  it('removes quote and list syntax while preserving code indentation and original separators', () => {
    expect(
      renderMarkdownBlocks(
        '> ```\r\n>   indented\r\n>\r\n> ```\r\n\n- list\n\n  ```\n  foo\n  ```\n',
      ).code,
    ).toEqual(['  indented\r\n\r\n', 'foo\n']);
  });
  it('does not add a newline to an unclosed final code line', () => {
    expect(renderMarkdownBlocks('```\nraw').code).toEqual(['raw']);
  });
});
