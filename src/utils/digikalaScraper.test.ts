import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPriceFromDigikalaInspect } from './digikalaScraper.ts';
import { selectDigikalaBestVariantPrice } from './universalScraper.ts';

test('extractPriceFromDigikalaInspect parses exact DevTools snippet from user image', () => {
  // Exact snippet from screenshot:
  const snippet = `<div class="flex flex-row items-center" data-theme-animation="price-container">
  <span class="ml-1 text-neutral-800" data-testid="price-final">
    <div>۴,۱۶۵,۰۰۰</div>
  </span>
  <dds-icon name="value-toman" color="content/1" aria-hidden="true" style="font-size: 14px;"></dds-icon>
</div>`;

  const result = extractPriceFromDigikalaInspect(snippet);
  assert.notEqual(result, null);
  assert.equal(result?.priceToman, 4165000);
  assert.equal(result?.sourceType, 'data-testid-price-final');
});

test('extractPriceFromDigikalaInspect parses span with data-testid="price-final"', () => {
  const span = `<span class="ml-1 text-neutral-800" data-testid="price-final"><div>۴,۱۶۵,۰۰۰</div></span>`;
  const result = extractPriceFromDigikalaInspect(span);
  assert.notEqual(result, null);
  assert.equal(result?.priceToman, 4165000);
});

test('extractPriceFromDigikalaInspect parses raw pasted Persian digits with commas', () => {
  const raw = '۴,۱۶۵,۰۰۰';
  const result = extractPriceFromDigikalaInspect(raw);
  assert.notEqual(result, null);
  assert.equal(result?.priceToman, 4165000);
});

test('extractPriceFromDigikalaInspect parses English digits with commas', () => {
  const raw = '4,165,000';
  const result = extractPriceFromDigikalaInspect(raw);
  assert.notEqual(result, null);
  assert.equal(result?.priceToman, 4165000);
});

test('selectDigikalaBestVariantPrice picks lowest non-discounted same-color seller price (MacBook DKP-21723566)', () => {
  const mockProduct = {
    title_fa: 'لپ‌تاپ اپل مدل MacBook Air MDHE4 2026 LLA',
    category: { title_fa: 'لپ تاپ و الترابوک' },
    default_variant: {
      id: 84388591,
      status: 'marketable',
      color: { id: 22, title: 'سرمه‌ای' },
      seller: { title: 'دیجی‌کالا' },
      price: {
        rrp_price: 3657553000,
        selling_price: 3474676000,
        discount_percent: 5,
        is_promotion: true,
      },
    },
    variants: [
      {
        id: 84388591,
        status: 'marketable',
        color: { id: 22, title: 'سرمه‌ای' },
        seller: { title: 'دیجی‌کالا' },
        price: {
          rrp_price: 3657553000,
          selling_price: 3474676000,
          discount_percent: 5,
          is_promotion: true,
        },
      },
      {
        id: 78848253,
        status: 'marketable',
        color: { id: 22, title: 'سرمه‌ای' },
        seller: { title: 'تامین کالای آرتین همتا' },
        price: {
          rrp_price: 3471676000,
          selling_price: 3471676000,
          discount_percent: 0,
          marketable_stock: 1,
        },
      },
      {
        id: 99999999,
        status: 'marketable',
        color: { id: 1, title: 'مشکی' },
        seller: { title: 'فروشنده رنگ دیگر' },
        price: {
          rrp_price: 3000000000,
          selling_price: 3000000000,
          discount_percent: 0,
          marketable_stock: 2,
        },
      },
    ],
  };

  const res = selectDigikalaBestVariantPrice(mockProduct, 120);
  assert.equal(res.priceToman, 347167600);
  assert.equal(res.stockStatus, 'in_stock');
  assert.equal(res.hasDiscount, false);
  assert.ok(res.source.includes('تامین کالای آرتین همتا'));
});

test('selectDigikalaBestVariantPrice ignores single-seller promo discount and treats omitted marketable_stock as in_stock', () => {
  const mockPromoProduct = {
    title_fa: 'ماوس بی سیم گیمینگ مدل T2',
    default_variant: {
      id: 73538348,
      status: 'marketable',
      color: { id: 1, title: 'مشکی' },
      seller: { title: 'شیک سنتر' },
      price: {
        rrp_price: 23500000,
        selling_price: 16230000,
        discount_percent: 31,
        is_promotion: true,
      },
    },
    variants: [
      {
        id: 73538348,
        status: 'marketable',
        color: { id: 1, title: 'مشکی' },
        seller: { title: 'شیک سنتر' },
        price: {
          rrp_price: 23500000,
          selling_price: 16230000,
          discount_percent: 31,
          is_promotion: true,
        },
      },
    ],
  };

  const res = selectDigikalaBestVariantPrice(mockPromoProduct, 80);
  assert.equal(res.priceToman, 2350000);
  assert.equal(res.stockStatus, 'in_stock');
  assert.equal(res.hasDiscount, true);
});

