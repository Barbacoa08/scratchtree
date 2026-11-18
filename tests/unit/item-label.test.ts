import { expect, it, vi } from 'vitest';
import { itemLabel } from '../../src/lib/domain/hierarchy';
import { item } from '../fixtures/items';

it.each([
  ['', 'Untitled'],
  [' \t\nSecond line', 'Untitled'],
  ['  First line \r\nSecond line', 'First line'],
  ['First\rSecond', 'First'],
  ['x'.repeat(32), 'x'.repeat(32)],
  ['x'.repeat(33), 'x'.repeat(31) + '…'],
  ['😀'.repeat(32), '😀'.repeat(32)],
  ['😀'.repeat(33), '😀'.repeat(31) + '…'],
  ['x'.repeat(30) + '😀ab', 'x'.repeat(30) + '😀…'],
  ['e\u0301'.repeat(17), 'e\u0301'.repeat(15) + 'e…'],
])('preserves exact label output for %j', (markdown, expected) => {
  expect(
    itemLabel(item({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', markdown })),
  ).toBe(expected);
});

it('does not expand a whole large first line into Unicode code points for a short preview', () => {
  const markdown = '😀'.repeat(100000);
  const original = String.prototype[Symbol.iterator];
  let visited = 0;
  const spy = vi
    .spyOn(String.prototype, Symbol.iterator)
    .mockImplementation(function* (
      this: string,
    ): Generator<string, undefined, unknown> {
      const value = String(this);
      for (const point of { [Symbol.iterator]: () => original.call(value) }) {
        if (value === markdown) visited++;
        yield point;
      }
      return undefined;
    });
  let label: string;
  try {
    label = itemLabel(
      item({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', markdown }),
    );
  } finally {
    spy.mockRestore();
  }
  expect(label).toBe('😀'.repeat(31) + '…');
  expect(visited).toBeLessThanOrEqual(33);
});
