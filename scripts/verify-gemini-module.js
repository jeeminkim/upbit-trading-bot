/**
 * 대시보드 폴더에서 실행: node scripts/verify-gemini-module.js
 * → 실제 로드되는 lib/gemini 경로와 모델명 확인
 */
const path = require('path');
const libPath = path.join(__dirname, '..', 'lib', 'gemini.js');
const resolved = require.resolve(libPath);
console.log('로드된 gemini 모듈 절대경로:', resolved);
const gemini = require(libPath);
console.log('getModelName():', typeof gemini.getModelName === 'function' ? gemini.getModelName() : 'N/A');
console.log('(위 경로가 현재 대시보드의 lib/gemini.js 여야 합니다)');
