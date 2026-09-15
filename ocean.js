// Wavemaker 海浪引擎。零采样，纯 Web Audio。被 index.html 和 analyze.html 共用。
(function (global) {
  const PRESETS = {
    dawn:      { swell: .3, period: 12, breakForce: .35, wash: .5, distance: .3, wind: .1, gulls: .15, material: 'sand',   space: .25, ambience: .3 },
    afternoon: { swell: .6, period: 9,  breakForce: .6,  wash: .65, distance: .2, wind: .25, gulls: .4, material: 'sand',   space: .25, ambience: .35 },
    brighton:  { swell: .55, period: 8, breakForce: .7,  wash: .7, distance: .15, wind: .35, gulls: .3, material: 'pebble', space: .35, ambience: .3 },
    storm:     { swell: .95, period: 6, breakForce: .95, wash: .5, distance: .1, wind: .8, gulls: .05, material: 'rock',   space: .55, ambience: .5 },
    far:       { swell: .7, period: 11, breakForce: .5,  wash: .3, distance: .85, wind: .3, gulls: .2, material: 'sand',   space: .4, ambience: .6 },
  };

  // 材质决定每一层的滤波器落点。这是"这片海是哪片海"的主要来源。
  // 频率都比第一版低了很多：真实海浪的能量集中在 100 到 1000 Hz，高频只是点缀。
  const MATERIAL = {
    sand:   { swellLP: 550, roarLP: 1100, washHP: 450, washLP: 3800, foam: 1.0, rattle: 0,   thump: 0.08, echo: 0,    cascade: 0 },
    pebble: { swellLP: 500, roarLP: 1300, washHP: 600, washLP: 4500, foam: 0.5, rattle: 1,   thump: 0.15, echo: 0,    cascade: 0 },
    rock:   { swellLP: 450, roarLP: 900,  washHP: 400, washLP: 3000, foam: 0.8, rattle: 0,   thump: 0.8,  echo: 0.35, cascade: 1 },
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

  // 合成一个开阔海岸的混响脉冲响应：立体声、指数衰减的噪声，高频衰减得更快
  function shoreIR(ctx, rng, seconds = 1.8) {
    const sr = ctx.sampleRate, len = Math.floor(sr * seconds), ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, env = Math.exp(-t * 3.2) * (i < 400 ? i / 400 : 1);
        const a = Math.min(0.98, 0.3 + t * 0.4);                 // 随时间越来越暗
        lp = lp * a + (rng() * 2 - 1) * (1 - a);
        d[i] = lp * env;
      }
    }
    return ir;
  }

  function buildScene(ctx, p, onEvent) {
    const rng = mulberry32(hashSeed(p.seed));
    const master = ctx.createGain(); master.gain.value = 1.0;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 0.5; tone.frequency.value = distanceCutoff(p.distance);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 2.5; comp.attack.value = 0.02; comp.release.value = 0.5;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    master.connect(tone).connect(comp).connect(analyser).connect(ctx.destination);

    // 空间：近处的层送一部分进混响；礁石再加一个崖壁的短回声
    const near = ctx.createGain(); near.connect(master);
    const send = ctx.createGain(); send.gain.value = 0;
    const verb = ctx.createConvolver(); verb.buffer = shoreIR(ctx, rng);
    const wet = ctx.createGain(); wet.gain.value = 0;
    near.connect(send).connect(verb).connect(wet).connect(master);
    const echo = ctx.createDelay(1); echo.delayTime.value = 0.17;
    const echoGain = ctx.createGain(); echoGain.gain.value = 0;
    const echoLP = ctx.createBiquadFilter(); echoLP.type = 'lowpass'; echoLP.frequency.value = 1800;
    near.connect(echo).connect(echoLP).connect(echoGain).connect(verb);
    function updateSpace(t) {
      const sp = p.space ?? 0.3, m = MATERIAL[p.material];
      send.gain.setTargetAtTime(0.9, t, 0.1);
      wet.gain.setTargetAtTime(0.55 * sp, t, 0.3);
      echoGain.gain.setTargetAtTime(m.echo * sp, t, 0.3);
    }

    const L = {
      bedL:   layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 200 }, { type: 'highpass', freq: 100 }], -0.75),
      bedR:   layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 200 }, { type: 'highpass', freq: 100 }],  0.75),
      swell:  layer(ctx, rng, master, 'pink',  [{ type: 'lowpass', freq: 550, Q: 0.8 }, { type: 'highpass', freq: 160 }]),
      roar:   layer(ctx, rng, near, 'pink',  [{ type: 'lowpass', freq: 1100, Q: 0.9 }, { type: 'highpass', freq: 140 }]),   // 拍岸的主体
      crash:  layer(ctx, rng, near, 'white', [{ type: 'bandpass', freq: 2200, Q: 0.8 }]),                                    // 拍岸顶上的飞溅，礁石上还有落回去的水
      thump:  layer(ctx, rng, near, 'brown', [{ type: 'lowpass', freq: 90 }]),
      wash:   layer(ctx, rng, near, 'pink',  [{ type: 'highpass', freq: 450 }, { type: 'lowpass', freq: 3800 }]),
      foam:   layer(ctx, rng, near, 'white', [{ type: 'highpass', freq: 3500 }, { type: 'lowpass', freq: 10000 }]),
      rattle: layer(ctx, rng, near, 'white', [{ type: 'bandpass', freq: 2500, Q: 7 }]),                                      // 卵石：高 Q，像小石头相碰的"嗒"
      drain:  layer(ctx, rng, near, 'pink',  [{ type: 'highpass', freq: 2200 }, { type: 'lowpass', freq: 9000 }]),           // 卵石：水从石缝里退下去的细嘶
      wind:   layer(ctx, rng, master, 'pink',  [{ type: 'bandpass', freq: 350, Q: 1.5 }]),
      leaves: layer(ctx, rng, master, 'white', [{ type: 'bandpass', freq: 3200, Q: 0.9 }]),                                  // 环境：风过草木
    };

    const S = { nextWave: 0.5, waveIndex: 0, dir: 1, nextGull: 2 + rng() * 6, nextBed: 0, nextWind: 0, until: 0 };

    function wave(t, strength, dir) {
      const m = MATERIAL[p.material];
      const s = Math.min(1, Math.max(0.05, strength));
      const nearF = 1 - 0.7 * p.distance;
      const rise = p.period * 0.42 * (0.8 + 0.4 * rng());        // 比第一版长：从远处慢慢过来
      const tB = t + rise;

      // 涌：一开始又远又糊，越来越近、越来越亮。增益和低通一起打开
      L.swell.gain.setTargetAtTime(0.06 + 0.15 * s, t, rise * 0.5);
      L.swell.gain.setTargetAtTime(0.25 + 0.75 * s, t + rise * 0.45, rise * 0.22);
      L.swell.gain.setTargetAtTime(0.05, tB + 0.7, 1.4);           // 拖过拍岸，不留断档
      L.swell.filters[0].frequency.setValueAtTime(220, t);
      L.swell.filters[0].frequency.exponentialRampToValueAtTime(m.swellLP * (1.6 + 1.6 * s) * (m.cascade ? 2.2 : 1), tB);
      L.swell.filters[0].frequency.setTargetAtTime(300, tB + 0.8, 1.2);

      // 拍岸：中低频的"轰"，从拍岸前一点开始起，音色在最初半秒里打开
      const bf = p.breakForce * (0.5 + 0.6 * s) * nearF;
      L.roar.filters[0].frequency.setValueAtTime(m.roarLP * 0.5, tB - 0.15);
      L.roar.filters[0].frequency.exponentialRampToValueAtTime(m.roarLP * (1.2 + 0.8 * s), tB + 0.45);
      L.roar.filters[0].frequency.setTargetAtTime(m.roarLP * 0.7, tB + 1.2, 1.0);
      L.roar.gain.setTargetAtTime(bf * 1.15, tB - 0.15, 0.14 + 0.2 * (1 - bf));
      L.roar.gain.setTargetAtTime(0, tB + 0.5 + 0.5 * bf, 0.7 + 1.0 * s);
      L.roar.panner.pan.setValueAtTime(dir * 0.4, tB);
      L.crash.gain.setTargetAtTime(bf * 0.1, tB, 0.06);
      L.crash.gain.setTargetAtTime(0, tB + 0.35, 0.4);
      L.crash.panner.pan.setValueAtTime(dir * 0.5, tB);
      if (m.thump) {
        L.thump.gain.setTargetAtTime(m.thump * bf * 0.9, tB - 0.05, 0.06);
        L.thump.gain.setTargetAtTime(0, tB + 0.25, m.cascade ? 0.9 : 0.4);
      }
      // 礁石：拍上去的水又落回来，一串越来越稀的飞溅
      if (m.cascade) {
        const n = 18 + Math.floor(14 * s);
        for (let i = 0; i < n; i++) {
          const tt = tB + 0.3 + Math.pow(rng(), 0.7) * (1.6 + 1.2 * s);
          L.crash.gain.setValueAtTime(bf * 0.07 * (0.3 + 0.7 * rng()) * (1 - (tt - tB) / 3.5), tt);
          L.crash.gain.setTargetAtTime(0, tt + 0.015, 0.03 + 0.05 * rng());
        }
      }

      // 冲滩：紧接着拍岸，慢慢涌上来，越推越亮，最响的时候最清澈；回退时变暗
      const w = p.wash * (0.45 + 0.7 * s) * nearF;
      const tW = tB + 0.1;
      const runup = 1.3 + 2.4 * w;
      L.wash.gain.setTargetAtTime(0.65 * w, tW, 0.55);
      L.wash.gain.setTargetAtTime(0, tW + runup, 0.7 + 1.1 * w);
      L.wash.filters[0].frequency.setValueAtTime(m.washHP * 0.6, tW);
      L.wash.filters[0].frequency.linearRampToValueAtTime(m.washHP * 1.5, tW + runup);
      L.wash.filters[0].frequency.setTargetAtTime(m.washHP * 0.5, tW + runup, 1.5);
      L.wash.filters[1].frequency.setValueAtTime(m.washLP * 0.45, tW);
      L.wash.filters[1].frequency.exponentialRampToValueAtTime(m.washLP * 2.2, tW + runup * 0.8);
      L.wash.filters[1].frequency.setTargetAtTime(m.washLP * 0.4, tW + runup + 0.3, 1.0);
      L.wash.panner.pan.setValueAtTime(-dir * 0.6, tW);
      L.wash.panner.pan.linearRampToValueAtTime(dir * 0.6, tW + runup + 2);

      // 泡沫：冲到最远处之后留在沙上的细碎声，明亮但轻
      L.foam.gain.setTargetAtTime(0.045 * w * m.foam, tW + runup * 0.5, 0.7);
      L.foam.gain.setTargetAtTime(0, tW + runup + 0.3, 1.6);

      // 卵石：不是踩上去，是水轻轻拍上去、再从石缝里退下去。
      // 一层细嘶（水退）+ 一串很轻、高 Q 的"嗒"（小石头相碰），密度在回退中段最高，都送进混响
      if (m.rattle) {
        const tR = tW + runup * 0.7, span = runup * 0.8 + 1.5;
        L.drain.gain.setTargetAtTime(0.09 * w, tR, 0.5);
        L.drain.gain.setTargetAtTime(0, tR + span * 0.6, 1.2);
        L.drain.panner.pan.setValueAtTime(dir * 0.3, tR);
        const n = Math.floor(40 + 120 * w);
        const times = [];
        for (let i = 0; i < n; i++) { const u = rng(); times.push(tR + span * (0.5 - 0.5 * Math.cos(u * Math.PI)) * 0.9 + rng() * 0.1 * span); }
        times.sort((a, b) => a - b);
        for (const tt of times) {
          const k = 1 - Math.abs((tt - tR) / span - 0.45) * 1.6;           // 中段最密最响
          L.rattle.filters[0].frequency.setValueAtTime(1200 + 2600 * rng(), tt);
          L.rattle.panner.pan.setValueAtTime(dir * 0.3 + (rng() - 0.5) * 0.8, tt);
          L.rattle.gain.setValueAtTime(0.05 * w * Math.max(0.15, k) * (0.4 + 0.6 * rng()), tt);
          L.rattle.gain.setTargetAtTime(0, tt + 0.004, 0.006 + 0.012 * rng());
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
        const base = (0.05 + 0.15 * p.swell) * (1 - 0.35 * p.distance) * (0.6 + 0.8 * (p.ambience ?? 0.3));
        L.bedL.gain.setTargetAtTime(base * (0.7 + 0.6 * rng()), S.nextBed, 1.5);
        L.bedR.gain.setTargetAtTime(base * (0.7 + 0.6 * rng()), S.nextBed + 0.7, 1.5);
        S.nextBed += 2.5 + rng() * 2;
      }
      while (S.nextWind < to) {
        const gust = p.wind * (0.4 + rng() * 0.9), amb = p.ambience ?? 0.3;
        L.wind.gain.setTargetAtTime(0.3 * gust, S.nextWind, 1.2 + rng() * 2);
        L.wind.filters[0].frequency.setTargetAtTime(250 + 350 * gust + rng() * 150, S.nextWind, 1.5);
        L.leaves.gain.setTargetAtTime(0.05 * amb * gust * (0.3 + rng()), S.nextWind + 0.4, 1.0 + rng() * 1.5);
        L.leaves.panner.pan.setTargetAtTime(rng() * 1.4 - 0.7, S.nextWind, 2);
        S.nextWind += 1.5 + rng() * 4;
      }
      tone.frequency.setTargetAtTime(distanceCutoff(p.distance), from, 0.3);
      updateSpace(from);
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
