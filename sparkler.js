// Wavemaker 仙女棒引擎。三种口味：
//   raw     原味：几千颗极小的火花糊成一片带颗粒感的嘶声，偶尔飞出一颗，快熄灭时断断续续
//   electro 电子：每颗火花是一个高 Q 带通的"叮"，抱团成不规则律动（第一版，像拉长的鞭炮和踩镲滚奏）
//   drum    鼓机：电子口味的火花对齐到节拍网格，有摇摆和滚奏，当踩镲用
(function (global) {
  function hashSeed(str) { let h = 1779033703 ^ str.length; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return (h >>> 0) || 1; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function noiseBuffer(ctx, rng, color, seconds = 3) {
    const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    } else for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    return buf;
  }
  function noiseSource(ctx, rng, color = 'white') { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, rng, color); s.loop = true; s.start(0); return s; }

  // 原味口味的核心：一条"噼啪包络"。每秒几千个泊松脉冲，每个衰减不到 1 毫秒，叠在一个底上，
  // 再乘一个 30 到 80 Hz 的粗糙起伏。把它接到增益上，噪声就有了燃烧的颗粒感。
  function crackleBuffer(ctx, rng, rate, seconds = 4) {
    const sr = ctx.sampleRate, len = Math.floor(sr * seconds), buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    const decay = Math.exp(-1 / (sr * 0.0004));
    let env = 0, next = 0, rough = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      while (next <= i) { env += 0.3 + 1.7 * Math.pow(rng(), 3); next += -Math.log(1 - rng()) / rate * sr; }
      env *= decay;
      rough += ((rng() * 2 - 1) - rough) * 0.004;            // 慢慢飘的粗糙度
      d[i] = (0.35 + env) * (1 + 3 * rough);
      if (d[i] > peak) peak = d[i];
    }
    for (let i = 0; i < len; i++) d[i] = Math.max(0, d[i] / peak);
    return buf;
  }

  function voice(ctx, rng, dest, type, freq, Q, color = 'white') {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = ctx.createGain(); g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    noiseSource(ctx, rng, color).connect(f).connect(g).connect(pan).connect(dest);
    return { f, gain: g.gain, pan: pan.pan };
  }

  // 一根仙女棒的亮度曲线：点燃很快，中段微微起伏，最后 20% 越来越弱
  function intensity(sp, t) {
    const u = (t - sp.t0) / sp.dur;
    if (u < 0) return 0;
    if (u < 0.02) return u / 0.02;
    if (u < 0.8) return 0.82 + 0.18 * Math.sin(t * 1.3 + sp.phase) * Math.sin(t * 0.37 + sp.phase * 2);
    if (u < 1) { const tail = (1 - u) / 0.2; return Math.pow(tail, 1.4) * 0.9; }
    return 0;
  }

  function buildScene(ctx, p, onSpark) {
    const rng = mulberry32(hashSeed(p.seed + ':' + p.mode));
    const master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.002; comp.release.value = 0.25;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    master.connect(comp).connect(analyser).connect(ctx.destination);

    // 电子和鼓机共用的火花声部
    const N = 8;
    const ticks = []; for (let i = 0; i < N; i++) ticks.push(voice(ctx, rng, master, 'bandpass', 5000, 3));
    // 原味的飞溅声部：低 Q，中心频率往下滑
    const flyers = []; for (let i = 0; i < 4; i++) flyers.push(voice(ctx, rng, master, 'bandpass', 5000, 1.1));
    const pops = voice(ctx, rng, master, 'bandpass', 1400, 1.2);
    const hiss = voice(ctx, rng, master, 'highpass', 5000, 0.7);
    const ignite = voice(ctx, rng, master, 'bandpass', 600, 1.5);
    let vi = 0, fi = 0;
    const S = { sparklers: [], until: 0 };

    // 原味：每根仙女棒有自己的一条燃烧噪声链
    function rawChain(sp) {
      const src = noiseSource(ctx, rng, 'pink');
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900 + 600 * (1 - p.depth); hp.Q.value = 0.7;
      const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 2600 + 2400 * (1 - p.depth); pk.Q.value = 0.9; pk.gain.value = 6;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000 + 5000 * (1 - p.depth); lp.Q.value = 0.6;
      const mod = ctx.createGain(); mod.gain.value = 0;                     // 增益由噼啪包络驱动
      const depth = ctx.createGain(); depth.gain.value = 0;                 // 包络的深度 = 亮度 × 力度
      const gate = ctx.createGain(); gate.gain.value = 1;                   // 熄灭时的断续
      const pan = ctx.createStereoPanner(); pan.pan.value = sp.pan;
      const crackle = ctx.createBufferSource(); crackle.buffer = crackleBuffer(ctx, rng, 800 + 3200 * p.density); crackle.loop = true;
      crackle.connect(depth).connect(mod.gain); crackle.start(sp.t0);
      src.connect(hp).connect(pk).connect(lp).connect(mod).connect(gate).connect(pan).connect(master);
      return { depth: depth.gain, gate: gate.gain, pan: pan.pan, stop: t => { src.stop(t); crackle.stop(t); } };
    }

    function light(t0, pan) {
      const sp = { t0, dur: p.burn * (0.9 + 0.2 * rng()), phase: rng() * 6.28, pan: pan ?? (rng() * 1.2 - 0.6), next: t0, segEnd: t0, mul: 1, id: S.sparklers.length + 1, nextGate: t0, nextFlyer: t0 + 0.3, nextPop: t0 + 2 + rng() * 4, lastStep: -1 };
      S.sparklers.push(sp);
      if (p.mode === 'raw') {
        sp.chain = rawChain(sp);
        // 划着：先一小声"呲"，再猛地起来
        ignite.f.frequency.setValueAtTime(1500, t0); ignite.f.frequency.exponentialRampToValueAtTime(5000, t0 + 0.25);
        ignite.gain.setValueAtTime(0, t0); ignite.gain.linearRampToValueAtTime(0.25 * p.force, t0 + 0.08); ignite.gain.setTargetAtTime(0, t0 + 0.15, 0.1);
      } else {
        ignite.f.frequency.setValueAtTime(400, t0); ignite.f.frequency.exponentialRampToValueAtTime(3500, t0 + 0.35);
        ignite.gain.setValueAtTime(0, t0); ignite.gain.linearRampToValueAtTime(0.35 * p.force, t0 + 0.05); ignite.gain.setTargetAtTime(0, t0 + 0.2, 0.15);
      }
      ignite.pan.setValueAtTime(sp.pan, t0);
      return sp;
    }

    function tick(sp, t, I, accent = 1) {
      const v = ticks[vi++ % N];
      const center = (9000 - 6000 * p.depth) * (0.6 + 0.8 * rng());
      const r = rng();
      const amp = p.force * (0.12 + 0.88 * r * r) * (0.5 + 0.5 * I) * 0.6 * accent;
      const decay = 0.004 + 0.025 * rng() + (r > 0.92 ? 0.05 : 0);
      v.f.frequency.setValueAtTime(center, t);
      v.pan.setValueAtTime(sp.pan + (rng() - 0.5) * 0.35, t);
      v.gain.setValueAtTime(amp, t);
      v.gain.setTargetAtTime(0, t + 0.003, decay);
      if (rng() < 0.025 * p.force * (0.5 + 0.5 * I)) pop(sp, t, 0.5 * p.force);
      onSpark && onSpark({ at: t, sp, amp, big: r > 0.92 });
    }
    function pop(sp, t, amp) {
      pops.f.frequency.setValueAtTime(800 + 1400 * rng(), t);
      pops.pan.setValueAtTime(sp.pan, t);
      pops.gain.setValueAtTime(amp, t);
      pops.gain.setTargetAtTime(0, t + 0.005, 0.03 + 0.07 * rng());
    }
    // 原味里偶尔飞出去的一颗：短促、低 Q、频率往下滑，很轻
    function flyer(sp, t, I) {
      const v = flyers[fi++ % 4];
      const f0 = 5000 + 3000 * rng() - 1500 * p.depth;
      const dur = 0.012 + 0.03 * rng();
      v.f.frequency.setValueAtTime(f0, t); v.f.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + dur);
      v.pan.setValueAtTime(sp.pan + (rng() - 0.5) * 0.5, t);
      const amp = 0.08 * p.force * (0.3 + 0.7 * rng()) * (0.4 + 0.6 * I);
      v.gain.setValueAtTime(amp, t); v.gain.setTargetAtTime(0, t + dur * 0.4, dur * 0.3);
      onSpark && onSpark({ at: t, sp, amp: amp * 4, big: rng() > 0.7 });
    }

    // 电子：强度随时间变化的泊松过程，"律动"把强度切成一段段随机倍率
    function scheduleElectro(sp, to) {
      const end = sp.t0 + sp.dur;
      while (sp.next < to && sp.next < end) {
        const t = sp.next, I = intensity(sp, t), u = (t - sp.t0) / sp.dur;
        const burst = Math.min(1, p.burstiness + (u > 0.8 ? (1 - I) * 0.7 : 0));
        if (t >= sp.segEnd) {
          sp.segEnd = t + 0.04 + rng() * (0.12 + 0.35 * burst);
          sp.mul = rng() < burst ? [0.03, 0.25, 1.8, 3.2][Math.floor(rng() * 4)] : 1;
          sp.segEnd += (sp.mul < 0.1 ? 0.15 * burst * rng() : 0);
        }
        const lambda = Math.max(0.8, (12 + 340 * p.density) * I * sp.mul);
        if (I > 0.005 && rng() < Math.min(1, I * 1.5)) tick(sp, t, I);
        sp.next = t + (-Math.log(1 - rng()) / lambda);
      }
    }

    // 原味：连续的燃烧噪声，深度跟着亮度走；快熄灭时用门控做断续；偶尔飞出一颗；很少的"啪"
    function scheduleRaw(sp, to) {
      const end = sp.t0 + sp.dur, c = sp.chain;
      for (let t = Math.max(sp.next, sp.t0); t < to && t < end + 0.5; t += 0.1) {
        c.depth.setTargetAtTime(2.6 * p.force * Math.min(1, intensity(sp, t) * 1.1), t, 0.06);
      }
      sp.next = Math.max(sp.next, to);
      while (sp.nextGate < to && sp.nextGate < end) {
        const t = sp.nextGate, u = (t - sp.t0) / sp.dur;
        if (u < 0.78) { c.gate.setTargetAtTime(1, t, 0.02); sp.nextGate = t + 0.5; continue; }
        const dying = (u - 0.78) / 0.22;                                  // 0 到 1
        const on = 0.03 + (0.25 - 0.2 * dying) * rng(), off = 0.02 + (0.05 + 0.5 * dying) * rng() * (rng() < 0.5 + 0.5 * dying ? 1 : 0.2);
        c.gate.setTargetAtTime(1, t, 0.004); c.gate.setTargetAtTime(0, t + on, 0.006);
        sp.nextGate = t + on + off;
        if (rng() < 0.4 * dying) flyer(sp, t + on * 0.5, 0.5);
      }
      while (sp.nextFlyer < to && sp.nextFlyer < end) {
        const I = intensity(sp, sp.nextFlyer);
        if (I > 0.05) flyer(sp, sp.nextFlyer, I);
        sp.nextFlyer += (-Math.log(1 - rng())) / Math.max(0.5, 2 + 14 * p.density * I);
      }
      while (sp.nextPop < to && sp.nextPop < end) {
        if (intensity(sp, sp.nextPop) > 0.3) pop(sp, sp.nextPop, 0.18 * p.force);
        sp.nextPop += 2 + rng() * 6;
      }
      if (!sp.stopped && to > end + 0.6) { c.stop(end + 0.6); sp.stopped = true; }
    }

    // 鼓机：火花落在节拍网格上；每一步按密度决定要不要打；律动 = 摇摆 + 随机滚奏；重音在拍首
    function scheduleDrum(sp, to) {
      const end = sp.t0 + sp.dur;
      const beat = 60 / p.bpm, step = beat / (p.subdiv / 4);
      let k = Math.max(sp.lastStep + 1, Math.floor((Math.max(sp.next, sp.t0) - sp.t0) / step));
      for (; ; k++) {
        const swing = (k % 2 === 1) ? p.burstiness * 0.33 * step : 0;
        const t = sp.t0 + k * step + swing + (rng() - 0.5) * 0.004;
        if (t >= to || t >= end) break;
        sp.lastStep = k;
        const I = intensity(sp, t); if (I <= 0.005) continue;
        const onBeat = k % (p.subdiv / 4) === 0, onBar = k % p.subdiv === 0;
        const prob = onBar ? 1 : onBeat ? 0.6 + 0.4 * p.density : 0.15 + 0.85 * p.density;
        if (rng() < prob) tick(sp, t, I, onBar ? 2.0 : onBeat ? 1.6 : 1.1);
        if (rng() < 0.12 * p.burstiness) { const n = 2 + Math.floor(rng() * 5); for (let j = 1; j <= n; j++) tick(sp, t + step * j / (n + 1), I, 0.9 + 0.6 * j / n); }
      }
      sp.next = to;
    }

    function schedule(from, to) {
      from = Math.max(0, from);
      for (const sp of S.sparklers) (p.mode === 'raw' ? scheduleRaw : p.mode === 'drum' ? scheduleDrum : scheduleElectro)(sp, to);
      if (p.mode !== 'raw') {
        for (let t = from; t < to; t += 0.25) {
          let sum = 0; for (const sp of S.sparklers) sum += intensity(sp, t);
          hiss.gain.setTargetAtTime(0.03 * p.force * Math.min(2, sum), t, 0.15);
        }
      }
      S.sparklers = S.sparklers.filter(sp => to < sp.t0 + sp.dur + 1);
    }
    const scheduleSparkler = (sp, to) => (p.mode === 'raw' ? scheduleRaw : p.mode === 'drum' ? scheduleDrum : scheduleElectro)(sp, to);

    return { ctx, master, analyser, light, schedule, scheduleSparkler, state: S, rng };
  }

  function encodeWav(buffer) {
    const ch = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
    const out = new ArrayBuffer(44 + len * ch * 2), v = new DataView(out);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true);
    v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
    return new Blob([out], { type: 'audio/wav' });
  }

  async function renderOffline(p, count, sampleRate = 48000) {
    const seconds = p.burn * 1.1 + 3 + (count - 1) * 2;
    const off = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
    const scene = buildScene(off, p, null);
    for (let i = 0; i < count; i++) scene.light(0.3 + i * 2, count === 1 ? 0 : (i / (count - 1)) * 1.4 - 0.7);
    scene.schedule(0, seconds);
    return off.startRendering();
  }

  global.Sparkler = Object.assign(global.Sparkler || {}, { buildScene, renderOffline, encodeWav, intensity, crackleBuffer });
})(window);
