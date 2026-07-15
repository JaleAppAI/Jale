import { stripe, logResult } from './lib/client';

async function main() {
  const product = await stripe.products.create({
    name: 'Jale Employer Pro (sandbox)',
    metadata: { jale_plan_code: 'employer_pro' },
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 2000, // $20.00 — spec S5.1
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: { jale_plan_code: 'employer_pro' },
  });
  logResult('01 product+price', { productId: product.id, priceId: price.id, unitAmount: price.unit_amount });
  console.log(`\nAdd to .env:  SPIKE_PRICE_ID=${price.id}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
