/* 変わりゴマ メーカー：画面操作 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const stage = $('stage'), shapeG = $('shapeG'), live = $('live'), closer = $('closer');
  const VIEW = 200;           // おえかきエリアの一辺（描画単位）
  const MIN_EDGE_MM = 1.5;    // あなのふちから外形までの最低のこりしろ
  const TAP_MAX = 4;          // これより小さい動きはタップあつかい
  const NUMS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const numLabel = i => NUMS[i] || `(${i + 1})`;

  const state = {
    raw: [],          // 元の輪郭 { pts, drawn }。drawn = 手がき（簡略化・平滑化の対象）
    res: null,        // Geo.analyze の結果 { shapes, bbox }
    crossing: false,  // 線が交わっている
    revealed: false,
    guesses: [],      // よそうの点（図形ごとに1つ）
    drawing: null,    // かいている途中の点列
    spin: null,       // { raf }
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

  // 点 p がどの図形のものか：中にあればその図形（入れ子なら小さいほう）、なければ いちばん近い図形
  function shapeIndexAt(p) {
    const shapes = state.res ? state.res.shapes : [];
    let best = -1, bestV = Infinity;
    shapes.forEach((s, i) => {
      if (Geo.pointInPolygon(p, s.contours[0].pts) && s.bbox.w * s.bbox.h < bestV) { best = i; bestV = s.bbox.w * s.bbox.h; }
    });
    if (best >= 0) return best;
    shapes.forEach((s, i) => {
      const d = Geo.distToContour(p, s.contours[0].pts);
      if (d < bestV) { best = i; bestV = d; }
    });
    return best;
  }
  const guessFor = i => state.guesses.find(g => shapeIndexAt(g) === i);

  function render() {
    const r = state.res, k = mmPerUnit();
    const shapes = r ? r.shapes : [], many = shapes.length > 1;
    // 方眼：1マス = 10mm
    const g = 10 / k;
    $('grid').setAttribute('width', g); $('grid').setAttribute('height', g);
    $('gridPath').setAttribute('d', `M${g} 0H0V${g}`);

    const ok = !!r && !state.crossing, shown = ok && state.revealed;
    const mode = $('markMode').value, hd = holeDiameter();
    const results = [], warns = [];

    shapeG.innerHTML = shapes.map((s, i) => {
      const c = s.centroid, hr = hd / 2 / k, arm = Math.max(hr + 2, 4), gp = guessFor(i);
      let h = `<g><path class="shape" fill-rule="evenodd" d="${pathD(s.contours.map(u => u.pts))}"/>`;
      if (shown) {
        if (mode === 'hole' && s.inside) h += `<circle class="hole" cx="${c.x}" cy="${c.y}" r="${hr}"/>`;
        h += `<path class="cross" d="M${c.x - arm} ${c.y}H${c.x + arm}M${c.x} ${c.y - arm}V${c.y + arm}"/>`;
        if (many) h += `<text class="numLabel" font-size="7" x="${c.x + arm * 0.5}" y="${c.y - arm * 0.5}">${numLabel(i)}</text>`;
      }
      if (gp) {
        h += `<circle class="guessDot" r="2.2" cx="${gp.x}" cy="${gp.y}"/>` +
          `<text class="guessLabel" font-size="6" x="${gp.x + 3.5}" y="${gp.y + 7}">よそう</text>`;
      }
      if (shown) {
        const tag = many ? numLabel(i) + ' ' : '重心は ';
        let line = `${tag}左から ${((c.x - r.bbox.minX) * k).toFixed(1)} mm、上から ${((c.y - r.bbox.minY) * k).toFixed(1)} mm` + (many ? '' : ' のところ！');
        if (gp) {
          const d = Math.hypot(gp.x - c.x, gp.y - c.y) * k;
          line += (many ? ' ／ ' : '<br>') + `よそうとのずれ：${d.toFixed(1)} mm ` + (d < 2 ? '🎯 ぴったり！' : d < 6 ? '👏 おしい！' : '🤔 はなれていたね');
        }
        results.push(line);
        const who = many ? numLabel(i) + 'は、' : '';
        if (!s.inside) warns.push(who + '重心が形の外（材料のないところ）にあるよ。じくをさせないので、しるしは付かない。形をかえてみよう！');
        else if (mode === 'hole' && s.edgeDist * k < hd / 2 + MIN_EDGE_MM) warns.push(who + 'あながふちに近すぎて、われやすいよ。形を大きくするか、じくを細くしよう。');
      }
      return h + '</g>';
    }).join('');

    setHidden('shaftField', mode !== 'hole');
    setHidden('shaftCustomWrap', $('shaft').value !== 'custom');
    $('dims').textContent = r ? `${many ? 'ぜんたい：' : ''}よこ ${(r.bbox.w * k).toFixed(1)} mm × たて ${(r.bbox.h * k).toFixed(1)} mm` : '';
    $('result').innerHTML = (shown && many ? '重心の場所（ぜんたいの左上から）<br>' : '') + results.join('<br>');
    $('warn').innerHTML = warns.join('<br>');

    $('btnUndo').disabled = !state.raw.length;
    $('btnReveal').disabled = !ok || state.revealed;
    $('btnDownload').disabled = !(shown && shapes.some(s => s.inside));
    $('btnSpinC').disabled = !shown;
    $('btnSpinG').disabled = !(shown && state.guesses.length);
    $('btnStop').disabled = !state.spin;
  }

  /* ---------- 形の登録 ---------- */

  function processDrawn(pts) {
    const s = Geo.simplifyClosed(pts, 0.6);
    return $('smooth').checked ? Geo.smoothClosed(s, 2) : s;
  }

  function hasCrossing(cs) {
    for (let i = 0; i < cs.length; i++) {
      if (Geo.selfIntersects(cs[i])) return true;
      for (let j = i + 1; j < cs.length; j++) if (Geo.contoursIntersect(cs[i], cs[j])) return true;
    }
    return false;
  }

  function rebuild() {
    stopSpin();
    const cs = state.raw.map(r => r.drawn ? processDrawn(r.pts) : r.pts);
    state.res = Geo.analyze(cs);
    state.crossing = !!state.res && hasCrossing(cs);
    if (!state.res) setMsg('ここに ひとふでがきで 形をかいてね ✏️');
    else if (state.crossing) setMsg('線が交わっている形があるよ。正しく計算できないので、べつの形にしよう。', 'bad');
    else if (!state.revealed) {
      const n = state.res.shapes.length;
      setMsg((n > 1 ? `形が ${n} こできた！ それぞれの` : '形ができた！ ') + '重心はどこかな？ 形の上をタップしてよそうしよう。');
    } else setMsg('重心は 十字のしるしのところ！', 'good');
    render();
  }

  function setShapes(contours, note) {
    state.raw = contours.map(pts => ({ pts, drawn: false }));
    state.revealed = false; state.guesses = [];
    rebuild();
    if (note && state.res && !state.crossing) setMsg(note);
  }

  function clearAll() {
    state.raw = []; state.revealed = false; state.guesses = [];
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

  /* ---------- おえかき・よそう ---------- */

  function toView(e) {
    const m = stage.getScreenCTM();
    return { x: (e.clientX - m.e) / m.a, y: (e.clientY - m.f) / m.d };
  }

  stage.addEventListener('pointerdown', e => {
    if (e.button > 0 || state.spin || state.drawing) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    state.drawing = [toView(e)];
  });

  stage.addEventListener('pointermove', e => {
    const d = state.drawing;
    if (!d) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const p = toView(ev), q = d[d.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) >= 0.8) d.push(p);
    }
    const b = Geo.bbox([d]);
    if (Math.max(b.w, b.h) < TAP_MAX) return;
    live.setAttribute('points', d.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '));
    const a = d[0], z = d[d.length - 1];
    closer.setAttribute('x1', z.x); closer.setAttribute('y1', z.y);
    closer.setAttribute('x2', a.x); closer.setAttribute('y2', a.y);
    closer.style.display = '';
  });

  function tap(p) {
    if (!state.res) { setMsg('ゆびをはなさずに、ぐるっと形をかいてね ✏️'); return; }
    if (state.crossing || state.revealed) return;
    const i = shapeIndexAt(p);
    state.guesses = state.guesses.filter(g => shapeIndexAt(g) !== i);
    state.guesses.push(p);
    const left = state.res.shapes.length - state.guesses.length;
    setMsg(left > 0
      ? `よそうできたね！ のこり ${left} この形もよそうしてみよう。（そのまま「こたえを見る」でもOK）`
      : 'よそうできたね！ 「こたえを見る」をおしてみよう。（タップしなおしてもOK）');
    render();
  }

  function endDraw() {
    const d = state.drawing;
    if (!d) return;
    state.drawing = null;
    live.setAttribute('points', ''); closer.style.display = 'none';
    const b = Geo.bbox([d]);
    if (Math.max(b.w, b.h) < TAP_MAX) { tap(d[0]); return; }
    const simple = Geo.simplifyClosed(d, 0.6);
    if (Geo.selfIntersects(simple)) {
      setMsg('線がとちゅうで交わっているよ。交わらないように、もういちどかいてみよう。', 'bad');
      return;
    }
    if (d.length < 8 || Math.max(b.w, b.h) < 12 || Math.abs(Geo.signedArea(d)) < 40) {
      setMsg('小さすぎるみたい。もっと大きく、ぐるっとかいてね。', 'bad');
      return;
    }
    const pts = processDrawn(d);
    const others = state.raw.map(r => r.drawn ? processDrawn(r.pts) : r.pts);
    if (others.some(o => Geo.contoursIntersect(pts, o))) {
      setMsg('ほかの形と線が重なっているよ。はなしてかくか、すっぽり中にかいてね。', 'bad');
      return;
    }
    state.raw.push({ pts: d, drawn: true });
    state.revealed = false;
    rebuild();
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
    setShapes([presets[b.dataset.preset]()]);
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
    if (isImageFile(file)) return openImage(file);
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
      const n = res.shapes.length;
      let note = `「${file.name}」を読みこんだよ！` + (n > 1 ? ` 形が ${n} こあるね。それぞれの` : ' ') + '重心はどこかな？ タップしてよそうしよう。';
      if (skipped) note += `<br>（スプライン・だ円 ${skipped} こは未対応のためとばしたよ）`;
      setShapes(fitToView(contours), note);
    } catch (err) {
      clearAll();
      setMsg(err.message || 'ファイルを読みこめなかったよ。', 'bad');
    }
  }

  $('btnFile').addEventListener('click', () => $('file').click());
  $('btnCamera').addEventListener('click', () => $('camera').click());
  $('camera').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('file').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  stage.addEventListener('dragover', e => e.preventDefault());
  stage.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  /* ---------- 写真・画像から形をとりだす ---------- */

  const IMG_MAX = 640;   // 表示・処理する画像の長辺（画素）
  const CROP_MIN = 24;   // 切りぬきわくの最小サイズ（表示画素）
  // crop・contours は表示用キャンバスの座標。gray は切りぬいた範囲を元画像から取りなおしたもの
  const photo = { el: null, src: null, w: 0, h: 0, crop: null, gray: null, gw: 0, gh: 0, contours: [], gapTouched: false, threshTouched: false, drag: null };
  const isImageFile = f => (/^image\//.test(f.type) && !/svg/.test(f.type)) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);

  function loadImageEl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), el = new Image();
      el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
      el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      el.src = url;
    });
  }

  // 元画像の (sx,sy,sw,sh) を w×h のキャンバスにかく（すきとおった所は白い紙あつかい）
  function drawScaled(el, sx, sy, sw, sh, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, w, h);
    return c;
  }

  async function openImage(file) {
    let el;
    try { el = await loadImageEl(file); } catch (e) {
      setMsg('この画像は読みこめなかったよ。JPEG か PNG でためしてね。', 'bad');
      return;
    }
    const s = Math.min(1, IMG_MAX / Math.max(el.naturalWidth, el.naturalHeight));
    const w = Math.max(1, Math.round(el.naturalWidth * s)), h = Math.max(1, Math.round(el.naturalHeight * s));
    Object.assign(photo, {
      el, w, h, src: drawScaled(el, 0, 0, el.naturalWidth, el.naturalHeight, w, h),
      crop: { x: 0, y: 0, w, h }, gray: null, gapTouched: false, threshTouched: false, drag: null,
    });
    $('imgCanvas').width = w; $('imgCanvas').height = h;
    detectPhoto();
    $('imgDlg').showModal();
  }

  // 切りぬいた範囲を元画像から取りなおして明るさの配列にする（小さく切りぬくほど細かく見られる）
  function cropGray() {
    const c = photo.crop, k = photo.el.naturalWidth / photo.w;
    const s = Math.min(1, IMG_MAX / (Math.max(c.w, c.h) * k));
    const gw = Math.max(1, Math.round(c.w * k * s)), gh = Math.max(1, Math.round(c.h * k * s));
    const d = drawScaled(photo.el, c.x * k, c.y * k, c.w * k, c.h * k, gw, gh).getContext('2d').getImageData(0, 0, gw, gh).data;
    const gray = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    Object.assign(photo, { gray, gw, gh });
  }

  function detectPhoto() {
    if (!photo.gray) cropGray();
    // 感度は、さわるまでは画像のざらつきから自動で決める
    if (!photo.threshTouched) $('imgThresh').value = Math.round(47 - 100 * Trace.suggestThreshold(photo.gray, photo.gw, photo.gh));
    const t = (47 - parseFloat($('imgThresh').value)) / 100, c = photo.crop;
    const res = Trace.detect(photo.gray, photo.gw, photo.gh, { t, gap: photo.gapTouched ? parseInt($('imgGap').value, 10) : null });
    if (!photo.gapTouched) $('imgGap').value = res.gap;
    const kx = c.w / photo.gw, ky = c.h / photo.gh;
    photo.contours = res.contours.map(pts => pts.map(p => ({ x: c.x + p.x * kx, y: c.y + p.y * ky })));
    const n = photo.contours.length;
    $('imgInfo').textContent = n
      ? `形が ${n} こ見つかったよ！（オレンジのところ）`
      : '形が見つからない…。わくやつまみを動かすか、とりなおしてね。';
    $('imgOk').disabled = !n;
    drawPhoto(true);
  }

  function drawPhoto(withShapes) {
    const ctx = $('imgCanvas').getContext('2d'), c = photo.crop, W = photo.w, H = photo.h;
    const u = Math.max(1, W / 320);   // 線の太さの単位
    ctx.drawImage(photo.src, 0, 0);
    if (withShapes) {
      ctx.beginPath();
      for (const pts of photo.contours) {
        pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(255, 170, 0, .45)'; ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = '#e02020'; ctx.stroke();
    }
    // わくの外を暗くする
    ctx.fillStyle = 'rgba(0, 20, 50, .55)';
    ctx.fillRect(0, 0, W, c.y); ctx.fillRect(0, c.y + c.h, W, H - c.y - c.h);
    ctx.fillRect(0, c.y, c.x, c.h); ctx.fillRect(c.x + c.w, c.y, W - c.x - c.w, c.h);
    ctx.lineWidth = u; ctx.strokeStyle = '#fff';
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    // かどのつまみ
    const L = Math.min(14 * u, c.w / 3, c.h / 3);
    ctx.lineWidth = 3 * u; ctx.strokeStyle = '#2b7de9'; ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[c.x, c.y, 1, 1], [c.x + c.w, c.y, -1, 1], [c.x, c.y + c.h, 1, -1], [c.x + c.w, c.y + c.h, -1, -1]]) {
      ctx.moveTo(x + dx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * L);
    }
    ctx.stroke();
  }

  /* 切りぬきわくの操作：かど = 大きさ変更、わくの中 = 移動、わくの外 = かきなおし */
  function canvasPoint(e) {
    const r = $('imgCanvas').getBoundingClientRect(), k = photo.w / r.width;
    return {
      x: Math.min(photo.w, Math.max(0, (e.clientX - r.left) * k)),
      y: Math.min(photo.h, Math.max(0, (e.clientY - r.top) * k)),
      hit: 26 * k,   // つまみの当たり判定（画面上で約26px）
    };
  }
  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  $('imgWrap').addEventListener('pointerdown', e => {
    if (e.button > 0 || photo.drag) return;
    e.preventDefault();
    $('imgWrap').setPointerCapture(e.pointerId);
    const p = canvasPoint(e), c = photo.crop, prev = { ...c };
    const xs = [c.x, c.x + c.w], ys = [c.y, c.y + c.h];
    let drag = null, best = p.hit;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const d = Math.hypot(p.x - xs[i], p.y - ys[j]);
      if (d < best) { best = d; drag = { anchor: { x: xs[1 - i], y: ys[1 - j] } }; }  // 反対のかどを固定
    }
    if (!drag) {
      const inside = p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h;
      drag = inside ? { move: { dx: p.x - c.x, dy: p.y - c.y } } : { anchor: { x: p.x, y: p.y } };
    }
    drag.prev = prev;
    photo.drag = drag;
  });

  $('imgWrap').addEventListener('pointermove', e => {
    const d = photo.drag;
    if (!d) return;
    const p = canvasPoint(e), c = photo.crop;
    if (d.move) {
      c.x = Math.min(photo.w - c.w, Math.max(0, p.x - d.move.dx));
      c.y = Math.min(photo.h - c.h, Math.max(0, p.y - d.move.dy));
    } else {
      photo.crop = rectFrom(d.anchor, p);
    }
    drawPhoto(false);
  });

  function endCropDrag() {
    const d = photo.drag;
    if (!d) return;
    photo.drag = null;
    const c = photo.crop;
    if (c.w < CROP_MIN || c.h < CROP_MIN) photo.crop = d.prev;   // 小さすぎるわくは取り消し
    else photo.crop = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
    photo.gray = null;
    detectPhoto();
  }
  $('imgWrap').addEventListener('pointerup', endCropDrag);
  $('imgWrap').addEventListener('pointercancel', endCropDrag);
  $('imgCropReset').addEventListener('click', () => {
    photo.crop = { x: 0, y: 0, w: photo.w, h: photo.h };
    photo.gray = null;
    detectPhoto();
  });

  $('imgThresh').addEventListener('input', () => { photo.threshTouched = true; detectPhoto(); });
  $('imgGap').addEventListener('input', () => { photo.gapTouched = true; detectPhoto(); });
  $('imgCancel').addEventListener('click', () => $('imgDlg').close());
  $('imgOk').addEventListener('click', () => {
    $('imgDlg').close();
    const n = photo.contours.length;
    // 手がきと同じあつかい（ぎざぎざを取り、なめらかに）
    state.raw = fitToView(photo.contours).map(pts => ({ pts, drawn: true }));
    state.revealed = false; state.guesses = [];
    rebuild();
    if (state.res && !state.crossing) {
      setMsg('しゃしんから形をとりだしたよ！' + (n > 1 ? ` 形が ${n} こあるね。それぞれの` : ' ') + '重心はどこかな？ タップしてよそうしよう。');
    }
  });

  /* ---------- こたえ・回転 ---------- */

  $('btnReveal').addEventListener('click', () => {
    state.revealed = true;
    if (state.res.shapes.some(s => !s.inside)) setMsg('重心は ここ！ …あれ？ 形の外にあるものがあるね。へこんだ形だと、こういうことがおきるよ。', 'bad');
    else setMsg('重心は ここ！ ここにじくをさすと、ぶれずにまわるコマになるよ。', 'good');
    render();
  });

  function stopSpin() {
    if (!state.spin) return;
    cancelAnimationFrame(state.spin.raf);
    state.spin = null;
    $('pivots').innerHTML = '';
    for (const g of shapeG.children) g.removeAttribute('transform');
  }

  // 図形ごとに、それぞれの軸（重心 or よそうの点）でまわす
  function startSpin(useGuess) {
    stopSpin();
    const pivots = state.res.shapes.map((s, i) => (useGuess && guessFor(i)) || s.centroid);
    $('pivots').innerHTML = pivots.map(p => `<circle class="pivot" r="1.2" cx="${p.x}" cy="${p.y}"/>`).join('');
    const spin = state.spin = { raf: 0 };
    let angle = 0, last = performance.now();
    const tick = now => {
      angle = (angle + (now - last) * 0.36) % 360;   // 1秒で1回転
      last = now;
      pivots.forEach((p, i) => {
        const g = shapeG.children[i];
        if (g) g.setAttribute('transform', `rotate(${angle.toFixed(2)} ${p.x} ${p.y})`);
      });
      spin.raf = requestAnimationFrame(tick);
    };
    spin.raf = requestAnimationFrame(tick);
    setMsg(useGuess
      ? 'よそうの点でまわすと、重心（十字のしるし）がぐるぐるうごく。これが「ぶれ」のもと！'
      : '重心でまわすと、重さのまん中がうごかない。だから ぶれにくい！');
    render();
  }
  $('btnSpinC').addEventListener('click', () => startSpin(false));
  $('btnSpinG').addEventListener('click', () => startSpin(true));
  $('btnStop').addEventListener('click', () => { stopSpin(); render(); });

  /* ---------- 設定・ダウンロード ---------- */

  $('btnClear').addEventListener('click', clearAll);
  $('btnUndo').addEventListener('click', () => { state.raw.pop(); state.guesses = []; rebuild(); });
  $('smooth').addEventListener('change', rebuild);
  $('size').addEventListener('input', () => { $('sizeNum').value = $('size').value; render(); });
  $('sizeNum').addEventListener('input', () => { $('size').value = $('sizeNum').value; render(); });
  ['markMode', 'shaft', 'shaftCustom'].forEach(id => $(id).addEventListener('input', render));

  $('btnDownload').addEventListener('click', () => {
    const r = state.res;
    const svg = Geo.buildSVG({
      shapes: r.shapes, bbox: r.bbox,
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
