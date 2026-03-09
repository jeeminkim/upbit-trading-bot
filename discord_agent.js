/**
 * 레거시 진입점 — server.js만 실행합니다.
 *
 * ⚠️ 포트 3000은 server.js 하나만 사용합니다.
 *    node server.js 와 node discord_agent.js 를 동시에 실행하면 안 됩니다.
 *
 * 권장: node server.js (또는 npm start) 한 번만 실행하면
 *       웹 대시보드 + Scalp 엔진 + 디스코드 봇이 함께 구동됩니다.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log('[Check] ADMIN_ID loaded:', process.env.ADMIN_ID ? 'Yes' : 'No');
require('./server');
