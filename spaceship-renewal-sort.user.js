// ==UserScript==
// @name         Spaceship Beast Mode — sort by renewal price
// @namespace    https://github.com/pasc4le-labs/spaceship-renewal-sort
// @version      1.0.0
// @description  Adds a toggle to Spaceship's Beast Mode results that re-sorts the list by renewal price instead of the first-year price.
// @author       bob
// @match        https://www.spaceship.com/domain-search*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'sprs:sortByRenewal';
  const PRICE_ENDPOINT = '/gateway/api/v1/pricing-bff/price/getPrices';
  const MAX_PRODUCTS_PER_REQUEST = 65;
  const ROW_SELECTOR = '[data-index]';
  const RESULTS_CONTAINER_SELECTOR = '.results__virtuoso-container';

  const priceIndex = new Map();
  const attempted = new Set();
  let lastCurrency = 'USD';
  let enabled = false;
  let toggleEl = null;
  let listEl = null;
  let renderTimer = null;
  let hydrationInFlight = false;

  const debug = (...args) => {
    if (window.__SPRS_DEBUG) console.log('[renewal-sort]', ...args);
  };

  const num = (value) => {
    const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

  const readEnabled = () => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  };

  const writeEnabled = (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* storage blocked: keep state in memory only */
    }
  };

  const slugOf = (tld) => String(tld || '').toLowerCase().replace(/\./g, '_');

  const priceOf = (priceEntry) => {
    if (!priceEntry) return null;
    const totals = priceEntry.total ? Object.values(priceEntry.total) : [];
    const total = totals.find((t) => t && t.price) || null;
    if (!total || !total.price) return null;
    const fee = priceEntry.components?.icannFee ? Object.values(priceEntry.components.icannFee)[0] : null;
    const feeAmount = num(fee?.price?.amount) ?? 0;
    const gross = num(total.price.amount);
    const grossRegular = num(total.regularPrice?.amount);
    if (gross == null) return null;
    return {
      net: round2(gross - feeAmount),
      netRegular: grossRegular == null ? null : round2(grossRegular - feeAmount),
      currency: total.price.currency || null,
    };
  };

  const capturePrices = (requestBody, responseJson) => {
    let request;
    try {
      request = typeof requestBody === 'string' ? JSON.parse(requestBody) : null;
    } catch {
      return false;
    }
    const sent = request?.products;
    const received = responseJson?.products || responseJson?.data?.products;
    if (!Array.isArray(sent) || !Array.isArray(received)) return false;
    if (Array.isArray(request.currencies) && request.currencies[0]) lastCurrency = request.currencies[0];

    let changed = false;
    const count = Math.min(sent.length, received.length);
    for (let i = 0; i < count; i += 1) {
      const sentProduct = sent[i]?.product;
      const receivedProduct = received[i];
      const slug = receivedProduct?.product?.productSlug || sentProduct?.productSlug;
      const sld = receivedProduct?.params?.formulaParamsWithDefaults?.sld || sentProduct?.plan?.pricingPlanParams?.sld;
      if (!slug || !sld) continue;
      const plan = sentProduct?.plan?.pricingPlanSlug || receivedProduct?.plan?.pricingPlanSlug || 'regular';
      const prices = receivedProduct?.prices || [];
      const firstYear = priceOf(prices.find((p) => p.priceType === 'purchase'));
      const renewal = priceOf(prices.find((p) => p.priceType === 'renewal'));
      if (!firstYear && !renewal) continue;
      const key = `${String(sld).toLowerCase()}|${slug}`;
      const entries = priceIndex.get(key) || [];
      const entry = {
        plan,
        firstYear: firstYear?.net ?? null,
        firstYearList: firstYear?.netRegular ?? null,
        renewal: renewal?.net ?? null,
        renewalList: renewal?.netRegular ?? null,
        currency: renewal?.currency || firstYear?.currency || lastCurrency,
        cachedAt: Date.now(),
      };
      const existing = entries.findIndex((e) => e.plan === plan);
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
      priceIndex.set(key, entries);
      changed = true;
    }
    return changed;
  };

  const looksLikePriceCall = (url) => typeof url === 'string' && url.includes('getPrices');

  const hookFetch = () => {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function') return;
    window.fetch = function patchedFetch(input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (looksLikePriceCall(url) && promise && typeof promise.then === 'function') {
          const body = init?.body;
          promise
            .then((response) => {
              response
                .clone()
                .json()
                .then((json) => {
                  if (capturePrices(typeof body === 'string' ? body : null, json)) scheduleRender();
                })
                .catch(() => {});
            })
            .catch(() => {});
        }
      } catch {
        /* never break the page's own fetch */
      }
      return promise;
    };
  };

  const hookXhr = () => {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto) return;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    proto.open = function patchedOpen(method, url) {
      try {
        this.__sprsUrl = url;
      } catch {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };
    proto.send = function patchedSend(body) {
      try {
        if (looksLikePriceCall(this.__sprsUrl)) {
          const xhr = this;
          xhr.addEventListener('load', () => {
            try {
              const json = JSON.parse(xhr.responseText);
              if (capturePrices(typeof body === 'string' ? body : null, json)) scheduleRender();
            } catch {
              /* not JSON: ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return nativeSend.apply(this, arguments);
    };
  };

  const readDomainPart = (item) => {
    const container = item.querySelector('[class*="__text__span__container"]');
    if (!container) return null;
    const spans = [...container.children].filter((el) => el.tagName === 'SPAN');
    const sldEl = spans.find((el) => !/__text__tld$/.test(el.className || ''));
    const tldEl = container.querySelector('[class*="__text__tld"]');
    if (!sldEl || !tldEl) return null;
    const sld = (sldEl.textContent || '').trim();
    const tld = [...tldEl.querySelectorAll('span')]
      .map((s) => (s.textContent || '').trim())
      .join('')
      .replace(/^\./, '');
    if (!sld || !tld) return null;
    return { sld, tld, domain: `${sld}.${tld}` };
  };

  const readRow = (item) => {
    if (!item.querySelector('.beast-tab-item__container')) return null;
    const parts = readDomainPart(item);
    if (!parts) return null;
    const unavailable = Boolean(item.querySelector('[class*="item__unavailable__container"]'));
    const premium = Boolean(item.querySelector('.domains-tab-item__available__suggested__badge'));
    return {
      item,
      sld: parts.sld,
      tld: parts.tld,
      domain: parts.domain,
      unavailable,
      premium,
      key: `${parts.sld.toLowerCase()}|${slugOf(parts.tld)}|${premium ? 'premium' : 'regular'}`,
    };
  };

  const lookupPrice = (row) => {
    const entries = priceIndex.get(`${row.sld.toLowerCase()}|${slugOf(row.tld)}`);
    if (!entries || !entries.length) return null;
    return entries.find((e) => e.plan === (row.premium ? 'premium' : 'regular')) || entries[0];
  };

  const formatMoney = (amount, currency) => {
    if (amount == null) return '';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || lastCurrency || 'USD',
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount}`;
    }
  };

  const setBadge = (row, entry) => {
    const priceContainer = row.item.querySelector('[class*="__price__container"]');
    if (!priceContainer) return;
    let badge = priceContainer.querySelector('.sprs-renew');
    if (entry?.renewal == null) {
      if (badge) badge.remove();
      return;
    }
    const text = `renews ${formatMoney(entry.renewal, entry.currency)}`;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sprs-renew';
      priceContainer.appendChild(badge);
    }
    if (badge.textContent !== text) badge.textContent = text;
    const title = `Renewal price (year 2+). First year: ${formatMoney(entry.firstYear, entry.currency)}`;
    if (badge.title !== title) badge.title = title;
  };

  const findList = () => {
    if (listEl && listEl.isConnected && listEl.querySelector(ROW_SELECTOR)) return listEl;
    const scope = document.querySelector(RESULTS_CONTAINER_SELECTOR) || document.querySelector('.results');
    if (!scope) return null;
    const firstItem = scope.querySelector(ROW_SELECTOR);
    listEl = firstItem ? firstItem.parentElement : null;
    return listEl;
  };

  const sortRows = () => {
    if (!enabled) return;
    const list = findList();
    if (!list) return;
    const items = [...list.children].filter((el) => el.matches(ROW_SELECTOR));
    if (!items.length) return;

    const rows = items.map(readRow).filter(Boolean);
    if (!rows.length) return;

    rows.forEach((row) => {
      if (row.unavailable) {
        const stale = row.item.querySelector('.sprs-renew');
        if (stale) stale.remove();
        return;
      }
      row.entry = lookupPrice(row);
      setBadge(row, row.entry);
    });

    const ranked = rows
      .map((row, index) => ({ row, index, renewal: row.unavailable ? null : row.entry?.renewal ?? null }))
      .sort((a, b) => {
        if (a.renewal == null && b.renewal == null) return a.index - b.index;
        if (a.renewal == null) return 1;
        if (b.renewal == null) return -1;
        if (a.renewal !== b.renewal) return a.renewal - b.renewal;
        return a.index - b.index;
      });

    if (list.style.display !== 'flex') list.style.display = 'flex';
    if (list.style.flexDirection !== 'column') list.style.flexDirection = 'column';
    ranked.forEach(({ row }, order) => {
      const value = String(order);
      if (row.item.style.order !== value) row.item.style.order = value;
    });

    const missing = rows.filter((row) => !row.unavailable && !row.entry && !attempted.has(row.key));
    if (missing.length) hydrate(missing);
  };

  const restoreRows = () => {
    debug('restoreRows');
    const list = findList();
    if (list) {
      list.style.removeProperty('display');
      list.style.removeProperty('flex-direction');
      [...list.children].forEach((el) => el.style.removeProperty('order'));
    }
    document.querySelectorAll(ROW_SELECTOR).forEach((el) => el.style.removeProperty('order'));
    document.querySelectorAll('.sprs-renew').forEach((el) => el.remove());
  };

  const hydrate = async (rows) => {
    if (hydrationInFlight) return;
    hydrationInFlight = true;
    const unique = new Map();
    rows.forEach((row) => {
      attempted.add(row.key);
      unique.set(row.key, row);
    });
    try {
      const list = [...unique.values()];
      for (let i = 0; i < list.length; i += MAX_PRODUCTS_PER_REQUEST) {
        const chunk = list.slice(i, i + MAX_PRODUCTS_PER_REQUEST);
        const body = {
          currencies: [lastCurrency || 'USD'],
          products: chunk.map((row) => ({
            priceTypes: ['purchase', 'renewal'],
            product: {
              productSlug: slugOf(row.tld),
              plan: {
                pricingPlanParams: { transfer: 0, sld: row.sld },
                pricingPlanSlug: row.premium ? 'premium' : 'regular',
                period: 'P1Y',
              },
            },
          })),
          includeFields: ['components', 'modifiers', 'params', 'discount', 'pricePerPeriod', 'outputValues', 'reducers'],
          includeBasePrice: true,
        };
        const serialized = JSON.stringify(body);
        const response = await fetch(PRICE_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: serialized,
        });
        if (!response.ok) continue;
        capturePrices(serialized, await response.json());
      }
    } catch (error) {
      debug('hydrate failed', error);
    } finally {
      hydrationInFlight = false;
      if (enabled) scheduleRender();
    }
  };

  const scheduleRender = () => {
    if (!enabled) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (enabled) sortRows();
    }, 120);
  };

  const setEnabled = (value) => {
    debug('setEnabled', value);
    enabled = Boolean(value);
    writeEnabled(enabled);
    clearTimeout(renderTimer);
    renderTimer = null;
    if (toggleEl) {
      toggleEl.classList.toggle('sprs-toggle--on', enabled);
      toggleEl.setAttribute('aria-checked', String(enabled));
    }
    if (enabled) sortRows();
    else restoreRows();
  };

  const buildToggle = () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sprs-toggle';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', 'false');
    button.title = 'Sort Beast Mode results by renewal price (cheapest renewal first)';
    button.innerHTML =
      '<span class="sprs-toggle__track"><span class="sprs-toggle__thumb"></span></span>' +
      '<span class="sprs-toggle__label">Sort by renewal</span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(!enabled);
    });
    return button;
  };

  const mountToggle = () => {
    const header = document.querySelector('.results__header');
    if (!header) return;
    if (toggleEl && header.contains(toggleEl)) return;
    const anchor = header.querySelector('.results__sort-by') || header;
    if (!toggleEl) toggleEl = buildToggle();
    anchor.insertBefore(toggleEl, anchor.firstChild);
    toggleEl.classList.toggle('sprs-toggle--on', enabled);
    toggleEl.setAttribute('aria-checked', String(enabled));
  };

  const injectStyles = () => {
    if (document.querySelector('style[data-sprs]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-sprs', '1');
    style.textContent = `
      .sprs-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px 5px 6px;
        border: 1px solid #2c2f36;
        border-radius: 999px;
        background: #16181d;
        color: #cfd3dc;
        font: 500 12px/1.2 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        white-space: nowrap;
        transition: border-color .15s ease, background .15s ease, color .15s ease;
      }
      .sprs-toggle:hover { border-color: #3b3f48; color: #fff; }
      .sprs-toggle:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 2px; }
      .sprs-toggle--on { border-color: #4d6bfe; background: rgba(77, 107, 254, .12); color: #fff; }
      .sprs-toggle__track {
        position: relative;
        width: 26px;
        height: 15px;
        border-radius: 999px;
        background: #3a3f49;
        transition: background .15s ease;
        flex: none;
      }
      .sprs-toggle--on .sprs-toggle__track { background: #4d6bfe; }
      .sprs-toggle__thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: #fff;
        transition: transform .15s ease;
      }
      .sprs-toggle--on .sprs-toggle__thumb { transform: translateX(11px); }
      .sprs-renew {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(77, 107, 254, .14);
        color: #9fb0ff;
        font-size: 11px;
        font-weight: 600;
        vertical-align: middle;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  let observer = null;
  const startObserver = () => {
    if (observer) return;
    let scheduled = false;
    observer = new MutationObserver((records) => {
      if (scheduled) return;
      const relevant = records.some((record) => {
        const target = record.target;
        if (!(target instanceof Element)) return false;
        return Boolean(target.closest('.results')) || target.querySelector?.('.results');
      });
      if (!relevant) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        mountToggle();
        if (enabled) scheduleRender();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  const boot = () => {
    injectStyles();
    mountToggle();
    startObserver();
    if (enabled) scheduleRender();
  };

  enabled = readEnabled();
  hookFetch();
  hookXhr();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
