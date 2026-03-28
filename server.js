const express = require('express');
const path = require('path');
const yaml = require('js-yaml');
const config = require('./config');
const db = require('./database');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
db.initDb(config.defaultSubscriptions);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory health status for fast failover decisions
const linkHealth = new Map(); // url -> { healthy: bool, lastCheck: Date }

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${config.adminToken}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// Upstream subscription fetching
// ---------------------------------------------------------------------------
async function tryFetchUrl(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ClashForAndroid/2.5.12' },
    });
    const elapsed = Date.now() - start;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.text();
    if (!body || body.length < 10) throw new Error('Empty response');
    return {
      content: body,
      contentType: resp.headers.get('content-type') || 'text/plain',
      contentDisposition: resp.headers.get('content-disposition'),
      subscriptionUserinfo: resp.headers.get('subscription-userinfo'),
      elapsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Parse subscription-userinfo header: "upload=xxx; download=xxx; total=xxx; expire=xxx"
function parseSubInfo(header) {
  if (!header) return null;
  const info = {};
  header.split(';').forEach((part) => {
    const [key, val] = part.trim().split('=');
    if (key && val) info[key.trim()] = parseInt(val.trim()) || 0;
  });
  return info;
}

// Detect content format
function isClashYaml(content) {
  return /^(port|mixed-port|proxies|proxy-groups):/m.test(content);
}

function isBase64ProxyList(content) {
  try {
    const decoded = Buffer.from(content.trim(), 'base64').toString('utf-8');
    return /^(ss|ssr|vmess|vless|trojan|hysteria|hy2|tuic):\/\//m.test(decoded);
  } catch {
    return false;
  }
}

// Merge multiple subscription contents into one
function mergeSubscriptionContents(results) {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const clashResults = results.filter((r) => isClashYaml(r.content));
  const base64Results = results.filter((r) => isBase64ProxyList(r.content));

  // All base64: merge decoded lines
  if (base64Results.length > 0 && clashResults.length === 0) {
    const allLines = [];
    for (const r of base64Results) {
      const decoded = Buffer.from(r.content.trim(), 'base64').toString('utf-8');
      allLines.push(...decoded.split('\n').filter((l) => l.trim()));
    }
    const unique = [...new Set(allLines)];
    return {
      content: Buffer.from(unique.join('\n')).toString('base64'),
      contentType: 'text/plain; charset=utf-8',
    };
  }

  // Has Clash YAML: merge using proper YAML parsing
  if (clashResults.length > 0) {
    try {
      return mergeClashConfigs(clashResults);
    } catch (err) {
      console.error('[merge] YAML merge failed, returning first result:', err.message);
      return results[0];
    }
  }

  return results[0];
}

// Merge Clash configs by text surgery — preserves original formatting that Clash clients expect.
// Uses js-yaml only for PARSING (to extract proxy data), never for serialization.
function mergeClashConfigs(results) {
  // Parse all configs to extract proxy data
  const configs = results.map((r, i) => {
    try {
      return { parsed: yaml.load(r.content), raw: r.content, index: i };
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (configs.length === 0) return results[0];

  const base = configs[0];
  const baseNames = new Set((base.parsed.proxies || []).map((p) => p.name));
  const newProxyLines = [];   // raw YAML lines to insert
  const newProxyNames = [];   // names for proxy-group patching

  // Extract new proxies from other configs as raw text lines
  for (let i = 1; i < configs.length; i++) {
    const otherParsed = configs[i].parsed;
    const otherRaw = configs[i].raw;

    // Extract the raw proxies section text from this config
    const rawProxyEntries = extractRawProxyEntries(otherRaw);

    for (const entry of rawProxyEntries) {
      // Parse name from the raw text
      const nameMatch = entry.match(/name:\s*['"]?([^'",}\n]+)/);
      const name = nameMatch ? nameMatch[1].trim() : null;
      if (name && !baseNames.has(name)) {
        baseNames.add(name);
        newProxyLines.push(entry);
        newProxyNames.push(name);
      }
    }
  }

  if (newProxyLines.length === 0) {
    console.log('[merge] No new proxies to merge, returning base config');
    return results[0];
  }

  // Step 1: Insert new proxy lines at end of proxies section in the raw base text
  let merged = insertProxiesIntoRaw(base.raw, newProxyLines);

  // Step 2: Patch proxy-groups to include new proxy names
  merged = patchProxyGroups(merged, base.parsed, newProxyNames);

  console.log(
    `[merge] Merged ${configs.length} configs: ${baseNames.size} total proxies (${newProxyNames.length} new)`
  );

  return {
    content: merged,
    contentType: results[0].contentType,
  };
}

// Extract each proxy entry as a raw text line from a Clash YAML config
function extractRawProxyEntries(rawYaml) {
  const lines = rawYaml.split('\n');
  const entries = [];
  let inProxies = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^proxies:\s*$/.test(line)) {
      inProxies = true;
      continue;
    }
    if (inProxies) {
      // Stop at next top-level key
      if (/^\S/.test(line) && !/^\s*-/.test(line) && line.trim() !== '') {
        break;
      }
      // Compact format: - { name: xxx, ... }
      if (/^\s+-\s*\{/.test(line)) {
        entries.push(line);
      }
      // Block format: - name: xxx (skip for now, less common)
    }
  }
  return entries;
}

// Insert proxy lines into raw YAML text, right before the next section after proxies
function insertProxiesIntoRaw(rawYaml, newLines) {
  const lines = rawYaml.split('\n');
  const result = [];
  let inProxies = false;
  let inserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^proxies:\s*$/.test(line)) {
      inProxies = true;
      result.push(line);
      continue;
    }

    // Detect end of proxies section (next top-level key)
    if (inProxies && !inserted && /^\S/.test(line) && !/^\s*-/.test(line) && line.trim() !== '') {
      // Insert new proxies before this line, using same indentation as existing entries
      const indent = detectProxyIndent(result);
      for (const pl of newLines) {
        // Normalize indentation to match base config
        result.push(pl.replace(/^\s+/, indent));
      }
      inserted = true;
      inProxies = false;
    }

    result.push(line);
  }

  // If proxies was the last section
  if (inProxies && !inserted) {
    const indent = detectProxyIndent(result);
    for (const pl of newLines) {
      result.push(pl.replace(/^\s+/, indent));
    }
  }

  return result.join('\n');
}

// Detect the indentation used for proxy entries in the config
function detectProxyIndent(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\s+)-\s/);
    if (m) return m[1];
  }
  return '    '; // default 4 spaces
}

// Patch proxy-groups in raw text to include new proxy names
function patchProxyGroups(rawYaml, parsedBase, newNames) {
  if (!parsedBase['proxy-groups'] || newNames.length === 0) return rawYaml;

  // Build a comma-separated string of new names for inline format
  const newNamesStr = newNames.map((n) => {
    // Quote names that contain special chars
    return /[,\[\]{}:'"#&*!|>%@`\s]/.test(n) ? `'${n.replace(/'/g, "''")}'` : n;
  }).join(', ');

  const lines = rawYaml.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match inline proxy-group with select/url-test/fallback/load-balance and a proxies array
    if (/^\s+-\s*\{.*type:\s*(select|url-test|fallback|load-balance).*proxies:\s*\[/.test(line)) {
      // Find the proxies array closing bracket ']' and insert before it
      // The ']' may be followed by ', url: ...' or '} ' etc.
      const patched = line.replace(/(proxies:\s*\[[^\]]*)\]/, `$1, ${newNamesStr}]`);
      result.push(patched);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

// Fetch from a single subscription with failover awareness
async function fetchSingleSubscription(link) {
  const health = linkHealth.get(link.url);
  const timeout =
    health && !health.healthy && link.is_main
      ? config.retryTimeout
      : config.requestTimeout;
  const result = await tryFetchUrl(link.url, timeout);
  linkHealth.set(link.url, { healthy: true, lastCheck: new Date() });

  // Update subscription info if header present
  const info = parseSubInfo(result.subscriptionUserinfo);
  if (info) {
    db.updateSubscriptionInfo(link.id, info.upload, info.download, info.total, info.expire);
  }

  return { ...result, source: link.name, sourceUrl: link.url, subId: link.id };
}

// Fetch with failover (single best link) - used when share has no specific subscription selection
async function fetchSubscriptionFailover(links) {
  for (const link of links) {
    try {
      return await fetchSingleSubscription(link);
    } catch (err) {
      console.log(`[failover] ${link.name} failed: ${err.message}`);
      linkHealth.set(link.url, { healthy: false, lastCheck: new Date() });
    }
  }
  return null;
}

// Fetch multiple subscriptions and merge results
async function fetchMultipleSubscriptions(links) {
  const results = [];
  const sources = [];

  for (const link of links) {
    try {
      const result = await fetchSingleSubscription(link);
      results.push(result);
      sources.push(link.name);
    } catch (err) {
      console.log(`[multi-fetch] ${link.name} failed: ${err.message}`);
      linkHealth.set(link.url, { healthy: false, lastCheck: new Date() });
    }
  }

  if (results.length === 0) return null;

  const merged = mergeSubscriptionContents(results);
  return {
    content: merged.content,
    contentType: merged.contentType || results[0].contentType,
    subscriptionUserinfo: results[0].subscriptionUserinfo,
    source: sources.join(' + '),
  };
}

// ---------------------------------------------------------------------------
// Public share endpoints
// ---------------------------------------------------------------------------

// Shared access-control logic
function checkShareAccess(share, req, res) {
  if (!share) { res.status(404).send('Link not found'); return null; }
  if (share.revoked) { res.status(403).send('This link has been revoked'); return null; }

  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress;

  const isNewImport = db.recordClientAccess(share.token, clientIp);
  const importCount = db.getShareImportCount(share.token);

  if (isNewImport && share.max_uses && importCount > share.max_uses) {
    res.status(410).send('This link has expired (import limit reached)');
    return null;
  }

  return { clientIp, isNewImport, importCount };
}

// Get the list of subscriptions for a share
function getShareSubscriptions(share) {
  const subIds = share.subscription_ids ? JSON.parse(share.subscription_ids) : null;
  if (subIds && subIds.length > 0) {
    return db.getSubscriptionsByIds(subIds);
  }
  return db.getEnabledSubscriptions();
}

// /s/:token — overview page listing all subscription links for this share
app.get('/s/:token', (req, res) => {
  const share = db.getShareByToken(req.params.token);
  if (!share) return res.status(404).send('Link not found');
  if (share.revoked) return res.status(403).send('This link has been revoked');

  const subs = getShareSubscriptions(share);
  if (subs.length === 0) {
    return res.status(502).send('No subscriptions available');
  }

  // If only 1 subscription, redirect directly to it
  if (subs.length === 1) {
    return res.redirect(`/s/${share.token}/0`);
  }

  // Build a simple page listing all subscription links
  const baseUrl = config.baseUrl;
  const links = subs.map((sub, i) => {
    const url = `${baseUrl}/s/${share.token}/${i}`;
    return { name: sub.name, url, index: i };
  });

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VPN Subscriptions</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;display:flex;justify-content:center;padding:40px 20px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:600px;width:100%}
  h2{margin-bottom:16px;font-size:1.2rem}
  .sub{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:10px}
  .sub .name{font-weight:600;margin-bottom:6px}
  .sub .url{font-size:0.82rem;color:#58a6ff;word-break:break-all;font-family:monospace}
  .sub .actions{margin-top:8px;display:flex;gap:6px}
  button{padding:6px 14px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e1e4e8;cursor:pointer;font-size:0.82rem}
  button:hover{background:#30363d}
  .btn-blue{background:#1f6feb;border-color:#1f6feb}
  .btn-blue:hover{background:#388bfd}
  .note{font-size:0.8rem;color:#8b949e;margin-top:16px}
  .toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;background:#238636;color:#fff;border-radius:8px;font-size:0.85rem;opacity:0;transition:opacity 0.3s;pointer-events:none}
  .toast.show{opacity:1}
</style>
</head><body>
<div class="card">
  <h2>Subscription Links</h2>
  <p style="font-size:0.85rem;color:#8b949e;margin-bottom:16px">Add each link below as a separate subscription in your VPN client (Clash, Shadowrocket, etc.)</p>
  ${links.map(l => `
  <div class="sub">
    <div class="name">${l.name}</div>
    <div class="url">${l.url}</div>
    <div class="actions">
      <button class="btn-blue" onclick="copy('${l.url}')">Copy Link</button>
      <button onclick="window.open('clash://install-config?url='+encodeURIComponent('${l.url}'))">Open in Clash</button>
    </div>
  </div>`).join('')}
  <div class="note">Each link is a separate subscription. Import them individually so you can see traffic and expiry for each one.</div>
</div>
<div class="toast" id="toast">Copied!</div>
<script>
function copy(url){navigator.clipboard.writeText(url).then(()=>{const t=document.getElementById('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000)})}
</script>
</body></html>`);
});

// /s/:token/:index — proxy to a specific subscription
app.get('/s/:token/:index', async (req, res) => {
  const share = db.getShareByToken(req.params.token);
  const access = checkShareAccess(share, req, res);
  if (!access) return;

  const subs = getShareSubscriptions(share);
  const index = parseInt(req.params.index);

  if (isNaN(index) || index < 0 || index >= subs.length) {
    return res.status(404).send('Subscription index out of range');
  }

  const targetSub = subs[index];

  try {
    let result;
    try {
      result = await fetchSingleSubscription(targetSub);
    } catch (err) {
      console.log(`[share] Sub "${targetSub.name}" failed: ${err.message}, trying failover`);
      result = await fetchSubscriptionFailover(db.getEnabledSubscriptions());
    }

    if (!result) {
      return res.status(502).send('Upstream subscription is currently unavailable');
    }

    db.incrementUseCount(req.params.token);

    res.set('Content-Type', result.contentType);
    if (result.contentDisposition) {
      res.set('Content-Disposition', result.contentDisposition);
    }
    if (result.subscriptionUserinfo) {
      res.set('subscription-userinfo', result.subscriptionUserinfo);
    }
    res.set('profile-update-interval', '24');
    res.send(result.content);

    const action = access.isNewImport ? 'IMPORT' : 'REFRESH';
    console.log(
      `[access] Share "${share.label}" (${share.token.slice(0, 8)}...) sub#${index} "${targetSub.name}" ${action} by ${access.clientIp}. ` +
        `Imports: ${access.importCount}/${share.max_uses || '∞'}`
    );
  } catch (err) {
    console.error('[proxy error]', err);
    res.status(500).send('Internal error');
  }
});

// ---------------------------------------------------------------------------
// Admin API — Shares
// ---------------------------------------------------------------------------
function enrichShare(s) {
  return {
    ...s,
    url: `${config.baseUrl}/s/${s.token}`,
    import_count: db.getShareImportCount(s.token),
    clients: db.getShareClients(s.token),
  };
}

app.post('/api/shares', requireAdmin, (req, res) => {
  const { label, maxUses, subscriptionIds } = req.body;
  const share = db.createShare(label, maxUses, subscriptionIds);
  res.json(enrichShare(share));
});

app.get('/api/shares', requireAdmin, (req, res) => {
  res.json(db.listShares().map(enrichShare));
});

app.get('/api/shares/:token', requireAdmin, (req, res) => {
  const share = db.getShareByToken(req.params.token);
  if (!share) return res.status(404).json({ error: 'Not found' });
  res.json(enrichShare(share));
});

app.patch('/api/shares/:token', requireAdmin, (req, res) => {
  const share = db.getShareByToken(req.params.token);
  if (!share) return res.status(404).json({ error: 'Not found' });
  if (req.body.maxUses !== undefined) {
    db.updateShareMaxUses(req.params.token, req.body.maxUses);
  }
  res.json(db.getShareByToken(req.params.token));
});

app.patch('/api/shares/:token/revoke', requireAdmin, (req, res) => {
  db.revokeShare(req.params.token);
  res.json({ ok: true });
});

app.patch('/api/shares/:token/unrevoke', requireAdmin, (req, res) => {
  db.unrevokeShare(req.params.token);
  res.json({ ok: true });
});

app.delete('/api/shares/:token', requireAdmin, (req, res) => {
  db.deleteShare(req.params.token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin API — Subscriptions CRUD
// ---------------------------------------------------------------------------
app.get('/api/subscriptions', requireAdmin, (req, res) => {
  res.json(db.listSubscriptions());
});

app.post('/api/subscriptions', requireAdmin, (req, res) => {
  const { name, url, priority, is_main } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  const sub = db.addSubscription(name, url, priority, is_main);
  res.json(sub);
});

app.patch('/api/subscriptions/:id', requireAdmin, (req, res) => {
  const sub = db.updateSubscription(parseInt(req.params.id), req.body);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json(sub);
});

app.delete('/api/subscriptions/:id', requireAdmin, (req, res) => {
  db.deleteSubscription(parseInt(req.params.id));
  res.json({ ok: true });
});

// Test a subscription URL and update its info
app.post('/api/subscriptions/:id/test', requireAdmin, async (req, res) => {
  const sub = db.getSubscription(parseInt(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await tryFetchUrl(sub.url, config.requestTimeout);
    linkHealth.set(sub.url, { healthy: true, lastCheck: new Date() });
    // Update subscription info
    const info = parseSubInfo(result.subscriptionUserinfo);
    if (info) {
      db.updateSubscriptionInfo(sub.id, info.upload, info.download, info.total, info.expire);
    }
    res.json({
      ok: true,
      elapsed: result.elapsed,
      contentLength: result.content.length,
      info: info || null,
    });
  } catch (err) {
    linkHealth.set(sub.url, { healthy: false, lastCheck: new Date() });
    res.json({ ok: false, error: err.message });
  }
});

// Refresh info for all subscriptions
app.post('/api/subscriptions/refresh-info', requireAdmin, async (req, res) => {
  const allLinks = db.getEnabledSubscriptions();
  const results = [];
  for (const link of allLinks) {
    try {
      const result = await tryFetchUrl(link.url, config.requestTimeout);
      const info = parseSubInfo(result.subscriptionUserinfo);
      if (info) {
        db.updateSubscriptionInfo(link.id, info.upload, info.download, info.total, info.expire);
      }
      linkHealth.set(link.url, { healthy: true, lastCheck: new Date() });
      results.push({ id: link.id, name: link.name, ok: true, info });
    } catch (err) {
      linkHealth.set(link.url, { healthy: false, lastCheck: new Date() });
      results.push({ id: link.id, name: link.name, ok: false, error: err.message });
    }
  }
  res.json(results);
});

// ---------------------------------------------------------------------------
// Admin API — Health
// ---------------------------------------------------------------------------
app.get('/api/health', requireAdmin, (req, res) => {
  const allLinks = db.getEnabledSubscriptions();
  const status = allLinks.map((link) => {
    const h = linkHealth.get(link.url);
    const dbLatest = db.getLatestHealth().find((r) => r.url === link.url);
    return {
      name: link.name,
      url: link.url,
      healthy: h ? h.healthy : null,
      lastCheck: h ? h.lastCheck : null,
      responseTimeMs: dbLatest ? dbLatest.response_time_ms : null,
    };
  });
  res.json(status);
});

app.get('/api/health/history', requireAdmin, (req, res) => {
  res.json(db.getHealthHistory(100));
});

app.post('/api/health/check', requireAdmin, async (req, res) => {
  await runHealthCheck();
  res.json({ ok: true });
});

// Stats
app.get('/api/stats', requireAdmin, (req, res) => {
  const shares = db.listShares();
  const totalUses = shares.reduce((sum, s) => sum + s.use_count, 0);
  const active = shares.filter(
    (s) => !s.revoked && (!s.max_uses || s.use_count < s.max_uses)
  ).length;

  const allLinks = db.getEnabledSubscriptions();
  const healthStatus = allLinks.map((link) => {
    const h = linkHealth.get(link.url);
    return { name: link.name, healthy: h ? h.healthy : null };
  });

  res.json({
    totalShares: shares.length,
    activeShares: active,
    totalUses,
    linkHealth: healthStatus,
  });
});

// ---------------------------------------------------------------------------
// Health check + info refresh
// ---------------------------------------------------------------------------
async function runHealthCheck() {
  const allLinks = db.getEnabledSubscriptions();

  console.log('[health] Running health check...');
  for (const link of allLinks) {
    try {
      const result = await tryFetchUrl(link.url, config.requestTimeout);
      linkHealth.set(link.url, { healthy: true, lastCheck: new Date() });
      db.logHealth(link.url, link.name, 'ok', result.elapsed);
      // Also update subscription info
      const info = parseSubInfo(result.subscriptionUserinfo);
      if (info) {
        db.updateSubscriptionInfo(link.id, info.upload, info.download, info.total, info.expire);
      }
      console.log(`  ✓ ${link.name} (${result.elapsed}ms)`);
    } catch (err) {
      linkHealth.set(link.url, { healthy: false, lastCheck: new Date() });
      db.logHealth(link.url, link.name, 'fail', null);
      console.log(`  ✗ ${link.name}: ${err.message}`);
    }
  }
}

runHealthCheck();
// Health check every 5 minutes, info refresh piggybacks on health check
setInterval(runHealthCheck, config.healthCheckInterval);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(config.port, () => {
  console.log(`\nVPN Control running on port ${config.port}`);
  console.log(`Admin UI:     ${config.baseUrl}/`);
  console.log(`Share format: ${config.baseUrl}/s/<token>`);
  console.log(`Admin token:  ${config.adminToken}\n`);
});
