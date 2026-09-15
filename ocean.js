// Wavemaker 海浪引擎。零采样，纯 Web Audio。被 index.html 和 analyze.html 共用。
(function (global) {
  const PRESETS = {
    dawn:      { swell: .3, period: 12, breakForce: .35, wash: .5, distance: .3, wind: .1, gulls: .15, material: 'sand' },
    afternoon: { swell: .6, period: 9,  breakForce: .6,  wash: .65, distance: .2, wind: .25, gulls: .4, material: 'sand' },
    brighton:  { swell: .55, period: 8, breakForce: .7,  wash: .7, distance: .15, wind: .35, gulls: .3, material: 'pebble' },
    storm:     { swell: .95, period: 6, breakForce: .95, wash: .5, distance: .1, wind: .8, gulls: .05, material: 'rock' },
    far:       { swell: .7, period: 11, breakForce: .5,  wash: .3, distance: .85, wind: .3, gulls: .2, material: 'sand' },
  };

  // 材质决定每一层的滤波器落点。这是"这片海是哪片海"的主要来源。
  // 频率都比第一版低了很多：真实海浪的能量集中在 100 到 1000 Hz，高频只是点缀。
  const MATERIAL = {
    sand:   { swellLP: 550, roarLP: 1100, washHP: 450, washLP: 3800, foam: 1.0, rattle: 0,   thump: 0.08 },
    pebble: { swellLP: 500, roarLP: 1400, washHP: 650, washLP: 5000, foam: 0.6, rattle: 0.5, thump: 0.25 },
    rock:   { swellLP: 450, roarLP: 900,  washHP: 400, washLP: 3000, foam: 0.8, rattle: 0,   thump: 0.8 },
  };

  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return (h >>> 0) || 1;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 三种颜色的噪声。白噪声每倍频程能量相同，听起来就是"滋滋"；粉红噪声每倍频程降 3 dB，
  // 是自然界大多数声音的底色；棕色噪声降 6 dB，是远处的轰鸣。
  function noiseBuffer(ctx, rng, color, seconds = 5) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (color === 'white') {
      for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    } else if (color === 'brown') {
      let b = 0;
      for (let i = 0; i < len; i++) { b = (b + 0.02 * (rng() * 2 - 1)) / 1.02; d[i] = b * 3.5; }
    } else {   // pink，Paul Kellet 的近似
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    }
    return buf;
  }

  // 一层 = 独立噪声源 -> 若干滤波器 -> 增益 -> 声像
  function layer(ctx, rng, dest, color, filters, pan = 0) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, rng, color); src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const panner = ctx.createStereoPanner(); panner.pan.value = pan;
    let node = src;
    const fs = filters.map(f => {
      const b = ctx.createBiquadFilter(); b.type = f.type; b.frequency.value = f.freq; b.Q.value = f.Q ?? 0.7;
      if (f.gain !== undefined) b.gain.value = f.gain;
      node.connect(b); node = b; return b;
    });
    node.connect(gain).connect(panner).connect(dest);
    src.start(0);
    return { src, gain: gain.gain, panner, filters: fs };
  }

  function distanceCutoff(d) { return 12000 * Math.pow(0.1, d); }

  function buildScene(ctx, p, onEvent) {
    const rng = mulberry32(hashSeed(p.seed));
    const master = ctx.createGain(); master.gain.value = 1.0;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5; tone.frequency.value = distanceCutoff(p.distance);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 2.5; comp.attack.value = 0.02; comp.release.value = 0.5;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    master.connect(tone).connect(comp).connect(analyser).connect(ctx.destination);

    const L = {
      bedL:   layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 260 }, { type: 'highpass', freq: 100 }], -0.75),
      bedR:   layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 260 }, { type: 'highpass', freq: 100 }],  0.75),
      swell:  layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 550, Q: 0.8 }, { type: 'highpass', freq: 160 }]),
      roar:   layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 1100, Q: 0.9 }, { type: 'highpass', freq: 140 }]),   // 拍岸的主体
      crash:  layer(ctx, rng, master, 'white', [{ type: 'bandpass', freq: 2200, Q: 0.8 }]),                                      // 拍岸顶上一点点飞溅
      thump:  layer(ctx, rng, master, 'brown', [{ type: 'lowpass', freq: 90 }]),
      wash:   layer(ctx, rng, master, 'pink',  [{ type: 'highpass', freq: 450 }, { type: 'lowpass', freq: 3800 }]),
      foam:   layer(ctx, rng, master, 'white', [{ type: 'highpass', freq: 3500 }, { type: 'lowpass', freq: 10000 }]),
      rattle: layer(ctx, rng, master, 'white', [{ type: 'bandpass', freq: 2800, Q: 2.5 }]),
      wind:   layer(ctx, rng, master, 'pink',  [{ type: 'bandpass', freq: 350, Q: 1.5 }]),
    };

    const S = { nextWave: 0.5, waveIndex: 0, dir: 1, nextGull: 2 + rng() * 6, nextBed: 0, nextWind: 0, until: 0 };

    function wave(t, strength, dir) {
      const m = MATERIAL[p.material];
      const s = Math.min(1, Math.max(0.05, strength));
      const near = 1 - 0.7 * p.distance;
      const rise = p.period * 0.32 * (0.8 + 0.4 * rng());
      const tB = t + rise;

      // 涌：低频慢慢涨起来，滤波器随之打开
      L.swell.gain.setTargetAtTime(0.15 + 0.6 * s, t, rise / 2.5);
      L.swell.gain.setTargetAtTime(0.06, tB + 0.2, 0.9);
      L.swell.filters[0].frequency.setTargetAtTime(m.swellLP * (0.6 + 0.8 * s), t, rise / 2);
      L.swell.filters[0].frequency.setTargetAtTime(m.swellLP * 0.6, tB + 0.5, 1.5);

      // 拍岸：中低频的一声"轰"，上面只有一点点飞溅的高频
      const bf = p.breakForce * (0.5 + 0.6 * s) * near;
      L.roar.filters[0].frequency.setValueAtTime(m.roarLP * (0.85 + 0.3 * rng()), tB);
      L.roar.gain.setTargetAtTime(bf * 1.6, tB, 0.08 + 0.25 * (1 - bf));
      L.roar.gain.setTargetAtTime(0, tB + 0.4 + 0.5 * bf, 0.6 + 1.0 * s);
      L.roar.panner.pan.setValueAtTime(dir * 0.4, tB);
      L.crash.gain.setTargetAtTime(bf * 0.08, tB + 0.05, 0.05);
      L.crash.gain.setTargetAtTime(0, tB + 0.3, 0.4);
      L.crash.panner.pan.setValueAtTime(dir * 0.5, tB);
      if (m.thump) {
        L.thump.gain.setTargetAtTime(m.thump * bf * 1.2, tB, 0.05);
        L.thump.gain.setTargetAtTime(0, tB + 0.2, 0.4);
      }

      // 冲滩：中频的嘶声沿着海岸线跑；水变薄时稍微变亮，回退时变暗。比第一版低得多、轻得多
      const w = p.wash * (0.45 + 0.7 * s) * near;
      const tW = tB + 0.25;
      const runup = 1.2 + 2.2 * w;
      L.wash.filters[1].frequency.setValueAtTime(m.washLP, tW);
      L.wash.gain.setTargetAtTime(0.45 * w, tW, 0.4);
      L.wash.gain.setTargetAtTime(0, tW + runup, 0.9 + 1.6 * w);
      L.wash.filters[0].frequency.setValueAtTime(m.washHP * 0.7, tW);
      L.wash.filters[0].frequency.linearRampToValueAtTime(m.washHP * 1.3, tW + runup);
      L.wash.filters[0].frequency.setTargetAtTime(m.washHP * 0.6, tW + runup, 1.5);
      L.wash.panner.pan.setValueAtTime(-dir * 0.6, tW);
      L.wash.panner.pan.linearRampToValueAtTime(dir * 0.6, tW + runup + 2);

      // 泡沫：很轻的一层
      L.foam.gain.setTargetAtTime(0.035 * w * m.foam, tW + 0.3, 0.6);
      L.foam.gain.setTargetAtTime(0, tW + runup + 0.5, 2.5);

      // 卵石：回退时一串短促的脉冲
      if (m.rattle) {
        const t0 = tW + runup * 0.5, span = runup + 2;
        const n = Math.floor(30 + 90 * w);
        const times = [];
        for (let i = 0; i < n; i++) times.push(t0 + rng() * span);
        times.sort((a, b) => a - b);
        L.rattle.panner.pan.setValueAtTime(dir * 0.4, t0);
        for (const tt of times) {
          L.rattle.gain.setValueAtTime(m.rattle * w * (0.15 + 0.4 * rng()), tt);
          L.rattle.gain.setTargetAtTime(0, tt + 0.01, 0.012);
        }
      }
      onEvent && onEvent({ kind: 'wave', at: tB, strength: s, dir });
    }

    function gull(t) {
      const near = 1 - 0.6 * p.distance;
      const dist = 0.25 + rng() * 0.75;
      const f0 = 900 + rng() * 500;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      const vib = ctx.createOscillator(); vib.frequency.value = 22 + rng() * 8;
      const vibGain = ctx.createGain(); vibGain.gain.value = f0 * 0.02;
      vib.connect(vibGain).connect(osc.frequency);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.5;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000 * (1 - dist * 0.7);
      const g = ctx.createGain(); g.gain.value = 0;
      const pan = ctx.createStereoPanner(); pan.pan.value = rng() * 1.6 - 0.8;
      osc.connect(bp).connect(lp).connect(g).connect(pan).connect(master);
      const calls = 1 + Math.floor(rng() * 3);
      let tt = t;
      const amp = 0.15 * (1 - dist * 0.75) * near;
      for (let i = 0; i < calls; i++) {
        const dur = 0.35 + rng() * 0.3;
        osc.frequency.setValueAtTime(f0 * 0.85, tt);
        osc.frequency.linearRampToValueAtTime(f0 * 1.15, tt + dur * 0.3);
        osc.frequency.linearRampToValueAtTime(f0 * 0.7, tt + dur);
        bp.frequency.setValueAtTime(f0 * 1.9, tt);
        bp.frequency.linearRampToValueAtTime(f0 * 2.4, tt + dur * 0.3);
        bp.frequency.linearRampToValueAtTime(f0 * 1.5, tt + dur);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(amp, tt + 0.04);
        g.gain.setValueAtTime(amp, tt + dur * 0.6);
        g.gain.linearRampToValueAtTime(0, tt + dur);
        tt += dur + 0.12 + rng() * 0.25;
      }
      osc.start(t); vib.start(t); osc.stop(tt + 0.1); vib.stop(tt + 0.1);
      onEvent && onEvent({ kind: 'gull', at: t, dist });
    }

    // 把 [from, to) 这段时间里该发生的事都排进去。实时模式每 300 ms 往前排 2.5 s，离线模式一次排完。
    function schedule(from, to) {
      while (S.nextWave < to) {
        const group = 0.7 + 0.3 * Math.sin(S.waveIndex * Math.PI * 2 / 7 + 0.4);   // 七浪一组
        const strength = p.swell * (0.55 + 0.9 * rng()) * group;
        S.dir = -S.dir;
        wave(S.nextWave, strength, S.dir);
        S.waveIndex++;
        S.nextWave += p.period * (0.75 + 0.5 * rng());
      }
      while (S.nextGull < to) {
        if (p.gulls > 0.01 && rng() < p.gulls) gull(S.nextGull);
        S.nextGull += 3 + rng() * 10 * (1.2 - p.gulls);
      }
      while (S.nextBed < to) {
        const base = (0.05 + 0.15 * p.swell) * (1 - 0.35 * p.distance);
        L.bedL.gain.setTargetAtTime(base * (0.7 + 0.6 * rng()), S.nextBed, 1.5);
        L.bedR.gain.setTargetAtTime(base * (0.7 + 0.6 * rng()), S.nextBed + 0.7, 1.5);
        S.nextBed += 2.5 + rng() * 2;
      }
      while (S.nextWind < to) {
        const gust = p.wind * (0.4 + rng() * 0.9);
        L.wind.gain.setTargetAtTime(0.3 * gust, S.nextWind, 1.2 + rng() * 2);
        L.wind.filters[0].frequency.setTargetAtTime(250 + 350 * gust + rng() * 150, S.nextWind, 1.5);
        S.nextWind += 1.5 + rng() * 4;
      }
      tone.frequency.setTargetAtTime(distanceCutoff(p.distance), from, 0.3);
    }

    return { ctx, master, analyser, schedule, wave, gull, rng, state: S, layers: L };
  }

  function encodeWav(buffer) {
    const ch = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
    const out = new ArrayBuffer(44 + len * ch * 2);
    const v = new DataView(out);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2;
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  async function renderOffline(p, seconds, sampleRate = 48000) {
    const off = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
    const scene = buildScene(off, p, null);
    scene.schedule(0, seconds);
    return off.startRendering();
  }

  global.Wavemaker = Object.assign(global.Wavemaker || {}, { PRESETS, MATERIAL, buildScene, renderOffline, encodeWav, noiseBuffer, hashSeed, mulberry32 });
})(window);
