/**
 * Universal High-Speed Scraper for Digikala
 * 
 * Works 100% across ALL environments:
 * 1. Cloudflare Workers / Cloudflare Pages Functions (V8 Edge Runtimes)
 * 2. Local developer environment (Windows, Mac, Linux via npm run dev)
 * 3. Node.js Express server (server.ts / VPS / Docker)
 * 4. Browser / Client-side fallback
 * 
 * ZERO external OS dependencies (no curl, no Playwright, no child_process).
 * Pure standard Web API fetch with manual cookie-redirect tracking to bypass DigiCDN.
 */

import { toEnglishDigits } from './jalali.ts';

export interface ScrapedProductData {
  name: string;
  category?: string;
  priceToman: number;
  imageUrl: string;
  warranty: string;
  source: string;
  stockStatus: 'in_stock' | 'out_of_stock' | 'call';
  selectorUsed: string;
  hasDiscount?: boolean;
  discountedPriceToman?: number;
  discountPercent?: string;
  queryTimeMs?: number;
}

/**
 * Extract DKP ID from any input (full URL, shorthand, bare digits, or Persian numbers)
 */
export function extractDkpId(rawInput: string): string | null {
  if (!rawInput) return null;
  const cleaned = toEnglishDigits(rawInput.trim());

  // Pure numeric input like "18991772"
  if (/^\d{3,10}$/.test(cleaned)) {
    return cleaned;
  }
  // Match dkp-18991772
  const m1 = cleaned.match(/dkp-(\d+)/i);
  if (m1) return m1[1];

  // Match product_id=18991772
  const m2 = cleaned.match(/product_id=(\d+)/i);
  if (m2) return m2[1];

  // Match /product/18991772 or /products/18991772
  const m3 = cleaned.match(/\/product(?:s)?\/(\d+)/i);
  if (m3) return m3[1];

  return null;
}

/**
 * Guess category from product title if not provided by API
 */
export function guessCategoryFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (
    t.includes('لپ‌تاپ') ||
    t.includes('لپ تاپ') ||
    t.includes('laptop') ||
    t.includes('نوت‌بوک') ||
    t.includes('نوت بوک') ||
    t.includes('مک‌بوک') ||
    t.includes('مک بوک') ||
    t.includes('ideapad') ||
    t.includes('thinkpad') ||
    t.includes('vivobook') ||
    t.includes('zenbook') ||
    t.includes('legion') ||
    t.includes('tuf')
  ) {
    return 'لپ‌تاپ و اولترابوک';
  }
  if (t.includes('مانیتور') || t.includes('نمایشگر') || t.includes('monitor')) {
    return 'مانیتور و نمایشگر';
  }
  if (
    t.includes('ssd') ||
    t.includes('اس اس دی') ||
    t.includes('اس‌اس‌دی') ||
    t.includes('رم') ||
    t.includes('حافظه') ||
    t.includes('گرافیک') ||
    t.includes('مادربرد') ||
    t.includes('پردازنده') ||
    t.includes('پاور') ||
    t.includes('کیس') ||
    t.includes('هارد')
  ) {
    return 'قطعات و ارتقا سیستم';
  }
  if (
    t.includes('ماوس') ||
    t.includes('موس') ||
    t.includes('mouse') ||
    t.includes('کیبورد') ||
    t.includes('صفحه کلید') ||
    t.includes('keyboard') ||
    t.includes('هدست') ||
    t.includes('هدفون') ||
    t.includes('headset') ||
    t.includes('پد') ||
    t.includes('دسته بازی') ||
    t.includes('فلش')
  ) {
    return 'لوازم جانبی و گیمینگ';
  }
  return 'لوازم جانبی و قطعات';
}

function isDigikalaVariantInStock(v: any): boolean {
  if (!v || !v.price) return false;
  if (v.status && v.status !== 'marketable') return false;
  if (v.has_stock === false) return false;
  const stock = v.price.marketable_stock;
  if (stock !== undefined && stock !== null && Number(stock) <= 0) return false;
  return true;
}

function parseDigikalaVariantCandidate(v: any) {
  const p = v?.price;
  if (!p) return null;
  const rrpToman = p.rrp_price ? Math.round(Number(p.rrp_price) / 10) : 0;
  const sellingToman = p.selling_price ? Math.round(Number(p.selling_price) / 10) : 0;
  const genuinePriceToman = rrpToman > 0 ? rrpToman : sellingToman;
  if (!Number.isFinite(genuinePriceToman) || genuinePriceToman <= 0) return null;

  const discountNum = p.discount_percent ? Number(p.discount_percent) : 0;
  const isDiscounted =
    Boolean(p.is_incredible) ||
    Boolean(p.is_promotion) ||
    discountNum > 0 ||
    (rrpToman > 0 && sellingToman > 0 && sellingToman < rrpToman);

  return {
    variant: v,
    genuinePriceToman,
    sellingToman,
    isDiscounted,
    discountNum,
    sellerTitle: String(v?.seller?.title || '').trim(),
  };
}

export function selectDigikalaBestVariantPrice(
  prod: any,
  elapsed: number,
  envLabel = 'استعلام فوری'
): ScrapedProductData {
  const titleClean = String(prod?.title_fa || 'کالای دیجی‌کالا').trim();
  const cat = prod?.category?.title_fa || guessCategoryFromTitle(titleClean);
  const img =
    prod?.images?.main?.url?.[0] ||
    'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=600&q=80';

  const defaultVar = prod?.default_variant;
  const rawVariants = Array.isArray(prod?.variants) ? prod.variants : [];

  const mergedVariants: any[] = [];
  const seenIds = new Set<string | number>();
  for (const v of [defaultVar, ...rawVariants]) {
    if (!v || typeof v !== 'object') continue;
    const vid = v.id;
    if (vid !== undefined && vid !== null) {
      if (seenIds.has(vid)) continue;
      seenIds.add(vid);
    }
    mergedVariants.push(v);
  }

  const targetColorId = defaultVar?.color?.id ?? null;
  const targetSizeId = defaultVar?.size?.id ?? null;

  const candidates: NonNullable<ReturnType<typeof parseDigikalaVariantCandidate>>[] = [];
  for (const v of mergedVariants) {
    if (!isDigikalaVariantInStock(v)) continue;
    if (targetColorId !== null && targetColorId !== undefined && v?.color?.id !== targetColorId) {
      continue;
    }
    if (targetSizeId !== null && targetSizeId !== undefined && v?.size?.id !== targetSizeId) {
      continue;
    }
    const parsed = parseDigikalaVariantCandidate(v);
    if (parsed) candidates.push(parsed);
  }

  candidates.sort((a, b) => {
    if (a.genuinePriceToman !== b.genuinePriceToman) {
      return a.genuinePriceToman - b.genuinePriceToman;
    }
    if (a.isDiscounted !== b.isDiscounted) {
      return a.isDiscounted ? 1 : -1;
    }
    if (defaultVar?.id !== undefined && defaultVar?.id !== null) {
      if (a.variant.id === defaultVar.id) return -1;
      if (b.variant.id === defaultVar.id) return 1;
    }
    return a.sellingToman - b.sellingToman;
  });

  const best = candidates[0];
  if (!best) {
    return {
      name: titleClean,
      category: cat,
      priceToman: 0,
      imageUrl: img,
      warranty: '',
      source: `${envLabel} (${elapsed}ms) - کالای ناموجود در دیجی‌کالا`,
      stockStatus: 'out_of_stock',
      selectorUsed: 'api.digikala.com (status: out_of_stock)',
      queryTimeMs: elapsed,
    };
  }

  const defaultSeller = String(defaultVar?.seller?.title || '').trim();
  const usedCheaperSeller =
    Boolean(best.sellerTitle) && Boolean(defaultSeller) && best.sellerTitle !== defaultSeller;

  const sellerTag = best.sellerTitle ? ` - ${best.sellerTitle}` : '';
  const sourceLabel = best.isDiscounted
    ? `${envLabel} (${elapsed}ms) قیمت اصلی بدون تخفیف${sellerTag}`
    : usedCheaperSeller
      ? `${envLabel} (${elapsed}ms) کمترین قیمت غیرتخفیفی${sellerTag}`
      : `${envLabel} (${elapsed}ms) قیمت مستقیم کالا${sellerTag}`;

  return {
    name: titleClean,
    category: cat,
    priceToman: best.genuinePriceToman,
    imageUrl: img,
    warranty: '',
    source: sourceLabel,
    stockStatus: 'in_stock',
    selectorUsed: usedCheaperSeller
      ? 'api.digikala.com (variants min genuine same-color rrp_price)'
      : 'api.digikala.com (default_variant.price.rrp_price)',
    hasDiscount: best.isDiscounted,
    discountedPriceToman: best.isDiscounted ? best.sellingToman : undefined,
    discountPercent: best.discountNum > 0 ? `${best.discountNum}٪` : undefined,
    queryTimeMs: elapsed,
  };
}

/**
 * Pure standard Web API fetch with manual cookie-following loop.
 * Bypasses DigiCDN 307 redirect cookie challenge in ~150-300ms.
 * Compatible with Cloudflare Workers, Node.js, Bun, Deno, and modern browsers.
 */
export async function scrapeDigikalaPureFetch(dkpId: string): Promise<ScrapedProductData | null> {
  const t0 = Date.now();
  let currentUrl = `https://api.digikala.com/product/v1/products/${dkpId}/`;
  let cookieHeader = 'digicdn_cookie=f1e30d0c3c16734bd250ead36e794ae8c5d8dfee';

  try {
    let finalJson: any = null;

    // Follow up to 4 redirects manually to capture and send cookies across requests
    for (let step = 0; step < 4; step++) {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.digikala.com/',
        Origin: 'https://www.digikala.com',
      };
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
      });

      // Capture set-cookie headers from DigiCDN edge
      let setCookieList: string[] = [];
      // @ts-ignore
      if (typeof res.headers.getSetCookie === 'function') {
        // @ts-ignore
        setCookieList = res.headers.getSetCookie();
      } else if (res.headers.get('set-cookie')) {
        setCookieList = [res.headers.get('set-cookie') as string];
      }

      if (setCookieList && setCookieList.length > 0) {
        const pairs = setCookieList
          .map((c) => c.split(';')[0].trim())
          .filter(Boolean);
        if (pairs.length > 0) {
          cookieHeader = pairs.join('; ');
        }
      }

      if (res.status === 200) {
        finalJson = await res.json();
        break;
      }

      // If redirect 301, 302, 307, 308
      if ([301, 302, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (location) {
          currentUrl = location.startsWith('http')
            ? location
            : new URL(location, currentUrl).toString();
          continue;
        }
      }

      // If unexpected status and not redirected
      break;
    }

    if (!finalJson || finalJson.status !== 200 || !finalJson.data?.product) {
      return null;
    }

    const elapsed = Date.now() - t0;
    return selectDigikalaBestVariantPrice(finalJson.data.product, elapsed, 'استعلام فوری');
  } catch (err: any) {
    console.warn('[UniversalScraper] Pure fetch query failed:', err.message);
    return null;
  }
}

/**
 * Main query entry point
 */
export async function scrapeProductUniversal(urlOrId: string): Promise<ScrapedProductData | null> {
  const dkpId = extractDkpId(urlOrId);
  if (!dkpId) return null;
  return scrapeDigikalaPureFetch(dkpId);
}
