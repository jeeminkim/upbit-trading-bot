/**
 * PM2 명령 실행 후 항상 성공 종료 (Windows에서 || true 대체)
 * 사용: node scripts/pm2-delete-if-exists.js delete api-server
 *       node scripts/pm2-delete-if-exists.js stop upbit-bot MarketSearchEngine
 */
const { execSync } = require('child_process');
const args = process.argv.slice(2).filter(Boolean);
const verb = args[0];
const names = args.slice(1);
if (!verb || names.length === 0) process.exit(0);
try {
  execSync('pm2 ' + verb + ' ' + names.join(' '), { stdio: 'ignore', windowsHide: true });
} catch (_) {}
process.exit(0);
