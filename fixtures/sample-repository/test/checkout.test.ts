import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cart } from '../src/cart.ts';
import { checkout } from '../src/checkout.ts';
import { FakePaymentGateway } from '../src/payment/fake-gateway.ts';

function cartWithTwoMugs(): Cart {
  const cart = new Cart();
  cart.addItem({ sku: 'MUG-01', unitPrice: 1250, quantity: 2 });
  return cart;
}

test('charges subtotal plus tax when no discount code is given', async () => {
  const receipt = await checkout(cartWithTwoMugs(), new FakePaymentGateway(), { orderId: 'order-1' });
  assert.equal(receipt.subtotal, 2500);
  assert.equal(receipt.tax, 200);
  assert.equal(receipt.total, 2700);
});

test('applies tax to the discounted amount', async () => {
  const receipt = await checkout(cartWithTwoMugs(), new FakePaymentGateway(), {
    orderId: 'order-2',
    discountCode: 'WELCOME10',
  });
  assert.equal(receipt.discounted, 2250);
  assert.equal(receipt.tax, 180);
  assert.equal(receipt.total, 2430);
});

test('reports declined payments', async () => {
  await assert.rejects(
    checkout(cartWithTwoMugs(), new FakePaymentGateway(1000), { orderId: 'order-3' }),
    /Payment declined for order-3/,
  );
});
