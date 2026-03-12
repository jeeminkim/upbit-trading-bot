"use strict";
/**
 * 고정 패널 규약 — 역할/버튼/레이아웃 불변 계약
 * - 역할 A/B/C 명칭·의미 고정
 * - 버튼 customId·역할 소속·스타일 고정
 *
 * 레이아웃 분리:
 * - ROLE_LAYOUT_IDEAL_SPEC: 역할별 "이상적인" 논리 레이아웃 (사람이 이해하는 row 구성). paged 모드에서 사용.
 * - PANEL_LAYOUT_SPEC: 단일 메시지(single) 모드에서 실제 Discord에 뿌리는 row 배치. 최대 5 row, 자동 slice 금지.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_BUTTON_ID_ALIASES = exports.PANEL_LAYOUT_SPEC = exports.PANEL_BUTTON_DEFINITIONS = exports.ROLE_PANEL_LAYOUT_SPEC = exports.ROLE_LAYOUT_IDEAL_SPEC = exports.PANEL_ROLE_DEFINITIONS = exports.PANEL_PAGED_MENU_KEYS = exports.PANEL_CONTENT_VERSION = exports.PANEL_LAYOUT_VERSION = exports.DISCORD_MAX_BUTTONS_PER_ROW = exports.DISCORD_MAX_ROWS_PER_MESSAGE = exports.BUTTON_KEYS = exports.ROLE_TYPES = exports.DISCORD_BUTTON_STYLE = void 0;
exports.normalizeButtonId = normalizeButtonId;
exports.validatePanelDefinitions = validatePanelDefinitions;
exports.buildPanelModel = buildPanelModel;
exports.buildPanelContent = buildPanelContent;
exports.buildPanelComponents = buildPanelComponents;
exports.buildRolePanelContent = buildRolePanelContent;
exports.buildRolePanelComponents = buildRolePanelComponents;
exports.getFallbackComponents = getFallbackComponents;
exports.getFallbackContent = getFallbackContent;
const LogUtil_1 = require("../../../packages/core/src/LogUtil");
const LOG_TAG = 'DISCORD_OP_PANEL';
/** Discord Button Style: 1=PRIMARY, 2=SECONDARY, 3=SUCCESS, 4=DANGER */
exports.DISCORD_BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };
/** 역할 타입 — 고정 운영 개념 */
exports.ROLE_TYPES = ['A', 'B', 'C'];
/** 표준 버튼 키 (고정 계약 custom_id) */
exports.BUTTON_KEYS = [
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
];
/** Discord 단일 메시지당 최대 ActionRow 개수 (제약 상수) */
exports.DISCORD_MAX_ROWS_PER_MESSAGE = 5;
/** Discord row당 최대 버튼 개수 */
exports.DISCORD_MAX_BUTTONS_PER_ROW = 5;
/** 패널 레이아웃 버전 — 변경 시 여기만 수정 */
exports.PANEL_LAYOUT_VERSION = 'ROLE_FIXED_V1';
exports.PANEL_CONTENT_VERSION = 'AUTO_TRADE_CONTROL_PANEL_V3';
/** 페이지형 UI용 상위 메뉴 버튼 키 (예약). 추후 panel_role_A/B/C 클릭 시 paged 모드로 전환 시 사용 */
exports.PANEL_PAGED_MENU_KEYS = ['panel_role_A', 'panel_role_B', 'panel_role_C', 'panel_back_home'];
// ---------------------------------------------------------------------------
// 역할 정의 (고정)
// ---------------------------------------------------------------------------
/** 역할 A — 현장 지휘관: 엔진 제어 · 실시간 상태 · 수익/보유/체결 기반 즉시 액션 · 공격/중지/매도 */
/** 역할 B — 정보 분석가: AI 분석 · 시황 요약 · 주요 지표 · 거래 부재 진단 · 최근 체결/스캘/로그 리뷰/조언 */
/** 역할 C — 서버 관리자: 시스템 상태 점검 · API 사용량 · 비상 제어 · 시스템 업데이트/복구/운영 안정성 */
exports.PANEL_ROLE_DEFINITIONS = [
    {
        id: 'A',
        title: '역할 A — 현장 지휘관',
        description: '상태 확인 · 수익 확인 · 즉시 제어 · 전략 조정',
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
        description: 'AI 분석 · 시황 요약 · 주요지표 · 거래 리뷰 · 개선 제안',
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
// ROLE_LAYOUT_IDEAL_SPEC — 역할별 "이상적인" 논리 레이아웃 (Discord 5 row 제약과 무관)
// ---------------------------------------------------------------------------
/** 역할별 이상 레이아웃. 사람이 이해하는 논리적 row 구성. paged 모드에서 사용. */
exports.ROLE_LAYOUT_IDEAL_SPEC = {
    A: [
        ['engine_start', 'engine_stop', 'current_status'],
        ['current_pnl', 'sell_all'],
        ['race_horse_toggle', 'relax_threshold'],
        ['scalp_attack', 'scalp_stop'],
        ['strategy_menu', 'current_strategy'],
    ],
    B: [
        ['ai_entry_analysis', 'market_summary', 'surge_analysis', 'key_indicators', 'no_trade_diagnosis'],
        ['recent_scalp', 'recent_fills', 'logic_suggestion', 'advisor_comment', 'daily_log_analysis'],
    ],
    C: [['health_check', 'emergency_control', 'api_usage', 'system_update']],
};
// ---------------------------------------------------------------------------
// ROLE_PANEL_LAYOUT_SPEC — 역할별 메시지 1개당 버튼 row (역할 제목 아래 해당 역할 버튼만)
// ---------------------------------------------------------------------------
/** 역할별 패널 메시지용 row 구성. 메시지당 최대 5 row, row당 최대 5 버튼. */
exports.ROLE_PANEL_LAYOUT_SPEC = {
    A: [
        ['engine_start', 'engine_stop', 'current_status', 'current_strategy', 'current_pnl'],
        ['sell_all', 'race_horse_toggle', 'relax_threshold', 'scalp_attack', 'scalp_stop'],
        ['strategy_menu'],
    ],
    B: [
        ['ai_entry_analysis', 'market_summary', 'surge_analysis', 'key_indicators'],
        ['no_trade_diagnosis', 'recent_scalp', 'recent_fills'],
        ['logic_suggestion', 'advisor_comment', 'daily_log_analysis'],
    ],
    C: [['health_check', 'emergency_control', 'api_usage', 'system_update']],
};
// ---------------------------------------------------------------------------
// 버튼 정의 (key = custom_id, label/style 고정)
// ---------------------------------------------------------------------------
exports.PANEL_BUTTON_DEFINITIONS = {
    engine_start: { label: '엔진 가동', style: exports.DISCORD_BUTTON_STYLE.SUCCESS },
    engine_stop: { label: '즉시 정지', style: exports.DISCORD_BUTTON_STYLE.DANGER },
    current_status: { label: '현재 상태', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    current_pnl: { label: '현재 수익률', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    sell_all: { label: '전체 매도', style: exports.DISCORD_BUTTON_STYLE.DANGER },
    race_horse_toggle: { label: '경주마 ON/OFF', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    relax_threshold: { label: '기준 완화', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    scalp_attack: { label: '초공격 scalp', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
    scalp_stop: { label: 'scalp 중지', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    strategy_menu: { label: '전략', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
    current_strategy: { label: '현재전략', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
    ai_entry_analysis: { label: 'AI 타점 분석', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
    market_summary: { label: '시황 요약', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
    surge_analysis: { label: '급등주 분석', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    key_indicators: { label: '주요지표', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    no_trade_diagnosis: { label: '거래 부재 진단', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    recent_scalp: { label: '최근스캘', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    recent_fills: { label: '최근체결', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    logic_suggestion: { label: '로직 수정안 제안', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    advisor_comment: { label: '조언자의 한마디', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    daily_log_analysis: { label: '하루치 로그 분석', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    health_check: { label: '헬스', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    emergency_control: { label: '비상 제어', style: exports.DISCORD_BUTTON_STYLE.DANGER },
    api_usage: { label: 'API 사용량', style: exports.DISCORD_BUTTON_STYLE.SECONDARY },
    system_update: { label: '시스템 업데이트', style: exports.DISCORD_BUTTON_STYLE.PRIMARY },
};
// ---------------------------------------------------------------------------
// PANEL_LAYOUT_SPEC — 단일 메시지 모드(single)에서만 사용하는 실제 Discord row 배치 (최대 5 row)
// Row1: 상태/전략/수익·즉시 조치  Row2: 모드/기준/공격/전략 조정  Row3~4: 역할 B  Row5: 역할 C
// ---------------------------------------------------------------------------
exports.PANEL_LAYOUT_SPEC = [
    ['engine_start', 'engine_stop', 'current_status', 'current_strategy', 'current_pnl'],
    ['sell_all', 'race_horse_toggle', 'relax_threshold', 'scalp_attack', 'strategy_menu'],
    ['scalp_stop', 'ai_entry_analysis', 'market_summary', 'surge_analysis', 'key_indicators'],
    ['no_trade_diagnosis', 'recent_scalp', 'recent_fills', 'logic_suggestion', 'advisor_comment'],
    ['daily_log_analysis', 'health_check', 'emergency_control', 'api_usage', 'system_update'],
];
// ---------------------------------------------------------------------------
// 레거시 custom_id → 표준 ButtonKey (하위 호환)
// ---------------------------------------------------------------------------
exports.LEGACY_BUTTON_ID_ALIASES = {
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
function normalizeButtonId(customId) {
    if (exports.LEGACY_BUTTON_ID_ALIASES[customId] != null)
        return exports.LEGACY_BUTTON_ID_ALIASES[customId];
    if (exports.BUTTON_KEYS.includes(customId))
        return customId;
    return customId;
}
// ---------------------------------------------------------------------------
// 검증 (PANEL_LAYOUT_SPEC, ROLE_LAYOUT_IDEAL_SPEC, single/paged 제약, 역할 소속 일치)
// ---------------------------------------------------------------------------
function validatePanelDefinitions() {
    let ok = true;
    const definedKeys = new Set(exports.BUTTON_KEYS);
    // --- PANEL_LAYOUT_SPEC (single 모드 실제 렌더 레이아웃) ---
    const layoutKeys = new Set();
    for (const row of exports.PANEL_LAYOUT_SPEC) {
        for (const k of row) {
            layoutKeys.add(k);
            if (!definedKeys.has(k)) {
                LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: layout references undefined button key', { key: k });
                ok = false;
            }
        }
    }
    for (const k of definedKeys) {
        if (!layoutKeys.has(k)) {
            LogUtil_1.LogUtil.logWarn(LOG_TAG, 'validatePanelDefinitions: button key not in layout (will not appear)', { key: k });
        }
    }
    const layoutIdCount = {};
    for (const row of exports.PANEL_LAYOUT_SPEC) {
        for (const k of row) {
            layoutIdCount[k] = (layoutIdCount[k] ?? 0) + 1;
        }
    }
    for (const [id, count] of Object.entries(layoutIdCount)) {
        if (count > 1) {
            LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: duplicate button key in layout', { key: id });
            ok = false;
        }
    }
    if (exports.PANEL_LAYOUT_SPEC.length > exports.DISCORD_MAX_ROWS_PER_MESSAGE) {
        LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: single mode more than 5 rows', { rows: exports.PANEL_LAYOUT_SPEC.length });
        ok = false;
    }
    for (let i = 0; i < exports.PANEL_LAYOUT_SPEC.length; i++) {
        if (exports.PANEL_LAYOUT_SPEC[i].length > exports.DISCORD_MAX_BUTTONS_PER_ROW) {
            LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: row has more than 5 buttons', { rowIndex: i, count: exports.PANEL_LAYOUT_SPEC[i].length });
            ok = false;
        }
    }
    // --- ROLE_LAYOUT_IDEAL_SPEC (역할별 이상 레이아웃) ---
    const roleDefMap = new Map();
    for (const r of exports.PANEL_ROLE_DEFINITIONS)
        roleDefMap.set(r.id, r);
    for (const roleId of exports.ROLE_TYPES) {
        const idealRows = exports.ROLE_LAYOUT_IDEAL_SPEC[roleId];
        const roleSpec = roleDefMap.get(roleId);
        if (!roleSpec)
            continue;
        const roleButtonSet = new Set(roleSpec.buttons);
        if (idealRows.length > exports.DISCORD_MAX_ROWS_PER_MESSAGE) {
            LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_LAYOUT_IDEAL_SPEC row count > 5', { roleId, rows: idealRows.length });
            ok = false;
        }
        for (let ri = 0; ri < idealRows.length; ri++) {
            const row = idealRows[ri];
            if (row.length > exports.DISCORD_MAX_BUTTONS_PER_ROW) {
                LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_LAYOUT_IDEAL_SPEC row buttons > 5', { roleId, rowIndex: ri, count: row.length });
                ok = false;
            }
            for (const k of row) {
                if (!definedKeys.has(k)) {
                    LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_LAYOUT_IDEAL_SPEC references undefined button key', { roleId, key: k });
                    ok = false;
                }
                if (!roleButtonSet.has(k)) {
                    LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_LAYOUT_IDEAL_SPEC button not in role', { roleId, key: k });
                    ok = false;
                }
            }
        }
    }
    // --- ROLE_PANEL_LAYOUT_SPEC (역할별 메시지용 row) ---
    for (const roleId of exports.ROLE_TYPES) {
        const panelRows = exports.ROLE_PANEL_LAYOUT_SPEC[roleId];
        const roleSpec = roleDefMap.get(roleId);
        if (!roleSpec || !panelRows)
            continue;
        const roleButtonSet = new Set(roleSpec.buttons);
        if (panelRows.length > exports.DISCORD_MAX_ROWS_PER_MESSAGE) {
            LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_PANEL_LAYOUT_SPEC row count > 5', { roleId, rows: panelRows.length });
            ok = false;
        }
        for (let ri = 0; ri < panelRows.length; ri++) {
            const row = panelRows[ri];
            if (row.length > exports.DISCORD_MAX_BUTTONS_PER_ROW) {
                LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_PANEL_LAYOUT_SPEC row buttons > 5', { roleId, rowIndex: ri, count: row.length });
                ok = false;
            }
            for (const k of row) {
                if (!definedKeys.has(k)) {
                    LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_PANEL_LAYOUT_SPEC references undefined button key', { roleId, key: k });
                    ok = false;
                }
                if (!roleButtonSet.has(k)) {
                    LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: ROLE_PANEL_LAYOUT_SPEC button not in role', { roleId, key: k });
                    ok = false;
                }
            }
        }
    }
    // --- 역할 소속 일치 (PANEL_ROLE_DEFINITIONS) ---
    const roleButtonSet = new Set();
    for (const role of exports.PANEL_ROLE_DEFINITIONS) {
        for (const k of role.buttons) {
            roleButtonSet.add(k);
            if (!definedKeys.has(k)) {
                LogUtil_1.LogUtil.logError(LOG_TAG, 'validatePanelDefinitions: role references undefined button key', { roleId: role.id, key: k });
                ok = false;
            }
        }
    }
    for (const k of definedKeys) {
        if (!roleButtonSet.has(k)) {
            LogUtil_1.LogUtil.logWarn(LOG_TAG, 'validatePanelDefinitions: button key not in any role', { key: k });
        }
    }
    if (ok)
        LogUtil_1.LogUtil.logInfo(LOG_TAG, 'validatePanelDefinitions: OK', { layoutVersion: exports.PANEL_LAYOUT_VERSION });
    return ok;
}
/** 순수 데이터 모델만 반환 */
function buildPanelModel(options) {
    return {
        lastUpdatedAt: options?.lastUpdatedAt,
        panelStatus: options?.panelStatus ?? '',
        layoutVersion: exports.PANEL_LAYOUT_VERSION,
        contentVersion: exports.PANEL_CONTENT_VERSION,
        roles: exports.PANEL_ROLE_DEFINITIONS,
    };
}
// ---------------------------------------------------------------------------
// 패널 본문 (model 기반, options로 렌더 모드/현재 페이지 노출)
// ---------------------------------------------------------------------------
function buildPanelContent(model, options) {
    const renderMode = options?.renderMode ?? 'single';
    const activeRole = options?.activeRole ?? null;
    const lines = [];
    lines.push(`[${model.contentVersion}]`);
    if (model.lastUpdatedAt) {
        try {
            const d = new Date(model.lastUpdatedAt);
            const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            const kstStr = kst.toISOString().slice(0, 19).replace('T', ' ');
            lines.push(`마지막 갱신: ${kstStr} KST`);
        }
        catch (_) {
            lines.push('마지막 갱신: —');
        }
    }
    else {
        lines.push('마지막 갱신: —');
    }
    lines.push(`패널 상태: ${model.panelStatus || '—'}`);
    lines.push(`레이아웃: ${model.layoutVersion}`);
    lines.push(`렌더 모드: ${renderMode === 'single' ? 'SINGLE' : 'PAGED'}`);
    if (renderMode === 'paged' && activeRole) {
        const roleSpec = exports.PANEL_ROLE_DEFINITIONS.find((r) => r.id === activeRole);
        lines.push(`현재 페이지: 역할 ${activeRole} — ${roleSpec?.title ?? activeRole}`);
    }
    lines.push('');
    for (const r of model.roles) {
        lines.push(`**${r.title}**`);
        lines.push(r.description);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
function rowSpecToActionRow(rowSpec) {
    const components = [];
    for (const key of rowSpec) {
        const spec = exports.PANEL_BUTTON_DEFINITIONS[key];
        if (!spec)
            continue;
        components.push({ type: 2, style: spec.style, custom_id: key, label: spec.label });
    }
    if (components.length === 0)
        return null;
    return { type: 1, components };
}
function buildPanelComponents(model, options) {
    const renderMode = options?.renderMode ?? 'single';
    const activeRole = options?.activeRole ?? null;
    if (renderMode === 'single') {
        const rows = [];
        for (const rowSpec of exports.PANEL_LAYOUT_SPEC) {
            const row = rowSpecToActionRow(rowSpec);
            if (row)
                rows.push(row);
            if (rows.length >= exports.DISCORD_MAX_ROWS_PER_MESSAGE)
                break;
        }
        return rows;
    }
    if (renderMode === 'paged' && activeRole && exports.ROLE_TYPES.includes(activeRole)) {
        const idealRows = exports.ROLE_LAYOUT_IDEAL_SPEC[activeRole];
        const rows = [];
        for (const rowSpec of idealRows) {
            const row = rowSpecToActionRow(rowSpec);
            if (row)
                rows.push(row);
            if (rows.length >= exports.DISCORD_MAX_ROWS_PER_MESSAGE)
                break;
        }
        return rows;
    }
    // fallback: paged인데 activeRole 없거나 잘못됨 → single 레이아웃 사용
    const rows = [];
    for (const rowSpec of exports.PANEL_LAYOUT_SPEC) {
        const row = rowSpecToActionRow(rowSpec);
        if (row)
            rows.push(row);
        if (rows.length >= exports.DISCORD_MAX_ROWS_PER_MESSAGE)
            break;
    }
    return rows;
}
// ---------------------------------------------------------------------------
// 역할별 패널 메시지용 content / components (역할 제목 바로 아래 해당 역할 버튼만)
// ---------------------------------------------------------------------------
/** 역할별 단일 메시지 본문: 제목 + 설명만. */
function buildRolePanelContent(role, options) {
    const spec = exports.PANEL_ROLE_DEFINITIONS.find((r) => r.id === role);
    if (!spec)
        return `[${exports.PANEL_CONTENT_VERSION}]\n역할 ${role} (정의 없음)`;
    const lines = [];
    lines.push(`[${exports.PANEL_CONTENT_VERSION}]`);
    if (options?.lastUpdatedAt) {
        try {
            const d = new Date(options.lastUpdatedAt);
            const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            lines.push(`마지막 갱신: ${kst.toISOString().slice(0, 19).replace('T', ' ')} KST`);
        }
        catch (_) { }
    }
    lines.push('');
    lines.push(`**${spec.title}**`);
    lines.push(spec.description);
    return lines.join('\n').trimEnd();
}
/** 역할별 단일 메시지용 버튼 row (ROLE_PANEL_LAYOUT_SPEC 기준). */
function buildRolePanelComponents(role) {
    const rowsSpec = exports.ROLE_PANEL_LAYOUT_SPEC[role];
    if (!rowsSpec)
        return [];
    const rows = [];
    for (const rowSpec of rowsSpec) {
        const row = rowSpecToActionRow(rowSpec);
        if (row)
            rows.push(row);
        if (rows.length >= exports.DISCORD_MAX_ROWS_PER_MESSAGE)
            break;
    }
    return rows;
}
// ---------------------------------------------------------------------------
// Fallback 패널 (최소 버튼만)
// ---------------------------------------------------------------------------
function getFallbackComponents() {
    return [
        {
            type: 1,
            components: [
                { type: 2, style: exports.DISCORD_BUTTON_STYLE.SECONDARY, custom_id: 'health_check', label: '헬스' },
                { type: 2, style: exports.DISCORD_BUTTON_STYLE.DANGER, custom_id: 'emergency_control', label: '비상 제어' },
                { type: 2, style: exports.DISCORD_BUTTON_STYLE.PRIMARY, custom_id: 'system_update', label: '시스템 업데이트' },
            ],
        },
    ];
}
function getFallbackContent() {
    return `[${exports.PANEL_CONTENT_VERSION}]\n패널 상태: fallback\n레이아웃: ${exports.PANEL_LAYOUT_VERSION}\n\n(최소 복구 패널. 로그 확인.)`;
}
