/**
 * Upbit WebSocket 실시간 시세 (ticker)
 * wss://api.upbit.com/websocket/v1
 */

const WebSocket = require('ws');

const WS_URL = 'wss://api.upbit.com/websocket/v1';

function subscribeTicker(codes, onMessage, onError) {
  const ws = new WebSocket(WS_URL);
  const payload = [
    { ticket: 'ticker-' + Date.now() },
    { type: 'ticker', codes },
    { format: 'DEFAULT' }
  ];

  ws.on('open', () => {
    ws.send(JSON.stringify(payload));
  });

  ws.on('message', (data) => {
    try {
      const row = JSON.parse(data.toString());
      const item = Array.isArray(row) ? row[0] : row;
      if (item && (item.code || item.market) && item.trade_price != null) {
        const code = item.code || item.market;
        const ts = item.timestamp ? new Date(item.timestamp).getTime() : Date.now();
        const wsLagMs = Math.max(0, Date.now() - ts);
        onMessage({
          market: code,
          tradePrice: item.trade_price,
          signedChangeRate: item.signed_change_rate,
          timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
          wsLagMs
        });
      }
    } catch (err) {
      if (onError) onError(err);
    }
  });

  ws.on('error', (err) => {
    if (onError) onError(err);
  });

  ws.on('close', () => {});

  return ws;
}

module.exports = { subscribeTicker };
