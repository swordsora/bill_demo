const SYNC_QUEUE_KEY = 'bill:pwa:sync-queue';

export function syncConfig(config = {}) {
  return {
    provider: config.provider || 'supabase',
    request: typeof config.request === 'function' ? config.request : null,
    baseUrl: String(config.baseUrl || '').replace(/\/$/, '')
  };
}

export function queueInvoice(invoice) {
  const q = JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
  q.push(invoice);
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q));
  return q.length;
}

export async function pushQueuedInvoices(config, token) {
  if (!config || !token) return 0;
  const q = JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
  let sent = 0;
  for (const invoice of q) {
    let response;
    if (typeof config.request === 'function') {
      await config.request('/invoices', {
        method: 'POST',
        body: JSON.stringify(invoice)
      }, { token });
      response = { ok: true };
    } else if (config.baseUrl) {
      response = await fetch(`${config.baseUrl}/api/invoices`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(invoice)
      });
    } else {
      break;
    }
    if (!response.ok) break;
    sent++;
  }
  if (sent) {
    q.splice(0, sent);
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q));
  }
  return sent;
}

export function queuedCount() {
  return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]').length;
}
