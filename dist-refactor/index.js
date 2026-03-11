"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Root bundle: API server only (no trading-engine).
 * For refactor/PM2: run apps separately —
 *   api-server: dist-refactor/apps/api-server/src/index.js
 *   market-bot: scripts/engine-standalone.js
 *   discord-operator: dist-refactor/apps/discord-operator/src/index.js
 * Do NOT import trading-engine here so api-server stays engine-free when this file is used.
 */
require("./apps/api-server/src/index");
// import { startDiscordOperator } from './apps/discord-operator/src/index';
// startDiscordOperator();
