module.exports = {
  port: process.env.PORT || 3000,
  adminToken: process.env.ADMIN_TOKEN || 'change-me-in-production',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  healthCheckInterval: 5 * 60 * 1000,
  requestTimeout: 10000,
  retryTimeout: 3000,
  // Default subscriptions — seeded into DB on first run only.
  // Replace with your own subscription links.
  defaultSubscriptions: [
    {
      name: 'Main',
      url: 'https://example.com/subscribe?token=your-token-here',
      priority: 0,
      is_main: 1,
    },
    {
      name: 'Backup 1',
      url: 'https://example.com/backup1?token=your-token-here',
      priority: 1,
      is_main: 0,
    },
  ],
};
