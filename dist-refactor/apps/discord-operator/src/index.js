"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDiscordOperator = startDiscordOperator;
exports.getClient = getClient;
const path_1 = __importDefault(require("path"));
require('dotenv').config({ path: path_1.default.join(process.cwd(), '.env') });
const discord_js_1 = require("discord.js");
const discord = require('discord.js');
const Intents = discord.Intents;
const PermissionService_1 = require("../../../packages/core/src/PermissionService");
const AuditLogService_1 = require("../../../packages/core/src/AuditLogService");
const ConfirmFlow_1 = require("../../../packages/core/src/ConfirmFlow");
const LogUtil_1 = require("../../../packages/core/src/LogUtil");
const errors_1 = require("../../../packages/shared/src/errors");
const LOG_TAG = 'DISCORD_OP';
/** PANEL_RESTORE 진단 로그 — LOG_LEVEL 무관하게 항상 출력 (logWarn 사용) */
function panelRestoreWarn(tag, detail) {
    LogUtil_1.LogUtil.logWarn(LOG_TAG, `[PANEL_RESTORE][${tag}] ${JSON.stringify(detail)}`);
}
/** PANEL_RESTORE 실패 로그 — error + stack 일부 */
function panelRestoreFail(tag, err, extra) {
    const e = err;
    const stack = e?.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : '';
    LogUtil_1.LogUtil.logError(LOG_TAG, `[PANEL_RESTORE][${tag}] ${e?.message ?? String(err)}`, { ...extra, stack });
}
// ===== DISCORD OPERATOR BOOT DIAGNOSTIC (timestamp 항상 포함) =====
LogUtil_1.LogUtil.logInfo(LOG_TAG, 'process start', { cwd: process.cwd(), pid: process.pid, node: process.version });
process.on('uncaughtException', (err) => {
    LogUtil_1.LogUtil.logError(LOG_TAG, 'uncaughtException', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (err) => {
    LogUtil_1.LogUtil.logError(LOG_TAG, 'unhandledRejection', { message: String(err) });
});
if (LogUtil_1.LogUtil.isDebugLog()) {
    LogUtil_1.LogUtil.logDebug(LOG_TAG, 'DISCORD_TOKEN exists: ' + !!(process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN));
    LogUtil_1.LogUtil.logDebug(LOG_TAG, 'CHANNEL_ID exists: ' + !!(process.env.DISCORD_OPERATOR_CHANNEL_ID || process.env.CHANNEL_ID));
    LogUtil_1.LogUtil.logDebug(LOG_TAG, 'ADMIN_ID exists: ' + !!(process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID));
}
// 필수: 토큰과 채널 ID만 검증 (DISCORD_OPERATOR_CHANNEL_ID 또는 CHANNEL_ID)
const token = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();
const channelId = (process.env.DISCORD_OPERATOR_CHANNEL_ID || process.env.CHANNEL_ID || '').trim();
if (!token) {
    LogUtil_1.LogUtil.logError(LOG_TAG, 'Missing required env: DISCORD_TOKEN or DISCORD_BOT_TOKEN');
    process.exit(1);
}
if (!channelId) {
    LogUtil_1.LogUtil.logError(LOG_TAG, 'Missing required env: DISCORD_OPERATOR_CHANNEL_ID or CHANNEL_ID');
    process.exit(1);
}
if (!process.env.DISCORD_CLIENT_ID?.trim() || !process.env.DISCORD_GUILD_ID?.trim()) {
    if (process.env.DISCORD_OPERATOR_DEBUG === '1')
        LogUtil_1.LogUtil.logDebug(LOG_TAG, 'DISCORD_CLIENT_ID/GUILD_ID 미설정 — 전역 슬래시 명령 등록');
}
const adminId = (process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID || '').trim();
const DASHBOARD_URL = (process.env.DASHBOARD_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
LogUtil_1.LogUtil.logInfo(LOG_TAG, 'creating client');
const client = new discord_js_1.Client({ intents: [Intents?.FLAGS?.GUILDS ?? 1] });
client.on('error', (err) => {
    LogUtil_1.LogUtil.logError(LOG_TAG, 'client error', { message: (err && err.message) || String(err) });
});
let startupMessageSent = false;
async function api(path, opts) {
    const url = `${DASHBOARD_URL}${path.startsWith('/') ? path : '/' + path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (opts?.userId)
        headers['x-user-id'] = opts.userId;
    const res = await fetch(url, {
        method: opts?.method || 'GET',
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok)
        throw new Error(await res.text().catch(() => res.statusText));
    return res.json();
}
function buildStatusEmbedFromApi(data) {
    const assets = data.assets;
    const summary = data.profitSummary;
    const totalEval = summary?.totalEval ?? assets?.totalEvaluationKrw ?? 0;
    const orderableKrw = (summary?.krw ?? summary?.orderableKrw ?? assets?.orderableKrw ?? 0);
    const profitPctNum = summary?.profitPct ?? 0;
    const profitPct = (profitPctNum >= 0 ? '🟢 ' : '🔴 ') + (profitPctNum >= 0 ? '+' : '') + profitPctNum.toFixed(2) + '%';
    const strategyName = data.strategySummary?.strategyName || 'SCALP 기본';
    const w = data.strategySummary?.weights || {};
    const weightTable = [
        '| 항목 | 값 |',
        '|------|-----|',
        `| 돌파(price_break) | ${w.weight_price_break ?? '—'} |`,
        `| Vol(vol_surge) | ${w.weight_vol_surge ?? '—'} |`,
        `| OBI | ${w.weight_obi ?? '—'} |`,
        `| Strength | ${w.weight_strength ?? '—'} |`,
        `| 스프레드 | ${w.weight_spread ?? '—'} |`,
        `| Depth | ${w.weight_depth ?? '—'} |`,
        `| Kimp | ${w.weight_kimp ?? '—'} |`,
    ].join('\n');
    return new discord_js_1.MessageEmbed()
        .setTitle('📊 현재 상태')
        .setColor(0x5865f2)
        .addFields({ name: '총 평가금액(현재 총자산)', value: Number(totalEval).toLocaleString('ko-KR') + ' 원', inline: true }, { name: 'KRW 잔고', value: Number(orderableKrw).toLocaleString('ko-KR') + ' 원', inline: true }, { name: '총 손익률', value: profitPct, inline: true }, { name: '가동 전략', value: strategyName, inline: false }, { name: 'RaceHorse(예약) 가중치', value: '```\n' + weightTable + '\n```', inline: false })
        .setFooter({ text: 'ProfitCalculationService.getSummary() 단일 소스' })
        .setTimestamp();
}
function buildPnlEmbedFromApi(data) {
    const summary = data.profitSummary;
    const totalKrw = (summary?.krw ?? summary?.orderableKrw ?? data.assets?.orderableKrw ?? 0);
    const totalEval = summary?.totalEval ?? data.assets?.totalEvaluationKrw ?? 0;
    const totalBuyKrw = summary?.totalBuy ?? data.assets?.totalBuyKrwForCoins ?? data.assets?.totalBuyKrw ?? 0;
    const profitPctNum = summary?.profitPct ?? 0;
    const pctStr = profitPctNum.toFixed(2) + '%';
    const profitKrw = totalEval - (totalBuyKrw + totalKrw);
    const isProfit = profitKrw >= 0;
    const arrow = isProfit ? '▲' : '▼';
    const emoji = isProfit ? '🟢' : '🔴';
    const profitLine = totalBuyKrw + totalKrw > 0
        ? `${emoji} **현재 손익**: ${isProfit ? '+' : ''}${Number(profitKrw).toLocaleString('ko-KR')}원 (${arrow} ${pctStr})`
        : '🟢 **현재 손익**: 0원 (수익률 0.00%)';
    const summaryLine = totalBuyKrw + totalKrw > 0
        ? `총 매수: ${Number(totalBuyKrw).toLocaleString('ko-KR')}원 / 현재 총자산: ${Number(totalEval).toLocaleString('ko-KR')}원`
        : '—';
    return new discord_js_1.MessageEmbed()
        .setTitle(isProfit ? '🟢 현재 수익률' : '🔴 현재 수익률')
        .setColor(isProfit ? 0x57f287 : 0xed4245)
        .addFields({ name: '보유 KRW', value: Number(totalKrw).toLocaleString('ko-KR') + ' 원', inline: true }, { name: '현재 총자산', value: Number(totalEval).toLocaleString('ko-KR') + ' 원', inline: true }, { name: '총 매수금액', value: Number(totalBuyKrw).toLocaleString('ko-KR') + ' 원', inline: true }, { name: '평가 손익', value: profitLine + '\n' + summaryLine, inline: false })
        .setFooter({ text: 'ProfitCalculationService.getSummary() 단일 소스' })
        .setTimestamp();
}
function buildHealthEmbedFromApi(report) {
    return new discord_js_1.MessageEmbed()
        .setTitle('🩺 헬스체크')
        .setColor(0x57f287)
        .addFields({ name: '프로세스', value: report.process || '—', inline: true }, { name: '업타임(초)', value: String(report.uptimeSec ?? 0), inline: true }, { name: '마지막 주문', value: report.lastOrderAt || '—', inline: true }, { name: '1시간 오류', value: String(report.errorsLast1h ?? 0), inline: true }, { name: 'Upbit 인증', value: report.upbitAuthOk ? 'OK' : 'NG', inline: true }, { name: 'Circuit Upbit', value: report.circuitUpbit || '—', inline: true }, { name: 'Circuit Gemini', value: report.circuitGemini || '—', inline: true }, { name: '마지막 emit', value: report.lastEmitAt || '—', inline: false })
        .setFooter({ text: report.reportedAt || '' })
        .setTimestamp();
}
async function registerSlashCommands(client) {
    const commands = [
        {
            name: 'engine',
            description: '엔진 제어',
            options: [
                { type: 1, name: 'start', description: '매매 엔진 가동' },
                { type: 1, name: 'stop', description: '매매 엔진 정지 (2단계 확인)' },
                { type: 1, name: 'status', description: '엔진 상태 조회' },
            ],
        },
        {
            name: 'sell',
            description: '전체 매도 (2단계 확인)',
            options: [{ type: 1, name: 'all', description: '전량 시장가 매도' }],
        },
        { name: 'status', description: '현재 상태' },
        { name: 'pnl', description: '수익률' },
        { name: 'health', description: '헬스체크' },
        {
            name: 'strategy-mode',
            description: '전략 모드 전환 (진입 threshold)',
            options: [
                {
                    type: 3,
                    name: 'mode',
                    description: 'SAFE(0.62) / A_CONSERVATIVE(0.45) / A_BALANCED(0.38) / A_ACTIVE(0.35)',
                    required: true,
                    choices: [
                        { name: 'SAFE (0.62)', value: 'SAFE' },
                        { name: 'A-보수적 (0.45)', value: 'A_CONSERVATIVE' },
                        { name: 'A-균형형 (0.38)', value: 'A_BALANCED' },
                        { name: 'A-적극형 (0.35)', value: 'A_ACTIVE' },
                    ],
                },
            ],
        },
        { name: 'strategy-status', description: '전략 모드·30분 거래/스킵 현황' },
        { name: 'strategy-explain-recent', description: '최근 10건 decision 로그 (BUY/SKIP 사유)' },
        { name: 'strategy-skip-top', description: '최근 30분 skip reason 상위' },
        {
            name: 'analyst',
            description: '분석',
            options: [
                { type: 1, name: 'scan-vol', description: '급등주 분석' },
                { type: 1, name: 'summary', description: '시황 요약' },
                { type: 1, name: 'indicators', description: '주요지표' },
            ],
        },
    ];
    if (!client.application) {
        LogUtil_1.LogUtil.logWarn(LOG_TAG, 'client.application not ready, skip slash command registration');
        return;
    }
    const guildId = process.env.DISCORD_GUILD_ID?.trim();
    if (guildId) {
        await client.application.commands.set(commands, guildId);
        LogUtil_1.LogUtil.logInfo(LOG_TAG, 'slash commands registered', { guildId });
    }
    else {
        await client.application.commands.set(commands);
        LogUtil_1.LogUtil.logInfo(LOG_TAG, 'slash commands registered global');
    }
}
let healthDmScheduled = false;
function scheduleHourlyHealthDm() {
    if (healthDmScheduled)
        return;
    healthDmScheduled = true;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    async function runHealthCheck() {
        if (!adminId)
            return;
        try {
            const report = await api('/api/health');
            const embed = buildHealthEmbedFromApi(report);
            const user = await client.users.fetch(adminId).catch(() => null);
            if (user)
                await user.send({ content: '1시간 헬스체크', embeds: [embed] }).catch((e) => LogUtil_1.LogUtil.logWarn(LOG_TAG, 'health DM failed', { message: e?.message }));
        }
        catch (e) {
            LogUtil_1.LogUtil.logWarn(LOG_TAG, 'health check fetch failed', { message: e.message });
        }
    }
    setInterval(runHealthCheck, ONE_HOUR_MS);
    setTimeout(runHealthCheck, ONE_HOUR_MS);
    LogUtil_1.LogUtil.logInfo(LOG_TAG, '1시간 헬스체크 DM 예약됨');
}
const fs = require('fs');
const PANEL_FILE = path_1.default.join(process.cwd(), 'state', 'discord-panel.json');
/** 역할 A(현장 지휘관) / B(정보 분석가) / C(서버 관리자) — 한 메시지 내 최대 5 row, row당 5버튼. 전략 4종은 메인에 두지 않고 "전략" 버튼 클릭 시에만 노출. */
function buildPanelComponents() {
    return [
        // 역할 A — Row 1: 엔진 제어 + 상태/수익률 + 전체 매도
        {
            type: 1,
            components: [
                { type: 2, style: 3, custom_id: 'engine_start', label: '엔진 가동' },
                { type: 2, style: 4, custom_id: 'engine_stop', label: '즉시 정지' },
                { type: 2, style: 2, custom_id: 'current_state', label: '현재 상태' },
                { type: 2, style: 2, custom_id: 'current_return', label: '현재 수익률' },
                { type: 2, style: 4, custom_id: 'sell_all', label: '전체 매도' },
            ],
        },
        // 역할 A — Row 2: 경주마, 완화, 초공격 scalp, 전략(하위 메뉴 진입)
        {
            type: 1,
            components: [
                { type: 2, style: 2, custom_id: 'race_horse_toggle', label: '경주마 ON/OFF' },
                { type: 2, style: 2, custom_id: 'relax_toggle', label: '기준 완화' },
                { type: 2, style: 1, custom_id: 'independent_scalp_start', label: '초공격 scalp' },
                { type: 2, style: 2, custom_id: 'independent_scalp_stop', label: 'scalp 중지' },
                { type: 2, style: 1, custom_id: 'strategy_menu', label: '전략' },
            ],
        },
        // 역할 A — Row 3: 현재전략, 최근스킵, 최근체결 + 역할 C 1개
        {
            type: 1,
            components: [
                { type: 2, style: 1, custom_id: 'strategy_view_config', label: '현재전략' },
                { type: 2, style: 2, custom_id: 'strategy_skip_recent', label: '최근스킵' },
                { type: 2, style: 2, custom_id: 'strategy_buy_recent', label: '최근체결' },
                { type: 2, style: 2, custom_id: 'health', label: '헬스' },
                { type: 2, style: 4, custom_id: 'admin_emergency_menu', label: '비상 제어' },
            ],
        },
        // 역할 B — Row 4: AI 타점, 시황, 급등주, 주요지표, 거래 부재 진단
        {
            type: 1,
            components: [
                { type: 2, style: 1, custom_id: 'ai_analysis', label: 'AI 타점 분석' },
                { type: 2, style: 1, custom_id: 'analyst_get_prompt', label: '시황 요약' },
                { type: 2, style: 2, custom_id: 'analyst_scan_vol', label: '급등주 분석' },
                { type: 2, style: 2, custom_id: 'analyst_indicators', label: '주요지표' },
                { type: 2, style: 2, custom_id: 'analyst_diagnose_no_trade', label: '거래 부재 진단' },
            ],
        },
        // 역할 B + C — Row 5: 로직 제안, 조언자, 일일 로그, API 사용량, 시스템 업데이트
        {
            type: 1,
            components: [
                { type: 2, style: 2, custom_id: 'analyst_suggest_logic', label: '로직 수정안 제안' },
                { type: 2, style: 2, custom_id: 'analyst_advisor_one_liner', label: '조언자의 한마디' },
                { type: 2, style: 2, custom_id: 'daily_log_analysis', label: '하루치 로그 분석' },
                { type: 2, style: 2, custom_id: 'api_usage_monitor', label: 'API 사용량' },
                { type: 2, style: 1, custom_id: 'admin_git_pull_restart', label: '시스템 업데이트' },
            ],
        },
    ];
}
/** 전략 하위 메뉴: SAFE / A-보수적 / A-균형형 / A-적극형 (strategy_menu 클릭 시에만 표시) */
function buildStrategySubmenuComponents() {
    return [
        {
            type: 1,
            components: [
                { type: 2, style: 2, custom_id: 'strategy_safe', label: 'SAFE' },
                { type: 2, style: 2, custom_id: 'strategy_conservative', label: 'A-보수적' },
                { type: 2, style: 2, custom_id: 'strategy_balanced', label: 'A-균형형' },
                { type: 2, style: 2, custom_id: 'strategy_active', label: 'A-적극형' },
            ],
        },
    ];
}
/** 역할 C 비상 제어 하위 메뉴: 프로세스 정리 / 강제 종료 / 프로세스 재기동 (admin_emergency_menu 클릭 시에만 표시) */
function buildEmergencySubmenuComponents() {
    return [
        {
            type: 1,
            components: [
                { type: 2, style: 2, custom_id: 'admin_cleanup_processes', label: '비상 프로세스 정리' },
                { type: 2, style: 4, custom_id: 'admin_force_kill_bot', label: '강제 종료(taskkill)' },
                { type: 2, style: 2, custom_id: 'admin_simple_restart', label: '프로세스 재기동' },
            ],
        },
    ];
}
/** 패널 복구: content + components 반드시 적용. 성공 시 true, 실패 시 false. 진단 로그는 LogUtil.logWarn/logError로 항상 출력 */
async function restorePanel(channel) {
    const panelContent = [
        '🎮 **자동매매 통제 패널**',
        '',
        '**역할 A — 현장 지휘관** (엔진 제어 · 실시간 상태 · 체결 보고)',
        '**역할 B — 정보 분석가** (AI 실시간 타점 분석 · 시황 요약 · 주요지표 · 거래 부재 진단)',
        '**역할 C — 서버 관리자** (시스템 업데이트 · 프로세스 재기동)',
    ].join('\n');
    const components = buildPanelComponents();
    const rows = Array.isArray(components) ? components.length : 0;
    const counts = Array.isArray(components)
        ? components.map((r) => (Array.isArray(r?.components) ? r.components.length : 0))
        : [];
    const countsStr = counts.join(',');
    const firstIds = Array.isArray(components)
        ? components.slice(0, 2).map((r) => (r?.components?.[0]?.custom_id ?? '—')).join(',')
        : '—';
    const invalidRows = rows > 5 || rows === 0;
    const invalidCounts = counts.some((c) => c > 5 || c === 0);
    if (invalidRows || invalidCounts) {
        panelRestoreFail('COMPONENTS_INVALID', new Error('rows or button count out of limit'), { rows, counts: countsStr });
    }
    else {
        panelRestoreWarn('COMPONENTS_BUILT', { rows, counts: countsStr, firstIds });
    }
    let panelData = {};
    try {
        if (fs.existsSync(PANEL_FILE)) {
            const raw = fs.readFileSync(PANEL_FILE, 'utf8');
            panelData = JSON.parse(raw);
            panelRestoreWarn('STATE_LOADED', {
                found: true,
                channelId: panelData.channelId,
                messageId: panelData.panelMessageId,
                updatedAt: panelData.updatedAt ?? null,
            });
        }
        else {
            panelRestoreWarn('STATE_LOADED', { found: false, reason: 'no state file' });
        }
    }
    catch (e) {
        panelRestoreFail('STATE_LOAD_FAIL', e, { panelFile: PANEL_FILE });
    }
    panelRestoreWarn('START', {
        channelId: channel?.id,
        savedPanelMessageId: panelData.panelMessageId ?? null,
        savedChannelId: panelData.channelId ?? null,
        panelFile: PANEL_FILE,
    });
    const dir = path_1.default.join(process.cwd(), 'state');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const channelIdMatch = panelData.channelId && String(panelData.channelId) === String(channel.id);
    const hasSavedMessage = !!(panelData.panelMessageId && channelIdMatch);
    if (panelData.panelMessageId && !channelIdMatch) {
        panelRestoreWarn('CHANNEL_MISMATCH', { savedChannelId: panelData.channelId, currentChannelId: channel.id, willSendNew: true });
    }
    if (hasSavedMessage) {
        const messageId = panelData.panelMessageId;
        panelRestoreWarn('FETCH_EXISTING', { channelId: channel.id, messageId });
        let msg;
        try {
            msg = await channel.messages.fetch(messageId);
            panelRestoreWarn('FETCH_EXISTING_OK', { messageId });
        }
        catch (e) {
            panelRestoreFail('FETCH_EXISTING_FAIL', e, { messageId });
            // fall through to SEND_NEW
        }
        if (msg) {
            try {
                panelRestoreWarn('EDIT_START', { messageId: msg.id, contentLen: panelContent.length, rows });
                await msg.edit({ content: panelContent, components });
                panelRestoreWarn('EDIT_OK', { messageId: msg.id });
                try {
                    fs.writeFileSync(PANEL_FILE, JSON.stringify({ channelId: channel.id, panelMessageId: msg.id }));
                    panelRestoreWarn('STATE_SAVE_OK', { channelId: channel.id, messageId: msg.id });
                }
                catch (saveErr) {
                    panelRestoreFail('STATE_SAVE_FAIL', saveErr, { after: 'edit', channelId: channel.id, messageId: msg.id });
                }
                panelRestoreWarn('DONE', { restored: true, mode: 'edit', panelMessageId: msg.id });
                return true;
            }
            catch (e) {
                panelRestoreFail('EDIT_FAIL', e, { messageId: msg.id, contentLen: panelContent.length, rows });
            }
        }
    }
    panelRestoreWarn('SEND_NEW_START', { channelId: channel.id, contentLen: panelContent.length, rows });
    try {
        const msg = await channel.send({ content: panelContent, components });
        panelRestoreWarn('SEND_NEW_OK', { messageId: msg.id });
        try {
            fs.writeFileSync(PANEL_FILE, JSON.stringify({ channelId: channel.id, panelMessageId: msg.id }));
            panelRestoreWarn('STATE_SAVE_OK', { channelId: channel.id, messageId: msg.id });
        }
        catch (saveErr) {
            panelRestoreFail('STATE_SAVE_FAIL', saveErr, { after: 'send', channelId: channel.id, messageId: msg.id });
        }
        panelRestoreWarn('DONE', { restored: true, mode: 'new', panelMessageId: msg.id, restartMessageSeparate: true });
        return true;
    }
    catch (e) {
        panelRestoreFail('SEND_NEW_FAIL', e, { channelId: channel.id, contentLen: panelContent.length, rows });
        panelRestoreWarn('DONE', { restored: false, reason: 'send_failed' });
        return false;
    }
}
/** 재기동 안내 메시지. panelRestored=true일 때만 "패널 상태 : 복구 완료" 표시 */
async function sendRestartMessage(channel, panelRestored) {
    if (startupMessageSent)
        return;
    const panelStatus = panelRestored ? '복구 완료' : '복구 실패 (로그 확인)';
    panelRestoreWarn('RESTART_MESSAGE', { panelRestored, panelStatusText: panelStatus });
    try {
        const text = [
            '🚀 **시스템 재기동 되었습니다**',
            '',
            'Discord Operator : 정상',
            'Market Bot       : 연결 확인',
            'API Server       : 정상',
            '',
            `패널 상태 : ${panelStatus}`,
        ].join('\n');
        const restartMsg = await channel.send({ content: text });
        startupMessageSent = true;
        panelRestoreWarn('RESTART_MESSAGE_SENT', { restartMessageId: restartMsg?.id ?? null, panelRestored });
    }
    catch (e) {
        panelRestoreFail('RESTART_MESSAGE_FAIL', e, { panelRestored });
        LogUtil_1.LogUtil.logError(LOG_TAG, 'Restart message send failed', { message: e.message });
    }
}
async function handleButton(interaction) {
    const userId = interaction.user?.id ?? '';
    const customId = interaction.customId;
    if (customId.startsWith('confirm_')) {
        const tokenId = customId.replace('confirm_', '');
        const consumed = ConfirmFlow_1.ConfirmFlow.consume(tokenId, userId);
        if (!consumed) {
            await interaction.reply({ content: '확인 시간이 지났거나 본인이 아닙니다.', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferUpdate().catch(() => { });
        try {
            if (consumed.command === 'engine_stop') {
                const stopRes = await api('/api/engine/stop', { method: 'POST', body: { userId, updatedBy: 'discord' }, userId });
                await AuditLogService_1.AuditLogService.log({ userId, command: 'engine_stop', timestamp: new Date().toISOString(), success: true, approved: true });
                await interaction.update({ content: stopRes?.message ?? '엔진이 정지되었습니다.', components: [] }).catch(() => { });
            }
            else if (consumed.command === 'sell_all') {
                const result = await api('/api/sell-all', { method: 'POST', body: { userId }, userId });
                await AuditLogService_1.AuditLogService.log({ userId, command: 'sell_all', timestamp: new Date().toISOString(), success: true, approved: true, orderCreated: true });
                await interaction.update({ content: `전체 매도: ${result?.message ?? '완료'}`, components: [] }).catch(() => { });
            }
            else if (consumed.command === 'admin_cleanup_processes') {
                const result = await api('/api/admin/cleanup-processes', { method: 'POST', body: { userId }, userId });
                await AuditLogService_1.AuditLogService.log({ userId, command: 'admin_cleanup_processes', timestamp: new Date().toISOString(), success: !!result?.ok });
                LogUtil_1.LogUtil.logWarn(LOG_TAG, 'admin_cleanup_processes executed', { userId, ok: result?.ok, summary: result?.summary });
                await interaction.update({ content: result?.summary ?? result?.error ?? '처리 완료', components: [] }).catch(() => { });
            }
            else if (consumed.command === 'admin_force_kill_bot') {
                const result = await api('/api/admin/force-kill-bot', { method: 'POST', body: { userId }, userId });
                await AuditLogService_1.AuditLogService.log({ userId, command: 'admin_force_kill_bot', timestamp: new Date().toISOString(), success: !!result?.ok });
                LogUtil_1.LogUtil.logWarn(LOG_TAG, 'admin_force_kill_bot executed', { userId, ok: result?.ok, killed: result?.killed });
                await interaction.update({ content: result?.summary ?? result?.error ?? '처리 완료', components: [] }).catch(() => { });
            }
        }
        catch (e) {
            await AuditLogService_1.AuditLogService.log({ userId, command: consumed.command, timestamp: new Date().toISOString(), success: false, errorCode: e.message });
            LogUtil_1.LogUtil.logError(LOG_TAG, 'confirm flow failed', { command: consumed.command, userId, error: e.message });
            await interaction.update({ content: `오류: ${e.message}`, components: [] }).catch(() => { });
        }
        return;
    }
    if (customId.startsWith('cancel_')) {
        const tokenId = customId.replace('cancel_', '');
        ConfirmFlow_1.ConfirmFlow.cancel(tokenId);
        await interaction.deferUpdate().catch(() => { });
        await interaction.update({ content: '취소되었습니다.', components: [] }).catch(() => { });
        return;
    }
    // 전략 하위 메뉴: "전략" 버튼 클릭 시에만 SAFE / A-보수적 / A-균형형 / A-적극형 노출
    if (customId === 'strategy_menu') {
        await interaction.reply({
            content: '**전략 선택** — 아래에서 모드를 선택하세요.',
            components: buildStrategySubmenuComponents(),
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    // 엔진 가동 버튼 (확인 없이 즉시 API 호출)
    if (customId === 'engine_start') {
        const ctx = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctx, 'engine_start')) {
            await interaction.reply({ content: '권한 없음 (엔진 가동은 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const result = await api('/api/engine/start', {
                method: 'POST',
                body: { userId, updatedBy: 'discord' },
                userId,
            });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'engine_start', timestamp: new Date().toISOString(), success: !!result?.success });
            await interaction.editReply({ content: result?.message ?? '엔진 가동 요청됨' }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    // 즉시 정지 — 2단계 확인
    if (customId === 'engine_stop') {
        const ctx = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctx, 'engine_stop')) {
            await interaction.reply({ content: '권한 없음 (즉시 정지는 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'engine_stop');
        await interaction.reply({
            content: '⚠️ 엔진 정지하려면 확인 버튼을 누르세요. (5분 내)',
            components: [
                { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
            ],
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    // 전체 매도 — 2단계 확인
    if (customId === 'sell_all') {
        const ctx = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctx, 'sell_all')) {
            await interaction.reply({ content: '권한 없음 (전체 매도는 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'sell_all');
        await interaction.reply({
            content: '⚠️ 전량 시장가 매도하려면 확인 버튼을 누르세요. (5분 내)',
            components: [
                { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
            ],
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    const strategyModeMap = {
        strategy_safe: 'SAFE',
        strategy_conservative: 'A_CONSERVATIVE',
        strategy_balanced: 'A_BALANCED',
        strategy_active: 'A_ACTIVE',
    };
    if (strategyModeMap[customId]) {
        const adminIdSet = !!((process.env.ADMIN_ID || '').trim() ||
            (process.env.ADMIN_DISCORD_ID || '').trim() ||
            (process.env.DISCORD_ADMIN_ID || '').trim() ||
            (process.env.SUPER_ADMIN_ID || '').trim());
        const ctx = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctx, 'strategy-mode')) {
            const msg = !adminIdSet
                ? '관리자 ID 미설정으로 판별 불가. .env에 ADMIN_ID 또는 ADMIN_DISCORD_ID를 설정하세요.'
                : '권한 없음 (ADMIN만 전략 모드 전환이 가능합니다)';
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const result = await api('/api/strategy-mode', { method: 'POST', body: { mode: strategyModeMap[customId], updatedBy: 'discord' }, userId: interaction.user?.id });
            if (result?.ok) {
                const line = `전략 모드가 **${result.mode}**로 변경되었습니다.\n- threshold_entry: ${result.thresholdEntry}\n- min_orchestrator_score: ${result.minOrchestratorScore}\n- updated_by: ${result.updatedBy}\n- updated_at: ${result.updatedAt ? result.updatedAt.slice(0, 19).replace('T', ' ') : '—'}`;
                await interaction.editReply({ content: line }).catch(() => { });
                await AuditLogService_1.AuditLogService.log({
                    userId: interaction.user?.id ?? 'discord',
                    command: 'strategy_mode_change',
                    timestamp: new Date().toISOString(),
                    success: true,
                });
            }
            else {
                await interaction.editReply({ content: `오류: ${result?.error ?? 'Unknown'}` }).catch(() => { });
            }
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'strategy_view_config') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const data = await api('/api/strategy-config');
            const at = data.updatedAt ? data.updatedAt.slice(0, 19).replace('T', ' ') : '—';
            const desc = data.profile?.description ?? '—';
            const line = `**현재 전략 모드: ${data.mode ?? '—'}**\n- threshold_entry: ${data.thresholdEntry ?? '—'}\n- min_orchestrator_score: ${data.minOrchestratorScore ?? '—'}\n- updated_by: ${data.updatedBy ?? '—'}\n- updated_at: ${at}\n- description: ${desc}`;
            await interaction.editReply({ content: line }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'strategy_skip_recent') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const data = await api('/api/strategy-status');
            const lines = (data.skipTop5 || []).map((s) => `${s.reason} (${s.count}건)`).join('\n') || '—';
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('최근 30분 skip reason (상위 5)')
                .setColor(0x5865f2)
                .setDescription(lines || '데이터 없음')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'strategy_buy_recent') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const data = await api('/api/strategy-status');
            const lines = (data.buyRecent5 || []).map((b, i) => `${i + 1}) ${b.symbol} BUY | final ${b.finalScore ?? '—'} | ${b.reason ?? ''}`).join('\n') || '—';
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('최근 BUY 로그 (5건)')
                .setColor(0x57f287)
                .setDescription(lines || '데이터 없음')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    // ——— 역할 A: 경주마, 기준 완화, 초공격 scalp (market-bot proxy) ———
    if (customId === 'race_horse_toggle') {
        const ctxRh = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxRh, 'race_horse_toggle')) {
            await interaction.reply({ content: '권한 없음 (경주마 모드는 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const result = await api('/api/race-horse-toggle', { method: 'POST' });
            const msg = result?.active ? '🏇 경주마 모드를 예약했습니다. 오전 9시에 자산 50% 투입.' : '❄️ 경주마 모드 OFF';
            await interaction.editReply({ content: result?.message || msg }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'relax_toggle') {
        const ctxRelax = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxRelax, 'relax_toggle')) {
            await interaction.reply({ content: '권한 없음 (기준 완화는 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const status = await api('/api/relax-status');
            const remainingMs = status?.remainingMs ?? 0;
            const ONE_HOUR_MS = 60 * 60 * 1000;
            if (remainingMs > 0) {
                const remainingMin = Math.ceil(remainingMs / 60000);
                const isUnderOneHour = remainingMs < ONE_HOUR_MS;
                await interaction.editReply({
                    content: isUnderOneHour
                        ? `완화 적용 중. 남은 시간: ${remainingMin}분. 연장하려면 아래 버튼을 누르세요.`
                        : `기준 완화 적용 중. (남은 시간: ${remainingMin}분)`,
                    components: isUnderOneHour
                        ? [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'extend_relax', label: '연장 (4시간)' }] }]
                        : [],
                }).catch(() => { });
            }
            else {
                await api('/api/relax', { method: 'POST', body: { ttlMs: 4 * 60 * 60 * 1000 } });
                await interaction.editReply({ content: '🔓 매매 엔진 기준 완화를 4시간 적용했습니다.' }).catch(() => { });
            }
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'extend_relax') {
        const ctxExRelax = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxExRelax, 'extend_relax')) {
            await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            await api('/api/relax-extend', { method: 'POST' });
            await interaction.editReply({ content: '🔓 기준 완화 4시간 연장되었습니다.' }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'independent_scalp_start') {
        const ctxScalp = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxScalp, 'independent_scalp_start')) {
            await interaction.reply({ content: '권한 없음 (초공격 scalp는 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const status = await api('/api/independent-scalp-status');
            if (status?.isRunning && (status?.remainingMs ?? 0) > 0) {
                const remainingMin = Math.ceil((status.remainingMs ?? 0) / 60000);
                const under1h = (status.remainingMs ?? 0) < 60 * 60 * 1000;
                await interaction.editReply({
                    content: `독립 스캘프 가동 중. (남은 시간: ${remainingMin}분)${under1h ? ' 연장 가능.' : ''}`,
                    components: under1h ? [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'extend_independent_scalp', label: '연장 (3시간)' }] }] : [],
                }).catch(() => { });
            }
            else {
                const result = await api('/api/independent-scalp-start', { method: 'POST' });
                const min = result?.remainingMs != null ? Math.ceil(result.remainingMs / 60000) : 180;
                await interaction.editReply({ content: result?.success ? `🚀 초공격 스캘프 3시간 가동. (남은 시간: ${min}분)` : '요청 실패 또는 미연동.' }).catch(() => { });
            }
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'independent_scalp_stop') {
        const ctxScalpStop = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxScalpStop, 'independent_scalp_stop')) {
            await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            await api('/api/independent-scalp-stop', { method: 'POST' });
            await interaction.editReply({ content: '🛑 초공격 스캘프 중지됨.' }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'extend_independent_scalp') {
        const ctxExScalp = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxExScalp, 'extend_independent_scalp')) {
            await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const result = await api('/api/independent-scalp-extend', { method: 'POST' });
            const min = result?.remainingMs != null ? Math.ceil(result.remainingMs / 60000) : 0;
            await interaction.editReply({ content: result?.success ? `연장 완료. (남은 시간: ${min}분)` : '연장 불가 (1시간 미만일 때만 가능)' }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
        return;
    }
    // ——— 역할 B: AI 타점, 거래 부재 진단, 로직 제안, 조언자, 일일 로그, API 사용량 (market-bot proxy) ———
    if (customId === 'ai_analysis') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const result = await api('/api/ai_analysis');
            const text = (result?.content ?? '').slice(0, 2000) || '데이터 없음';
            await interaction.editReply({ content: text }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'analyst_diagnose_no_trade' || customId === 'analyst_suggest_logic') {
        const ctxDiag = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxDiag, customId)) {
            await interaction.reply({ content: '권한 없음 (거래 부재 진단/로직 제안은 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const path = customId === 'analyst_diagnose_no_trade' ? '/api/analyst/diagnose_no_trade' : '/api/analyst/suggest_logic';
            const embedJson = await api(path);
            const embed = new discord_js_1.MessageEmbed(embedJson);
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    if (customId === 'analyst_advisor_one_liner' || customId === 'daily_log_analysis' || customId === 'api_usage_monitor') {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            const path = customId === 'analyst_advisor_one_liner'
                ? '/api/analyst/advisor_one_liner'
                : customId === 'daily_log_analysis'
                    ? '/api/analyst/daily_log_analysis'
                    : '/api/analyst/api_usage_monitor';
            const result = await api(path);
            const text = (result?.content ?? '').slice(0, 2000) || '데이터 없음';
            await interaction.editReply({ content: text }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    // 비상 제어 하위 메뉴 진입 (역할 C)
    if (customId === 'admin_emergency_menu') {
        const ctxEm = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxEm, 'admin_emergency_menu')) {
            await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.reply({
            content: '**비상 제어** — 프로세스 정리 / 강제 종료 / 재기동 (강제 종료·정리는 확인 후 실행)',
            components: buildEmergencySubmenuComponents(),
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    // 비상 프로세스 정리 — 2단계 확인 후 실행
    if (customId === 'admin_cleanup_processes') {
        const ctxCp = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxCp, 'admin_cleanup_processes')) {
            await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'admin_cleanup_processes');
        await interaction.reply({
            content: '⚠️ **비상 프로세스 정리** — stale lock·좀비 프로세스 정리할까요? (5분 내 확인)',
            components: [
                { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
            ],
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    // 강제 종료(taskkill) — 2단계 확인 후 실행
    if (customId === 'admin_force_kill_bot') {
        const ctxFk = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxFk, 'admin_force_kill_bot')) {
            await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'admin_force_kill_bot');
        await interaction.reply({
            content: '⚠️ **강제 종료** — market-bot / discord-operator 프로세스를 taskkill 할까요? (5분 내 확인)',
            components: [
                { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
            ],
            ephemeral: true,
        }).catch(() => { });
        return;
    }
    // ——— 역할 C: 시스템 업데이트, 프로세스 재기동 (market-bot proxy) ———
    if (customId === 'admin_git_pull_restart' || customId === 'admin_simple_restart') {
        const ctxAdmin = PermissionService_1.PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
        if (!PermissionService_1.PermissionService.can(ctxAdmin, customId)) {
            await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => { });
            return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        const path = customId === 'admin_git_pull_restart' ? '/api/admin/git-pull-restart' : '/api/admin/simple-restart';
        try {
            const result = await api(path, { method: 'POST' });
            await interaction.editReply({ content: result?.content ?? '요청 처리됨' }).catch(() => { });
        }
        catch (e) {
            await interaction.editReply({ content: `오류 또는 미연동: ${e.message}` }).catch(() => { });
        }
        return;
    }
    // FIX: 패널 버튼(현재 상태, 수익률, 헬스, analyst) → ephemeral reply로 결과만 반환, 패널 메시지는 수정 안 함
    const panelIds = ['current_state', 'current_return', 'health', 'analyst_scan_vol', 'analyst_get_prompt', 'analyst_indicators'];
    if (panelIds.includes(customId)) {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        try {
            if (customId === 'current_state') {
                const data = await api('/api/status');
                const embed = buildStatusEmbedFromApi(data);
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
            else if (customId === 'current_return') {
                const data = await api('/api/pnl');
                const embed = buildPnlEmbedFromApi(data);
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
            else if (customId === 'health') {
                const report = await api('/api/health');
                const embed = buildHealthEmbedFromApi(report);
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
            else if (customId === 'analyst_scan_vol') {
                const result = await api('/api/analyst/scan-vol');
                const embed = new discord_js_1.MessageEmbed()
                    .setTitle('🔍 급등주 분석')
                    .setColor(0x0099ff)
                    .setDescription(result?.data?.text || result?.message || '데이터 없음')
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
            else if (customId === 'analyst_get_prompt') {
                const result = await api('/api/analyst/summary');
                const embed = new discord_js_1.MessageEmbed()
                    .setTitle('💡 시황 요약')
                    .setColor(0x0099ff)
                    .setDescription(result?.data?.text || result?.message || '데이터 없음')
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
            else if (customId === 'analyst_indicators') {
                const result = await api('/api/analyst/indicators');
                const d = result?.data || {};
                const lines = [
                    `FNG: ${d.fng ? `${d.fng.value} (${d.fng.classification})` : '—'}`,
                    `BTC: ${d.btcTrend || '—'}`,
                    `김프: ${d.kimpAvg != null ? d.kimpAvg.toFixed(2) + '%' : '—'}`,
                    `상위: ${d.topTickersText || '—'}`,
                ];
                const embed = new discord_js_1.MessageEmbed()
                    .setTitle('📊 주요 지표')
                    .setColor(0x0099ff)
                    .setDescription('```\n' + lines.join('\n') + '\n```')
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] }).catch(() => { });
            }
        }
        catch (e) {
            await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        }
    }
}
async function handleSlash(interaction) {
    const userId = interaction.user?.id ?? '';
    const channelIdFrom = interaction.channelId ?? '';
    const ctx = PermissionService_1.PermissionService.from(userId, channelIdFrom);
    const name = interaction.commandName;
    const sub = interaction.options?.getSubcommand(false);
    const full = sub ? `${name}_${sub}` : name;
    if (!PermissionService_1.PermissionService.can(ctx, full)) {
        const adminIdSet = !!((process.env.ADMIN_ID || '').trim() ||
            (process.env.ADMIN_DISCORD_ID || '').trim() ||
            (process.env.DISCORD_ADMIN_ID || '').trim() ||
            (process.env.SUPER_ADMIN_ID || '').trim());
        const isStrategyMode = name === 'strategy-mode' || full === 'strategy-mode';
        const msg = isStrategyMode && !adminIdSet
            ? '관리자 ID 미설정으로 판별 불가. .env에 ADMIN_ID 또는 ADMIN_DISCORD_ID를 설정하세요.'
            : `권한 없음 (${errors_1.AppErrorCode.AUTH_INSUFFICIENT_ROLE})`;
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
        return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => { });
    try {
        if (name === 'engine' && sub === 'start') {
            const result = await api('/api/engine/start', { method: 'POST', body: { userId, updatedBy: 'discord' }, userId });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'engine_start', timestamp: new Date().toISOString(), success: !!result?.success });
            await interaction.editReply({ content: result?.message ?? '엔진 가동 요청됨' }).catch(() => { });
        }
        else if (name === 'engine' && sub === 'stop') {
            const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'engine_stop');
            await interaction.editReply({
                content: '⚠️ 엔진 정지하려면 확인 버튼을 누르세요. (5분 내)',
                components: [
                    {
                        type: 1,
                        components: [
                            { type: 2, style: 4, custom_id: `confirm_${confirmToken}`, label: '확인' },
                            { type: 2, style: 2, custom_id: `cancel_${confirmToken}`, label: '취소' },
                        ],
                    },
                ],
            }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'engine_stop', timestamp: new Date().toISOString(), success: true });
        }
        else if (name === 'engine' && sub === 'status') {
            const data = await api('/api/engine-status');
            const started = data.startedAt ? new Date(data.startedAt).toLocaleString() : '—';
            const stopped = data.stoppedAt ? new Date(data.stoppedAt).toLocaleString() : '—';
            const line = `**엔진 상태:** ${data.status ?? '—'}\n시작: ${started}\n정지: ${stopped}\n변경 주체: ${data.updatedBy ?? '—'}\n전략 모드: ${data.runtimeMode ?? '—'}`;
            await interaction.editReply({ content: line }).catch(() => { });
        }
        else if (name === 'sell' && sub === 'all') {
            const confirmToken = ConfirmFlow_1.ConfirmFlow.create(userId, 'sell_all');
            await interaction.editReply({
                content: '⚠️ 전량 매도하려면 확인 버튼을 누르세요. (5분 내)',
                components: [
                    {
                        type: 1,
                        components: [
                            { type: 2, style: 4, custom_id: `confirm_${confirmToken}`, label: '확인' },
                            { type: 2, style: 2, custom_id: `cancel_${confirmToken}`, label: '취소' },
                        ],
                    },
                ],
            }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'sell_all', timestamp: new Date().toISOString(), success: true });
        }
        else if (name === 'status') {
            const data = await api('/api/status');
            const embed = buildStatusEmbedFromApi(data);
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'status', timestamp: new Date().toISOString(), success: true });
        }
        else if (name === 'pnl') {
            const data = await api('/api/pnl');
            const embed = buildPnlEmbedFromApi(data);
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        else if (name === 'health') {
            const report = await api('/api/health');
            const embed = buildHealthEmbedFromApi(report);
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        else if (name === 'analyst' && sub === 'scan-vol') {
            const result = await api('/api/analyst/scan-vol');
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('🔍 급등주 분석 (거래대금 상위 10종목)')
                .setColor(0x0099ff)
                .setDescription(result?.data?.text || result?.message || '데이터 없음')
                .setFooter({ text: 'Gemini' })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'analyst_scan-vol', timestamp: new Date().toISOString(), success: !!result?.ok });
        }
        else if (name === 'analyst' && sub === 'summary') {
            const result = await api('/api/analyst/summary');
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('💡 시황 요약')
                .setColor(0x0099ff)
                .setDescription(result?.data?.text || result?.message || '데이터 없음')
                .setFooter({ text: 'Gemini' })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'analyst_summary', timestamp: new Date().toISOString(), success: !!result?.ok });
        }
        else if (name === 'analyst' && sub === 'indicators') {
            const result = await api('/api/analyst/indicators');
            const d = result?.data || {};
            const lines = [
                `FNG: ${d.fng ? `${d.fng.value} (${d.fng.classification})` : '—'}`,
                `BTC: ${d.btcTrend || '—'}`,
                `김프 평균: ${d.kimpAvg != null ? d.kimpAvg.toFixed(2) + '%' : '—'}`,
                `상위: ${d.topTickersText || '—'}`,
            ];
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('📊 주요 지표')
                .setColor(0x0099ff)
                .setDescription('```\n' + lines.join('\n') + '\n```')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
            await AuditLogService_1.AuditLogService.log({ userId, command: 'analyst_indicators', timestamp: new Date().toISOString(), success: !!result?.ok });
        }
        else if (name === 'strategy-mode') {
            const mode = interaction.options?.getString?.('mode')?.trim?.()?.toUpperCase?.();
            if (!mode) {
                await interaction.editReply({ content: 'mode 옵션을 선택해 주세요 (SAFE, A_CONSERVATIVE, A_BALANCED, A_ACTIVE)' }).catch(() => { });
                return;
            }
            const result = await api('/api/strategy-mode', { method: 'POST', body: { mode, updatedBy: 'discord' }, userId });
            if (result?.ok) {
                const line = `전략 모드가 **${result.mode}**로 변경되었습니다.\n- threshold_entry: ${result.thresholdEntry}\n- min_orchestrator_score: ${result.minOrchestratorScore}\n- updated_by: ${result.updatedBy}\n- updated_at: ${result.updatedAt ? result.updatedAt.slice(0, 19).replace('T', ' ') : '—'}`;
                await interaction.editReply({ content: line }).catch(() => { });
                await AuditLogService_1.AuditLogService.log({ userId, command: 'strategy_mode_change', timestamp: new Date().toISOString(), success: true });
            }
            else {
                await interaction.editReply({ content: `오류: ${result?.error ?? 'Unknown'}` }).catch(() => { });
            }
        }
        else if (name === 'strategy-status') {
            const data = await api('/api/strategy-status');
            const topSkip = (data.skipTop5 || [])[0];
            const topSkipLine = topSkip ? `${topSkip.reason} (${topSkip.count}건)` : '—';
            const lines = [
                `현재 전략 모드: ${data.mode ?? '—'}`,
                `- threshold_entry: ${data.thresholdEntry ?? '—'}`,
                `- min_orchestrator_score: ${data.minOrchestratorScore ?? '—'}`,
                `- 최근 30분 trade count: ${data.tradeCountLast30m ?? 0}`,
                `- 최근 30분 decision count: ${data.decisionCountLast30m ?? 0}`,
                `- 최근 30분 top skip reason: ${topSkipLine}`,
            ];
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('📊 전략 현황')
                .setColor(0x5865f2)
                .setDescription(lines.join('\n'))
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        else if (name === 'strategy-skip-top') {
            const data = await api('/api/strategy-status');
            const lines = (data.skipTop5 || []).map((s) => `${s.reason} (${s.count}건)`).join('\n') || '—';
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('최근 30분 skip reason (상위 5)')
                .setColor(0x5865f2)
                .setDescription(lines || '데이터 없음')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        else if (name === 'strategy-explain-recent') {
            const result = await api('/api/strategy-explain-recent');
            const list = (result?.decisions || []).map((d, i) => {
                const raw = d.raw_entry_score != null ? d.raw_entry_score : '—';
                const norm = d.normalized_score != null ? Number(d.normalized_score).toFixed(2) : '—';
                const final = d.final_orchestrator_score != null ? Number(d.final_orchestrator_score).toFixed(2) : '—';
                const reason = d.reason_summary || d.skip_reason || '—';
                return `${i + 1}) ${d.symbol} ${d.action} | raw ${raw} | norm ${norm} | final ${final} | ${reason}`;
            }).join('\n') || '—';
            const embed = new discord_js_1.MessageEmbed()
                .setTitle('📋 최근 decision log')
                .setColor(0x5865f2)
                .setDescription('```\n' + list + '\n```')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] }).catch(() => { });
        }
        else {
            await interaction.editReply({ content: '알 수 없는 명령입니다.' }).catch(() => { });
        }
    }
    catch (e) {
        await interaction.editReply({ content: `오류: ${e.message}` }).catch(() => { });
        await AuditLogService_1.AuditLogService.log({ userId, command: full, timestamp: new Date().toISOString(), success: false, errorCode: errors_1.AppErrorCode.INTERNAL });
    }
}
// upbit-bot 메인 사용 시: 보고 권한 단일화 — 수익률/현재 상태 보고는 upbit-bot만. 여기서는 가동 완료 로그만.
client.once('ready', async () => {
    const clientId = client.user?.id ?? null;
    panelRestoreWarn('READY', { start: true, clientId, channelId: channelId ?? null });
    LogUtil_1.LogUtil.logInfo(LOG_TAG, '서비스 가동 완료');
    await registerSlashCommands(client);
    const chId = channelId;
    if (chId) {
        try {
            const channel = await client.channels.fetch(chId).catch((err) => {
                panelRestoreFail('CHANNEL_FETCH_FAIL', err, { channelId: chId });
                return null;
            });
            if (channel && channel.isText()) {
                // 1) 먼저 통제 패널(버튼) 복구. 성공 시에만 "복구 완료" 표시.
                const panelRestored = await restorePanel(channel);
                // 2) 그 다음 재기동 안내 메시지 전송 (패널 복구 결과 반영)
                await sendRestartMessage(channel, panelRestored);
            }
            else {
                LogUtil_1.LogUtil.logError(LOG_TAG, 'Channel fetch failed or not text channel', { channelId: chId });
            }
        }
        catch (e) {
            panelRestoreFail('READY_SEQUENCE_FAIL', e, { channelId: chId });
            LogUtil_1.LogUtil.logError(LOG_TAG, 'Startup sequence failed', { message: e.message });
        }
    }
    else {
        panelRestoreWarn('READY', { skip: true, reason: 'no channelId' });
    }
    if (adminId)
        scheduleHourlyHealthDm();
});
client.removeAllListeners('interactionCreate');
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            await handleButton(interaction);
        }
        if (interaction.isChatInputCommand()) {
            await handleSlash(interaction);
        }
    }
    catch (e) {
        LogUtil_1.LogUtil.logError(LOG_TAG, 'interaction handle error', { message: e.message });
    }
});
async function startDiscordOperator() {
    LogUtil_1.LogUtil.logInfo(LOG_TAG, 'trying login');
    await client.login(token);
    LogUtil_1.LogUtil.logInfo(LOG_TAG, 'login success');
}
function getClient() {
    return client;
}
if (require.main === module) {
    LogUtil_1.LogUtil.logInfo(LOG_TAG, 'standalone startDiscordOperator()');
    startDiscordOperator().catch((err) => {
        LogUtil_1.LogUtil.logError(LOG_TAG, 'startup_error', { message: err.message });
        process.exit(1);
    });
}
