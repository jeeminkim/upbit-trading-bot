/**
 * Discord 봇 (discord.js v13) - Scalp 엔진 원격 제어 + 체결/오류 알림
 * ADMIN_ID: .env 또는 config에서 로드(server 주입). adminGuard 공통 모듈로 검증
 *
 * 봇 인스턴스: server.js에서 start({ token: apiKeys.discordBotToken }) 호출 시 여기서 Client 1개 생성.
 * token은 항상 DISCORD_TOKEN 또는 DISCORD_BOT_TOKEN (매매 봇 전용). MARKET_BOT_TOKEN은 사용하지 않음.
 */
/** .env·config 모두 없을 때 사용하는 백업 ID (본인 디스코드 사용자 ID로 교체, 공개 저장소에는 빈 문자열 권장) */
const ADMIN_ID_BACKUP = '1435995084754649260';

const adminGuard = require('./adminGuard');
const Discord = require('discord.js');
const { Client, MessageEmbed, MessageActionRow, MessageButton } = Discord;
const Intents = Discord.Intents;
const FLAGS = Intents?.FLAGS || {};
// discord.js v13: Guilds(1), GuildMessages(512), MessageContent(32768) — 없으면 숫자 fallback
const GUILDS = FLAGS.GUILDS ?? 1;
const GUILD_MESSAGES = FLAGS.GUILD_MESSAGES ?? 512;
const MESSAGE_CONTENT = FLAGS.MESSAGE_CONTENT ?? 32768;

let client = null;
let controlChannel = null;
let channelIdStored = null;
/** [📊 현재 상태] 라이브 메시지 ID — emitDashboard 시 편집하여 웹과 수치 동기화 */
let statusMessageId = null;
/** 체결 알림 전용 채널 ID (미설정 시 control 채널에 전송) */
let tradingLogChannelIdStored = null;
/** 4시간 시황 브리핑 전송 채널 ID */
let aiAnalysisChannelIdStored = null;
/** 실제 사용할 관리자 ID (opts.adminId → adminGuard.getEffectiveAdminId) */
let effectiveAdminId = null;
/** 역할 C(인프라 관리자) 버튼 전용 ID. ADMIN_DISCORD_ID || effectiveAdminId */
let adminDiscordIdForInfra = null;
let handlers = null;
let startOpts = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 30 * 1000;
/** 연타 시 중복 응답 방지 — 한 번에 하나의 interaction만 처리 */
let isProcessingInteraction = false;
/** 재기동 보고서([📊 현재 상태]) 딱 1회만 전송 — client.once('ready') + 이 플래그로 중복 차단 */
let isMainReportSent = false;
/** 프로세스당 1회만 [🎮 역할 A]·[📋 역할 B]·[📊 현재 상태] 초기 패널 전송 (재연결 시 중복 방지) */
let hasSentStartupPanels = false;

function isAdmin(userId) {
  return adminGuard.isAdminUser(userId, effectiveAdminId);
}

async function replyEmbed(interaction, embedOrContent) {
  try {
    if (interaction.replied || interaction.deferred) return;
    const payload = typeof embedOrContent === 'object' && (embedOrContent instanceof MessageEmbed || embedOrContent?.title != null)
      ? { embeds: [embedOrContent] }
      : { content: embedOrContent || '처리됨.' };
    await interaction.reply(payload);
  } catch (e) {
    console.error('Discord reply error:', e?.message);
  }
}

/** Gemini 등 오래 걸리는 작업: 로딩 메시지 후 주기적 진행 문구 갱신, 완료 시 결과 반환. deferReply 된 interaction 전제. */
const PROGRESS_UPDATE_INTERVAL_MS = 12000;
const CHUNK_DELAY_MS = 500;

function runWithProgressUpdates(interaction, loadingMessage, workFn) {
  return new Promise((resolve, reject) => {
    let elapsedSec = 0;
    let cleared = false;
    const tick = () => {
      elapsedSec += PROGRESS_UPDATE_INTERVAL_MS / 1000;
      if (cleared) return;
      const msg = `${loadingMessage} (${elapsedSec}초 경과)`;
      interaction.editReply({ content: msg }).catch(() => {});
    };
    const intervalId = setInterval(tick, PROGRESS_UPDATE_INTERVAL_MS);
    Promise.resolve(workFn())
      .then((result) => {
        cleared = true;
        clearInterval(intervalId);
        resolve(result);
      })
      .catch((err) => {
        cleared = true;
        clearInterval(intervalId);
        reject(err);
      });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleInteraction(interaction) {
  if (!interaction.isButton()) return;

  const userId = interaction.user?.id;
  const customId = interaction.customId;
  const isInfraButton = customId === 'admin_git_pull_restart' || customId === 'admin_simple_restart';
  const adminIdToCheck = isInfraButton ? adminDiscordIdForInfra : effectiveAdminId;
  if (!adminGuard.isAdminUser(userId, adminIdToCheck)) {
    console.warn('[MyScalpBot] Auth Failed — User ID:', userId, isInfraButton ? '(인프라 버튼)' : '');
    await interaction.reply({ content: '주인님 전용 봇입니다. 🔒', ephemeral: true }).catch(() => {});
    return;
  }

  if (isProcessingInteraction) {
    await interaction.reply({
      content: '다른 요청 처리 중입니다. 잠시 후 다시 시도해 주세요.',
      ephemeral: true
    }).catch(() => {});
    return;
  }

  isProcessingInteraction = true;
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  try {
    if (customId === 'admin_git_pull_restart' && handlers?.adminGitPullRestart) {
      const result = await handlers.adminGitPullRestart();
      const content = typeof result === 'object' && result != null && typeof result.content === 'string' ? result.content : (result || '처리됨.');
      await interaction.editReply({ content }).catch(() => {});
    } else if (customId === 'admin_simple_restart' && handlers?.adminSimpleRestart) {
      const result = await handlers.adminSimpleRestart();
      const content = typeof result === 'object' && result != null && typeof result.content === 'string' ? result.content : (result || '처리됨.');
      await interaction.editReply({ content }).catch(() => {});
    } else if (customId === 'ai_analysis' && handlers?.aiAutoAnalysis) {
      const loadingMsg = '상위 5종목 수집 중… (RSI·체결강도·5분봉) → Gemini 분석 중 🧠';
      await interaction.editReply({ content: loadingMsg }).catch(() => {});
      let raw;
      try {
        raw = await runWithProgressUpdates(interaction, loadingMsg, () => handlers.aiAutoAnalysis());
      } catch (e) {
        await interaction.editReply({ content: 'AI 타점 분석 중 오류: ' + (e?.message || '알 수 없음'), embeds: [], components: [] }).catch(() => {});
        return;
      }
      const text = typeof raw === 'object' && raw != null && typeof raw.text === 'string' ? raw.text : (raw || '결과 없음');
      const recommendedTicker = typeof raw === 'object' && raw != null ? raw.recommendedTicker : null;
      const aggressiveAlready = typeof raw === 'object' && raw != null && raw.aggressiveAlready === true;
      const remainingMs = typeof raw === 'object' && raw != null && typeof raw.remainingMs === 'number' ? raw.remainingMs : 0;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const MAX_LEN = 2000;
      const chunks = text.length <= MAX_LEN ? [text] : text.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) || [text];
      const lastIndex = chunks.length - 1;
      const addButtonToLast = recommendedTicker && lastIndex >= 0;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === lastIndex;
        const payload = { content: chunks[i], ephemeral: i > 0 };
        if (isLast && addButtonToLast) {
          if (aggressiveAlready && remainingMs > 0) {
            if (remainingMs < ONE_HOUR_MS) {
              const remainingMinutes = Math.ceil(remainingMs / 60000);
              payload.components = [new MessageActionRow().addComponents(
                new MessageButton().setCustomId('extend_aggressive_' + recommendedTicker).setLabel('연장').setStyle('PRIMARY').setEmoji('⏱️'),
                new MessageButton().setCustomId('cancel_aggressive_' + recommendedTicker).setLabel('취소').setStyle('SECONDARY').setEmoji('❌')
              )];
              payload.content = (payload.content || '') + `\n\n[**${recommendedTicker}**] ${remainingMinutes}분 남음. 연장(4시간 추가)?`;
            } else {
              payload.content = (payload.content || '') + `\n\n[**${recommendedTicker}**] 이미 가중치 완화 적용 중.`;
            }
          } else {
            payload.components = [new MessageActionRow().addComponents(
              new MessageButton().setCustomId('confirm_aggressive_' + recommendedTicker).setLabel('공격적 매매 진행').setStyle('SUCCESS').setEmoji('✅'),
              new MessageButton().setCustomId('cancel_aggressive_' + recommendedTicker).setLabel('취소').setStyle('SECONDARY').setEmoji('❌')
            )];
            payload.content = (payload.content || '') + '\n\n**[✅ 공격적 매매 진행]** 버튼으로 해당 종목 가중치·진입 강도 상향 (4시간).';
          }
        }
        if (i === 0) {
          await delay(300);
          await interaction.editReply({ content: payload.content, embeds: [], components: payload.components || [] }).catch(() => {});
        } else {
          await delay(CHUNK_DELAY_MS);
          await interaction.followUp(payload).catch(() => {});
        }
      }
      return;
    }
    if (typeof customId === 'string' && customId.startsWith('extend_aggressive_')) {
      const ticker = customId.replace('extend_aggressive_', '');
      if (handlers?.setAggressiveSymbol) {
        const result = handlers.setAggressiveSymbol(ticker);
        const msg = result && result.success
          ? `⏱️ **${ticker}** 가중치 4시간 연장되었습니다.`
          : '처리할 수 없는 종목입니다.';
        await interaction.editReply({ content: msg }).catch(() => {});
      } else {
        await interaction.editReply({ content: '서버 설정이 없습니다.' }).catch(() => {});
      }
      return;
    }
    if (typeof customId === 'string' && customId.startsWith('confirm_aggressive_')) {
      const ticker = customId.replace('confirm_aggressive_', '');
      if (handlers?.setAggressiveSymbol) {
        const result = handlers.setAggressiveSymbol(ticker);
        const msg = result && result.success
          ? `🔥 **${ticker}** 가중치 상향 적용됨. 4시간 유지됩니다.`
          : '처리할 수 없는 종목입니다.';
        await interaction.editReply({ content: msg }).catch(() => {});
      } else {
        await interaction.editReply({ content: '서버 설정이 없습니다.' }).catch(() => {});
      }
      return;
    }
    if (typeof customId === 'string' && customId.startsWith('cancel_aggressive_')) {
      await interaction.editReply({ content: '취소되었습니다.' }).catch(() => {});
      return;
    }
    if (typeof customId === 'string' && customId.startsWith('release_aggressive_')) {
      const ticker = customId.replace('release_aggressive_', '');
      if (handlers?.clearAggressiveSymbol) {
        handlers.clearAggressiveSymbol(ticker);
        await interaction.editReply({ content: `🔓 **${ticker}** 가중치 해지됨.` }).catch(() => {});
      } else {
        await interaction.editReply({ content: '서버 설정이 없습니다.' }).catch(() => {});
      }
      return;
    }
    if (customId === 'api_usage_monitor' && handlers?.getApiUsageMonitor) {
      await interaction.editReply({ content: 'API 사용량 조회 중…' }).catch(() => {});
      const result = await handlers.getApiUsageMonitor();
      const content = (result && result.content) || '결과 없음';
      const MAX_LEN = 2000;
      const chunks = content.length <= MAX_LEN ? [content] : content.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) || [content];
      await interaction.editReply({ content: chunks[0], embeds: [] }).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await delay(CHUNK_DELAY_MS);
        await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
      }
      return;
    }
    if (customId === 'daily_log_analysis' && handlers?.analyst?.dailyLogAnalysis) {
      const loadingMsg = '오늘자 로그 수집·분석 중… (일 단위)';
      await interaction.editReply({ content: loadingMsg }).catch(() => {});
      let result;
      try {
        result = await runWithProgressUpdates(interaction, loadingMsg, () => handlers.analyst.dailyLogAnalysis());
      } catch (e) {
        await interaction.editReply({ content: '로그 분석 중 오류: ' + (e?.message || '알 수 없음'), embeds: [] }).catch(() => {});
        return;
      }
      const content = (result && result.content) || '결과 없음';
      const MAX_LEN = 2000;
      const chunks = content.length <= MAX_LEN ? [content] : content.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) || [content];
      await interaction.editReply({ content: chunks[0], embeds: [] }).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await delay(CHUNK_DELAY_MS);
        await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
      }
      return;
    }
    if (customId === 'analyst_advisor_one_liner' && handlers?.analyst?.advisorOneLiner) {
      const loadingMsg = '🧐 최근 거래 분석·조언 생성 중…';
      await interaction.editReply({ content: loadingMsg }).catch(() => {});
      let result;
      try {
        result = await runWithProgressUpdates(interaction, loadingMsg, () => handlers.analyst.advisorOneLiner());
      } catch (e) {
        await interaction.editReply({ content: '조언자 분석 중 오류: ' + (e?.message || '알 수 없음'), embeds: [] }).catch(() => {});
        return;
      }
      const content = (result && result.content) || '결과 없음';
      const MAX_LEN = 2000;
      const chunks = content.length <= MAX_LEN ? [content] : content.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) || [content];
      await interaction.editReply({ content: chunks[0], embeds: [] }).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await delay(CHUNK_DELAY_MS);
        await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
      }
      return;
    }
    if (typeof customId === 'string' && customId.startsWith('analyst_')) {
      if ((customId === 'analyst_diagnose_no_trade' || customId === 'analyst_suggest_logic') && effectiveAdminId) {
        const userId = interaction.member?.user?.id || interaction.user?.id;
        if (userId !== effectiveAdminId) {
          await interaction.editReply({ content: '관리자만 사용할 수 있습니다.' }).catch(() => {});
          return;
        }
      }
      const loadingMsg = customId === 'analyst_get_prompt' ? 'Gemini 분석 중...' : (customId === 'analyst_diagnose_no_trade' || customId === 'analyst_suggest_logic' ? '진단/제안 분석 중…' : '조회 중…');
      await interaction.editReply({ content: loadingMsg }).catch(() => {});
      let embed;
      try {
        embed = await runWithProgressUpdates(interaction, loadingMsg, () => handleAnalystButton(customId));
      } catch (e) {
        await interaction.editReply({ content: '분석 중 오류: ' + (e?.message || '알 수 없음') }).catch(() => {});
        return;
      }
      await delay(300);
      await interaction.editReply(embed ? { embeds: [embed], content: null } : { content: '데이터 없음' }).catch(() => {});
      return;
    }
    if (customId === 'engine_start' && handlers?.engineStart) {
      const result = await handlers.engineStart();
      const msg = (result && typeof result === 'object' && result.message) ? result.message : '자동 매매를 시작합니다.';
      await interaction.editReply({ content: msg }).catch(() => {});
      if (result && result.success && msg) sendToChannel(msg);
    } else if (customId === 'engine_stop' && handlers?.engineStop) {
      await handlers.engineStop();
      await interaction.editReply({ content: '처리 완료 — 매매 엔진 중단 및 미체결 주문 취소 완료.' }).catch(() => {});
    } else if (customId === 'current_state' && handlers?.currentState) {
      const embed = await handlers.currentState();
      await interaction.editReply(embed ? { embeds: [embed], content: null } : { content: '데이터 없음' }).catch(() => {});
    } else if (customId === 'current_return' && handlers?.currentReturn) {
      const embed = await handlers.currentReturn();
      await interaction.editReply(embed ? { embeds: [embed], content: null } : { content: '데이터 없음' }).catch(() => {});
    } else if (customId === 'sell_all' && handlers?.sellAll) {
      const msg = await handlers.sellAll();
      await interaction.editReply({ content: '처리 완료. ' + (msg || '') }).catch(() => {});
    } else if (customId === 'race_horse_toggle' && handlers?.toggleRaceHorse) {
      const result = await handlers.toggleRaceHorse();
      const active = result && typeof result === 'object' && result.active === true;
      const msg = active
        ? '🏇 경주마 모드를 예약했습니다. 오전 9시에 자동으로 자산의 50%를 투입합니다.'
        : '❄️ 경주마 모드 OFF';
      await interaction.editReply({ content: msg }).catch(() => {});
    } else if (customId === 'relax_toggle' && handlers?.getRelaxedStatus !== undefined) {
      const status = handlers.getRelaxedStatus();
      const remainingMs = status?.remainingMs ?? 0;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      if (remainingMs > 0) {
        const remainingMin = Math.ceil(remainingMs / 60000);
        const isUnderOneHour = remainingMs < ONE_HOUR_MS;
        await interaction.editReply({
          content: isUnderOneHour
            ? `완화 종료가 얼마 남지 않았습니다. 연장하시겠습니까? (현재 남은 시간: ${remainingMin}분)`
            : `현재 기준 완화 적용 중입니다. (남은 시간: ${remainingMin}분)`,
          components: isUnderOneHour
            ? [new MessageActionRow().addComponents(
                new MessageButton().setCustomId('extend_relax').setLabel('연장 (4시간)').setStyle('PRIMARY').setEmoji('⏱️')
              )]
            : []
        }).catch(() => {});
      } else if (handlers?.setRelaxedMode) {
        const scalpStatus = handlers?.getIndependentScalpStatus?.();
        if (scalpStatus?.isRunning && (scalpStatus?.remainingMs ?? 0) > 0) {
          await interaction.editReply({ content: '⚠️ 초단타 scalp 모드 중에는 매매 엔진 기준 완화가 불가합니다.' }).catch(() => {});
        } else {
          handlers.setRelaxedMode(4 * 60 * 60 * 1000);
          await interaction.editReply({ content: '🔓 매매 엔진 기준 완화를 4시간 적용했습니다. (진입 조건·체결강도 하한 완화)' }).catch(() => {});
        }
      } else {
        await interaction.editReply({ content: '처리할 수 없습니다.' }).catch(() => {});
      }
    } else if (customId === 'extend_relax' && handlers?.extendRelaxMode) {
      handlers.extendRelaxMode();
      await interaction.editReply({ content: '🔓 기준 완화 4시간 연장되었습니다.' }).catch(() => {});
    } else if (customId === 'independent_scalp_start' && handlers?.getIndependentScalpStatus) {
      const status = handlers.getIndependentScalpStatus();
      const remainingMs = status?.remainingMs ?? 0;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      if (status?.isRunning && remainingMs > 0) {
        const remainingMin = Math.ceil(remainingMs / 60000);
        const isUnderOneHour = remainingMs < ONE_HOUR_MS;
        await interaction.editReply({
          content: isUnderOneHour
            ? `독립 스캘프 가동 중. 완료가 ${remainingMin}분 남았습니다. 연장하시겠습니까? (3시간 추가)`
            : `독립 스캘프 가동 중입니다. (남은 시간: ${remainingMin}분, 우선권=SCALP)`,
          components: isUnderOneHour
            ? [new MessageActionRow().addComponents(
                new MessageButton().setCustomId('extend_independent_scalp').setLabel('연장 (3시간)').setStyle('PRIMARY').setEmoji('⏱️')
              )]
            : []
        }).catch(() => {});
      } else if (handlers?.setIndependentScalpActivate) {
        handlers.setIndependentScalpActivate('SUPER_AGGRESSIVE');
        const remain = handlers.getIndependentScalpStatus()?.remainingMs ?? 0;
        const min = Math.ceil(remain / 60000);
        await interaction.editReply({ content: `🚀 독립 초단타 스캘프 봇을 3시간 시한부로 가동했습니다. (우선권=SCALP, 남은 시간: ${min}분)` }).catch(() => {});
      } else {
        await interaction.editReply({ content: '처리할 수 없습니다.' }).catch(() => {});
      }
    } else if (customId === 'independent_scalp_stop' && handlers?.setIndependentScalpStop) {
      handlers.setIndependentScalpStop();
      await interaction.editReply({ content: '🛑 독립 스캘프 봇을 중지했습니다. (우선권=MAIN 반납)' }).catch(() => {});
    } else if (customId === 'extend_independent_scalp' && handlers?.extendIndependentScalp) {
      const result = handlers.extendIndependentScalp();
      const remainingMs = result?.remainingMs ?? 0;
      const remainingMin = Math.ceil(remainingMs / (1000 * 60));
      const msg = result?.success
        ? `운영 시간 3시간 연장 완료! (남은 시간: ${remainingMin}분)`
        : '연장 가능한 시점이 아닙니다. (1시간 미만일 때만 연장 가능)';
      await interaction.editReply({ content: msg }).catch(() => {});
    } else {
      await interaction.editReply({ content: '알 수 없는 버튼입니다.' }).catch(() => {});
    }
  } catch (err) {
    await interaction.editReply({ content: '오류: ' + (err?.message || 'Unknown') }).catch(() => {});
  } finally {
    isProcessingInteraction = false;
  }
}

async function handleAnalystButton(customId) {
  if (!handlers?.analyst) return null;
  if (customId === 'analyst_scan_vol') return handlers.analyst.scanVol();
  if (customId === 'analyst_get_prompt') return handlers.analyst.getPrompt();
  if (customId === 'analyst_major_indicators') return handlers.analyst.majorIndicators();
  if (customId === 'analyst_diagnose_no_trade') return handlers.analyst.diagnoseNoTrade();
  if (customId === 'analyst_suggest_logic') return handlers.analyst.suggestLogic();
  if (customId === 'analyst_advisor_one_liner') return handlers.analyst.advisorOneLiner();
  return null;
}

function buildAnalystRow() {
  const row1 = new MessageActionRow().addComponents(
    new MessageButton().setCustomId('ai_analysis').setLabel('AI 실시간 타점 분석').setStyle('PRIMARY').setEmoji('💡'),
    new MessageButton().setCustomId('analyst_get_prompt').setLabel('시황 요약').setStyle('PRIMARY').setEmoji('📊'),
    new MessageButton().setCustomId('analyst_scan_vol').setLabel('급등주 분석').setStyle('PRIMARY').setEmoji('🔍'),
    new MessageButton().setCustomId('analyst_major_indicators').setLabel('주요지표').setStyle('PRIMARY').setEmoji('📈')
  );
  const row2 = new MessageActionRow().addComponents(
    new MessageButton().setCustomId('analyst_diagnose_no_trade').setLabel('거래 부재 원인 진단').setStyle('SECONDARY').setEmoji('🔍'),
    new MessageButton().setCustomId('analyst_suggest_logic').setLabel('매매 로직 수정안 제안').setStyle('SECONDARY').setEmoji('💡'),
    new MessageButton().setCustomId('analyst_advisor_one_liner').setLabel('조언자의 한마디').setStyle('SECONDARY').setEmoji('🧐'),
    new MessageButton().setCustomId('daily_log_analysis').setLabel('하루치 로그 (일 단위) 분석').setStyle('SECONDARY').setEmoji('📋'),
    new MessageButton().setCustomId('api_usage_monitor').setLabel('API 사용량 조회').setStyle('SECONDARY').setEmoji('📊')
  );
  return [row1, row2];
}

function buildControlRow() {
  const row1 = new MessageActionRow().addComponents(
    new MessageButton().setCustomId('engine_start').setLabel('엔진 가동').setStyle('SUCCESS').setEmoji('🚀'),
    new MessageButton().setCustomId('engine_stop').setLabel('즉시 정지').setStyle('DANGER').setEmoji('🛑'),
    new MessageButton().setCustomId('current_state').setLabel('현재 상태').setStyle('SECONDARY').setEmoji('📊'),
    new MessageButton().setCustomId('current_return').setLabel('현재 수익률').setStyle('SECONDARY').setEmoji('📈')
  );
  const row2 = new MessageActionRow().addComponents(
    new MessageButton().setCustomId('sell_all').setLabel('전체 매도').setStyle('DANGER').setEmoji('📉'),
    new MessageButton().setCustomId('race_horse_toggle').setLabel('경주마 모드 ON/OFF').setStyle('SECONDARY').setEmoji('🏇'),
    new MessageButton().setCustomId('relax_toggle').setLabel('매매 엔진 기준 완화').setStyle('SECONDARY').setEmoji('🔓')
  );
  const row3 = new MessageActionRow().addComponents(
    new MessageButton().setCustomId('independent_scalp_start').setLabel('초공격 scalp').setStyle('PRIMARY').setEmoji('⚡'),
    new MessageButton().setCustomId('independent_scalp_stop').setLabel('초공격 scalp 중지').setStyle('SECONDARY').setEmoji('🛑')
  );
  return [row1, row2, row3];
}

function buildAdminRow() {
  return new MessageActionRow().addComponents(
    new MessageButton().setCustomId('admin_git_pull_restart').setLabel('시스템 업데이트').setStyle('PRIMARY').setEmoji('🔄'),
    new MessageButton().setCustomId('admin_simple_restart').setLabel('프로세스 재기동').setStyle('SECONDARY').setEmoji('♻️')
  );
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** 디스코드 에러 시 client.destroy() 후 30초 뒤 새 Client로 client.login()만 시도. process.exit/process.kill 없음 → PM2 재기동 아님. */
function scheduleReconnect() {
  clearReconnectTimer();
  if (!startOpts?.token) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const token = startOpts.token;
    const channelId = channelIdStored;
    if (client) {
      try {
        client.removeAllListeners('interactionCreate');
        client.removeAllListeners('error');
        client.removeAllListeners('disconnect');
        client.removeAllListeners('ready');
        client.destroy();
      } catch (_) {}
      client = null;
      controlChannel = null;
    }
    console.warn('[MyScalpBot] 오프라인 — 30초 경과. 새 Client로 login() 시도.');
    const intents = [GUILDS, GUILD_MESSAGES];
    if (MESSAGE_CONTENT != null) intents.push(MESSAGE_CONTENT);
    const validIntents = intents.filter((n) => n != null && !isNaN(n));
    client = new Client({ intents: validIntents });
    client.removeAllListeners('interactionCreate');
    client.on('interactionCreate', handleInteraction);
    client.on('error', (err) => {
      console.error('[MyScalpBot] client error:', err?.message);
      scheduleReconnect();
    });
    client.on('disconnect', () => {
      console.error('[MyScalpBot] 연결 끊김. 재연결 예약.');
      scheduleReconnect();
    });
    client.once('ready', async () => {
      clearReconnectTimer();
      const botTag = client.user ? `${client.user.tag} (${client.user.id})` : 'Unknown';
      console.log(`[MyScalpBot] 재연결 온라인 — ${botTag}`);
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        controlChannel = ch;
      } catch (_) {}
    });
    client.login(token).then(() => {
      clearReconnectTimer();
    }).catch((e) => {
      console.error('[MyScalpBot] login 재시도 실패:', e?.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

/**
 * @param {Object} opts
 * @param {string} opts.token - Discord 봇 토큰
 * @param {string} opts.channelId - 알림/컨트롤 채널 ID
 * @param {string} opts.adminId - 관리자 디스코드 사용자 ID (버튼 허용)
 * @param {string} [opts.tradingLogChannelId] - 체결 보고 전용 채널 (#trading-log). 미설정 시 channelId 사용
 * @param {string} [opts.aiAnalysisChannelId] - 4시간 시황 브리핑 전송 채널 (#ai-analysis)
 * @param {Object} opts.handlers - { getStartupStatusEmbed, engineStart, engineStop, currentState, sellAll } (async 함수)
 */
async function start(opts) {
  const { token, channelId, adminId: envAdminId, adminDiscordId: envAdminDiscordId, tradingLogChannelId, aiAnalysisChannelId, handlers: h } = opts || {};
  if (!token || !channelId) {
    const missing = [];
    if (!token) missing.push('DISCORD_TOKEN');
    if (!channelId) missing.push('CHANNEL_ID');
    console.error('설정 오류: .env 파일을 확인하세요. 누락된 항목:', missing.join(', '), '— 봇 기능 스킵. client.login 미실행.');
    return null;
  }
  effectiveAdminId = adminGuard.getEffectiveAdminId(envAdminId, ADMIN_ID_BACKUP);
  adminDiscordIdForInfra = adminGuard.normalizeAdminId(envAdminDiscordId) || effectiveAdminId;
  if (effectiveAdminId) {
    const fromEnv = envAdminId && adminGuard.normalizeAdminId(envAdminId);
    console.log('[MyScalpBot] 관리자 ID 적용:', effectiveAdminId.slice(0, 4) + '…' + effectiveAdminId.slice(-4), fromEnv ? '(env)' : '(백업)');
  } else {
    console.warn('[MyScalpBot] ADMIN_ID 미설정 — .env의 ADMIN_ID 또는 lib/discordBot.js의 ADMIN_ID_BACKUP을 설정하세요.');
  }
  handlers = h || null;
  channelIdStored = channelId;
  tradingLogChannelIdStored = tradingLogChannelId || null;
  aiAnalysisChannelIdStored = aiAnalysisChannelId || null;
  startOpts = opts;

  if (client) {
    try {
      client.removeAllListeners('interactionCreate');
      client.destroy();
    } catch (_) {}
    client = null;
    controlChannel = null;
    isProcessingInteraction = false;
  }
  clearReconnectTimer();

  const intents = [GUILDS, GUILD_MESSAGES];
  if (MESSAGE_CONTENT != null) intents.push(MESSAGE_CONTENT);
  const validIntents = intents.filter((n) => n != null && !isNaN(n));
  console.log('Discord Library Check: intents=', validIntents.join(', '), validIntents.length ? 'OK' : 'NONE');
  if (validIntents.length === 0) {
    console.error('설정 오류: 인텐트를 로드할 수 없습니다. discord.js 또는 discord-api-types 버전을 확인하세요. client.login 미실행.');
    return null;
  }
  client = new Client({ intents: validIntents });
  client.removeAllListeners('interactionCreate');
  client.on('interactionCreate', handleInteraction);

  client.on('error', (err) => {
    console.error('[MyScalpBot] client error:', err?.message);
    scheduleReconnect();
  });
  client.on('disconnect', () => {
    console.error('[MyScalpBot] 연결 끊김. 재연결 예약.');
    scheduleReconnect();
  });

  /** 역할 A 패널 전송 (이전 전송 완료 후 다음 호출) */
  async function sendOperatorPanel(ch) {
    const rows = buildControlRow();
    await ch.send({
      content: '**🎮 역할 A — 현장 지휘관 (The Operator)**\n엔진 제어 · 실시간 상태 · 체결 보고',
      components: Array.isArray(rows) ? rows : [rows]
    });
    console.log('[MyScalpBot] 역할 A(현장 지휘관) 패널 전송 완료');
  }

  /** 역할 B 패널 전송 */
  async function sendAnalystPanel(ch) {
    const analystRow = buildAnalystRow();
    await ch.send({
      content: '**📋 역할 B — 정보 분석가 (The Analyst)**\nAI 실시간 타점 분석·시황 요약·주요지표·거래 부재 진단',
      components: Array.isArray(analystRow) ? analystRow : [analystRow]
    });
    console.log('[MyScalpBot] 역할 B(정보 분석가) 패널 전송 완료');
  }

  /** 역할 C 패널 전송 */
  async function sendAdminPanel(ch) {
    const adminRow = buildAdminRow();
    await ch.send({
      content: '**🛠️ 역할 C — 인프라 관리자 (Server Admin)**\ngit pull · 프로세스 재기동 (ADMIN_DISCORD_ID만 사용 가능)',
      components: [adminRow]
    });
    console.log('[MyScalpBot] 역할 C(인프라 관리자) 패널 전송 완료');
  }

  /** ready 시 패널 전송 순서 엄격 보장: 부팅 메시지 → A → B → C → [📊 현재 상태] (각 await 후 다음 전송) */
  async function sendInitMessage(ch) {
    const boot = typeof handlers?.getBootReadyCheck === 'function' ? handlers.getBootReadyCheck() : null;
    const bootMsg = boot?.allOk ? '시스템 재가동 완료 🟢' : '시스템 재시작 완료';
    await ch.send({ content: bootMsg });
    console.log('[MyScalpBot] 부팅 메시지 전송 완료');
    await sendOperatorPanel(ch);
    await sendAnalystPanel(ch);
    await sendAdminPanel(ch);
    if (!isMainReportSent && handlers?.getStartupStatusEmbed && controlChannel) {
      try {
        const embed = await handlers.getStartupStatusEmbed();
        if (embed) {
          const sent = await controlChannel.send({ embeds: [embed] });
          if (sent?.id) statusMessageId = sent.id;
          isMainReportSent = true;
          console.log('[MyScalpBot] [📊 현재 상태] 임베드 전송 완료');
        }
      } catch (err) {
        console.error('[MyScalpBot] startup status embed:', err?.message);
        const fallback = new MessageEmbed()
          .setTitle('📊 현재 상태')
          .setColor(0x5865f2)
          .addFields(
            { name: '매매 엔진 상태', value: '🔴 정지됨', inline: true },
            { name: '경주마 모드', value: '❄️ 비활성', inline: true },
            { name: '상태', value: '데이터 로딩 중… ([📊 현재 상태] 버튼으로 새로고침)', inline: false }
          )
          .setTimestamp();
        await controlChannel.send({ embeds: [fallback] });
        isMainReportSent = true;
      }
    }
  }

  /** 재가동 시 패널 전송이 모두 끝난 뒤 resolve. server.js에서 restoreSystemState() 후 await start() 시 순서 보장 */
  let resolveStartupPromise = null;
  const startupPanelsDone = new Promise((resolve) => {
    resolveStartupPromise = resolve;
  });

  client.once('ready', async () => {
    clearReconnectTimer();
    const botTag = client.user ? `${client.user.tag} (${client.user.id})` : 'Unknown';
    console.log(`[MyScalpBot] 온라인 — ${botTag}`);
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      controlChannel = ch;
      if (!ch) {
        console.error('[MyScalpBot] 채널 조회 실패 — CHANNEL_ID 확인 필요');
        if (resolveStartupPromise) resolveStartupPromise();
        return;
      }
      if (hasSentStartupPanels) {
        await ch.send({ content: 'MyScalpBot 재연결 완료.' }).catch(() => {});
        if (resolveStartupPromise) resolveStartupPromise();
        return;
      }
      try {
        await sendInitMessage(ch);
      } catch (err) {
        console.error('[MyScalpBot] sendInitMessage 실패:', err?.message);
        if (!isMainReportSent && controlChannel) {
          try {
            const fallback = new MessageEmbed()
              .setTitle('📊 현재 상태')
              .setColor(0x5865f2)
              .addFields(
                { name: '매매 엔진 상태', value: '🔴 정지됨', inline: true },
                { name: '경주마 모드', value: '❄️ 비활성', inline: true },
                { name: '상태', value: '데이터 로딩 중… (Upbit/Gemini 확인 후 [📊 현재 상태] 버튼으로 새로고침)', inline: false }
              )
              .setTimestamp();
            await controlChannel.send({ embeds: [fallback] });
            isMainReportSent = true;
          } catch (_) {}
        }
      } finally {
        hasSentStartupPanels = true;
        if (resolveStartupPromise) resolveStartupPromise();
      }
    } catch (e) {
      console.error('[MyScalpBot] ready handler:', e?.message);
      if (resolveStartupPromise) resolveStartupPromise();
    }
  });

  console.log(`[MyScalpBot] 연결 시도 — Token 앞자리(${token?.substring(0, 4)}...), Channel(${channelId})`);
  try {
    await client.login(token);
    console.log('[MyScalpBot] client.login() 호출 완료 (연결 대기 중).');
    return startupPanelsDone;
  } catch (e) {
    console.error('[MyScalpBot] login 실패:', e?.message);
    scheduleReconnect();
    return null;
  }
}

/** 봇이 정상 접속·준비 상태인지 */
function isOnline() {
  return !!(client && client.isReady());
}

function getChannel() {
  return controlChannel;
}

async function sendToChannel(contentOrEmbed) {
  let ch = controlChannel;
  if (!ch && client && channelIdStored) {
    ch = await client.channels.fetch(channelIdStored).catch(() => null);
    if (ch) controlChannel = ch;
  }
  if (!ch) return false;
  try {
    if (typeof contentOrEmbed === 'object' && (contentOrEmbed instanceof MessageEmbed || contentOrEmbed?.title != null)) {
      await ch.send({ embeds: [contentOrEmbed] });
    } else {
      await ch.send({ content: String(contentOrEmbed) });
    }
    return true;
  } catch (e) {
    console.error('[MyScalpBot] send error:', e?.message);
    return false;
  }
}

/** 헬스체크: 관리자에게 DM 전송 (1시간마다 "가즈아" 등). 관리자 ID와 봇 온라인 시에만 동작 */
async function sendDmToAdmin(content) {
  if (!client?.isReady() || !effectiveAdminId) return false;
  try {
    const user = await client.users.fetch(effectiveAdminId).catch(() => null);
    if (!user) return false;
    await user.send(String(content));
    return true;
  } catch (e) {
    console.warn('[MyScalpBot] sendDmToAdmin:', e?.message);
    return false;
  }
}

/** 지정 채널에 메시지/Embed 전송 (4시간 시황 등). channelId가 없으면 control 채널 사용 */
async function sendToChannelId(channelId, contentOrEmbed) {
  if (!client || !channelId) return false;
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return false;
    if (typeof contentOrEmbed === 'object' && (contentOrEmbed instanceof MessageEmbed || contentOrEmbed?.title != null)) {
      await ch.send({ embeds: [contentOrEmbed] });
    } else {
      await ch.send({ content: String(contentOrEmbed) });
    }
    return true;
  } catch (e) {
    console.error('[MyScalpBot] sendToChannelId error:', e?.message);
    return false;
  }
}

/** 체결 알림: 업비트 스타일 Embed — 수익률/수익금/매도가/매수가 2열 배치 */
function sendTradeAlert(data) {
  const {
    ticker,
    side,
    price,
    quantity,
    currentReturnPct,
    profitPct,
    profitKrw,
    exitPrice,
    avgPrice,
    duration,
    symbol
  } = data || {};
  const isBuy = (side || '').toLowerCase() === 'buy';
  const sideKo = isBuy ? '매수' : '매도';
  const sym = symbol || (ticker ? ticker.replace('KRW-', '') : '—');

  if (isBuy) {
    const embed = new MessageEmbed()
      .setColor(0x57f287)
      .setTitle(`📈 [체결 알림 — 매수] ${sym}`)
      .addFields(
        { name: '체결가', value: price != null ? Number(price).toLocaleString('ko-KR') + ' 원' : '—', inline: true },
        { name: '수량', value: quantity != null ? String(quantity) : '—', inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: '종목', value: ticker || sym, inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'MyScalpBot Execution Engine' });
    const targetChannelId = tradingLogChannelIdStored || channelIdStored;
    if (targetChannelId && client) return sendToChannelId(targetChannelId, embed);
    return sendToChannel(embed);
  }

  const pct = profitPct != null ? Number(profitPct) : (currentReturnPct != null ? Number(currentReturnPct) : null);
  const krw = profitKrw != null ? Number(profitKrw) : null;
  const isProfit = pct != null ? pct > 0 : (krw != null ? krw > 0 : false);
  const color = isProfit ? 0xff4d4d : 0x4d4dff;
  const emoji = isProfit ? '📈' : '📉';
  const embed = new MessageEmbed()
    .setColor(color)
    .setTitle(`${emoji} [체결 알림 — 매도] ${sym}`)
    .addFields(
      {
        name: '수익률',
        value: pct != null ? `**${(pct >= 0 ? '+' : '') + Number(pct).toFixed(2)}%**` : '—',
        inline: true
      },
      {
        name: '수익금',
        value: krw != null ? `${Math.round(krw).toLocaleString('ko-KR')} KRW` : '—',
        inline: true
      },
      { name: '\u200b', value: '\u200b', inline: true },
      {
        name: '매도가',
        value: (exitPrice != null ? exitPrice : price) != null ? `${Number(exitPrice != null ? exitPrice : price).toLocaleString('ko-KR')} 원` : '—',
        inline: true
      },
      {
        name: '매수가',
        value: avgPrice != null ? `${Number(avgPrice).toLocaleString('ko-KR')} 원` : '—',
        inline: true
      },
      {
        name: '보유시간',
        value: duration || '—',
        inline: true
      }
    )
    .setTimestamp()
    .setFooter({ text: 'MyScalpBot Execution Engine' });
  if (currentReturnPct != null && (profitPct == null || profitKrw == null)) {
    embed.addFields({ name: '현재 포트폴리오 수익률', value: `${(currentReturnPct >= 0 ? '+' : '') + Number(currentReturnPct).toFixed(2)}%`, inline: false });
  }
  const targetChannelId = tradingLogChannelIdStored || channelIdStored;
  if (targetChannelId && client) return sendToChannelId(targetChannelId, embed);
  return sendToChannel(embed);
}

/** 오류/긴급 알림 (API Key, Latency 등) */
function sendErrorAlert(title, message) {
  const embed = new MessageEmbed()
    .setColor(0xed4245)
    .setTitle(title || '긴급 알림')
    .setDescription(message || '')
    .setTimestamp();
  return sendToChannel(embed);
}

/**
 * [📊 현재 상태] 메시지 최신화 — emitDashboard 호출 시 동일 Embed로 편집하여 PC 웹·모바일 수치 100% 일치
 * @param {MessageEmbed} embed - server에서 buildCurrentStateEmbed()로 만든 Embed
 * @param {string[]} [aggressiveSymbols] - 특별 관리 종목 목록이면 티커별 해지 버튼 추가 (최대 5개/행)
 */
async function updateStatusMessage(embed, aggressiveSymbols) {
  if (!embed || !client?.isReady()) return false;
  if (!statusMessageId) return false;
  let ch = controlChannel;
  if (!ch && channelIdStored) {
    ch = await client.channels.fetch(channelIdStored).catch(() => null);
    if (ch) controlChannel = ch;
  }
  if (!ch) return false;
  const components = [];
  if (Array.isArray(aggressiveSymbols) && aggressiveSymbols.length > 0) {
    const maxPerRow = 5;
    for (let i = 0; i < aggressiveSymbols.length; i += maxPerRow) {
      const row = new MessageActionRow();
      aggressiveSymbols.slice(i, i + maxPerRow).forEach((sym) => {
        row.addComponents(
          new MessageButton()
            .setCustomId('release_aggressive_' + sym)
            .setLabel(sym + ' 해지')
            .setStyle('SECONDARY')
            .setEmoji('🔓')
        );
      });
      components.push(row);
    }
  }
  try {
    const msg = await ch.messages.fetch(statusMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      return true;
    }
    statusMessageId = null;
    return false;
  } catch (e) {
    statusMessageId = null;
    console.warn('[MyScalpBot] updateStatusMessage:', e?.message);
    return false;
  }
}

function stop() {
  startOpts = null;
  clearReconnectTimer();
  statusMessageId = null;
  tradingLogChannelIdStored = null;
  aiAnalysisChannelIdStored = null;
  if (client) {
    client.destroy().catch(() => {});
    client = null;
  }
  controlChannel = null;
}

module.exports = {
  start,
  stop,
  isOnline,
  getChannel,
  sendToChannel,
  sendToChannelId,
  sendDmToAdmin,
  sendTradeAlert,
  sendErrorAlert,
  updateStatusMessage
};
