"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
require('dotenv').config({ path: path_1.default.join(process.cwd(), '.env') });
const discord_js_1 = require("discord.js");
const Intents = require('discord.js').Intents;
const token = process.env.MARKET_BOT_TOKEN || process.env.MARKET_SEARCH_ENGINE_TOKEN || '';
const dashboardUrl = (process.env.DASHBOARD_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const client = new discord_js_1.Client({ intents: [Intents?.FLAGS?.GUILDS ?? 1] });
function pathForButton(customId) {
    if (customId === 'analyst_scan_vol')
        return 'scan-vol';
    if (customId === 'analyst_get_prompt')
        return 'summary';
    if (customId === 'analyst_indicators')
        return 'indicators';
    return customId;
}
function formatResponse(data, pathSegment) {
    if (!data?.ok && data?.error)
        return `오류: ${data.message || data.error}`;
    const d = data?.data;
    if (pathSegment === 'indicators' && d) {
        const lines = [
            `FNG: ${d.fng ? `${d.fng.value} (${d.fng.classification})` : '—'}`,
            `BTC: ${d.btcTrend || '—'}`,
            `김프 평균: ${d.kimpAvg != null ? d.kimpAvg.toFixed(2) + '%' : '—'}`,
            `상위: ${d.topTickersText || '—'}`,
        ];
        return lines.join('\n');
    }
    if (d?.text)
        return d.text;
    return d?.message ?? JSON.stringify(data);
}
async function handleButton(interaction) {
    const customId = interaction.customId;
    if (!customId.startsWith('analyst_'))
        return;
    // 3초 내 ACK: 버튼 클릭 즉시 deferReply (ephemeral → 버튼 패널 유지)
    await interaction.deferReply({ ephemeral: true });
    try {
        const pathSegment = pathForButton(customId);
        const url = `${dashboardUrl}/api/analyst/${pathSegment}`;
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        const text = formatResponse(data, pathSegment);
        await interaction.editReply({ content: text.slice(0, 1900) });
    }
    catch (e) {
        await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
    }
}
client.once('ready', () => {
    console.log('[market-bot] 서비스 가동 완료');
});
client.removeAllListeners('interactionCreate');
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        await handleButton(interaction);
    }
});
if (token)
    client.login(token).catch((e) => console.error('[market-bot] login', e));
else
    console.warn('[market-bot] MARKET_BOT_TOKEN missing');
