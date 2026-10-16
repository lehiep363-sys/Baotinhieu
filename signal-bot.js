#!/usr/bin/env node
/**
 * signal-bot.js — Bot quét tín hiệu Điểm 2 (RSI retest MA9) và báo qua Telegram.
 *
 * Cách chạy:  node signal-bot.js
 *
 * Biến môi trường:
 *   TELEGRAM_BOT_TOKEN    (bắt buộc) Token bot lấy từ @BotFather
 *   TELEGRAM_CHAT_ID      (bắt buộc) Chat ID của bạn (lấy qua getUpdates sau khi /start bot)
 *   SYMBOLS               (tùy chọn) VD: "NEARUSDT,OPUSDT" (mặc định: NEARUSDT,OPUSDT,ARBUSDT,CAKEUSDT,ETHFIUSDT)
 *   TIMEFRAMES            (tùy chọn) VD: "15m,1h" (mặc định: 15m,1h,4h)
 *   MAX_SIGNAL_AGE_HOURS  (tùy chọn) Bỏ qua tín hiệu cũ hơn X giờ (mặc định 24; 0 = tắt)
 *
 * Không cần cài thêm thư viện nào — chỉ dùng fetch có sẵn của Node 20+.
 * Chống spam: state.json lưu openTime của nến trigger đã báo, theo khóa
 * "<SYMBOL>|<TF>|<LONG|SHORT>". Chỉ gửi khi có trigger mới hơn.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ================= 1. Cấu hình =================

const DEFAULT_SYMBOLS = ['NEARUSDT', 'OPUSDT', 'ARBUSDT', 'CAKEUSDT', 'ETHFIUSDT'];
const DEFAULT_TFS = ['15m', '1h', '4h'];

// Map khung giờ -> khung cao hơn để lọc bằng BTC (giống app Crypto Chart)
const HTF_MAP = {
  '1m': '5m', '5m': '15m', '15m': '1h', '30m': '2h', '1h': '4h',
  '2h': '6h', '3h': '12h', '4h': '1d', '6h': '1d', '12h': '2d',
  '1d': '1w', '2d': '1w', '3d': '1w', '6d': '1w', '1w': '1M',
};

const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
const STATE_PATH = path.join(__dirname, 'state.json');
const KLINES_LIMIT = 200; // số nến lấy mỗi lần (đủ làm nóng RSI14 + MA45)

// Chuẩn hóa khung giờ: '1M' (tháng) giữ nguyên, còn lại lowercase rồi đối chiếu whitelist
function normTF(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (t === '1M') return '1M'; // tháng — phân biệt với '1m' (1 phút)
  const hit = VALID_TFS.find((v) => v.toLowerCase() === t.toLowerCase());
  return hit || null;
}

function parseSymbols(envVal) {
  const arr = String(envVal || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]+$/.test(s));
  return arr.length ? [...new Set(arr)] : DEFAULT_SYMBOLS;
}

function parseTFs(envVal) {
  const arr = String(envVal || '')
    .split(',')
    .map(normTF)
    .filter(Boolean);
  const uniq = [...new Set(arr)];
  return uniq.length ? uniq : DEFAULT_TFS;
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SYMBOLS = parseSymbols(process.env.SYMBOLS);
const TIMEFRAMES = parseTFs(process.env.TIMEFRAMES);
const MAX_AGE_H = process.env.MAX_SIGNAL_AGE_HOURS === undefined
  ? 24
  : parseFloat(process.env.MAX_SIGNAL_AGE_HOURS);

// ================= 2. Lấy dữ liệu Binance =================

async function fetchKlines(symbol, interval, limit = KLINES_LIMIT) {
  const qs = `symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const urls = [
    `https://api.binance.com/api/v3/klines?${qs}`,
    `https://data-api.binance.vision/api/v3/klines?${qs}`, // fallback khi api.binance.com bị chặn vùng
  ];
  let lastErr = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'signal-bot/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j) && j.length > 0) return j;
      throw new Error('dữ liệu rỗng');
    } catch (e) {
      lastErr = e;
      console.log(`    ⚠️ Lỗi ${new URL(u).hostname}: ${e.message} — thử nguồn khác...`);
    }
  }
  throw lastErr;
}

// ================= 3. Chỉ báo: RSI (Wilder) + SMA =================

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  rsi[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return rsi;
}

function computeSMA(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] == null) { ok = false; break; }
      sum += values[j];
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

// ================= 4. Engine nhận diện Điểm 2 =================
// Logic (áp dụng cho nến đã đóng, tín hiệu chốt tại nến trigger):
//   BUY:  (1) RSI rơi < 30 tạo đáy hoảng loạn (ghi RSI thấp nhất)
//          (2) RSI bật lên cắt xuyên qua MA9 (đóng trên MA9, nến trước đóng dưới/tại MA9)
//          (3) RSI tạo đỉnh pivot nhỏ 1 (cao hơn 3 nến mỗi bên)
//          (4) RSI hồi về test MA9 tạo đáy pivot nhỏ 2 (thấp hơn 3 nến mỗi bên;
//              chấp nhận vừa chạm MA9 bật lên hoặc xuyên nhẹ xuống dưới MA9)
//          (5) BẮT BUỘC: RSI tại đáy nhỏ 2 >= RSI đáy hoảng loạn (không thì loại)
//          (6) trigger — biến thể nào tới trước thì chốt:
//              A: đáy nhỏ 2 < MA9  → nến đóng trên MA9 ⇒ BUY
//              B: đáy nhỏ 2 > MA9 và 3 đường siết (max-min < 3) → nến đóng trên MA45 ⇒ BUY
//              C: đáy nhỏ 2 > MA9, RSI < 25, RSI < MA45-5 → 5 nến liên tiếp có
//                 |RSI-MA45| giảm dần ⇒ BUY tại nến thứ 5
//   SHORT: đối xứng hoàn toàn (đỉnh hoảng loạn > 70, cắt xuống MA9,
//          đáy pivot nhỏ 1, đỉnh pivot nhỏ 2 phải <= đỉnh hoảng loạn,
//          trigger A: đóng dưới MA9; B: siết < 3 và đóng dưới MA45;
//          C: RSI > 75, RSI > MA45+5, 5 nến tiến sát MA45).

const PIVOT_N = 3;    // đỉnh/đáy nhỏ: cao/thấp hơn N nến mỗi bên
const PANIC_N = 5;    // đáy/đỉnh hoảng loạn: cực trị trong ±5 nến
const RETEST_TOL = 6; // đáy nhỏ 2 được lệch khỏi MA9 tối đa 6 điểm RSI
const SQUEEZE_MAX = 3;// 3 đường siết: max(RSI,MA9,MA45) - min(...) < 3
const SCAN_START = 60;// bỏ qua đoạn đầu để RSI14 + MA45 đủ nóng

const NN = (arr, i) => (i >= 0 && i < arr.length && arr[i] != null ? arr[i] : null);

function isPivotHigh(arr, i, n) {
  const v = NN(arr, i);
  if (v == null) return false;
  for (let k = 1; k <= n; k++) {
    const l = NN(arr, i - k), r = NN(arr, i + k);
    if (l == null || r == null || l >= v || r >= v) return false;
  }
  return true;
}

function isPivotLow(arr, i, n) {
  const v = NN(arr, i);
  if (v == null) return false;
  for (let k = 1; k <= n; k++) {
    const l = NN(arr, i - k), r = NN(arr, i + k);
    if (l == null || r == null || l <= v || r <= v) return false;
  }
  return true;
}

// Tìm trigger sau đáy/đỉnh nhỏ 2 — trả về {variant:'A'|'B'|'C', index} của biến thể tới trước
function findTrigger(rsi, ma9, ma45, b2, dir) {
  const isLong = dir > 0;
  const rb2 = NN(rsi, b2), mb2 = NN(ma9, b2), m45b2 = NN(ma45, b2);
  if (rb2 == null || mb2 == null || m45b2 == null) return null;
  const end = Math.min(b2 + 40, rsi.length - 1);
  let best = null;
  const consider = (variant, index) => {
    if (index > b2 && index <= end && (!best || index < best.index)) best = { variant, index };
  };

  // Biến thể A: đáy nhỏ 2 phía kia MA9 → đóng nến vượt qua MA9
  const aApplies = isLong ? rb2 < mb2 : rb2 > mb2;
  if (aApplies) {
    for (let i = b2 + 1; i <= end; i++) {
      const r = NN(rsi, i), m = NN(ma9, i);
      if (r == null || m == null) continue;
      if (isLong ? r > m : r < m) { consider('A', i); break; }
    }
  }

  // Biến thể B: đáy/đỉnh nhỏ 2 phía trong + 3 đường siết → đóng nến vượt qua MA45
  const spread = Math.max(rb2, mb2, m45b2) - Math.min(rb2, mb2, m45b2);
  const bApplies = (isLong ? rb2 > mb2 : rb2 < mb2) && spread < SQUEEZE_MAX;
  if (bApplies) {
    for (let i = b2 + 1; i <= end; i++) {
      const r = NN(rsi, i), m = NN(ma45, i);
      if (r == null || m == null) continue;
      if (isLong ? r > m : r < m) { consider('B', i); break; }
    }
  }

  // Biến thể C: cực trị RSI + 5 nến liên tiếp có |RSI - MA45| giảm dần → chốt tại nến thứ 5
  const cApplies = isLong
    ? (rb2 > mb2 && rb2 < 25 && rb2 < m45b2 - 5)
    : (rb2 < mb2 && rb2 > 75 && rb2 > m45b2 + 5);
  if (cApplies) {
    for (let k = b2; k <= Math.min(b2 + 10, end - 4); k++) {
      let ok = true;
      for (let j = 1; j <= 4; j++) {
        const a0 = NN(rsi, k + j - 1), m0 = NN(ma45, k + j - 1);
        const a1 = NN(rsi, k + j), m1 = NN(ma45, k + j);
        if (a0 == null || m0 == null || a1 == null || m1 == null ||
            !(Math.abs(a1 - m1) < Math.abs(a0 - m0))) { ok = false; break; }
      }
      if (ok) { consider('C', k + 4); break; }
    }
  }
  return best;
}

function detectDir(rsi, ma9, ma45, dir) {
  const isLong = dir > 0;
  const n = rsi.length;
  const signals = [];
  for (let pb = SCAN_START; pb < n - 10; pb++) {
    const rpb = NN(rsi, pb);
    if (rpb == null) continue;

    // (1) Đáy/đỉnh hoảng loạn: RSI < 30 (Long) / > 70 (Short), cực trị ±5 nến
    if (isLong ? rpb >= 30 : rpb <= 70) continue;
    if (isLong ? !isPivotLow(rsi, pb, PANIC_N) : !isPivotHigh(rsi, pb, PANIC_N)) continue;

    // (2) RSI bật lên/vọt xuống cắt xuyên qua MA9 sau đó
    let cross = -1;
    const crossEnd = Math.min(pb + 60, n - 1);
    for (let i = pb + 1; i <= crossEnd; i++) {
      const r0 = NN(rsi, i - 1), m0 = NN(ma9, i - 1), r1 = NN(rsi, i), m1 = NN(ma9, i);
      if (r0 == null || m0 == null || r1 == null || m1 == null) continue;
      const crossed = isLong ? (r0 <= m0 && r1 > m1) : (r0 >= m0 && r1 < m1);
      if (crossed) { cross = i; break; }
    }
    if (cross < 0) continue;

    // (3) Điểm nhỏ 1: đỉnh/đáy pivot (N=3) sau nến cắt
    let p1 = -1;
    const p1End = Math.min(cross + 40, n - 1 - PIVOT_N);
    for (let i = cross + 1; i <= p1End; i++) {
      if (isLong ? isPivotHigh(rsi, i, PIVOT_N) : isPivotLow(rsi, i, PIVOT_N)) { p1 = i; break; }
    }
    if (p1 < 0) continue;

    // (4) Điểm nhỏ 2: pivot retest quanh MA9 sau điểm nhỏ 1
    let b2 = -1;
    const b2End = Math.min(p1 + 40, n - 1 - PIVOT_N);
    for (let i = p1 + 1; i <= b2End; i++) {
      const isPiv = isLong ? isPivotLow(rsi, i, PIVOT_N) : isPivotHigh(rsi, i, PIVOT_N);
      if (!isPiv) continue;
      const rb = NN(rsi, i), mb = NN(ma9, i);
      if (rb == null || mb == null) continue;
      if (Math.abs(rb - mb) > RETEST_TOL) continue; // phải test quanh MA9
      b2 = i; break;
    }
    if (b2 < 0) continue;

    // (5) ĐIỀU KIỆN BẮT BUỘC: không phá vỡ cực trị pha trước
    const rb2 = NN(rsi, b2);
    const guardOk = isLong ? rb2 >= rpb : rb2 <= rpb;
    if (!guardOk) continue;

    // (6) Trigger — biến thể nào tới trước thì chốt
    const trig = findTrigger(rsi, ma9, ma45, b2, dir);
    if (trig) signals.push({ dir: isLong ? 'LONG' : 'SHORT', trigger: trig.variant, index: trig.index });
  }
  return signals;
}

// Quét cả 2 chiều, trả về mảng {dir:'LONG'|'SHORT', trigger:'A'|'B'|'C', index}
function detectSignals(rsi, ma9, ma45) {
  if (!rsi || rsi.length < 70) return [];
  return [...detectDir(rsi, ma9, ma45, +1), ...detectDir(rsi, ma9, ma45, -1)];
}

// ================= 5. Bộ lọc BTC khung cao =================

async function btcHTFCheck(tf, dir, cache) {
  const htf = HTF_MAP[tf];
  if (!htf) {
    console.log(`    ⚠️ Khung ${tf} chưa có map HTF — bỏ qua bộ lọc BTC.`);
    return { filtered: false };
  }
  let d = cache.get(htf);
  if (!d) {
    const kl = await fetchKlines('BTCUSDT', htf, KLINES_LIMIT);
    const closed = kl.slice(0, -1);
    const closes = closed.map((k) => parseFloat(k[4]));
    const rsi = computeRSI(closes);
    const ma9 = computeSMA(rsi, 9);
    const ma45 = computeSMA(rsi, 45);
    const i = closes.length - 1;
    d = { rsi: rsi[i], ma9: ma9[i], ma45: ma45[i] };
    cache.set(htf, d);
  }
  const { rsi, ma9, ma45 } = d;
  if (rsi == null || ma9 == null || ma45 == null) return { filtered: false };
  const dist = Math.abs(rsi - ma45);
  const filtered = dir === 'LONG'
    ? (rsi < ma9 && rsi < ma45 && dist < 20)
    : (rsi > ma9 && rsi > ma45 && dist < 20);
  return { filtered, htf, rsi, ma9, ma45, dist };
}

// ================= 6. Gửi Telegram =================

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram API: ${j.description || `HTTP ${r.status}`}`);
}

// Giờ VN (UTC+7) dạng "10:15 16/10"
function fmtTime(ms) {
  const d = new Date(ms + 7 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
}

function fmtPrice(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) ? String(v) : s;
}

const TRIGGER_DESC = {
  LONG: {
    A: 'Trigger A — RSI đóng trên MA9',
    B: 'Trigger B — RSI đóng trên MA45 (3 đường siết)',
    C: 'Trigger C — 5 nến tiến sát MA45',
  },
  SHORT: {
    A: 'Trigger A — RSI đóng dưới MA9',
    B: 'Trigger B — RSI đóng dưới MA45 (3 đường siết)',
    C: 'Trigger C — 5 nến tiến sát MA45',
  },
};

function formatMessage(dir, symbol, tf, trigger, price, openTime) {
  const icon = dir === 'LONG' ? '🟢' : '🔴';
  return `${icon} ${dir} ${symbol} · ${tf}\n${TRIGGER_DESC[dir][trigger]}\nGiá: ${fmtPrice(price)} · Nến ${fmtTime(openTime)}`;
}

// ================= 7. State chống spam =================

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {}; // chưa có file → lần chạy đầu
  }
}

// ================= 8. Luồng chính =================

async function main() {
  console.log('🤖 Bot tín hiệu Điểm 2 — bắt đầu quét');
  console.log(`   Coin: ${SYMBOLS.join(', ')}`);
  console.log(`   Khung giờ: ${TIMEFRAMES.join(', ')}`);
  if (!TOKEN || !CHAT_ID) {
    console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID. Dừng lại.');
    process.exit(1);
  }

  const state = loadState();
  const htfCache = new Map();
  let sent = 0, skipped = 0, errors = 0;

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      try {
        console.log(`\n🔍 ${symbol} · ${tf}`);
        const klines = await fetchKlines(symbol, tf, KLINES_LIMIT);
        const closed = klines.slice(0, -1); // chỉ dùng nến đã đóng
        console.log(`   Đã lấy ${closed.length} nến đóng (nến mới nhất: ${fmtTime(closed[closed.length - 1][0])})`);

        const closes = closed.map((k) => parseFloat(k[4]));
        const rsi = computeRSI(closes);
        const ma9 = computeSMA(rsi, 9);
        const ma45 = computeSMA(rsi, 45);

        const signals = detectSignals(rsi, ma9, ma45);
        if (!signals.length) { console.log('   → Không có tín hiệu.'); continue; }

        // Lấy trigger mới nhất cho mỗi chiều
        const latest = {};
        for (const s of signals) {
          if (!latest[s.dir] || s.index > latest[s.dir].index) latest[s.dir] = s;
        }
        console.log(`   → Tìm thấy: ${Object.entries(latest).map(([d, s]) => `${d} trigger ${s.trigger}`).join(', ')}`);

        for (const dir of ['LONG', 'SHORT']) {
          const s = latest[dir];
          if (!s) continue;
          const openTime = closed[s.index][0];
          const price = closed[s.index][4];

          // Bỏ qua tín hiệu quá cũ (an toàn khi chạy lần đầu)
          const ageH = (Date.now() - openTime) / 3600000;
          if (MAX_AGE_H > 0 && ageH > MAX_AGE_H) {
            console.log(`   → ${dir} trigger ${s.trigger} đã cũ (${ageH.toFixed(1)}h > ${MAX_AGE_H}h) — bỏ qua.`);
            skipped++; continue;
          }

          // Bộ lọc BTC khung cao
          const f = await btcHTFCheck(tf, dir, htfCache);
          if (f.filtered) {
            console.log(`   → ${dir} bị lọc BTC HTF (${tf}→${f.htf}, RSI BTC ${f.rsi.toFixed(1)}) — bỏ qua.`);
            skipped++; continue;
          }

          // Chống spam: chỉ gửi khi trigger mới hơn lần đã báo
          const key = `${symbol}|${tf}|${dir}`;
          if (openTime <= (state[key] || 0)) {
            console.log(`   → ${dir} đã báo trước đó — bỏ qua.`);
            skipped++; continue;
          }

          await sendTelegram(formatMessage(dir, symbol, tf, s.trigger, price, openTime));
          console.log(`   ✅ Đã gửi Telegram: ${dir} trigger ${s.trigger} @ ${fmtPrice(price)}`);
          state[key] = openTime;
          sent++;
        }
      } catch (e) {
        errors++;
        console.log(`   ❌ Lỗi ${symbol} ${tf}: ${e.message}`);
      }
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\n🏁 Xong: gửi ${sent} tin, bỏ qua ${skipped}, lỗi ${errors}.`);
}

if (require.main === module) {
  main().catch((e) => { console.error('❌ Lỗi nghiêm trọng:', e.message); process.exit(1); });
}

// Export để test unit (require file này sẽ KHÔNG chạy main nhờ guard ở trên)
module.exports = { computeRSI, computeSMA, detectSignals, HTF_MAP, normTF };
