/**
 * PM2 — 리팩터 구조 (api-server + discord-operator + market-bot)
 * api-server: HTTP + Socket.IO + health 전용. engine은 proxy로 market-bot에 위임.
 * market-bot: engine lock + server.js + trading 루프 + HTTP API (port 3001).
 * discord-operator: Discord A/B/C 패널 + 재기동 메시지 + Slash commands.
 * 빌드: npm run build:refactor
 * 실행: npm run pm2:refactor
 *
 * .env: 이 파일 로드 시점에 dotenv로 먼저 읽어서 PM2 자식 프로세스에 전달합니다.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const root = path.resolve(__dirname);
const dist = path.join(root, 'dist-refactor');
[path.join(root, 'logs'), path.join(root, 'data')].forEach((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
});

const common = {
  cwd: root,
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  watch: false,
  autorestart: true,
  max_restarts: 15,
  restart_delay: 5000,
  exp_backoff_restart_delay: 100,
  max_memory_restart: '500M',
  env: { ...process.env, NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      name: 'api-server',
      script: path.join(root, 'scripts', 'run-api-server.js'),
      ...common,
      max_memory_restart: '800M',
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      node_args: '--max-old-space-size=768',
      error_file: path.join(root, 'logs', 'pm2-api-server-error.log'),
      out_file: path.join(root, 'logs', 'pm2-api-server-out.log'),
      merge_logs: true,
    },
    {
      name: 'discord-operator',
      script: path.join(dist, 'apps', 'discord-operator', 'src', 'index.js'),
      ...common,
      max_memory_restart: '300M',
      error_file: path.join(root, 'logs', 'pm2-discord-operator-error.log'),
      out_file: path.join(root, 'logs', 'pm2-discord-operator-out.log'),
      merge_logs: true,
    },
    {
      name: 'market-bot',
      script: path.join(root, 'scripts', 'engine-standalone.js'),
      ...common,
      max_memory_restart: '600M',
      error_file: path.join(root, 'logs', 'pm2-market-bot-error.log'),
      out_file: path.join(root, 'logs', 'pm2-market-bot-out.log'),
      merge_logs: true,
    },
  ],
};
