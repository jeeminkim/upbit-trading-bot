export enum PermissionLevel {
  SUPER_ADMIN = 4,
  ADMIN = 3,
  ANALYST = 2,
  VIEWER = 1,
  NONE = 0,
}

export interface PermissionContext {
  userId: string;
  channelId: string;
  role: PermissionLevel;
  allowedChannels: string[];
}

export type AppResult<T> =
  | { ok: true; data: T; meta?: { cachedAt?: number } }
  | { ok: false; error: AppError };

export interface AppError {
  code: string;
  message: string;
  details?: string;
}

export interface AssetSummary {
  totalEvaluationKrw: number;
  totalBuyKrw: number;
  totalBuyKrwForCoins: number;
  orderableKrw: number;
}

export interface EngineStateSnapshot {
  botEnabled: boolean;
  currentPosition: Record<string, number>;
  lastOrderAt: string | null;
  cooldownUntil: number | null;
  dailyPnL: number;
  openOrders: OpenOrder[];
  assets: AssetSummary | null;
}

export interface OpenOrder {
  uuid: string;
  market: string;
  side: string;
  price: number;
  volume: number;
}

export interface EmbedMeta {
  timestamp: string;
  model: string;
  dataRange: string;
  symbolCount: number;
  errorCode?: string;
  warning?: string;
}

export type EventType =
  | 'ENGINE_STARTED'
  | 'ENGINE_STOPPED'
  | 'ORDER_FILLED'
  | 'ORDER_FAILED'
  | 'ORDER_SUBMITTED'
  | 'MARKET_SIGNAL'
  | 'STRATEGY_SIGNAL'
  | 'TRADE_SKIPPED'
  | 'EXPLAIN_ENTRY'
  | 'STRATEGY_MODE_CHANGED'
  | 'STRATEGY_THRESHOLD_UPDATED'
  | 'GEMINI_ANALYSIS_READY'
  | 'DASHBOARD_EMIT'
  | 'AUDIT_COMMAND';

export interface AuditLogEntry {
  userId: string;
  command: string;
  timestamp: string;
  success: boolean;
  errorCode?: string;
  approved?: boolean;
  orderCreated?: boolean;
}
