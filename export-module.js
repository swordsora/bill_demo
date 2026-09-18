/* Export module: keeps format-specific serialization outside app.js. */
(function (global) {
  function exportRows(rows) {
    return (rows || []).map((row) => Object.fromEntries(
      Object.entries(row || {}).map(([key, value]) => [key, value && typeof value === "object" ? JSON.stringify(value) : value])
    ));
  }
  function workbookBlob(data, filename) {
    if (!global.XLSX) return null;
    const book = global.XLSX.utils.book_new();
    const sheets = [
      ["Products", data.products], ["Customers", data.customers], ["Users", data.users],
      ["Employees", data.employees], ["CustomerHistory", data.customerHistory], ["Invoices", data.invoices],
      ["Inventory", data.inventories], ["Payroll", data.payroll], ["AdminLog", data.adminLog],
    ];
    sheets.forEach(([name, rows]) => global.XLSX.utils.book_append_sheet(book, global.XLSX.utils.json_to_sheet(exportRows(rows)), name.slice(0, 31)));
    const output = global.XLSX.write(book, { bookType: "xlsx", type: "array" });
    return new Blob([output], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  global.InvoiceExport = Object.freeze({ exportRows, workbookBlob });
})(window);
