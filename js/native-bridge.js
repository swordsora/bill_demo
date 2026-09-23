/* Native bridge adapter shared by Android and desktop shells. */
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
