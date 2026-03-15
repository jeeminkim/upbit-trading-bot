/**
 * PM2 설정 — upbit-bot + MarketSearchEngine, upbit-bot만 USE_SIGNAL_ENGINE=1 로 기동
 *
 * 사용법:
 *   npm run pm2:start:engine   — 둘 다 띄우기 (엔진 ON)
 *   npm run pm2:restart:engine  — 둘 다 재기동 (엔진 ON)
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname);
[path.join(root, 'logs'), path.join(root, 'data')].forEach((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
});

module.exports = {
  apps: [
    {
      name: 'upbit-bot',
      script: 'server.js',
      cwd: root,
      instances: 1,
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 3000,
      exp_backoff_restart_delay: 10000,
      env: { NODE_ENV: 'production', USE_SIGNAL_ENGINE: '1' },
      error_file: path.join(root, 'logs', 'pm2-upbit-bot-error.log'),
      out_file: path.join(root, 'logs', 'pm2-upbit-bot-out.log'),
    },
    {
      name: 'MarketSearchEngine',
      script: 'market_search.js',
      cwd: root,
      instances: 1,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 10000,
      env: { NODE_ENV: 'production' },
      error_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-error.log'),
      out_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-out.log'),
    },
  ],
};
