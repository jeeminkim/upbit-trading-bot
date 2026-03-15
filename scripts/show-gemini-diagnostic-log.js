const fs = require('fs');
const path = require('path');
const logFile = path.join(process.cwd(), 'logs', 'gemini-error-diagnostic.log');
if (fs.existsSync(logFile)) {
  console.log(fs.readFileSync(logFile, 'utf8'));
} else {
  console.log('(아직 gemini-error-diagnostic.log 없음. Gemini 에러 발생 시 자동 생성됨)');
}
