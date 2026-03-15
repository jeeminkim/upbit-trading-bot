/**
 * .env가 dashboard 경로에서 정상 로드되는지 검증
 * 사용: node scripts/verify-env.js  (dashboard에서 실행)
 * 또는: node scripts/verify-env.js --path "C:\Users\kingj\OneDrive\문서\upbit-price-alert\dashboard"
 */
const path = require('path');
const fs = require('fs');

const dashboardPath = process.argv.includes('--path') && process.argv[process.argv.indexOf('--path') + 1]
  ? process.argv[process.argv.indexOf('--path') + 1]
  : path.resolve(__dirname, '..');

const envPath = path.join(dashboardPath, '.env');

function main() {
  console.log('[verify-env] Dashboard path:', dashboardPath);
  console.log('[verify-env] .env path:', envPath);
  console.log('[verify-env] process.cwd():', process.cwd());
  console.log('');

  const exists = fs.existsSync(envPath);
  console.log('[verify-env] .env file exists:', exists);
  if (!exists) {
    console.error('[verify-env] FAIL: .env not found. Run from dashboard or pass --path "C:\\...\\dashboard"');
    process.exit(1);
  }

  require('dotenv').config({ path: envPath });

  const keys = [
    'UPBIT_ACCESS_KEY',
    'UPBIT_SECRET_KEY',
    'DISCORD_TOKEN',
    'CHANNEL_ID',
    'ADMIN_ID',
    'ADMIN_DISCORD_ID',
    'PORT',
    'MARKET_BOT_URL',
    'ENGINE_PORT',
    'GEMINI_API_KEY',
  ];

  const results = [];
  for (const key of keys) {
    const raw = process.env[key];
    const set = raw !== undefined && String(raw).trim() !== '';
    const display = set ? `(length ${String(raw).length})` : '(empty/missing)';
    results.push({ key, set, display });
  }

  console.log('[verify-env] Key check (values not printed):');
  results.forEach(({ key, set, display }) => {
    const status = set ? 'OK' : '—';
    console.log(`  ${status} ${key} ${display}`);
  });

  const critical = ['UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY', 'DISCORD_TOKEN', 'CHANNEL_ID'];
  const missing = critical.filter((k) => !results.find((r) => r.key === k && r.set));
  if (missing.length) {
    console.log('');
    console.warn('[verify-env] WARN: critical keys missing or empty:', missing.join(', '));
  } else {
    console.log('');
    console.log('[verify-env] OK: .env is readable from dashboard path.');
  }
}

main();
