/**
 * PM2 — 리팩터 구조 (api-server + discord-operator + market-bot)
 * api-server: Express + Socket.IO + trading-engine 루프 (동일 프로세스)
 * Windows 지원: script는 .js, cwd=프로젝트 루트, node로 실행
 * 빌드: npm run build:refactor
 * 실행: npm run pm2:refactor
 * 로그/데이터: logs/ 및 data/ 폴더가 없으면 생성해 두세요. (audit.db는 data/에 생성됨)
 */
const path = require('path');
const fs = require('fs');
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
  max_restarts: 10,
  restart_delay: 3000,
  max_memory_restart: '500M',
  env: { NODE_ENV: 'production' },
  error_file: path.join(root, 'logs', 'pm2-%name%-error.log'),
  out_file: path.join(root, 'logs', 'pm2-%name%-out.log'),
  merge_logs: false,
};

module.exports = {
  apps: [
    {
      name: 'api-server',
      script: path.join(dist, 'apps', 'api-server', 'src', 'index.js'),
      ...common,
      max_memory_restart: '600M',
    },
    {
      name: 'discord-operator',
      script: path.join(dist, 'apps', 'discord-operator', 'src', 'index.js'),
      ...common,
      max_memory_restart: '300M',
    },
    {
      name: 'market-bot',
      script: path.join(dist, 'apps', 'market-bot', 'src', 'index.js'),
      ...common,
      max_memory_restart: '300M',
    },
  ],
};
