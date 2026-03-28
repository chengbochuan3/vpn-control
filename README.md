# VPN Subscription Link Manager

A self-hosted tool for managing and sharing VPN subscription links with fine-grained access control. Generate one-time-use (or limited-use) proxy links that you can revoke at any time — the recipient never sees your real subscription URL.

## Features

- **Controlled Sharing** — Generate proxy links with usage limits (one-time, N-times, or unlimited). Recipients never see your real subscription URLs.
- **Instant Revoke** — Disable any shared link with one click. Re-enable it anytime.
- **Multi-Subscription Merge** — Import multiple subscription sources. When generating a share link, choose to include all or specific subscriptions — nodes from all selected sources are merged into a single response.
- **Auto Failover** — If the primary subscription link goes down, automatically falls through to backup links. Recovers to the primary once it's back.
- **Traffic & Expiry Monitoring** — Displays remaining traffic, usage percentage, and expiration date for each subscription (parsed from `subscription-userinfo` header). Auto-refreshes every 30 minutes.
- **Health Checks** — Periodically tests all upstream links (every 5 minutes) with latency tracking and historical logs.
- **Admin Dashboard** — Dark-themed web UI for managing everything: subscriptions, shares, health status, and usage stats.
- **Subscription CRUD** — Add, edit, delete, enable/disable subscription links at any time through the admin panel.

## How It Works

```
Recipient → Your Server (/s/<token>) → Real Subscription URL(s)
                  ↑
          Access control here
          (valid? used up? revoked?)
```

Your server acts as a reverse proxy. It holds the real subscription links, issues disposable tokens, and can close access at any time. Recipients only interact with your server — they never learn the upstream URLs.

## Quick Start

### Prerequisites

- Node.js 18+ (tested with Node 20)
- npm

### Install & Run

```bash
git clone https://github.com/YOUR_USERNAME/vpn-control.git
cd vpn-control
npm install
npm start
```

The server starts at `http://localhost:3000`. Open it in your browser to access the admin panel.

### Configuration

Edit `config.js` or use environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ADMIN_TOKEN` | `change-me-in-production` | Admin API bearer token |
| `BASE_URL` | `http://localhost:3000` | Public URL for generated share links |

**Important:** Change `ADMIN_TOKEN` before deploying!

```bash
ADMIN_TOKEN=my-secret-token BASE_URL=https://yourdomain.com npm start
```

### Add Your Subscription Links

On first run, default example links are seeded. Replace them in the admin panel:

1. Open `http://localhost:3000` and log in with your admin token
2. In the **Subscription Links** section, delete the example links
3. Click **+ Add Link** to add your real subscription URLs
4. Set one as **Main** (highest priority for failover)

### Create a Share Link

1. In the **Create Share Link** section, enter a label (e.g., `friend-phone`)
2. Set **Max Uses** (1 for one-time, 0 for unlimited)
3. Choose **All subscriptions** or **Select specific** ones to include
4. Click **Create** and copy the generated URL
5. Send the URL to the recipient — they add it as a subscription in their VPN client

### Manage Access

- **Revoke** — Instantly blocks a shared link (recipient gets 403 on next update)
- **Enable** — Re-activates a revoked link
- **Delete** — Permanently removes a shared link

## Deployment

### Using PM2 (recommended)

```bash
npm install -g pm2

# Create ecosystem.config.js
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'vpn-control',
    script: 'server.js',
    env: {
      ADMIN_TOKEN: 'your-secure-token',
      BASE_URL: 'https://yourdomain.com/vpn',
      NODE_ENV: 'production'
    }
  }]
};
EOF

pm2 start ecosystem.config.js
pm2 save
pm2 startup  # auto-start on reboot
```

### Behind Nginx (reverse proxy)

```nginx
location /vpn/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /s/ {
    proxy_pass http://127.0.0.1:3000/s/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Tech Stack

- **Node.js** + **Express** — HTTP server
- **better-sqlite3** — Embedded database (zero config, no external DB needed)
- **Vanilla JS** — Admin UI (no build step, no framework)

## Project Structure

```
vpn-control/
├── server.js        # Express app, routes, failover & merge logic
├── database.js      # SQLite schema and query helpers
├── config.js        # Server settings and default subscriptions
├── public/
│   └── index.html   # Admin dashboard (single-page app)
├── data/            # SQLite database (auto-created, gitignored)
└── package.json
```

## License

MIT
