/* ==================== بداية وحدة الرواتب ====================
 * كل موظف يظهر في صف واحد، والحقول قابلة للتعديل داخل صفه.
 * تعتمد الوحدة على دوال التطبيق العامة مثل $, money, escapeHtml و toast.
 * ==================== نهاية وصف وحدة الرواتب ==================== */
const PAYROLL_KEY = "bill:pwa:payroll:v1";
function payrollRecords() { return safeJson(appStorage.getItem(PAYROLL_KEY) || "[]", []); }
function savePayrollRecords(records) { appStorage.setItem(PAYROLL_KEY, JSON.stringify(records.slice(-12000))); }
function payrollFor(month, employeeId) {
  return payrollRecords().find((x) => x.month === month && String(x.employeeId) === String(employeeId)) || {
    month, employeeId, advances: 0, absenceDeductionAmount: 0,
    halfDayDeductionAmount: 0, lateCount: 0, lateDeduction: 0, otherDeductions: 0, additions: 0, notes: ""
  };
}
function calculatePayroll(employee, record) {
  // القيم المدخلة في الواجهة مبالغ مالية بالجنيه وليست عدد أيام.
  const legacyDay = Number(employee.workDays) ? Number(employee.salary || 0) / Number(employee.workDays) : 0;
  const absence = Number(record.absenceDeductionAmount ?? (Number(record.absenceDays || 0) * legacyDay)) || 0;
  const half = Number(record.halfDayDeductionAmount ?? (Number(record.halfDays || 0) * legacyDay * 0.5)) || 0;
  const total = absence + half + Number(record.lateDeduction || 0) + Number(record.advances || 0) + Number(employee.insurance || 0) + Number(record.otherDeductions || 0);
  return { ...record, absenceDeduction: absence, halfDayDeduction: half, totalDeductions: total, net: Math.max(0, Number(employee.salary || 0) + Number(record.additions || 0) - total) };
}
function payrollField(label, key, value) {
  return `<td><label class="payroll-cell-label">${label}<input data-payroll="${key}" type="number" min="0" step="0.01" value="${Number(value || 0)}"></label></td>`;
}
function renderPayroll() {
  if (!requireFeatureAccess("employeeManagement", "إدارة المرتبات للمطورين فقط")) return;
  const month = $("#payrollMonth")?.value || new Date().toISOString().slice(0, 7);
  const box = $("#payrollList");
  if (!box) return;
  const employees = employeeRecords();
  if (!employees.length) { box.innerHTML = '<div class="empty-row">لا يوجد موظفون</div>'; return; }
  const rows = employees.map((employee) => {
    const rec = calculatePayroll(employee, payrollFor(month, employee.id));
    return `<tr data-payroll-id="${escapeHtml(String(employee.id))}">
      <td>${escapeHtml(employee.name)}</td><td>${escapeHtml(employee.job || "—")}</td>
      <td>${money(employee.salary)}</td>${payrollField("سلف", "advances", rec.advances)}${payrollField("خصم الغياب (جنيه)", "absenceDeductionAmount", rec.absenceDeductionAmount)}${payrollField("خصم نصف اليوم (جنيه)", "halfDayDeductionAmount", rec.halfDayDeductionAmount)}${payrollField("خصم تأخير", "lateDeduction", rec.lateDeduction)}${payrollField("خصومات أخرى", "otherDeductions", rec.otherDeductions)}${payrollField("إضافات", "additions", rec.additions)}
      <td class="payroll-number" data-payroll-total>${money(rec.totalDeductions)}</td><td class="payroll-number" data-payroll-net>${money(rec.net)}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `<div class="payroll-table-wrap"><table class="payroll-table"><thead><tr><th>الموظف</th><th>الوظيفة</th><th>الأساسي</th><th>سلف</th><th>خصم الغياب (جنيه)</th><th>خصم نصف اليوم (جنيه)</th><th>خصم تأخير</th><th>خصومات أخرى</th><th>إضافات</th><th>إجمالي الخصم</th><th>الصافي</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  box.querySelectorAll("[data-payroll]").forEach((input) => input.addEventListener("change", () => {
    const row = input.closest("[data-payroll-id]");
    const id = row?.dataset.payrollId;
    if (!id) return;
    const current = payrollFor(month, id);
    current[input.dataset.payroll] = Number(input.value) || 0;
    current.month = month; current.employeeId = id;
    const all = payrollRecords().filter((x) => !(x.month === month && String(x.employeeId) === String(id)));
    all.push(current); savePayrollRecords(all);
    const employee = employeeRecords().find((item) => String(item.id) === String(id));
    const calculated = employee ? calculatePayroll(employee, current) : null;
    if (calculated) {
      const totalCell = row.querySelector("[data-payroll-total]");
      const netCell = row.querySelector("[data-payroll-net]");
      if (totalCell) totalCell.textContent = money(calculated.totalDeductions);
      if (netCell) netCell.textContent = money(calculated.net);
    }
  }));
}
function printPayroll() {
  if (!requireFeatureAccess("employeeManagement", "طباعة كشف المرتبات للمطورين فقط")) return;
  const month = $("#payrollMonth")?.value || new Date().toISOString().slice(0, 7);
  const rows = employeeRecords().map((e) => { const r = calculatePayroll(e, payrollFor(month, e.id)); return `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.job || "")}</td><td>${money(e.salary)}</td><td>${money(r.absenceDeduction)}</td><td>${money(r.halfDayDeduction)}</td><td>${money(r.lateDeduction)}</td><td>${money(r.advances)}</td><td>${money(r.totalDeductions)}</td><td>${money(r.additions)}</td><td>${money(r.net)}</td></tr>`; }).join("");
  const sheet = $("#printSheet");
  if (!sheet) { toast("تعذر تجهيز ورقة الطباعة"); return; }
  const oldTitle = document.title;
  document.title = `كشف مرتبات ${month}`;
  sheet.innerHTML = `<section class="print-page payroll-print-page"><h2>كشف مرتبات شهر ${escapeHtml(month)}</h2><table class="print-table"><thead><tr><th>الموظف</th><th>الوظيفة</th><th>الأساسي</th><th>خصم الغياب (جنيه)</th><th>خصم نصف اليوم (جنيه)</th><th>تأخير</th><th>سلف</th><th>إجمالي الخصم</th><th>إضافات</th><th>الصافي</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  window.print();
  setTimeout(() => { sheet.innerHTML = ""; document.title = oldTitle; }, 1200);
}
/* ==================== نهاية وحدة الرواتب ==================== */
