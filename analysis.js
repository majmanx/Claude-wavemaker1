// 声音分析。给一个 AudioBuffer，算出：倍频程能量分布、频谱斜率、浪的周期、拍岸时刻和间歇时刻的亮度。
// 纯 JS，不依赖任何库。被 analyze.html 和自动化测试共用。
(function (global) {
  const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  // 文献里海滩录音的典型长期频谱（相对 500 Hz 倍频程，dB）。能量集中在 125 到 1000 Hz，往上每倍频程掉 5 到 6 dB。
  // 这是一个起点，不是真理：用你自己的录音跑一遍，把结果替换进来。
  const TARGET_SURF = { 63: -8, 125: -3, 250: -1, 500: 0, 1000: -3, 2000: -8, 4000: -14, 8000: -21, 16000: -30 };

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  function analyze(buffer, opts = {}) {
    const N = opts.fftSize || 4096, hop = N / 2, sr = buffer.sampleRate;
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }

    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const bins = N / 2, binHz = sr / N;
    const avg = new Float64Array(bins);
    const frames = [];
    const loBin = Math.round(100 / binHz), hiBin = Math.round(1000 / binHz);
    let count = 0;
    for (let pos = 0; pos + N <= len; pos += hop) {
      for (let i = 0; i < N; i++) { re[i] = mono[pos + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let env = 0, cSum = 0, pSum = 0;
      for (let k = 1; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        avg[k] += p;
        if (k >= loBin && k <= hiBin) env += p;
        cSum += p * k * binHz; pSum += p;
      }
      frames.push({ t: pos / sr, env: Math.sqrt(env), centroid: pSum > 0 ? cSum / pSum : 0 });
      count++;
    }
    if (!count) return null;
    for (let k = 0; k < bins; k++) avg[k] /= count;

    // 倍频程能量
    const bands = {};
    let total = 0;
    for (const fc of BANDS) {
      const lo = Math.max(1, Math.round(fc / Math.SQRT2 / binHz)), hi = Math.min(bins - 1, Math.round(fc * Math.SQRT2 / binHz));
      let p = 0; for (let k = lo; k <= hi; k++) p += avg[k];
      bands[fc] = p; total += p;
    }
    const ref = bands[500] || 1e-12;
    const bandsDb = {}; for (const fc of BANDS) bandsDb[fc] = 10 * Math.log10((bands[fc] || 1e-20) / ref);
    // 频谱斜率：250 Hz 到 8 kHz 的线性回归，dB/倍频程
    const xs = [], ys = [];
    for (const fc of [250, 500, 1000, 2000, 4000, 8000]) { xs.push(Math.log2(fc)); ys.push(bandsDb[fc]); }
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let num = 0, den = 0; for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = num / den;
    const centroid = (() => { let c = 0, p = 0; for (let k = 1; k < bins; k++) { c += avg[k] * k * binHz; p += avg[k]; } return c / p; })();

    // 包络：100 到 1000 Hz 的能量随时间的变化，用自相关找浪的周期
    const env = frames.map(f => f.env);
    const sm = env.map((_, i) => { let s = 0, n = 0; for (let j = -3; j <= 3; j++) { const v = env[i + j]; if (v !== undefined) { s += v; n++; } } return s / n; });
    const mean = sm.reduce((a, b) => a + b) / sm.length;
    const dev = sm.map(v => v - mean);
    const dt = hop / sr;
    let bestLag = 0, bestR = -1;
    const var0 = dev.reduce((a, b) => a + b * b, 0);
    for (let lag = Math.round(3 / dt); lag < Math.min(dev.length / 2, Math.round(25 / dt)); lag++) {
      let r = 0; for (let i = 0; i + lag < dev.length; i++) r += dev[i] * dev[i + lag];
      r /= var0;
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    const sorted = [...sm].sort((a, b) => a - b);
    const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const crest = q(0.95) / (q(0.5) || 1e-9);

    // 拍岸时刻（包络最高的 15%）和间歇时刻（最低的 30%）的亮度
    const hiT = q(0.85), loT = q(0.30);
    let bc = 0, bn = 0, tc = 0, tn = 0;
    frames.forEach((f, i) => { if (sm[i] >= hiT) { bc += f.centroid; bn++; } else if (sm[i] <= loT) { tc += f.centroid; tn++; } });

    let rms = 0; for (let i = 0; i < len; i++) rms += mono[i] * mono[i]; rms = Math.sqrt(rms / len);

    return {
      seconds: len / sr, sampleRate: sr, channels: ch,
      rmsDb: 20 * Math.log10(rms || 1e-9),
      bandsDb, slope, centroid,
      wavePeriod: bestLag * dt, periodStrength: bestR, crest,
      breakCentroid: bn ? bc / bn : 0, troughCentroid: tn ? tc / tn : 0,
      envelope: sm, envelopeDt: dt,
    };
  }

  function report(r, name = '') {
    if (!r) return '（太短，无法分析）';
    const lines = [];
    lines.push(`${name} ${r.seconds.toFixed(1)} s · ${r.sampleRate} Hz · ${r.channels} ch · RMS ${r.rmsDb.toFixed(1)} dBFS`);
    lines.push('倍频程（相对 500 Hz，dB）：');
    for (const fc of BANDS) lines.push(`  ${String(fc).padStart(5)} Hz  ${r.bandsDb[fc].toFixed(1).padStart(6)}   目标 ${String(TARGET_SURF[fc]).padStart(4)}   差 ${(r.bandsDb[fc] - TARGET_SURF[fc]).toFixed(1).padStart(6)}`);
    lines.push(`频谱斜率 ${r.slope.toFixed(1)} dB/倍频程（目标约 -5 到 -6）· 质心 ${r.centroid.toFixed(0)} Hz`);
    lines.push(`浪的周期 ${r.wavePeriod.toFixed(1)} s（自相关 ${r.periodStrength.toFixed(2)}）· 峰均比 ${r.crest.toFixed(2)}`);
    lines.push(`拍岸时亮度 ${r.breakCentroid.toFixed(0)} Hz · 间歇时亮度 ${r.troughCentroid.toFixed(0)} Hz`);
    return lines.join('\n');
  }

  global.Analysis = { BANDS, TARGET_SURF, analyze, report, fft };
})(window);
