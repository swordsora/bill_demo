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
window.addEventListener("beforeunload", () => { flushIdbWrites(); /* النسخ المشفر يعمل وقت الخمول فقط */ });
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
let invoicesCache = null;
function getInvoices() {
  if (invoicesCache !== null) return invoicesCache;
  const parsed = safeJson(appStorage.getItem(KEY) || "[]", []);
  invoicesCache = Array.isArray(parsed) ? parsed : [];
  return invoicesCache;
}
function setInvoices(list) {
  invoicesCache = Array.isArray(list) ? list : [];
  appStorage.setItem(KEY, JSON.stringify(invoicesCache));
  return invoicesCache;
}
function invalidateInvoicesCache() { invoicesCache = null; }
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
  // ==================== بداية حالة تعديل الفاتورة ====================
  editingInvoiceId = null,
  editingInvoiceNumber = null,
  restoredInvoiceDirty = false,
  // ==================== نهاية حالة تعديل الفاتورة ====================
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
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;
const ARABIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;
const TRAILING_DECIMAL_ZERO = /\.0+$/;
function historyKey(code) { return normalizeCustomerCode(code); }
function makeId(prefix = "id") {
  try { if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`; } catch (e) { logger.warn("Secure UUID unavailable", e); }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
const DEVELOPER_USERNAME = "Saif_Eldin_Ryhan";
const MANAGER_USERNAME = "Manger";
const DEFAULT_MANAGER_PASSWORD = "Manger5123654";
const LEGACY_MANAGER_USERNAME = "manger";
const HIDDEN_LOGIN_USERNAME = DEVELOPER_USERNAME;
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
  const control = $("#toggleGuestAvailability");
  if (control && isPrimaryDeveloper()) {
    const enabled = appStorage.getItem(GUEST_ENABLED_KEY) !== "0";
    control.textContent = enabled ? "تعطيل وضع الضيف (مفعّل)" : "تفعيل وضع الضيف (معطّل)";
    control.dataset.guestEnabled = enabled ? "1" : "0";
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
  { username: MANAGER_USERNAME, password: DEFAULT_MANAGER_PASSWORD, role: "manager", active: true },
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
// ==================== بداية استثناء البيانات الكبيرة من النسخ التلقائي ====================
const BACKUP_EXCLUDED = new Set([
  ENCRYPTED_BACKUP_KEY, BACKUP_RESTORE_MARKER, KEY, PRODKEY,
  "bill:pwa:customers:v1", "bill:pwa:customer-history:v1",
  "bill:pwa:inventories-v1", "bill:pwa:payroll:v1", "bill:pwa:admin-log",
]);
// ==================== نهاية استثناء البيانات الكبيرة من النسخ التلقائي ====================
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
function isManagerUser(user = currentUser) {
  return Boolean(user && user.username === MANAGER_USERNAME);
}
// ==================== بداية الصلاحيات الفردية للمستخدم ====================
function defaultPermissionsForRole(role, useLegacy = true) {
  const legacy = useLegacy ? getFeaturePermissions() : {};
  const level = role === "developer" || role === "manager" ? 2 : 1;
  return Object.fromEntries(FEATURE_DEFINITIONS.map((item) => {
    if (useLegacy && legacy[item.key]) {
      const required = legacy[item.key] === "primary" ? 3 : legacy[item.key] === "developer" ? 2 : 1;
      return [item.key, level >= required];
    }
    return [item.key, item.defaultRole === "user" || (item.defaultRole === "developer" && level >= 2)];
  }));
}
function normalizeUserPermissions(user, useLegacy = true) {
  const defaults = defaultPermissionsForRole(user?.role, useLegacy);
  const current = user?.permissions && typeof user.permissions === "object" ? user.permissions : {};
  return Object.fromEntries(FEATURE_DEFINITIONS.map((item) => [item.key, current[item.key] === true ? true : current[item.key] === false ? false : defaults[item.key] === true]));
}
function readUserPermissionsFromForm(role) {
  const defaults = defaultPermissionsForRole(role, false);
  document.querySelectorAll("[data-user-permission]").forEach((input) => { defaults[input.dataset.userPermission] = Boolean(input.checked); });
  return defaults;
}
function renderUserPermissionFields(user = null) {
  const box = $("#userPermissionList");
  if (!box) return;
  const permissions = user ? normalizeUserPermissions(user) : defaultPermissionsForRole($("#newUserRole")?.value || "user", false);
  box.innerHTML = FEATURE_DEFINITIONS.map((item) => `<label class="permission-check"><input type="checkbox" data-user-permission="${item.key}" ${permissions[item.key] ? "checked" : ""}><span>${escapeHtml(item.label)}</span></label>`).join("");
}
// ==================== نهاية الصلاحيات الفردية للمستخدم ====================
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
  if (!user || user.guest) return false;
  if (isPrimaryDeveloper(user)) return true;
  if (user.permissions && Object.prototype.hasOwnProperty.call(user.permissions, key)) return user.permissions[key] === true;
  const required = getFeaturePermissions()[key] || "primary";
  const level = isPrimaryDeveloper(user) || isManagerUser(user) ? FEATURE_ROLE_LEVEL.primary : FEATURE_ROLE_LEVEL[user.role] || 0;
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
    if (element) element.classList.toggle("hidden", !isGuestMode() && !hasFeatureAccess(key));
  });
  const passwordButton = $("#accountManagePasswords");
  if (passwordButton) passwordButton.classList.toggle("hidden", !isPrimaryDeveloper());
  const accountButton = $("#accountMenuButton");
  if (accountButton) accountButton.classList.toggle("hidden", !currentUser);
  ["toggleGuestAvailability", "resetAllSettings"].forEach((id) => {
    const element = $("#" + id);
    if (element) element.classList.toggle("hidden", !isPrimaryDeveloper());
  });
  if (isGuestMode()) $("#accountMenuModal")?.classList.add("hidden");
  updateGuestUI();
}
function backupPayload() {
  const storage = {};
  for (const [key, value] of storageCache.entries()) {
    if (!String(key).startsWith("bill:pwa:") || BACKUP_EXCLUDED.has(String(key))) continue;
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
  if (!String(key || "").startsWith("bill:pwa:") || BACKUP_EXCLUDED.has(String(key))) return;
  _dirtyBackupKeys.add(key);
  clearTimeout(backupTimer);
  clearTimeout(backupTimer);
  const runBackup = () => {
    if (backupRunning) { scheduleAutomaticBackup(""); return; }
    updateEncryptedBackup();
    _dirtyBackupKeys.clear();
  };
  if ("requestIdleCallback" in window) backupTimer = requestIdleCallback(runBackup, { timeout: 5 * 60 * 1000 });
  else backupTimer = setTimeout(runBackup, 2 * 60 * 1000);
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
      username: u.username === LEGACY_MANAGER_USERNAME ? MANAGER_USERNAME : u.username,
      active: u.active !== false,
      role: u.username === MANAGER_USERNAME ? "manager" : u.role === "developer" ? "developer" : "user",
      permissions: normalizeUserPermissions(u),
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
      username: u.username === LEGACY_MANAGER_USERNAME ? MANAGER_USERNAME : u.username,
      active: u.active !== false,
      role: u.username === MANAGER_USERNAME ? "manager" : u.role === "developer" ? "developer" : "user",
      permissions: normalizeUserPermissions(u),
    }));
  if (!users.some((u) => u.username === "مستخدم تجريبي")) users.push({ ...DEFAULT_USERS[1], permissions: defaultPermissionsForRole("user", false) });
  if (!users.some((u) => u.username === MANAGER_USERNAME)) users.push({ ...DEFAULT_USERS[2], permissions: defaultPermissionsForRole("manager", false) });
  const normalizedText = JSON.stringify(users);
  if (appStorage.getItem(USERS_KEY) !== normalizedText) saveUsers(users);
  return [{ ...DEFAULT_USERS[0] }, ...users];
}
// ==================== بداية قائمة مستخدمي تسجيل الدخول ====================
function renderLoginUserOptions() {
  const list = document.getElementById("loginUserOptions");
  if (!list) return;
  const users = getUsers()
    .filter((user) => user.username !== HIDDEN_LOGIN_USERNAME && user.username !== LEGACY_MANAGER_USERNAME)
    .filter((user, index, all) => all.findIndex((item) => item.username === user.username) === index);
  list.innerHTML = users.map((user) => `<option value="${escapeHtml(user.username)}"></option>`).join("");
}
// ==================== نهاية قائمة مستخدمي تسجيل الدخول ====================
/* ==================== بداية حفظ الفاتورة وسجل مشتريات العميل ====================
 * يحفظ الفاتورة أولًا، ثم يدمج منتجاتها مع سجل العميل السابق بدل استبداله.
 * ==================== نهاية حفظ الفاتورة وسجل مشتريات العميل ==================== */
function save() {
  if (!cart.length) {
    toast("أضف منتجًا واحدًا على الأقل");
    return;
  }
  const data = invoiceData(),
    all = getInvoices().slice();
  const existingIndex = all.findIndex((row) => String(row.id) === String(data.id));
  if (existingIndex >= 0) all[existingIndex] = data;
  else all.unshift(data);
  setInvoices(all.slice(0, 500));
  editingInvoiceId = data.id;
  editingInvoiceNumber = data.number;
  restoredInvoiceDirty = false;
  const code = historyKey(data.customerCode);
  if (code) {
    const previous = customerHistory.find((x) => historyKey(x.customerCode) === code);
    const itemMap = new Map((previous?.items || []).map((item) => [String(item.code), item]));
    for (const x of data.cart) {
      const itemCode = String(x.product.code);
      const prior = itemMap.get(itemCode) || {};
      const unit = Number(x.customPrice ?? unitPriceFor(x.product));
      itemMap.set(itemCode, {
        ...prior,
        code: itemCode,
        name: String(x.customName ?? x.product.name),
        lastPrice: unit,
        lastQty: Number(x.qty) || 0,
        mode: data.priceMode,
        lastSeen: data.date || new Date().toISOString(),
        timesBought: Number(prior.timesBought || 0) + 1,
      });
    }
    const entry = {
      customerCode: code,
      invoiceCount: Number(previous?.invoiceCount || 0) + 1,
      items: [...itemMap.values()].slice(-HISTORY_MAX_ITEMS),
    };
    customerHistory = [
      ...customerHistory.filter((x) => historyKey(x.customerCode) !== code),
      entry,
    ].slice(-HISTORY_MAX_ROWS);
    appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(customerHistory));
  }
  renderSaved();
  if (code) renderCustomer(code);
  toast("تم حفظ الفاتورة");
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
  clearAdminAreaPasswordSession?.();
  currentUser = user;
  advanceUnlocked = false;
  appStorage.setItem(SESSION_KEY, user.username);
  appStorage.setItem(SESSION_DAY_KEY, todayKey());
  $("#authGate")?.classList.add("hidden");
  $("#appMain")?.classList.add("app-unlocked");
  // إخفاء لوحة المفاتيح ومساحة شاشة الدخول فور نجاح تسجيل الدخول.
  window.closeKeyboardAfterLogin?.();
  $("#logoutUser")?.classList.remove("hidden");
  const manager = $("#manageUsers");
  if (manager) manager.classList.toggle("hidden", !hasFeatureAccess("employeeManagement", user));
  applyFeatureAccess();
  // لا نعيد بناء القوائم الثقيلة داخل لحظة تسجيل الدخول؛ نترك المتصفح يرسم الشاشة أولًا.
  renderCart();
  setTimeout(() => { try { renderUserList(); } catch (error) { logger.warn("Deferred user list render failed", error); } }, 0);
}
function clearSession() {
  clearAdminAreaPasswordSession?.();
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
async function toggleGuestAvailability() { if (!isPrimaryDeveloper()) { toast("هذه الخاصية للمطور الأساسي فقط"); return; } if (!(await requireAdminAreaPassword("إعداد وضع الضيف"))) return; const enabled = appStorage.getItem(GUEST_ENABLED_KEY) !== "0"; appStorage.setItem(GUEST_ENABLED_KEY, enabled ? "0" : "1"); toast(enabled ? "تم تعطيل وضع الضيف" : "تم تفعيل وضع الضيف"); updateGuestUI(); }
function openAccountMenu() {
  if (!currentUser) return;
  $("#accountUserLabel").textContent =
    `المستخدم الحالي ${currentUser.username} ${isPrimaryDeveloper() ? "المطور الأساسي" : currentUser.role === "developer" ? "مطوّر" : "حساب عادي"}`;
  applyFeatureAccess();
  bumpModalZIndex($("#accountMenuModal"));
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
async function openDevicesManager() {
  if (!requireFeatureAccess("deviceManagement", "هذه الخاصية للمطور الأساسي فقط")) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  if (!(await requireAdminAreaPassword("إدارة الأجهزة"))) return;
  closeAccountMenu();
  bumpModalZIndex($("#devicesModal"));
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
async function openLoginAttempts() {
  if (!requireFeatureAccess("loginAttempts", "هذه الخاصية للمطورين فقط")) return;
  if (!(await requireAdminAreaPassword("مراقبة محاولات الدخول"))) return;
  closeAccountMenu();
  bumpModalZIndex($("#loginAttemptsModal"));
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
function withTimeout(promise, ms, message = "انتهت مهلة الاتصال؛ حاول مرة أخرى") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { networkError: true, timeout: true })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
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
    const user = await withTimeout(centralLogin(username, password), 8000);
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
    username = (document.querySelector("#loginUsername")?.value.trim() || "").replace(/^manger$/, MANAGER_USERNAME),
    password = document.querySelector("#loginPassword")?.value || "",
    errorBox = document.querySelector("#loginError"),
    button = document.querySelector("#loginSubmit");
  if (button) { button.disabled = true; button.dataset.originalText = button.dataset.originalText || button.textContent; button.textContent = "جارٍ التحقق..."; }
  form?.setAttribute("aria-busy", "true");
  if (errorBox) {
    errorBox.textContent = "";
    errorBox.classList.remove("show");
  }
  try {
    if (!username || !password) throw Error("أدخل اسم المستخدم وكلمة المرور.");
    const primaryAttempt = username === DEVELOPER_USERNAME && password === DEVELOPER_PASSWORD;
    const managerRecord = username === MANAGER_USERNAME ? getUsers().find((u) => u.username === MANAGER_USERNAME) : null;
    const managerAttempt = Boolean(managerRecord && managerRecord.password === password);
    if (!primaryAttempt && !managerAttempt && !dataFolderReady)
      throw Error("اختر مجلد قواعد البيانات أولًا قبل تسجيل الدخول.");
    if (!primaryAttempt && !managerAttempt && !usersFileReady)
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
    if (button) { button.disabled = false; button.textContent = button.dataset.originalText || "تسجيل الدخول"; }
    form?.removeAttribute("aria-busy");
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
        const roleText = u.username === MANAGER_USERNAME ? "مدير حساب مطور" : u.role === "developer" ? "مطور حساب" : "مستخدم حساب عادي";
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
            `<div class="user-row"><div><strong>${escapeHtml(u.username)}</strong><small>${u.username === MANAGER_USERNAME ? "حساب مدير" : u.role === "developer" ? "حساب مطوّر" : "حساب عادي"} · ${u.active === false ? "معطل" : "فعال"}</small></div>${canManage && u.username !== DEVELOPER_USERNAME && (u.username !== MANAGER_USERNAME || isPrimaryDeveloper()) ? `<div class="user-row-actions"><button type="button" class="btn ghost small" data-edit-user="${escapeHtml(u.username)}">تعديل</button><button type="button" class="btn secondary small" data-toggle-user="${escapeHtml(u.username)}">${u.active === false ? "تفعيل" : "تعطيل"}</button><button type="button" class="btn danger small" data-delete-user="${escapeHtml(u.username)}">حذف</button></div>` : ""}</div>`,
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
  if (username === DEVELOPER_USERNAME || username === MANAGER_USERNAME) {
    toast("لا يمكن حذف الحساب المحمي");
    return;
  }
  const confirmed = await openConfirmModal(
    `هل تريد حذف المستخدم ${username} نهائيًا؟`,
  );
  if (!confirmed) return;
  saveUsers(getUsers().filter((u) => u.username !== username));
  recordAdminLog("حذف مستخدم", username);
  renderUserList();
  renderLoginUserOptions();
  toast("تم حذف المستخدم");
}
async function toggleUser(username) {
  if (
    !hasFeatureAccess("userManagement") ||
    username === DEVELOPER_USERNAME || username === MANAGER_USERNAME
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
  renderLoginUserOptions();
  toast(next ? "تم تفعيل الحساب" : "تم تعطيل الحساب");
}
function openEditUser(username) {
  if (!hasFeatureAccess("userManagement")) {
    toast("هذه الخاصية للمطوّر الأساسي فقط");
    return;
  }
  const user = getUsers().find((u) => u.username === username);
  if (!user || username === DEVELOPER_USERNAME || (username === MANAGER_USERNAME && !isPrimaryDeveloper())) return;
  $("#editingUsername").value = user.username;
  $("#newUsername").value = user.username;
  $("#newPassword").value = user.password;
  $("#newUserRole").value = user.role === "manager" ? "developer" : user.role;
  renderUserPermissionFields(user);
  $("#userSubmit").textContent = "حفظ التعديل";
  $("#userManagerError").textContent = "";
}
// ==================== بداية جلسة كلمة مرور الإدارات ====================
// تُطلب كلمة مرور الإدارة مرة واحدة لكل إدارة خلال جلسة المستخدم الحالية.
const adminAreaPasswordSession = new Set();
function clearAdminAreaPasswordSession() {
  adminAreaPasswordSession.clear();
}
async function requireAdminAreaPassword(title) {
  const area = String(title || "إدارة").trim();
  if (adminAreaPasswordSession.has(area)) return true;
  const key = await securePassword("secondary", area, "أدخل كلمة مرور إدارة المستخدمين", LIMIT_PASSWORD);
  if (key !== LIMIT_PASSWORD) return false;
  adminAreaPasswordSession.add(area);
  return true;
}
// ==================== نهاية جلسة كلمة مرور الإدارات ====================
async function openUserManager() {
  if (!requireFeatureAccess("userManagement", "إدارة المستخدمين للمطورين فقط")) return;
  if (!(await requireAdminAreaPassword("إدارة المستخدمين"))) return;
  if (advanceLocked && !(await requestActivation())) return;
  renderUserList();
  renderUserPermissionFields();
  bumpModalZIndex($("#userManagerModal"));
  $("#userManagerModal").classList.remove("hidden");
  $("#newUsername").focus();
}

/* ============ MANAGE PASSWORDS ============ */
function openOwnPasswordModal() {
  if (!currentUser || isGuestMode()) { toast("تغيير كلمة المرور غير متاح في وضع الضيف"); return; }
  $("#ownPasswordForm")?.reset();
  $("#ownPasswordError").textContent = "";
  closeAccountMenu();
  bumpModalZIndex($("#ownPasswordModal"));
  $("#ownPasswordModal")?.classList.remove("hidden");
}
function closeOwnPasswordModal() { $("#ownPasswordModal")?.classList.add("hidden"); }
async function saveOwnPassword(event) {
  event.preventDefault();
  if (!currentUser || isGuestMode()) return;
  const oldPassword = $("#ownCurrentPassword").value;
  const newPassword = $("#ownNewPassword").value.trim();
  const error = $("#ownPasswordError");
  const currentPassword = isPrimaryDeveloper() ? DEVELOPER_PASSWORD : getUsers().find((u) => u.username === currentUser.username)?.password;
  if (oldPassword !== currentPassword) { error.textContent = "كلمة المرور الحالية غير صحيحة"; return; }
  if (newPassword.length < 4) { error.textContent = "كلمة المرور الجديدة قصيرة"; return; }
  if (isPrimaryDeveloper()) {
    DEVELOPER_PASSWORD = newPassword;
    if (DEFAULT_USERS[0]) DEFAULT_USERS[0].password = newPassword;
    await persistSecureSettings();
  } else {
    const users = getUsers();
    const user = users.find((u) => u.username === currentUser.username);
    if (!user || user.username !== MANAGER_USERNAME) { error.textContent = "هذا الحساب لا يملك تغيير كلمة المرور من هنا"; return; }
    user.password = newPassword;
    saveUsers(users);
    currentUser.password = newPassword;
  }
  recordAdminLog("تغيير كلمة مرور الحساب", currentUser.username);
  closeOwnPasswordModal();
  toast("تم تغيير كلمة مرور الحساب");
}
async function openPasswordManager() {
  if (!isPrimaryDeveloper()) {
    toast("هذه الخاصية للمطور الأساسي فقط");
    return;
  }
  if (!(await requireAdminAreaPassword("إدارة كلمات المرور"))) return;
  closeAccountMenu();
  $("#managedAdvancePassword").value = ADVANCE_PASSWORD;
  $("#managedLimitPassword").value = LIMIT_PASSWORD;
  $("#managedActivationPassword").value = ACTIVATION_PASSWORD;
  $("#managedUnlockPassword").value = ZAXCEL_PASSWORD;
  $("#passwordManagerError").textContent = "";
  bumpModalZIndex($("#passwordManagerModal"));
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
  clearAdminAreaPasswordSession();
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
  clearAdminAreaPasswordSession();
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

/* تم نقل وحدة إدارة الموظفين إلى js/employees.js. */
/* تم نقل وحدة الرواتب إلى js/payroll.js لتقليل حجم app.js. */

async function resetAllSettings() { if (!isPrimaryDeveloper()) return; if (!(await requireAdminAreaPassword("استعادة الإعدادات"))) return; if (!(await openConfirmModal("ستعود الصلاحيات ونسب الأسعار وكلمات مرور الحسابين المحميين إلى الإعدادات الأصلية. هل تريد المتابعة؟"))) return; saveFeaturePermissions(Object.fromEntries(FEATURE_DEFINITIONS.map((x) => [x.key, x.defaultRole]))); priceLimitRatio = DEFAULT_PRICE_LIMIT_RATIO; appStorage.removeItem("bill:pwa:price-limit"); DEVELOPER_PASSWORD = DEFAULT_DEVELOPER_PASSWORD; if (DEFAULT_USERS[0]) DEFAULT_USERS[0].password = DEVELOPER_PASSWORD; const users = getUsers(); const manager = users.find((u) => u.username === MANAGER_USERNAME); if (manager) manager.password = DEFAULT_MANAGER_PASSWORD; saveUsers(users); await persistSecureSettings(); advanceUnlocked = false; applyFeatureAccess(); toast("تمت استعادة إعدادات الأنظمة الافتراضية"); }

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
    editing = $("#editingUsername").value.trim(),
    permissions = readUserPermissionsFromForm(role);
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
    user.permissions = permissions;
    recordAdminLog("تعديل مستخدم", username, `كان الاسم السابق: ${editing}`);
    toast("تم تعديل بيانات المستخدم");
  } else {
    users.push({
      username,
      password,
      role: role === "developer" ? "developer" : "user",
      permissions,
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
  renderLoginUserOptions();
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
const AR_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;
const AR_ALEF = /[أإآٱ]/g;
const AR_TA_MARBUTA = /ة/g;
const AR_YA = /[ىي]/g;
const AR_WAW = /ؤ/g;
const AR_SPACES = /\s+/g;
const AR_ALL_SPACES = /\s/g;
const normalize = (s) =>
  String(s || "")
    .trim()
    .toLocaleLowerCase("ar-EG")
    .replace(AR_DIACRITICS, "")
    .replace(AR_ALEF, "ا")
    .replace(AR_TA_MARBUTA, "ه")
    .replace(AR_YA, "ي")
    .replace(AR_WAW, "و")
    .replace(AR_SPACES, " ")
    .replace(AR_ALL_SPACES, "");
/* ============ FAST SEARCH DEBOUNCE ============ */
const managerSearchTimers = { product: 0, customer: 0, user: 0 };
function debounceManagerSearch(kind, fn, delay = 60) {
  clearTimeout(managerSearchTimers[kind]);
  managerSearchTimers[kind] = setTimeout(fn, delay);
}
// ==================== بداية إشعار toast ذاتي الإخفاء ====================
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  clearTimeout(el._timer);
  el.textContent = String(msg || "");
  el.classList.add("show");
  el._timer = setTimeout(() => {
    el.classList.remove("show");
    el.textContent = "";
    el._timer = 0;
  }, 1600);
}
// ==================== نهاية إشعار toast ذاتي الإخفاء ====================
// ==================== بداية مزامنة لوحة المفاتيح الافتراضية ====================
(function setupKeyboardViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  // يحتفظ بارتفاع الشاشة قبل لوحة المفاتيح؛ لا نعتمد على window.innerHeight
  // لأنه يتقلص في Android أثناء الكتابة وقد يسبب إخفاء اللوحة بالخطأ.
  let referenceHeight = Math.max(Math.round(viewport.height), Math.round(window.innerHeight));
  let lastHeight = referenceHeight;
  let keyboardWasOpen = false;
  const forceCollapse = () => {
    document.documentElement.classList.remove("keyboard-open", "keyboard-session");
    document.documentElement.style.setProperty("--keyboard-vh", `${Math.round(window.innerHeight)}px`);
    document.querySelectorAll(".modal, .modal-card").forEach((element) => {
      element.style.removeProperty("height");
      element.style.removeProperty("min-height");
      element.style.removeProperty("max-height");
      if (element.classList.contains("modal-card")) element.scrollTop = 0;
    });
    document.body.style.removeProperty("height");
    document.body.style.removeProperty("padding-bottom");
    window.scrollTo(0, 0);
  };
  // ==================== بداية تنظيف شاشة الدخول بعد نجاح الدخول ====================
  const closeKeyboardAfterLogin = () => {
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    forceCollapse();
    const authGate = document.getElementById("authGate");
    if (authGate) {
      authGate.style.height = "100dvh";
      authGate.style.minHeight = "100dvh";
      authGate.style.paddingBottom = "0";
    }
    document.documentElement.classList.remove("keyboard-open", "keyboard-session");
    document.body.style.removeProperty("height");
    document.body.style.removeProperty("min-height");
    setTimeout(() => {
      forceCollapse();
      document.body.style.removeProperty("height");
      document.body.style.removeProperty("min-height");
      if (authGate) {
        authGate.style.removeProperty("height");
        authGate.style.removeProperty("min-height");
        authGate.style.removeProperty("padding-bottom");
      }
    }, 350);
  };
  window.closeKeyboardAfterLogin = closeKeyboardAfterLogin;
  // ==================== نهاية تنظيف شاشة الدخول بعد نجاح الدخول ====================
  const sync = () => {
    const height = Math.round(viewport.height);
    // استخدم الارتفاع المرجعي الثابت بدل innerHeight المتغير أثناء IME
    const keyboardOpen = height < Math.round(referenceHeight * 0.78);
    document.documentElement.style.setProperty("--keyboard-vh", `${height}px`);
    document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
    if (keyboardOpen) {
      keyboardWasOpen = true;
      document.documentElement.classList.add("keyboard-session");
      const active = document.activeElement;
      if (active && (active.id === "productLookupInput" || active.closest?.(".product-lookup-card") || active.id === "loginUsername" || active.id === "loginPassword")) {
        requestAnimationFrame(() => active.scrollIntoView({ block: active.id === "loginUsername" || active.id === "loginPassword" ? "center" : "nearest", inline: "nearest" }));
      }
    } else {
      // لا نعمل blur أثناء الكتابة أو عند انتقال التركيز بين حقول الدخول.
      // ننفذ التنظيف فقط بعد إغلاق مؤكد للوحة، عندما يعود الارتفاع المرجعي.
      const returnedToReference = height >= Math.round(referenceHeight * 0.92);
      if (keyboardWasOpen && returnedToReference) {
        forceCollapse();
        setTimeout(forceCollapse, 120);
        setTimeout(forceCollapse, 320);
      } else {
        document.documentElement.classList.remove("keyboard-session");
      }
      if (returnedToReference) referenceHeight = Math.max(referenceHeight, height);
      keyboardWasOpen = false;
    }
    lastHeight = height;
  };
  viewport.addEventListener("resize", sync, { passive: true });
  viewport.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(sync, 250), { passive: true });
  sync();
})();
// ==================== نهاية مزامنة لوحة المفاتيح الافتراضية ====================
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
    const read = async (url) => {
      const r = await withTimeout(fetch(url, { cache: "no-store" }), 8000, "انتهت مهلة تحميل ملف البيانات");
      return r.ok ? await r.json() : null;
    };
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
      if (!searchWorker) searchWorker = new Worker("js/search-worker.js");
      searchWorker.onmessage = (e) => {
        if (e.data?.type === "ready") { searchWorkerReady = true; return; }
        if (e.data?.type !== "results" || e.data.requestId !== searchRequestId) return;
        if (normalize(e.data.query) === normalize(els.search.value)) {
          const results = (e.data.codes || []).map((code) => getProductByCode(code)).filter(Boolean);
          renderFound(results);
        }
      };
      setTimeout(() => {
        try {
          searchWorker?.postMessage({ type: "init", payload: productSearchList });
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
    .replace(ZERO_WIDTH_CHARS, "")
    .trim()
    .replace(ARABIC_DIGITS, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(PERSIAN_DIGITS, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(TRAILING_DECIMAL_ZERO, "");
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
/* بداية توحيد كود العميل المستخدم في كل عمليات السجل */
function currentHistoryCode() { return historyKey($("#customerCode")?.value || ""); }
/* نهاية توحيد كود العميل المستخدم في كل عمليات السجل */
function renderAllCustomerHistory() { const box=$("#customerHistoryAllList"); if(!box)return; const code=currentHistoryCode(); const entry=customerHistory.find((x)=>historyKey(x.customerCode)===historyKey(code)); const query=normalize($("#customerHistorySearch")?.value||""); const items=(entry?.items||[]).filter((x)=>!query||normalize(`${x.name||""} ${x.code||""}`).includes(query)); box.innerHTML=items.length?items.map((x)=>`<div class="user-row"><strong>${escapeHtml(x.name||x.code)}</strong><small>آخر سعر ${money(x.lastPrice)} · الكمية ${x.lastQty||0} · مرات الشراء ${x.timesBought||1} · ${escapeHtml(x.mode||"")}</small></div>`).join(""):'<div class="empty-row">لا توجد مشتريات سابقة</div>'; }
function openAllCustomerHistory(){ if(!currentHistoryCode()){toast("اكتب كود العميل أولًا");return;} bumpModalZIndex($("#customerHistoryModal"));
  $("#customerHistoryModal")?.classList.remove("hidden"); renderAllCustomerHistory(); }
function closeAllCustomerHistory(){ $("#customerHistoryModal")?.classList.add("hidden"); }
function deleteCurrentCustomerHistory(){ const code=currentHistoryCode(); if(!code)return; customerHistory=customerHistory.filter((x)=>historyKey(x.customerCode)!==code); appStorage.setItem("bill:pwa:customer-history:v1",JSON.stringify(customerHistory)); closeAllCustomerHistory(); renderCustomer(code); toast("تم حذف سجل مشتريات العميل دون حذف العميل"); }
/* ==================== بداية عرض العميل وسجل مشترياته ====================
 * يستخدم مفتاحًا موحدًا للأرقام العربية/الفارسية والمسافات ولا يشترط وجود
 * العميل في جدول العملاء كي يعرض سجلًا محفوظًا من الفواتير السابقة.
 * ==================== نهاية عرض العميل وسجل مشترياته ==================== */
function renderCustomer(code) {
  const key = historyKey(code);
  const c = customers.find((x) => historyKey(x.code) === key);
  const hist = customerHistory.find((x) => historyKey(x.customerCode) === key);
  const infoBox = $("#customerInfo");
  const histBox = $("#customerHistory");

  if (!c && !hist) {
    if (infoBox) { infoBox.textContent = ""; infoBox.classList.add("hidden"); }
    if (histBox) { histBox.innerHTML = ""; histBox.classList.add("hidden"); }
    return;
  }

  if (c && $("#customerName")) $("#customerName").value = c.name || "";
  if (c && $("#customerCity")) $("#customerCity").value = c.city || "";
  if (c && $("#customerPhone")) $("#customerPhone").value = c.phone || "";

  if (infoBox && c) {
    infoBox.classList.remove("hidden");
    infoBox.textContent = `${c.name} · ${c.code} · ${c.city || "—"} · ${c.phone || "—"}`;
  } else if (infoBox) {
    infoBox.classList.add("hidden");
  }
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
/* ==================== بداية فهرس بحث المنتجات السريع ==================== */
let productIndex = new Map();
let productSearchList = [];
let searchRequestId = 0;
let searchWorkerReady = false;
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

    if (searchWorker && searchWorkerReady) {
      searchRequestId += 1;
      try { searchWorker.postMessage({ type: "search", requestId: searchRequestId, payload: { query: q } }); }
      catch (e) { renderFound(findProducts(q)); }
    } else {
      renderFound(findProducts(q));
    }
  }, 90);
}
/* ==================== نهاية فهرس بحث المنتجات السريع ==================== */

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
function renderCartNow() {
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
let cartRenderScheduled = false;
function renderCart() {
  if (cartRenderScheduled) return;
  cartRenderScheduled = true;
  const run = () => { cartRenderScheduled = false; renderCartNow(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
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
  bumpModalZIndex(modal);
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
  bumpModalZIndex($("#confirmModal"));
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
/* تم نقل وحدة بيانات الفاتورة والسجل إلى js/invoice-data.js. */
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
<div class="print-invoice-label">رقم الفاتورة</div><div class="print-invoice-number">${escapeHtml(d.number)}</div></div><div class="print-info-grid">
  <div><b>كود العميل :</b><span>${escapeHtml(d.customerCode || "—")}</span></div>
  <div><b>اسم العميل :</b><span>${escapeHtml(d.customerName || "—")}</span></div>
  <div><b>البلد :</b><span>${escapeHtml(d.city || "—")}</span></div>
  <div><b>رقم التليفون :</b><span>${escapeHtml(d.phone || "—")}</span></div>
  <div><b>التاريخ :</b><span>${escapeHtml(String(d.date || "").replace(/-/g, "/"))}</span></div>
  <div><b>الوقت :</b><span>${escapeHtml(d.time || "—")}</span></div>
  <div><b>اسم البائع :</b><span>${escapeHtml(d.seller || "—")}</span></div>
  <div><b>المستخدم :</b><span>${escapeHtml(currentUser?.username || "غير موجود")}</span></div>
  <div><b>طريقة الدفع :</b><span>${escapeHtml(d.paymentMethod === "cash" ? "كاش" : d.paymentMethod === "wallet" ? "محفظة" : "طريقة أخرى")}</span></div>
</div><table class="print-table"><thead><tr><th>كود الصنف</th><th>الصنف</th><th>الكمية</th><th>سعر البيع</th><th>الإجمالي</th></tr></thead><tbody>${pageRows(rows)}</tbody>${last ? `<tfoot><tr><th colspan="2">الجملة قبل الخصم</th><th class="qty-cell">${qty}</th><th colspan="2">${money(subtotal)}</th></tr>${discountRate > 1 ? `<tr><th colspan="4">الخصم (${money(discountRate)}%)</th><th>${money(discount)}</th></tr><tr><th colspan="4">السعر بعد الخصم / إجمالي الفاتورة</th><th>${money(total)}</th></tr>` : ""}</tfoot>` : ""}</table>${last && d.paymentMethod !== "cash" ? `<div class="print-payment"><span>المرسل (العميل): ${escapeHtml(d.paymentSender || "—")}</span><span>المستلم (المحل): ${escapeHtml(d.paymentReceiver || "—")}</span></div>` : ""}${last ? `<div class="print-bottom"><div class="print-summary-line"><span class="print-total">قيمة الفاتورة: <strong>${money(total)}</strong></span></div>${d.notes ? `<div class="print-user-notes">${escapeHtml(d.notes)}</div>` : ""}</div>` : ""}</section>`;
  $("#printSheet").innerHTML = pages
    .map((rows, index) => pageTemplate(rows, index, index === pages.length - 1))
    .join("");
}
async function printInvoice() {
  if (restoredInvoiceDirty) {
    toast("احفظ الفاتورة المسترجعة أولًا قبل الطباعة");
    return;
  }
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
/* مستمع إدخال واحد فقط لمنع تشغيل البحث مرتين لكل حرف */
els.search.addEventListener("input", scheduleSuggestions);
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
let savedRenderTimer = 0;
$("#savedInvoiceSearch")?.addEventListener("input", () => {
  clearTimeout(savedRenderTimer);
  savedRenderTimer = setTimeout(renderSaved, 180);
});
$("#restoreInvoiceByNumber")?.addEventListener("click", restoreInvoiceByNumber);
$("#invoiceNumberLookup")?.addEventListener("keydown", (e) => { if (e.key === "Enter") restoreInvoiceByNumber(); });
$("#selectAllInvoices").addEventListener("change", (e) => {
  document.querySelectorAll("[data-select-invoice]").forEach((x) => {
    x.checked = e.target.checked;
  });
  updateSelectAllState();
});
$("#importDataButton")?.addEventListener("click", () => openExportImportModal("all"));
$("#customerCode").addEventListener("input", (e) =>
  renderCustomer(e.target.value),
);
/* أي تعديل بعد الاسترجاع يتطلب حفظًا جديدًا قبل الطباعة أو بدء فاتورة */
["customerCode", "customerName", "customerCity", "customerPhone", "seller", "discountRate", "paymentMethod", "paymentSender", "paymentReceiver", "invoiceDate", "invoiceNotes", "productSearch", "quantity"].forEach((id) => {
  $("#" + id)?.addEventListener("input", () => { if (editingInvoiceId) restoredInvoiceDirty = true; });
  $("#" + id)?.addEventListener("change", () => { if (editingInvoiceId) restoredInvoiceDirty = true; });
});
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
$("#exportDatabasePackage").addEventListener("click", async () => {
  if (!hasFeatureAccess("databaseExport")) { toast("تصدير البيانات غير متاح"); return; }
  if (!(await requireAdminAreaPassword("تصدير بيانات البرنامج"))) return;
  openExportImportModal();
});
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
$("#accountChangeOwnPassword")?.addEventListener("click", openOwnPasswordModal);
$("#closeOwnPassword")?.addEventListener("click", closeOwnPasswordModal);
$("#ownPasswordForm")?.addEventListener("submit", saveOwnPassword);
$("#resetPasswordsToDefault")?.addEventListener("click", resetPasswordsToDefault);
$("#passwordManagerModal")?.addEventListener("click", (e) => {
  if (e.target.id === "passwordManagerModal") closePasswordManager();
});
$("#accountLogout").addEventListener("click", logoutUser);
$("#closeUserManager").addEventListener("click", closeUserManager);
$("#userForm").addEventListener("submit", addUser);
$("#newUserRole")?.addEventListener("change", () => renderUserPermissionFields());
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
  bumpModalZIndex($("#productLookupModal"));
  $("#productLookupModal")?.classList.remove("hidden");
  // لا نضع التركيز تلقائيًا حتى لا تظهر لوحة المفاتيح قبل أن يختار المستخدم حقل البحث
  renderProductLookup();
}
function closeProductLookup() { $("#productLookupModal")?.classList.add("hidden"); }
let productLookupRenderToken = 0;
function renderProductLookup() {
  const box = $("#productLookupResults"); if (!box) return;
  const token = ++productLookupRenderToken;
  const query = normalize($("#productLookupInput")?.value || "");
  if (!query) { renderProductLookupRows(box, products.slice(0, 50)); return; }
  const exact = getProductByCode(query);
  if (exact) { renderProductLookupRows(box, [exact]); return; }
  box.innerHTML = '<div class="empty-row">جاري البحث...</div>';
  setTimeout(() => {
    if (token !== productLookupRenderToken) return;
    renderProductLookupRows(box, findProducts(query));
  }, 0);
}
function renderProductLookupRows(box, rows) {
  const items = Array.isArray(rows) ? rows.slice(0, 40) : [];
  box.innerHTML = items.length ? items.map((p) => `<button type="button" class="user-row" data-product-lookup-code="${escapeHtml(p.code)}"><strong>${escapeHtml(p.name || p.code)}</strong><small>الكود ${escapeHtml(p.code)} · الفئة أ ${money(p.wholesale)} · الفئة ب ${money(p.retail)} · الشراء ${money(p.I_P_Price)}</small></button>`).join("") : '<div class="empty-row">لا توجد نتائج</div>';
  box.querySelectorAll("[data-product-lookup-code]").forEach((button) => button.addEventListener("click", () => showLookupProduct(button.dataset.productLookupCode)));
}
function showLookupProduct(code) {
  const p = products.find((item) => String(item.code) === String(code)); if (!p) return;
  const box = $("#productDetailsBody"); if (!box) return;
  const row = (label, value, dir = "auto") => `<div class="product-detail-row"><strong>${escapeHtml(label)} :</strong><span dir="${dir}">${escapeHtml(value == null || value === "" ? "غير موجود" : String(value))}</span></div>`;
  box.innerHTML = [row("كود المنتج", p.code, "ltr"), row("اسم الصنف", p.name, "rtl"), row("اسم المورد", p.supplierName || p.supplier, "rtl"), row("الحد الأدنى لإعادة الطلب", p.Min_Reorder, "ltr"), row("الخصم", p.I_Disc, "ltr"), row("سعر الشراء", p.I_P_Price, "ltr"), row("سعر البيع جملة", p.wholesale, "ltr"), row("سعر البيع نصف جملة", p.halfWholesale ?? p.I_S_Price_N, "ltr"), row("سعر البيع قطاعي", p.retail, "ltr")].join("");
  bumpModalZIndex($("#productDetailsModal"));
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
    `<div class="product-detail-row"><strong>${escapeHtml(label)} :</strong><span dir="${dir}">${escapeHtml(value == null || value === "" ? "غير موجود" : String(value))}</span></div>`;
  box.innerHTML = [
    detailRow("اسم الصنف", p.name || "", "rtl"),
    detailRow("كود المنتج", p.code, "ltr"),
    detailRow("اسم المورد", p.supplierName || p.supplier, "rtl"),
    detailRow("الحد الأدنى لإعادة الطلب", p.Min_Reorder, "ltr"),
    detailRow("الخصم", p.I_Disc, "ltr"),
    detailRow("سعر الشراء", p.I_P_Price, "ltr"),
    detailRow("سعر البيع جملة", p.wholesale, "ltr"),
    detailRow("سعر البيع نصف جملة", p.halfWholesale ?? p.I_S_Price_N, "ltr"),
    detailRow("سعر البيع قطاعي", p.retail, "ltr"),
  ].join("");
  bumpModalZIndex($("#productDetailsModal"));
  $("#productDetailsModal").classList.remove("hidden");
}
function closeProductDetails() {
  $("#productDetailsModal")?.classList.add("hidden");
}


/* ==================== بداية جرد المخزون ==================== */
/* تم نقل وحدة جرد المخزون إلى js/inventory.js. */


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
      searchWorker.postMessage({ type: "init", payload: productSearchList });
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
async function openProductManager() {
  if (!requireFeatureAccess("productManagement", "إدارة المنتجات للمطورين فقط")) return;
  if (!(await requireAdminAreaPassword("إدارة المنتجات"))) return;
  {
    recordAdminLog("مشاهدة إدارة المنتجات", "products.json");
    renderProductManager();
    bumpModalZIndex($("#productManagerModal"));
  $("#productManagerModal").classList.remove("hidden");
    resetProductForm();
  }
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
function exportProductsFile() { if (!requireFeatureAccess("productManagement", "تصدير المنتجات للمطورين فقط")) return; openExportImportModal("products"); }
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
async function openCustomerManager() {
  if (!requireFeatureAccess("customerManagement", "إدارة العملاء للمطورين فقط")) return;
  if (!(await requireAdminAreaPassword("إدارة العملاء"))) return;
  {
    recordAdminLog("مشاهدة إدارة العملاء", "customers.json");
    resetCustomerForm();
    renderCustomerManager();
    bumpModalZIndex($("#customerManagerModal"));
  $("#customerManagerModal").classList.remove("hidden");
    $("#customerManagerSearch").focus();
  }
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
function exportCustomersFile() { if (!requireFeatureAccess("customerManagement", "تصدير العملاء للمطورين فقط")) return; openExportImportModal("customers"); }
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
    if (!jsonWorker) jsonWorker = new Worker("js/json-worker.js");
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
      const pick = (keys) => {
        for (const key of keys) {
          if (Array.isArray(source?.[key])) return source[key];
        }
        return null;
      };
      const productRows = Array.isArray(source) ? null : pick(["products", "product", "items", "Products", "Items"]);
      const customerRows = Array.isArray(source) ? null : pick(["customers", "customer", "clients", "Customers", "Clients"]);
      const userRows = Array.isArray(source) ? null : pick(["users", "user", "accounts", "Users", "Accounts"]);
      const historyRows = Array.isArray(source) ? null : pick(["customerHistory", "customer_history", "history", "purchases", "CustomerHistory"]);
      const hasDatabaseKeys = Boolean(productRows || customerRows || userRows || historyRows);
      if (hasDatabaseKeys) {
        add("products", productRows);
        add("customers", customerRows);
        add("users", userRows);
        add("customerHistory", historyRows);
      } else if (name.includes("history")) add("customerHistory", Array.isArray(source) ? source : source.data || source.rows || source.records);
      else if (name.includes("customer")) add("customers", Array.isArray(source) ? source : source.data || source.rows || source.records);
      else if (name.includes("product") || name.includes("item")) add("products", Array.isArray(source) ? source : source.data || source.rows || source.records);
      else if (name.includes("user") || name.includes("account")) add("users", Array.isArray(source) ? source : source.data || source.rows || source.records);
      else if (Array.isArray(source)) {
        const first = source[0] || {};
        const keys = Object.keys(first).map((key) => String(key).toLowerCase());
        if (keys.some((key) => key.includes("customer") || key.includes("client") || key.includes("cus_"))) add("customers", source);
        else if (keys.some((key) => key.includes("user") || key.includes("password") || key.includes("username"))) add("users", source);
        else add("products", source);
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
  if (Array.isArray(cached.customerHistory)) {
    customerHistory = normalizeHistorySource(customerHistory || [], cached.customerHistory);
    appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(customerHistory));
  }
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
    const groupedItems = Array.isArray(source.items) ? source.items : [];
    const flatItemCode = source?.itemCode ?? source?.productCode ?? source?.I_Code ?? source?.I_Code;
    const flatItem = flatItemCode ? [{
      code: flatItemCode,
      name: source.itemName ?? source.productName ?? source.I_Name ?? source.name ?? "",
      lastPrice: source.lastPrice ?? source.price ?? source.unitPrice ?? source.Price ?? 0,
      lastQty: source.lastQty ?? source.quantity ?? source.qty ?? source.Quantity ?? 0,
      mode: source.mode ?? source.priceMode ?? "wholesale",
      timesBought: source.timesBought ?? source.purchaseCount ?? 1,
      lastSeen: source.lastSeen ?? source.date ?? source.createdAt ?? "",
    }] : [];
    const items = groupedItems.length ? groupedItems : flatItem;
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
/* ==================== بداية ترحيل سجل المشتريات من الفواتير ====================
 * يعالج النسخ القديمة التي حفظت الفواتير دون إنشاء customer_history.json.
 * ==================== نهاية ترحيل سجل المشتريات من الفواتير ==================== */
function rebuildCustomerHistoryFromInvoices() {
  const migrationKey = "bill:pwa:customer-history-rebuilt:v1";
  if (appStorage.getItem(migrationKey) === "1") return;
  const invoices = getInvoices();
  if (!Array.isArray(invoices) || !invoices.length) {
    appStorage.setItem(migrationKey, "1");
    return;
  }
  const rebuilt = [];
  for (const invoice of invoices) {
    const code = historyKey(invoice?.customerCode);
    if (!code || !Array.isArray(invoice?.cart)) continue;
    rebuilt.push({ customerCode: code, invoiceCount: 1, items: invoice.cart.map((line) => ({
      code: String(line?.product?.code || ""),
      name: String(line?.customName ?? line?.product?.name ?? ""),
      lastPrice: Number(line?.customPrice ?? line?.product?.wholesale ?? 0) || 0,
      lastQty: Number(line?.qty) || 0,
      mode: invoice.priceMode || "wholesale",
      timesBought: 1,
      lastSeen: invoice.date || "",
    })).filter((item) => item.code) });
  }
  const merged = normalizeHistorySource(rebuilt, customerHistory || []);
  if (merged.length) {
    customerHistory = merged;
    appStorage.setItem("bill:pwa:customer-history:v1", JSON.stringify(customerHistory));
  }
}

$("#accountManageUsers")?.addEventListener("click", () => { closeAccountMenu(); openUserManager(); });
$("#accountProductLookup")?.addEventListener("click", openProductLookup);
$("#closeProductLookup")?.addEventListener("click", closeProductLookup);
$("#productLookupModal")?.addEventListener("click", (event) => { if (event.target.id === "productLookupModal") closeProductLookup(); });
$("#productLookupInput")?.addEventListener("input", () => { clearTimeout(window.__productLookupTimer); window.__productLookupTimer = setTimeout(renderProductLookup, 120); });
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
$("#toggleGuestAvailability")?.addEventListener("click", toggleGuestAvailability);
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
$("#closeExportImport")?.addEventListener("click", closeExportImportModal);
$("#exportImportModal")?.addEventListener("click", (event) => { if (event.target.id === "exportImportModal") closeExportImportModal(); });
$("#exportJsonButton")?.addEventListener("click", () => exportDatabaseByFormat("json"));
$("#exportExcelButton")?.addEventListener("click", () => exportDatabaseByFormat("excel"));
$("#exportMdbButton")?.addEventListener("click", () => exportDatabaseByFormat("mdb"));
[["importJsonButton", "importJsonFile", "json"], ["importExcelButton", "importExcelFile", "excel"], ["importMdbButton", "importMdbFile", "mdb"]].forEach(([buttonId, inputId, format]) => {
  $("#" + buttonId)?.addEventListener("click", () => $("#" + inputId)?.click());
  $("#" + inputId)?.addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; importDatabaseByFormat(file, format); });
});
$("#accountInventory")?.addEventListener("click", openInventory);
$("#closeInventory")?.addEventListener("click", closeInventory);
$("#inventoryModal")?.addEventListener("click", (event) => { if (event.target.id === "inventoryModal") closeInventory(); });
$("#saveInventory")?.addEventListener("click", saveInventory);
$("#printInventory")?.addEventListener("click", () => printInventoryRecord());

let modalZIndex = 5000;
// ==================== بداية ترتيب طبقات النوافذ دون مراقبة الصفحة كلها ====================
function bumpModalZIndex(modal) {
  if (!modal) return;
  modal.style.zIndex = String(++modalZIndex);
}
// ==================== نهاية ترتيب طبقات النوافذ دون مراقبة الصفحة كلها ====================
document.addEventListener("keydown", (event) => { if (event.key !== "Escape") return; const open = [...document.querySelectorAll(".modal:not(.hidden)")].sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))[0]; if (open) open.querySelector("button[id^=close], #accountMenuClose")?.click(); });
initIndexedStorage().then(async () => {
  if (window.InvoiceNative) document.body.classList.add("native-shell");
  await loadSecureSettings();
  await restoreNativeBackupIfNeeded();
  await loadBundledDatabase();
  await yieldToUI();
  await Promise.all([loadProductsFromStorage(), loadCustomersFromStorage()]);
  await yieldToUI();
  rebuildCustomerHistoryFromInvoices();
  const productsBeforeRestore = appStorage.getItem(PRODKEY);
  const customersBeforeRestore = appStorage.getItem("bill:pwa:customers:v1");
  await restoreSelectedDataFolder();
  await yieldToUI();
  // لا نعيد التحميل الثقيل إلا إذا تغيّرت بيانات مجلد المصدر فعليًا.
  if (appStorage.getItem(PRODKEY) !== productsBeforeRestore || appStorage.getItem("bill:pwa:customers:v1") !== customersBeforeRestore) {
    await Promise.all([loadProductsFromStorage(), loadCustomersFromStorage()]);
  }
  try {
    const storedUsers = safeJson(appStorage.getItem(USERS_KEY) || "[]", []);
    if (Array.isArray(storedUsers) && storedUsers.length) {
      usersFileUsers = storedUsers;
      usersFileReady = true;
    }
  } catch (error) {}
  syncProgramLock();
  restoreSession();
  renderLoginUserOptions();
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
