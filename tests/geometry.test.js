const test = require('node:test');
const assert = require('node:assert');
const Geo = require('../geometry.js');
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

test('正方形の重心', () => {
  const r = Geo.analyze([rect(0, 0, 10, 10)]);
  near(r.centroid.x, 5); near(r.centroid.y, 5); near(r.area, 100);
  assert.ok(r.inside); near(r.edgeDist, 5);
});

test('L字の重心（向きによらない）', () => {
  const L = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  for (const pts of [L, L.slice().reverse()]) {
    const r = Geo.analyze([pts]);
    near(r.centroid.x, 25 / 3); near(r.centroid.y, 25 / 3); near(r.area, 300);
  }
});

test('穴つき・別の形は除外', () => {
  const r = Geo.analyze([rect(0, 0, 20, 10), rect(12, 2, 6, 6), rect(100, 100, 3, 3)]);
  near(r.area, 164); near(r.centroid.x, (200 * 10 - 36 * 15) / 164); near(r.centroid.y, 5);
  assert.strictEqual(r.droppedShapes, 1);
  assert.strictEqual(r.contours.filter(c => c.hole).length, 1);
});

test('重心が形の外', () => {
  const v = [{ x: 20, y: 150 }, { x: 100, y: 30 }, { x: 180, y: 150 }, { x: 160, y: 162 }, { x: 100, y: 72 }, { x: 40, y: 162 }];
  assert.strictEqual(Geo.analyze([v]).inside, false);
});

test('自己交差', () => {
  assert.ok(Geo.selfIntersects([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]));
  assert.ok(!Geo.selfIntersects(rect(0, 0, 5, 5)));
});

test('簡略化・平滑化で重心がほぼ変わらない', () => {
  const c = [];
  for (let i = 0; i < 400; i++) c.push({ x: 50 + 30 * Math.cos(i / 400 * 2 * Math.PI), y: 40 + 20 * Math.sin(i / 400 * 2 * Math.PI) });
  const s = Geo.smoothClosed(Geo.simplifyClosed(c, 0.3), 2);
  assert.ok(s.length < 400);
  const g = Geo.polygonCentroid(s);
  near(g.x, 50, 0.2); near(g.y, 40, 0.2);
});

const dxf = ents => ['0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\n');

test('DXF: bulgeつきLWPOLYLINE = 円', () => {
  const { contours } = Geo.parseDXF(dxf(['0', 'LWPOLYLINE', '90', '2', '70', '1', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0', '42', '1']));
  const r = Geo.analyze(contours);
  near(r.centroid.x, 5, 1e-6); near(r.centroid.y, 0, 1e-6); near(r.area, Math.PI * 25, 0.1);
});

test('DXF: LINEとARCの連結', () => {
  // 半円（右半分）+ 直線でとじる
  const { contours } = Geo.parseDXF(dxf([
    '0', 'ARC', '10', '0', '20', '0', '40', '10', '50', '270', '51', '90',
    '0', 'LINE', '10', '0', '20', '10', '11', '0', '21', '-10']));
  assert.strictEqual(contours.length, 1);
  const r = Geo.analyze(contours);
  near(r.centroid.x, 40 / (3 * Math.PI), 0.02); near(r.centroid.y, 0, 1e-6);
});

test('SVG出力はmm単位', () => {
  const r = Geo.analyze([rect(10, 10, 100, 50)]);
  const svg = Geo.buildSVG({ contours: r.contours, centroid: r.centroid, bbox: r.bbox, mmPerUnit: 0.6, mark: 'hole', holeDiameter: 3 });
  assert.match(svg, /width="70mm" height="40mm" viewBox="0 0 70 40"/);
  assert.match(svg, /<circle id="shaft-hole" cx="35" cy="20" r="1.5"/);
});
