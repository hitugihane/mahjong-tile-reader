/*!
 * tile-art.js — テスト・デモ用の簡易な麻雀牌の絵（canvas で描画）
 * 実際のゲームの牌とは絵柄が違うので、本番では実物のスクショから基準を登録してください。
 */

const KANJI_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONORS = ['東', '南', '西', '北', '白', '發', '中'];

const STYLES = {
  // 絵柄A: 明朝体、丸は「色・白い輪・色の点」、棒は白い節
  A: {
    style: 'A',
    face: '#f6f2e7',
    faceEdge: '#d6cfbc',
    back: '#1e6f8e',
    ink: '#1b1b1b',
    red: '#cc2b2b',
    green: '#1d8a4a',
    blue: '#1f4fa8',
    font: '"Noto Serif CJK JP","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif',
    weight: 'bold',
  },
  // 絵柄B: 極太の明朝体、丸は塗りつぶしに縁と白い点、棒は細く暗い節、配置は中央寄り、背はオレンジ
  B: {
    style: 'B',
    face: '#fbfaf4',
    faceEdge: '#cfc9b8',
    back: '#d98c1f',
    ink: '#222222',
    red: '#d24a2a',
    green: '#2e7d32',
    blue: '#2b5ea8',
    font: '"Noto Serif CJK JP","Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif',
    weight: '900',
  },
};

export const ART = { ...STYLES.A };

/** 絵柄を切り替える（'A' か 'B'） */
export function useStyle(name) {
  Object.assign(ART, STYLES[name] || STYLES.A);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function circle(ctx, cx, cy, r, color) {
  if (ART.style === 'B') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.stroke();
    ctx.fillStyle = ART.face;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ART.face;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
  ctx.fill();
}

function stick(ctx, cx, cy, sw, sh, color, angle = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  roundRect(ctx, -sw / 2, -sh / 2, sw, sh, sw / 2);
  ctx.fill();
  if (ART.style === 'B') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (const t of [-0.22, 0.22]) ctx.fillRect(-sw / 2, sh * t - sh * 0.03, sw, sh * 0.06);
  } else {
    ctx.fillStyle = ART.face;
    ctx.fillRect(-sw / 2, -sh * 0.03, sw, sh * 0.06);
  }
  ctx.restore();
}

const P = {
  1: [[0.5, 0.5]],
  2: [[0.5, 0.26], [0.5, 0.74]],
  3: [[0.22, 0.18], [0.5, 0.5], [0.78, 0.82]],
  4: [[0.28, 0.26], [0.72, 0.26], [0.28, 0.74], [0.72, 0.74]],
  5: [[0.25, 0.2], [0.75, 0.2], [0.5, 0.5], [0.25, 0.8], [0.75, 0.8]],
  6: [[0.3, 0.15], [0.7, 0.15], [0.3, 0.56], [0.7, 0.56], [0.3, 0.86], [0.7, 0.86]],
  7: [[0.2, 0.1], [0.5, 0.22], [0.8, 0.34], [0.3, 0.62], [0.7, 0.62], [0.3, 0.88], [0.7, 0.88]],
  8: [[0.3, 0.12], [0.7, 0.12], [0.3, 0.37], [0.7, 0.37], [0.3, 0.63], [0.7, 0.63], [0.3, 0.88], [0.7, 0.88]],
  9: [[0.18, 0.16], [0.5, 0.16], [0.82, 0.16], [0.18, 0.5], [0.5, 0.5], [0.82, 0.5], [0.18, 0.84], [0.5, 0.84], [0.82, 0.84]],
};
const PC = {
  2: ['G', 'B'],
  3: ['B', 'R', 'G'],
  4: ['B', 'G', 'G', 'B'],
  5: ['B', 'G', 'R', 'G', 'B'],
  6: ['G', 'G', 'R', 'R', 'R', 'R'],
  7: ['G', 'G', 'G', 'R', 'R', 'R', 'R'],
  8: ['B', 'B', 'B', 'B', 'B', 'B', 'B', 'B'],
  9: ['B', 'B', 'B', 'R', 'R', 'R', 'G', 'G', 'G'],
};
const PR = { 2: 0.22, 3: 0.17, 4: 0.2, 5: 0.17, 6: 0.15, 7: 0.13, 8: 0.13, 9: 0.15 };

const S = {
  2: [[0.5, 0.27], [0.5, 0.73]],
  3: [[0.5, 0.27], [0.3, 0.73], [0.7, 0.73]],
  4: [[0.3, 0.27], [0.7, 0.27], [0.3, 0.73], [0.7, 0.73]],
  5: [[0.22, 0.27], [0.78, 0.27], [0.5, 0.5], [0.22, 0.73], [0.78, 0.73]],
  6: [[0.2, 0.27], [0.5, 0.27], [0.8, 0.27], [0.2, 0.73], [0.5, 0.73], [0.8, 0.73]],
  7: [[0.5, 0.15], [0.2, 0.52], [0.5, 0.52], [0.8, 0.52], [0.2, 0.84], [0.5, 0.84], [0.8, 0.84]],
  8: [[0.14, 0.27], [0.38, 0.27], [0.62, 0.27], [0.86, 0.27], [0.14, 0.73], [0.38, 0.73], [0.62, 0.73], [0.86, 0.73]],
  9: [[0.2, 0.17], [0.5, 0.17], [0.8, 0.17], [0.2, 0.5], [0.5, 0.5], [0.8, 0.5], [0.2, 0.83], [0.5, 0.83], [0.8, 0.83]],
};
const SR = { 5: [2], 7: [0], 9: [1, 4, 7] }; // 赤い棒
const SA = { 8: [0, 0.4, -0.4, 0, 0, -0.4, 0.4, 0] }; // 八索の傾き

const COLOR = { R: () => ART.red, G: () => ART.green, B: () => ART.blue };

/** 牌を 1 枚描く。(x, y) から幅 w・高さ h（下 14% は牌の側面） */
export function drawTile(ctx, code, x, y, w, h) {
  const n = Number(code[0]);
  const suit = code[1];
  const fh = h * 0.86;
  const r = w * 0.1;

  ctx.fillStyle = ART.back;
  roundRect(ctx, x, y + h * 0.1, w, h * 0.9, r);
  ctx.fill();
  ctx.fillStyle = ART.faceEdge;
  roundRect(ctx, x, y, w, fh, r);
  ctx.fill();
  ctx.fillStyle = ART.face;
  roundRect(ctx, x + w * 0.03, y + w * 0.03, w - w * 0.06, fh - w * 0.06, r * 0.8);
  ctx.fill();

  const cx = x + w * 0.1;
  const cy = y + fh * 0.08;
  const cw = w * 0.8;
  const ch = fh * 0.84;
  const B = ART.style === 'B';
  // 絵柄B は筒子・索子の配置を少し中央に寄せる
  const squeeze = B && (suit === 'p' || suit === 's');
  const at = (fx, fy) =>
    squeeze ? [cx + (0.5 + (fx - 0.5) * 0.88) * cw, cy + (0.5 + (fy - 0.5) * 0.92) * ch] : [cx + fx * cw, cy + fy * ch];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (suit === 'm') {
    ctx.fillStyle = ART.ink;
    ctx.font = `${ART.weight} ${Math.round(ch * (B ? 0.36 : 0.4))}px ${ART.font}`;
    ctx.fillText(KANJI_NUM[n - 1], ...at(0.5, B ? 0.22 : 0.25));
    ctx.fillStyle = ART.red;
    ctx.font = `${ART.weight} ${Math.round(ch * (B ? 0.5 : 0.46))}px ${ART.font}`;
    ctx.fillText('萬', ...at(0.5, B ? 0.71 : 0.73));
  } else if (suit === 'z') {
    if (n === 5) return; // 白は無地
    ctx.fillStyle = n === 6 ? ART.green : n === 7 ? ART.red : ART.ink;
    ctx.font = `${ART.weight} ${Math.round(ch * 0.62)}px ${ART.font}`;
    ctx.fillText(HONORS[n - 1], ...at(0.5, 0.52));
  } else if (suit === 'p') {
    const unit = Math.min(cw, ch * 0.75);
    if (n === 1) {
      const [px, py] = at(0.5, 0.5);
      const R = unit * 0.46;
      circle(ctx, px, py, R, ART.blue);
      circle(ctx, px, py, R * 0.55, ART.green);
      ctx.fillStyle = ART.red;
      ctx.beginPath();
      ctx.arc(px, py, R * 0.18, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    P[n].forEach(([fx, fy], i) => circle(ctx, ...at(fx, fy), unit * PR[n] * (B ? 0.85 : 1), COLOR[PC[n][i]]()));
  } else if (suit === 's') {
    if (n === 1 && B) {
      // 絵柄B の鳥: 丸い体・翼・赤い頭・青い尾
      ctx.fillStyle = ART.green;
      ctx.beginPath();
      ctx.arc(...at(0.45, 0.55), cw * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ART.blue;
      ctx.beginPath();
      const [tx, ty] = at(0.62, 0.62);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + cw * 0.3, ty + ch * 0.2);
      ctx.lineTo(tx + cw * 0.05, ty + ch * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ART.red;
      ctx.beginPath();
      ctx.arc(...at(0.35, 0.25), cw * 0.11, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (n === 1) {
      const [bx, by] = at(0.5, 0.58);
      ctx.fillStyle = ART.green;
      ctx.beginPath();
      ctx.ellipse(bx, by, cw * 0.26, ch * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ART.blue;
      ctx.beginPath();
      ctx.moveTo(bx - cw * 0.15, by + ch * 0.15);
      ctx.lineTo(bx + cw * 0.15, by + ch * 0.15);
      ctx.lineTo(bx, by + ch * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ART.red;
      ctx.beginPath();
      ctx.arc(...at(0.58, 0.22), cw * 0.13, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const sh = n >= 7 ? ch * 0.26 : ch * 0.38;
    const sw = cw * (n >= 6 ? 0.15 : 0.17) * (B ? 0.75 : 1);
    S[n].forEach(([fx, fy], i) => {
      const red = (SR[n] || []).includes(i);
      stick(ctx, ...at(fx, fy), sw, sh, red ? ART.red : ART.green, ((SA[n] || [])[i] || 0) * (B ? 0.75 : 1));
    });
  }
}

/**
 * 手牌を並べて描く。
 * @param {object} o tileH（牌の高さ）, gap（牌のすき間）, tsumoGap（最後の牌の前のすき間, 0 で無し）, pad（余白）, bg（背景色）
 * @returns {{width:number,height:number}} 描画に必要な大きさ（ctx が null のときは計測のみ）
 */
export function drawHand(ctx, codes, o = {}) {
  const tileH = o.tileH ?? 84;
  const tileW = Math.round(tileH * (o.ratio ?? 0.72));
  const gap = o.gap ?? 2;
  const tsumoGap = o.tsumoGap ?? 0;
  const pad = o.pad ?? 12;
  const width = pad * 2 + codes.length * tileW + (codes.length - 1) * gap + (tsumoGap ? tsumoGap : 0);
  const height = pad * 2 + tileH;
  if (!ctx) return { width, height };
  ctx.fillStyle = o.bg ?? '#2f6b4f';
  ctx.fillRect(0, 0, width, height);
  let x = pad;
  codes.forEach((c, i) => {
    if (tsumoGap && i === codes.length - 1) x += tsumoGap;
    drawTile(ctx, c, x, pad, tileW, tileH);
    x += tileW + gap;
  });
  return { width, height };
}
