/*
 * 合成した手牌の画像を「写真らしく」する（テスト用）。
 */

// 写真らしくする: 机の背景・牌の影・遠近のゆがみ（上が狭い台形）・傾き・照明のむら・影の帯
// 撮影枠で切り出した画像を想定し、手牌のまわりに少し机が写る
export function photoize(c, p, rand = Math.random) {
  const w = c.width, h = c.height;
  // 1) 遠近: 上の行ほど横に縮める（1 行ずつ描く）
  const persp = new OffscreenCanvas(w, h);
  const pc = persp.getContext('2d');
  for (let y = 0; y < h; y++) {
    const k = 1 - p.persp * (1 - y / h);
    pc.drawImage(c, 0, y, w, 1, (w - w * k) / 2, y, w * k, 1);
  }
  // 2) 机の上に置き、影を落として少し傾ける
  const mx = Math.round(w * p.margin), my = Math.round(h * p.margin * 2.5);
  const out = new OffscreenCanvas(w + mx * 2, h + my * 2);
  const ctx = out.getContext('2d');
  const W = out.width, H = out.height;
  ctx.fillStyle = p.desk;
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 60; i++) { // 机の木目・布目
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '0,0,0' : '255,255,255'},${(rand() * 0.06).toFixed(3)})`;
    ctx.fillRect(rand() * W, rand() * H, 1 + rand() * 6, 1);
  }
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((p.tilt * Math.PI) / 180);
  ctx.shadowColor = p.noDrop ? 'transparent' : 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = h * 0.08;
  ctx.shadowOffsetX = h * 0.03;
  ctx.shadowOffsetY = h * 0.06;
  ctx.drawImage(persp, -w / 2, -h / 2);
  ctx.restore();
  // 3) 照明のむら（片側が暗い）と、手や物の影の帯
  ctx.globalCompositeOperation = 'multiply';
  const light = ctx.createLinearGradient(0, 0, W, 0);
  const dark = `rgb(${Math.round(255 * (1 - p.vignette))},${Math.round(255 * (1 - p.vignette))},${Math.round(255 * (1 - p.vignette * 0.9))})`;
  light.addColorStop(0, p.lightLeft ? '#fff' : dark);
  light.addColorStop(1, p.lightLeft ? dark : '#fff');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, H);
  if (p.shadow) {
    const x0 = W * p.shadow.at, sw = W * p.shadow.width;
    const sg = ctx.createLinearGradient(x0, 0, x0 + sw, 0);
    const s = Math.round(255 * (1 - p.shadow.depth));
    sg.addColorStop(0, '#fff');
    sg.addColorStop(0.3, `rgb(${s},${s},${s})`);
    sg.addColorStop(0.7, `rgb(${s},${s},${s})`);
    sg.addColorStop(1, '#fff');
    ctx.fillStyle = sg;
    ctx.fillRect(x0, 0, sw, H);
  }
  ctx.globalCompositeOperation = 'source-over';
  return out;
}
