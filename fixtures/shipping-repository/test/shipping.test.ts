import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteShipping } from '../src/shipping.ts';

test('charges the flat rate below the threshold', () => {
  const quote = quoteShipping(4000, 5000, 500);
  assert.equal(quote.total, 4500);
});

test('ships free above the threshold', () => {
  const quote = quoteShipping(6000, 5000, 500);
  assert.equal(quote.total, 6000);
});

test('ships free exactly at the threshold', () => {
  const quote = quoteShipping(5000, 5000, 500);
  assert.equal(quote.shipping, 0);
});
