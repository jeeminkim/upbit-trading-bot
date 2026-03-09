/**
 * 현재 API 키로 사용 가능한 Gemini 모델 목록 조회
 * 사용: node scripts/list-gemini-models.js  (프로젝트 루트에서 실행, .env 의 GEMINI_API_KEY 사용)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error('GEMINI_API_KEY가 .env에 없습니다.');
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

async function listModels() {
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      console.error('API 오류:', data?.error?.message || res.statusText);
      process.exit(1);
    }
    const models = data.models || [];
    console.log('사용 가능한 모델 (generateContent 등 호출 시 아래 name 중 models/ 제거한 이름 사용):\n');
    models.forEach((m) => {
      const name = (m.name || '').replace(/^models\//, '');
      if (name) console.log('  ', name);
    });
    if (models.length === 0) console.log('  (없음)');
  } catch (e) {
    console.error('요청 실패:', e?.message);
    process.exit(1);
  }
}

listModels();
