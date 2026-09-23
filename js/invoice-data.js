/* ==================== بداية وحدة بيانات الفاتورة والسجل ====================
 * حساب الإجماليات، بيانات الفاتورة، السجل المحلي، الاستيراد والتصدير.
 * تُحمّل قبل app.js وتستخدم الحالة العامة بعد اكتمال تشغيل التطبيق.
 * ==================== نهاية وصف الوحدة ==================== */
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
/* ==================== بداية ترقيم الفواتير واسترجاعها ====================
 * أرقام الفواتير متسلسلة ورقمية فقط، مع الحفاظ على أرقام النسخ القديمة.
 * ==================== نهاية ترقيم الفواتير واسترجاعها ==================== */
function nextInvoiceNumber() {
  const invoices = getInvoices();
  const maxStored = Array.isArray(invoices)
    ? invoices.reduce((max, row) => Math.max(max, Number(historyKey(row?.number)) || 0), 0)
    : 0;
  const configured = Number(appStorage.getItem("bill:pwa:next-invoice-number") || 0) || 0;
  const next = Math.max(maxStored, configured, 0) + 1;
  appStorage.setItem("bill:pwa:next-invoice-number", String(next));
  return String(next);
}
function invoiceData() {
  return {
    id: editingInvoiceId || makeId("invoice"),
    number: editingInvoiceNumber || nextInvoiceNumber(),
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
    // نخزن الحقول اللازمة للفاتورة فقط، وليس كائن المنتج الكامل وفهرس البحث.
    cart: cart.map((row) => ({
      qty: Number(row.qty) || 0,
      customPrice: row.customPrice == null ? undefined : Number(row.customPrice),
      customName: row.customName || undefined,
      product: {
        code: String(row.product?.code || ""),
        name: String(row.product?.name || ""),
        wholesale: Number(row.product?.wholesale || 0),
        retail: Number(row.product?.retail || 0),
        I_P_Price: Number(row.product?.I_P_Price || 0),
      },
    })),
  };
}

function customerDisplayName(code, fallback = "") {
  const key = String(code || "").trim();
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
  const all = getInvoices();
  const query = normalize($("#savedInvoiceSearch")?.value || "");
  const visible = query
    ? all.filter((x) => {
        const header = normalize(`${x.number || ""} ${x.customerCode || ""} ${x.customerName || ""} ${x.date || ""}`);
        if (header.includes(query)) return true;
        return (x.cart || []).some((i) => normalize(`${i.product?.name || ""} ${i.product?.code || ""}`).includes(query));
      })
    : all;
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
/* بداية استرجاع فاتورة بالرقم */
function restoreInvoiceByNumber() {
  const raw = String($("#invoiceNumberLookup")?.value || "").trim();
  const number = raw.replace(/[^0-9]/g, "");
  if (!number) { toast("اكتب رقم الفاتورة أولًا"); return; }
  const invoices = getInvoices();
  const found = invoices.find((row) => String(row.number || "").replace(/[^0-9]/g, "") === number);
  if (!found) { toast(`لا توجد فاتورة بالرقم ${number}`); return; }
  loadInvoice(found.id);
  $("#invoiceNumberLookup").value = number;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/* نهاية استرجاع فاتورة بالرقم */
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
    invoices: getInvoices(),
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
  const invoices = getInvoices().filter((x) =>
    ids.includes(String(x.id)),
  );
  openExportImportModal("invoices", invoices);
}
async function deleteSelectedInvoices() {
  const ids = selectedInvoiceIds();
  if (!ids.length) {
    toast("حدد فاتورة واحدة على الأقل للحذف");
    return;
  }
  if (!(await openConfirmModal(`هل تريد حذف ${ids.length.toLocaleString("en-US")} فاتورة محددة؟`))) return;
  const all = getInvoices().filter(
    (x) => !ids.includes(String(x.id)),
  );
  setInvoices(all);
  renderSaved();
  toast("تم حذف الفواتير المحددة");
}
function loadInvoice(id) {
  const x = getInvoices().find(
    (i) => String(i.id) === String(id),
  );
  if (!x) return;
  const currentMode = priceMode;
  editingInvoiceId = x.id;
  editingInvoiceNumber = String(x.number || "").replace(/[^0-9]/g, "") || null;
  restoredInvoiceDirty = true;
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
  if (restoredInvoiceDirty) {
    toast("احفظ الفاتورة المسترجعة أولًا قبل إنشاء فاتورة جديدة");
    return;
  }
  editingInvoiceId = null;
  editingInvoiceNumber = null;
  restoredInvoiceDirty = false;
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

let exportPickerScope = "all", exportPickerRows = null;
function openExportImportModal(scope = "all", rows = null) { if (!requireFeatureAccess("databaseExport", "إدارة تصدير واستيراد البيانات للمطورين فقط")) return; exportPickerScope = scope; exportPickerRows = rows; closeAccountMenu(); bumpModalZIndex($("#exportImportModal")); $("#exportImportModal")?.classList.remove("hidden"); }
function closeExportImportModal() { $("#exportImportModal")?.classList.add("hidden"); }
async function exportDatabaseByFormat(format, scope = exportPickerScope) {
  const data = databaseExportPayload();
  const date = new Date().toISOString().slice(0, 10);
  const names = { products: "products", customers: "customers", employees: "employees", users: "users", invoices: "invoices", inventory: "inventory" };
  const scoped = scope === "all" ? data : scope === "inventory" ? { inventories: data.inventories, payroll: data.payroll } : { [scope]: exportPickerRows || data[scope] || [] };
  if (format === "json") await downloadJson({ version: data.version, format: "invoice-program-export", scope, ...scoped }, `database-${scope}-${date}.json`);
  else if (format === "excel") {
    await yieldToUI();
    const exported = await exportWorkbook(scoped, `database-${scope}-${date}.xlsx`);
    if (!exported) { toast("تعذر تصدير Excel؛ تأكد من تحميل مكتبة Excel"); return; }
  }
  else {
    const saved = (await idbReadDatabaseFiles()).records.find((x) => String(x.name).toLowerCase().endsWith(".mdb"));
    if (!saved) { toast("لا توجد نسخة MDB أصلية محفوظة للتصدير"); return; }
    if (scope !== "all") { toast("تصدير MDB المنفصل يحتاج قاعدة MDB قابلة للكتابة؛ سيتم تصدير قاعدة MDB الأصلية كاملة"); }
    await downloadBlob(saved.blob, `database-${scope}-${saved.name}`);
  }
  recordAdminLog("تصدير البيانات", `${scope}:${format}`);
  toast(scope === "all" ? "تم تصدير كل البيانات في ملف واحد" : `تم تصدير قسم ${names[scope] || scope}`);
}
async function importDatabaseByFormat(file, format) {
  if (!file) return;
  if (format === "json") await importBackup(file);
  else if (format === "excel" || format === "mdb") {
    const extension = format === "excel" ? "xlsx" : "mdb";
    const prepared = new File([file], `import.${extension}`, { type: file.type || "application/octet-stream" });
    await loadSelectedDataFolder([prepared]);
  }
  closeExportImportModal();
}

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
  openExportImportModal("all");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.invoices)) throw Error("invalid");
    setInvoices(data.invoices);
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

/* ==================== نهاية وحدة بيانات الفاتورة والسجل ==================== */
