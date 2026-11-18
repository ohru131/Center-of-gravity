/* 変わりゴマ メーカー：画面操作 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const stage = $('stage'), shapeEl = $('shape'), shapeG = $('shapeG'), live = $('live'), closer = $('closer');
  const VIEW = 200;           // おえかきエリアの一辺（描画単位）
  const MIN_EDGE_MM = 1.5;    // あなのふちから外形までの最低のこりしろ

  const state = {
    raw: null,        // 元の輪郭（点列の配列）
    source: null,     // 'draw' | 'file' | 'preset'
    res: null,        // Geo.analyze の結果
    crossing: false,  // 線が交わっている
    revealed: false,
    guess: null,
    drawing: null,    // かいている途中の点列
    spin: null,       // { raf, pivot }
  };

  /* ---------- 表示まわり ---------- */

  // SVG要素には hidden プロパティがないので属性で切りかえる
  const setHidden = (id, on) => $(id).toggleAttribute('hidden', !!on);
  function setMsg(html, kind) { $('msg').innerHTML = html; $('msg').className = kind || ''; }
  const sizeMm = () => Math.max(1, parseFloat($('sizeNum').value) || 60);
  const mmPerUnit = () => state.res ? sizeMm() / Math.max(state.res.bbox.w, state.res.bbox.h) : 0.5;
  function holeDiameter() {
    const v = $('shaft').value === 'custom' ? parseFloat($('shaftCustom').value) : parseFloat($('shaft').value);
    return v > 0 ? v : 3;
  }
  const pathD = contours => contours.map(c =>
    'M' + c.map(p => p.x.toFixed(2) + ' ' + p.y.toFixed(2)).join('L') + 'Z').join('');

  function render() {
    const r = state.res, k = mmPerUnit();
    // 方眼：1マス = 10mm
    const g = 10 / k;
    $('grid').setAttribute('width', g); $('grid').setAttribute('height', g);
    $('gridPath').setAttribute('d', `M${g} 0H0V${g}`);

    shapeEl.setAttribute('d', r ? pathD(r.contours.map(c => c.pts)) : '');
    const ok = !!r && !state.crossing;
    const mode = $('markMode').value;

    setHidden('answer', !(ok && state.revealed));
    if (ok) {
      const c = r.centroid, hr = holeDiameter() / 2 / k, s = Math.max(hr + 2, 4);
      $('hole').setAttribute('cx', c.x); $('hole').setAttribute('cy', c.y);
      $('hole').setAttribute('r', hr);
      $('hole').style.display = mode === 'hole' ? '' : 'none';
      $('cross').setAttribute('d', `M${c.x - s} ${c.y}H${c.x + s}M${c.x} ${c.y - s}V${c.y + s}`);
    }
    setHidden('guess', !state.guess);
    if (state.guess) {
      $('guessDot').setAttribute('cx', state.guess.x); $('guessDot').setAttribute('cy', state.guess.y);
      $('guessLabel').setAttribute('x', state.guess.x + 3.5); $('guessLabel').setAttribute('y', state.guess.y - 3);
    }

    setHidden('shaftField', mode !== 'hole');
    setHidden('shaftCustomWrap', $('shaft').value !== 'custom');
    $('dims').textContent = r ? `よこ ${(r.bbox.w * k).toFixed(1)} mm × たて ${(r.bbox.h * k).toFixed(1)} mm` : '';

    // こたえ・注意
    let result = '', warn = '', canDownload = ok && state.revealed;
    if (ok && state.revealed) {
      const c = r.centroid;
      result = `重心は 左から ${((c.x - r.bbox.minX) * k).toFixed(1)} mm、上から ${((c.y - r.bbox.minY) * k).toFixed(1)} mm のところ！`;
      if (state.guess) {
        const d = Math.hypot(state.guess.x - c.x, state.guess.y - c.y) * k;
        result += `<br>よそうとのずれ：${d.toFixed(1)} mm ` + (d < 2 ? '🎯 ぴったり！' : d < 6 ? '👏 おしい！' : '🤔 けっこうはなれていたね');
      }
      if (!r.inside) {
        warn = '重心が形の外（材料のないところ）にあるよ。このままではじくをさせない。形をかえてみよう！';
        canDownload = false;
      } else if (mode === 'hole' && r.edgeDist * k < holeDiameter() / 2 + MIN_EDGE_MM) {
        warn = 'あながふちに近すぎて、われやすいよ。形を大きくするか、じくを細くしよう。';
      }
    }
    $('result').innerHTML = result;
    $('warn').textContent = warn;

    $('btnReveal').disabled = !ok || state.revealed;
    $('btnDownload').disabled = !canDownload;
    $('btnSpinC').disabled = !(ok && state.revealed);
    $('btnSpinG').disabled = !(ok && state.revealed && state.guess);
    $('btnStop').disabled = !state.spin;
  }

  /* ---------- 形の登録 ---------- */

  function rebuild() {
    stopSpin();
    let cs = state.raw || [];
    if (state.source === 'draw') {
      cs = cs.map(c => Geo.simplifyClosed(c, 0.6));
      if ($('smooth').checked) cs = cs.map(c => Geo.smoothClosed(c, 2));
    }
    state.res = Geo.analyze(cs);
    state.crossing = !!state.res && state.res.contours.some(c => Geo.selfIntersects(c.pts));
    if (!state.res) setMsg('ここに ひとふでがきで 形をかいてね ✏️');
    else if (state.crossing) setMsg('線がとちゅうで交わっている形だよ。正しく計算できないので、べつの形にしよう。', 'bad');
    else if (!state.revealed) setMsg('形ができた！ 重心はどこかな？ 形の上をタップしてよそうしよう。');
    render();
  }

  function setShape(contours, source, note) {
    state.raw = contours; state.source = source;
    state.revealed = false; state.guess = null;
    rebuild();
    if (note && state.res && !state.crossing) setMsg(note);
  }

  function clearAll() {
    state.raw = null; state.source = null; state.revealed = false; state.guess = null;
    live.setAttribute('points', '');
    rebuild();
  }

  // 読みこんだ図形を おえかきエリアに おさめる
  function fitToView(contours) {
    const b = Geo.bbox(contours), s = (VIEW * 0.8) / Math.max(b.w, b.h);
    const ox = (VIEW - b.w * s) / 2 - b.minX * s, oy = (VIEW - b.h * s) / 2 - b.minY * s;
    return contours.map(c => c.map(p => ({ x: p.x * s + ox, y: p.y * s + oy })));
  }

  function setSize(mm) {
    mm = Math.round(Math.min(500, Math.max(10, mm)));
    $('sizeNum').value = mm; $('size').value = Math.min(200, Math.max(20, mm));
  }

  /* ---------- おえかき ---------- */

  function toView(e) {
    const m = stage.getScreenCTM();
    return { x: (e.clientX - m.e) / m.a, y: (e.clientY - m.f) / m.d };
  }

  stage.addEventListener('pointerdown', e => {
    if (e.button > 0 || state.spin) return;
    const p = toView(e);
    if (state.res) {           // 形があるとき：タップ = よそう
      if (!state.crossing && !state.revealed) {
        state.guess = p;
        setMsg('よそうできたね！ 「こたえを見る」をおしてみよう。（タップしなおしてもOK）');
        render();
      }
      return;
    }
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    state.drawing = [p];
  });

  stage.addEventListener('pointermove', e => {
    const d = state.drawing;
    if (!d) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const p = toView(ev), q = d[d.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) >= 0.8) d.push(p);
    }
    live.setAttribute('points', d.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '));
    const a = d[0], b = d[d.length - 1];
    closer.setAttribute('x1', b.x); closer.setAttribute('y1', b.y);
    closer.setAttribute('x2', a.x); closer.setAttribute('y2', a.y);
    closer.style.display = '';
  });

  function endDraw() {
    const d = state.drawing;
    if (!d) return;
    state.drawing = null;
    live.setAttribute('points', ''); closer.style.display = 'none';
    const b = Geo.bbox([d]);
    if (Geo.selfIntersects(Geo.simplifyClosed(d, 0.6))) {
      setMsg('線がとちゅうで交わっているよ。交わらないように、もういちどかいてみよう。', 'bad');
      return;
    }
    if (d.length < 8 || Math.max(b.w, b.h) < 20 || Math.abs(Geo.signedArea(d)) < 60) {
      setMsg('小さすぎるみたい。もっと大きく、ぐるっとかいてね。', 'bad');
      return;
    }
    setShape([d], 'draw');
  }
  stage.addEventListener('pointerup', endDraw);
  stage.addEventListener('pointercancel', endDraw);
  closer.style.display = 'none';

  /* ---------- みほん ---------- */

  const presets = {
    star() {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 32 : 78, a = -Math.PI / 2 + i * Math.PI / 5;
        pts.push({ x: 100 + r * Math.cos(a), y: 104 + r * Math.sin(a) });
      }
      return pts;
    },
    heart() {
      const pts = [];
      for (let i = 0; i < 120; i++) {
        const t = i / 120 * 2 * Math.PI;
        pts.push({
          x: 100 + 4.6 * 16 * Math.pow(Math.sin(t), 3),
          y: 92 - 4.6 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
        });
      }
      return pts;
    },
    boomerang() {
      return [{ x: 20, y: 150 }, { x: 100, y: 30 }, { x: 180, y: 150 }, { x: 160, y: 162 }, { x: 100, y: 72 }, { x: 40, y: 162 }];
    },
  };
  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    setSize(60);
    setShape([presets[b.dataset.preset]()], 'preset');
  }));

  /* ---------- ファイル読みこみ ---------- */

  const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
  function lengthMm(s) {
    const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(s || '');
    return m && m[2].toLowerCase() in UNIT_MM ? parseFloat(m[1]) * UNIT_MM[m[2].toLowerCase()] : null;
  }

  const NUM = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
  const FIRST_PAIR = new RegExp('^[\\s,]*(' + NUM + ')[\\s,]*(' + NUM + ')');

  // path の d を サブパスごとに分け、それぞれ絶対座標の M で始まる形にする
  function splitSubpaths(d, probe) {
    const parts = d.match(/[Mm][^Mm]*/g) || [];
    if (parts.length <= 1) return parts;
    const out = [];
    let end = { x: 0, y: 0 };
    parts.forEach((part, i) => {
      const rel = part[0] === 'm', m = FIRST_PAIR.exec(part.slice(1));
      if (!m) return;
      const x = parseFloat(m[1]) + (rel && i ? end.x : 0), y = parseFloat(m[2]) + (rel && i ? end.y : 0);
      const tail = part.slice(1 + m[0].length);
      const implicit = /^[\s,]*[-+.\d]/.test(tail);
      const abs = `M${x} ${y}` + (implicit ? (rel ? 'l' : 'L') : '') + tail;
      probe.setAttribute('d', abs);
      const L = probe.getTotalLength();
      end = L > 0 ? probe.getPointAtLength(L) : { x, y };
      out.push(abs);
    });
    return out;
  }

  function sampleGeometry(el, n) {
    const L = el.getTotalLength(), m = el.getCTM();
    if (!(L > 0) || !m) return null;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = el.getPointAtLength(L * i / n);
      pts.push({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
    }
    return pts;
  }

  function importSVG(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const src = doc.documentElement;
    if (!src || src.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('SVGファイルとして読めなかったよ。');
    }
    // 安全のため、スクリプトなどは取りのぞく
    src.querySelectorAll('script, foreignObject, image, iframe').forEach(n => n.remove());
    [src, ...src.querySelectorAll('*')].forEach(n => {
      for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    });

    const vb = (src.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVb = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0;
    let unitMm = UNIT_MM.px;
    if (hasVb) {
      const w = lengthMm(src.getAttribute('width'));
      if (w > 0) unitMm = w / vb[2];
      // ユーザー単位 = 1px になるようにして、座標をそのまま取り出す
      src.setAttribute('width', vb[2]); src.setAttribute('height', vb[3]);
      src.removeAttribute('preserveAspectRatio');
    }
    const host = $('svgHost');
    host.textContent = '';
    const svg = document.importNode(src, true);
    host.appendChild(svg);
    try {
      const contours = [];
      const skip = 'defs, clipPath, mask, symbol, pattern, marker';
      svg.querySelectorAll('path, polygon, polyline, rect, circle, ellipse').forEach(el => {
        if (el.closest(skip) || typeof el.getTotalLength !== 'function') return;
        if (el.localName === 'path') {
          const probe = el.cloneNode(false);
          el.parentNode.insertBefore(probe, el);
          for (const sub of splitSubpaths(el.getAttribute('d') || '', probe)) {
            probe.setAttribute('d', sub);
            const pts = sampleGeometry(probe, 500);
            if (pts) contours.push(pts);
          }
          probe.remove();
        } else {
          const pts = sampleGeometry(el, 500);
          if (pts) contours.push(pts);
        }
      });
      return { contours, unitMm };
    } finally {
      host.textContent = '';
    }
  }

  async function loadFile(file) {
    try {
      const text = await file.text();
      const isDxf = /\.dxf$/i.test(file.name);
      let contours, unitMm = 1, skipped = 0;
      if (isDxf) ({ contours, skipped } = Geo.parseDXF(text));
      else ({ contours, unitMm } = importSVG(text));
      contours = contours.filter(c => c.length >= 3);
      if (!contours.length || !Geo.analyze(contours)) {
        throw new Error('とじた形が見つからなかったよ。' + (skipped ? '（スプライン・だ円のDXFは未対応。ポリラインに変換してね）' : ''));
      }
      const b0 = Geo.bbox(contours), diag = Math.hypot(b0.w, b0.h);
      contours = contours.map(c => Geo.simplifyClosed(c, diag * 0.0004));
      const res = Geo.analyze(contours);
      setSize(Math.max(res.bbox.w, res.bbox.h) * unitMm);
      let note = `「${file.name}」を読みこんだよ！ 重心はどこかな？ タップしてよそうしよう。`;
      if (res.droppedShapes > 0) note += `<br>（形が ${res.droppedShapes + 1} こあったので、いちばん大きいものを使うね）`;
      if (skipped) note += `<br>（スプライン・だ円 ${skipped} こは未対応のためとばしたよ）`;
      setShape(fitToView(res.contours.map(c => c.pts)), 'file', note);
    } catch (err) {
      clearAll();
      setMsg(err.message || 'ファイルを読みこめなかったよ。', 'bad');
    }
  }

  $('btnFile').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  stage.addEventListener('dragover', e => e.preventDefault());
  stage.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  /* ---------- こたえ・回転 ---------- */

  $('btnReveal').addEventListener('click', () => {
    state.revealed = true;
    const r = state.res;
    if (!r.inside) setMsg('重心は ここ！ …あれ？ 形の外にあるね。へこんだ形だと、こういうことがおきるよ。', 'bad');
    else setMsg('重心は ここ！ ここにじくをさすと、ぶれずにまわるコマになるよ。', 'good');
    render();
  });

  function stopSpin() {
    if (!state.spin) return;
    cancelAnimationFrame(state.spin.raf);
    state.spin = null;
    shapeG.removeAttribute('transform');
    setHidden('pivot', true);
  }

  function startSpin(pivot, isCentroid) {
    stopSpin();
    $('pivot').setAttribute('cx', pivot.x); $('pivot').setAttribute('cy', pivot.y);
    setHidden('pivot', false);
    const spin = state.spin = { raf: 0 };
    let angle = 0, last = performance.now();
    const tick = now => {
      angle = (angle + (now - last) * 0.36) % 360;   // 1秒で1回転
      last = now;
      shapeG.setAttribute('transform', `rotate(${angle.toFixed(2)} ${pivot.x} ${pivot.y})`);
      spin.raf = requestAnimationFrame(tick);
    };
    spin.raf = requestAnimationFrame(tick);
    setMsg(isCentroid
      ? '重心でまわすと、重さのまん中がうごかない。だから ぶれにくい！'
      : 'よそうの点でまわすと、重心（十字のしるし）がぐるぐるうごく。これが「ぶれ」のもと！');
    render();
  }
  $('btnSpinC').addEventListener('click', () => startSpin(state.res.centroid, true));
  $('btnSpinG').addEventListener('click', () => startSpin(state.guess, false));
  $('btnStop').addEventListener('click', () => { stopSpin(); render(); });

  /* ---------- 設定・ダウンロード ---------- */

  $('btnClear').addEventListener('click', clearAll);
  $('smooth').addEventListener('change', rebuild);
  $('size').addEventListener('input', () => { $('sizeNum').value = $('size').value; render(); });
  $('sizeNum').addEventListener('input', () => { $('size').value = $('sizeNum').value; render(); });
  ['markMode', 'shaft', 'shaftCustom'].forEach(id => $(id).addEventListener('input', render));

  $('btnDownload').addEventListener('click', () => {
    const r = state.res;
    const svg = Geo.buildSVG({
      contours: r.contours, centroid: r.centroid, bbox: r.bbox,
      mmPerUnit: mmPerUnit(), mark: $('markMode').value, holeDiameter: holeDiameter(),
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.download = 'koma.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  rebuild();
})();
