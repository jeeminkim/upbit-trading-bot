/**
 * PM2 — upbit-bot 메인 사용 시 (api-server 미사용)
 *
 * 등록 앱 4개: upbit-bot, MarketSearchEngine, discord-operator, market-bot
 * (PM2에 보이는 5개 중 api-server는 제외 — upbit-bot과 역할 중복)
 *
 * 사용법:
 *   npm run pm2:main         — 빌드 후 4개 한 번에 시작
 *   npm run pm2:main:restart — 빌드 후 4개 한 번에 재기동
 *   npm run pm2:main:stop    — 4개 모두 삭제
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname);
const dist = path.join(root, 'dist-refactor');
[path.join(root, 'logs'), path.join(root, 'data')].forEach((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
});

const commonRefactor = {
  cwd: root,
  interpreter: 'node',
  instances: 1,
  watch: false,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      name: 'upbit-bot',
      script: 'server.js',
      cwd: root,
      ...commonRefactor,
      max_memory_restart: '500M',
      error_file: path.join(root, 'logs', 'pm2-upbit-bot-error.log'),
      out_file: path.join(root, 'logs', 'pm2-upbit-bot-out.log'),
    },
    {
      name: 'MarketSearchEngine',
      script: 'market_search.js',
      cwd: root,
      ...commonRefactor,
      max_memory_restart: '300M',
      error_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-error.log'),
      out_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-out.log'),
    },
    {
      name: 'discord-operator',
      script: path.join(dist, 'apps', 'discord-operator', 'src', 'index.js'),
      ...commonRefactor,
      max_memory_restart: '300M',
      error_file: path.join(root, 'logs', 'pm2-discord-operator-error.log'),
      out_file: path.join(root, 'logs', 'pm2-discord-operator-out.log'),
    },
    {
      name: 'market-bot',
      script: path.join(dist, 'apps', 'market-bot', 'src', 'index.js'),
      ...commonRefactor,
      max_memory_restart: '300M',
      error_file: path.join(root, 'logs', 'pm2-market-bot-error.log'),
      out_file: path.join(root, 'logs', 'pm2-market-bot-out.log'),
    },
  ],
};
