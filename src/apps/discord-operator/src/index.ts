import path from 'path';
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
import { Client, MessageEmbed } from 'discord.js';
const discord = require('discord.js') as any;
const Intents = discord.Intents;
const REST = discord.REST;
const Routes = discord.Routes;
import { EventBus } from '../../../packages/core/src/EventBus';
import { PermissionService } from '../../../packages/core/src/PermissionService';
import { AuditLogService } from '../../../packages/core/src/AuditLogService';
import { HealthReportService } from '../../../packages/core/src/HealthReportService';
import { ConfirmFlow } from '../../../packages/core/src/ConfirmFlow';
import { AppErrorCode } from '../../../packages/shared/src/errors';
import type { PermissionContext } from '../../../packages/shared/src/types';

// 필수: 토큰과 채널 ID만 검증 (DISCORD_OPERATOR_CHANNEL_ID 또는 CHANNEL_ID)
const token = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();
const channelId = (process.env.DISCORD_OPERATOR_CHANNEL_ID || process.env.CHANNEL_ID || '').trim();
if (!token) {
  console.error('[discord-operator] Missing required env: DISCORD_TOKEN or DISCORD_BOT_TOKEN');
  process.exit(1);
}
if (!channelId) {
  console.error('[discord-operator] Missing required env: DISCORD_OPERATOR_CHANNEL_ID or CHANNEL_ID');
  process.exit(1);
}
// DISCORD_CLIENT_ID 미설정 시 ready 후 client.user.id로 슬래시 명령 등록. DISCORD_GUILD_ID 미설정 시 전역 등록(즉시 반영 가능).
if (!process.env.DISCORD_CLIENT_ID?.trim() || !process.env.DISCORD_GUILD_ID?.trim()) {
  if (process.env.DISCORD_OPERATOR_DEBUG === '1') {
    console.log('[discord-operator] DISCORD_CLIENT_ID/GUILD_ID 미설정 — client.user.id로 전역 슬래시 명령 등록');
  }
}
const adminId = (process.env.ADMIN_ID || process.env.DISCORD_ADMIN_ID || '').trim();
const DASHBOARD_URL = (process.env.DASHBOARD_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');

const client = new Client({ intents: [(Intents as any)?.FLAGS?.GUILDS ?? 1] });

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

async function registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: '9' }).setToken(token);
  const commands = [
    {
      name: 'engine',
      description: '엔진 제어',
      options: [
        { type: 1, name: 'start', description: '매매 엔진 가동' },
        { type: 1, name: 'stop', description: '매매 엔진 정지 (2단계 확인)' },
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
  const appId = client.user?.id || process.env.DISCORD_CLIENT_ID;
  if (appId) await rest.put((Routes as any).applicationCommands(appId), { body: commands });
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
      if (user) await user.send({ content: '1시간 헬스체크', embeds: [embed] }).catch((e) => console.warn('[discord-operator] health DM failed', e?.message));
    } catch (e) {
      console.warn('[discord-operator] health check fetch failed', (e as Error).message);
    }
  }
  setInterval(runHealthCheck, ONE_HOUR_MS);
  setTimeout(runHealthCheck, ONE_HOUR_MS);
  console.log('[discord-operator] 1시간 헬스체크 DM 예약됨');
}

// 가동 시 짧은 메시지만 (수익률/현재 상태 보고는 upbit-bot에서만)
async function sendStartupMessage(channel: any): Promise<void> {
  if (startupMessageSent) return;
  try {
    await channel.send({ content: '✅ discord-operator 서비스 가동 완료' });
    startupMessageSent = true;
  } catch (e) {
    console.error('[discord-operator] Startup message send failed:', (e as Error).message);
  }
}

// FIX: Operator / Analyst 패널을 channel.send()로 새로 생성, 기존 메시지 수정 안 함
async function sendOperatorPanel(channel: any): Promise<void> {
  try {
    await channel.send({
      content: '**Operator / Analyst 패널**',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'current_state', label: '현재 상태' },
            { type: 2, style: 1, custom_id: 'current_return', label: '수익률' },
            { type: 2, style: 1, custom_id: 'health', label: '헬스' },
          ],
        },
        {
          type: 1,
          components: [
            { type: 2, style: 2, custom_id: 'analyst_scan_vol', label: '급등주 분석' },
            { type: 2, style: 2, custom_id: 'analyst_get_prompt', label: '시황 요약' },
            { type: 2, style: 2, custom_id: 'analyst_indicators', label: '주요지표' },
          ],
        },
      ],
    });
    await channel.send({
      content: '**전략 모드** (RuntimeStrategyModeService 기준)',
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, custom_id: 'strategy_safe', label: 'SAFE' },
            { type: 2, style: 2, custom_id: 'strategy_conservative', label: 'A-보수적' },
            { type: 2, style: 2, custom_id: 'strategy_balanced', label: 'A-균형형' },
            { type: 2, style: 2, custom_id: 'strategy_active', label: 'A-적극형' },
          ],
        },
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'strategy_view_config', label: '현재전략' },
            { type: 2, style: 2, custom_id: 'strategy_skip_recent', label: '최근스킵' },
            { type: 2, style: 2, custom_id: 'strategy_buy_recent', label: '최근체결' },
          ],
        },
      ],
    });
  } catch (e) {
    console.error('[discord-operator] Operator panel send failed:', (e as Error).message);
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
        await api('/api/engine/stop', { method: 'POST', body: { userId }, userId });
        EventBus.emit('ENGINE_STOPPED', {});
        await AuditLogService.log({ userId, command: 'engine_stop', timestamp: new Date().toISOString(), success: true, approved: true });
        await interaction.update({ content: '엔진이 정지되었습니다.', components: [] }).catch(() => {});
      } else if (consumed.command === 'sell_all') {
        const result = await api<{ success?: boolean; message?: string }>('/api/sell-all', { method: 'POST', body: { userId }, userId });
        await AuditLogService.log({ userId, command: 'sell_all', timestamp: new Date().toISOString(), success: true, approved: true, orderCreated: true });
        await interaction.update({ content: `전체 매도: ${result?.message ?? '완료'}`, components: [] }).catch(() => {});
      }
    } catch (e) {
      await AuditLogService.log({ userId, command: consumed.command, timestamp: new Date().toISOString(), success: false, errorCode: (e as Error).message });
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

  const strategyModeMap: Record<string, string> = {
    strategy_safe: 'SAFE',
    strategy_conservative: 'A_CONSERVATIVE',
    strategy_balanced: 'A_BALANCED',
    strategy_active: 'A_ACTIVE',
  };
  if (strategyModeMap[customId]) {
    const ctx = PermissionService.from(interaction.user?.id ?? '', interaction.channelId ?? '');
    if (!PermissionService.can(ctx, 'strategy-mode')) {
      await interaction.reply({ content: '권한 없음 (ADMIN만 전략 모드 전환이 가능합니다)', ephemeral: true }).catch(() => {});
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
    await interaction.reply({ content: `권한 없음 (${AppErrorCode.AUTH_INSUFFICIENT_ROLE})`, ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  try {
    if (name === 'engine' && sub === 'start') {
      const result = await api<{ success?: boolean; message?: string }>('/api/engine/start', { method: 'POST', body: { userId }, userId });
      EventBus.emit('ENGINE_STARTED', {});
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
  console.log('[discord-operator] 서비스 가동 완료');
  await registerSlashCommands();
  const chId = channelId;
  if (chId) {
    try {
      const channel = await client.channels.fetch(chId).catch(() => null);
      if (channel && channel.isText()) {
        await sendStartupMessage(channel);
        await sendOperatorPanel(channel);
      } else {
        console.error('[discord-operator] Channel fetch failed or not text channel:', chId);
      }
    } catch (e) {
      console.error('[discord-operator] Startup sequence failed:', (e as Error).message);
    }
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
    console.error('[discord-operator]', e);
  }
});

export async function startDiscordOperator(): Promise<void> {
  await client.login(token);
}

export function getClient(): Client {
  return client;
}
