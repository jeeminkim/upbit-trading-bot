import path from 'path';
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

import { Client, MessageEmbed } from 'discord.js';
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

function buildStatusEmbedFromApi(data: {
  assets: any;
  profitSummary: { profitPct: number; totalEval: number; totalBuy: number; krw?: number; orderableKrw?: number };
  strategySummary?: any;
  botEnabled?: boolean;
}): MessageEmbed {
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
  return new MessageEmbed()
    .setTitle('📊 현재 상태')
    .setColor(0x5865f2)
    .addFields(
      { name: '총 평가금액(현재 총자산)', value: Number(totalEval).toLocaleString('ko-KR') + ' 원', inline: true },
      { name: 'KRW 잔고', value: Number(orderableKrw).toLocaleString('ko-KR') + ' 원', inline: true },
      { name: '총 손익률', value: profitPct, inline: true },
      { name: '가동 전략', value: strategyName, inline: false },
      { name: 'RaceHorse(예약) 가중치', value: '```\n' + weightTable + '\n```', inline: false }
    )
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

// --- 패널 UI 모델: 역할 기반 선언형 정의 (1=PRIMARY, 2=SECONDARY, 3=SUCCESS, 4=DANGER) ---
const DISCORD_BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 } as const;

interface PanelButtonSpec {
  custom_id: string;
  label: string;
  style: 1 | 2 | 3 | 4;
}

interface PanelRoleSpec {
  id: string;
  title: string;
  description: string;
  buttons: PanelButtonSpec[];
}

/** 역할별 버튼 정의 — 순서대로 row에 채워짐. row 배치는 ROW_LAYOUT으로 제어 */
const PANEL_ROLES: PanelRoleSpec[] = [
  {
    id: 'A',
    title: '역할 A — 현장 지휘관',
    description: '엔진 제어 · 실시간 상태 · 체결 보고 · 공격/정지/매도',
    buttons: [
      { custom_id: 'engine_start', label: '엔진 가동', style: DISCORD_BUTTON_STYLE.SUCCESS },
      { custom_id: 'engine_stop', label: '즉시 정지', style: DISCORD_BUTTON_STYLE.DANGER },
      { custom_id: 'current_state', label: '현재 상태', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'current_return', label: '현재 수익률', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'sell_all', label: '전체 매도', style: DISCORD_BUTTON_STYLE.DANGER },
      { custom_id: 'race_horse_toggle', label: '경주마 ON/OFF', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'relax_toggle', label: '기준 완화', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'independent_scalp_start', label: '초공격 scalp', style: DISCORD_BUTTON_STYLE.PRIMARY },
      { custom_id: 'independent_scalp_stop', label: 'scalp 중지', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'strategy_menu', label: '전략', style: DISCORD_BUTTON_STYLE.PRIMARY },
      { custom_id: 'strategy_view_config', label: '현재전략', style: DISCORD_BUTTON_STYLE.PRIMARY },
      { custom_id: 'strategy_skip_recent', label: '최근스킵', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'strategy_buy_recent', label: '최근체결', style: DISCORD_BUTTON_STYLE.SECONDARY },
    ],
  },
  {
    id: 'B',
    title: '역할 B — 정보 분석가',
    description: 'AI 타점 · 시황 요약 · 급등주/주요지표 · 거래 부재 진단 · 로직 제안 · 조언 · 로그 분석',
    buttons: [
      { custom_id: 'ai_analysis', label: 'AI 타점 분석', style: DISCORD_BUTTON_STYLE.PRIMARY },
      { custom_id: 'analyst_get_prompt', label: '시황 요약', style: DISCORD_BUTTON_STYLE.PRIMARY },
      { custom_id: 'analyst_scan_vol', label: '급등주 분석', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'analyst_indicators', label: '주요지표', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'analyst_diagnose_no_trade', label: '거래 부재 진단', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'analyst_suggest_logic', label: '로직 수정안 제안', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'analyst_advisor_one_liner', label: '조언자의 한마디', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'daily_log_analysis', label: '하루치 로그 분석', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'api_usage_monitor', label: 'API 사용량', style: DISCORD_BUTTON_STYLE.SECONDARY },
    ],
  },
  {
    id: 'C',
    title: '역할 C — 서버 관리자',
    description: '시스템 업데이트 · 비상 제어 · 헬스 · 프로세스 재기동',
    buttons: [
      { custom_id: 'health', label: '헬스', style: DISCORD_BUTTON_STYLE.SECONDARY },
      { custom_id: 'admin_emergency_menu', label: '비상 제어', style: DISCORD_BUTTON_STYLE.DANGER },
      { custom_id: 'admin_git_pull_restart', label: '시스템 업데이트', style: DISCORD_BUTTON_STYLE.PRIMARY },
    ],
  },
];

/** 각 row를 어떤 역할·몇 개씩 채울지. 5 row × 최대 5버튼. */
const ROW_LAYOUT: { roleId: string; count: number }[][] = [
  [{ roleId: 'A', count: 5 }],
  [{ roleId: 'A', count: 5 }],
  [{ roleId: 'A', count: 3 }, { roleId: 'C', count: 2 }],
  [{ roleId: 'B', count: 5 }],
  [{ roleId: 'B', count: 4 }, { roleId: 'C', count: 1 }],
];

export interface PanelModel {
  roles: PanelRoleSpec[];
  lastUpdatedAt?: string;
}

/** UI 모델 생성 (마지막 갱신 시각 선택) */
function buildPanelModel(lastUpdatedAt?: string): PanelModel {
  return { roles: PANEL_ROLES, lastUpdatedAt };
}

/** 패널 메시지 content — 역할별 제목/설명 + 마지막 갱신 시각 */
function buildPanelContent(model: PanelModel): string {
  const lines: string[] = [];
  if (model.lastUpdatedAt) {
    try {
      const d = new Date(model.lastUpdatedAt);
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const kstStr = kst.toISOString().slice(0, 19).replace('T', ' ');
      lines.push(`🎮 **자동매매 통제 패널** · 마지막 갱신: ${kstStr} KST`);
    } catch (_) {
      lines.push('🎮 **자동매매 통제 패널**');
    }
  } else {
    lines.push('🎮 **자동매매 통제 패널**');
  }
  lines.push('');
  for (const r of model.roles) {
    lines.push(`**${r.title}**`);
    lines.push(r.description);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 역할 인덱스 */
const ROLE_INDEX: Record<string, number> = { A: 0, B: 1, C: 2 };

/** 모델에서 Discord ActionRow[] 생성 (역할 단위 배치). 최대 5 row, row당 5버튼. */
function buildPanelComponents(model: PanelModel): any[] {
  const roles = model.roles;
  const indices: Record<string, number> = { A: 0, B: 0, C: 0 };
  const rows: any[] = [];
  for (const rowSpec of ROW_LAYOUT) {
    const components: any[] = [];
    for (const { roleId, count } of rowSpec) {
      const ri = ROLE_INDEX[roleId];
      const role = ri != null ? roles[ri] : null;
      if (!role) continue;
      let idx = indices[roleId] ?? 0;
      for (let i = 0; i < count && idx < role.buttons.length; i++, idx++) {
        const b = role.buttons[idx];
        components.push({ type: 2, style: b.style, custom_id: b.custom_id, label: b.label });
      }
      indices[roleId] = idx;
    }
    if (components.length > 0) rows.push({ type: 1, components });
    if (rows.length >= 5) break;
  }
  return rows;
}

/** 기존 호환: model 없이 호출 시 기본 모델로 빌드 */
function buildPanelComponentsLegacy(): any[] {
  return buildPanelComponents(buildPanelModel());
}

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

export type PanelRestoreResult = { restored: boolean; mode?: 'edit' | 'new' };

/** 패널 복구/생성: 모델 → content + components 빌드 후 edit 또는 send. 타이밍(ms)·fallback·상태 명시. */
async function restoreOrCreatePanelMessage(channel: any): Promise<PanelRestoreResult> {
  const t0 = Date.now();
  const lastUpdatedAt = new Date().toISOString();
  const model = buildPanelModel(lastUpdatedAt);
  let panelContent: string;
  let components: any[];

  try {
    panelContent = buildPanelContent(model);
  } catch (e) {
    panelRestoreFail('CONTENT_BUILD_FAIL', e, {});
    panelContent = '🎮 **자동매매 통제 패널**\n\n(콘텐츠 생성 오류. 로그 확인.)';
  }

  try {
    components = buildPanelComponents(model);
  } catch (e) {
    panelRestoreFail('COMPONENTS_BUILD_FAIL', e, { willUseFallback: true });
    components = [{ type: 1, components: [{ type: 2, style: 2, custom_id: 'health', label: '헬스' }] }];
  }

  const rows = Array.isArray(components) ? components.length : 0;
  const counts = Array.isArray(components)
    ? components.map((r: any) => (Array.isArray(r?.components) ? r.components.length : 0))
    : [];
  const countsStr = counts.join(',');
  const firstIds = Array.isArray(components)
    ? components.slice(0, 2).map((r: any) => (r?.components?.[0]?.custom_id ?? '—')).join(',')
    : '—';

  const invalidRows = rows > 5 || rows === 0;
  const invalidCounts = counts.some((c: number) => c > 5 || c === 0);
  if (invalidRows || invalidCounts) {
    panelRestoreFail('COMPONENTS_INVALID', new Error('rows or button count out of limit'), { rows, counts: countsStr });
  } else {
    panelRestoreWarn('PANEL_LAYOUT', { rows, counts: countsStr, firstIds });
  }

  const tState = Date.now();
  let panelData: { channelId?: string; panelMessageId?: string; updatedAt?: string } = {};
  try {
    if (fs.existsSync(PANEL_FILE)) {
      const raw = fs.readFileSync(PANEL_FILE, 'utf8');
      panelData = JSON.parse(raw);
      panelRestoreWarn('STATE_LOADED', {
        found: true,
        channelId: panelData.channelId,
        messageId: panelData.panelMessageId,
        updatedAt: panelData.updatedAt ?? null,
        stateLoadMs: Date.now() - tState,
      });
    } else {
      panelRestoreWarn('STATE_LOADED', { found: false, reason: 'no state file', stateLoadMs: Date.now() - tState });
    }
  } catch (e) {
    panelRestoreFail('STATE_LOAD_FAIL', e, { panelFile: PANEL_FILE });
  }

  panelRestoreWarn('PANEL_RESTORE_START', {
    channelId: channel?.id,
    savedPanelMessageId: panelData.panelMessageId ?? null,
    savedChannelId: panelData.channelId ?? null,
    panelFile: PANEL_FILE,
  });

  const dir = path.join(process.cwd(), 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const channelIdMatch = panelData.channelId && String(panelData.channelId) === String(channel.id);
  let hasSavedMessage = !!(panelData.panelMessageId && channelIdMatch);
  if (panelData.panelMessageId && !channelIdMatch) {
    panelRestoreWarn('CHANNEL_MISMATCH', { savedChannelId: panelData.channelId, currentChannelId: channel.id, willSendNew: true });
    hasSavedMessage = false;
  }

  if (hasSavedMessage) {
    const messageId = panelData.panelMessageId!;
    panelRestoreWarn('FETCH_EXISTING', { channelId: channel.id, messageId });
    const tFetch = Date.now();
    let msg: any;
    try {
      msg = await channel.messages.fetch(messageId);
      panelRestoreWarn('FETCH_EXISTING_OK', { messageId, fetchMs: Date.now() - tFetch });
    } catch (e) {
      panelRestoreFail('FETCH_EXISTING_FAIL', e, { messageId, fetchMs: Date.now() - tFetch });
      panelRestoreWarn('MESSAGE_DELETED_OR_INACCESSIBLE', { messageId, willSendNew: true });
      hasSavedMessage = false;
    }
    if (msg) {
      try {
        panelRestoreWarn('EDIT_START', { messageId: msg.id, contentLen: panelContent.length, rows });
        const tEdit = Date.now();
        await msg.edit({ content: panelContent, components });
        panelRestoreWarn('EDIT_OK', { messageId: msg.id, editMs: Date.now() - tEdit });
        try {
          fs.writeFileSync(PANEL_FILE, JSON.stringify({ channelId: channel.id, panelMessageId: msg.id, updatedAt: lastUpdatedAt }));
          panelRestoreWarn('STATE_SAVE_OK', { channelId: channel.id, messageId: msg.id });
        } catch (saveErr) {
          panelRestoreFail('STATE_SAVE_FAIL', saveErr, { after: 'edit', channelId: channel.id, messageId: msg.id });
        }
        panelRestoreWarn('PANEL_RESTORE_DONE', {
          restored: true,
          mode: 'edit',
          panelMessageId: msg.id,
          restoreDurationMs: Date.now() - t0,
        });
        return { restored: true, mode: 'edit' };
      } catch (e) {
        panelRestoreFail('EDIT_FAIL', e, { messageId: msg.id, contentLen: panelContent.length, rows });
      }
    }
  }

  panelRestoreWarn('SEND_NEW_START', { channelId: channel.id, contentLen: panelContent.length, rows });
  try {
    const msg = await channel.send({ content: panelContent, components });
    panelRestoreWarn('SEND_NEW_OK', { messageId: msg.id });
    try {
      fs.writeFileSync(PANEL_FILE, JSON.stringify({ channelId: channel.id, panelMessageId: msg.id, updatedAt: lastUpdatedAt }));
      panelRestoreWarn('STATE_SAVE_OK', { channelId: channel.id, messageId: msg.id });
    } catch (saveErr) {
      panelRestoreFail('STATE_SAVE_FAIL', saveErr, { after: 'send', channelId: channel.id, messageId: msg.id });
    }
    panelRestoreWarn('PANEL_RESTORE_DONE', {
      restored: true,
      mode: 'new',
      panelMessageId: msg.id,
      restoreDurationMs: Date.now() - t0,
    });
    return { restored: true, mode: 'new' };
  } catch (e) {
    panelRestoreFail('SEND_NEW_FAIL', e, { channelId: channel.id, contentLen: panelContent.length, rows });
    panelRestoreWarn('PANEL_RESTORE_DONE', { restored: false, reason: 'send_failed', restoreDurationMs: Date.now() - t0 });
    return { restored: false };
  }
}

/** 재기동 안내 메시지. result에 따라 "패널 복구 완료 / 새 패널 생성 / 복구 실패" 명시 */
async function sendRestartMessage(channel: any, result: PanelRestoreResult): Promise<void> {
  if (startupMessageSent) return;
  const panelStatus =
    result.restored === false
      ? '복구 실패 (로그 확인)'
      : result.mode === 'edit'
        ? '복구 완료'
        : '새 패널 생성';
  panelRestoreWarn('RESTART_MESSAGE', { panelRestored: result.restored, mode: result.mode, panelStatusText: panelStatus });
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
    panelRestoreWarn('RESTART_MESSAGE_SENT', { restartMessageId: restartMsg?.id ?? null, panelRestored: result.restored, panelStatus });
  } catch (e) {
    panelRestoreFail('RESTART_MESSAGE_FAIL', e, { panelRestored: result.restored });
    LogUtil.logError(LOG_TAG, 'Restart message send failed', { message: (e as Error).message });
  }
}

async function handleButton(interaction: any): Promise<void> {
  const userId = interaction.user?.id ?? '';
  const customId = interaction.customId;

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

  // 전략 하위 메뉴: "전략" 버튼 클릭 시에만 SAFE / A-보수적 / A-균형형 / A-적극형 노출
  if (customId === 'strategy_menu') {
    await interaction.reply({
      content: '**전략 선택** — 아래에서 모드를 선택하세요.',
      components: buildStrategySubmenuComponents(),
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  // 엔진 가동 버튼 (확인 없이 즉시 API 호출)
  if (customId === 'engine_start') {
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
  if (customId === 'engine_stop') {
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
  if (customId === 'sell_all') {
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
  if (customId === 'strategy_view_config') {
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
  if (customId === 'strategy_skip_recent') {
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
  if (customId === 'strategy_buy_recent') {
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
  if (customId === 'race_horse_toggle') {
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
  if (customId === 'relax_toggle') {
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
  if (customId === 'independent_scalp_start') {
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
  if (customId === 'independent_scalp_stop') {
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
  if (customId === 'ai_analysis') {
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
  if (customId === 'analyst_diagnose_no_trade' || customId === 'analyst_suggest_logic') {
    const ctxDiag = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxDiag, customId)) {
      await interaction.reply({ content: '권한 없음 (거래 부재 진단/로직 제안은 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const path = customId === 'analyst_diagnose_no_trade' ? '/api/analyst/diagnose_no_trade' : '/api/analyst/suggest_logic';
      const embedJson = await api<Record<string, unknown>>(path);
      const embed = new MessageEmbed(embedJson as any);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }
  if (customId === 'analyst_advisor_one_liner' || customId === 'daily_log_analysis' || customId === 'api_usage_monitor') {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const path =
        customId === 'analyst_advisor_one_liner'
          ? '/api/analyst/advisor_one_liner'
          : customId === 'daily_log_analysis'
          ? '/api/analyst/daily_log_analysis'
          : '/api/analyst/api_usage_monitor';
      const result = await api<{ content?: string }>(path);
      const text = (result?.content ?? '').slice(0, 2000) || '데이터 없음';
      await interaction.editReply({ content: text }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // 비상 제어 하위 메뉴 진입 (역할 C)
  if (customId === 'admin_emergency_menu') {
    const ctxEm = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxEm, 'admin_emergency_menu')) {
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
  if (customId === 'admin_git_pull_restart' || customId === 'admin_simple_restart') {
    const ctxAdmin = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctxAdmin, customId)) {
      await interaction.reply({ content: '권한 없음 (서버 관리자 전용입니다.)', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const path = customId === 'admin_git_pull_restart' ? '/api/admin/git-pull-restart' : '/api/admin/simple-restart';
    try {
      const result = await api<{ content?: string; ok?: boolean }>(path, { method: 'POST' });
      await interaction.editReply({ content: result?.content ?? '요청 처리됨' }).catch(() => {});
    } catch (e) {
      await interaction.editReply({ content: `오류 또는 미연동: ${(e as Error).message}` }).catch(() => {});
    }
    return;
  }

  // FIX: 패널 버튼(현재 상태, 수익률, 헬스, analyst) → ephemeral reply로 결과만 반환, 패널 메시지는 수정 안 함
  const panelIds = ['current_state', 'current_return', 'health', 'analyst_scan_vol', 'analyst_get_prompt', 'analyst_indicators'];
  if (panelIds.includes(customId)) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      if (customId === 'current_state') {
        const data = await api<any>('/api/status');
        const embed = buildStatusEmbedFromApi(data);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (customId === 'current_return') {
        const data = await api<any>('/api/pnl');
        const embed = buildPnlEmbedFromApi(data);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (customId === 'health') {
        const report = await api<any>('/api/health');
        const embed = buildHealthEmbedFromApi(report);
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (customId === 'analyst_scan_vol') {
        const result = await api<{ ok?: boolean; data?: { text?: string }; message?: string }>('/api/analyst/scan-vol');
        const embed = new MessageEmbed()
          .setTitle('🔍 급등주 분석')
          .setColor(0x0099ff)
          .setDescription(result?.data?.text || result?.message || '데이터 없음')
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (customId === 'analyst_get_prompt') {
        const result = await api<{ ok?: boolean; data?: { text?: string }; message?: string }>('/api/analyst/summary');
        const embed = new MessageEmbed()
          .setTitle('💡 시황 요약')
          .setColor(0x0099ff)
          .setDescription(result?.data?.text || result?.message || '데이터 없음')
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      } else if (customId === 'analyst_indicators') {
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
      const data = await api<any>('/api/status');
      const embed = buildStatusEmbedFromApi(data);
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
        const panelResult = await restoreOrCreatePanelMessage(channel);
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
    if (interaction.isButton()) {
      await handleButton(interaction);
    }
    if (interaction.isChatInputCommand()) {
      await handleSlash(interaction);
    }
  } catch (e) {
    LogUtil.logError(LOG_TAG, 'interaction handle error', { message: (e as Error).message });
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
