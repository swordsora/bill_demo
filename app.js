/* بداية ربط الغلاف الأصلي عند تشغيل APK */
if (!window.InvoiceNative && window.Capacitor?.Plugins?.InvoiceNative) {
  const nativePlugin = window.Capacitor.Plugins.InvoiceNative;
  window.InvoiceNative = {
    saveFile: (payload) => nativePlugin.saveFile(payload),
    savePdf: (payload) => nativePlugin.savePdf(payload || {}),
    writeBackup: (value) => nativePlugin.writeBackup({ value }),
    readBackup: async () => (await nativePlugin.readBackup()).value || "",
    writeSecret: (value) => nativePlugin.writeSecret({ value }),
    readSecret: async () => (await nativePlugin.readSecret()).value || "",
    writeToken: (value) => nativePlugin.writeToken({ value }),
    readToken: async () => (await nativePlugin.readToken()).value || "",
    writeDataFile: (payload) => nativePlugin.writeDataFile(payload),
  };
}
/* نهاية ربط الغلاف الأصلي عند تشغيل APK */
const IDB_NAME = "bill-storage";
const IDB_VERSION = 3;
const IDB_STORE = "kv";
const IDB_FILE_STORE = "database-files";
const IDB_META_STORE = "database-meta";
let idbDatabase = null;
const storageCache = new Map();
let idbReady = false;
function legacyGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function legacyKeys() {
  try {
    return Object.keys(window.localStorage);
  } catch (e) {
    return [];
  }
}
function openIndexedDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE))
        request.result.createObjectStore(IDB_STORE);
      if (!request.result.objectStoreNames.contains(IDB_FILE_STORE))
        request.result.createObjectStore(IDB_FILE_STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(IDB_META_STORE))
        request.result.createObjectStore(IDB_META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || Error("IndexedDB unavailable"));
  });
}
function idbReadAll(db) {
  return new Promise((resolve, reject) => {
    const out = {};
    const tx = db.transaction(IDB_STORE, "readonly"),
      store = tx.objectStore(IDB_STORE),
      req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out[cursor.key] = cursor.value;
        cursor.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}
let _pendingIdbWrites = new Map();
let _idbFlushTimer = 0;
const _dirtyBackupKeys = new Set();
function flushIdbWrites() {
  if (!idbDatabase || !_pendingIdbWrites.size) return;
  const entries = [..._pendingIdbWrites.entries()];
  _pendingIdbWrites.clear();
  try {
    const tx = idbDatabase.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const [key, value] of entries) store.put(value, key);
    tx.onerror = () => entries.forEach(([key, value]) => _pendingIdbWrites.set(key, value));
  } catch (error) {
    entries.forEach(([key, value]) => _pendingIdbWrites.set(key, value));
    logger.error("IDB batch write failed", error);
  }
}
function idbPut(key, value) {
  if (!idbDatabase) return;
  _pendingIdbWrites.set(String(key), String(value));
  clearTimeout(_idbFlushTimer);
  _idbFlushTimer = setTimeout(flushIdbWrites, 300);
}
window.addEventListener("beforeunload", () => { flushIdbWrites(); if (_dirtyBackupKeys.size) updateEncryptedBackup(); });
const appStorage = {
  getItem(key) {
    return storageCache.has(key) ? storageCache.get(key) : legacyGet(key);
  },
  setItem(key, value) {
    const text = String(value);
    storageCache.set(key, text);
    idbPut(key, text);
    if (typeof scheduleAutomaticBackup === "function") scheduleAutomaticBackup(key);
  },
  removeItem(key) {
    storageCache.delete(key);
    if (idbDatabase) {
      try {
        idbDatabase
          .transaction(IDB_STORE, "readwrite")
          .objectStore(IDB_STORE)
          .delete(key);
      } catch (e) {}
    }
  },
  key(index) {
    return [...storageCache.keys()][index] ?? null;
  },
  get length() {
    return storageCache.size;
  },
};
function idbReplaceDatabaseFiles(records, meta) {
  if (!idbDatabase) return;
  try {
    const tx = idbDatabase.transaction(
        [IDB_FILE_STORE, IDB_META_STORE],
        "readwrite",
      ),
      files = tx.objectStore(IDB_FILE_STORE),
      metadata = tx.objectStore(IDB_META_STORE);
    files.clear();
    (records || []).forEach((record) => files.put(record));
    metadata.put(meta || {}, "selected-folder");
  } catch (e) {
    console.warn("IndexedDB database files save failed", e);
  }
}
function idbReadDatabaseFiles() {
  return new Promise((resolve) => {
    if (!idbDatabase) {
      resolve({ records: [], meta: null });
      return;
    }
    try {
      const tx = idbDatabase.transaction(
          [IDB_FILE_STORE, IDB_META_STORE],
          "readonly",
        ),
        files = tx.objectStore(IDB_FILE_STORE),
        metadata = tx.objectStore(IDB_META_STORE),
        records = [],
        cursorRequest = files.openCursor();
      cursorRequest.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          records.push(cursor.value);
          cursor.continue();
        } else {
          const req = metadata.get("selected-folder");
          req.onsuccess = () => resolve({ records, meta: req.result || null });
          req.onerror = () => resolve({ records, meta: null });
        }
      };
      cursorRequest.onerror = () => resolve({ records, meta: null });
    } catch (e) {
      resolve({ records: [], meta: null });
    }
  });
}
async function migrateLegacyStorage() {
  const oldPrefix = String.fromCharCode(116, 97, 119, 111, 111, 115) + ":pwa:";
  const newPrefix = "bill:pwa:";
  const remap = (key) =>
    String(key).startsWith(oldPrefix)
      ? newPrefix + String(key).slice(oldPrefix.length)
      : String(key);
  try {
    for (const key of Object.keys(localStorage)) {
      if (String(key).startsWith(oldPrefix)) {
        const value = localStorage.getItem(key);
        const nk = remap(key);
        if (value !== null && !localStorage.getItem(nk))
          localStorage.setItem(nk, value);
      }
    }
  } catch (e) { console.error("Legacy localStorage migration failed", e); }
  try {
    const legacy = await new Promise((resolve, reject) => {
      const r = indexedDB.open(
        String.fromCharCode(
          116,
          97,
          119,
          111,
          111,
          115,
          45,
          98,
          105,
          108,
          108,
          45,
          115,
          116,
          111,
          114,
          97,
          103,
          101,
        ),
      );
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onupgradeneeded = () => {
        console.warn("Legacy IndexedDB opened for inspection; migration will continue without deleting it.");
      };
    });
    const names = [...legacy.objectStoreNames];
    if (names.includes("kv")) {
      const data = await new Promise((resolve) => {
        const out = {};
        const q = legacy
          .transaction("kv", "readonly")
          .objectStore("kv")
          .openCursor();
        q.onsuccess = () => {
          const c = q.result;
          if (c) {
            out[c.key] = c.value;
            c.continue();
          } else resolve(out);
        };
        q.onerror = () => resolve(out);
      });
      try {
        const backupKey = "bill:pwa:migration-backup:" + new Date().toISOString().slice(0, 10);
        if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, JSON.stringify(data));
      } catch (backupError) { console.error("Could not create migration backup", backupError); }
      for (const [k, v] of Object.entries(data)) {
        const nk = remap(k);
        if (!storageCache.has(nk)) storageCache.set(nk, String(v));
      }
    }
    legacy.close();
  } catch (e) { console.error("Legacy IndexedDB migration failed", e); }
}

async function initIndexedStorage() {
  try {
    await migrateLegacyStorage();
    idbDatabase = await openIndexedDb();
    if (idbDatabase) {
      const data = await idbReadAll(idbDatabase);
      Object.entries(data).forEach(([key, value]) =>
        storageCache.set(key, String(value)),
      );
      for (const key of legacyKeys()) {
        if (!storageCache.has(key)) {
          const value = legacyGet(key);
          if (value !== null) {
            storageCache.set(key, value);
            idbPut(key, value);
          }
        }
      }
      idbReady = true;
    }
  } catch (e) {
    for (const key of legacyKeys()) {
      const value = legacyGet(key);
      if (value !== null) storageCache.set(key, value);
    }
  }
}
const $ = (s) => {
  try {
    return document.querySelector(s);
  } catch (e) {
    return null;
  }
};
const logger = {
  error: (message, context) => console.error(message, context || ""),
  warn: (message, context) => console.warn(message, context || ""),
  info: (message, context) => console.info(message, context || ""),
};
window.addEventListener("error", (e) => logger.error("Application Error:", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => {
  logger.error("Application Unhandled Rejection:", e.reason);
});
const els = {
  search: $("#productSearch"),
  suggestions: $("#suggestions"),
  qty: $("#quantity"),
  price: $("#selectedPrice"),
  selected: $("#selectedProduct"),
  items: $("#invoiceItems"),
  itemsCount: $("#itemsCount"),
  totalQty: $("#totalQty"),
  grand: $("#grandTotal"),
  toast: $("#toast"),
};
let products = [],
  customers = [],
  customerHistory = [],
  cart = [],
  selected = null,
  priceMode = "wholesale",
  activeSuggestion = -1,
  deferredPrompt = null,
  searchTimer = 0,
  searchWorker = null,
  scannerTimer = 0,
  scannerControls = null,
  scannerStream = null,
  scannerTorchOn = false,
  scannerMode = "",
  scannerSession = 0,
  advanceUnlocked = false,
  advanceLocked = appStorage.getItem("bill:pwa:advance-locked") === "1",
  pendingRegistration = null;
/* ==================== بداية الإعدادات الحساسة المشفرة ==================== */
const ADVANCE_PASSWORD_KEY = "bill:pwa:advance-password";
const LIMIT_PASSWORD_KEY = "bill:pwa:limit-password";
const ACTIVATION_PASSWORD_KEY = "bill:pwa:activation-password";
const SETTINGS_VAULT_KEY = "bill:pwa:secure-settings-v1";
const DEFAULT_ADVANCE_PASSWORD = String.fromCharCode(51,54,57,51,50,49,57,53,49,83,97,105,102);
const DEFAULT_LIMIT_PASSWORD = String.fromCharCode(55,52,49,55,56,57,49,53,57,83,97,105,102);
const DEFAULT_ACTIVATION_PASSWORD = String.fromCharCode(83,97,105,102,95,83,101,114,118,101,114,95,65,99,116,105,118,101,116,101);
const DEFAULT_DEVELOPER_PASSWORD = String.fromCharCode(50,53,56,42,51,53,55,42,49,53,57,42,54,53,52);
const DEFAULT_UNLOCK_PASSWORD = String.fromCharCode(90,97,120,99,101,108);
const DEFAULT_PRICE_LIMIT_RATIO = 0.30;
const SECURE_SETTINGS_SEED = String.fromCharCode(98,105,108,108,45,115,101,116,116,105,110,103,115,45,118,49,45,108,111,99,97,108,45,101,110,118,101,108,111,112,101);
let ADVANCE_PASSWORD = DEFAULT_ADVANCE_PASSWORD;
let LIMIT_PASSWORD = DEFAULT_LIMIT_PASSWORD;
let ACTIVATION_PASSWORD = DEFAULT_ACTIVATION_PASSWORD;
/* ==================== نهاية الإعدادات الحساسة المشفرة ==================== */
const savedPriceLimit = appStorage.getItem("bill:pwa:price-limit"),
  parsedPriceLimit = Number(savedPriceLimit);
let priceLimitRatio =
    (savedPriceLimit === null ||
    !Number.isFinite(parsedPriceLimit) ||
    parsedPriceLimit < 0 ||
    parsedPriceLimit > 100
      ? 30
      : parsedPriceLimit) / 100,
  modalResolve = null,
  confirmResolve = null;
const secureModalQueue = [], confirmModalQueue = [];
const KEY = "bill:pwa:invoices",
  PRODKEY = "bill:pwa:products:v2",
  HISTORY_KEY = "bill:pwa:history-collapsed",
  USERS_KEY = "bill:pwa:users",
  SESSION_KEY = "bill:pwa:session",
  SESSION_DAY_KEY = "bill:pwa:session-day",
  ADMIN_LOG_KEY = "bill:pwa:admin-log";
const HISTORY_MAX_ITEMS = 200;
const HISTORY_MAX_ROWS = 5000;
function historyKey(code) {
  return String(code ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\.0+$/, "").trim();
}
function makeId(prefix = "id") {
  try { if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`; } catch (e) { logger.warn("Secure UUID unavailable", e); }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
const DEVELOPER_USERNAME = "Saif_Eldin_Ryhan";
let DEVELOPER_PASSWORD = DEFAULT_DEVELOPER_PASSWORD;
let ZAXCEL_PASSWORD = DEFAULT_UNLOCK_PASSWORD;
const PASSWORD_FAILURES_KEY = "bill:pwa:password-failures",
  DEVICE_BLOCKED_KEY = "bill:pwa:device-blocked";
/* ============ GUEST MODE ============ */
const GUEST_SESSION_KEY = "bill:pwa:guest-session";
const GUEST_LOCK_KEY    = "bill:pwa:guest-locked-until";
const GUEST_ENABLED_KEY = "bill:pwa:guest-enabled";
const GUEST_DURATION_MS = 10 * 60 * 1000;        // 10 دقائق
const GUEST_LOCKOUT_MS  = 24 * 60 * 60 * 1000;   // 24 ساعة
let guestTimerId = null;
let dataFolderReady = false,
  usersFileReady = false,
  usersFileUsers = [],
  mdbSelected = false,
  selectedSourceFiles = new Map();
function isPrimaryDeveloperAttempt() {
  return (
    currentUser?.username === DEVELOPER_USERNAME ||
    $("#loginUsername")?.value.trim() === DEVELOPER_USERNAME
  );
}
function readPasswordFailures() {
  try {
    return JSON.parse(appStorage.getItem(PASSWORD_FAILURES_KEY) || "{}");
  } catch {
    return {};
  }
}
function recordPasswordFailure(kind) {
  const failures = readPasswordFailures();
  failures[kind] = (Number(failures[kind]) || 0) + 1;
  appStorage.setItem(PASSWORD_FAILURES_KEY, JSON.stringify(failures));
  return failures[kind];
}
function clearPasswordFailure(kind) {
  const failures = readPasswordFailures();
  delete failures[kind];
  appStorage.setItem(PASSWORD_FAILURES_KEY, JSON.stringify(failures));
}
async function blockCurrentDevice() {
  if (isPrimaryDeveloperAttempt()) return;
  appStorage.setItem(DEVICE_BLOCKED_KEY, "1");
  try {
    await centralRequest("/devices/block-self", {
      method: "POST",
      body: JSON.stringify(getDeviceProfile()),
    });
  } catch (e) {}
  clearSession();
  toast(
    "تم حظر هذا الجهاز وتسجيل الخروج لا يمكن الدخول منه إلا بعد تفعيل المطوّر الأساسي.",
  );
  updateGuestUI();
}


function isGuestMode() {
  const started = Number(appStorage.getItem(GUEST_SESSION_KEY) || 0);
  return started > 0 && Date.now() - started < GUEST_DURATION_MS;
}
function guestRemainingMs() {
  const started = Number(appStorage.getItem(GUEST_SESSION_KEY) || 0);
  return started ? Math.max(0, GUEST_DURATION_MS - (Date.now() - started)) : 0;
}
function guestLockRemainingMs() {
  const until = Number(appStorage.getItem(GUEST_LOCK_KEY) || 0);
  return Math.max(0, until - Date.now());
}
function formatGuestMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function startGuestTimer() {
  if (guestTimerId) clearInterval(guestTimerId);
  updateGuestUI();
  guestTimerId = setInterval(() => {
    if (!isGuestMode()) { endGuestSession("expired"); return; }
    updateGuestUI();
  }, 1000);
}
function updateGuestUI() {
  const banner = $("#guestBanner");
  const timer  = $("#guestTimer");
  if (banner) {
    if (isGuestMode()) {
      banner.classList.remove("hidden");
      if (timer) timer.textContent = formatGuestMs(guestRemainingMs());
    } else {
      banner.classList.add("hidden");
    }
  }
  const btn = $("#guestModeButton");
  if (btn) {
    const lock = guestLockRemainingMs();
    if (isGuestMode()) {
      btn.disabled = true;
      btn.textContent = "وضع الضيف مُفعَّل حاليًا";
    } else if (lock > 0) {
      btn.disabled = true;
      const h = Math.ceil(lock / 3600000);
      btn.textContent = `وضع الضيف متاح بعد ${h} ساعة`;
    } else {
      btn.disabled = false;
      btn.textContent = "دخول كوضع الضيف (10 دقائق)";
    }
  }
}
function startGuestSession() {
  if (appStorage.getItem(GUEST_ENABLED_KEY) === "0") { toast("وضع الضيف معطل بواسطة المطور الأساسي"); return false; }
  if (isGuestMode()) return true;
  if (guestLockRemainingMs() > 0) {
    const h = Math.ceil(guestLockRemainingMs() / 3600000);
    toast(`وضع الضيف غير متاح. تبقى ${h} ساعة تقريبًا.`);
    return false;
  }
  appStorage.setItem(GUEST_SESSION_KEY, String(Date.now()));
  clearSession();
  setSession({ username: "ضيف", role: "user", guest: true, active: true });
  startGuestTimer();
  toast("تم تفعيل وضع الضيف لمدة 10 دقائق");
  return true;
}
function endGuestSession(reason = "expired") {
  if (guestTimerId) { clearInterval(guestTimerId); guestTimerId = null; }
  appStorage.removeItem(GUEST_SESSION_KEY);
  // قفل 24 ساعة عند أي خروج (يدوي أو انتهاء وقت)
  appStorage.setItem(GUEST_LOCK_KEY, String(Date.now() + GUEST_LOCKOUT_MS));
  if (currentUser?.guest) clearSession();
  updateGuestUI();
  if (reason === "expired") toast("انتهى وضع الضيف. لن يتاح مرة أخرى إلا بعد 24 ساعة.");
  else if (reason === "manual") toast("تم إنهاء وضع الضيف. لن يتاح مرة أخرى إلا بعد 24 ساعة.");
}
async function securePassword(kind, title, message, expected) {
  if (isGuestMode()) {
    toast("وضع الضيف لا يملك صلاحية فتح هذه الإدارة");
    return null;
  }
    const max = kind === "activation" ? 3 : 2;
  for (;;) {
    const key = await openSecureModal(title, message);
    if (key === null) return null;
    if (key === expected) {
      clearPasswordFailure(kind);
      toast("تم التحقق من كلمة المرور بنجاح");
      return key;
    }
    if (isPrimaryDeveloperAttempt()) {
      $("#modalError").textContent = "كلمة المرور غير صحيحة؛ أعد المحاولة";
      toast("كلمة المرور غير صحيحة؛ أعد المحاولة");
      continue;
    }
    const count = recordPasswordFailure(kind);
    const remaining = max - count;
    if (remaining > 0) {
      $("#modalError").textContent =
        `كلمة المرور غير صحيحة. المحاولات المتبقية: ${remaining}`;
      toast(`كلمة المرور غير صحيحة. المتبقي: ${remaining}`);
      continue;
    }
    if (kind === "activation") {
      await blockCurrentDevice();
      return null;
    }
    toast("تم استنفاد المحاولات؛ سيتم طلب كلمة مرور التفعيل");
    return "__ESCALATE__";
  }
}

const DEFAULT_USERS = [
  {
    username: DEVELOPER_USERNAME,
    password: DEVELOPER_PASSWORD,
    role: "developer",
    active: true,
  },
  { username: "مستخدم تجريبي", password: "4321", role: "user", active: true },
];
let currentUser = null;

/* ==================== بداية التشفير والصلاحيات ==================== */
const FEATURE_PERMISSIONS_KEY = "bill:pwa:feature-permissions-v1";
const INVENTORY_KEY = "bill:pwa:inventories-v1";
const EMPLOYEES_KEY = "bill:pwa:employees-v1";
const EMPLOYEE_DEPARTMENTS_KEY = "bill:pwa:employee-departments-v1";
const INVOICE_EDIT_ACCESS_KEY = "bill:pwa:invoice-edit-access-v1";
const ENCRYPTED_BACKUP_KEY = "bill:pwa:encrypted-backup-v1";
const BACKUP_RESTORE_MARKER = "bill:pwa:backup-restored-v1";
let backupTimer = 0;
let backupRunning = false;
const FEATURE_DEFINITIONS = Object.freeze([
  { key: "userManagement", label: "إدارة المستخدمين", defaultRole: "developer" },
  { key: "employeeManagement", label: "إدارة الموظفين", defaultRole: "developer" },
  { key: "productManagement", label: "إدارة المنتجات", defaultRole: "developer" },
  { key: "customerManagement", label: "إدارة العملاء", defaultRole: "developer" },
  { key: "inventory", label: "جرد المخزون", defaultRole: "developer" },
  { key: "priceEdit", label: "تعديل السعر", defaultRole: "user" },
  { key: "productDetails", label: "معلومات المنتج", defaultRole: "user" },
  { key: "productLookup", label: "بحث معلومات المنتج", defaultRole: "user" },
  { key: "priceSettings", label: "إعدادات نسبة الأسعار", defaultRole: "user" },
  { key: "databaseExport", label: "تصدير واستيراد البيانات", defaultRole: "developer" },
  { key: "loginAttempts", label: "مراقبة محاولات الدخول", defaultRole: "developer" },
  { key: "deviceManagement", label: "إدارة الأجهزة", defaultRole: "primary" }
]);
const FEATURE_ROLE_LEVEL = Object.freeze({ user: 1, developer: 2, primary: 3 });

function bytesToBase64(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function base64ToBytes(value) {
  const text = atob(String(value || ""));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
let _secureKeyPromise = null;
async function getSecureSettingsKey() {
  if (_secureKeyPromise) return _secureKeyPromise;
  if (!globalThis.crypto?.subtle) throw Error("التشفير غير متاح في هذا المتصفح");
  _secureKeyPromise = (async () => {
    const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECURE_SETTINGS_SEED),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: new TextEncoder().encode("invoice-local-v1"), iterations: 180000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  return _secureKeyPromise;
}
async function encryptSecureObject(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getSecureSettingsKey();
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { version: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher)) };
}
async function decryptSecureObject(value) {
  if (!value || value.version !== 1 || !value.iv || !value.data) throw Error("بيانات مشفرة غير صالحة");
  const key = await getSecureSettingsKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(value.iv) },
    key,
    base64ToBytes(value.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
async function persistSecureSettings() {
  const settings = {
    advancePassword: ADVANCE_PASSWORD,
    limitPassword: LIMIT_PASSWORD,
    activationPassword: ACTIVATION_PASSWORD,
    developerPassword: DEVELOPER_PASSWORD,
    unlockPassword: ZAXCEL_PASSWORD,
  };
  if (window.InvoiceNative?.writeSecret) {
    await window.InvoiceNative.writeSecret(JSON.stringify(settings));
    appStorage.removeItem(SETTINGS_VAULT_KEY);
    return;
  }
  const payload = await encryptSecureObject(settings);
  appStorage.setItem(SETTINGS_VAULT_KEY, JSON.stringify(payload));
}
function applySecureSettings(value) {
  if (typeof value?.advancePassword === "string") ADVANCE_PASSWORD = value.advancePassword;
  if (typeof value?.limitPassword === "string") LIMIT_PASSWORD = value.limitPassword;
  if (typeof value?.activationPassword === "string") ACTIVATION_PASSWORD = value.activationPassword;
  if (typeof value?.developerPassword === "string") DEVELOPER_PASSWORD = value.developerPassword;
  if (typeof value?.unlockPassword === "string") ZAXCEL_PASSWORD = value.unlockPassword;
  if (Array.isArray(DEFAULT_USERS) && DEFAULT_USERS[0]) DEFAULT_USERS[0].password = DEVELOPER_PASSWORD;
}
async function loadSecureSettings() {
  if (window.InvoiceNative?.readSecret) {
    try {
      const nativeRaw = await window.InvoiceNative.readSecret();
      if (nativeRaw) {
        applySecureSettings(JSON.parse(nativeRaw));
        return true;
      }
    } catch (error) {
      console.warn("Native secure settings could not be opened", error);
    }
  }
  const raw = appStorage.getItem(SETTINGS_VAULT_KEY);
  if (raw) {
    try {
      const value = await decryptSecureObject(JSON.parse(raw));
      applySecureSettings(value);
      return true;
    } catch (error) {
      console.warn("Secure settings could not be opened", error);
    }
  }
  const legacyAdvance = appStorage.getItem(ADVANCE_PASSWORD_KEY);
  const legacyLimit = appStorage.getItem(LIMIT_PASSWORD_KEY);
  const legacyActivation = appStorage.getItem(ACTIVATION_PASSWORD_KEY);
  if (legacyAdvance) ADVANCE_PASSWORD = legacyAdvance;
  if (legacyLimit) LIMIT_PASSWORD = legacyLimit;
  if (legacyActivation) ACTIVATION_PASSWORD = legacyActivation;
  appStorage.removeItem(ADVANCE_PASSWORD_KEY);
  appStorage.removeItem(LIMIT_PASSWORD_KEY);
  appStorage.removeItem(ACTIVATION_PASSWORD_KEY);
  if (Array.isArray(DEFAULT_USERS) && DEFAULT_USERS[0]) DEFAULT_USERS[0].password = DEVELOPER_PASSWORD;
  await persistSecureSettings();
  return false;
}
function isPrimaryDeveloper(user = currentUser) {
  return Boolean(user && user.username === DEVELOPER_USERNAME);
}
function getFeaturePermissions() {
  const defaults = Object.fromEntries(FEATURE_DEFINITIONS.map((item) => [item.key, item.defaultRole]));
  try {
    const saved = JSON.parse(appStorage.getItem(FEATURE_PERMISSIONS_KEY) || "{}");
    for (const item of FEATURE_DEFINITIONS) {
      if (["user", "developer", "primary"].includes(saved?.[item.key])) defaults[item.key] = saved[item.key];
    }
  } catch (error) {}
  return defaults;
}
function saveFeaturePermissions(value) {
  const valid = {};
  for (const item of FEATURE_DEFINITIONS) {
    valid[item.key] = ["user", "developer", "primary"].includes(value?.[item.key])
      ? value[item.key]
      : item.defaultRole;
  }
  appStorage.setItem(FEATURE_PERMISSIONS_KEY, JSON.stringify(valid));
  return valid;
}
function hasFeatureAccess(key, user = currentUser) {
  if (!user) return false;
  if (user.guest) {
    return ![
      "userManagement", "employeeManagement", "productManagement", "customerManagement", "inventory",
      "priceEdit", "productDetails", "productLookup", "priceSettings", "databaseExport",
      "loginAttempts", "deviceManagement",
    ].includes(key);
  }
  const required = getFeaturePermissions()[key] || "primary";
  const level = isPrimaryDeveloper(user) ? FEATURE_ROLE_LEVEL.primary : FEATURE_ROLE_LEVEL[user.role] || 0;
  return level >= (FEATURE_ROLE_LEVEL[required] || FEATURE_ROLE_LEVEL.primary);
}
function requireFeatureAccess(key, message) {
  if (hasFeatureAccess(key)) return true;
  toast(message || "هذه الخاصية غير متاحة لنوع الحساب الحالي");
  return false;
}
function applyFeatureAccess() {
  const controls = {
    accountManageUsers: "userManagement",
    accountManageEmployees: "employeeManagement",
    accountManageProducts: "productManagement",
    accountProductLookup: "productLookup",
    accountManageCustomers: "customerManagement",
    accountInventory: "inventory",
    accountPriceSettings: "priceSettings",
    exportDatabasePackage: "databaseExport",
    accountLoginAttempts: "loginAttempts",
    accountManageDevices: "deviceManagement",
  };
  Object.entries(controls).forEach(([id, key]) => {
    const element = $("#" + id);
    if (element) element.classList.toggle("hidden", !hasFeatureAccess(key));
  });
  const passwordButton = $("#accountManagePasswords");
  if (passwordButton) passwordButton.classList.toggle("hidden", !isPrimaryDeveloper());
  const permissionsButton = $("#accountManagePermissions");
  if (permissionsButton) permissionsButton.classList.toggle("hidden", !isPrimaryDeveloper());
}
function backupPayload() {
  const storage = {};
  for (const [key, value] of storageCache.entries()) {
    if (!String(key).startsWith("bill:pwa:") || key === ENCRYPTED_BACKUP_KEY || key === BACKUP_RESTORE_MARKER) continue;
    storage[key] = value;
  }
  return { version: 1, createdAt: new Date().toISOString(), storage };
}
async function updateEncryptedBackup() {
  if (backupRunning) return;
  backupRunning = true;
  try {
    const record = await encryptSecureObject(backupPayload());
    const serialized = JSON.stringify(record);
    appStorage.setItem(ENCRYPTED_BACKUP_KEY, serialized);
    if (window.InvoiceNative?.writeBackup) await window.InvoiceNative.writeBackup(serialized);
  } catch (error) {
    console.warn("Encrypted backup could not be written", error);
  } finally {
    backupRunning = false;
  }
}
function scheduleAutomaticBackup(key) {
  if (!String(key || "").startsWith("bill:pwa:") || key === ENCRYPTED_BACKUP_KEY || key === BACKUP_RESTORE_MARKER) return;
  _dirtyBackupKeys.add(key);
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    if (backupRunning) { scheduleAutomaticBackup(""); return; }
    updateEncryptedBackup();
    _dirtyBackupKeys.clear();
  }, 10000);
}
async function restoreNativeBackupIfNeeded() {
  if (!window.InvoiceNative?.readBackup || appStorage.getItem(BACKUP_RESTORE_MARKER)) return false;
  const hasLocalData = Boolean(appStorage.getItem(KEY) || appStorage.getItem(PRODKEY));
  if (hasLocalData) return false;
  try {
    const serialized = await window.InvoiceNative.readBackup();
    if (!serialized) return false;
    const payload = await decryptSecureObject(JSON.parse(serialized));
    if (!payload?.storage || typeof payload.storage !== "object") throw Error("نسخة احتياطية غير صالحة");
    Object.entries(payload.storage).forEach(([key, value]) => appStorage.setItem(key, value));
    appStorage.setItem(BACKUP_RESTORE_MARKER, new Date().toISOString());
    toast("تمت استعادة النسخة الاحتياطية المشفرة");
    return true;
  } catch (error) {
    console.warn("Native backup restore skipped", error);
    return false;
  }
}
/* ==================== نهاية التشفير والصلاحيات ==================== */
const CENTRAL_DEFAULT =
    "https://3000-icvfeaxb8zgobmqlkioua-a3ed9d5f.us3.manus.computer/api/local",
  DEVICE_ID_KEY = "bill:pwa:device-id",
  CENTRAL_TOKEN_KEY = "bill:pwa:central-token";
function getDeviceId() {
  let id = appStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    appStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
function getDeviceProfile() {
  const ua = navigator.userAgent || "";
  const platform = /Android/i.test(ua)
    ? "android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "ios"
      : /Windows/i.test(ua)
        ? "windows"
        : /Macintosh/i.test(ua)
          ? "macos"
          : /Linux/i.test(ua)
            ? "linux"
            : "web";
  return {
    deviceId: getDeviceId(),
    deviceName: `${platform === "android" ? "هاتف Android" : platform === "ios" ? "هاتف iPhone" : platform === "windows" ? "كمبيوتر Windows" : platform === "macos" ? "كمبيوتر Mac" : platform === "linux" ? "كمبيوتر Linux" : "متصفح ويب"} · ${navigator.platform || "web"}`,
    platform,
  };
}
function formatInvoiceTime(date = new Date()) {
  const value = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return value.replace(/\sAM$/, " صباحًا").replace(/\sPM$/, " مساءً");
}
async function centralRequest(path, options = {}) {
  const cfg = window.BILL_CENTRAL_CONFIG || {},
    base = String(cfg.baseUrl || CENTRAL_DEFAULT).replace(/\/$/, "");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 8000);
  try {
    const token = window.InvoiceNative?.readToken
      ? await window.InvoiceNative.readToken().catch(() => "")
      : appStorage.getItem(CENTRAL_TOKEN_KEY);
    if (typeof cfg.request === "function")
      return await cfg.request(
        path,
        {
          ...options,
          headers: { ...(cfg.headers || {}), ...(options.headers || {}) },
        },
        { token },
      );
    const response = await fetch(`${base}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Error(data.error || "تعذر الاتصال بالخادم المركزي");
      error.code =
        data.code ||
        data.errorCode ||
        (response.status === 403 ? "FORBIDDEN" : "CENTRAL_ERROR");
      error.status = response.status;
      error.serverData = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError" || error instanceof TypeError) {
      const networkError = Error(
        "تعذر الاتصال بالخادم المركزي. تحقق من الاتصال.",
      );
      networkError.networkError = true;
      networkError.code = "NETWORK_ERROR";
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function openScanner(mode) {
  await stopScanner();
  const session = ++scannerSession;
  scannerMode = mode;
  const modal = $("#scannerModal"),
    video = $("#scannerVideo"),
    message = $("#scannerMessage"),
    torchButton = $("#scannerTorch"),
    zoomControl = $("#scannerZoom");
  if (!modal || !video || !message) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  $("#scannerTitle").textContent =
    mode === "product" ? "مسح باركود المنتج" : "";
  message.textContent = "جاري تشغيل الكاميرا...";
  if (torchButton) torchButton.classList.add("hidden");
  if (zoomControl) {
    zoomControl.classList.add("hidden");
    zoomControl.value = "1";
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("camera unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    });
    if (session !== scannerSession) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    scannerStream = stream;
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks?.()[0],
      caps = track?.getCapabilities?.() || {};
    if (torchButton && caps.torch) {
      torchButton.classList.remove("hidden");
      torchButton.textContent = "تشغيل الكشاف";
      torchButton.onclick = () => toggleScannerTorch(track, torchButton);
    }
    if (zoomControl && caps.zoom) {
      zoomControl.classList.remove("hidden");
      zoomControl.min = String(caps.zoom.min ?? 1);
      zoomControl.max = String(caps.zoom.max ?? 4);
      zoomControl.step = String(caps.zoom.step ?? 0.1);
      zoomControl.value = String(caps.zoom.min ?? 1);
      zoomControl.oninput = () => setScannerZoom(track, zoomControl);
    }
    let detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats(),
          formats = [
            "aztec",
            "codabar",
            "code_128",
            "code_39",
            "code_93",
            "data_matrix",
            "ean_13",
            "ean_8",
            "itf",
            "pdf417",
            "qr_code",
            "upc_a",
            "upc_e",
          ].filter((x) => supported.includes(x));
        if (formats.length) detector = new BarcodeDetector({ formats });
      } catch (e) {}
    }
    message.textContent =
      mode === "product"
        ? "وجّه الكاميرا إلى الباركود"
        : "وجّه الكاميرا إلى الباركود";
    let lastRaw = "",
      lastAt = 0,
      busy = false;
    const deliver = async (raw) => {
      if (
        !raw ||
        busy ||
        session !== scannerSession ||
        (raw === lastRaw && Date.now() - lastAt < 1200)
      )
        return;
      lastRaw = raw;
      lastAt = Date.now();
      busy = true;
      try {
        await processScannedValue(raw);
      } finally {
        busy = false;
      }
    };
    const scanNative = async () => {
      if (session !== scannerSession || !scannerStream) return;
      try {
        const found = detector ? await detector.detect(video) : null;
        const raw = found?.[0]?.rawValue || "";
        if (raw) await deliver(raw);
      } catch (e) {}
      if (session === scannerSession && scannerStream)
        scannerTimer = requestAnimationFrame(scanNative);
    };
    if (detector) {
      scannerTimer = requestAnimationFrame(scanNative);
      return;
    }
    if (window.ZXingBrowser?.BrowserMultiFormatReader) {
      try {
        const reader = new ZXingBrowser.BrowserMultiFormatReader();
        scannerControls = await reader.decodeFromVideoElement(
          video,
          async (result) => {
            if (session !== scannerSession) return;
            await deliver(result?.getText?.() || result?.text || "");
          },
        );
        return;
      } catch (e) {
        scannerControls = null;
      }
    }
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    const scanFallback = async () => {
      if (session !== scannerSession || !scannerStream) return;
      try {
        if (window.jsQR && video.readyState >= 2) {
          const width = Math.min(video.videoWidth || 640, 960),
            height = Math.min(video.videoHeight || 480, 720);
          if (width && height) {
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height),
              raw =
                window.jsQR(imageData.data, width, height, {
                  inversionAttempts: "attemptBoth",
                })?.data || "";
            if (raw) await deliver(raw);
          }
        }
      } catch (e) {}
      if (session === scannerSession && scannerStream)
        scannerTimer = requestAnimationFrame(scanFallback);
    };
    scannerTimer = requestAnimationFrame(scanFallback);
  } catch (error) {
    if (session === scannerSession)
      message.textContent =
        "تعذر تشغيل الكاميرا. استخدم زر اختيار صورة أو باركود.";
  }
}
async function centralLogin(username, password) {
  const data = await centralRequest("/login", {
    method: "POST",
    body: JSON.stringify({ username, password, ...getDeviceProfile() }),
  });
  if (window.InvoiceNative?.writeToken) await window.InvoiceNative.writeToken(data.token);
  else appStorage.setItem(CENTRAL_TOKEN_KEY, data.token);
  appStorage.setItem(
    "bill:pwa:central-device",
    JSON.stringify(data.device || {}),
  );
  return data.user;
}
async function syncCentralDevice() {
  if (!appStorage.getItem(CENTRAL_TOKEN_KEY)) return;
  try {
    const data = await centralRequest("/heartbeat", {
      method: "POST",
      body: JSON.stringify(getDeviceProfile()),
    });
    if (data.device?.status === "blocked") {
      clearSession();
      toast("هذا الجهاز محظور من المطوّر");
    }
  } catch (e) {}
}
function saveUsers(users) {
  const safe = (Array.isArray(users) ? users : [])
    .filter(
      (u) =>
        u &&
        u.username !== DEVELOPER_USERNAME &&
        u.username !== "شيماء عبدالجواد" &&
        u.username !== "سيف الدين ريحان",
    )
    .map((u) => ({
      ...u,
      active: u.active !== false,
      role: u.role === "developer" ? "developer" : "user",
    }));
  appStorage.setItem(USERS_KEY, JSON.stringify(safe));
  return safe;
}
function getUsers() {
  let users = [];
  try {
    const raw = appStorage.getItem(USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) users = parsed;
  } catch (e) {}
  users = users
    .filter(
      (u) =>
        u &&
        u.username !== DEVELOPER_USERNAME &&
        u.username !== "شيماء عبدالجواد" &&
        u.username !== "سيف الدين ريحان",
    )
    .map((u) => ({
      ...u,
      active: u.active !== false,
      role: u.role === "developer" ? "developer" : "user",
    }));
  if (!users.some((u) => u.username === "مستخدم تجريبي"))
    users.push({ ...DEFAULT_USERS[1] });
  saveUsers(users);
  return [{ ...DEFAULT_USERS[0] }, ...users];
}
function save() {
  if (!cart.length) {
    toast("أضف منتجًا واحدًا على الأقل");
    return;
  }
  const data = invoiceData(),
    all = JSON.parse(appStorage.getItem(KEY) || "[]");
  all.unshift(data);
  appStorage.setItem(KEY, JSON.stringify(all.slice(0, 500)));
  const code = historyKey(data.customerCode);
  if (code) {
    const previous = customerHistory.find((x) => historyKey(x.customerCode) === code);
    const items = data.cart.map((x) => {
      const unit = Number(x.customPrice ?? unitPriceFor(x.product));
      const prior = previous?.items?.find((item) => String(item.code) === String(x.product.code));
      return {
        code: String(x.product.code),
        name: String(x.customName ?? x.product.name),
        lastPrice: unit,
        lastQty: Number(x.qty) || 0,
        mode: data.priceMode,
        lastSeen: data.date || new Date().toISOString(),
        timesBought: Number(prior?.timesBought || 0) + 1,
      };
    }).slice(0, HISTORY_MAX_ITEMS);
    const entry = { customerCode: code, invoiceCount: Number(previous?.invoiceCount || 0) + 1, items };
    customerHistory = [
      ...customerHistory.filter((x) => historyKey(x.customerCode) !== code),
      entry,
    ].slice(-HISTORY_MAX_ROWS);
    appStorage.setItem(
      "bill:pwa:customer-history:v1",
      JSON.stringify(customerHistory),
    );
  }
  renderSaved();
  if (code) renderCustomer(code);
  toast(" حفظ الفاتورة");
}
function recordAdminLog(action, target, details = "") {
  const logs = JSON.parse(appStorage.getItem(ADMIN_LOG_KEY) || "[]");
  logs.unshift({
    id: makeId("admin"),
    time: new Date().toISOString(),
    actor: currentUser?.username || "system",
    action,
    target,
    details,
  });
  appStorage.setItem(ADMIN_LOG_KEY, JSON.stringify(logs.slice(0, 500)));
}
function renderAdminLog() {
  const box = $("#adminLog");
  if (!box) return;
  const logs = JSON.parse(appStorage.getItem(ADMIN_LOG_KEY) || "[]");
  box.innerHTML = logs.length
    ? logs
        .slice(0, 30)
        .map(
          (x) =>
            `<div class="log-row"><strong>${escapeHtml(x.action)}</strong><span>${escapeHtml(x.target)}</span><small>${escapeHtml(x.actor)} · ${escapeHtml(new Date(x.time).toLocaleString("ar-EG"))}</small></div>`,
        )
        .join("")
    : '<div class="empty-row">لا توجد عمليات مسجلة</div>';
}
function availableUsers() {
  let stored = [];
  try {
    const raw = appStorage.getItem(USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) stored = parsed;
  } catch (e) {}
  const merged = [];
  [...DEFAULT_USERS, ...stored, ...usersFileUsers].forEach((user) => {
    if (!user || !String(user.username || "").trim()) return;
    const i = merged.findIndex((x) => x.username === user.username);
    if (i >= 0) merged[i] = user;
    else merged.push(user);
  });
  return merged;
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function setSession(user) {
  currentUser = user;
  advanceUnlocked = false;
  appStorage.setItem(SESSION_KEY, user.username);
  appStorage.setItem(SESSION_DAY_KEY, todayKey());
  $("#authGate")?.classList.add("hidden");
  $("#appMain")?.classList.add("app-unlocked");
  $("#logoutUser")?.classList.remove("hidden");
  const manager = $("#manageUsers");
  if (manager) manager.classList.toggle("hidden", !hasFeatureAccess("employeeManagement", user));
  applyFeatureAccess();
  renderCart();
  renderUserList();
}
function clearSession() {
  currentUser = null;
  advanceUnlocked = false;
  appStorage.removeItem(CENTRAL_TOKEN_KEY);
  appStorage.removeItem("bill:pwa:central-device");
  appStorage.removeItem(SESSION_KEY);
  appStorage.removeItem(SESSION_DAY_KEY);
  $("#authGate")?.classList.remove("hidden");
  $("#appMain")?.classList.remove("app-unlocked");
  applyFeatureAccess();
}
function toggleGuestAvailability() { if (!isPrimaryDeveloper()) { toast("هذه الخاصية للمطور الأساسي فقط"); return; } const enabled = appStorage.getItem(GUEST_ENABLED_KEY) !== "0"; appStorage.setItem(GUEST_ENABLED_KEY, enabled ? "0" : "1"); toast(enabled ? "تم تعطيل وضع الضيف" : "تم تفعيل وضع الضيف"); updateGuestUI(); }
function openAccountMenu() {
  if (!currentUser) return;
  $("#accountUserLabel").textContent =
    `المستخدم الحالي ${currentUser.username} ${isPrimaryDeveloper() ? "المطور الأساسي" : currentUser.role === "developer" ? "مطوّر" : "حساب عادي"}`;
  applyFeatureAccess();
  $("#accountMenuModal").classList.remove("hidden");
}
function closeAccountMenu() {
  $("#accountMenuModal")?.classList.add("hidden");
}
async function renderDevices() {
  const box = $("#devicesList");
  if (!box) return;
  box.innerHTML = '<div class="empty-row">جاري تحميل الأجهزة...</div>';
  try {
    const data = await centralRequest("/devices");
    const devices = data.devices || [];
    box.innerHTML = devices.length
      ? devices
          .map((x) => {
            const d = x.device || x,
              a = x.account || {};
            const status =
              d.status === "blocked"
                ? "محظور"
                : d.status === "revoked"
                  ? "ملغى"
                  : "نشط";
            return `<div class="user-row"><div><strong>${escapeHtml(d.deviceName || "جهاز")}</strong><small>${escapeHtml(a.username || "حساب غير معروف")} · ${escapeHtml(d.platform || "unknown")} · ${status} · آخر اتصال ${escapeHtml(new Date(d.lastSeenAt).toLocaleString("ar-EG"))}</small></div><div class="user-row-actions">${d.status === "blocked" ? `<button type="button" class="btn secondary small" data-device-action="active" data-device-id="${d.id}">إلغاء الحظر</button>` : `<button type="button" class="btn danger small" data-device-action="blocked" data-device-id="${d.id}">حظر</button>`}<button type="button" class="btn ghost small" data-device-action="revoked" data-device-id="${d.id}">إلغاء التسجيل</button></div></div>`;
          })
          .join("")
      : '<div class="empty-row">لا توجد أجهزة مسجلة</div>';
    box
      .querySelectorAll("[data-device-action]")
      .forEach((b) =>
        b.addEventListener("click", () =>
          changeDeviceStatus(
            Number(b.dataset.deviceId),
            b.dataset.deviceAction,
          ),
        ),
      );
  } catch (e) {
    box.innerHTML = `<div class="empty-row">${escapeHtml(e.message || "تعذر تحميل الأجهزة")}</div>`;
  }
}
async function changeDeviceStatus(id, status) {
  if (!requireFeatureAccess("deviceManagement", "هذه الخاصية للمطور الأساسي فقط")) return;
  const labels = {
    active: "إلغاء الحظر",
    blocked: "حظر",
    revoked: "إلغاء تسجيل",
  };
  const ok = await openConfirmModal(
    `هل تريد تنفيذ: ${labels[status] || status} لهذا الجهاز؟`,
  );
  if (!ok) return;
  try {
    await centralRequest("/devices/action", {
      method: "POST",
      body: JSON.stringify({ id, status }),
    });
    recordAdminLog(labels[status] || status, "device:" + id);
    await renderDevices();
    toast("تم تحديث حالة الجهاز");
  } catch (e) {
    toast(e.message || "تعذر تحديث الجهاز");
  }
}
function openDevicesManager() {
  if (!requireFeatureAccess("deviceManagement", "هذه الخاصية للمطور الأساسي فقط")) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  closeAccountMenu();
  $("#devicesModal").classList.remove("hidden");
  renderDevices();
}
function closeDevicesManager() {
  $("#devicesModal")?.classList.add("hidden");
}
function syncUnlockButton() {
  const button = $("#deviceUnlockButton");
  if (button)
    button.classList.toggle(
      "hidden",
      appStorage.getItem(DEVICE_BLOCKED_KEY) !== "1",
    );
}
async function unlockDeviceWithZaxcel() {
  const key = await openSecureModal(
    "فتح البرنامج",
    "أدخل كلمة مرور إلغاء الحظر لفتح البرنامج والسماح بتسجيل الدخول:",
  );
  if (key !== ZAXCEL_PASSWORD) {
    toast("كلمة مرور Zaxcel غير صحيحة");
    return false;
  }
  appStorage.removeItem(DEVICE_BLOCKED_KEY);
  clearPasswordFailure("activation");
  clearPasswordFailure("secondary");
  clearPasswordFailure("primary");
  syncUnlockButton();
  try {
    await centralRequest("/devices/unlock", {
      method: "POST",
      body: JSON.stringify({ deviceId: getDeviceId(), password: key }),
    });
    toast("تم فتح البرنامج بنجاح. يمكنك تسجيل الدخول الآن.");
  } catch (error) {
    toast("تم فتح البرنامج محليًا. يمكنك تسجيل الدخول الآن.");
  }
  return true;
}
async function renderLoginAttempts() {
  const box = $("#loginAttemptsList");
  if (!box) return;
  box.innerHTML = '<div class="empty-row">جاري تحميل سجل الدخول...</div>';
  try {
    const data = await centralRequest("/login-attempts?limit=100");
    const attempts = data.attempts || [];
    box.innerHTML = attempts.length
      ? attempts
          .map(
            (a) =>
              `<div class="user-row"><div><strong>${escapeHtml(a.username || "—")}</strong><small>${escapeHtml(a.result === "success" ? "نجاح" : a.result === "blocked" ? "محظور" : "فشل")} · ${escapeHtml(a.reason || "—")} · ${escapeHtml(a.platform || "unknown")}</small></div><small>${escapeHtml(new Date(a.createdAt).toLocaleString("ar-EG"))}</small></div>`,
          )
          .join("")
      : '<div class="empty-row">لا توجد محاولات مسجلة</div>';
  } catch (error) {
    box.innerHTML = `<div class="empty-row">${escapeHtml(error?.message || "تعذر تحميل سجل الدخول")}</div>`;
  }
}
function openLoginAttempts() {
  if (!requireFeatureAccess("loginAttempts", "هذه الخاصية للمطورين فقط")) return;
  closeAccountMenu();
  $("#loginAttemptsModal").classList.remove("hidden");
  renderLoginAttempts();
}
function closeLoginAttempts() {
  $("#loginAttemptsModal")?.classList.add("hidden");
}
function logoutUser() {
  if (isGuestMode()) { endGuestSession("manual"); return; }
  closeAccountMenu();
  closeUserManager();
  clearSession();
  $("#loginUsername")?.focus();
  toast("تم تسجيل الخروج");
}
function restoreSession() {
  const guestStarted = Number(appStorage.getItem(GUEST_SESSION_KEY) || 0);
  if (guestStarted) {
    if (Date.now() - guestStarted < GUEST_DURATION_MS) {
      setSession({ username: "ضيف", role: "user", guest: true, active: true });
      startGuestTimer();
      return;
    }
    endGuestSession("expired");
    return;
  }
  const name = appStorage.getItem(SESSION_KEY),
    day = appStorage.getItem(SESSION_DAY_KEY),
    user = getUsers().find((x) => x.username === name);
  if (user && user.active !== false && day === todayKey()) setSession(user);
  else clearSession();
}
async function login(username, password) {
  const primary =
    username === DEVELOPER_USERNAME && password === DEVELOPER_PASSWORD;
  const locallyBlocked = appStorage.getItem(DEVICE_BLOCKED_KEY) === "1";
  if (locallyBlocked && !primary)
    throw Error(
      "لا يمكن تسجيل الدخول من هذا الجهاز لأنه محظور. يجب فتحه بواسطة المطوّر الأساسي أو من خلال خيار فتح الجهاز.",
    );
  if (primary) {
    appStorage.removeItem(DEVICE_BLOCKED_KEY);
    appStorage.removeItem(CENTRAL_TOKEN_KEY);
    appStorage.removeItem("bill:pwa:central-device");
    setSession({
      username: DEVELOPER_USERNAME,
      password: DEVELOPER_PASSWORD,
      role: "developer",
      active: true,
    });
    toast("تم تسجيل دخول المطوّر الأساسي بنجاح");
    return true;
  }
  const localUser = availableUsers().find((x) => x.username === username);
  if (localUser) {
    if (localUser.active === false || localUser.password !== password)
      throw Error("اسم المستخدم أو كلمة المرور غير صحيحة.");
    setSession(localUser);
    toast("تم الدخول بالحساب المحلي");
    return true;
  }
  try {
    const user = await centralLogin(username, password);
    if (!user || !user.username)
      throw Error("استجابة الدخول من الخادم غير صالحة.");
    appStorage.removeItem(DEVICE_BLOCKED_KEY);
    setSession(user);
    return true;
  } catch (centralError) {
    if (
      locallyBlocked ||
      centralError?.code === "DEVICE_BLOCKED" ||
      centralError?.status === 403 ||
      /محظور|blocked/i.test(String(centralError?.message || ""))
    )
      throw Error(
        "لا يمكن تسجيل الدخول من هذا الجهاز لأنه محظور. يجب فتحه بواسطة المطوّر الأساسي أو من خلال خيار فتح الجهاز.",
      );
    if (!centralError?.networkError) throw centralError;
    throw Error("اسم المستخدم أو كلمة المرور غير صحيحة.");
  }
}
async function loginFromForm(event) {
  event?.preventDefault?.();
  const form = document.querySelector("#loginForm"),
    username = document.querySelector("#loginUsername")?.value.trim() || "",
    password = document.querySelector("#loginPassword")?.value || "",
    errorBox = document.querySelector("#loginError"),
    button = document.querySelector("#loginSubmit");
  if (button) button.disabled = true;
  if (errorBox) {
    errorBox.textContent = "";
    errorBox.classList.remove("show");
  }
  try {
    if (!username || !password) throw Error("أدخل اسم المستخدم وكلمة المرور.");
    const primaryAttempt = username === DEVELOPER_USERNAME && password === DEVELOPER_PASSWORD;
    if (!primaryAttempt && !dataFolderReady)
      throw Error("اختر مجلد قواعد البيانات أولًا قبل تسجيل الدخول.");
    if (!primaryAttempt && !usersFileReady)
      throw Error("يجب أن يحتوي مجلد قاعدة البيانات على ملف users.json صالح قبل تسجيل الدخول.");
    const ok = await login(username, password);
    if (!ok) {
      if (errorBox)
        errorBox.textContent = "اسم المستخدم أو كلمة المرور غير صحيحة";
      return false;
    }
    form?.reset();
    if (errorBox) errorBox.textContent = "";
    toast(`تم تسجيل الدخول بنجاح: ${currentUser?.username || username}`);
    return true;
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error?.message || "تعذر تسجيل الدخول";
      errorBox.classList.add("show");
    }
    if (typeof syncUnlockButton === "function") syncUnlockButton();
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}
window.loginFromForm = loginFromForm;
function renderUserList() {
  const box = $("#userList");
  if (!box) return;
  const canManage = hasFeatureAccess("userManagement");
  const query = normalize($("#userManagerSearch")?.value || "");

  const allUsers = getUsers();
  const filtered = query
    ? allUsers.filter((u) => {
        const roleText = u.role === "developer" ? "مطور مطور حساب" : "مستخدم حساب عادي";
        const activeText = u.active === false ? "معطل موقوف" : "فعال نشط";
        return (
          normalize(u.username || "").includes(query) ||
          normalize(roleText).includes(query) ||
          normalize(activeText).includes(query)
        );
      })
    : allUsers;

  const rows = filtered.slice(0, 200); // ⚡ حد أقصى للسرعة

  box.innerHTML = rows.length
    ? rows
        .map(
          (u) =>
            `<div class="user-row"><div><strong>${escapeHtml(u.username)}</strong><small>${u.role === "developer" ? "حساب مطوّر" : "حساب عادي"} · ${u.active === false ? "معطل" : "فعال"}</small></div>${canManage && u.username !== DEVELOPER_USERNAME ? `<div class="user-row-actions"><button type="button" class="btn ghost small" data-edit-user="${escapeHtml(u.username)}">تعديل</button><button type="button" class="btn secondary small" data-toggle-user="${escapeHtml(u.username)}">${u.active === false ? "تفعيل" : "تعطيل"}</button><button type="button" class="btn danger small" data-delete-user="${escapeHtml(u.username)}">حذف</button></div>` : ""}</div>`,
        )
        .join("")
    : '<div class="empty-row">لا يوجد مستخدم مطابق</div>';

  box
    .querySelectorAll("[data-delete-user]")
    .forEach((b) =>
      b.addEventListener("click", () => deleteUser(b.dataset.deleteUser)),
    );
  box
    .querySelectorAll("[data-edit-user]")
    .forEach((b) =>
      b.addEventListener("click", () => openEditUser(b.dataset.editUser)),
    );
  box
    .querySelectorAll("[data-toggle-user]")
    .forEach((b) =>
      b.addEventListener("click", () => toggleUser(b.dataset.toggleUser)),
    );
  renderAdminLog();
}
async function deleteUser(username) {
  if (!hasFeatureAccess("userManagement")) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  if (username === DEVELOPER_USERNAME) {
    toast("لا يمكن حذف حساب المطوّر الأساسي");
    return;
  }
  const confirmed = await openConfirmModal(
    `هل تريد حذف المستخدم ${username} نهائيًا؟`,
  );
  if (!confirmed) return;
  saveUsers(getUsers().filter((u) => u.username !== username));
  recordAdminLog("حذف مستخدم", username);
  renderUserList();
  toast("تم حذف المستخدم");
}
async function toggleUser(username) {
  if (
    !hasFeatureAccess("userManagement") ||
    username === DEVELOPER_USERNAME
  ) {
    toast("تغيير حالة هذا الحساب غير مسموح");
    return;
  }
  const users = getUsers(),
    user = users.find((u) => u.username === username);
  if (!user) return;
  const next = user.active === false;
  const confirmed = await openConfirmModal(
    `${next ? "تفعيل" : "تعطيل"} الحساب ${username}؟`,
  );
  if (!confirmed) return;
  user.active = next;
  saveUsers(users);
  recordAdminLog(next ? "تفعيل مستخدم" : "تعطيل مستخدم", username);
  renderUserList();
  toast(next ? "تم تفعيل الحساب" : "تم تعطيل الحساب");
}
function openEditUser(username) {
  if (!hasFeatureAccess("userManagement")) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  const user = getUsers().find((u) => u.username === username);
  if (!user || username === DEVELOPER_USERNAME) return;
  $("#editingUsername").value = user.username;
  $("#newUsername").value = user.username;
  $("#newPassword").value = user.password;
  $("#newUserRole").value = user.role;
  $("#userSubmit").textContent = "حفظ التعديل";
  $("#userManagerError").textContent = "";
}
async function openUserManager() {
  if (!requireFeatureAccess("userManagement", "إدارة المستخدمين للمطورين فقط")) return;
  const key = await securePassword(
    "secondary",
    "إدارة المستخدمين",
    "أدخل كلمة مرور إدارة الحساب:",
    LIMIT_PASSWORD,
  );
  if (key !== LIMIT_PASSWORD) return;
  if (advanceLocked && !(await requestActivation())) return;
  renderUserList();
  $("#userManagerModal").classList.remove("hidden");
  $("#newUsername").focus();
}

/* ============ MANAGE PASSWORDS ============ */
async function openPasswordManager() {
  if (!isPrimaryDeveloper()) {
    toast("هذه الخاصية للمطور الأساسي فقط");
    return;
  }
  const verified = await securePassword(
    "account",
    "إدارة كلمات المرور",
    "أدخل كلمة مرور حساب المطور الأساسي",
    DEVELOPER_PASSWORD,
  );
  if (verified !== DEVELOPER_PASSWORD) return;
  closeAccountMenu();
  $("#managedAdvancePassword").value = ADVANCE_PASSWORD;
  $("#managedLimitPassword").value = LIMIT_PASSWORD;
  $("#managedActivationPassword").value = ACTIVATION_PASSWORD;
  $("#managedUnlockPassword").value = ZAXCEL_PASSWORD;
  $("#passwordManagerError").textContent = "";
  $("#passwordManagerModal").classList.remove("hidden");
  $("#managedAdvancePassword").focus();
}

function closePasswordManager() {
  $("#passwordManagerModal")?.classList.add("hidden");
  $("#passwordManagerForm")?.reset();
  const err = $("#passwordManagerError");
  if (err) err.textContent = "";
}

async function saveManagedPasswords(event) {
  event.preventDefault();
  if (!currentUser || currentUser.username !== DEVELOPER_USERNAME) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  const advance = $("#managedAdvancePassword").value.trim();
  const limit = $("#managedLimitPassword").value.trim();
  const activation = $("#managedActivationPassword").value.trim();
  const unlock = $("#managedUnlockPassword").value.trim();
  const error = $("#passwordManagerError");

  if (!advance || !limit || !activation || !unlock) {
    error.textContent = "كل الحقول مطلوبة";
    return;
  }
  if (advance.length < 4 || limit.length < 4 || activation.length < 4 || unlock.length < 4) {
    error.textContent = "كل كلمة مرور يجب أن تكون 4 أحرف على الأقل";
    return;
  }
  if (advance === limit || advance === activation || limit === activation) {
    error.textContent = "لا يمكن استخدام نفس كلمة المرور لأكثر من نوع";
    return;
  }

  ADVANCE_PASSWORD = advance;
  LIMIT_PASSWORD = limit;
  ACTIVATION_PASSWORD = activation;
  ZAXCEL_PASSWORD = unlock;
  await persistSecureSettings();

  // تسجيل العملية (بدون كشف الكلمات نفسها)
  recordAdminLog("تعديل كلمات المرور", "passwords",
    "تم تحديث كلمات المرور المحمية");

  // تصفير عدّادات الفشل لأن الكلمات تغيّرت
  clearPasswordFailure("primary");
  clearPasswordFailure("secondary");
  clearPasswordFailure("activation");

  error.textContent = "";
  toast("تم حفظ كلمات المرور الجديدة بنجاح");
  closePasswordManager();
}

async function resetPasswordsToDefault() {
  if (!currentUser || currentUser.username !== DEVELOPER_USERNAME) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  const ok = await openConfirmModal(
    "هل تريد استعادة كلمات المرور الافتراضية؟ لن تُحفظ التعديلات الحالية."
  );
  if (!ok) return;

  ADVANCE_PASSWORD = DEFAULT_ADVANCE_PASSWORD;
  LIMIT_PASSWORD = DEFAULT_LIMIT_PASSWORD;
  ACTIVATION_PASSWORD = DEFAULT_ACTIVATION_PASSWORD;
  ZAXCEL_PASSWORD = DEFAULT_UNLOCK_PASSWORD;
  await persistSecureSettings();

  $("#managedAdvancePassword").value = ADVANCE_PASSWORD;
  $("#managedLimitPassword").value = LIMIT_PASSWORD;
  $("#managedActivationPassword").value = ACTIVATION_PASSWORD;
  $("#managedUnlockPassword").value = ZAXCEL_PASSWORD;

  clearPasswordFailure("primary");
  clearPasswordFailure("secondary");
  clearPasswordFailure("activation");

  recordAdminLog("استعادة كلمات المرور", "passwords", "تم الرجوع للافتراضي");
  toast("تم استعادة كلمات المرور الافتراضية");
}

function employeeRecords() { return safeJson(appStorage.getItem(EMPLOYEES_KEY) || "[]", []); }
function saveEmployeeRecords(records) { appStorage.setItem(EMPLOYEES_KEY, JSON.stringify(records.slice(0, 1000))); }
function employeeDepartments() { return safeJson(appStorage.getItem(EMPLOYEE_DEPARTMENTS_KEY) || "[]", []); }
function renderEmployeeDepartments() { const list = $("#employeeDepartmentOptions"); if (list) list.innerHTML = employeeDepartments().map((x) => `<option value="${escapeHtml(x)}"></option>`).join(""); }
function employeeNetSalary(employee) { const base = Number(employee.salary || 0);
  const insurance = Number(employee.insurance || 0); const day = Number(employee.workDays || 0) ? base / Number(employee.workDays) : 0; return Math.max(0, base - insurance - Number(employee.deductions || 0) - day * Number(employee.leaveDays || 0)); }
function resetEmployeeForm() { ["employeeEditingId","employeeName","employeeCode","employeeJob","employeePhone","employeeHireDate","employeeYear","employeeDepartment","employeeWorkDays","employeeWorkHours","employeeSalary","employeeInsurance","employeeDeductions","employeeLeaveDays","employeeNotes"].forEach((id) => { const el = $("#" + id); if (el) el.value = ""; }); $("#employeeWorkDays").value = "26"; $("#employeeWorkHours").value = "8"; $("#employeeSubmit").textContent = "إضافة الموظف"; }
function renderEmployeeManager() {
  const box = $("#employeeList"); if (!box) return;
  renderEmployeeDepartments();
  const query = normalize($("#employeeManagerSearch")?.value || "");
  const rows = employeeRecords().filter((e) => !query || normalize(`${e.name} ${e.code} ${e.job} ${e.department} ${e.year}`).includes(query));
  box.innerHTML = rows.length ? rows.map((e) => `<div class="employee-row"><div><strong>${escapeHtml(e.name)} · ${escapeHtml(e.code || "—")}</strong><small>${escapeHtml(e.job || "—")} · ${escapeHtml(e.phone || "—")} · السنة ${escapeHtml(e.year || "—")} · القسم ${escapeHtml(e.department || "—")} · ${escapeHtml(e.workDays || 0)} يوم · ${escapeHtml(e.workHours || 0)} ساعة يوميًا</small><small>المرتب ${money(e.salary)} · الخصومات ${money(e.deductions)} · الإجازات ${escapeHtml(e.leaveDays || 0)} · الصافي ${money(employeeNetSalary(e))}</small><small>${escapeHtml(e.notes || "")}</small></div><div class="user-row-actions"><button type="button" class="btn ghost small" data-employee-edit="${e.id}">تعديل</button><button type="button" class="btn danger small" data-employee-delete="${e.id}">حذف</button></div></div>`).join("") : '<div class="empty-row">لا توجد بيانات موظفين</div>';
  box.querySelectorAll("[data-employee-edit]").forEach((b) => b.addEventListener("click", () => editEmployee(Number(b.dataset.employeeEdit))));
  box.querySelectorAll("[data-employee-delete]").forEach((b) => b.addEventListener("click", () => deleteEmployee(Number(b.dataset.employeeDelete))));
}
function openEmployeeManager() { if (!requireFeatureAccess("employeeManagement", "إدارة الموظفين للمطورين فقط")) return; closeAccountMenu(); resetEmployeeForm(); renderEmployeeManager(); $("#employeeManagerModal")?.classList.remove("hidden"); }
function closeEmployeeManager() { $("#employeeManagerModal")?.classList.add("hidden"); }
function editEmployee(id) { const e = employeeRecords().find((x) => x.id === id); if (!e) return; $("#employeeEditingId").value = e.id; $("#employeeName").value = e.name || ""; $("#employeeCode").value = e.code || ""; $("#employeeJob").value = e.job || ""; $("#employeePhone").value = e.phone || ""; $("#employeeHireDate").value = e.hireDate || ""; $("#employeeYear").value = e.year || ""; $("#employeeDepartment").value = e.department || ""; $("#employeeWorkDays").value = e.workDays || ""; $("#employeeWorkHours").value = e.workHours || ""; $("#employeeSalary").value = e.salary || ""; $("#employeeInsurance").value = e.insurance || ""; $("#employeeStatus").value = e.status || "active"; $("#employeeDeductions").value = e.deductions || ""; $("#employeeLeaveDays").value = e.leaveDays || ""; $("#employeeNotes").value = e.notes || ""; $("#employeeSubmit").textContent = "حفظ التعديل"; }
async function deleteEmployee(id) { if (!(await openConfirmModal("هل تريد حذف سجل الموظف؟"))) return; saveEmployeeRecords(employeeRecords().filter((e) => e.id !== id)); renderEmployeeManager(); toast("تم حذف الموظف"); }
function submitEmployee(event) { event.preventDefault(); if (!requireFeatureAccess("employeeManagement", "إدارة الموظفين للمطورين فقط")) return; const id = $("#employeeEditingId").value || makeId("employee"); const name = $("#employeeName").value.trim(); if (!name) { $("#employeeError").textContent = "اكتب اسم الموظف"; return; } const department = $("#employeeDepartment").value.trim(); const departments = new Set(employeeDepartments()); if (department) departments.add(department); appStorage.setItem(EMPLOYEE_DEPARTMENTS_KEY, JSON.stringify([...departments])); const record = { id, name, code: $("#employeeCode").value.trim() || makeId("EMP"), job: $("#employeeJob").value.trim(), phone: $("#employeePhone").value.trim(), hireDate: $("#employeeHireDate").value, year: $("#employeeYear").value.trim(), department, workDays: Number($("#employeeWorkDays").value) || 0, workHours: Number($("#employeeWorkHours").value) || 0, salary: Number($("#employeeSalary").value) || 0, insurance: Number($("#employeeInsurance").value) || 0, deductions: Number($("#employeeDeductions").value) || 0, leaveDays: Number($("#employeeLeaveDays").value) || 0, status: $("#employeeStatus").value || "active", notes: $("#employeeNotes").value.trim(), updatedAt: new Date().toISOString() }; const records = employeeRecords(); const index = records.findIndex((e) => e.id === id); if (index >= 0) records[index] = record; else records.unshift(record); saveEmployeeRecords(records); recordAdminLog(index >= 0 ? "تعديل موظف" : "إضافة موظف", name); resetEmployeeForm(); renderEmployeeManager(); toast("تم حفظ بيانات الموظف وحساب صافي المرتب"); }
function exportEmployees() { downloadJson({ version: 1, employees: employeeRecords(), departments: employeeDepartments() }, "employees.json"); }
async function importEmployees(file) { try { const data = JSON.parse(await file.text()); const records = Array.isArray(data) ? data : data.employees; if (!Array.isArray(records)) throw Error(); saveEmployeeRecords(records); if (Array.isArray(data.departments)) appStorage.setItem(EMPLOYEE_DEPARTMENTS_KEY, JSON.stringify(data.departments)); renderEmployeeManager(); toast("تم استيراد بيانات الموظفين"); } catch (e) { toast("ملف الموظفين غير صحيح"); } }
const PAYROLL_KEY = "bill:pwa:payroll:v1";
function payrollRecords() { return safeJson(appStorage.getItem(PAYROLL_KEY) || "[]", []); }
function savePayrollRecords(records) { appStorage.setItem(PAYROLL_KEY, JSON.stringify(records.slice(-12000))); }
function payrollFor(month, employeeId) { return payrollRecords().find((x) => x.month === month && String(x.employeeId) === String(employeeId)) || { month, employeeId, advances: 0, absenceDays: 0, absenceDayValue: 0, halfDays: 0, lateCount: 0, lateDeduction: 0, otherDeductions: 0, additions: 0, notes: "" }; }
function calculatePayroll(employee, record) { const day = Number(record.absenceDayValue) || (Number(employee.workDays) ? Number(employee.salary || 0) / Number(employee.workDays) : 0); const absence = Number(record.absenceDays || 0) * day; const half = Number(record.halfDays || 0) * day * .5; const total = absence + half + Number(record.lateDeduction || 0) + Number(record.advances || 0) + Number(employee.insurance || 0) + Number(record.otherDeductions || 0); return { ...record, absenceDeduction: absence, halfDayDeduction: half, totalDeductions: total, net: Math.max(0, Number(employee.salary || 0) + Number(record.additions || 0) - total) }; }
function renderPayroll() { if (!requireFeatureAccess("employeeManagement", "إدارة المرتبات للمطورين فقط")) return; const month = $("#payrollMonth")?.value || new Date().toISOString().slice(0,7); const box=$("#payrollList"); if (!box) return; const rows=employeeRecords().map((employee)=>{ const rec=calculatePayroll(employee,payrollFor(month,employee.id)); return `<div class="employee-row payroll-row" data-payroll-id="${escapeHtml(String(employee.id))}"><div><strong>${escapeHtml(employee.name)}</strong><small>${escapeHtml(employee.job || "")} · الأساسي ${money(employee.salary)} · صافي ${money(rec.net)}</small></div><div class="payroll-fields"><label>سلف<input data-payroll="advances" type="number" value="${rec.advances||0}"></label><label>غياب<input data-payroll="absenceDays" type="number" value="${rec.absenceDays||0}"></label><label>قيمة اليوم<input data-payroll="absenceDayValue" type="number" value="${rec.absenceDayValue||0}"></label><label>نصف يوم<input data-payroll="halfDays" type="number" value="${rec.halfDays||0}"></label><label>خصم تأخير<input data-payroll="lateDeduction" type="number" value="${rec.lateDeduction||0}"></label><label>خصومات أخرى<input data-payroll="otherDeductions" type="number" value="${rec.otherDeductions||0}"></label><label>إضافات<input data-payroll="additions" type="number" value="${rec.additions||0}"></label></div></div>`; }).join(""); box.innerHTML=rows || '<div class="empty-row">لا يوجد موظفون</div>'; box.querySelectorAll("[data-payroll]").forEach((input)=>input.addEventListener("change",()=>{ const row=input.closest("[data-payroll-id]"); const id=row.dataset.payrollId; const current=payrollFor(month,id); current[input.dataset.payroll]=Number(input.value)||0; current.month=month; current.employeeId=id; const all=payrollRecords().filter((x)=>!(x.month===month&&String(x.employeeId)===String(id))); all.push(current); savePayrollRecords(all); renderPayroll(); })); }
function printPayroll() { if (!requireFeatureAccess("employeeManagement", "طباعة كشف المرتبات للمطورين فقط")) return; const month=$("#payrollMonth")?.value || new Date().toISOString().slice(0,7); const rows=employeeRecords().map((e)=>{const r=calculatePayroll(e,payrollFor(month,e.id)); return `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.job||"")}</td><td>${money(e.salary)}</td><td>${money(r.absenceDeduction)}</td><td>${money(r.halfDayDeduction)}</td><td>${money(r.lateDeduction)}</td><td>${money(r.advances)}</td><td>${money(r.totalDeductions)}</td><td>${money(r.additions)}</td><td>${money(r.net)}</td></tr>`}).join(""); const w=window.open("","_blank"); if(!w)return; w.document.write(`<html dir="rtl"><head><title>كشف مرتبات ${month}</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #777;padding:6px;text-align:center}</style></head><body><h2>كشف مرتبات شهر ${month}</h2><table><thead><tr><th>الموظف</th><th>الوظيفة</th><th>الأساسي</th><th>غياب</th><th>نصف يوم</th><th>تأخير</th><th>سلف</th><th>إجمالي الخصم</th><th>إضافات</th><th>الصافي</th></tr></thead><tbody>${rows}</tbody></table><script>window.print()<\/script></body></html>`); w.document.close(); }
async function resetAllSettings() { if (!isPrimaryDeveloper()) return; if (!(await openConfirmModal("سيتم استعادة صلاحيات الأدوات ونسبة الأسعار الافتراضية فقط، ولن تتغير كلمة مرور المطور الأساسي. هل تريد المتابعة؟"))) return; saveFeaturePermissions(Object.fromEntries(FEATURE_DEFINITIONS.map((x) => [x.key, x.defaultRole]))); priceLimitRatio = DEFAULT_PRICE_LIMIT_RATIO; appStorage.removeItem("bill:pwa:price-limit"); advanceUnlocked = false; applyFeatureAccess(); toast("تمت استعادة إعدادات الأنظمة الافتراضية"); }

function closeUserManager() {
  $("#userManagerModal")?.classList.add("hidden");
  $("#userForm")?.reset();
  $("#editingUsername").value = "";
  $("#userSubmit").textContent = "إضافة المستخدم";
  $("#userManagerError").textContent = "";
}
async function addUser(event) {
  event.preventDefault();
  if (!requireFeatureAccess("userManagement", "إدارة المستخدمين للمطورين فقط")) return;
  const username = $("#newUsername").value.trim(),
    password = $("#newPassword").value,
    role = $("#newUserRole").value,
    error = $("#userManagerError"),
    editing = $("#editingUsername").value.trim();
  if (!username || !password) {
    error.textContent = "أدخل اسم المستخدم وكلمة المرور";
    return;
  }
  const users = getUsers();
  if (users.some((u) => u.username === username && u.username !== editing)) {
    error.textContent = "اسم المستخدم موجود بالفعل";
    return;
  }
  if (editing) {
    const user = users.find((u) => u.username === editing);
    if (!user) {
      error.textContent = "المستخدم غير موجود";
      return;
    }
    user.username = username;
    user.password = password;
    user.role = role === "developer" ? "developer" : "user";
    recordAdminLog("تعديل مستخدم", username, `كان الاسم السابق: ${editing}`);
    toast("تم تعديل بيانات المستخدم");
  } else {
    users.push({
      username,
      password,
      role: role === "developer" ? "developer" : "user",
      active: true,
    });
    recordAdminLog(
      "إضافة مستخدم",
      username,
      role === "developer" ? "حساب مطوّر" : "حساب عادي",
    );
    toast("تمت إضافة المستخدم");
  }
  saveUsers(users);
  if (isPrimaryDeveloper()) {
    try {
      await centralRequest("/accounts/sync", {
        method: "POST",
        body: JSON.stringify({ username, password, role }),
      });
    } catch (e) {
      toast("تم حفظ الحساب محليًا وسيتم رفعه عند توفر الاتصال");
    }
  }
  downloadJson(
    {
      version: 1,
      users: users
        .filter((user) => user.username !== DEVELOPER_USERNAME)
        .map(({ password, ...user }) => user),
      logs: JSON.parse(appStorage.getItem(ADMIN_LOG_KEY) || "[]"),
      updatedAt: new Date().toISOString(),
    },
    "users.json",
  );
  error.textContent = "";
  closeUserManager();
  renderUserList();
}
async function importUsersFile(file) {
  try {
    const data = JSON.parse(await file.text()),
      users = Array.isArray(data) ? data : data.users;
    if (
      !Array.isArray(users) ||
      !users.length ||
      users.some(
        (u) =>
          !u.username || !u.password || !["user", "developer"].includes(u.role),
      )
    )
      throw Error();
    if (!currentUser || (currentUser.role !== "developer" && !isPrimaryDeveloper())) {
      toast("استيراد المستخدمين للمطوّر فقط");
      return;
    }
    saveUsers(
      users.some((u) => u.username === DEVELOPER_USERNAME)
        ? users
        : [...DEFAULT_USERS, ...users],
    );
    recordAdminLog("استيراد المستخدمين", "users.json");
    renderUserList();
    toast("تم استيراد قاعدة المستخدمين");
  } catch (e) {
    toast("ملف users.json غير صحيح");
  }
}
const money = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const normalize = (s) =>
  String(s || "")
    .trim()
    .toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىي]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/\s+/g, " ")
    .replace(/\s/g, "");
/* ============ FAST SEARCH DEBOUNCE ============ */
const managerSearchTimers = { product: 0, customer: 0, user: 0 };
function debounceManagerSearch(kind, fn, delay = 60) {
  clearTimeout(managerSearchTimers[kind]);
  managerSearchTimers[kind] = setTimeout(fn, delay);
}
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2400);
}
function setDate() {
  const d = new Date();
  $("#invoiceDate").value =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}
async function loadBundledDatabase() {
  if (appStorage.getItem(PRODKEY) || appStorage.getItem("bill:pwa:customers:v1")) {
    dataFolderReady = true;
    return;
  }
  const files = {products: "Database/products.json", customers: "Database/customers.json", history: "Database/customer_history.json", users: "Database/users.json"};
  try {
    const read = async (url) => { const r = await fetch(url, {cache: "no-store"}); return r.ok ? await r.json() : null; };
    const [productsData, customersData, historyData, usersData] = await Promise.all(Object.values(files).map(read));
    if (Array.isArray(productsData) && productsData.length) appStorage.setItem(PRODKEY, JSON.stringify(productsData));
    if (Array.isArray(customersData) && customersData.length) appStorage.setItem("bill:pwa:customers:v1", JSON.stringify(customersData));
    if (Array.isArray(historyData) && historyData.length) appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(historyData));
    if (Array.isArray(usersData) && usersData.length) { usersFileUsers = usersData; usersFileReady = true; saveUsers(usersData); }
    dataFolderReady = Boolean(
      (Array.isArray(productsData) && productsData.length) ||
      (Array.isArray(customersData) && customersData.length) ||
      (Array.isArray(usersData) && usersData.length),
    );
  } catch (e) { console.warn("Bundled database unavailable", e); }
}
async function loadProducts() {
  let local = [];
  try {
    const raw = appStorage.getItem(PRODKEY);
    const data = raw ? JSON.parse(raw) : [];
    if (Array.isArray(data)) local = data;
  } catch (e) {}
  products = local
    .filter((p) => p && p.code != null)
    .map((p) => ({
      ...p,
      code: String(p.code),
      searchText: `${normalize(p.name || p.code)} ${p.code}`,
  }));
  rebuildProductIndex();
  try {
    if ("Worker" in window && products.length) {
      if (!searchWorker) searchWorker = new Worker("search-worker.js");
      searchWorker.onmessage = (e) => {
        if (
          e.data?.type === "results" &&
          normalize(e.data.query) === normalize(els.search.value)
        )
          if ((e.data.results || []).length || !findProducts(e.data.query).length)
            renderFound(e.data.results);
      };
      setTimeout(() => {
        try {
          searchWorker?.postMessage({ type: "init", payload: products });
        } catch (e) {}
      }, 0);
    }
  } catch (e) {
    searchWorker = null;
  }
  if (!products.length)
    toast("لم يتم تحميل المنتجات؛ اختر مجلد قاعدة البيانات");
  document.title = "Bill";
}
function normalizeCustomerCode(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/\.0+$/, "");
}
function normalizeCustomerRecord(item) {
  if (!item || typeof item !== "object") return null;
  const pick = (...keys) => {
    const key = Object.keys(item).find((k) =>
      keys.some(
        (name) => String(k).toLowerCase() === String(name).toLowerCase(),
      ),
    );
    return key === undefined ? "" : item[key];
  };
  const code = normalizeCustomerCode(
    pick(
      "code",
      "customerCode",
      "cus_code",
      "cuscode",
      "customer_code",
      "كود",
      "كود_العميل",
    ),
  );
  const name = String(
    pick(
      "name",
      "customerName",
      "cus_name",
      "cusname",
      "customer_name",
      "اسم",
      "اسم_العميل",
    ) || "",
  ).trim();
  if (!code || !name) return null;
  return {
    code,
    name,
    city: String(
      pick(
        "city",
        "customerCity",
        "cus_city",
        "cuscity",
        "customer_city",
        "مدينة",
        "المدينة",
      ) || "",
    ).trim(),
    address: String(
      pick(
        "address",
        "customerAddress",
        "cus_address",
        "cusaddress",
        "customer_address",
        "عنوان",
        "العنوان",
      ) || "",
    ).trim(),
    phone: String(
      pick(
        "phone",
        "tel",
        "tel_1",
        "tel1",
        "mobile",
        "telephone",
        "هاتف",
        "التليفون",
      ) || "",
    ).trim(),
  };
}
function normalizeCustomersData(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeCustomerRecord).filter(Boolean);
}
async function loadCustomers() {
  try {
    const raw = JSON.parse(appStorage.getItem("bill:pwa:customers:v1") || "[]");
    const local = Array.isArray(raw)
      ? raw
      : raw?.customers || raw?.customer || raw?.data || raw?.rows || [];
    customers = normalizeCustomersData(local);
  } catch (e) {
    customers = [];
  }
  try {
    const localHistory = JSON.parse(
      appStorage.getItem("bill:pwa:customer-history:v1") || "[]",
    );
    customerHistory = Array.isArray(localHistory) ? localHistory : [];
  } catch (e) {
    customerHistory = [];
  }
}
function currentHistoryCode() { return historyKey($("#customerCode")?.value || ""); }
function renderAllCustomerHistory() { const box=$("#customerHistoryAllList"); if(!box)return; const code=currentHistoryCode(); const entry=customerHistory.find((x)=>historyKey(x.customerCode)===code); const query=normalize($("#customerHistorySearch")?.value||""); const items=(entry?.items||[]).filter((x)=>!query||normalize(`${x.name||""} ${x.code||""}`).includes(query)); box.innerHTML=items.length?items.map((x)=>`<div class="user-row"><strong>${escapeHtml(x.name||x.code)}</strong><small>آخر سعر ${money(x.lastPrice)} · الكمية ${x.lastQty||0} · مرات الشراء ${x.timesBought||1} · ${escapeHtml(x.mode||"")}</small></div>`).join(""):'<div class="empty-row">لا توجد مشتريات سابقة</div>'; }
function openAllCustomerHistory(){ if(!currentHistoryCode()){toast("اكتب كود العميل أولًا");return;} $("#customerHistoryModal")?.classList.remove("hidden"); renderAllCustomerHistory(); }
function closeAllCustomerHistory(){ $("#customerHistoryModal")?.classList.add("hidden"); }
function deleteCurrentCustomerHistory(){ const code=currentHistoryCode(); if(!code)return; customerHistory=customerHistory.filter((x)=>historyKey(x.customerCode)!==code); appStorage.setItem("bill:pwa:customer-history:v1",JSON.stringify(customerHistory)); closeAllCustomerHistory(); renderCustomer(code); toast("تم حذف سجل مشتريات العميل دون حذف العميل"); }
function renderCustomer(code) {
  const key = String(code || "").trim();
  const c = customers.find((x) => String(x.code) === key);
  const infoBox = $("#customerInfo");
  const histBox = $("#customerHistory");

  if (!c) {
    if (infoBox) { infoBox.textContent = ""; infoBox.classList.add("hidden"); }
    if (histBox) { histBox.innerHTML = ""; histBox.classList.add("hidden"); }
    return;
  }

  if ($("#customerName")) $("#customerName").value = c.name || "";
  if ($("#customerCity")) $("#customerCity").value = c.city || "";
  if ($("#customerPhone")) $("#customerPhone").value = c.phone || "";

  if (infoBox) {
    infoBox.classList.remove("hidden");
    infoBox.textContent = `${c.name} · ${c.code} · ${c.city || "—"} · ${c.phone || "—"}`;
  }

  const hist = customerHistory.find((x) => String(x.customerCode) === key);
  if (histBox) {
    const itemsBox = $("#customerHistoryItems");
    if (hist && Array.isArray(hist.items) && hist.items.length) {
      histBox.classList.remove("hidden");
      if (itemsBox) itemsBox.innerHTML = hist.items.map((it) => `<div class="history-chip"><span>${escapeHtml(it.name || "")}</span><small>${escapeHtml(String(it.lastQty || 0))} × ${money(it.lastPrice || 0)}</small></div>`).join("");
    } else {
      histBox.classList.add("hidden");
      if (itemsBox) itemsBox.innerHTML = "";
    }
  }
}
let productIndex = new Map();
let productSearchList = [];
function rebuildProductIndex() {
  productIndex = new Map();
  productSearchList = products.map((p) => { const code = String(p.code); productIndex.set(code, p); return { code, text: p.searchText || `${normalize(p.name || code)} ${code}` }; });
}
function getProductByCode(code) { return productIndex.get(String(code)) || null; }
function findProducts(q) {
  const query = normalize(q), out = [];
  if (!query) return out;
  for (const entry of productSearchList) { if (entry.text.includes(query)) { const p = productIndex.get(entry.code); if (p) out.push(p); if (out.length >= 40) break; } }
  return out;
}
function renderFound(list) {
  const box = els.suggestions;
  if (!box) return;

  const items = Array.isArray(list) ? list.slice(0, 40) : [];
  activeSuggestion = -1;

  if (!items.length) {
    box.innerHTML = "";
    box.classList.remove("open");
    return;
  }

  box.innerHTML = items
    .map((p, i) => {
      const cls = productAgeClass(p.code);
      const w = money(unitPriceFor(p, "wholesale"));
      const r = money(unitPriceFor(p, "retail"));
      return `<div class="suggestion ${cls}" data-index="${i}" data-code="${escapeHtml(p.code)}">
        <strong>${escapeHtml(p.name)}</strong>
        <small>${escapeHtml(p.code)} · جملة ${w} · تجزئة ${r}</small>
      </div>`;
    })
    .join("");

  box.classList.add("open");

  box.querySelectorAll(".suggestion[data-index]").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const found = getProductByCode(el.dataset.code);
      if (found) choose(found);
    });
  });
}
function scheduleSuggestions() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = els.search.value;
    if (!normalize(q)) {
      renderFound([]);
      return;
    }

    const local = findProducts(q);

    if (searchWorker) {
      // اعرض النتائج المحلية فورًا كضمان
      renderFound(local);

      let answered = false;
      const onMsg = (e) => {
        if (e.data?.type !== "results") return;
        answered = true;
        searchWorker.removeEventListener("message", onMsg);
        if (normalize(e.data.query) === normalize(els.search.value))
          if ((e.data.results || []).length || !findProducts(e.data.query).length)
            renderFound(e.data.results);
      };
      searchWorker.addEventListener("message", onMsg);
      try {
        searchWorker.postMessage({ type: "search", payload: { query: q } });
      } catch (e) {}

      setTimeout(() => {
        if (!answered) {
          try { searchWorker.removeEventListener("message", onMsg); } catch (e) {}
        }
      }, 250);
    } else {
      renderFound(local);
    }
  }, 20);
}

function productAgeClass(code) {
  const value = String(code || "");
  if (value.startsWith("24")) return "product-old";
  if (value.startsWith("25")) return "product-recent";
  if (value.startsWith("26")) return "product-current";
  return "product-current";
}
function applyProductColor(product) {
  const cls = product ? productAgeClass(product.code) : "";
  [els.search, els.qty, els.selected].forEach((el) => {
    if (!el) return;
    el.classList.remove("product-current", "product-recent", "product-old");
    if (cls) el.classList.add(cls);
  });
}
function choose(p) {
  selected = p;
  els.search.value = p.name;
  els.suggestions.classList.remove("open");
  els.selected.classList.remove("empty");
  applyProductColor(p);
  updatePrice();
  els.qty.focus();
  els.qty.select();
}
function unitPriceFor(product, mode = priceMode) {
  if (!product) return 0;
  const preferred = Number(
    mode === "wholesale" ? product.wholesale : product.retail,
  );
  if (Number.isFinite(preferred) && preferred > 0) return preferred;
  const fallback = Number(
    mode === "wholesale" ? product.retail : product.wholesale,
  );
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}
function effectivePriceMode(product, mode = priceMode) {
  if (!product) return mode;
  const preferred = Number(
    mode === "wholesale" ? product.wholesale : product.retail,
  );
  return Number.isFinite(preferred) && preferred > 0
    ? mode
    : mode === "wholesale"
      ? "retail"
      : "wholesale";
}
function effectivePriceLabel(product) {
  return effectivePriceMode(product) === "wholesale" ? "الفئة أ" : "الفئة ب";
}
function selectedUnitPrice() {
  return selected ? unitPriceFor(selected) : 0;
}
function updatePrice() {
  els.price.textContent = selected ? money(selectedUnitPrice()) : "—";
  if (selected) {
    applyProductColor(selected);
    els.selected.innerHTML = `<strong>${escapeHtml(selected.name)}</strong> <span>· الكود ${escapeHtml(selected.code)} · ${effectivePriceLabel(selected)} ${money(selectedUnitPrice())}</span>`;
  } else applyProductColor(null);
  document
    .querySelectorAll(".price-btn")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.price === priceMode),
    );
  renderCart();
}
function add() {
  if (!selected) {
    toast("اكتب جزءًا من الاسم واختر منتجًا");
    els.search.focus();
    return;
  }
  const qty = Number(els.qty.value);
  if (!qty || qty <= 0) {
    toast("أدخل كمية صحيحة");
    els.qty.focus();
    return;
  }
  const existing = cart.find((x) => x.product.code === selected.code);
  if (existing) existing.qty += qty;
  else cart.push({ product: selected, qty });
  renderCart();
  els.search.value = "";
  els.qty.value = "1";
  selected = null;
  els.selected.textContent = "لم يتم اختيار منتج";
  els.selected.classList.add("empty");
  els.price.textContent = "—";
  els.search.focus();
}
function renderCart() {
  if (!cart.length)
    els.items.innerHTML =
      '<tr><td colspan="7" class="empty-row">لم تتم إضافة منتجات بعد</td></tr>';
  else
    els.items.innerHTML = cart
      .map((x, i) => {
        const original = unitPriceFor(x.product),
          unit = Number(x.customPrice ?? original),
          total = unit * x.qty,
          cls = productAgeClass(x.product.code);
        const infoButton = hasFeatureAccess("productDetails") ? `<button class="price-edit product-info-btn" data-i="${i}" title="معلومات المنتج" aria-label="معلومات المنتج">ⓘ</button>` : "";
        const priceButton = hasFeatureAccess("priceEdit") ? `<button class="price-edit" data-i="${i}" title="تعديل اسم وسعر المنتج" aria-label="تعديل اسم وسعر المنتج">✎</button>` : "";
        return `<tr class="${cls}"><td>${i + 1}</td><td><strong>${escapeHtml(x.customName ?? x.product.name)}</strong></td><td><span class="product-code">${escapeHtml(x.product.code)}</span></td><td><span>${money(unit)}</span>${x.customPrice != null ? '<small class="custom-price-mark">معدل</small>' : ""}</td><td><input class="line-qty ${cls}" data-i="${i}" type="number" min=".01" step=".01" value="${x.qty}"></td><td><strong>${money(total)}</strong></td><td><div class="line-actions">${infoButton}${priceButton}<button class="delete-line" data-i="${i}">حذف</button></div></td></tr>`;
      })
      .join("");
  els.items.querySelectorAll(".line-qty").forEach((i) =>
    i.addEventListener("change", () => {
      const q = Number(i.value);
      if (q > 0) cart[Number(i.dataset.i)].qty = q;
      renderCart();
    }),
  );
  els.items.querySelectorAll(".delete-line").forEach((b) =>
    b.addEventListener("click", () => {
      cart.splice(Number(b.dataset.i), 1);
      renderCart();
    }),
  );
  els.items
    .querySelectorAll(".price-edit:not(.product-info-btn)")
    .forEach((b) =>
      b.addEventListener("click", () => editAdvancedPrice(Number(b.dataset.i))),
    );
  els.items
    .querySelectorAll(".product-info-btn")
    .forEach((b) =>
      b.addEventListener("click", () =>
        showCartProductDetails(Number(b.dataset.i)),
      ),
    );
  const tq = cart.reduce((a, x) => a + x.qty, 0),
    total = cart.reduce((a, x) => {
      const original = unitPriceFor(x.product);
      return a + Number(x.customPrice ?? original) * x.qty;
    }, 0);
  els.itemsCount.textContent = `${cart.length.toLocaleString("en-US")} أصناف`;
  els.totalQty.textContent = tq.toLocaleString("en-US");
  els.grand.textContent = money(invoiceTotals().total);
  renderDiscountSummary();
}
function syncProgramLock() {
  const lock = $("#programLock");
  if (lock) lock.classList.toggle("hidden", !advanceLocked);
}
function updatePriceLimitLabel() {
  /* لا يوجد نص نسبة تعديل ظاهر في الواجهة */
}
async function ensureInvoiceEditAccess() {
  if (advanceLocked && !(await requestActivation())) return false;
  if (advanceUnlocked) return true;
  const key = await securePassword("primary", "تأكيد تعديل الفاتورة", "أدخل كلمة مرور تعديل السعر أو معلومات المنتج مرة واحدة لهذه الفاتورة:", ADVANCE_PASSWORD);
  if (key === ADVANCE_PASSWORD) { advanceUnlocked = true; return true; }
  if (key === "__ESCALATE__" && await requestActivation()) { advanceUnlocked = true; return true; }
  return false;
}
function openSecureModal(title, message, options = {}) {
  return new Promise((resolve) => {
    secureModalQueue.push({ title, message, options, resolve });
    if (!modalResolve) showNextSecureModal();
  });
}
function showNextSecureModal() {
  const request = secureModalQueue[0];
  if (!request) return;
  const modal = $("#passwordModal"), input = $("#modalInput");
  $("#modalTitle").textContent = request.title;
  $("#modalMessage").textContent = request.message;
  $("#modalError").textContent = "";
  input.type = request.options.type || "password";
  input.value = request.options.value ?? "";
  input.min = request.options.min ?? "";
  input.max = request.options.max ?? "";
  input.step = request.options.step ?? "";
  modalResolve = request.resolve;
  modal.classList.remove("hidden");
  setTimeout(() => input.focus(), 30);
}
function closeSecureModal(value) {
  const modal = $("#passwordModal");
  modal.classList.add("hidden");
  if (!modalResolve) return;
  const resolve = modalResolve;
  modalResolve = null;
  secureModalQueue.shift();
  resolve(value);
  showNextSecureModal();
}
function openConfirmModal(message) {
  return new Promise((resolve) => {
    confirmModalQueue.push({ message, resolve });
    if (!confirmResolve) showNextConfirmModal();
  });
}
function showNextConfirmModal() {
  const request = confirmModalQueue[0];
  if (!request) return;
  $("#confirmMessage").textContent = request.message;
  confirmResolve = request.resolve;
  $("#confirmModal").classList.remove("hidden");
}
function closeConfirmModal(value) {
  $("#confirmModal").classList.add("hidden");
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null;
  confirmModalQueue.shift();
  resolve(value);
  showNextConfirmModal();
}
function lockProgram() {
  advanceLocked = true;
  appStorage.setItem("bill:pwa:advance-locked", "1");
  syncProgramLock();
  toast("تم قفل خاصية التعديل المتقدم");
}
async function requestActivation() {
  const key = await securePassword(
    "activation",
    "تفعيل البرنامج",
    "تم تجاوز عدد المحاولات. أدخل كلمة مرور التفعيل لفتح البرنامج:",
    ACTIVATION_PASSWORD,
  );
  if (key === ACTIVATION_PASSWORD) {
    advanceLocked = false;
    appStorage.removeItem("bill:pwa:advance-locked");
    syncProgramLock();
    toast("تم تفعيل البرنامج بنجاح");
    return true;
  }
  return false;
}
async function editAdvancedPrice(index) {
  if (!requireFeatureAccess("priceEdit", "تعديل السعر غير متاح لنوع الحساب الحالي")) return;
  if (!(await ensureInvoiceEditAccess())) return;
  const item = cart[index];
  if (!item) return;
  const product = item.product;
  const nameValue = await openSecureModal(
    "اسم المنتج في هذه الفاتورة",
    "أدخل الاسم الذي سيظهر في هذه الفاتورة فقط:",
    { type: "text", value: String(item.customName ?? product.name ?? "") },
  );
  if (nameValue === null) return;
  const newName = String(nameValue).trim();
  if (!newName) {
    toast("اسم المنتج غير صحيح؛ لم يتم التعديل");
    return;
  }
  const original = unitPriceFor(product),
    current = Number(item.customPrice ?? original);
  const entered = await openSecureModal(
    "السعر في هذه الفاتورة",
    `السعر الأصلي ${money(original)}. النسبة المسموحة ±${Math.round(priceLimitRatio * 100)}%: أدخل السعر الجديد.`,
    { type: "number", value: String(current), min: "0", step: "0.01" },
  );
  if (entered === null) return;
  const value = Number(entered);
  if (!Number.isFinite(value) || value <= 0) {
    toast("السعر غير صحيح؛ لم يتم التعديل");
    return;
  }
  const min = original * (1 - priceLimitRatio),
    max = original * (1 + priceLimitRatio);
  if (value < min || value > max) {
    const key = await securePassword(
      "secondary",
      "السعر خارج الحدود",
      "السعر خارج النطاق المسموح. أدخل كلمة المرور الإضافية:",
      LIMIT_PASSWORD,
    );
    if (key === LIMIT_PASSWORD) {
    } else if (key === "__ESCALATE__") {
      if (!(await requestActivation())) return;
    } else return;
  }
  item.customName = newName;
  item.customPrice = Number(value.toFixed(2));
  recordAdminLog(
    "تعديل اسم وسعر داخل الفاتورة",
    product.code,
    `الاسم: ${newName}، السعر: ${money(value)}`,
  );
  renderCart();
  toast("تم حفظ الاسم والسعر في هذه الفاتورة فقط");
}
async function openAdvancedSettings() {
  if (!requireFeatureAccess("priceSettings", "إعدادات نسبة الأسعار غير متاحة لنوع الحساب الحالي")) return;
  if (currentUser.username === DEVELOPER_USERNAME) {
    advanceUnlocked = true;
  } else {
    if (advanceLocked && !(await requestActivation())) return;
    const key = await securePassword(
      "secondary",
      "إعدادات نسبة الأسعار",
      "أدخل كلمة مرور إعدادات نسبة الأسعار:",
      LIMIT_PASSWORD,
    );
    if (key === LIMIT_PASSWORD) {
    } else if (key === "__ESCALATE__") {
      if (!(await requestActivation())) return;
    } else return;
  }
  const entered = await openSecureModal(
    "نسبة تعديل الأسعار",
    `النسبة الحالية ±${Math.round(priceLimitRatio * 100)}%. أدخل النسبة الجديدة من 0 إلى 100:`,
    {
      type: "number",
      value: String(Math.round(priceLimitRatio * 100)),
      min: "0",
      max: "100",
      step: "1",
    },
  );
  if (entered === null) return;
  const value = Number(entered);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    toast("أدخل نسبة صحيحة بين 0 و100");
    return;
  }
  const confirmed = await openConfirmModal(
    `سيتم اعتماد نسبة ±${value}% لتعديل أسعار المستخدمين. هل تريد الحفظ؟`,
  );
  if (!confirmed) {
    toast("تم إلغاء حفظ النسبة");
    return;
  }
  priceLimitRatio = value / 100;
  appStorage.setItem("bill:pwa:price-limit", String(value));
    toast(`تم حفظ نسبة التعديل الحالية: ±${value}%`);
}
async function stopScanner() {
  const session = ++scannerSession;
  if (scannerTimer) {
    cancelAnimationFrame(scannerTimer);
    scannerTimer = 0;
  }
  const controls = scannerControls;
  scannerControls = null;
  try {
    controls?.stop?.();
  } catch (e) {}
  const stream = scannerStream;
  scannerStream = null;
  try {
    stream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch (e) {}
    });
  } catch (e) {}
  const video = $("#scannerVideo");
  if (video) {
    try {
      video.pause();
    } catch (e) {}
    video.srcObject = null;
  }
  scannerTorchOn = false;
  const modal = $("#scannerModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  const torchButton = $("#scannerTorch");
  if (torchButton) {
    torchButton.classList.add("hidden");
    torchButton.onclick = null;
  }
  const zoomControl = $("#scannerZoom");
  if (zoomControl) {
    zoomControl.classList.add("hidden");
    zoomControl.oninput = null;
  }
  return session;
}
async function decodeQrImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image(),
      url = URL.createObjectURL(file);
    image.onload = async () => {
      try {
        const canvas = document.createElement("canvas"),
          scale = Math.min(
            1,
            1600 / Math.max(image.naturalWidth, image.naturalHeight),
          );
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = window.jsQR?.(
          ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          { inversionAttempts: "attemptBoth" },
        );
        let raw = result?.data || null;
        if (!raw && window.ZXingBrowser?.BrowserMultiFormatReader) {
          try {
            const reader = new ZXingBrowser.BrowserMultiFormatReader(),
              decoded = await reader.decodeFromImageElement(image);
            raw = decoded?.getText?.() || decoded?.text || null;
          } catch (error) {}
        }
        URL.revokeObjectURL(url);
        resolve(raw);
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("تعذر قراءة الصورة"));
    };
    image.src = url;
  });
}
async function processScannedValue(raw) {
  raw = String(raw || "").trim();
  if (!raw || scannerMode !== "product") return;
  await stopScanner();
  const found = products.find((p) => String(p.code) === raw);
  if (found) { choose(found); toast(`تم العثور على المنتج: ${found.name}`); }
  else { els.search.value = raw; scheduleSuggestions(); toast(`تمت قراءة الكود: ${raw}، لكن لم يتم العثور على منتج مطابق`); }
  els.search.focus();
}

function setScannerZoom(track, control) {
  if (!track?.applyConstraints || !control) return;
  const value = Number(control.value);
  if (!Number.isFinite(value)) return;
  track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {});
}
function toggleScannerTorch(track, button) {
  if (!track?.applyConstraints) return;
  scannerTorchOn = !scannerTorchOn;
  track
    .applyConstraints({ advanced: [{ torch: scannerTorchOn }] })
    .then(() => {
      if (button)
        button.textContent = scannerTorchOn ? "إيقاف الكشاف" : "تشغيل الكشاف";
    })
    .catch(() => {
      scannerTorchOn = false;
      if (button) button.textContent = "الكشاف غير متاح";
    });
}
function invoiceTotals() {
  const subtotal = cart.reduce((a, x) => {
    const unit = Number(x.customPrice ?? unitPriceFor(x.product));
    return a + unit * Number(x.qty || 0);
  }, 0);
  const rate = Math.max(0, Math.min(100, Number($("#discountRate")?.value || 0) || 0));
  const discount = rate > 1 ? subtotal * rate / 100 : 0;
  return {subtotal, rate, discount, total: subtotal - discount};
}
function syncPaymentFields() {
  const method = $("#paymentMethod")?.value || "cash";
  const box = $("#paymentParties");
  if (box) box.classList.toggle("hidden", method === "cash");
}
function renderDiscountSummary() {
  const t = invoiceTotals(), box = $("#discountSummary");
  if (!box) return;
  box.classList.toggle("hidden", !(t.rate > 1));
  if (t.rate > 1) box.innerHTML = `<span>قبل الخصم: <b>${money(t.subtotal)}</b></span><span>الخصم ${money(t.rate)}%: <b>${money(t.discount)}</b></span><span>بعد الخصم: <b>${money(t.total)}</b></span>`;
}
function invoiceData() {
  return {
    id: makeId("invoice"),
    number: makeId("INV").replace("INV-", "").slice(-8),
    date: $("#invoiceDate").value,
    time: formatInvoiceTime(),
    customerCode: $("#customerCode").value,
    customerName: $("#customerName").value,
    city: $("#customerCity").value,
    phone: $("#customerPhone").value,
    seller: $("#seller").value,
    discountRate: Number($("#discountRate")?.value || 0) || 0,
    paymentMethod: $("#paymentMethod")?.value || "cash",
    paymentSender: $("#paymentSender")?.value || "",
    paymentReceiver: $("#paymentReceiver")?.value || "",
    notes: $("#invoiceNotes").value,
    priceMode,
    cart,
  };
}

function customerDisplayName(code, fallback = "") {
  const key = String(code || "").trim();
  const matches = customers.filter(
    (c) => normalize(c.name || "") === normalize(fallback || c.name || ""),
  );
  const found = customers.find((c) => key && String(c.code) === key);
  const base = found?.name || fallback || "عميل نقدي";
  const same = customers.filter(
    (c) => normalize(c.name || "") === normalize(base),
  );
  if (same.length <= 1) return base;
  const pos = Math.max(
    0,
    same.findIndex((c) => String(c.code) === String(found?.code || key)),
  );
  return `${base} ${pos + 1}`;
}
function renderSaved() {
  const all = JSON.parse(appStorage.getItem(KEY) || "[]");
  const query = normalize($("#savedInvoiceSearch")?.value || "");
  const visible = query ? all.filter((x) => normalize(`${x.number || ""} ${x.customerCode || ""} ${x.customerName || ""} ${x.date || ""} ${(x.cart || []).map((i) => i.product?.name || i.product?.code || "").join(" ")}`).includes(query)) : all;
  $("#savedCount").textContent = all.length.toLocaleString("en-US");
  $("#savedInvoices").innerHTML = visible.length
    ? visible
        .slice(0, 100)
        .map((x) => {
          const rawName = String(x.customerName || "").trim();
          const displayName = customerDisplayName(x.customerCode, x.customerName);
          const hasName = rawName !== "";

          // العنوان الرئيسي: اسم العميل لو موجود، وإلا رقم الفاتورة
          const mainTitle = hasName ? displayName : String(x.number);

          // السطر الفرعي: الرقم + التاريخ لو في اسم، وإلا التاريخ فقط
          const subtitle = hasName
            ? `فاتورة رقم ${escapeHtml(String(x.number))} · ${escapeHtml(x.date || "")}`
            : escapeHtml(x.date || "");

          return `<div class="saved-item"><label class="invoice-check"><input type="checkbox" data-select-invoice="${x.id}"><span></span></label><div class="saved-details"><strong>${escapeHtml(mainTitle)}</strong><small> · ${subtitle}</small></div><div class="saved-actions"><button data-print="${x.id}">طباعة</button><button data-load="${x.id}">فتح</button></div></div>`;
        })
        .join("")
    : '<div class="empty-row">لا توجد فواتير محفوظة</div>';
  document
    .querySelectorAll("[data-load]")
    .forEach((b) =>
      b.addEventListener("click", () => loadInvoice(Number(b.dataset.load))),
    );
  document.querySelectorAll("[data-print]").forEach((b) =>
    b.addEventListener("click", () => {
      loadInvoice(Number(b.dataset.print));
      setTimeout(printInvoice, 80);
    }),
  );
  document
    .querySelectorAll("[data-select-invoice]")
    .forEach((b) => b.addEventListener("change", updateSelectAllState));
  updateSelectAllState();
}
function selectedInvoiceIds() {
  return [...document.querySelectorAll("[data-select-invoice]:checked")].map(
    (x) => String(x.dataset.selectInvoice),
  );
}
function updateSelectAllState() {
  const boxes = [...document.querySelectorAll("[data-select-invoice]")],
    master = $("#selectAllInvoices");
  if (!master) return;
  master.checked = boxes.length > 0 && boxes.every((x) => x.checked);
  master.indeterminate = boxes.some((x) => x.checked) && !master.checked;
}
async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}
async function downloadBlob(blob, filename) {
  if (window.InvoiceNative?.saveFile) {
    const response = await window.InvoiceNative.saveFile({
      filename,
      mime: blob.type || "application/octet-stream",
      data: await blobToBase64(blob),
    });
    if (response?.path) toast(`تم حفظ الملف في ${response.path}`);
    return response;
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "Invoice export", accept: { [blob.type || "application/octet-stream"]: [`.${String(filename).split(".").pop()}`] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast(`تم حفظ الملف في ${handle.name}`);
      return { path: handle.name };
    } catch (error) {
      if (error?.name === "AbortError") return { path: "" };
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  return { path: "التنزيلات" };
}
async function downloadJson(data, filename) {
  return downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    filename,
  );
}
function databaseExportPayload() {
  return {
    version: 4,
    format: "invoice-program-database-export",
    products: products.map(({ searchText, ...item }) => item),
    customers,
    users: getUsers(),
    employees: employeeRecords(),
    payroll: payrollRecords(),
    customerHistory,
    invoices: safeJson(appStorage.getItem(KEY) || "[]", []),
    inventories: safeJson(appStorage.getItem(INVENTORY_KEY) || "[]", []),
    permissions: getFeaturePermissions(),
    adminLog: safeJson(appStorage.getItem(ADMIN_LOG_KEY) || "[]", []),
    exportedAt: new Date().toISOString(),
  };
}
function exportRows(rows) {
  if (window.InvoiceExport?.exportRows) return window.InvoiceExport.exportRows(rows);
  return (rows || []).map((row) => Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, value && typeof value === "object" ? JSON.stringify(value) : value])
  ));
}
async function exportWorkbook(data, filename) {
  if (window.InvoiceExport?.workbookBlob) {
    const blob = window.InvoiceExport.workbookBlob(data, filename);
    if (blob) { await downloadBlob(blob, filename); return true; }
  }
  if (!window.XLSX) return false;
  const book = XLSX.utils.book_new();
  const sheets = [
    ["Products", data.products], ["Customers", data.customers], ["Users", data.users],
    ["CustomerHistory", data.customerHistory], ["Invoices", data.invoices],
    ["Inventory", data.inventories], ["AdminLog", data.adminLog],
  ];
  sheets.forEach(([name, rows]) => XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(exportRows(rows)), name));
  const output = XLSX.write(book, { bookType: "xlsx", type: "array" });
  await downloadBlob(new Blob([output], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  return true;
}
async function exportSectionRows(name, rows, format) { const date=new Date().toISOString().slice(0,10); if(format==="json") return downloadJson({version:1,[name]:rows,exportedAt:new Date().toISOString()},`${name}-${date}.json`); if(format==="excel"&&window.XLSX){const book=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(exportRows(rows)),name.slice(0,30)); const output=XLSX.write(book,{bookType:"xlsx",type:"array"}); return downloadBlob(new Blob([output],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),`${name}-${date}.xlsx`);} const saved=(await idbReadDatabaseFiles()).records.find((x)=>String(x.name).toLowerCase().endsWith(".mdb")); if(saved)return downloadBlob(saved.blob,saved.name); toast("لا توجد نسخة MDB أصلية محفوظة"); }
function exportSelectedInvoices() {
  const ids = selectedInvoiceIds();
  if (!ids.length) {
    toast("حدد فاتورة واحدة على الأقل للتصدير");
    return;
  }
  const invoices = JSON.parse(appStorage.getItem(KEY) || "[]").filter((x) =>
    ids.includes(String(x.id)),
  );
  exportSectionRows("invoices", invoices, $("#invoiceExportFormat")?.value || "json");
  toast(`تم تصدير ${invoices.length.toLocaleString("en-US")} فاتورة`);
}
async function deleteSelectedInvoices() {
  const ids = selectedInvoiceIds();
  if (!ids.length) {
    toast("حدد فاتورة واحدة على الأقل للحذف");
    return;
  }
  if (!(await openConfirmModal(`هل تريد حذف ${ids.length.toLocaleString("en-US")} فاتورة محددة؟`))) return;
  const all = JSON.parse(appStorage.getItem(KEY) || "[]").filter(
    (x) => !ids.includes(String(x.id)),
  );
  appStorage.setItem(KEY, JSON.stringify(all));
  renderSaved();
  toast("تم حذف الفواتير المحددة");
}
function loadInvoice(id) {
  const x = JSON.parse(appStorage.getItem(KEY) || "[]").find(
    (i) => String(i.id) === String(id),
  );
  if (!x) return;
  const currentMode = priceMode;
  Object.entries({
    customerCode: x.customerCode,
    customerName: x.customerName,
    customerCity: x.city,
    customerPhone: x.phone,
    seller: x.seller,
    discountRate: x.discountRate || 0,
    paymentMethod: x.paymentMethod || "cash",
    paymentSender: x.paymentSender || "",
    paymentReceiver: x.paymentReceiver || "",
    invoiceDate: x.date,
    invoiceNotes: x.notes,
  }).forEach(([k, v]) => {
    if ($("#" + k)) $("#" + k).value = v || "";
  });
  priceMode = currentMode;
  let discardedHistoricalPrices = 0;
  cart = (x.cart || []).map((row) => {
    const code = String(row?.product?.code ?? row?.code ?? "");
    const current = products.find((p) => String(p.code) === code);
    const historicalPrice = Number(row?.customPrice);
    if (row?.customPrice != null && (!Number.isFinite(historicalPrice) || historicalPrice <= 0)) discardedHistoricalPrices++;
    return { ...row, product: current || row.product, customPrice: Number.isFinite(historicalPrice) && historicalPrice > 0 ? historicalPrice : undefined };
  });
  selected = null;
  renderCart();
  updatePrice();
  toast(
    `تم فتح الفاتورة بأسعار ${priceMode === "wholesale" ? "الفئة أ" : "الفئة ب"} للمستخدم الحالي`,
  );
  if (discardedHistoricalPrices) toast("تم تجاهل سعر تاريخي غير صالح في الفاتورة");
}
function newInvoice() {
  cart = [];
  selected = null;
  priceMode = "wholesale";
  advanceUnlocked = false;
  [
    "customerCode",
    "customerName",
    "customerCity",
    "customerPhone",
    "seller",
  ].forEach((id) => ($("#" + id).value = ""));
  $("#invoiceNotes").value = "";
  $("#discountRate").value = "0";
  $("#paymentMethod").value = "cash";
  $("#paymentSender").value = ""; $("#paymentReceiver").value = "";
  syncPaymentFields();
  setDate();
  els.search.value = "";
  els.qty.value = "1";
  els.selected.textContent = "لم يتم اختيار منتج";
  els.selected.classList.add("empty");
  updatePrice();
  els.search.focus();
}

function openExportImportModal() { if (!requireFeatureAccess("databaseExport", "إدارة تصدير واستيراد البيانات للمطورين فقط")) return; closeAccountMenu(); $("#exportImportModal")?.classList.remove("hidden"); }
function closeExportImportModal() { $("#exportImportModal")?.classList.add("hidden"); }
async function exportDatabaseByFormat() {
  const format = $("#databaseExportFormat")?.value || "json";
  const scope = $("#databaseExportScope")?.value || "all";
  const data = databaseExportPayload();
  const date = new Date().toISOString().slice(0, 10);
  const names = { products: "products", customers: "customers", employees: "employees", users: "users", invoices: "invoices", inventory: "inventory" };
  const scoped = scope === "all" ? data : scope === "inventory" ? { inventories: data.inventories, payroll: data.payroll } : { [scope]: data[scope] || [] };
  if (format === "json") await downloadJson({ version: data.version, format: "invoice-program-export", scope, ...scoped }, `database-${scope}-${date}.json`);
  else if (format === "excel") await exportWorkbook(scoped, `database-${scope}-${date}.xlsx`);
  else {
    const saved = (await idbReadDatabaseFiles()).records.find((x) => String(x.name).toLowerCase().endsWith(".mdb"));
    if (!saved) { toast("لا توجد نسخة MDB أصلية محفوظة للتصدير"); return; }
    if (scope !== "all") { toast("تصدير MDB المنفصل يحتاج قاعدة MDB قابلة للكتابة؛ سيتم تصدير قاعدة MDB الأصلية كاملة"); }
    await downloadBlob(saved.blob, `database-${scope}-${saved.name}`);
  }
  recordAdminLog("تصدير البيانات", `${scope}:${format}`);
  toast(scope === "all" ? "تم تصدير كل البيانات في ملف واحد" : `تم تصدير قسم ${names[scope] || scope}`);
}
async function importDatabaseByFormat(file) { if (!file) return; const ext = String(file.name).toLowerCase().split(".").pop(); if (ext === "json") await importBackup(file); else if (["mdb", "xlsx", "xls"].includes(ext)) await loadSelectedDataFolder([file]); else toast("الامتداد غير مدعوم"); closeExportImportModal(); }

async function exportDatabasePackage() {
  if (!requireFeatureAccess("databaseExport", "تصدير كل البيانات غير متاح لنوع الحساب الحالي")) return;
  const data = databaseExportPayload();
  const date = new Date().toISOString().slice(0, 10);
  await downloadJson(data, `database-export-${date}.json`);
  await exportWorkbook(data, `database-export-${date}.xlsx`);
  recordAdminLog("تصدير كل البيانات", "database");
  toast("تم تصدير بيانات البرنامج بصيغة JSON و Excel");
}
async function exportData() {
  const data = databaseExportPayload();
  await downloadJson(data, `bill-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast("تم تصدير نسخة البيانات");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.invoices)) throw Error("invalid");
    appStorage.setItem(KEY, JSON.stringify(data.invoices));
    if (Array.isArray(data.products)) appStorage.setItem(PRODKEY, JSON.stringify(data.products));
    if (Array.isArray(data.customers)) appStorage.setItem("bill:pwa:customers:v1", JSON.stringify(data.customers));
    if (Array.isArray(data.customerHistory)) appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(data.customerHistory));
    if (Array.isArray(data.inventories)) appStorage.setItem(INVENTORY_KEY, JSON.stringify(data.inventories));
    if (data.permissions && typeof data.permissions === "object") saveFeaturePermissions(data.permissions);
    if (Array.isArray(data.users) && data.users.length) saveUsers(data.users);
    if (Array.isArray(data.adminLog)) appStorage.setItem(ADMIN_LOG_KEY, JSON.stringify(data.adminLog));
    await loadProducts();
    await loadCustomers();
    renderSaved();
    renderUserList();
    applyFeatureAccess();
    toast(`تم استرداد ${data.invoices.length.toLocaleString("en-US")} فاتورة`);
  } catch (e) {
    toast("ملف النسخة الاحتياطية غير صحيح");
  }
}
function renderPrintSheet() {
  const d = invoiceData(),
    total = invoiceTotals().total,
    subtotal = invoiceTotals().subtotal,
    discount = invoiceTotals().discount,
    discountRate = invoiceTotals().rate,
    qty = cart.reduce((a, x) => a + x.qty, 0),
    rowsPerPage = 35,
    pages = [];
  for (let i = 0; i < cart.length; i += rowsPerPage)
    pages.push(cart.slice(i, i + rowsPerPage));
  const pageRows = (rows) =>
    rows
      .map((x) => {
        const original = unitPriceFor(x.product),
          unit = Number(x.customPrice ?? original);
        return `<tr><td>${escapeHtml(x.product.code)}</td><td>${escapeHtml(x.customName ?? x.product.name)}</td><td>${x.qty}</td><td>${money(unit)}</td><td>${money(unit * x.qty)}</td></tr>`;
      })
      .join("");
  const pageTemplate = (
    rows,
    index,
    last,
  ) => `<section class="print-page${last ? " print-page-last" : ""}"><div class="print-head">
<!--<img class="print-logo" src="${escapeHtml(document.querySelector(".brand-logo")?.getAttribute("src") || "")}" alt="Bill">-->
<div><h1>فاتورة مبيعات مؤقتة رقم : ${escapeHtml(d.number)}</h1></div><div>${escapeHtml(String(d.date || "").replace(/-/g, "/"))}<br>الوقت : ${escapeHtml(d.time)}</div></div><div class="print-customer">
  <span class="customer-client"><b>العميل:</b> <span class="customer-code">${escapeHtml(d.customerCode || "—")}</span></span>
  <span class="customer-name">${escapeHtml(d.customerName || "")}</span>
  <span class="customer-city">البلد: ${escapeHtml(d.city || "—")}</span>
</div><div class="print-meta"><div class="print-meta-row"><span>التاريخ: ${escapeHtml(String(d.date || "").replace(/-/g, "/"))}</span><span>الوقت: ${escapeHtml(d.time)}</span></div><div class="print-meta-row"><span>البائع: ${escapeHtml(d.seller || "—")}</span><span>طريقة الدفع ${escapeHtml(d.paymentMethod === "cash" ? "كاش" : d.paymentMethod === "wallet" ? "محفظة" : "طريقة أخرى")}</span><span>الهاتف ${escapeHtml(d.phone || "")}</span></div></div><table class="print-table"><thead><tr><th>كود الصنف</th><th>الصنف</th><th>الكمية</th><th>سعر البيع</th><th>الإجمالي</th></tr></thead><tbody>${pageRows(rows)}</tbody>${last ? `<tfoot><tr><th colspan="2">الجملة قبل الخصم</th><th class="qty-cell">${qty}</th><th colspan="2">${money(subtotal)}</th></tr>${discountRate > 1 ? `<tr><th colspan="4">الخصم (${money(discountRate)}%)</th><th>${money(discount)}</th></tr><tr><th colspan="4">السعر بعد الخصم / إجمالي الفاتورة</th><th>${money(total)}</th></tr>` : ""}</tfoot>` : ""}</table>${last && d.paymentMethod !== "cash" ? `<div class="print-payment"><span>المرسل (العميل): ${escapeHtml(d.paymentSender || "—")}</span><span>المستلم (المحل): ${escapeHtml(d.paymentReceiver || "—")}</span></div>` : ""}${last ? `<div class="print-bottom"><div class="print-summary-line"><span class="print-total">قيمة الفاتورة: <strong>${money(total)}</strong></span><span class="print-notes"><b>ملاحظات</b> ${escapeHtml(d.notes || "")}</span></div><div class="print-terms"><div>لا يوجد استبدال أو مرتجع للمستورد نهائيا أما المصرى يقبل الاستبدال أو المرتجعة إذا كان به عيب فقط و ذلك خلال 15 يوم و باصل الفاتورة</div><div>طهطا ش بورسعيد خلف المركز - ت: 01158760078 &amp; 01270801908 &nbsp;&nbsp;&nbsp;&nbsp; *** &nbsp;&nbsp;&nbsp;&nbsp; مواعيد العمل: صيفا من 9ص حتى 8:30م &amp; شتاءً من 9ص حتى 7:30 م</div><div>الإجازة الأسبوعية يوم الجمعة - ابتدأ من عيد الفطر المبارك القادم</div></div></div>` : ""}</section>`;
  $("#printSheet").innerHTML = pages
    .map((rows, index) => pageTemplate(rows, index, index === pages.length - 1))
    .join("");
}
async function printInvoice() {
  if (!cart.length) {
    toast("أضف منتجًا قبل الطباعة");
    return;
  }
  renderPrintSheet();
  const logo = document.querySelector("#printSheet .print-logo");
  if (logo && (!logo.complete || !logo.naturalWidth)) {
    await new Promise((resolve) => {
      const done = () => {
        logo.removeEventListener("load", done);
        logo.removeEventListener("error", done);
        resolve();
      };
      logo.addEventListener("load", done, { once: true });
      logo.addEventListener("error", done, { once: true });
      setTimeout(done, 1200);
    });
  }
  const oldTitle = document.title;
  document.title = ($("#customerName").value || "").trim() || "invoice";
  if (window.InvoiceNative?.savePdf) {
    try {
      const saved = await window.InvoiceNative.savePdf({ filename: `${document.title || "invoice"}.pdf` });
      if (saved?.path) toast(`تم حفظ ملف PDF في ${saved.path}`);
    } catch (error) {
      window.print();
    }
  } else {
    window.print();
  }
  setTimeout(() => {
    document.title = oldTitle;
  }, 1500);
}
els.search.addEventListener("input", scheduleSuggestions);
els.search.oninput = scheduleSuggestions;
els.search.addEventListener("keydown", (e) => {
  const list = [...els.suggestions.querySelectorAll(".suggestion[data-index]")];
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestion = Math.min(activeSuggestion + 1, list.length - 1);
    list.forEach((x, i) =>
      x.classList.toggle("active", i === activeSuggestion),
    );
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion = Math.max(activeSuggestion - 1, 0);
    list.forEach((x, i) =>
      x.classList.toggle("active", i === activeSuggestion),
    );
  } else if (e.key === "Enter" && activeSuggestion >= 0) {
    e.preventDefault();
    list[activeSuggestion]?.dispatchEvent(new MouseEvent("mousedown"));
  } else if (e.key === "Escape") els.suggestions.classList.remove("open");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".product-search"))
    els.suggestions.classList.remove("open");
});
document.querySelectorAll(".price-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (cart.length) {
      toast("لا يمكن تغيير النظام بعد إضافة المنتجات");
      return;
    }
    priceMode = b.dataset.price;
    updatePrice();
  }),
);
$("#discountRate").addEventListener("input", renderCart);
$("#paymentMethod").addEventListener("change", syncPaymentFields);
syncPaymentFields();
$("#addProduct").addEventListener("click", add);
els.qty.addEventListener("keydown", (e) => {
  if (e.key === "Enter") add();
});
$("#saveInvoice").addEventListener("click", save);
$("#printInvoice").addEventListener("click", printInvoice);
$("#newInvoice").addEventListener("click", newInvoice);
$("#exportData").addEventListener("click", exportData);
$("#exportSelected").addEventListener("click", exportSelectedInvoices);
$("#deleteSelected").addEventListener("click", deleteSelectedInvoices);
$("#savedInvoiceSearch")?.addEventListener("input", renderSaved);
$("#selectAllInvoices").addEventListener("change", (e) => {
  document.querySelectorAll("[data-select-invoice]").forEach((x) => {
    x.checked = e.target.checked;
  });
  updateSelectAllState();
});
$("#importBackup").addEventListener("change", (e) => {
  if (e.target.files[0]) importBackup(e.target.files[0]);
  e.target.value = "";
});
$("#customerCode").addEventListener("input", (e) =>
  renderCustomer(e.target.value),
);
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    printInvoice();
  }
  if (e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
  if (e.ctrlKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newInvoice();
  }
  if (
    e.key === "Delete" &&
    document.activeElement.classList.contains("line-qty")
  ) {
    const i = Number(document.activeElement.dataset.i);
    cart.splice(i, 1);
    renderCart();
  }
});
window.addEventListener("beforeinstallprompt", (e) => {
  if (window.InvoiceNative) return;
  e.preventDefault();
  deferredPrompt = e;
  $("#installBtn").classList.remove("hidden");
});
$("#installBtn").addEventListener("click", async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt = null;
  }
});
function showUpdateButton() {
  if (window.InvoiceNative) return;
  const button = $("#updateBtn");
  if (button && pendingRegistration?.waiting) button.classList.remove("hidden");
}
function watchForUpdates(registration) {
  pendingRegistration = registration;
  const showIfWaiting = () => {
    if (registration.waiting) showUpdateButton();
  };
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") showIfWaiting();
    });
  });
  showIfWaiting();
  registration.update().catch(() => {});
  setInterval(() => registration.update().catch(() => {}), 10 * 60 * 1000);
}
$("#updateBtn").addEventListener("click", () => {
  const waiting = pendingRegistration?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  $("#updateBtn").textContent = "جاري التحديث...";
  $("#updateBtn").disabled = true;
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", reload, {
    once: true,
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
  setTimeout(reload, 5000);
});
window.addEventListener("load", () =>
  setTimeout(() => $("#startupSplash")?.classList.add("is-hidden"), 650),
);
$("#unlockProgram").addEventListener("click", requestActivation);
$("#passwordForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#modalInput");
  if (input.value.trim()) closeSecureModal(input.value.trim());
  else $("#modalError").textContent = "أدخل قيمة صحيحة";
});
$("#modalCancel").addEventListener("click", () => closeSecureModal(null));
$("#passwordModal").addEventListener("click", (e) => {
  if (e.target.id === "passwordModal") closeSecureModal(null);
});
$("#confirmOk").addEventListener("click", () => closeConfirmModal(true));
$("#confirmCancel").addEventListener("click", () => closeConfirmModal(false));
$("#confirmModal").addEventListener("click", (e) => {
  if (e.target.id === "confirmModal") closeConfirmModal(false);
});
$("#accountMenuButton").addEventListener("click", openAccountMenu);
$("#accountMenuClose").addEventListener("click", closeAccountMenu);
$("#accountMenuModal").addEventListener("click", (e) => {
  if (e.target.id === "accountMenuModal") closeAccountMenu();
});
$("#accountManageUsers").addEventListener("click", () => {
  closeAccountMenu();
  openUserManager();
});
$("#accountManageDevices").addEventListener("click", openDevicesManager);
$("#accountLoginAttempts").addEventListener("click", openLoginAttempts);
$("#closeLoginAttempts").addEventListener("click", closeLoginAttempts);
$("#loginAttemptsModal").addEventListener("click", (e) => {
  if (e.target.id === "loginAttemptsModal") closeLoginAttempts();
});
$("#deviceUnlockButton").addEventListener("click", unlockDeviceWithZaxcel);
$("#closeDevices").addEventListener("click", closeDevicesManager);
$("#devicesModal").addEventListener("click", (e) => {
  if (e.target.id === "devicesModal") closeDevicesManager();
});
$("#exportDatabasePackage").addEventListener("click", openExportImportModal);
$("#accountPriceSettings").addEventListener("click", () => {
  closeAccountMenu();
  openAdvancedSettings();
});
$("#accountManagePasswords")?.addEventListener("click", () => {
  closeAccountMenu();
  openPasswordManager();
});
$("#closePasswordManager")?.addEventListener("click", closePasswordManager);
$("#passwordManagerForm")?.addEventListener("submit", saveManagedPasswords);
$("#resetPasswordsToDefault")?.addEventListener("click", resetPasswordsToDefault);
$("#passwordManagerModal")?.addEventListener("click", (e) => {
  if (e.target.id === "passwordManagerModal") closePasswordManager();
});
$("#accountLogout").addEventListener("click", logoutUser);
$("#closeUserManager").addEventListener("click", closeUserManager);
$("#userForm").addEventListener("submit", addUser);
$("#exportUsers").addEventListener("click", () => {
  if (currentUser?.role !== "developer") {
    toast("هذه الخاصية للمطوّر فقط");
    return;
  }
  downloadJson(
    {
      version: 1,
      users: getUsers()
        .filter((user) => user.username !== DEVELOPER_USERNAME)
        .map(({ password, ...user }) => user),
      updatedAt: new Date().toISOString(),
    },
    "users.json",
  );
  toast("تم تنزيل users.json");
});
$("#importUsers").addEventListener("change", (e) => {
  if (e.target.files[0]) importUsersFile(e.target.files[0]);
  e.target.value = "";
});
$("#closeProductDetails").addEventListener("click", closeProductDetails);
$("#productDetailsModal").addEventListener("click", (e) => {
  if (e.target.id === "productDetailsModal") closeProductDetails();
});
$("#scannerClose").addEventListener("click", stopScanner);
$("#scanFromImage").addEventListener("click", () => $("#scannerFile").click());
$("#scannerFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const raw = await decodeQrImage(file);
    if (!raw) throw new Error("لم يتم العثور على باركود واضح في الصورة");
    await processScannedValue(raw);
  } catch (error) {
    $("#scannerMessage").textContent =
      error.message || "تعذر قراءة الباركود من الصورة";
  }
});
$("#scannerModal").addEventListener("click", (e) => {
  if (e.target.id === "scannerModal") stopScanner();
});
$("#scanProductButton").addEventListener("click", () => openScanner("product"));
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await loginFromForm(e);
});
$("#guestModeButton")?.addEventListener("click", startGuestSession);
$("#exitGuestMode")?.addEventListener("click", async () => {
  const ok = await openConfirmModal(
    "هل تريد إنهاء وضع الضيف؟ لن يتاح مرة أخرى إلا بعد 24 ساعة."
  );
  if (ok) endGuestSession("manual");
});
$("#chooseDataSource").addEventListener("click", async () => {
  if (window.showDirectoryPicker) {
    try {
      const directory = await window.showDirectoryPicker({ mode: "readwrite" });
      const files = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "file" || !/\.(mdb|json|xlsx|xls)$/i.test(name)) continue;
        const file = await handle.getFile();
        file.handle = handle;
        files.push(file);
      }
      if (files.length) { await loadSelectedDataFolder(files); return; }
      toast("المجلد لا يحتوي على ملفات بيانات مدعومة");
    } catch (error) {
      if (error?.name !== "AbortError") toast("تعذر فتح مجلد البيانات");
    }
    return;
  }
  $("#dataSourceInput")?.click();
});
$("#dataSourceInput").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (files?.length) await loadSelectedDataFolder(files);
  e.target.value = "";
});
function openProductLookup() {
  if (!requireFeatureAccess("productLookup", "بحث معلومات المنتج غير متاح لنوع الحساب الحالي")) return;
  closeAccountMenu();
  $("#productLookupModal")?.classList.remove("hidden");
  $("#productLookupInput")?.focus();
  renderProductLookup();
}
function closeProductLookup() { $("#productLookupModal")?.classList.add("hidden"); }
function renderProductLookup() {
  const box = $("#productLookupResults"); if (!box) return;
  const query = normalize($("#productLookupInput")?.value || "");
  const exact = query ? getProductByCode(query) : null;
  const rows = exact ? [exact] : (query ? findProducts(query) : products.slice(0, 50));
  box.innerHTML = rows.length ? rows.map((p) => `<button type="button" class="user-row" data-product-lookup-code="${escapeHtml(p.code)}"><strong>${escapeHtml(p.name || p.code)}</strong><small>الكود ${escapeHtml(p.code)} · الفئة أ ${money(p.wholesale)} · الفئة ب ${money(p.retail)} · الشراء ${money(p.I_P_Price)}</small></button>`).join("") : '<div class="empty-row">لا توجد نتائج</div>';
  box.querySelectorAll("[data-product-lookup-code]").forEach((button) => button.addEventListener("click", () => showLookupProduct(button.dataset.productLookupCode)));
}
function showLookupProduct(code) {
  const p = products.find((item) => String(item.code) === String(code)); if (!p) return;
  const box = $("#productDetailsBody"); if (!box) return;
  const row = (label, value) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value == null || value === "" ? "—" : String(value))}</strong></div>`;
  box.innerHTML = [row("اسم المورد", p.supplierName || p.supplier), row("اسم الصنف", p.name), row("الكود", p.code), row("سعر البيع جملة", money(p.wholesale)), row("سعر البيع نصف جملة", money(p.halfWholesale ?? p.I_S_Price_N)), row("سعر البيع قطاعي", money(p.retail)), row("سعر الشراء", money(p.I_P_Price)), row("الكمية", p.quantity || p.stock || "—"), row("الوصف", p.description || p.notes)].join("");
  $("#productDetailsModal")?.classList.remove("hidden");
}
async function showCartProductDetails(index) {
  if (!requireFeatureAccess("productDetails", "معلومات المنتج غير متاحة لنوع الحساب الحالي")) return;
  if (!(await ensureInvoiceEditAccess())) return;
  const item = cart[index];
  const p = item?.product;
  if (!p) return;
  const box = $("#productDetailsBody");
  if (!box) return;
  const detailRow = (label, value, dir = "auto") =>
    `<div class="product-detail-row"><strong>${label} :</strong><span dir="${dir}">${escapeHtml(value ?? "غير موجود")}</span></div>`;
  box.innerHTML = [
    detailRow("اسم المورد", p.supplierName || p.supplier || "", "rtl"),
    detailRow("اسم الصنف", p.name || "", "rtl"),
    detailRow("كود المنتج", p.code, "ltr"),
    detailRow("الحد الأدنى لإعادة الطلب", p.Min_Reorder, "ltr"),
    detailRow("الخصم", p.I_Disc, "ltr"),
    detailRow("سعر الشراء", p.I_P_Price, "ltr"),
    detailRow("سعر البيع جملة", p.wholesale, "ltr"),
    detailRow("سعر البيع نصف جملة", p.halfWholesale ?? p.I_S_Price_N, "ltr"),
    detailRow("سعر البيع قطاعي", p.retail, "ltr"),
  ].join("");
  $("#productDetailsModal").classList.remove("hidden");
}
function closeProductDetails() {
  $("#productDetailsModal")?.classList.add("hidden");
}

/* ==================== بداية إدارة صلاحيات الأدوات ==================== */
async function openFeaturePermissions() {
  if (!isPrimaryDeveloper()) {
    toast("هذه الخاصية للمطور الأساسي فقط");
    return;
  }
  const verified = await securePassword("permissions", "إدارة الصلاحيات", "أدخل كلمة مرور حساب المطور الأساسي", DEVELOPER_PASSWORD);
  if (verified !== DEVELOPER_PASSWORD) return;
  closeAccountMenu();
  renderFeaturePermissions();
  $("#featurePermissionsModal")?.classList.remove("hidden");
}
function renderFeaturePermissions() {
  const box = $("#featurePermissionList");
  if (!box) return;
  const permissions = getFeaturePermissions();
  box.innerHTML = FEATURE_DEFINITIONS.map((item) => `<label>${escapeHtml(item.label)}<select data-feature-permission="${item.key}"><option value="user" ${permissions[item.key] === "user" ? "selected" : ""}>جميع المستخدمين</option><option value="developer" ${permissions[item.key] === "developer" ? "selected" : ""}>المطورون فقط</option><option value="primary" ${permissions[item.key] === "primary" ? "selected" : ""}>المطور الأساسي فقط</option></select></label>`).join("");
}
function closeFeaturePermissions() {
  $("#featurePermissionsModal")?.classList.add("hidden");
}
function saveFeaturePermissionsFromForm(event) {
  event.preventDefault();
  if (!isPrimaryDeveloper()) return;
  const next = {};
  document.querySelectorAll("[data-feature-permission]").forEach((select) => { next[select.dataset.featurePermission] = select.value; });
  saveFeaturePermissions(next);
  recordAdminLog("تعديل الصلاحيات", "feature-permissions");
  applyFeatureAccess();
  renderCart();
  closeFeaturePermissions();
  toast("تم حفظ الصلاحيات");
}
/* ==================== نهاية إدارة صلاحيات الأدوات ==================== */

/* ==================== بداية جرد المخزون ==================== */
function inventoryRecords() {
  return safeJson(appStorage.getItem(INVENTORY_KEY) || "[]", []);
}
function inventoryOptions() {
  const list = $("#inventoryProductOptions");
  if (!list) return;
  list.innerHTML = products.map((product) => `<option value="${escapeHtml(product.name)}">${escapeHtml(product.code)}</option>`).join("");
}
function lookupInventoryProduct(value) {
  const text = String(value || "").trim();
  const target = normalize(text);
  return products.find((product) => String(product.code) === text || normalize(product.name) === target) || null;
}
function inventoryRowHtml(item = {}) {
  return `<tr data-inventory-row><td><input class="inventory-name" list="inventoryProductOptions" value="${escapeHtml(item.productName || "")}" autocomplete="off"><small class="inventory-code">${escapeHtml(item.productCode || "")}</small></td><td><input class="inventory-quantity" type="number" min="0" step="0.01" value="${item.quantity ?? ""}"></td><td><input class="inventory-wholesale" type="number" min="0" step="0.01" value="${item.wholesale ?? ""}"></td><td><input class="inventory-retail" type="number" min="0" step="0.01" value="${item.retail ?? ""}"></td><td><input class="inventory-purchase" type="number" min="0" step="0.01" value="${item.purchasePrice ?? ""}"></td><td><input class="inventory-row-notes" value="${escapeHtml(item.notes || "")}"></td><td><input class="inventory-add-product" type="checkbox" ${item.addToProducts ? "checked" : ""}></td></tr>`;
}
function attachInventoryRow(row) {
  const name = row.querySelector(".inventory-name");
  const fill = () => {
    const product = lookupInventoryProduct(name.value);
    const code = row.querySelector(".inventory-code");
    if (product) {
      code.textContent = product.code;
      row.dataset.productCode = product.code;
      row.querySelector(".inventory-wholesale").value = product.wholesale ?? "";
      row.querySelector(".inventory-retail").value = product.retail ?? "";
      row.querySelector(".inventory-purchase").value = product.I_P_Price ?? "";
      row.querySelector(".inventory-add-product").checked = false;
    } else {
      code.textContent = "منتج جديد";
      delete row.dataset.productCode;
      row.querySelector(".inventory-add-product").checked = Boolean(name.value.trim());
    }
    ensureInventoryTrailingRow();
  };
  name.addEventListener("change", fill);
  name.addEventListener("blur", fill);
  row.querySelectorAll("input").forEach((input) => input.addEventListener("blur", ensureInventoryTrailingRow));
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    ensureInventoryTrailingRow();
    const rows = [...document.querySelectorAll("[data-inventory-row]")];
    const index = rows.indexOf(row);
    rows[index + 1]?.querySelector(".inventory-name")?.focus();
  });
}
function addInventoryRow(item = {}) {
  const body = $("#inventoryItems");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", inventoryRowHtml(item));
  attachInventoryRow(body.lastElementChild);
}
function ensureInventoryTrailingRow() {
  const rows = [...document.querySelectorAll("[data-inventory-row]")];
  const last = rows[rows.length - 1];
  if (!last || last.querySelector(".inventory-name")?.value.trim()) addInventoryRow();
}
function openInventory() {
  if (!requireFeatureAccess("inventory", "جرد المخزون للمطورين فقط")) return;
  closeAccountMenu();
  inventoryOptions();
  $("#inventoryItems").innerHTML = "";
  addInventoryRow();
  $("#inventoryNotes").value = "";
  renderInventoryHistory();
  $("#inventoryModal")?.classList.remove("hidden");
  $("#inventoryItems .inventory-name")?.focus();
}
function closeInventory() {
  $("#inventoryModal")?.classList.add("hidden");
}
function inventoryInputRows() {
  return [...document.querySelectorAll("[data-inventory-row]")].map((row, index) => {
    const name = row.querySelector(".inventory-name").value.trim();
    if (!name) return null;
    const product = lookupInventoryProduct(name);
    const number = (selector) => {
      const value = Number(row.querySelector(selector).value);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    return {
      id: makeId("inventory-item"),
      productId: product?.code || null,
      productCode: product?.code || makeId("INV"),
      productName: product?.name || name,
      quantity: number(".inventory-quantity"),
      wholesale: number(".inventory-wholesale"),
      retail: number(".inventory-retail"),
      purchasePrice: number(".inventory-purchase"),
      notes: row.querySelector(".inventory-row-notes").value.trim(),
      addToProducts: !product && row.querySelector(".inventory-add-product").checked,
    };
  }).filter(Boolean);
}
async function saveInventory() {
  if (!requireFeatureAccess("inventory", "جرد المخزون للمطورين فقط")) return;
  const items = inventoryInputRows();
  if (!items.length) {
    toast("أدخل منتجًا واحدًا على الأقل");
    return;
  }
  const changes = items.filter((item) => {
    const product = products.find((entry) => entry.code === item.productId);
    return product && [
      ["wholesale", item.wholesale], ["retail", item.retail], ["I_P_Price", item.purchasePrice],
    ].some(([key, value]) => Number(product[key] || 0) !== Number(value || 0));
  });
  if (changes.length && !(await openConfirmModal(`سيتم تحديث أسعار ${changes.length} منتج حسب الجرد هل تريد المتابعة`))) return;
  items.forEach((item) => {
    const product = products.find((entry) => entry.code === item.productId);
    if (product) {
      product.stockQuantity = item.quantity;
      product.wholesale = item.wholesale;
      product.retail = item.retail;
      product.I_P_Price = item.purchasePrice;
    } else if (item.addToProducts) {
      products.push({ code: item.productCode, name: item.productName, wholesale: item.wholesale, retail: item.retail, I_P_Price: item.purchasePrice, stockQuantity: item.quantity });
    }
  });
  saveProducts();
  const record = { id: makeId("inventory"), date: new Date().toISOString(), user: currentUser?.username || "", notes: $("#inventoryNotes").value.trim(), items };
  appStorage.setItem(INVENTORY_KEY, JSON.stringify([record, ...inventoryRecords()].slice(0, 500)));
  recordAdminLog("حفظ جرد المخزون", String(record.id), `${items.length} منتج`);
  renderInventoryHistory();
  inventoryOptions();
  toast("تم حفظ جرد المخزون");
}
function renderInventoryHistory() {
  const box = $("#inventoryHistory");
  if (!box) return;
  const records = inventoryRecords().slice(0, 20);
  box.innerHTML = records.length ? records.map((record) => `<div class="log-row"><strong>جرد ${escapeHtml(new Date(record.date).toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" }))}</strong><span>${escapeHtml(String(record.items?.length || 0))} منتج</span><small>${escapeHtml(record.user || "")} ${escapeHtml(record.notes || "")}</small><button class="btn ghost small" type="button" data-print-inventory="${record.id}">طباعة</button></div>`).join("") : '<div class="empty-row">لا يوجد جرد محفوظ</div>';
  box.querySelectorAll("[data-print-inventory]").forEach((button) => button.addEventListener("click", () => printInventoryRecord(Number(button.dataset.printInventory))));
}
async function printInventoryRecord(id = null) {
  const record = id ? inventoryRecords().find((item) => item.id === id) : inventoryRecords()[0];
  if (!record) {
    toast("لا يوجد جرد محفوظ للطباعة");
    return;
  }
  const rows = (record.items || []).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.productCode)}</td><td>${item.quantity}</td><td>${money(item.wholesale)}</td><td>${money(item.retail)}</td><td>${money(item.purchasePrice)}</td><td>${escapeHtml(item.notes || "")}</td></tr>`).join("");
  $("#printSheet").innerHTML = `<section class="print-page print-page-last"><div class="print-head"><div><h1>كشف جرد المخزون</h1></div><div>${escapeHtml(new Date(record.date).toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" }))}</div></div><div class="print-meta"><div class="print-meta-row"><span>المستخدم ${escapeHtml(record.user || "")}</span><span>ملاحظات ${escapeHtml(record.notes || "")}</span></div></div><table class="print-table"><thead><tr><th>م</th><th>المنتج</th><th>الكود</th><th>الكمية</th><th>الفئة أ</th><th>الفئة ب</th><th>الشراء</th><th>ملاحظات</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  const oldTitle = document.title;
  document.title = "inventory";
  if (window.InvoiceNative?.savePdf) {
    try {
      const saved = await window.InvoiceNative.savePdf({ filename: "inventory.pdf" });
      if (saved?.path) toast(`تم حفظ ملف PDF في ${saved.path}`);
    } catch (error) { window.print(); }
  } else window.print();
  setTimeout(() => { document.title = oldTitle; }, 1500);
}
/* ==================== نهاية جرد المخزون ==================== */

function saveProducts() {
  products = products.map((p) => {
    const { barcode: _legacyBarcode, barCode: _legacyBarCode, ...legacyFree } = p;
    const item = {
      ...legacyFree,
      code: String(p.code || p.barcode || p.barCode || "").trim(),
      name: String(p.name || "").trim(),
      supplierName: String(p.supplierName || p.supplier || "").trim(),
      wholesale: Number(p.wholesale || 0),
      retail: Number(p.retail || 0),
      Min_Reorder: Number(p.Min_Reorder || 0),
      I_Disc: Number(p.I_Disc || 0),
      I_S_Price_N: Number(p.I_S_Price_N ?? 0),
      I_P_Price: Number(p.I_P_Price ?? 0),
      stockQuantity: Number(p.stockQuantity ?? p.I_Qty ?? p.Qty ?? 0),
    };
    return { ...item, searchText: `${normalize(item.name)} ${item.code}` };
  });
  rebuildProductIndex();
  appStorage.setItem(PRODKEY, JSON.stringify(products));
  if (searchWorker) {
    try {
      searchWorker.postMessage({ type: "init", payload: products });
    } catch (e) {}
  }
  persistSelectedJsonSource("product", { version: 1, products: products.map(({ searchText, ...item }) => item) });
}
function renderProductManager() {
  const box = $("#productManagerList");
  if (!box) return;
  const query = normalize($("#productManagerSearch")?.value || "");
  const filtered = query
    ? products.filter((p) => p.searchText.includes(query))
    : products;
  const rows = filtered.slice(0, 200); // ⚡ حد أقصى

  box.innerHTML = rows.length
    ? rows
        .map(
          (p) =>
            `<div class="product-admin-row"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.code)} · جملة ${money(p.wholesale)} · تجزئة ${money(p.retail)}</small></div><div class="user-row-actions"><button type="button" class="btn ghost small" data-product-edit="${escapeHtml(p.code)}">تعديل</button><button type="button" class="btn danger small" data-product-delete="${escapeHtml(p.code)}">حذف</button></div></div>`,
        )
        .join("")
    : '<div class="empty-row">لا توجد منتجات مطابقة</div>';

  box
    .querySelectorAll("[data-product-edit]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        editManagedProduct(b.dataset.productEdit),
      ),
    );
  box
    .querySelectorAll("[data-product-delete]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        deleteManagedProduct(b.dataset.productDelete),
      ),
    );
  const logBox = $("#productManagerLog");
  if (logBox) {
    const logs = JSON.parse(appStorage.getItem(ADMIN_LOG_KEY) || "[]")
      .filter((x) =>
        /منتج|products\.json|إدارة المنتجات/.test(`${x.action} ${x.target}`),
      )
      .slice(0, 30);
    logBox.innerHTML = logs.length
      ? logs
          .map(
            (x) =>
              `<div class="log-row"><strong>${escapeHtml(x.action)}</strong><span>${escapeHtml(x.target || "—")}</span><small>${escapeHtml(x.actor || "—")} · ${escapeHtml(new Date(x.time).toLocaleString("ar-EG"))}</small></div>`,
          )
          .join("")
      : '<div class="empty-row">لا توجد عمليات مسجلة</div>';
  }
}
function resetProductForm() {
  [
    "productEditingCode",
    "productSupplier",
    "productCode",
    "productName",
    "productWholesale",
    "productHalfWholesale",
    "productPurchase",
    "productRetail",
  ].forEach((id) => {
    const el = $("#" + id);
    if (el) el.value = "";
  });
  $("#productSubmit") && ($("#productSubmit").textContent = "إضافة المنتج");
}
function openProductManager() {
  if (!requireFeatureAccess("productManagement", "إدارة المنتجات للمطورين فقط")) return;
  securePassword(
    "secondary",
    "إدارة المنتجات",
    "أدخل كلمة مرور إدارة الحساب:",
    LIMIT_PASSWORD,
  ).then((key) => {
    if (key !== LIMIT_PASSWORD) return;
    recordAdminLog("مشاهدة إدارة المنتجات", "products.json");
    renderProductManager();
    $("#productManagerModal").classList.remove("hidden");
    resetProductForm();
  });
}
function closeProductManager() {
  $("#productManagerModal")?.classList.add("hidden");
}
function editManagedProduct(code) {
  const p = products.find((x) => String(x.code) === String(code));
  if (!p) return;
  $("#productEditingCode").value = p.code;
  $("#productCode").value = p.code;
  $("#productSupplier").value = p.supplierName || p.supplier || "";
  $("#productName").value = p.name;
  $("#productWholesale").value = p.wholesale;
  $("#productHalfWholesale").value = p.halfWholesale ?? p.I_S_Price_N ?? "";
  $("#productPurchase").value = p.I_P_Price ?? "";
  $("#productRetail").value = p.retail;
  $("#productSubmit").textContent = "حفظ التعديل";
  $("#productName").focus();
}
function submitManagedProduct(e) {
  e.preventDefault();
  if (!requireFeatureAccess("productManagement", "إدارة المنتجات للمطورين فقط")) return;
  const editing = $("#productEditingCode").value.trim(),
    supplierName = $("#productSupplier").value.trim(),
    code = $("#productCode").value.trim(),
    name = $("#productName").value.trim(),
    wholesale = Number($("#productWholesale").value),
    retail = Number($("#productRetail").value),
    halfWholesale = Number($("#productHalfWholesale").value),
    purchase = Number($("#productPurchase").value) || 0;
  if (
    !supplierName || !code ||
    !name ||
    !Number.isFinite(wholesale) || wholesale <= 0 ||
    !Number.isFinite(halfWholesale) || halfWholesale <= 0 ||
    !Number.isFinite(retail) || retail <= 0
  ) {
    $("#productManagerError").textContent =
      "أدخل الكود والاسم والأسعار بشكل صحيح";
    return;
  }
  if (!editing && products.some((p) => p.code === code)) {
    $("#productManagerError").textContent = "كود المنتج موجود بالفعل";
    return;
  }
  if (editing && code !== editing && products.some((p) => p.code === code)) {
    $("#productManagerError").textContent = "الكود الجديد مستخدم بالفعل";
    return;
  }
  const p = editing ? products.find((x) => x.code === editing) : null;
  if (p) {
    p.supplierName = supplierName;
    p.code = code;
    p.name = name;
    p.wholesale = wholesale;
    p.halfWholesale = halfWholesale;
    p.I_S_Price_N = halfWholesale;
    p.I_P_Price = purchase;
    p.retail = retail;
    recordAdminLog("تعديل منتج", code, `الاسم: ${name}`);
    toast("تم تعديل المنتج");
  } else {
    products.push({ supplierName, code, name, wholesale, halfWholesale, I_S_Price_N: halfWholesale, I_P_Price: purchase, retail });
    recordAdminLog("إضافة منتج", code, `الاسم: ${name}`);
    toast("تمت إضافة المنتج");
  }
  saveProducts();
  resetProductForm();
  $("#productManagerError").textContent = "";
  renderProductManager();
}
async function deleteManagedProduct(code) {
  if (!requireFeatureAccess("productManagement", "حذف المنتجات للمطورين فقط")) return;
  const p = products.find((x) => x.code === code);
  if (!p) return;
  if (!(await openConfirmModal(`هل تريد حذف المنتج «${p.name}»؟`))) return;
  products = products.filter((x) => x.code !== code);
  saveProducts();
  await persistSelectedJsonSource("product", { version: 1, products: products.map(({ searchText, ...item }) => item) });
  recordAdminLog("حذف منتج", code, p.name);
  renderProductManager();
  toast("تم حذف المنتج");
}
function exportProductsFile() { if (!requireFeatureAccess("productManagement", "تصدير المنتجات للمطورين فقط")) return; recordAdminLog("تصدير المنتجات", $("#productsExportFormat")?.value || "json"); exportSectionRows("products", products.map(({searchText,...p})=>p), $("#productsExportFormat")?.value || "json"); toast("تم تصدير المنتجات"); }
async function importProductsFile(file) {
  if (!requireFeatureAccess("productManagement", "استيراد المنتجات للمطورين فقط")) return;
  try {
    const data = JSON.parse(await file.text()),
      items = Array.isArray(data) ? data : data.products;
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.some((p) => {
        const w = Number(p.wholesale),
          r = Number(p.retail);
        return (
          !String(p.code || "").trim() ||
          ((!Number.isFinite(w) || w <= 0) && (!Number.isFinite(r) || r <= 0))
        );
      })
    )
      throw Error();
    products = items.map((p) => ({
      code: String(p.code).trim(),
      name: String(p.name || p.code).trim(),
      wholesale: Number(p.wholesale),
      retail: Number(p.retail),
      searchText: `${normalize(String(p.name || p.code).trim())} ${String(p.code).trim()}`,
    }));
    saveProducts();
    recordAdminLog(
      "استيراد المنتجات",
      "products.json",
      `${products.length} منتج`,
    );
    renderProductManager();
    toast(`تم استيراد ${products.length} منتج`);
  } catch (e) {
    toast("ملف المنتجات غير صحيح");
  }
}
$("#accountManageProducts").addEventListener("click", () => {
  closeAccountMenu();
  openProductManager();
});
function saveCustomers() {
  customers = customers.map((c) => ({
    code: String(c.code).trim(),
    name: String(c.name || "").trim(),
    city: String(c.city || ""),
    phone: String(c.phone || ""),
    address: String(c.address || ""),
  }));
  appStorage.setItem("bill:pwa:customers:v1", JSON.stringify(customers));
}
function suggestCustomerCode() {
  let n = 1;
  const used = new Set(customers.map((c) => String(c.code)));
  while (used.has(String(n))) n++;
  return String(n);
}

function resetCustomerForm() {
  [
    "customerEditingCode",
    "managedCustomerCode",
    "managedCustomerName",
    "managedCustomerCity",
    "managedCustomerPhone",
  ].forEach((id) => {
    const el = $("#" + id);
    if (el) el.value = "";
  });
  $("#customerSubmit") && ($("#customerSubmit").textContent = "إضافة العميل");
  const code = $("#managedCustomerCode");
  if (code) {
    code.placeholder = suggestCustomerCode();
    code.value = suggestCustomerCode();
  }
}
function openCustomerManager() {
  if (!requireFeatureAccess("customerManagement", "إدارة العملاء للمطورين فقط")) return;
  securePassword(
    "secondary",
    "إدارة العملاء",
    "أدخل كلمة مرور إدارة الحساب:",
    LIMIT_PASSWORD,
  ).then((key) => {
    if (key !== LIMIT_PASSWORD) return;
    recordAdminLog("مشاهدة إدارة العملاء", "customers.json");
    resetCustomerForm();
    renderCustomerManager();
    $("#customerManagerModal").classList.remove("hidden");
    $("#customerManagerSearch").focus();
  });
}
function closeCustomerManager() {
  $("#customerManagerModal")?.classList.add("hidden");
}
function editManagedCustomer(code) {
  const c = customers.find((x) => String(x.code) === String(code));
  if (!c) return;
  $("#customerEditingCode").value = c.code;
  $("#managedCustomerCode").value = c.code;
  $("#managedCustomerName").value = c.name || "";
  $("#managedCustomerCity").value = c.city || "";
  $("#managedCustomerPhone").value = c.phone || "";
  $("#customerSubmit").textContent = "حفظ التعديل";
  $("#managedCustomerName").focus();
}
function submitManagedCustomer(e) {
  e.preventDefault();
  if (!requireFeatureAccess("customerManagement", "إدارة العملاء للمطورين فقط")) return;
  const editing = $("#customerEditingCode").value.trim(),
    code = $("#managedCustomerCode").value.trim() || suggestCustomerCode(),
    name = $("#managedCustomerName").value.trim(),
    city = $("#managedCustomerCity").value.trim(),
    phone = $("#managedCustomerPhone").value.trim();
  if (!name) {
    $("#customerManagerError").textContent = "أدخل اسم العميل";
    return;
  }
  if (
    customers.some((c) => String(c.code) === code && String(c.code) !== editing)
  ) {
    $("#customerManagerError").textContent = "كود العميل محجوز لعميل آخر";
    return;
  }
  const c = editing ? customers.find((x) => String(x.code) === editing) : null;
  if (c) {
    c.code = code;
    c.name = name;
    c.city = city;
    c.phone = phone;
    recordAdminLog("تعديل عميل", code, `الاسم: ${name}`);
    toast("تم تعديل بيانات العميل");
  } else {
    customers.push({ code, name, city, phone });
    recordAdminLog("إضافة عميل", code, `الاسم: ${name}`);
    toast("تمت إضافة العميل");
  }
  saveCustomers();
  persistSelectedJsonSource("customer", { version: 1, customers });
  $("#customerManagerError").textContent = "";
  resetCustomerForm();
  renderCustomerManager();
}
async function deleteManagedCustomer(code) {
  if (!requireFeatureAccess("customerManagement", "حذف العملاء للمطورين فقط")) return;
  const c = customers.find((x) => String(x.code) === String(code));
  if (!c) return;
  if (!(await openConfirmModal(`هل تريد حذف العميل «${c.name}»؟`))) return;
  customers = customers.filter((x) => String(x.code) !== String(code));
  saveCustomers();
  await persistSelectedJsonSource("customer", { version: 1, customers });
  recordAdminLog("حذف عميل", code, c.name);
  renderCustomerManager();
  toast("تم حذف العميل");
}
function exportCustomersFile() { if (!requireFeatureAccess("customerManagement", "تصدير العملاء للمطورين فقط")) return; const format=$("#customersExportFormat")?.value || "json"; recordAdminLog("تصدير العملاء", format); exportSectionRows("customers", customers, format); toast("تم تصدير العملاء"); }
async function importCustomersFile(file) {
  if (!requireFeatureAccess("customerManagement", "استيراد العملاء للمطورين فقط")) return;
  try {
    const data = JSON.parse(await file.text()),
      items = Array.isArray(data) ? data : data.customers;
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.some(
        (c) => !String(c.code || "").trim() || !String(c.name || "").trim(),
      )
    )
      throw Error();
    const codes = items.map((c) => String(c.code).trim());
    if (new Set(codes).size !== codes.length) throw Error();
    customers = items.map((c) => ({
      code: String(c.code).trim(),
      name: String(c.name).trim(),
      city: String(c.city || ""),
      phone: String(c.phone || ""),
      address: String(c.address || ""),
    }));
    saveCustomers();
    recordAdminLog(
      "استيراد العملاء",
      "customers.json",
      `${customers.length} عميل`,
    );
    renderCustomerManager();
    toast(`تم استيراد ${customers.length} عميل`);
  } catch (e) {
    toast("ملف العملاء غير صحيح");
  }
}
$("#closeProductManager").addEventListener("click", closeProductManager);
$("#productManagerModal").addEventListener("click", (e) => {
  if (e.target.id === "productManagerModal") closeProductManager();
});
$("#productForm").addEventListener("submit", submitManagedProduct);
$("#productManagerSearch").addEventListener("input", () =>
  debounceManagerSearch("product", renderProductManager),
);
$("#customerManagerSearch").addEventListener("input", () =>
  debounceManagerSearch("customer", renderCustomerManager),
);
$("#userManagerSearch")?.addEventListener("input", () =>
  debounceManagerSearch("user", renderUserList),
);
$("#exportProducts").addEventListener("click", exportProductsFile);
$("#importProducts").addEventListener("change", (e) => {
  if (e.target.files[0]) importProductsFile(e.target.files[0]);
  e.target.value = "";
});
$("#accountManageCustomers").addEventListener("click", () => {
  closeAccountMenu();
  openCustomerManager();
});
$("#closeCustomerManager").addEventListener("click", closeCustomerManager);
$("#customerManagerModal").addEventListener("click", (e) => {
  if (e.target.id === "customerManagerModal") closeCustomerManager();
});
$("#customerForm").addEventListener("submit", submitManagedCustomer);
$("#exportCustomers").addEventListener("click", exportCustomersFile);
$("#importCustomers").addEventListener("change", (e) => {
  if (e.target.files[0]) importCustomersFile(e.target.files[0]);
  e.target.value = "";
});
const ACCEPTED_DATA_FILES = Object.freeze([
  "product.json",
  "products.json",
  "users.json",
  "customer.json",
  "customers.json",
  "customer_history.json",
]);
function dataFilePath(file) {
  return String(file?.path || file?.webkitRelativePath || file?.name || "").replaceAll(
    "\\\\",
    "/",
  );
}
function acceptedDataFile(file) {
  const name = String(file?.name || "").toLowerCase();
  return name.endsWith(".mdb") || name.endsWith(".json") || name.endsWith(".xlsx") || name.endsWith(".xls");
}
async function readFolderFile(files, names) {
  const wantedNames = (Array.isArray(names) ? names : [names]).map((x) =>
    String(x).toLowerCase(),
  );
  const wanted = files.find((file) =>
    wantedNames.includes(String(file.name || "").toLowerCase()),
  );
  return wanted ? await wanted.text() : null;
}
function excelValue(row, names) {
  const keys = Object.keys(row || {});
  const key = keys.find(k => names.some(n => String(k).trim().toLowerCase() === String(n).trim().toLowerCase())) || keys.find(k => names.some(n => String(k).trim().toLowerCase().includes(String(n).trim().toLowerCase())));
  return key === undefined ? "" : row[key];
}
function normalizeExcelProduct(row) {
  return {
    code: String(excelValue(row,["code","الكود","كود الصنف","item_code","product_code","i_code"])||"").trim(),
    name: String(excelValue(row,["name","اسم الصنف","اسم المنتج","item_name","product_name","i_name"])||"").trim(),
    wholesale: Number(excelValue(row,["wholesale","سعر البيع جملة","سعر البيع نصف جملة","price2","user2","i_s_price_w"])||0)||0,
    retail: Number(excelValue(row,["retail","سعر البيع قطاعي","price3","user3","i_s_price_p"])||0)||0,
    I_S_Price_N: Number(excelValue(row,["i_s_price_n","agent","price_agent","سعر الوسيط"])||0)||0,
    I_P_Price: Number(excelValue(row,["i_p_price","purchase","purchase_price","سعر الشراء"])||0)||0,
    stockQuantity: Number(excelValue(row,["stock","quantity","qty","i_qty","الكمية"])||0)||0,
  };
}
function normalizeExcelCustomer(row) {
  return normalizeCustomerRecord({
    code: excelValue(row,["code","customer_code","cus_code","كود العميل"]),
    name: excelValue(row,["name","customer_name","cus_name","اسم العميل"]),
    city: excelValue(row,["city","cus_city","المدينة"]),
    phone: excelValue(row,["phone","tel","tel_1","التليفون"]),
    address: excelValue(row,["address","cus_address","العنوان"]),
  });
}
function normalizeExcelUser(row) {
  const username = String(excelValue(row,["username","user","login","اسم المستخدم"]) || "").trim();
  const password = String(excelValue(row,["password","pass","كلمة المرور"]) || "");
  if (!username || !password) return null;
  return { username, password, role: String(excelValue(row,["role","type","نوع الحساب"]) || "user").toLowerCase() === "developer" ? "developer" : "user", active: excelValue(row,["active","enabled","فعال"]) !== false };
}
async function readExcelDataFiles(files) {
  const result = {products: [], customers: [], customerHistory: [], users: []};
  if (!window.XLSX) return result;
  for (const file of files.filter(f => /\.(xlsx|xls)$/i.test(String(f.name || "")))) {
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), {type: "array"});
      for (const sheetName of workbook.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {defval: ""});
        const name = `${file.name} ${sheetName}`.toLowerCase();
        const keys = Object.keys(rows[0] || {}).map(k => String(k).toLowerCase());
        const has = (...names) => names.some(n => keys.some(k => k === n || k.includes(n)));
        if (has("username","user","password","مستخدم","كلمة")) result.users.push(...rows.map(normalizeExcelUser).filter(Boolean));
        else if (has("customer","client","عميل","اسم العميل","cus_")) result.customers.push(...rows.map(normalizeExcelCustomer).filter(Boolean));
        else if (has("history","purchase","سجل","فاتورة")) result.customerHistory.push(...rows);
        else result.products.push(...rows.map(normalizeExcelProduct).filter(x => x.code && x.name));
      }
    } catch (e) { console.warn("Excel file skipped", file.name, e); }
  }
  return result;
}
async function readAllJsonDataFiles(files) {
  const result = {
    products: [],
    customers: [],
    customerHistory: [],
    users: [],
  };
  let jsonWorker = null;
  async function parseJsonText(text) {
    if (text.length <= 10 * 1024 * 1024 || !("Worker" in window)) return JSON.parse(text);
    if (!jsonWorker) jsonWorker = new Worker("json-worker.js");
    const id = makeId("json");
    return new Promise((resolve, reject) => {
      const handler = (event) => {
        if (event.data?.id !== id) return;
        jsonWorker.removeEventListener("message", handler);
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
      };
      jsonWorker.addEventListener("message", handler);
      jsonWorker.postMessage({ id, text });
    });
  }
  for (const file of files.filter((item) =>
    String(item?.name || "")
      .toLowerCase()
      .endsWith(".json"),
  )) {
    try {
      const parsed = await parseJsonText(await file.text()),
        name = String(file.name || "").toLowerCase(),
        source = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object"
            ? parsed
            : {},
        add = (key, value) => {
          if (Array.isArray(value)) result[key].push(...value);
        };
      if (name.includes("history"))
        add(
          "customerHistory",
          Array.isArray(source)
            ? source
            : source.customerHistory ||
                source.customer_history ||
                source.history ||
                source.data,
        );
      else if (name.includes("customer"))
        add(
          "customers",
          Array.isArray(source)
            ? source
            : source.customers ||
                source.customer ||
                source.data ||
                source.rows ||
                source.records,
        );
      else if (name.includes("product") || name.includes("item"))
        add(
          "products",
          Array.isArray(source)
            ? source
            : source.products ||
                source.product ||
                source.items ||
                source.data ||
                source.rows ||
                source.records,
        );
      else if (name.includes("user") || name.includes("account"))
        add(
          "users",
          Array.isArray(source)
            ? source
            : source.users ||
                source.user ||
                source.accounts ||
                source.data ||
                source.rows ||
                source.records,
        );
      else {
        add("products", source.products);
        add("customers", source.customers);
        add(
          "customerHistory",
          source.customerHistory || source.customer_history || source.history,
        );
        add("users", source.users);
      }
    } catch (e) {
      console.warn("JSON file skipped", file.name, e);
    }
  }
  return result;
}
function parseDataFile(text, key) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return null;
    const aliases = [
      key,
      key.endsWith("s") ? key.slice(0, -1) : key,
      `${key}s`,
      "data",
      "rows",
      "records",
    ];
    const found = Object.keys(data).find((name) =>
      aliases.some(
        (alias) => String(name).toLowerCase() === String(alias).toLowerCase(),
      ),
    );
    return found && Array.isArray(data[found]) ? data[found] : null;
  } catch (e) {
    return null;
  }
}
function updateDataFolderStatus(found, rejected, hasMdb) {
  const status = $("#dataFolderStatus");
  if (!status) return;
  const lines = [];
  if (found.length)
    lines.push(
      `<strong>الملفات المعتمدة:</strong> ${found.map((x) => escapeHtml(x)).join(" · ")}`,
    );
  if (rejected.length)
    lines.push(
      `<strong class="data-folder-rejected">تم تجاهل:</strong> ${rejected.map((x) => escapeHtml(x)).join(" · ")}`,
    );
  if (hasMdb)
    lines.push(
      "<small>تم تحديد database.mdb؛ ستتم معالجته تلقائيًا داخل التطبيق.</small>",
    );
  status.innerHTML =
    lines.join("<br>") || "لم يتم العثور على ملف قاعدة بيانات معتمد";
}
function findMdbTable(reader, names, indicators = []) {
  let tableNames = [];
  try {
    tableNames = reader.getTableNames({ normalTables: true });
  } catch (e) {
    return null;
  }
  const wanted = names.map((x) => String(x).toLowerCase());
  const direct = tableNames.find((name) => wanted.includes(String(name).toLowerCase()));
  if (direct) return reader.getTable(direct);
  const needed = indicators.map((item) => String(item).toLowerCase());
  let best = null;
  for (const name of tableNames) {
    try {
      const table = reader.getTable(name);
      const cols = (typeof table.getColumnNames === "function" ? table.getColumnNames() : [])
        .map((column) => String(column).toLowerCase());
      const score = needed.reduce((total, wantedColumn) => total + (cols.some((column) => column === wantedColumn || column.includes(wantedColumn)) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { table, score };
    } catch (e) {}
  }
  return best?.table || null;
}
function mdbColumn(row, names) {
  const keys = Object.keys(row || {});
  const wanted = names.map((x) => x.toLowerCase());
  const key = keys.find((k) => wanted.includes(String(k).toLowerCase())) || keys.find((k) => wanted.some(w => String(k).toLowerCase().includes(w)));
  return key === undefined ? null : row[key];
}
async function readMdb(file, onProgress = () => {}) {
  if (
    !file ||
    !String(file.name || "")
      .toLowerCase()
      .endsWith(".mdb")
  )
    throw Error("ملف MDB غير صالح");
  if (!window.MDBReader) throw Error("محرك MDB غير متاح داخل التطبيق");
  const buffer = await file.arrayBuffer(),
    reader = new window.MDBReader(window.Buffer.from(buffer));
  const safeTable = (names, indicators = []) => {
    try {
      return findMdbTable(reader, names, indicators);
    } catch (e) {
      return null;
    }
  };
  const itemTable = safeTable(["Items_Names", "Items", "Products", "Product", "product"], ["i_code", "item_code", "product_code", "i_name"]);
  onProgress("قراءة المنتجات", 25);
  await yieldToUI();
  const customerTable = safeTable(["Cus_Names", "Customers", "Customer", "customer"], ["cus_code", "customer_code", "cus_name"]);
  const userTable = safeTable(["Users", "User", "Accounts", "users", "account"], ["username", "password", "userpassword"]);
  const historyTable = safeTable(["Customer_History", "CustomerHistory", "Customers_History", "Sales_History", "Purchase_History", "Purchases", "Invoice_Items", "customer_history", "history"], ["customer_code", "cus_code", "invoice_count", "last_price"]);
  const rows = (table) => {
    try {
      return table ? table.getData() : [];
    } catch (e) {
      return [];
    }
  };
  const number = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const mdbProducts = [];
for (const row of rows(itemTable)) {
  const code = String(
    mdbColumn(row, [
      "I_Code","Code","Item_Code","Product_Code","الكود","كود الصنف","code",
    ]) ?? "",
  ).trim();
  if (!code) continue;
  mdbProducts.push({
    code,
    name: String(
      mdbColumn(row, [
        "I_Name","Name","Item_Name","Product_Name","اسم الصنف","اسم المنتج","name",
      ]) ?? "",
    ).trim(),
    wholesale: number(
      mdbColumn(row, [
        "I_S_Price_W","Wholesale","Price2","User2",
        "wholesale","سعر البيع جملة","سعر البيع نصف جملة",
      ]),
    ),
    retail: number(
      mdbColumn(row, [
        "I_S_Price_P","Retail","Price3","User3","retail","سعر البيع قطاعي",
      ]),
    ),
    I_S_Price_N: number(mdbColumn(row, ["I_S_Price_N", "Agent", "Agent_Price", "Price_Agent", "سعر الوسيط"])),
    I_P_Price: number(mdbColumn(row, ["I_P_Price", "Purchase", "Purchase_Price", "Cost", "سعر الشراء"])),
    stockQuantity: number(mdbColumn(row, ["I_Qty", "Qty", "Quantity", "Stock", "Balance", "الكمية"])),
  });
}
  onProgress("قراءة العملاء", 50);
  await yieldToUI();
  const mdbCustomers = [];
for (const row of rows(customerTable)) {
  const code = String(
    mdbColumn(row, ["Cus_Code","Code","Customer_Code","code"]) ?? "",
  ).trim();
  if (!code) continue;
  mdbCustomers.push({
    code,
    name: String(
      mdbColumn(row, ["Cus_Name","Name","Customer_Name","name"]) ?? "",
    ).trim(),
    city: String(mdbColumn(row, ["Cus_City","City","city"]) ?? "").trim(),
    address: String(
      mdbColumn(row, ["Cus_Address","Address","address"]) ?? "",
    ).trim(),
    phone: String(
      mdbColumn(row, ["Tel_1","Phone","Tel","phone"]) ?? "",
    ).trim(),
  });
}
  onProgress("قراءة سجل المشتريات", 75);
  await yieldToUI();
  const mdbHistory = [];
for (const row of rows(historyTable)) {
  const customerCode = String(
    mdbColumn(row, [
      "Customer_Code","Cus_Code","CustomerCode","Code","customer_code",
    ]) ?? "",
  ).trim();
  const itemCode = String(
    mdbColumn(row, [
      "I_Code","Item_Code","Product_Code","ProductCode","code",
    ]) ?? "",
  ).trim();
  if (!customerCode || !itemCode) continue;
  mdbHistory.push({
    customerCode,
    invoiceCount: Number(
      mdbColumn(row, [
        "Invoice_Count","InvoiceCount","Count","invoice_count",
      ]) || 1,
    ) || 1,
    items: [{
      code: itemCode,
      name: String(
        mdbColumn(row, ["I_Name","Item_Name","Product_Name","name"]) ?? "",
      ).trim(),
      lastPrice: Number(
        mdbColumn(row, ["Price","Unit_Price","Last_Price","price"]) || 0,
      ) || 0,
      lastQty: Number(
        mdbColumn(row, ["Qty","Quantity","Last_Qty","quantity"]) || 0,
      ) || 0,
      mode: String(
        mdbColumn(row, ["Mode","Price_Mode","mode"]) || "wholesale",
      ),
    }],
  });
}
  onProgress("قراءة المستخدمين", 95);
  await yieldToUI();
  const mdbUsers = [];
for (const row of rows(userTable)) {
  const username = String(
    mdbColumn(row, ["Username","UserName","Login","Name","username"]) ?? "",
  ).trim();
  const password = String(
    mdbColumn(row, ["Password","Pass","UserPassword","password"]) ?? "",
  );
  if (!username || !password) continue;
  mdbUsers.push({
    username,
    password,
    role: String(
      mdbColumn(row, ["Role","Type","role"]) ?? "user",
    ).toLowerCase() === "developer" ? "developer" : "user",
    active: mdbColumn(row, ["Active","Enabled","active"]) !== false,
  });
}
  let tables = [];
  try {
    tables = reader.getTableNames({ normalTables: true });
  } catch (e) {}
  return {
    products: mdbProducts,
    customers: mdbCustomers,
    users: mdbUsers,
    customerHistory: mdbHistory,
    tables,
  };
}
function databaseFingerprintFromFiles(files) {
  return [...files].map((file) => `${dataFilePath(file)}::${file.size || 0}::${file.lastModified || 0}`).sort().join("|");
}
function databaseFingerprintFromRecords(records) {
  return (records || []).map((record) => `${record.path || record.name}::${record.size || record.blob?.size || 0}::${record.lastModified || record.blob?.lastModified || 0}`).sort().join("|");
}
function applyParsedDatabaseCache(cached, found = []) {
  if (!cached || (!cached.products?.length && !cached.customers?.length && !cached.users?.length && !cached.customerHistory?.length)) return false;
  if (Array.isArray(cached.products)) { appStorage.setItem(PRODKEY, JSON.stringify(cached.products)); products = []; }
  if (Array.isArray(cached.customers)) { appStorage.setItem("bill:pwa:customers:v1", JSON.stringify(cached.customers)); customers = []; }
  if (Array.isArray(cached.customerHistory)) { appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(cached.customerHistory)); customerHistory = cached.customerHistory; }
  if (Array.isArray(cached.users)) { usersFileUsers = cached.users; usersFileReady = cached.users.length > 0; saveUsers(cached.users); }
  if (found.length) updateDataFolderStatus(found, [], true);
  return true;
}
async function restoreSelectedDataFolder() {
  try {
    const saved = await idbReadDatabaseFiles();
    if (!saved.records.length) return false;
    const found = saved.meta?.paths || saved.records.map((record) => record.path || record.name);
    const cached = safeJson(appStorage.getItem("bill:pwa:mdb-parsed-cache:v1") || "null", null);
    const savedFingerprint = saved.meta?.fingerprint || databaseFingerprintFromRecords(saved.records);
    if (cached && cached.fingerprint === savedFingerprint && applyParsedDatabaseCache(cached, found)) {
      await loadProducts();
      await loadCustomers();
      dataFolderReady = true;
      updateDataFolderStatus(found, [], true);
      return true;
    }
    const restored = saved.records.map((record) => {
      const file = new File([record.blob], record.name, { type: record.type || "application/octet-stream", lastModified: record.lastModified || Date.now() });
      try { Object.defineProperty(file, "webkitRelativePath", { value: record.path || record.name }); } catch (e) {}
      return file;
    });
    return await loadSelectedDataFolder(restored, true);
  } catch (e) { console.warn("تعذر استعادة مسار قاعدة البيانات", e); return false; }
}

/* بداية دمج مصادر قاعدة البيانات */
function mergeImportedProducts(...groups) {
  const merged = new Map();
  const priceKeys = new Set(["wholesale", "retail", "I_S_Price_N", "I_P_Price"]);
  for (const group of groups) for (const raw of group || []) {
    const code = String(raw?.code || "").trim();
    if (!code) continue;
    const previous = merged.get(code) || { code };
    const next = { ...previous };
    for (const [key, value] of Object.entries(raw || {})) {
      if (value === null || value === undefined || String(value).trim() === "") continue;
      if (priceKeys.has(key) && !(Number(value) > 0)) continue;
      next[key] = value;
    }
    merged.set(code, next);
  }
  return [...merged.values()];
}
function mergeImportedCustomers(...groups) {
  const merged = new Map();
  for (const group of groups) for (const raw of group || []) {
    const item = normalizeCustomerRecord(raw);
    if (!item?.code) continue;
    merged.set(item.code, { ...(merged.get(item.code) || {}), ...Object.fromEntries(Object.entries(item).filter(([, value]) => String(value || "").trim() !== "")) });
  }
  return [...merged.values()];
}
function normalizeHistorySource(...sources) {
  const byCustomer = new Map();
  for (const source of sources.flat()) {
    const code = historyKey(source?.customerCode ?? source?.customer_code ?? source?.code);
    if (!code) continue;
    const previous = byCustomer.get(code) || { customerCode: code, invoiceCount: 0, items: [] };
    const items = Array.isArray(source.items) ? source.items : [];
    const itemMap = new Map((previous.items || []).map((item) => [String(item.code), item]));
    for (const raw of items) {
      const itemCode = String(raw?.code ?? raw?.productCode ?? "").trim(); if (!itemCode) continue;
      const prior = itemMap.get(itemCode) || {};
      itemMap.set(itemCode, { ...prior, ...raw, code: itemCode, timesBought: Number(prior.timesBought || 0) + Number(raw.timesBought || 1), lastSeen: raw.lastSeen || prior.lastSeen || "" });
    }
    previous.invoiceCount = Math.max(Number(previous.invoiceCount || 0), Number(source.invoiceCount || 0));
    previous.items = [...itemMap.values()].sort((a, b) => Number(b.timesBought || 0) - Number(a.timesBought || 0) || String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""))).slice(0, HISTORY_MAX_ITEMS);
    byCustomer.set(code, previous);
  }
  return [...byCustomer.values()].slice(-HISTORY_MAX_ROWS);
}
/* نهاية دمج مصادر قاعدة البيانات */
function yieldToUI() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function updateDataProgress(stage, percent) { const wrap=$("#dataLoadProgress"); if (!wrap) return; wrap.classList.remove("hidden"); $("#progressStage").textContent=stage; $("#progressFill").style.width=`${percent}%`; $("#progressPercent").textContent=`${Math.round(percent)}%`; }
function hideDataProgress() { $("#dataLoadProgress")?.classList.add("hidden"); }

async function persistSelectedJsonSource(section, payload) {
  const entry = [...selectedSourceFiles.entries()].find(([name]) => name.includes(section))
    || [...selectedSourceFiles.entries()].find(([name]) => /\.(json|xlsx|xls)$/i.test(name));
  if (!entry) return false;
  const [name, file] = entry;
  const isExcel = /\.(xlsx|xls)$/i.test(name);
  const isMdb = /\.mdb$/i.test(name);
  if (isMdb) { toast("التعديل المباشر في MDB غير مدعوم من محرك المتصفح الحالي؛ تم حفظ البيانات محليًا"); return false; }
  const rows = payload?.products || payload?.customers || payload?.users || [];
  const text = JSON.stringify(payload, null, 2);
  try {
    let output = new Blob([text], { type: "application/json" });
    if (isExcel && window.XLSX) {
      let workbook;
      try { workbook = XLSX.read(await file.arrayBuffer(), { type: "array" }); }
      catch (error) { workbook = XLSX.utils.book_new(); }
      if (!workbook.SheetNames.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), section.slice(0, 31));
      const sheetName = workbook.SheetNames.find((sheet) => normalize(sheet).includes(normalize(section))) || workbook.SheetNames[0];
      workbook.Sheets[sheetName] = XLSX.utils.json_to_sheet(rows);
      const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
      output = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    if (window.InvoiceNative?.writeDataFile && file.path) { await window.InvoiceNative.writeDataFile({ path: file.path, data: await blobToBase64(output) }); return true; }
    if (file.handle?.createWritable) { const writable = await file.handle.createWritable(); await writable.write(output); await writable.close(); return true; }
  } catch (error) { logger.error("Source JSON write-back failed", { name, error }); toast("تم الحفظ محليًا، وتعذر تعديل الملف الأصلي"); }
  return false;
}
async function loadSelectedDataFolder(files, fromStorage = false) {
  const list = [...files];
  const accepted = list.filter(acceptedDataFile);
  selectedSourceFiles = new Map(accepted.map((file) => [String(file.name || "").toLowerCase(), file]));
  const rejected = list
    .filter((file) => !acceptedDataFile(file))
    .map(dataFilePath);
  const found = accepted.map(dataFilePath);
  const fp = databaseFingerprintFromFiles(accepted);
  const mdb = accepted.find((file) =>
    String(file.name || "").toLowerCase().endsWith(".mdb"),
  );
  const status = $("#dataFolderStatus");
  dataFolderReady = false;
  if (status) status.textContent = "جاري فحص ملفات قاعدة البيانات...";
  updateDataProgress("فحص الملفات", 5);
  await yieldToUI();

  if (!accepted.length) {
    updateDataFolderStatus([], rejected, false);
    toast("المجلد لا يحتوي على ملفات قاعدة بيانات معتمدة");
    return false;
  }

  // 🔥 جرّب الكاش أولًا لو فيه ملف mdb
  if (accepted.length) {
    try {
      const cached = JSON.parse(
        appStorage.getItem("bill:pwa:mdb-parsed-cache:v1") || "null",
      );
      if (cached && cached.fingerprint === fp) {
        applyParsedDatabaseCache(cached, found);
        await loadProducts();
        await loadCustomers();
        dataFolderReady = true;
        updateDataFolderStatus(found, rejected, true);
        toast("تم تحميل قاعدة البيانات من الكاش (سريع)");
        return true;
      }
    } catch (e) {
      console.warn("MDB cache miss", e);
    }
  }

  try {
    let mdbResult = null;
    if (mdb) {
      updateDataProgress("قراءة الملف الرئيسي", 10); await yieldToUI();
      mdbResult = await readMdb(mdb, (stage, pct) => updateDataProgress(stage, 10 + pct * 0.5));
      mdbSelected = true;
    } else {
      mdbSelected = false;
    }
    updateDataProgress("قراءة JSON", 65); await yieldToUI();
    const jsonData = await readAllJsonDataFiles(accepted);
    updateDataProgress("قراءة Excel", 75); await yieldToUI();
    const excelData = await readExcelDataFiles(accepted);
    jsonData.products.push(...excelData.products);
    jsonData.customers.push(...excelData.customers);
    jsonData.customerHistory.push(...excelData.customerHistory);
    jsonData.users.push(...excelData.users);
    const folderProducts = jsonData.products;
    const folderCustomers = jsonData.customers;
    const folderHistory = normalizeHistorySource(
      ...(jsonData.customerHistory || []),
      ...(mdbResult?.customerHistory || []),
      ...(customerHistory || []),
    );
    const folderUsers = [
      ...(jsonData.users || []),
      ...(mdbResult?.users || []),
    ];
    updateDataProgress("دمج البيانات", 85); await yieldToUI();
    const finalProducts = mergeImportedProducts(folderProducts, mdbResult?.products || []);
    const finalCustomers = mergeImportedCustomers(folderCustomers, mdbResult?.customers || []);
    updateDataProgress("الحفظ في IndexedDB", 92); await yieldToUI();
    appStorage.setItem(PRODKEY, JSON.stringify(finalProducts || []));
    products = [];
    appStorage.setItem("bill:pwa:customers:v1", JSON.stringify(finalCustomers || []));
    customers = [];
    appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(folderHistory || []));
    customerHistory = folderHistory || [];
    if (folderUsers?.length) {
      usersFileUsers = folderUsers
        .filter(
          (user) =>
            user &&
            String(user.username || "").trim() &&
            typeof user.password !== "undefined" &&
            user.username !== DEVELOPER_USERNAME,
        )
        .map((user) => ({
          ...user,
          username: String(user.username).trim(),
          password: String(user.password),
          role: user.role === "developer" ? "developer" : "user",
          active: user.active !== false,
        }));
      usersFileReady = true;
      saveUsers(usersFileUsers);
    } else {
      usersFileUsers = [];
      usersFileReady = false;
      saveUsers([]);
    }
    if (!fromStorage) {
      const records = accepted.map((file, index) => ({
        id: `${String(file.name || "").toLowerCase()}::${index}`,
        name: String(file.name || ""),
        path: dataFilePath(file),
        size: file.size || 0,
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || Date.now(),
        blob: file,
      }));
      idbReplaceDatabaseFiles(records, {
        paths: found,
        fingerprint: fp,
        selectedAt: new Date().toISOString(),
      });
    }

    // 🔥 احفظ النتيجة في الكاش (المرة الجاية هتكون فورية)
    if (accepted.length) {
      try {
        appStorage.setItem(
          "bill:pwa:mdb-parsed-cache:v1",
          JSON.stringify({
            fingerprint: fp,
            products: finalProducts || [],
            customers: finalCustomers || [],
            users: folderUsers || [],
            customerHistory: folderHistory || [],
            parsedAt: Date.now(),
          }),
        );
      } catch (e) {
        console.warn("MDB cache save failed", e);
      }
    }

    await loadProducts();
    await loadCustomers();
    dataFolderReady = true;
    updateDataFolderStatus(found, rejected, Boolean(mdb));
    updateDataProgress("اكتمل", 100); await yieldToUI();
    setTimeout(hideDataProgress, 800);
    toast("تمت قراءة ملفات قاعدة البيانات بنجاح");
    return true;
  } catch (error) {
    hideDataProgress();
    dataFolderReady = false;
    if (status)
      status.innerHTML = `<strong>فشل قراءة قاعدة البيانات:</strong> ${escapeHtml(error.message || "ملف غير صالح")}`;
    toast("تعذر قراءة ملفات قاعدة البيانات");
    return false;
  }
}
  
function normalizeDataRecord(value, fallback = "") {
  return value === null || value === undefined || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}
function safeJson(raw, fallback) {
  try {
    const x = JSON.parse(raw);
    return x ?? fallback;
  } catch (e) {
    return fallback;
  }
}
async function loadProductsFromStorage() {
  return loadProducts();
}
async function loadCustomersFromStorage() {
  return loadCustomers();
}

$("#accountManageUsers")?.addEventListener("click", () => { closeAccountMenu(); openUserManager(); });
$("#accountProductLookup")?.addEventListener("click", openProductLookup);
$("#closeProductLookup")?.addEventListener("click", closeProductLookup);
$("#productLookupModal")?.addEventListener("click", (event) => { if (event.target.id === "productLookupModal") closeProductLookup(); });
$("#productLookupInput")?.addEventListener("input", () => { clearTimeout(window.__productLookupTimer); window.__productLookupTimer = setTimeout(renderProductLookup, 40); });
$("#productLookupScan")?.addEventListener("click", () => openScanner("product"));
$("#accountManageEmployees")?.addEventListener("click", openEmployeeManager);
$("#closeEmployeeManager")?.addEventListener("click", closeEmployeeManager);
$("#employeeManagerModal")?.addEventListener("click", (event) => { if (event.target.id === "employeeManagerModal") closeEmployeeManager(); });
$("#employeeForm")?.addEventListener("submit", submitEmployee);
$("#employeeManagerSearch")?.addEventListener("input", () => debounceManagerSearch("employee", renderEmployeeManager));
$("#renderPayroll")?.addEventListener("click", renderPayroll);
$("#printPayroll")?.addEventListener("click", printPayroll);
$("#exportEmployees")?.addEventListener("click", exportEmployees);
$("#importEmployees")?.addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) importEmployees(file); });
$("#showAllCustomerHistory")?.addEventListener("click", openAllCustomerHistory);
$("#closeCustomerHistory")?.addEventListener("click", closeAllCustomerHistory);
$("#deleteCustomerHistory")?.addEventListener("click", async()=>{if(await openConfirmModal("هل تريد حذف سجل مشتريات هذا العميل فقط؟"))deleteCurrentCustomerHistory();});
$("#customerHistorySearch")?.addEventListener("input", renderAllCustomerHistory);
$("#toggleCustomerHistory")?.addEventListener("click", () => { const items = $("#customerHistoryItems"), button = $("#toggleCustomerHistory"); if (!items || !button) return; const hidden = items.classList.toggle("hidden"); button.textContent = hidden ? "إظهار القائمة" : "إخفاء القائمة"; button.setAttribute("aria-expanded", String(!hidden)); });
$("#resetAllSettings")?.addEventListener("click", resetAllSettings);
function togglePasswordVisibility(button) {
  const input = document.getElementById(button?.dataset?.passwordToggle || "");
  if (!input) return;
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "◌" : "◉";
  button.setAttribute("aria-label", visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
}
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-password-toggle]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  togglePasswordVisibility(button);
}, true);
$("#accountManagePermissions")?.addEventListener("click", openFeaturePermissions);
$("#closeFeaturePermissions")?.addEventListener("click", closeFeaturePermissions);
$("#featurePermissionsModal")?.addEventListener("click", (event) => { if (event.target.id === "featurePermissionsModal") closeFeaturePermissions(); });
$("#featurePermissionsForm")?.addEventListener("submit", saveFeaturePermissionsFromForm);
$("#closeExportImport")?.addEventListener("click", closeExportImportModal);
$("#exportImportModal")?.addEventListener("click", (event) => { if (event.target.id === "exportImportModal") closeExportImportModal(); });
$("#exportDatabaseFormatButton")?.addEventListener("click", exportDatabaseByFormat);
$("#importDatabaseFile")?.addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; importDatabaseByFormat(file); });
$("#accountInventory")?.addEventListener("click", openInventory);
$("#closeInventory")?.addEventListener("click", closeInventory);
$("#inventoryModal")?.addEventListener("click", (event) => { if (event.target.id === "inventoryModal") closeInventory(); });
$("#saveInventory")?.addEventListener("click", saveInventory);
$("#printInventory")?.addEventListener("click", () => printInventoryRecord());

let modalZIndex = 5000;
const modalLayerObserver = new MutationObserver((records) => records.forEach((record) => { if (record.type === "attributes" && record.target.classList.contains("modal") && !record.target.classList.contains("hidden")) record.target.style.zIndex = String(++modalZIndex); }));
modalLayerObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
document.addEventListener("keydown", (event) => { if (event.key !== "Escape") return; const open = [...document.querySelectorAll(".modal:not(.hidden)")].sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))[0]; if (open) open.querySelector("button[id^=close], #accountMenuClose")?.click(); });
initIndexedStorage().then(async () => {
  if (window.InvoiceNative) document.body.classList.add("native-shell");
  await loadSecureSettings();
  await restoreNativeBackupIfNeeded();
  await loadBundledDatabase();
  await restoreSelectedDataFolder();
  await loadProductsFromStorage();
  await loadCustomersFromStorage();
  try {
    const storedUsers = safeJson(appStorage.getItem(USERS_KEY) || "[]", []);
    if (Array.isArray(storedUsers) && storedUsers.length) {
      usersFileUsers = storedUsers;
      usersFileReady = true;
    }
  } catch (error) {}
  syncProgramLock();
  restoreSession();
  updateGuestUI();   
  if (!usersFileReady && !appStorage.getItem(USERS_KEY)) toast("لم يتم العثور على users؛ اختر ملف users.json أو Excel من زر قاعدة البيانات");
  syncUnlockButton();
  syncCentralDevice();
  setInterval(syncCentralDevice, 15 * 60 * 1000);
  setDate();
  renderCart();
  renderSaved();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("sw.js")
      .then(watchForUpdates)
      .catch(() => {});
    navigator.serviceWorker.ready.then((reg) => reg.update());
  }
});
