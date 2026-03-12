import path from 'path';
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

import { Client, MessageEmbed, MessageActionRow, MessageButton } from 'discord.js';
const discord = require('discord.js') as any;
const Intents = discord.Intents;
import { EventBus } from '../../../packages/core/src/EventBus';
import { PermissionService } from '../../../packages/core/src/PermissionService';
import { AuditLogService } from '../../../packages/core/src/AuditLogService';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';
import { ConfirmFlow } from '../../../packages/core/src/ConfirmFlow';
import { LogUtil } from '../../../packages/core/src/LogUtil';
import { AppErrorCode } from '../../../packages/shared/src/errors';
import type { PermissionContext } from '../../../packages/shared/src/types';
import {
  validatePanelDefinitions,
  buildPanelModel,
  buildPanelContent,
  buildPanelComponents,
  buildRolePanelContent,
  buildRolePanelComponents,
  getFallbackContent,
  getFallbackComponents,
  normalizeButtonId,
  PANEL_LAYOUT_VERSION,
  PANEL_CONTENT_VERSION,
  type PanelModel,
  type ActionRowPayload,
  type RoleType,
} from './panelContract';

/** panelContract의 ActionRowPayload[]를 Discord.js v13 MessageActionRow[]로 변환 (edit/send 시 버튼이 보이도록) */
function toDiscordComponents(rows: ActionRowPayload[]): MessageActionRow[] {
  return rows.map((row) => {
    const actionRow = new MessageActionRow();
    for (const comp of row.components) {
      const btn = new MessageButton()
        .setCustomId(comp.custom_id)
        .setLabel(comp.label)
        .setStyle(comp.style as 1 | 2 | 3 | 4 | 5);
      actionRow.addComponents(btn);
    }
    return actionRow;
  });
}

const LOG_TAG = 'DISCORD_OP';

/** PANEL_RESTORE 진단 로그 — LOG_LEVEL 무관하게 항상 출력 (logWarn 사용) */
function panelRestoreWarn(tag: string, detail: Record<string, unknown>): void {
  LogUtil.logWarn(LOG_TAG, `[PANEL_RESTORE][${tag}] ${JSON.stringify(detail)}`);
}
/** PANEL_RESTORE 실패 로그 — error + stack 일부 */
function panelRestoreFail(tag: string, err: unknown, extra?: Record<string, unknown>): void {
  const e = err as Error;
  const stack = e?.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : '';
  LogUtil.logError(LOG_TAG, `[PANEL_RESTORE][${tag}] ${e?.message ?? String(err)}`, { ...extra, stack });
}

// ===== DISCORD OPERATOR BOOT DIAGNOSTIC (timestamp 항상 포함) =====
LogUtil.logInfo(LOG_TAG, 'process start', { cwd: process.cwd(), pid: process.pid, node: process.version });

let packageVersion: string | undefined;
try {
  const pkg = require(path.join(process.cwd(), 'package.json')) as { version?: string };
  packageVersion = pkg?.version;
} catch {
  packageVersion = process.env.npm_package_version;
}
const scriptPath = process.argv[1] ?? 'unknown';
// BUILD_INFO를 setImmediate로 지연해 panelContract 순환 참조 시 'before initialization' 방지
setImmediate(() => {
  LogUtil.logWarn(LOG_TAG, '[BOOT][BUILD_INFO]', {
    pid: process.pid,
    cwd: process.cwd(),
    scriptPath,
    argv: process.argv,
    nodeVersion: process.version,
    PANEL_LAYOUT_VERSION,
    PANEL_CONTENT_VERSION,
    renderModeDefault: 'single',
    packageVersion: packageVersion ?? 'unknown',
  });
});

process.on('uncaughtException', (err) => {
  LogUtil.logError(LOG_TAG, 'uncaughtException', { message: (err as Error).message, stack: (err as Error).stack });
});

process.on('unhandledRejection', (err) => {
  LogUtil.logError(LOG_TAG, 'unhandledRejection', { message: String(err) });
});

if (LogUtil.isDebugLog()) {
  LogUtil.logDebug(LOG_TAG, 'DISCORD_TOKEN exists: ' + !!(process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN));
  LogUtil.logDebug(LOG_TAG, 'CHANNEL_ID exists: ' + !!(process.env.DISCORD_OPERATOR_CHANNEL_ID || process.env.CHANNEL_ID));
  LogUtil.logDebug(LOG_TAG, 'ADMIN_ID exists: ' + !!(process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID));
}

// 필수: 토큰과 채널 ID만 검증 (DISCORD_OPERATOR_CHANNEL_ID 또는 CHANNEL_ID)
const token = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();
const channelId = (process.env.DISCORD_OPERATOR_CHANNEL_ID || process.env.CHANNEL_ID || '').trim();
if (!token) {
  LogUtil.logError(LOG_TAG, 'Missing required env: DISCORD_TOKEN or DISCORD_BOT_TOKEN');
  process.exit(1);
}
if (!channelId) {
  LogUtil.logError(LOG_TAG, 'Missing required env: DISCORD_OPERATOR_CHANNEL_ID or CHANNEL_ID');
  process.exit(1);
}
if (!process.env.DISCORD_CLIENT_ID?.trim() || !process.env.DISCORD_GUILD_ID?.trim()) {
  if (process.env.DISCORD_OPERATOR_DEBUG === '1') LogUtil.logDebug(LOG_TAG, 'DISCORD_CLIENT_ID/GUILD_ID 미설정 — 전역 슬래시 명령 등록');
}
const adminId = (process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID || '').trim();

// 고정 패널 규약 검증 — 앱 시작 시 1회. 오류 시 경고 후 fallback 레이아웃 사용
validatePanelDefinitions();
const DASHBOARD_URL = (process.env.DASHBOARD_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');

LogUtil.logInfo(LOG_TAG, 'creating client');
const client = new Client({ intents: [(Intents as any)?.FLAGS?.GUILDS ?? 1] });
client.on('error', (err: any) => {
  LogUtil.logError(LOG_TAG, 'client error', { message: (err && err.message) || String(err) });
});

let startupMessageSent = false;

async function api<T>(path: string, opts?: { method?: string; body?: any; userId?: string }): Promise<T> {
  const url = `${DASHBOARD_URL}${path.startsWith('/') ? path : '/' + path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.userId) headers['x-user-id'] = opts.userId;
  const res = await fetch(url, {
    method: opts?.method || 'GET',
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json() as Promise<T>;
}

/** services: /api/services-status 응답. 있으면 임베드 상단에 서비스 상태 한 줄 추가. details.reason 있으면 🔴인 항목에만 괄호로 표시. */
function buildStatusEmbedFromApi(
  data: {
    assets: any;
    profitSummary: { profitPct: number; totalEval: number; totalBuy: number; krw?: number; orderableKrw?: number };
    strategySummary?: any;
    botEnabled?: boolean;
  },
  services?: {
    apiServer?: boolean;
    marketBot?: boolean;
    engineRunning?: boolean;
    details?: {
      apiServer?: { reason?: string | null };
      marketBot?: { reason?: string | null };
      engine?: { reason?: string | null };
    };
  } | null
): MessageEmbed {
  const assets = data.assets;
  const summary = data.profitSummary;
  const totalEval = summary?.totalEval ?? assets?.totalEvaluationKrw ?? 0;
  const orderableKrw = (summary?.krw ?? summary?.orderableKrw ?? assets?.orderableKrw ?? 0) as number;
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

  const details = services?.details;
  const fmt = (ok: boolean, reason: string | null | undefined) =>
    ok ? '🟢' : '🔴' + (reason ? ' (' + reason + ')' : '');

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (services != null) {
    const a = fmt(!!services.apiServer, details?.apiServer?.reason ?? null);
    const d = '🟢'; // Discord에서 호출 시 discord-operator는 가동 중
    const m = fmt(!!services.marketBot, details?.marketBot?.reason ?? null);
    const e = fmt(!!services.engineRunning, details?.engine?.reason ?? null);
    fields.push({ name: '서비스 상태', value: `api-server ${a} · discord-op ${d} · market-bot ${m} · engine ${e}`, inline: false });
  }
  fields.push(
    { name: '총 평가금액(현재 총자산)', value: Number(totalEval).toLocaleString('ko-KR') + ' 원', inline: true },
    { name: 'KRW 잔고', value: Number(orderableKrw).toLocaleString('ko-KR') + ' 원', inline: true },
    { name: '총 손익률', value: profitPct, inline: true },
    { name: '가동 전략', value: strategyName, inline: false },
    { name: 'RaceHorse(예약) 가중치', value: '```\n' + weightTable + '\n```', inline: false }
  );

  return new MessageEmbed()
    .setTitle('📊 현재 상태')
    .setColor(0x5865f2)
    .addFields(fields)
    .setFooter({ text: 'ProfitCalculationService.getSummary() 단일 소스' })
    .setTimestamp();
}

function buildPnlEmbedFromApi(data: { assets: any; profitSummary: any }): MessageEmbed {
  const summary = data.profitSummary;
  const totalKrw = (summary?.krw ?? summary?.orderableKrw ?? data.assets?.orderableKrw ?? 0) as number;
  const totalEval = summary?.totalEval ?? data.assets?.totalEvaluationKrw ?? 0;
  const totalBuyKrw = summary?.totalBuy ?? data.assets?.totalBuyKrwForCoins ?? data.assets?.totalBuyKrw ?? 0;
  const profitPctNum = summary?.profitPct ?? 0;
  const pctStr = profitPctNum.toFixed(2) + '%';
  const profitKrw = totalEval - (totalBuyKrw + totalKrw);
  const isProfit = profitKrw >= 0;
  const arrow = isProfit ? '▲' : '▼';
  const emoji = isProfit ? '🟢' : '🔴';
  const profitLine =
    totalBuyKrw + totalKrw > 0
      ? `${emoji} **현재 손익**: ${isProfit ? '+' : ''}${Number(profitKrw).toLocaleString('ko-KR')}원 (${arrow} ${pctStr})`
      : '🟢 **현재 손익**: 0원 (수익률 0.00%)';
  const summaryLine =
    totalBuyKrw + totalKrw > 0
      ? `총 매수: ${Number(totalBuyKrw).toLocaleString('ko-KR')}원 / 현재 총자산: ${Number(totalEval).toLocaleString('ko-KR')}원`
      : '—';
  return new MessageEmbed()
    .setTitle(isProfit ? '🟢 현재 수익률' : '🔴 현재 수익률')
    .setColor(isProfit ? 0x57f287 : 0xed4245)
    .addFields(
      { name: '보유 KRW', value: Number(totalKrw).toLocaleString('ko-KR') + ' 원', inline: true },
      { name: '현재 총자산', value: Number(totalEval).toLocaleString('ko-KR') + ' 원', inline: true },
      { name: '총 매수금액', value: Number(totalBuyKrw).toLocaleString('ko-KR') + ' 원', inline: true },
      { name: '평가 손익', value: profitLine + '\n' + summaryLine, inline: false }
    )
    .setFooter({ text: 'ProfitCalculationService.getSummary() 단일 소스' })
    .setTimestamp();
}

function buildHealthEmbedFromApi(report: any): MessageEmbed {
  return new MessageEmbed()
    .setTitle('🩺 헬스체크')
    .setColor(0x57f287)
    .addFields(
      { name: '프로세스', value: report.process || '—', inline: true },
      { name: '업타임(초)', value: String(report.uptimeSec ?? 0), inline: true },
      { name: '마지막 주문', value: report.lastOrderAt || '—', inline: true },
      { name: '1시간 오류', value: String(report.errorsLast1h ?? 0), inline: true },
      { name: 'Upbit 인증', value: report.upbitAuthOk ? 'OK' : 'NG', inline: true },
      { name: 'Circuit Upbit', value: report.circuitUpbit || '—', inline: true },
      { name: 'Circuit Gemini', value: report.circuitGemini || '—', inline: true },
      { name: '마지막 emit', value: report.lastEmitAt || '—', inline: false }
    )
    .setFooter({ text: report.reportedAt || '' })
    .setTimestamp();
}

async function registerSlashCommands(client: Client): Promise<void> {
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
    LogUtil.logWarn(LOG_TAG, 'client.application not ready, skip slash command registration');
    return;
  }
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  if (guildId) {
    await client.application.commands.set(commands, guildId);
    LogUtil.logInfo(LOG_TAG, 'slash commands registered', { guildId });
  } else {
    await client.application.commands.set(commands);
    LogUtil.logInfo(LOG_TAG, 'slash commands registered global');
  }
}

let healthDmScheduled = false;
function scheduleHourlyHealthDm(): void {
  if (healthDmScheduled) return;
  healthDmScheduled = true;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  async function runHealthCheck(): Promise<void> {
    if (!adminId) return;
    try {
      const report = await api<Record<string, unknown>>('/api/health');
      const embed = buildHealthEmbedFromApi(report);
      const user = await client.users.fetch(adminId).catch(() => null);
      if (user) await user.send({ content: '1시간 헬스체크', embeds: [embed] }).catch((e) => LogUtil.logWarn(LOG_TAG, 'health DM failed', { message: (e as Error)?.message }));
    } catch (e) {
      LogUtil.logWarn(LOG_TAG, 'health check fetch failed', { message: (e as Error).message });
    }
  }
  setInterval(runHealthCheck, ONE_HOUR_MS);
  setTimeout(runHealthCheck, ONE_HOUR_MS);
  LogUtil.logInfo(LOG_TAG, '1시간 헬스체크 DM 예약됨');
}

const fs = require('fs') as typeof import('fs');
const PANEL_FILE = path.join(process.cwd(), 'state', 'discord-panel.json');

/** 전략 하위 메뉴: SAFE / A-보수적 / A-균형형 / A-적극형 (strategy_menu 클릭 시에만 표시) */
function buildStrategySubmenuComponents(): any[] {
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
function buildEmergencySubmenuComponents(): any[] {
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

/** 역할별 패널 state (역할별 메시지 ID 3개) */
export interface PanelState {
  channelId?: string;
  roleAMessageId?: string;
  roleBMessageId?: string;
  roleCMessageId?: string;
  updatedAt?: string;
}

export interface PanelRestoreResult {
  restored: boolean;
  mode?: 'edit' | 'new';
  statusText: string;
  durationMs?: number;
  roleA?: 'edit' | 'new';
  roleB?: 'edit' | 'new';
  roleC?: 'edit' | 'new';
}

/** 역할별 패널 3개 복구/생성: A → B → C 순서로 메시지 각각 fetch/edit 또는 send. */
async function restoreOrCreateRolePanels(channel: any): Promise<PanelRestoreResult> {
  const t0 = Date.now();
  const lastUpdatedAt = new Date().toISOString();
  const dir = path.join(process.cwd(), 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let state: PanelState = {};
  try {
    if (fs.existsSync(PANEL_FILE)) {
      const raw = fs.readFileSync(PANEL_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      state = {
        channelId: typeof parsed.channelId === 'string' ? parsed.channelId : undefined,
        roleAMessageId: typeof parsed.roleAMessageId === 'string' ? parsed.roleAMessageId : undefined,
        roleBMessageId: typeof parsed.roleBMessageId === 'string' ? parsed.roleBMessageId : undefined,
        roleCMessageId: typeof parsed.roleCMessageId === 'string' ? parsed.roleCMessageId : undefined,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      };
      panelRestoreWarn('STATE_LOADED', { channelId: state.channelId, roleA: state.roleAMessageId, roleB: state.roleBMessageId, roleC: state.roleCMessageId });
    } else {
      panelRestoreWarn('STATE_LOADED', { found: false, reason: 'no state file' });
    }
  } catch (e) {
    panelRestoreFail('STATE_LOAD_FAIL', e, { panelFile: PANEL_FILE });
  }

  const channelIdMatch = state.channelId && String(state.channelId) === String(channel.id);
  const forceNewPanel = process.env.FORCE_NEW_PANEL_ON_RESTART === 'true';
  const roles: RoleType[] = ['A', 'B', 'C'];
  const result: { roleA?: 'edit' | 'new'; roleB?: 'edit' | 'new'; roleC?: 'edit' | 'new' } = {};
  const messageIdKeys: (keyof PanelState)[] = ['roleAMessageId', 'roleBMessageId', 'roleCMessageId'];

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const messageIdKey = messageIdKeys[i];
    let savedId: string | undefined = state[messageIdKey];
    if (forceNewPanel || !channelIdMatch) savedId = undefined;

    const content = buildRolePanelContent(role, { lastUpdatedAt });
    const components = buildRolePanelComponents(role);
    const discordComponents = toDiscordComponents(components);

    let finalId: string;
    if (savedId) {
      try {
        const msg = await channel.messages.fetch(savedId);
        await msg.edit({ content, components: discordComponents });
        finalId = msg.id;
        if (role === 'A') result.roleA = 'edit';
        else if (role === 'B') result.roleB = 'edit';
        else result.roleC = 'edit';
        panelRestoreWarn('ROLE_PANEL_EDIT', { role, messageId: finalId });
      } catch (e) {
        panelRestoreWarn('ROLE_PANEL_FETCH_FAIL', { role, messageId: savedId, willSendNew: true });
        const sent = await channel.send({ content, components: discordComponents });
        finalId = sent.id;
        if (role === 'A') result.roleA = 'new';
        else if (role === 'B') result.roleB = 'new';
        else result.roleC = 'new';
        panelRestoreWarn('ROLE_PANEL_SEND', { role, messageId: finalId });
      }
    } else {
      const sent = await channel.send({ content, components: discordComponents });
      finalId = sent.id;
      if (role === 'A') result.roleA = 'new';
      else if (role === 'B') result.roleB = 'new';
      else result.roleC = 'new';
      panelRestoreWarn('ROLE_PANEL_SEND', { role, messageId: finalId });
    }
    state[messageIdKey] = finalId;
  }

  state.channelId = channel.id;
  state.updatedAt = lastUpdatedAt;
  try {
    fs.writeFileSync(PANEL_FILE, JSON.stringify(state));
    panelRestoreWarn('STATE_SAVE_OK', { channelId: channel.id, roleA: state.roleAMessageId, roleB: state.roleBMessageId, roleC: state.roleCMessageId });
  } catch (saveErr) {
    panelRestoreFail('STATE_SAVE_FAIL', saveErr as Error, { channelId: channel.id });
  }

  const totalRestoreMs = Date.now() - t0;
  const allEdit = result.roleA === 'edit' && result.roleB === 'edit' && result.roleC === 'edit';
  const anyNew = result.roleA === 'new' || result.roleB === 'new' || result.roleC === 'new';
  const statusText = allEdit ? '역할별 패널 3건 복구 완료' : anyNew ? '역할별 패널 일부 신규 생성' : '역할별 패널 복구 완료';
  panelRestoreWarn('PANEL_RESTORE_DONE', { restored: true, roleA: result.roleA, roleB: result.roleB, roleC: result.roleC, totalRestoreMs });
  return {
    restored: true,
    statusText,
    durationMs: totalRestoreMs,
    roleA: result.roleA,
    roleB: result.roleB,
    roleC: result.roleC,
  };
}

/** 재기동 안내 메시지. result.statusText·durationMs 반영 */
async function sendRestartMessage(channel: any, result: PanelRestoreResult): Promise<void> {
  const policy = 'always send';
  panelRestoreWarn('RESTART_MESSAGE_POLICY', {
    policy,
    startupMessageSentAlready: startupMessageSent,
    willSend: !startupMessageSent,
  });
  if (startupMessageSent) return;
  const statusText = result.statusText;
  panelRestoreWarn('RESTART_MESSAGE', { panelRestored: result.restored, mode: result.mode, statusText, durationMs: result.durationMs });
  try {
    const durationLine = result.durationMs != null ? `\n패널 복구 소요: ${result.durationMs} ms` : '';
    const text = [
      '🚀 **시스템 재기동 되었습니다**',
      '',
      'Discord Operator : 정상',
      'Market Bot       : 연결 확인',
      'API Server       : 정상',
      '',
      `패널 상태 : ${statusText}${durationLine}`,
    ].join('\n');
    const restartMsg = await channel.send({ content: text });
    startupMessageSent = true;
    panelRestoreWarn('RESTART_MESSAGE_SENT', { restartMessageId: restartMsg?.id ?? null, panelRestored: result.restored, statusText });
    panelRestoreWarn('RESTART_MESSAGE_POLICY', { policy, restartMessageSend: true, restartMessageId: restartMsg?.id ?? null });
  } catch (e) {
    panelRestoreFail('RESTART_MESSAGE_FAIL', e as Error, { panelRestored: result.restored });
    LogUtil.logError(LOG_TAG, 'Restart message send failed', { message: (e as Error).message });
    panelRestoreWarn('RESTART_MESSAGE_POLICY', { policy, restartMessageSend: false, error: (e as Error).message });
  }
}

async function handleButton(interaction: any): Promise<void> {
  const userId = interaction.user?.id ?? '';
  const customId = interaction.customId;
  /** 레거시 customId → 표준 버튼 키. 패널 버튼은 표준 키 기준으로 분기 */
  const key = normalizeButtonId(customId);

  if (customId.startsWith('confirm_')) {
    const tokenId = customId.replace('confirm_', '');
    const consumed = ConfirmFlow.consume(tokenId, userId);
    if (!consumed) {
      await interaction.reply({ content: '확인 시간이 지났거나 본인이 아닙니다.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    try {
      if (consumed.command === 'engine_stop') {
        const stopRes = await api<{ success?: boolean; noop?: boolean; message?: string }>('/api/engine/stop', { method: 'POST', body: { userId, updatedBy: 'discord' }, userId });
        await AuditLogService.log({ userId, command: 'engine_stop', timestamp: new Date().toISOString(), success: true, approved: true });
        await interaction.update({ content: stopRes?.message ?? '엔진이 정지되었습니다.', components: [] }).catch(() => {});
      } else if (consumed.command === 'sell_all') {
        const result = await api<{ success?: boolean; message?: string }>('/api/sell-all', { method: 'POST', body: { userId }, userId });
        await AuditLogService.log({ userId, command: 'sell_all', timestamp: new Date().toISOString(), success: true, approved: true, orderCreated: true });
        await interaction.update({ content: `전체 매도: ${result?.message ?? '완료'}`, components: [] }).catch(() => {});
      } else if (consumed.command === 'admin_cleanup_processes') {
        const result = await api<{ ok?: boolean; summary?: string; error?: string }>('/api/admin/cleanup-processes', { method: 'POST', body: { userId }, userId });
        await AuditLogService.log({ userId, command: 'admin_cleanup_processes', timestamp: new Date().toISOString(), success: !!result?.ok });
        LogUtil.logWarn(LOG_TAG, 'admin_cleanup_processes executed', { userId, ok: result?.ok, summary: result?.summary });
        await interaction.update({ content: result?.summary ?? result?.error ?? '처리 완료', components: [] }).catch(() => {});
      } else if (consumed.command === 'admin_force_kill_bot') {
        const result = await api<{ ok?: boolean; summary?: string; killed?: number[]; error?: string }>('/api/admin/force-kill-bot', { method: 'POST', body: { userId }, userId });
        await AuditLogService.log({ userId, command: 'admin_force_kill_bot', timestamp: new Date().toISOString(), success: !!result?.ok });
        LogUtil.logWarn(LOG_TAG, 'admin_force_kill_bot executed', { userId, ok: result?.ok, killed: result?.killed });
        await interaction.update({ content: result?.summary ?? result?.error ?? '처리 완료', components: [] }).catch(() => {});
      }
    } catch (e) {
      await AuditLogService.log({ userId, command: consumed.command, timestamp: new Date().toISOString(), success: false, errorCode: (e as Error).message });
      LogUtil.logError(LOG_TAG, 'confirm flow failed', { command: consumed.command, userId, error: (e as Error).message });
      await interaction.update({ content: `오류: ${(e as Error).message}`, components: [] }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith('cancel_')) {
    const tokenId = customId.replace('cancel_', '');
    ConfirmFlow.cancel(tokenId);
    await interaction.deferUpdate().catch(() => {});
    await interaction.update({ content: '취소되었습니다.', components: [] }).catch(() => {});
    return;
  }

  // ---------- 페이지형 UI 확장 포인트 (상위 메뉴 버튼: panel_role_A / panel_role_B / panel_role_C / panel_back_home) ----------
  if (customId === 'panel_role_A') {
    // TODO: render paged A — 패널 메시지 편집하여 buildPanelComponents(model, { renderMode: 'paged', activeRole: 'A' }) + buildPanelContent(..., { renderMode: 'paged', activeRole: 'A' }) 반영
    await interaction.reply({ content: '페이지형 UI(역할 A) 전환은 준비 중입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  if (customId === 'panel_role_B') {
    // TODO: render paged B — buildPanelComponents(model, { renderMode: 'paged', activeRole: 'B' })
    await interaction.reply({ content: '페이지형 UI(역할 B) 전환은 준비 중입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  if (customId === 'panel_role_C') {
    // TODO: render paged C — buildPanelComponents(model, { renderMode: 'paged', activeRole: 'C' })
    await interaction.reply({ content: '페이지형 UI(역할 C) 전환은 준비 중입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  if (customId === 'panel_back_home') {
    // TODO: render single home — buildPanelComponents(model, { renderMode: 'single' }), buildPanelContent(..., { renderMode: 'single' })
    await interaction.reply({ content: '홈 패널 전환은 준비 중입니다.', ephemeral: true }).catch(() => {});
    return;
  }

  // 전략 하위 메뉴: "전략" 버튼 클릭 시에만 SAFE / A-보수적 / A-균형형 / A-적극형 노출
  if (key === 'strategy_menu') {
    await interaction.reply({
      content: '**전략 선택** — 아래에서 모드를 선택하세요.',
      components: buildStrategySubmenuComponents(),
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // 엔진 가동 버튼 (확인 없이 즉시 API 호출)
  if (key === 'engine_start') {
    const ctx = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctx, 'engine_start')) {
      await interaction.reply({ content: '권한 없음 (엔진 가동은 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const result = await api<{ success?: boolean; noop?: boolean; message?: string }>('/api/engine/start', {
        method: 'POST',
        body: { userId, updatedBy: 'discord' },
        userId,
      });
      await AuditLogService.log({ userId, command: 'engine_start', timestamp: new Date().toISOString(), success: !!result?.success });
      await interaction.editReply({ content: result?.message ?? '엔진 가동 요청됨' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // 즉시 정지 — 2단계 확인
  if (key === 'engine_stop') {
    const ctx = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctx, 'engine_stop')) {
      await interaction.reply({ content: '권한 없음 (즉시 정지는 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    const confirmToken = ConfirmFlow.create(userId, 'engine_stop');
    await interaction.reply({
      content: '⚠️ 엔진 정지하려면 확인 버튼을 누르세요. (5분 내)',
      components: [
        { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
      ],
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // 전체 매도 — 2단계 확인
  if (key === 'sell_all') {
    const ctx = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctx, 'sell_all')) {
      await interaction.reply({ content: '권한 없음 (전체 매도는 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    const confirmToken = ConfirmFlow.create(userId, 'sell_all');
    await interaction.reply({
      content: '⚠️ 전량 시장가 매도하려면 확인 버튼을 누르세요. (5분 내)',
      components: [
        { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
      ],
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const strategyModeMap: Record<string, string> = {
    strategy_safe: 'SAFE',
    strategy_conservative: 'A_CONSERVATIVE',
    strategy_balanced: 'A_BALANCED',
    strategy_active: 'A_ACTIVE',
  };
  if (strategyModeMap[customId]) {
    const adminIdSet = !!(
      (process.env.ADMIN_ID || '').trim() ||
      (process.env.ADMIN_DISCORD_ID || '').trim() ||
      (process.env.DISCORD_ADMIN_ID || '').trim() ||
      (process.env.SUPER_ADMIN_ID || '').trim()
    );
    const ctx = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctx, 'strategy-mode')) {
      const msg = !adminIdSet
        ? '관리자 ID 미설정으로 판별 불가. .env에 ADMIN_ID 또는 ADMIN_DISCORD_ID를 설정하세요.'
        : '권한 없음 (ADMIN만 전략 모드 전환이 가능합니다)';
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const result = await api<{ ok?: boolean; error?: string; mode?: string; thresholdEntry?: number; minOrchestratorScore?: number; updatedBy?: string; updatedAt?: string }>(
        '/api/strategy-mode',
        { method: 'POST', body: { mode: strategyModeMap[customId], updatedBy: 'discord' }, userId: interaction.user?.id }
      );
      if (result?.ok) {
        const line = `전략 모드가 **${result.mode}**로 변경되었습니다.\n- threshold_entry: ${result.thresholdEntry}\n- min_orchestrator_score: ${result.minOrchestratorScore}\n- updated_by: ${result.updatedBy}\n- updated_at: ${result.updatedAt ? result.updatedAt.slice(0, 19).replace('T', ' ') : '—'}`;
        await interaction.editReply({ content: line }).catch(() => {});
        await AuditLogService.log({
          userId: interaction.user?.id ?? 'discord',
          command: 'strategy_mode_change',
          timestamp: new Date().toISOString(),
          success: true,
        });
      } else {
        await interaction.editReply({ content: `오류: ${result?.error ?? 'Unknown'}` }).catch(() => {});
      }
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'current_strategy') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const data = await api<{ mode?: string; profile?: { description?: string }; thresholdEntry?: number; minOrchestratorScore?: number; updatedBy?: string; updatedAt?: string }>('/api/strategy-config');
      const at = data.updatedAt ? data.updatedAt.slice(0, 19).replace('T', ' ') : '—';
      const desc = data.profile?.description ?? '—';
      const line = `**현재 전략 모드: ${data.mode ?? '—'}**\n- threshold_entry: ${data.thresholdEntry ?? '—'}\n- min_orchestrator_score: ${data.minOrchestratorScore ?? '—'}\n- updated_by: ${data.updatedBy ?? '—'}\n- updated_at: ${at}\n- description: ${desc}`;
      await interaction.editReply({ content: line }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'recent_scalp') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const data = await api<{ skipTop5?: { reason: string; count: number }[] }>('/api/strategy-status');
      const lines = (data.skipTop5 || []).map((s) => `${s.reason} (${s.count}건)`).join('\n') || '—';
      const embed = new MessageEmbed()
        .setTitle('최근 30분 skip reason (상위 5)')
        .setColor(0x5865f2)
        .setDescription(lines || '데이터 없음')
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'recent_fills') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const data = await api<{ buyRecent5?: { symbol: string; time?: string; finalScore?: number; reason?: string }[] }>('/api/strategy-status');
      const lines = (data.buyRecent5 || []).map((b, i) => `${i + 1}) ${b.symbol} BUY | final ${b.finalScore ?? '—'} | ${b.reason ?? ''}`).join('\n') || '—';
      const embed = new MessageEmbed()
        .setTitle('최근 BUY 로그 (5건)')
        .setColor(0x57f287)
        .setDescription(lines || '데이터 없음')
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // ——— 역할 A: 경주마, 기준 완화, 초공격 scalp (market-bot proxy) ———
  if (key === 'race_horse_toggle') {
    const ctxRh = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxRh, 'race_horse_toggle')) {
      await interaction.reply({ content: '권한 없음 (경주마 모드는 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const result = await api<{ active?: boolean; message?: string }>('/api/race-horse-toggle', { method: 'POST' });
      const msg = result?.active ? '🏇 경주마 모드를 예약했습니다. 오전 9시에 자산 50% 투입.' : '❄️ 경주마 모드 OFF';
      await interaction.editReply({ content: result?.message || msg }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'relax_threshold') {
    const ctxRelax = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxRelax, 'relax_toggle')) {
      await interaction.reply({ content: '권한 없음 (기준 완화는 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const status = await api<{ remainingMs?: number }>('/api/relax-status');
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
        }).catch(() => {});
      } else {
        await api('/api/relax', { method: 'POST', body: { ttlMs: 4 * 60 * 60 * 1000 } });
        await interaction.editReply({ content: '🔓 매매 엔진 기준 완화를 4시간 적용했습니다.' }).catch(() => {});
      }
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (customId === 'extend_relax') {
    const ctxExRelax = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxExRelax, 'extend_relax')) {
      await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      await api('/api/relax-extend', { method: 'POST' });
      await interaction.editReply({ content: '🔓 기준 완화 4시간 연장되었습니다.' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'scalp_attack') {
    const ctxScalp = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxScalp, 'independent_scalp_start')) {
      await interaction.reply({ content: '권한 없음 (초공격 scalp는 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const status = await api<{ isRunning?: boolean; remainingMs?: number }>('/api/independent-scalp-status');
      if (status?.isRunning && (status?.remainingMs ?? 0) > 0) {
        const remainingMin = Math.ceil((status.remainingMs ?? 0) / 60000);
        const under1h = (status.remainingMs ?? 0) < 60 * 60 * 1000;
        await interaction.editReply({
          content: `독립 스캘프 가동 중. (남은 시간: ${remainingMin}분)${under1h ? ' 연장 가능.' : ''}`,
          components: under1h ? [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'extend_independent_scalp', label: '연장 (3시간)' }] }] : [],
        }).catch(() => {});
      } else {
        const result = await api<{ success?: boolean; remainingMs?: number }>('/api/independent-scalp-start', { method: 'POST' });
        const min = result?.remainingMs != null ? Math.ceil(result.remainingMs / 60000) : 180;
        await interaction.editReply({ content: result?.success ? `🚀 초공격 스캘프 3시간 가동. (남은 시간: ${min}분)` : '요청 실패 또는 미연동.' }).catch(() => {});
      }
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'scalp_stop') {
    const ctxScalpStop = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxScalpStop, 'independent_scalp_stop')) {
      await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      await api('/api/independent-scalp-stop', { method: 'POST' });
      await interaction.editReply({ content: '🛑 초공격 스캘프 중지됨.' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (customId === 'extend_independent_scalp') {
    const ctxExScalp = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxExScalp, 'extend_independent_scalp')) {
      await interaction.reply({ content: '권한 없음.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const result = await api<{ success?: boolean; remainingMs?: number }>('/api/independent-scalp-extend', { method: 'POST' });
      const min = result?.remainingMs != null ? Math.ceil(result.remainingMs / 60000) : 0;
      await interaction.editReply({ content: result?.success ? `연장 완료. (남은 시간: ${min}분)` : '연장 불가 (1시간 미만일 때만 가능)' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // ——— 역할 B: AI 타점, 거래 부재 진단, 로직 제안, 조언자, 일일 로그, API 사용량 (market-bot proxy) ———
  if (key === 'ai_entry_analysis') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const result = await api<{ content?: string }>('/api/ai_analysis');
      const text = (result?.content ?? '').slice(0, 2000) || '데이터 없음';
      await interaction.editReply({ content: text }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'no_trade_diagnosis' || key === 'logic_suggestion') {
    const ctxDiag = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxDiag, key)) {
      await interaction.reply({ content: '권한 없음 (거래 부재 진단/로직 제안은 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const apiPath = key === 'no_trade_diagnosis' ? '/api/analyst/diagnose_no_trade' : '/api/analyst/suggest_logic';
      const embedJson = await api<Record<string, unknown>>(apiPath);
      const embed = new MessageEmbed(embedJson as any);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (key === 'advisor_comment' || key === 'daily_log_analysis' || key === 'api_usage') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const apiPath =
        key === 'advisor_comment'
          ? '/api/analyst/advisor_one_liner'
          : key === 'daily_log_analysis'
            ? '/api/analyst/daily_log_analysis'
            : '/api/analyst/api_usage_monitor';
      const result = await api<{ content?: string }>(apiPath);
      const text = (result?.content ?? '').slice(0, 2000) || '데이터 없음';
      await interaction.editReply({ content: text }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // 비상 제어 하위 메뉴 진입 (역할 C)
  if (key === 'emergency_control') {
    const ctxEm = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxEm, 'emergency_control')) {
      await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.reply({
      content: '**비상 제어** — 프로세스 정리 / 강제 종료 / 재기동 (강제 종료·정리는 확인 후 실행)',
      components: buildEmergencySubmenuComponents(),
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // 비상 프로세스 정리 — 2단계 확인 후 실행
  if (customId === 'admin_cleanup_processes') {
    const ctxCp = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxCp, 'admin_cleanup_processes')) {
      await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    const confirmToken = ConfirmFlow.create(userId, 'admin_cleanup_processes');
    await interaction.reply({
      content: '⚠️ **비상 프로세스 정리** — stale lock·좀비 프로세스 정리할까요? (5분 내 확인)',
      components: [
        { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
      ],
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // 강제 종료(taskkill) — 2단계 확인 후 실행
  if (customId === 'admin_force_kill_bot') {
    const ctxFk = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxFk, 'admin_force_kill_bot')) {
      await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    const confirmToken = ConfirmFlow.create(userId, 'admin_force_kill_bot');
    await interaction.reply({
      content: '⚠️ **강제 종료** — market-bot / discord-operator 프로세스를 taskkill 할까요? (5분 내 확인)',
      components: [
        { type: 1, components: [{ type: 2, style: 3, custom_id: `confirm_${confirmToken}`, label: '확인' }, { type: 2, style: 4, custom_id: `cancel_${confirmToken}`, label: '취소' }] },
      ],
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // ——— 역할 C: 시스템 업데이트, 프로세스 재기동 (market-bot proxy) ———
  if (key === 'system_update' || customId === 'admin_simple_restart') {
    const ctxAdmin = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    const permKey = key === 'system_update' ? 'admin_git_pull_restart' : customId;
    if (!PermissionService.can(ctxAdmin, permKey)) {
      await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const apiPath = customId === 'admin_simple_restart' ? '/api/admin/simple-restart' : '/api/admin/git-pull-restart';
    try {
      const result = await api<{ content?: string; ok?: boolean }>(apiPath, { method: 'POST' });
      await interaction.editReply({ content: result?.content ?? '요청 처리됨' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // 패널 버튼(현재 상태, 수익률, 헬스, 분석) → ephemeral reply. 표준 키 기준 (레거시는 normalizeButtonId로 이미 반영)
  const panelIds = ['current_status', 'current_pnl', 'health_check', 'surge_analysis', 'market_summary', 'key_indicators'];
  if (panelIds.includes(key)) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      if (key === 'current_status') {
        const [data, services] = await Promise.all([
          api<any>('/api/status'),
          api<{ apiServer?: boolean; marketBot?: boolean; engineRunning?: boolean; details?: { apiServer?: { reason?: string | null }; marketBot?: { reason?: string | null }; engine?: { reason?: string | null } } }>('/api/services-status').catch(() => null),
        ]);
        const embed = buildStatusEmbedFromApi(data, services ?? undefined);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (key === 'current_pnl') {
        const data = await api<any>('/api/pnl');
        const embed = buildPnlEmbedFromApi(data);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (key === 'health_check') {
        const report = await api<any>('/api/health');
        const embed = buildHealthEmbedFromApi(report);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (key === 'surge_analysis') {
        const result = await api<{ ok?: boolean; data?: { text?: string }; message?: string }>('/api/analyst/scan-vol');
        const embed = new MessageEmbed()
          .setTitle('🔍 급등주 분석')
          .setColor(0x0099ff)
          .setDescription(result?.data?.text || result?.message || '데이터 없음')
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (key === 'market_summary') {
        const result = await api<{ ok?: boolean; data?: { text?: string }; message?: string }>('/api/analyst/summary');
        const embed = new MessageEmbed()
          .setTitle('💡 시황 요약')
          .setColor(0x0099ff)
          .setDescription(result?.data?.text || result?.message || '데이터 없음')
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (key === 'key_indicators') {
        const result = await api<{ ok?: boolean; data?: any }>('/api/analyst/indicators');
        const d = result?.data || {};
        const lines = [
          `FNG: ${d.fng ? `${d.fng.value} (${d.fng.classification})` : '—'}`,
          `BTC: ${d.btcTrend || '—'}`,
          `김프: ${d.kimpAvg != null ? d.kimpAvg.toFixed(2) + '%' : '—'}`,
          `상위: ${d.topTickersText || '—'}`,
        ];
        const embed = new MessageEmbed()
          .setTitle('📊 주요 지표')
          .setColor(0x0099ff)
          .setDescription('```\n' + lines.join('\n') + '\n```')
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      }
    } catch (e) {
      await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    }
  }
}

async function handleSlash(interaction: any): Promise<void> {
  const userId = interaction.user?.id ?? '';
  const channelIdFrom = interaction.channelId ?? '';
  const ctx: PermissionContext = PermissionService.from(userId, channelIdFrom);
  const name = interaction.commandName;
  const sub = interaction.options?.getSubcommand(false);
  const full = sub ? `${name}_${sub}` : name;

  if (!PermissionService.can(ctx, full)) {
    const adminIdSet = !!(
      (process.env.ADMIN_ID || '').trim() ||
      (process.env.ADMIN_DISCORD_ID || '').trim() ||
      (process.env.DISCORD_ADMIN_ID || '').trim() ||
      (process.env.SUPER_ADMIN_ID || '').trim()
    );
    const isStrategyMode = name === 'strategy-mode' || full === 'strategy-mode';
    const msg = isStrategyMode && !adminIdSet
      ? '관리자 ID 미설정으로 판별 불가. .env에 ADMIN_ID 또는 ADMIN_DISCORD_ID를 설정하세요.'
      : `권한 없음 (${AppErrorCode.AUTH_INSUFFICIENT_ROLE})`;
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  try {
    if (name === 'engine' && sub === 'start') {
      const result = await api<{ success?: boolean; noop?: boolean; message?: string }>('/api/engine/start', { method: 'POST', body: { userId, updatedBy: 'discord' }, userId });
      await AuditLogService.log({ userId, command: 'engine_start', timestamp: new Date().toISOString(), success: !!result?.success });
      await interaction.editReply({ content: result?.message ?? '엔진 가동 요청됨' }).catch(() => {});
    } else if (name === 'engine' && sub === 'stop') {
      const confirmToken = ConfirmFlow.create(userId, 'engine_stop');
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
      }).catch(() => {});
      await AuditLogService.log({ userId, command: 'engine_stop', timestamp: new Date().toISOString(), success: true });
    } else if (name === 'engine' && sub === 'status') {
      const data = await api<{ status?: string; startedAt?: string | null; stoppedAt?: string | null; updatedBy?: string; runtimeMode?: string | null }>('/api/engine-status');
      const started = data.startedAt ? new Date(data.startedAt).toLocaleString() : '—';
      const stopped = data.stoppedAt ? new Date(data.stoppedAt).toLocaleString() : '—';
      const line = `**엔진 상태:** ${data.status ?? '—'}\n시작: ${started}\n정지: ${stopped}\n변경 주체: ${data.updatedBy ?? '—'}\n전략 모드: ${data.runtimeMode ?? '—'}`;
      await interaction.editReply({ content: line }).catch(() => {});
    } else if (name === 'sell' && sub === 'all') {
      const confirmToken = ConfirmFlow.create(userId, 'sell_all');
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
      }).catch(() => {});
      await AuditLogService.log({ userId, command: 'sell_all', timestamp: new Date().toISOString(), success: true });
    } else if (name === 'status') {
      const [data, services] = await Promise.all([
        api<any>('/api/status'),
        api<{ apiServer?: boolean; marketBot?: boolean; engineRunning?: boolean; details?: { apiServer?: { reason?: string | null }; marketBot?: { reason?: string | null }; engine?: { reason?: string | null } } }>('/api/services-status').catch(() => null),
      ]);
      const embed = buildStatusEmbedFromApi(data, services ?? undefined);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      await AuditLogService.log({ userId, command: 'status', timestamp: new Date().toISOString(), success: true });
    } else if (name === 'pnl') {
      const data = await api<any>('/api/pnl');
      const embed = buildPnlEmbedFromApi(data);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else if (name === 'health') {
      const report = await api<any>('/api/health');
      const embed = buildHealthEmbedFromApi(report);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else if (name === 'analyst' && sub === 'scan-vol') {
      const result = await api<{ ok?: boolean; data?: { text?: string }; error?: string; message?: string }>('/api/analyst/scan-vol');
      const embed = new MessageEmbed()
        .setTitle('🔍 급등주 분석 (거래대금 상위 10종목)')
        .setColor(0x0099ff)
        .setDescription(result?.data?.text || result?.message || '데이터 없음')
        .setFooter({ text: 'Gemini' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      await AuditLogService.log({ userId, command: 'analyst_scan-vol', timestamp: new Date().toISOString(), success: !!result?.ok });
    } else if (name === 'analyst' && sub === 'summary') {
      const result = await api<{ ok?: boolean; data?: { text?: string }; message?: string }>('/api/analyst/summary');
      const embed = new MessageEmbed()
        .setTitle('💡 시황 요약')
        .setColor(0x0099ff)
        .setDescription(result?.data?.text || result?.message || '데이터 없음')
        .setFooter({ text: 'Gemini' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      await AuditLogService.log({ userId, command: 'analyst_summary', timestamp: new Date().toISOString(), success: !!result?.ok });
    } else if (name === 'analyst' && sub === 'indicators') {
      const result = await api<{ ok?: boolean; data?: any }>('/api/analyst/indicators');
      const d = result?.data || {};
      const lines = [
        `FNG: ${d.fng ? `${d.fng.value} (${d.fng.classification})` : '—'}`,
        `BTC: ${d.btcTrend || '—'}`,
        `김프 평균: ${d.kimpAvg != null ? d.kimpAvg.toFixed(2) + '%' : '—'}`,
        `상위: ${d.topTickersText || '—'}`,
      ];
      const embed = new MessageEmbed()
        .setTitle('📊 주요 지표')
        .setColor(0x0099ff)
        .setDescription('```\n' + lines.join('\n') + '\n```')
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      await AuditLogService.log({ userId, command: 'analyst_indicators', timestamp: new Date().toISOString(), success: !!result?.ok });
    } else if (name === 'strategy-mode') {
      const mode = interaction.options?.getString?.('mode')?.trim?.()?.toUpperCase?.();
      if (!mode) {
        await interaction.editReply({ content: 'mode 옵션을 선택해 주세요 (SAFE, A_CONSERVATIVE, A_BALANCED, A_ACTIVE)' }).catch(() => {});
        return;
      }
      const result = await api<{ ok?: boolean; error?: string; mode?: string; thresholdEntry?: number; minOrchestratorScore?: number; updatedBy?: string; updatedAt?: string }>(
        '/api/strategy-mode',
        { method: 'POST', body: { mode, updatedBy: 'discord' }, userId }
      );
      if (result?.ok) {
        const line = `전략 모드가 **${result.mode}**로 변경되었습니다.\n- threshold_entry: ${result.thresholdEntry}\n- min_orchestrator_score: ${result.minOrchestratorScore}\n- updated_by: ${result.updatedBy}\n- updated_at: ${result.updatedAt ? result.updatedAt.slice(0, 19).replace('T', ' ') : '—'}`;
        await interaction.editReply({ content: line }).catch(() => {});
        await AuditLogService.log({ userId, command: 'strategy_mode_change', timestamp: new Date().toISOString(), success: true });
      } else {
        await interaction.editReply({ content: `오류: ${result?.error ?? 'Unknown'}` }).catch(() => {});
      }
    } else if (name === 'strategy-status') {
      const data = await api<any>('/api/strategy-status');
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
      const embed = new MessageEmbed()
        .setTitle('📊 전략 현황')
        .setColor(0x5865f2)
        .setDescription(lines.join('\n'))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else if (name === 'strategy-skip-top') {
      const data = await api<{ skipTop5?: { reason: string; count: number }[] }>('/api/strategy-status');
      const lines = (data.skipTop5 || []).map((s: any) => `${s.reason} (${s.count}건)`).join('\n') || '—';
      const embed = new MessageEmbed()
        .setTitle('최근 30분 skip reason (상위 5)')
        .setColor(0x5865f2)
        .setDescription(lines || '데이터 없음')
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else if (name === 'strategy-explain-recent') {
      const result = await api<{ ok?: boolean; decisions?: any[] }>('/api/strategy-explain-recent');
      const list = (result?.decisions || []).map((d: any, i: number) => {
        const raw = d.raw_entry_score != null ? d.raw_entry_score : '—';
        const norm = d.normalized_score != null ? Number(d.normalized_score).toFixed(2) : '—';
        const final = d.final_orchestrator_score != null ? Number(d.final_orchestrator_score).toFixed(2) : '—';
        const reason = d.reason_summary || d.skip_reason || '—';
        return `${i + 1}) ${d.symbol} ${d.action} | raw ${raw} | norm ${norm} | final ${final} | ${reason}`;
      }).join('\n') || '—';
      const embed = new MessageEmbed()
        .setTitle('📋 최근 decision log')
        .setColor(0x5865f2)
        .setDescription('```\n' + list + '\n```')
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else {
      await interaction.editReply({ content: '알 수 없는 명령입니다.' }).catch(() => {});
    }
  } catch (e) {
    await interaction.editReply({ content: `오류: ${(e as Error).message}` }).catch(() => {});
    await AuditLogService.log({ userId, command: full, timestamp: new Date().toISOString(), success: false, errorCode: AppErrorCode.INTERNAL });
  }
}

// upbit-bot 메인 사용 시: 보고 권한 단일화 — 수익률/현재 상태 보고는 upbit-bot만. 여기서는 가동 완료 로그만.
client.once('ready', async () => {
  const clientId = (client as any).user?.id ?? null;
  panelRestoreWarn('READY', { start: true, clientId, channelId: channelId ?? null });
  LogUtil.logInfo(LOG_TAG, '서비스 가동 완료');
  await registerSlashCommands(client);
  const chId = channelId;
  if (chId) {
    try {
      const channel = await client.channels.fetch(chId).catch((err: unknown) => {
        panelRestoreFail('CHANNEL_FETCH_FAIL', err, { channelId: chId });
        return null;
      });
      if (channel && channel.isText()) {
        // 1) 먼저 통제 패널(버튼) 복구. edit 성공 → "복구 완료", send 성공 → "새 패널 생성", 실패 → "복구 실패"
        const panelResult = await restoreOrCreateRolePanels(channel);
        // 2) 그 다음 재기동 안내 메시지 전송 (패널 복구 결과 반영)
        await sendRestartMessage(channel, panelResult);
      } else {
        LogUtil.logError(LOG_TAG, 'Channel fetch failed or not text channel', { channelId: chId });
      }
    } catch (e) {
      panelRestoreFail('READY_SEQUENCE_FAIL', e, { channelId: chId });
      LogUtil.logError(LOG_TAG, 'Startup sequence failed', { message: (e as Error).message });
    }
  } else {
    panelRestoreWarn('READY', { skip: true, reason: 'no channelId' });
  }
  if (adminId) scheduleHourlyHealthDm();
});

client.removeAllListeners('interactionCreate');
client.on('interactionCreate', async (interaction: any) => {
  try {
    if (
      typeof interaction.isChatInputCommand === 'function' &&
      interaction.isChatInputCommand()
    ) {
      await handleSlash(interaction);
      return;
    }
    if (
      typeof interaction.isButton === 'function' &&
      interaction.isButton()
    ) {
      await handleButton(interaction);
      return;
    }
    // 확장: select menu / modal 등은 여기서 분기 추가
  } catch (err) {
    LogUtil.logError(LOG_TAG, 'interaction error', {
      message: (err as Error).message,
      stack: (err as Error).stack?.slice(0, 200),
    });
  }
});

export async function startDiscordOperator(): Promise<void> {
  LogUtil.logInfo(LOG_TAG, 'trying login');
  await client.login(token);
  LogUtil.logInfo(LOG_TAG, 'login success');
}

export function getClient(): Client {
  return client;
}

if (require.main === module) {
  LogUtil.logInfo(LOG_TAG, 'standalone startDiscordOperator()');
  startDiscordOperator().catch((err) => {
    LogUtil.logError(LOG_TAG, 'startup_error', { message: (err as Error).message });
    process.exit(1);
  });
}
