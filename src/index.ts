/**
 * Single process: API server + trading engine loop + Discord operator (optional).
 * EventBus is in-memory so all run in one process; for multi-process use Redis later.
 */
import './apps/api-server/src/index';
import './apps/trading-engine/src/index';
// import { startDiscordOperator } from './apps/discord-operator/src/index';
// startDiscordOperator();
