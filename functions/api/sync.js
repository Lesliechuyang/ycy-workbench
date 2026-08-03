// Cloudflare Pages Function - Data Sync API
// Uses KV storage for cross-device data sync

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// Handle preflight CORS
export async function onRequestOptions() {
  return jsonResponse({});
}

// GET /api/sync?key=xxx - Pull data from cloud
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) return jsonResponse({ error: 'Missing key' }, 400);

  // KV binding: WORKBENCH_KV
  const kv = env.WORKBENCH_KV;
  if (!kv) return jsonResponse({ error: 'KV not configured' }, 500);

  const raw = await kv.get('data:' + key);
  if (!raw) return jsonResponse({ data: null, meta: null, modified: null });

  try {
    const parsed = JSON.parse(raw);
    return jsonResponse({ data: parsed.data, meta: parsed.meta, modified: parsed.modified });
  } catch (e) {
    return jsonResponse({ error: 'Data parse error' }, 500);
  }
}

// POST /api/sync - Push data to cloud (with server-side per-key merge)
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { key, data, meta } = body;

    if (!key || !data) return jsonResponse({ error: 'Missing key or data' }, 400);

    const kv = env.WORKBENCH_KV;
    if (!kv) return jsonResponse({ error: 'KV not configured' }, 500);

    // Read existing cloud data for per-key merge
    const existingRaw = await kv.get('data:' + key);
    let existing = { data: {}, meta: {}, modified: 0 };
    if (existingRaw) {
      try { existing = JSON.parse(existingRaw); } catch(e) {}
    }
    if (!existing.data) existing.data = {};
    if (!existing.meta) existing.meta = {};

    // Merge incoming data per-key using timestamps
    // Only overwrite a key if incoming timestamp is newer
    const incomingMeta = meta || {};
    const mergedData = { ...existing.data };
    const mergedMeta = { ...existing.meta };
    let updatedCount = 0;

    Object.keys(data).forEach(k => {
      const shortKey = k.replace('ycy_', '');
      const incomingTs = incomingMeta[shortKey] || Date.now();
      const existingTs = existing.meta[shortKey] || 0;

      if (incomingTs >= existingTs) {
        mergedData[k] = data[k];
        mergedMeta[shortKey] = incomingTs;
        updatedCount++;
      }
    });

    // Also merge any meta timestamps that are newer (for keys not in this push)
    Object.keys(incomingMeta).forEach(k => {
      if (incomingMeta[k] > (mergedMeta[k] || 0)) {
        mergedMeta[k] = incomingMeta[k];
      }
    });

    const modified = Date.now();
    await kv.put('data:' + key, JSON.stringify({
      data: mergedData,
      meta: mergedMeta,
      modified
    }));

    return jsonResponse({ success: true, modified, updatedCount, totalKeys: Object.keys(mergedData).length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
