/**
 * 고정 패널 규약 — 역할/버튼/레이아웃 불변 계약
 * - 역할 A/B/C 명칭·의미 고정
 * - 버튼 customId·역할 소속·스타일 고정
 * - 렌더링은 PANEL_LAYOUT_SPEC만 기준 (자동 분할 금지)
 */

import { LogUtil } from '../../../packages/core/src/LogUtil';

const LOG_TAG = 'DISCORD_OP_PANEL';

/** Discord Button Style: 1=PRIMARY, 2=SECONDARY, 3=SUCCESS, 4=DANGER */
export const DISCORD_BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 } as const;
export type DiscordButtonStyle = (typeof DISCORD_BUTTON_STYLE)[keyof typeof DISCORD_BUTTON_STYLE];

/** 역할 타입 — 고정 운영 개념 */
export const ROLE_TYPES = ['A', 'B', 'C'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

/** 표준 버튼 키 (고정 계약 custom_id) */
export const BUTTON_KEYS = [
  'engine_start',
  'engine_stop',
  'current_status',
  'current_pnl',
  'sell_all',
  'race_horse_toggle',
  'relax_threshold',
  'scalp_attack',
  'scalp_stop',
  'strategy_menu',
  'current_strategy',
  'ai_entry_analysis',
  'market_summary',
  'surge_analysis',
  'key_indicators',
  'no_trade_diagnosis',
  'recent_scalp',
  'recent_fills',
  'logic_suggestion',
  'advisor_comment',
  'daily_log_analysis',
  'health_check',
  'emergency_control',
  'api_usage',
  'system_update',
] as const;
export type ButtonKey = (typeof BUTTON_KEYS)[number];

export interface ButtonSpec {
  key: ButtonKey;
  label: string;
  style: DiscordButtonStyle;
}

export interface RoleSpec {
  id: RoleType;
  title: string;
  description: string;
  /** 의미 고정: 주석으로만 유지 */
  meaning: string;
  buttons: ButtonKey[];
}

/** 한 Discord row = 버튼 키 배열 (최대 5개). 순서 고정. */
export type LayoutRowSpec = ButtonKey[];

/** 패널 레이아웃 버전 — 변경 시 여기만 수정 */
export const PANEL_LAYOUT_VERSION = 'ROLE_FIXED_V1';
export const PANEL_CONTENT_VERSION = 'AUTO_TRADE_CONTROL_PANEL_V3';

// ---------------------------------------------------------------------------
// 역할 정의 (고정)
// ---------------------------------------------------------------------------
/** 역할 A — 현장 지휘관: 엔진 제어 · 실시간 상태 · 수익/보유/체결 기반 즉시 액션 · 공격/중지/매도 */
/** 역할 B — 정보 분석가: AI 분석 · 시황 요약 · 주요 지표 · 거래 부재 진단 · 최근 체결/스캘/로그 리뷰/조언 */
/** 역할 C — 서버 관리자: 시스템 상태 점검 · API 사용량 · 비상 제어 · 시스템 업데이트/복구/운영 안정성 */
export const PANEL_ROLE_DEFINITIONS: RoleSpec[] = [
  {
    id: 'A',
    title: '역할 A — 현장 지휘관',
    description: '엔진 제어 · 실시간 상태 · 체결 보고 · 공격/정지/매도',
    meaning: '엔진 제어, 실시간 상태 확인, 수익/보유/체결 기반 즉시 액션, 공격/중지/매도 같은 즉시 운용 판단',
    buttons: [
      'engine_start',
      'engine_stop',
      'current_status',
      'current_pnl',
      'sell_all',
      'race_horse_toggle',
      'relax_threshold',
      'scalp_attack',
      'scalp_stop',
      'strategy_menu',
      'current_strategy',
    ],
  },
  {
    id: 'B',
    title: '역할 B — 정보 분석가',
    description: 'AI 타점 · 시황 요약 · 급등주/주요지표 · 거래 부재 진단 · 최근스캘/체결 · 로직 제안 · 조언 · 로그 분석',
    meaning: 'AI 분석, 시황 요약, 주요 지표, 거래 부재 진단, 최근 체결/스캘/로그 리뷰/조언',
    buttons: [
      'ai_entry_analysis',
      'market_summary',
      'surge_analysis',
      'key_indicators',
      'no_trade_diagnosis',
      'recent_scalp',
      'recent_fills',
      'logic_suggestion',
      'advisor_comment',
      'daily_log_analysis',
    ],
  },
  {
    id: 'C',
    title: '역할 C — 서버 관리자',
    description: '헬스 · 비상 제어 · API 사용량 · 시스템 업데이트',
    meaning: '시스템 상태 점검, API 사용량, 비상 제어, 시스템 업데이트/복구/운영 안정성 관리',
    buttons: ['health_check', 'emergency_control', 'api_usage', 'system_update'],
  },
];

// ---------------------------------------------------------------------------
// 버튼 정의 (key = custom_id, label/style 고정)
// ---------------------------------------------------------------------------
export const PANEL_BUTTON_DEFINITIONS: Record<ButtonKey, Omit<ButtonSpec, 'key'>> = {
  engine_start: { label: '엔진 가동', style: DISCORD_BUTTON_STYLE.SUCCESS },
  engine_stop: { label: '즉시 정지', style: DISCORD_BUTTON_STYLE.DANGER },
  current_status: { label: '현재 상태', style: DISCORD_BUTTON_STYLE.SECONDARY },
  current_pnl: { label: '현재 수익률', style: DISCORD_BUTTON_STYLE.SECONDARY },
  sell_all: { label: '전체 매도', style: DISCORD_BUTTON_STYLE.DANGER },
  race_horse_toggle: { label: '경주마 ON/OFF', style: DISCORD_BUTTON_STYLE.SECONDARY },
  relax_threshold: { label: '기준 완화', style: DISCORD_BUTTON_STYLE.SECONDARY },
  scalp_attack: { label: '초공격 scalp', style: DISCORD_BUTTON_STYLE.PRIMARY },
  scalp_stop: { label: 'scalp 중지', style: DISCORD_BUTTON_STYLE.SECONDARY },
  strategy_menu: { label: '전략', style: DISCORD_BUTTON_STYLE.PRIMARY },
  current_strategy: { label: '현재전략', style: DISCORD_BUTTON_STYLE.PRIMARY },
  ai_entry_analysis: { label: 'AI 타점 분석', style: DISCORD_BUTTON_STYLE.PRIMARY },
  market_summary: { label: '시황 요약', style: DISCORD_BUTTON_STYLE.PRIMARY },
  surge_analysis: { label: '급등주 분석', style: DISCORD_BUTTON_STYLE.SECONDARY },
  key_indicators: { label: '주요지표', style: DISCORD_BUTTON_STYLE.SECONDARY },
  no_trade_diagnosis: { label: '거래 부재 진단', style: DISCORD_BUTTON_STYLE.SECONDARY },
  recent_scalp: { label: '최근스캘', style: DISCORD_BUTTON_STYLE.SECONDARY },
  recent_fills: { label: '최근체결', style: DISCORD_BUTTON_STYLE.SECONDARY },
  logic_suggestion: { label: '로직 수정안 제안', style: DISCORD_BUTTON_STYLE.SECONDARY },
  advisor_comment: { label: '조언자의 한마디', style: DISCORD_BUTTON_STYLE.SECONDARY },
  daily_log_analysis: { label: '하루치 로그 분석', style: DISCORD_BUTTON_STYLE.SECONDARY },
  health_check: { label: '헬스', style: DISCORD_BUTTON_STYLE.SECONDARY },
  emergency_control: { label: '비상 제어', style: DISCORD_BUTTON_STYLE.DANGER },
  api_usage: { label: 'API 사용량', style: DISCORD_BUTTON_STYLE.SECONDARY },
  system_update: { label: '시스템 업데이트', style: DISCORD_BUTTON_STYLE.PRIMARY },
};

// ---------------------------------------------------------------------------
// 고정 레이아웃 (5 row × 최대 5버튼, 명시적 배치만)
// ---------------------------------------------------------------------------
export const PANEL_LAYOUT_SPEC: LayoutRowSpec[] = [
  ['engine_start', 'engine_stop', 'current_status', 'current_pnl', 'sell_all'],
  ['race_horse_toggle', 'relax_threshold', 'scalp_attack', 'scalp_stop', 'strategy_menu'],
  ['current_strategy', 'ai_entry_analysis', 'market_summary', 'surge_analysis', 'key_indicators'],
  ['no_trade_diagnosis', 'recent_scalp', 'recent_fills', 'logic_suggestion', 'advisor_comment'],
  ['daily_log_analysis', 'health_check', 'emergency_control', 'api_usage', 'system_update'],
];

// ---------------------------------------------------------------------------
// 레거시 custom_id → 표준 ButtonKey (하위 호환)
// ---------------------------------------------------------------------------
export const LEGACY_BUTTON_ID_ALIASES: Record<string, ButtonKey> = {
  current_state: 'current_status',
  current_return: 'current_pnl',
  relax_toggle: 'relax_threshold',
  independent_scalp_start: 'scalp_attack',
  independent_scalp_stop: 'scalp_stop',
  strategy_view_config: 'current_strategy',
  strategy_skip_recent: 'recent_scalp',
  strategy_buy_recent: 'recent_fills',
  ai_analysis: 'ai_entry_analysis',
  analyst_get_prompt: 'market_summary',
  analyst_scan_vol: 'surge_analysis',
  analyst_indicators: 'key_indicators',
  analyst_diagnose_no_trade: 'no_trade_diagnosis',
  analyst_suggest_logic: 'logic_suggestion',
  analyst_advisor_one_liner: 'advisor_comment',
  api_usage_monitor: 'api_usage',
  health: 'health_check',
  admin_emergency_menu: 'emergency_control',
  admin_git_pull_restart: 'system_update',
};

/** interaction customId → 표준 ButtonKey. 패널 버튼이면 표준 키, 아니면 원본 반환. */
export function normalizeButtonId(customId: string): string {
  if (LEGACY_BUTTON_ID_ALIASES[customId] != null) return LEGACY_BUTTON_ID_ALIASES[customId];
  if (BUTTON_KEYS.includes(customId as ButtonKey)) return customId;
  return customId;
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------
export function validatePanelDefinitions(): boolean {
  let ok = true;
  const definedKeys = new Set<ButtonKey>(BUTTON_KEYS);
  const layoutKeys = new Set<ButtonKey>();
  for (const row of PANEL_LAYOUT_SPEC) {
    for (const k of row) {
      layoutKeys.add(k);
      if (!definedKeys.has(k)) {
        LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: layout references undefined button key', { key: k });
        ok = false;
      }
    }
  }
  for (const k of definedKeys) {
    if (!layoutKeys.has(k)) {
      LogUtil.logWarn(LOG_TAG, 'validatePanelDefinitions: button key not in layout (will not appear)', { key: k });
    }
  }
  const layoutIdCount: Record<string, number> = {};
  for (const row of PANEL_LAYOUT_SPEC) {
    for (const k of row) {
      layoutIdCount[k] = (layoutIdCount[k] ?? 0) + 1;
    }
  }
  for (const [id, count] of Object.entries(layoutIdCount)) {
    if (count > 1) {
      LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: duplicate button key in layout', { key: id });
      ok = false;
    }
  }
  if (PANEL_LAYOUT_SPEC.length > 5) {
    LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: more than 5 rows', { rows: PANEL_LAYOUT_SPEC.length });
    ok = false;
  }
  for (let i = 0; i < PANEL_LAYOUT_SPEC.length; i++) {
    if (PANEL_LAYOUT_SPEC[i].length > 5) {
      LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: row has more than 5 buttons', { rowIndex: i, count: PANEL_LAYOUT_SPEC[i].length });
      ok = false;
    }
  }
  const roleButtonSet = new Set<ButtonKey>();
  for (const role of PANEL_ROLE_DEFINITIONS) {
    for (const k of role.buttons) {
      roleButtonSet.add(k);
      if (!definedKeys.has(k)) {
        LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: role references undefined button key', { roleId: role.id, key: k });
        ok = false;
      }
    }
  }
  for (const k of definedKeys) {
    if (!roleButtonSet.has(k)) {
      LogUtil.logWarn(LOG_TAG, 'validatePanelDefinitions: button key not in any role', { key: k });
    }
  }
  if (ok) LogUtil.logInfo(LOG_TAG, 'validatePanelDefinitions: OK', { layoutVersion: PANEL_LAYOUT_VERSION });
  return ok;
}

// ---------------------------------------------------------------------------
// 패널 모델 (순수 데이터)
// ---------------------------------------------------------------------------
export interface PanelModel {
  lastUpdatedAt?: string;
  panelStatus?: '복구 완료' | '새 패널 생성' | 'fallback' | '';
  layoutVersion: string;
  contentVersion: string;
  roles: RoleSpec[];
}

/** 순수 데이터 모델만 반환 */
export function buildPanelModel(options?: {
  lastUpdatedAt?: string;
  panelStatus?: PanelModel['panelStatus'];
}): PanelModel {
  return {
    lastUpdatedAt: options?.lastUpdatedAt,
    panelStatus: options?.panelStatus ?? '',
    layoutVersion: PANEL_LAYOUT_VERSION,
    contentVersion: PANEL_CONTENT_VERSION,
    roles: PANEL_ROLE_DEFINITIONS,
  };
}

// ---------------------------------------------------------------------------
// 패널 본문 (model 기반)
// ---------------------------------------------------------------------------
export function buildPanelContent(model: PanelModel): string {
  const lines: string[] = [];
  lines.push(`[${model.contentVersion}]`);
  if (model.lastUpdatedAt) {
    try {
      const d = new Date(model.lastUpdatedAt);
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const kstStr = kst.toISOString().slice(0, 19).replace('T', ' ');
      lines.push(`마지막 갱신: ${kstStr} KST`);
    } catch (_) {
      lines.push('마지막 갱신: —');
    }
  } else {
    lines.push('마지막 갱신: —');
  }
  lines.push(`패널 상태: ${model.panelStatus || '—'}`);
  lines.push(`레이아웃: ${model.layoutVersion}`);
  lines.push('');
  for (const r of model.roles) {
    lines.push(`**${r.title}**`);
    lines.push(r.description);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// 패널 컴포넌트 (오직 PANEL_LAYOUT_SPEC 기준, 동적 재배치 없음)
// ---------------------------------------------------------------------------
export type ActionRowPayload = { type: 1; components: { type: 2; style: number; custom_id: string; label: string }[] };

export function buildPanelComponents(_model: PanelModel): ActionRowPayload[] {
  const rows: ActionRowPayload[] = [];
  for (const rowSpec of PANEL_LAYOUT_SPEC) {
    const components: { type: 2; style: number; custom_id: string; label: string }[] = [];
    for (const key of rowSpec) {
      const spec = PANEL_BUTTON_DEFINITIONS[key];
      if (!spec) continue;
      components.push({
        type: 2,
        style: spec.style,
        custom_id: key,
        label: spec.label,
      });
    }
    if (components.length > 0) rows.push({ type: 1, components });
    if (rows.length >= 5) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Fallback 패널 (최소 버튼만)
// ---------------------------------------------------------------------------
export function getFallbackComponents(): ActionRowPayload[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: DISCORD_BUTTON_STYLE.SECONDARY, custom_id: 'health_check', label: '헬스' },
        { type: 2, style: DISCORD_BUTTON_STYLE.DANGER, custom_id: 'emergency_control', label: '비상 제어' },
        { type: 2, style: DISCORD_BUTTON_STYLE.PRIMARY, custom_id: 'system_update', label: '시스템 업데이트' },
      ],
    },
  ];
}

export function getFallbackContent(): string {
  return `[${PANEL_CONTENT_VERSION}]\n패널 상태: fallback\n레이아웃: ${PANEL_LAYOUT_VERSION}\n\n(최소 복구 패널. 로그 확인.)`;
}
