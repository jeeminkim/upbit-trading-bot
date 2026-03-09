/**
 * PM2 프로세스 상태 표 — 5개 고정 행, online/offline만 사용해 열 너비 통일
 * 사용: node scripts/pm2-status-table.js  또는  npm run pm2:status
 */
const pm2 = require('pm2');

const PROCESS_NAMES = ['api-server', 'upbit-bot', 'MarketSearchEngine', 'discord-operator', 'market-bot'];
const NAME_WIDTH = 22;
const STATUS_WIDTH = 8;

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function printTable(byName) {
  const headerName = pad('name', NAME_WIDTH);
  const headerStatus = pad('status', STATUS_WIDTH);
  console.log('\n' + headerName + ' ' + headerStatus);
  console.log('-'.repeat(NAME_WIDTH) + ' ' + '-'.repeat(STATUS_WIDTH));
  PROCESS_NAMES.forEach((name) => {
    const status = (byName[name] === 'online') ? 'online' : 'offline';
    console.log(pad(name, NAME_WIDTH) + ' ' + pad(status, STATUS_WIDTH));
  });
  console.log('');
}

pm2.connect((err) => {
  if (err) {
    const empty = {};
    PROCESS_NAMES.forEach((n) => { empty[n] = 'offline'; });
    printTable(empty);
    process.exit(0);
    return;
  }
  pm2.list((err, list) => {
    pm2.disconnect();
    const byName = {};
    PROCESS_NAMES.forEach((n) => { byName[n] = 'offline'; });
    if (!err && Array.isArray(list)) {
      list.forEach((p) => {
        const name = p.name || (p.pm2_env && p.pm2_env.name);
        if (name && PROCESS_NAMES.includes(name))
          byName[name] = (p.pm2_env && p.pm2_env.status === 'online') ? 'online' : 'offline';
      });
    }
    printTable(byName);
  });
});
