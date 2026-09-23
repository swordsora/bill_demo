/*
 * إعداد قاعدة البيانات المركزية عبر Supabase.
 *
 * أنشئ Supabase Edge Function باسم central-api لتنفّذ المسارات المستخدمة في
 * app.js مثل /login و /heartbeat و /devices و /accounts/sync و /login-attempts.
 * لا تضع service_role key هنا؛ المفتاح المسموح للواجهة هو anon key فقط.
 */
window.BILL_CENTRAL_CONFIG = {
  provider: 'supabase',
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_SUPABASE_ANON_KEY',
  edgeFunction: 'central-api',
  timeoutMs: 10000,
  request: async (path, options = {}, context = {}) => {
    const cfg = window.BILL_CENTRAL_CONFIG;
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR_PROJECT_REF') ||
        !cfg.anonKey || cfg.anonKey.includes('YOUR_SUPABASE_ANON_KEY')) {
      throw new Error('أدخل supabaseUrl و anonKey في central-config.js أولًا');
    }

    const base = cfg.supabaseUrl.replace(/\/$/, '');
    const endpoint = `${base}/functions/v1/${cfg.edgeFunction}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 10000);
    const token = context.token || '';
    const headers = {
      'Content-Type': 'application/json',
      apikey: cfg.anonKey,
      Authorization: `Bearer ${token || cfg.anonKey}`,
      ...(options.headers || {})
    };
    const body = typeof options.body === 'string' ? (() => {
      try { return JSON.parse(options.body); } catch { return options.body; }
    })() : options.body;

    try {
      const response = await fetch(endpoint, {
        method: options.method || 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify({
          path,
          method: options.method || 'GET',
          body
        }),
        cache: 'no-store',
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || 'تعذر الاتصال بـ Supabase');
        error.code = data.code || (response.status === 403 ? 'FORBIDDEN' : 'SUPABASE_ERROR');
        error.status = response.status;
        error.serverData = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof TypeError) {
        const networkError = new Error('تعذر الاتصال بـ Supabase. تحقق من إعدادات المشروع والاتصال.');
        networkError.networkError = true;
        networkError.code = 'SUPABASE_NETWORK_ERROR';
        throw networkError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
};
