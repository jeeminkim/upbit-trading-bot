/**
 * API server only — no trading-engine, no server.js.
 * Used by PM2 refactor so api-server never loads engine or .server.lock.
 */
const path = require('path');
const root = path.resolve(__dirname, '..');
console.log('[run-api-server] entry (no server.js, no .server.lock)');
const apiServerPath = path.join(root, 'dist-refactor', 'apps', 'api-server', 'src', 'index.js');
require(apiServerPath);
