/**
 * Upbit API 안정성 검증: independent_scalp.log 및 PM2 로그에서 429/400(insufficient_funds) 발생 여부 확인
 * 사용: node scripts/check-api-errors.js
 * - 429/400 건수 출력. 0이면 Rate Limit·잔고 검증 로직이 정상 동작 중인지 확인용
 */
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'logs', 'independent_scalp.log');
const LINES_TO_READ = 5000;

function countInFile(filePath, patterns) {
  if (!fs.existsSync(filePath)) {
    return { found: false, counts: Object.fromEntries(patterns.map((p) => [p.name, 0])), lines: 0 };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const recent = lines.slice(-LINES_TO_READ);
  const counts = {};
  for (const p of patterns) {
    counts[p.name] = recent.filter((line) => p.regex.test(line)).length;
  }
  return { found: true, counts, lines: recent.length };
}

const patterns = [
  { name: '429_too_many_requests', regex: /429|too_many_requests/i },
  { name: '400_insufficient_funds', regex: /400|insufficient_funds_bid|INSUFFICIENT_FUNDS_BID/i },
  { name: 'rate_limit_retry', regex: /429.*재시도|API 요청 제한으로 재시도/i },
  { name: 'insufficient_skip', regex: /잔액 부족으로 매수 건너뜀|SCALP_SKIP.*insufficient/i }
];

const result = countInFile(LOG_PATH, patterns);

console.log('=== Upbit API 오류 검증 (최근', result.lines, '라인) ===');
console.log('파일:', LOG_PATH, result.found ? '' : '(없음)');
console.log('');
for (const p of patterns) {
  const n = result.counts[p.name] || 0;
  const ok = (p.name.startsWith('429') || p.name.startsWith('400')) ? n === 0 : true;
  console.log(`  ${p.name}: ${n} ${ok ? '' : ' (목표: 429/400 = 0)'}`);
}
console.log('');
if ((result.counts['429_too_many_requests'] || 0) === 0 && (result.counts['400_insufficient_funds'] || 0) === 0) {
  console.log('OK: 429/400 미발생. Rate Limit·잔고 검증 적용 상태로 판단 가능.');
} else {
  console.log('주의: 429 또는 400 발생. 로그 확인 후 upbit.js throttle/재시도 및 주문 전 잔고 검증 동작 확인.');
}
