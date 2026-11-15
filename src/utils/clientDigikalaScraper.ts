import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { extractPriceFromDigikalaInspect } from './digikalaScraper.ts';
import { extractDkpId, selectDigikalaBestVariantPrice } from './universalScraper.ts';
import { FIXED_SCHEDULE_HOURS } from './schedule.ts';

export interface ClientScrapedResult {
  name: string;
  category?: string;
  priceToman: number;
  imageUrl: string;
  warranty: string;
  source: string;
  stockStatus: 'in_stock' | 'out_of_stock' | 'call';
  hasDiscount?: boolean;
  discountedPriceToman?: number;
  discountPercent?: string;
  queryTimeMs?: number;
}

const CLIENT_SCHEDULER_SLOT_KEY = 'shop_last_client_3h_slot_v1';

/**
 * Queries Digikala microservice directly using Capacitor Native HTTP
 * when running inside Android APK — bypasses WebView CORS completely,
 * enabling standalone live price updates during Iran National Intranet ("نت ملی").
 */
async function scrapeDigikalaViaCapacitorNative(
  rawUrl: string
): Promise<ClientScrapedResult | null> {
  const dkpId = extractDkpId(rawUrl);
  if (!dkpId) return null;

  const t0 = Date.now();
  let currentUrl = `https://api.digikala.com/product/v1/products/${dkpId}/`;
  let cookieHeader = 'digicdn_cookie=f1e30d0c3c16734bd250ead36e794ae8c5d8dfee';

  try {
    let finalJson: any = null;

    for (let step = 0; step < 4; step++) {
      const response = await CapacitorHttp.request({
        url: currentUrl,
        method: 'GET',
        connectTimeout: 7000,
        readTimeout: 7000,
        disableRedirects: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://www.digikala.com/',
          Origin: 'https://www.digikala.com',
          Cookie: cookieHeader,
        },
      });

      const setCookieRaw =
        response.headers?.['set-cookie'] || response.headers?.['Set-Cookie'] || '';
      if (setCookieRaw) {
        const cookieParts = String(setCookieRaw)
          .split(/,(?=[^;]+=)/)
          .map((item) => item.split(';')[0].trim())
          .filter(Boolean);
        if (cookieParts.length > 0) {
          cookieHeader = cookieParts.join('; ');
        }
      }

      if (response.status === 200 && response.data) {
        finalJson =
          typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        break;
      }

      if ([301, 302, 307, 308].includes(response.status)) {
        const location =
          response.headers?.location || response.headers?.Location || '';
        if (location) {
          currentUrl = String(location).startsWith('http')
            ? String(location)
            : new URL(String(location), currentUrl).toString();
          continue;
        }
      }

      break;
    }

    if (!finalJson || finalJson.status !== 200 || !finalJson.data?.product) {
      return null;
    }

    const elapsed = Date.now() - t0;
    return selectDigikalaBestVariantPrice(
      finalJson.data.product,
      elapsed,
      'استعلام مستقیم اندروید'
    );
  } catch (err) {
    console.warn('[CapacitorNativeScraper] Digikala query error:', err);
    return null;
  }
}

async function postTrackUrlEndpoint(
  endpoint: string,
  payload: { url?: string; inspectHtml?: string; name?: string; imageUrl?: string },
  timeoutMs = 7000
): Promise<{ data: ClientScrapedResult | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        data: null,
        error:
          res.status === 404
            ? 'سرور استعلام (/api/track-url) در این آدرس فعال نیست.'
            : `پاسخ نامعتبر از سرور استعلام (کد ${res.status})`,
      };
    }
    const json = await res.json();
    if (json?.success && json?.data) {
      return { data: json.data as ClientScrapedResult };
    }
    return { data: null, error: json?.error || 'اطلاعات قیمت یافت نشد.' };
  } catch (err: any) {
    return {
      data: null,
      error: err?.message || 'عدم برقراری ارتباط با سرور استعلام',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unified zero-overhead live Digikala fetcher:
 * 1. In Android APK (Capacitor): calls Digikala directly via CapacitorHttp (no CORS, works during Net-Melli).
 * 2. On Web / Cloudflare Pages / Windows Electron: uses /api/track-url first (fast Worker / embedded Node server),
 *    then bridges to http://localhost:3000/api/track-url if running locally on Windows.
 * 3. Inspect HTML snippet fallback offline.
 */
export async function fetchLiveDigikalaProductClient(input: {
  url?: string;
  inspectHtml?: string;
  fallbackName?: string;
  fallbackCategory?: string;
  fallbackImageUrl?: string;
}): Promise<{ data: ClientScrapedResult | null; diagnosticError?: string }> {
  const url = (input.url || '').trim();
  const inspectHtml = (input.inspectHtml || '').trim();

  // Android Capacitor Native path: direct CORS-free internal network call (~200-400ms)
  if (Capacitor.isNativePlatform() && url) {
    const nativeData = await scrapeDigikalaViaCapacitorNative(url);
    if (nativeData) {
      return { data: nativeData };
    }
  }

  let diagnosticError = '';

  // Web / Electron / Localhost primary path (/api/track-url)
  if (!Capacitor.isNativePlatform() && (url || inspectHtml)) {
    const primary = await postTrackUrlEndpoint('/api/track-url', {
      url,
      inspectHtml,
      name: input.fallbackName,
      imageUrl: input.fallbackImageUrl,
    });
    if (primary.data) {
      return { data: primary.data };
    }
    if (primary.error) diagnosticError = primary.error;

    // Local Node/Electron bridge if browsing via remote domain
    if (
      typeof window !== 'undefined' &&
      !window.location.hostname.includes('localhost') &&
      !window.location.hostname.includes('127.0.0.1') &&
      url
    ) {
      const localBridge = await postTrackUrlEndpoint(
        'http://localhost:3000/api/track-url',
        { url, inspectHtml },
        4500
      );
      if (localBridge.data) {
        return {
          data: {
            ...localBridge.data,
            source: `${localBridge.data.source || 'استعلام سریع'} (سرور محلی سیستم)`,
          },
        };
      }
    }
  }

  // Offline Inspect HTML snippet fallback
  if (inspectHtml) {
    const parsed = extractPriceFromDigikalaInspect(inspectHtml);
    if (parsed && parsed.priceToman > 0) {
      return {
        data: {
          name: input.fallbackName || 'کالای استعلام‌شده',
          category: input.fallbackCategory,
          priceToman: parsed.priceToman,
          imageUrl: input.fallbackImageUrl || '',
          warranty: '',
          hasDiscount: parsed.isDiscountedOriginal,
          source: 'استخراج مستقیم از کد اینسپکت (آفلاین)',
          stockStatus: 'in_stock',
        },
      };
    }
  }

  return { data: null, diagnosticError };
}

/**
 * Returns the most recent 3-hour slot identifier (e.g. "2026-11-14T09")
 * and whether this device has already run an auto-check for that slot.
 */
export function getCurrent3HourSlotId(now: Date = new Date()): string {
  const currentHour = now.getHours();
  const activeSlotHour = [...FIXED_SCHEDULE_HOURS]
    .reverse()
    .find((h) => h <= currentHour) ?? 0;

  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(activeSlotHour).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}`;
}

export function shouldRunClient3HourAutoSync(now: Date = new Date()): boolean {
  try {
    const currentSlot = getCurrent3HourSlotId(now);
    const lastSlot = localStorage.getItem(CLIENT_SCHEDULER_SLOT_KEY);
    return lastSlot !== currentSlot;
  } catch {
    return false;
  }
}

export function markClient3HourSlotDone(now: Date = new Date()): void {
  try {
    localStorage.setItem(CLIENT_SCHEDULER_SLOT_KEY, getCurrent3HourSlotId(now));
  } catch {
    // Ignore storage errors
  }
}
