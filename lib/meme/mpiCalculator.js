/**
 * MPI 0~100 계산: MPI_raw = 30*S + 25*T + 20*N + 15*O - 10*F, clamp 0~100
 * S=reddit_velocity, T=trend_spike, N=news_burst, O=oi_spike, F=funding_heat
 */

const logger = require('./logger');

function scale(x) {
  return Math.max(0, Math.min(2, (x - 1) * 0.5 + 1));
}

function computeMPI(symbol, reddit, trends, news, futures) {
  const S = reddit?.velocity != null ? scale(reddit.velocity) : 1;
  const T = trends != null ? scale(trends) : 1;
  const N = news?.news_burst != null ? scale(news.news_burst) : 1;
  const O = futures?.oi_spike != null ? scale(futures.oi_spike) : 1;
  const F = futures?.funding_heat != null ? Math.min(2, futures.funding_heat) : 0;

  logger.comp(`symbol=${symbol} S=${S.toFixed(2)} T=${T.toFixed(2)} N=${N.toFixed(2)} O=${O.toFixed(2)} F=${F.toFixed(2)}`, { symbol, S, T, N, O, F });

  const mpi_raw = 30 * S + 25 * T + 20 * N + 15 * O - 10 * F;
  const mpi = Math.max(0, Math.min(100, Math.round(mpi_raw)));

  return {
    mpi,
    mpi_raw,
    components: { S, T, N, O, F },
    raw: {
      reddit_velocity: reddit?.velocity,
      trend_spike: trends,
      news_burst: news?.news_burst,
      oi_spike: futures?.oi_spike,
      funding_heat: futures?.funding_heat
    }
  };
}

module.exports = { computeMPI, scale };
