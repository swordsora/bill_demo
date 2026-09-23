/* ==================== بداية وحدة جرد المخزون ====================
 * إدخال الجرد وحفظه وتحديث المخزون والطباعة.
 * ==================== نهاية وصف وحدة جرد المخزون ==================== */
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
async function openInventory() {
  if (!requireFeatureAccess("inventory", "جرد المخزون للمطورين فقط")) return;
  if (!(await requireAdminAreaPassword("جرد المخزون"))) return;
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
