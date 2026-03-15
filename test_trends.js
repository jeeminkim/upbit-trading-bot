/**
 * 구글 트렌드 응답 파싱 안전성 테스트 (HTML vs JSON)
 * 실행: node test_trends.js
 */

const fs = require('fs');

function isLikelyHtml(str) {
  if (typeof str !== 'string') return false;
  const t = str.trimStart().toLowerCase();
  return t.startsWith('<html') || t.startsWith('<!doctype') || t.startsWith('<!');
}

function testParsing(mockData) {
  try {
    if (typeof mockData === 'string' && isLikelyHtml(mockData)) {
      console.log('✅ HTML 감지: 파싱을 중단하고 로그를 남깁니다. (안전)');
      return { safe: true, reason: 'html_detected' };
    }
    if (typeof mockData === 'string' && (mockData.trimStart().startsWith('{') || mockData.trimStart().startsWith('['))) {
      JSON.parse(mockData);
      console.log('✅ 정상 JSON: 데이터를 처리합니다.');
      return { safe: true, reason: 'json_ok' };
    }
    JSON.parse(mockData);
    console.log('✅ 파싱 성공');
    return { safe: true, reason: 'parsed' };
  } catch (e) {
    console.log('❌ 크래시 발생: 로직 수정이 필요합니다.', e.message);
    return { safe: false, error: e.message };
  }
}

// HTML 응답 시뮬레이션 테스트
console.log('--- HTML 응답 시뮬레이션 ---');
testParsing('<html lang="en">...</html>');

console.log('\n--- 429 Too Many Requests HTML 시뮬레이션 (<!DOCTYPE) ---');
testParsing('<!DOCTYPE html><html><body>Too Many Requests</body></html>');

console.log('\n--- 정상 JSON 시뮬레이션 ---');
testParsing(JSON.stringify({ default: { timelineData: [] } }));

console.log('\n--- 테스트 완료 ---');
