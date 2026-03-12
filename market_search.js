/**
 * MarketSearchEngine — 시황 분석 전용 Discord 봇 (매매 봇과 토큰 분리)
 * PM2: pm2 start market_search.js --name "MarketSearchEngine"
 *
 * 봇 인스턴스 독립성:
 * - 이 파일만의 Client 1개 생성, 토큰은 MARKET_BOT_TOKEN 또는 MARKET_SEARCH_ENGINE_TOKEN만 참조.
 * - server.js(매매 봇)는 DISCORD_TOKEN/DISCORD_BOT_TOKEN 사용·별도 Client → 환경 변수 충돌 없음.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function marketSearchLog(tag, detail) {
  const msg = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
  console.warn(`[MARKET_SEARCH][${tag}] ${msg}`);
}

// [MARKET_SEARCH][PROCESS_ERROR] — process-level 예외 (가장 먼저 등록)
process.on('unhandledRejection', (reason, promise) => {
  marketSearchLog('PROCESS_ERROR', { type: 'unhandledRejection', reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  marketSearchLog('PROCESS_ERROR', {
    type: 'uncaughtException',
    name: err?.name,
    message: err?.message,
    stack: err?.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : undefined,
  });
});
process.on('warning', (warn) => {
  marketSearchLog('PROCESS_ERROR', { type: 'warning', name: warn?.name, message: warn?.message });
});

const ADMIN_ID_BACKUP = '1435995084754649260';
const effectiveAdminId = process.env.ADMIN_ID || ADMIN_ID_BACKUP;
console.log('[Check] ADMIN_ID loaded:', effectiveAdminId ? 'Yes' : 'No');

const token =
  process.env.MARKET_BOT_TOKEN ||
  process.env.MARKET_SEARCH_ENGINE_TOKEN;
if (process.env.DISCORD_TOKEN && !token) {
  console.warn('[MarketSearchEngine] DISCORD_TOKEN은 매매 봇용입니다. 시황 봇에는 MARKET_BOT_TOKEN을 .env에 넣으세요.');
}

// [MARKET_SEARCH][BOOT]
marketSearchLog('BOOT', {
  pid: process.pid,
  cwd: process.cwd(),
  __filename: __filename,
  nodeVersion: process.version,
  argv: process.argv,
  hasDiscordToken: !!token,
  tokenPrefix: token ? token.slice(0, 8) + '...' : '',
});

console.log('[Analyst] Attempting to login with Token length:', process.env.MARKET_BOT_TOKEN?.length ?? 'N/A');
console.log('[Analyst] Using token length:', token?.length ?? 0);

if (!token) {
  console.error('[MarketSearchEngine] MARKET_BOT_TOKEN 또는 MARKET_SEARCH_ENGINE_TOKEN이 .env에 없습니다.');
  process.exit(1);
}

// discord.js v13 (package.json ^13.17.1): MessageEmbed, MessageActionRow, MessageButton, 이벤트 문자열 사용
const Discord = require('discord.js');
const Client = Discord.Client;
const ClientReadyEvent = 'ready';
const InteractionCreateEvent = 'interactionCreate';
const GatewayIntentBits = Discord.GatewayIntentBits || { Guilds: 1, GuildMessages: 512, MessageContent: 32768 };
const MessageEmbed = Discord.MessageEmbed;
const MessageActionRow = Discord.MessageActionRow;
const MessageButton = Discord.MessageButton;
const ButtonStyles = (Discord.MessageButton && Discord.MessageButton.Styles) || { PRIMARY: 1 };
if (typeof MessageEmbed !== 'function' || typeof MessageActionRow !== 'function' || typeof MessageButton !== 'function') {
  console.error('[MarketSearchEngine] discord.js v13 필요: MessageEmbed, MessageActionRow, MessageButton이 없습니다. npm install discord.js@13');
  process.exit(1);
}

const axios = require('axios');

const intentBits = GatewayIntentBits.Guilds != null ? GatewayIntentBits : { Guilds: 1, GuildMessages: 512, MessageContent: 32768 };
const intents = [intentBits.Guilds, intentBits.GuildMessages, intentBits.MessageContent].filter((n) => n != null && !isNaN(n));

const client = new Client({
  intents: intents.length ? intents : [intentBits.Guilds || 1]
});

client.on('error', (err) => console.error('[Analyst Error]', err));
client.on('debug', (info) => console.log('[Analyst Debug]', info));

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const GOOGLE_TRENDS_URL = process.env.GOOGLE_TRENDS_URL || '';

/** 구글 트렌드 등 외부 API: Content-Type이 application/json이 아니면 parse 시도 없이 null 반환 (HTML/429 방어) */
async function fetchGoogleTrends() {
  if (!GOOGLE_TRENDS_URL) return null;
  try {
    const response = await axios.get(GOOGLE_TRENDS_URL, { timeout: 15000, validateStatus: () => true });
    const ct = (response.headers && response.headers['content-type']) || '';
    if (!ct.includes('application/json')) {
      console.error('[GoogleTrends_Error] Invalid Content-Type: Received HTML or non-JSON');
      return null;
    }
    if (response.status !== 200) {
      console.error('[GoogleTrends_Error] status=' + response.status);
      return null;
    }
    return response.data;
  } catch (error) {
    console.error('[GoogleTrends_Error]', error?.message);
    return null;
  }
}

async function fetchAnalystEmbed(action) {
  const url = `${DASHBOARD_URL}/api/analyst/${action}`;
  const res = await axios.get(url, { timeout: 15000 });
  const ct = (res.headers && res.headers['content-type']) || '';
  if (!ct.includes('application/json')) {
    console.error('[Analyst] Invalid Content-Type (HTML 등): ' + ct);
    return null;
  }
  return res.data;
}

function buildAnalystRow() {
  const style = ButtonStyles.PRIMARY ?? 1;
  const secondary = (Discord.MessageButton && Discord.MessageButton.Styles && Discord.MessageButton.Styles.SECONDARY) ?? 2;
  const row1 = new MessageActionRow();
  row1.addComponents(
    new MessageButton().setCustomId('analyst_scan_vol').setLabel('급등주 분석').setStyle(style).setEmoji('🔍'),
    new MessageButton().setCustomId('analyst_get_prompt').setLabel('시황 요약').setStyle(style).setEmoji('💡'),
    new MessageButton().setCustomId('analyst_major_indicators').setLabel('주요지표').setStyle(style).setEmoji('📈')
  );
  const row2 = new MessageActionRow();
  row2.addComponents(
    new MessageButton().setCustomId('analyst_diagnose_no_trade').setLabel('거래 부재 원인 진단').setStyle(secondary).setEmoji('🔍'),
    new MessageButton().setCustomId('analyst_suggest_logic').setLabel('매매 로직 수정안 제안').setStyle(secondary).setEmoji('💡')
  );
  return [row1, row2];
}

const ONE_HOUR_MS = 60 * 60 * 1000;

client.once(ClientReadyEvent, async () => {
  marketSearchLog('READY', {
    botUserId: client.user?.id ?? null,
    botTag: client.user?.tag ?? null,
    guildCount: client.guilds?.cache?.size ?? 0,
  });
  console.log('[MarketSearchEngine] 서비스 가동 완료');
  const channelId =
    process.env.MARKET_SEARCH_ENGINE_CHANNEL_ID ||
    process.env.MARKET_CHANNEL_ID ||
    process.env.CHANNEL_ID;
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch) {
        const oneMinAgo = Date.now() - 60 * 1000;
        let shouldSend = true;
        try {
          const messages = await ch.messages.fetch({ limit: 25 }).catch(() => null);
          if (messages && messages.size) {
            for (const [, msg] of messages) {
              const fromUs = msg.author && msg.author.id === client.user.id;
              const recent = msg.createdAt && msg.createdAt.getTime() > oneMinAgo;
              const isRestart = /재기동|가동 완료|시스템이 재기동/.test(msg.content || '');
              if (fromUs && recent && isRestart) {
                shouldSend = false;
                console.log('[MarketSearchEngine] 1분 내 재기동 메시지 존재 — 중복 발송 스킵');
                break;
              }
            }
          }
        } catch (_) {}
        if (shouldSend) {
          const analystRows = buildAnalystRow();
          await ch.send({
            content: '✅ MarketSearchEngine 서비스 가동 완료 — 버튼을 눌러 시황·진단을 조회하세요.',
            components: Array.isArray(analystRows) ? analystRows : [analystRows]
          }).catch((e) => console.error('[MarketSearchEngine] 채널 전송 실패:', e?.message));
        }
      }
    } catch (e) {
      console.error('[MarketSearchEngine] 채널 조회 실패:', e?.message);
    }
  }

  if (effectiveAdminId) {
    function sendHealthCheckDm() {
      client.users.fetch(effectiveAdminId).then((user) => user.send('영!차!')).then(() => {
        console.log('[MarketSearchEngine] 1시간 헬스체크 DM 전송 (영!차!)');
      }).catch((e) => console.warn('[MarketSearchEngine] 헬스체크 DM 실패:', e?.message));
    }
    setInterval(sendHealthCheckDm, ONE_HOUR_MS);
    setTimeout(sendHealthCheckDm, ONE_HOUR_MS);
    console.log('[MarketSearchEngine] 1시간 헬스체크 예약됨 (관리자 DM: 영!차!)');
  }
});

client.removeAllListeners(InteractionCreateEvent);
client.on(InteractionCreateEvent, async (interaction) => {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;
  if (!customId || !customId.startsWith('analyst_')) return;

  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  if (customId === 'analyst_diagnose_no_trade' || customId === 'analyst_suggest_logic') {
    const userId = interaction.user?.id;
    if (effectiveAdminId && userId !== effectiveAdminId) {
      await interaction.editReply({ content: '관리자만 사용할 수 있습니다.' }).catch(() => {});
      return;
    }
  }

  const actionMap = {
    analyst_scan_vol: 'scan_vol',
    analyst_get_prompt: 'get_prompt',
    analyst_major_indicators: 'major_indicators',
    analyst_diagnose_no_trade: 'diagnose_no_trade',
    analyst_suggest_logic: 'suggest_logic'
  };
  const action = actionMap[customId];
  if (!action) {
    await interaction.editReply({ content: '알 수 없는 버튼입니다.' }).catch(() => {});
    return;
  }

  if (action === 'get_prompt') {
    await interaction.editReply({ content: 'Gemini 분석 중...' }).catch(() => {});
  } else if (action === 'diagnose_no_trade' || action === 'suggest_logic') {
    await interaction.editReply({ content: '진단/제안 분석 중…' }).catch(() => {});
  }

  try {
    const adminQ = (action === 'diagnose_no_trade' || action === 'suggest_logic') && effectiveAdminId ? '?admin_id=' + encodeURIComponent(effectiveAdminId) : '';
    const url = `${DASHBOARD_URL}/api/analyst/${action}${adminQ}`;
    const res = await axios.get(url, { timeout: 30000, validateStatus: () => true });
    const ct = (res.headers && res.headers['content-type']) || '';
    if (!ct.includes('application/json')) {
      console.error('[Analyst] Invalid Content-Type (HTML 등): ' + ct);
      await interaction.editReply({ content: '데이터 일시적 불가 (서버 응답이 JSON이 아님). 잠시 후 다시 시도하세요.' }).catch(() => {});
      return;
    }
    if (res.status !== 200) {
      await interaction.editReply({ content: `서버 오류: ${res.status}` }).catch(() => {});
      return;
    }
    const data = res.data;
    const embed = (data && typeof data === 'object') ? new MessageEmbed(data) : new MessageEmbed().setDescription(String(data || '데이터 없음'));
    await interaction.editReply({ embeds: [embed], content: null }).catch(() => {});
  } catch (err) {
    const msg = err?.response?.data?.error || err?.message || '조회 실패';
    const status = err?.response?.status;
    if (status === 403) {
      await interaction.editReply({ content: '관리자만 사용할 수 있습니다.' }).catch(() => {});
    } else {
      await interaction.editReply({ content: `오류: ${msg}\n(대시보드 서버가 켜져 있는지 확인하세요.)` }).catch(() => {});
    }
  }
});

marketSearchLog('DISCORD_LOGIN][START', {});
console.log('[MarketSearchEngine] 시작 중 (MARKET_BOT_TOKEN 사용)…');
client.login(token).then(() => {
  marketSearchLog('DISCORD_LOGIN][SUCCESS', {});
  console.log('[MarketSearchEngine] 로그인 요청 완료. 온라인 시 "[MarketSearchEngine] 온라인" 로그 확인.');
}).catch((e) => {
  marketSearchLog('DISCORD_LOGIN][FAIL', {
    errorName: e?.name,
    errorMessage: e?.message,
    stack: e?.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : undefined,
  });
  console.error('[MarketSearchEngine] 로그인 실패:', e?.message);
  process.exit(1);
});
