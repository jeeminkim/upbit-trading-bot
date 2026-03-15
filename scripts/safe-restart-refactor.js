/**
 * 안전 재기동: stop → pm2 kill → 10초 대기 → 빌드 → start
 * 포트/프로세스 정리 후 재기동하여 restart storm 방지.
 * 사용: node scripts/safe-restart-refactor.js (dashboard 폴더에서)
 */
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function run(cmd, opts = {}) {
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('[safe-restart] 1/5 Stopping refactor apps...');
  run('node scripts/pm2-delete-if-exists.js delete api-server discord-operator market-bot');

  console.log('[safe-restart] 2/5 pm2 kill...');
  try {
    run('pm2 kill');
  } catch (e) {
    // No process found 등 무시
  }

  console.log('[safe-restart] 3/5 Waiting 10s for port release...');
  await sleep(10000);

  console.log('[safe-restart] 4/5 Build...');
  run('npm run build:refactor');

  console.log('[safe-restart] 5/5 PM2 start...');
  run('pm2 start ecosystem.refactor.config.cjs');

  console.log('[safe-restart] Done. Check: pm2 list');
}

main().catch((e) => {
  console.error('[safe-restart]', e.message);
  process.exit(1);
});
