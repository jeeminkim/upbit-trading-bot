/**
 * PM2 설정 — 기본 2개 앱만 등록 (upbit-bot + MarketSearchEngine)
 *
 * ⚠️ 이 파일은 의도적으로 2개만 등록합니다.
 * - upbit-bot: server.js (대시보드 + 매매 엔진 + 디스코드 봇 통합)
 * - MarketSearchEngine: market_search.js
 *
 * 재기동: autorestart: true 이므로 process.exit(0) 시 PM2가 자동 재시작합니다.
 * npm run restart:all (= pm2 restart ecosystem.config.cjs) 와 동일하게
 * 새 프로세스에서 fetchAssets → 자산 조회·매매 루프가 처음부터 시작됩니다.
 *
 * 4개 앱(upbit-bot, MarketSearchEngine, discord-operator, market-bot)을 쓰려면:
 *   npm run pm2:main         — 빌드 후 4개 시작
 *   npm run pm2:main:restart — 4개 재기동
 * (discord-operator, market-bot은 dist-refactor 빌드 필요)
 *
 * 사용법 (2개만):
 *   pm2 start ecosystem.config.cjs   또는 npm run start:all
 *   pm2 restart ecosystem.config.cjs 또는 npm run restart:all
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
      exp_backoff_restart_delay: 10000, // 크래시 시 10초 이상 지연 재시작 (즉시 재시작 방지)
      env: { NODE_ENV: 'production' },
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
      exp_backoff_restart_delay: 10000, // 크래시 시 10초 이상 지연 재시작
      env: { NODE_ENV: 'production' },
      error_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-error.log'),
      out_file: path.join(root, 'logs', 'pm2-MarketSearchEngine-out.log'),
    },
  ],
};
