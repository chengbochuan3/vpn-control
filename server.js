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

// Properly merge multiple Clash YAML configs
function mergeClashConfigs(results) {
  // Parse all configs
  const configs = results.map((r) => {
    try {
      return yaml.load(r.content);
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (configs.length === 0) return results[0];

  // Use first config as base
  const base = configs[0];
  const baseProxies = base.proxies || [];
  const existingNames = new Set(baseProxies.map((p) => p.name));
  const newProxyNames = [];

  // Merge proxies from all other configs
  for (let i = 1; i < configs.length; i++) {
    const extraProxies = configs[i].proxies || [];
    for (const proxy of extraProxies) {
      if (proxy.name && !existingNames.has(proxy.name)) {
        existingNames.add(proxy.name);
        baseProxies.push(proxy);
        newProxyNames.push(proxy.name);
      }
    }
  }

  base.proxies = baseProxies;

  // Add new proxy names to proxy-groups so they're actually usable
  if (base['proxy-groups'] && newProxyNames.length > 0) {
    for (const group of base['proxy-groups']) {
      if (!group.proxies) continue;
      // Add to groups that use "select" or "url-test" or "fallback" or "load-balance"
      const type = group.type;
      if (['select', 'url-test', 'fallback', 'load-balance'].includes(type)) {
        group.proxies.push(...newProxyNames);
      }
    }
  }

  const merged = yaml.dump(base, {
    lineWidth: -1,     // no line wrapping
    noRefs: true,       // no YAML anchors
    quotingType: '"',
    forceQuotes: false,
  });

  console.log(
    `[merge] Merged ${configs.length} configs: ${baseProxies.length} total proxies (${newProxyNames.length} new)`
  );

  return {
    content: merged,
    contentType: 'text/yaml; charset=utf-8',
  };
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
// Public share endpoint
// ---------------------------------------------------------------------------
app.get('/s/:token', async (req, res) => {
  const share = db.getShareByToken(req.params.token);

  if (!share) return res.status(404).send('Link not found');
  if (share.revoked) return res.status(403).send('This link has been revoked');

  // Determine client IP (supports reverse proxy)
  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress;

  // Check if this is a new import or a refresh from a known client
  const isNewImport = db.recordClientAccess(req.params.token, clientIp);
  const importCount = db.getShareImportCount(req.params.token);

  // Only block NEW imports when limit is reached; refreshes from known clients always pass
  if (isNewImport && share.max_uses && importCount > share.max_uses) {
    return res.status(410).send('This link has expired (import limit reached)');
  }

  try {
    let result;
    const subIds = share.subscription_ids ? JSON.parse(share.subscription_ids) : null;

    if (subIds && subIds.length > 0) {
      const links = db.getSubscriptionsByIds(subIds);
      if (links.length === 0) {
        return res.status(502).send('No enabled subscriptions available for this share');
      }
      if (subIds.length === 1) {
        result = await fetchSingleSubscription(links[0]).catch(async () => {
          console.log(`[share] Selected sub failed, falling back`);
          return fetchSubscriptionFailover(db.getEnabledSubscriptions());
        });
      } else {
        result = await fetchMultipleSubscriptions(links);
      }
    } else {
      const links = db.getEnabledSubscriptions();
      if (links.length === 0) {
        return res.status(502).send('No subscriptions available');
      }
      result = await fetchMultipleSubscriptions(links);
    }

    if (!result) {
      return res
        .status(502)
        .send('All upstream subscription sources are currently unavailable');
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

    const action = isNewImport ? 'IMPORT' : 'REFRESH';
    console.log(
      `[access] Share "${share.label}" (${share.token.slice(0, 8)}...) ${action} by ${clientIp}. ` +
        `Imports: ${importCount}/${share.max_uses || '∞'}. Source: ${result.source}`
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
