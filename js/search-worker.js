/* بداية عامل البحث: يحتفظ بفهرس مختصر خارج الخيط الرئيسي */
let products = [];
const AR_DIACRITICS = /[ً-ْٰـ]/g;
const AR_ALEF = /[أإآٱ]/g;
const AR_TA_MARBUTA = /ة/g;
const AR_YA = /[ىي]/g;
const AR_WAW = /ؤ/g;
const AR_SPACES = /\s/g;
const normalize = (s) => String(s || "").trim().toLocaleLowerCase("ar-EG").replace(AR_DIACRITICS, "").replace(AR_ALEF, "ا").replace(AR_TA_MARBUTA, "ه").replace(AR_YA, "ي").replace(AR_WAW, "و").replace(AR_SPACES, "");
self.onmessage = (event) => {
  const { type, payload, requestId } = event.data || {};
  if (type === "init") { products = Array.isArray(payload) ? payload : []; self.postMessage({ type: "ready" }); return; }
  if (type !== "search") return;
  const query = normalize(payload?.query), codes = [];
  if (query) for (const item of products) { if (item.text?.includes(query)) { codes.push(item.code); if (codes.length >= 40) break; } }
  self.postMessage({ type: "results", requestId, query: payload?.query || "", codes });
};
/* نهاية عامل البحث */
