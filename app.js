/* =========================================================
   面試排程與進度看板 — 主程式
   資料全部存在瀏覽器的 localStorage，不需要伺服器。
   ========================================================= */

const STAGES = ['投遞', '履歷篩選', '一面', '二面', 'Offer', '結案'];
const RESULTS = ['錄取', '未錄取', '候選人婉拒'];
const ROUND_TYPES = ['電話篩選', '一面', '二面', '三面', '主管面談', '其他'];
const STORAGE_KEY = 'interview-board-v1';
const META_KEY = 'interview-board-meta';   // 記錄上次備份時間、遮蔽模式等設定

const STUCK_DAYS = 5;        // 在同一階段超過幾天算「卡關」
const SOON_HOURS = 48;       // 幾小時內的面試標示「即將面試」
const BACKUP_DAYS = 7;       // 超過幾天沒備份就提醒
const RETENTION_DAYS = 180;  // 結案超過幾天建議刪除個資
const DAY = 24 * 60 * 60 * 1000;

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);

// 把使用者輸入的文字轉成安全的 HTML，避免被當成程式碼執行
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (d) => `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowIso = () => new Date().toISOString();
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
const digits = (s) => String(s || '').replace(/\D/g, '');

function formatTime(str) {
  const d = new Date(str);
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（週${week}）${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const isTime = (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v || '');
const isDate = (v) => v && !isNaN(new Date(v));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

// 下載檔案（備份 JSON、行事曆 .ics 共用）
function downloadFile(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 資料讀寫 ----------
let candidates = load();
let meta = loadMeta();

// 示範資料改版時，自動把「舊版示範資料」換成新版；只要有任何真實資料就不動
const DEMO_VERSION = 2;
upgradeDemo();

function upgradeDemo() {
  if (meta.demoVersion >= DEMO_VERSION) return;
  const OLD_DEMO = new Set(['王小明', '陳怡君', '林志豪', '黃雅婷', '周文傑', '吳建宏', '蔡佩珊',
    '劉家瑜', '鄭家豪', '許庭瑋', '何思穎', '蘇冠廷', '江雨晴', '楊子豪']);
  const onlyOldDemo = candidates.length > 0 &&
    candidates.every((c) => OLD_DEMO.has(c.name) && (!c.email || c.email === 'ming@example.com'));
  if (onlyOldDemo) {
    candidates = sampleData();
    save();
  }
  meta.demoVersion = DEMO_VERSION;
  saveMeta();
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* 讀不到就用範例資料 */ }
  return sampleData();
}

// 整理資料：補上缺少的欄位、過濾不合格的內容（讀取舊資料、匯入備份時都會用到）
function migrate(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const num = (v, min, max, def) => Math.min(max, Math.max(min, parseInt(v, 10) || def));

  return list
    .filter((c) => c && typeof c === 'object' && str(c.name, 40))
    .map((c) => {
      const stage = STAGES.includes(c.stage) ? c.stage : '投遞';
      const stageSince = isDate(c.stageSince) ? c.stageSince : nowIso();

      // 舊版只有一個面試時間 → 轉成第一輪面試紀錄
      let interviews = Array.isArray(c.interviews) ? c.interviews : [];
      if (!interviews.length && isTime(c.interviewAt)) {
        interviews = [{
          round: ROUND_TYPES.includes(stage) ? stage : '一面',
          at: c.interviewAt, duration: c.duration, interviewer: c.interviewer, location: c.location
        }];
      }
      interviews = interviews.filter((iv) => iv && typeof iv === 'object').map((iv) => ({
        id: str(iv.id, 40) || newId(),
        round: ROUND_TYPES.includes(iv.round) ? iv.round : '其他',
        at: isTime(iv.at) ? iv.at : '',
        duration: num(iv.duration, 15, 480, 60),
        interviewer: str(iv.interviewer, 40),
        location: str(iv.location, 60),
        rating: num(iv.rating, 0, 5, 0),
        feedback: str(iv.feedback, 2000)
      }));

      // 階段異動歷程（漏斗分析用）；舊資料只知道目前階段
      let history = Array.isArray(c.history)
        ? c.history.filter((h) => h && STAGES.includes(h.stage) && isDate(h.at)).map((h) => ({ stage: h.stage, at: h.at }))
        : [];
      if (!history.length) history = [{ stage, at: stageSince }];
      history.sort((a, b) => new Date(a.at) - new Date(b.at));

      return {
        id: str(c.id, 40) || newId(),
        name: str(c.name, 40),
        position: str(c.position, 40),
        email: str(c.email, 100),
        phone: str(c.phone, 30),
        stage,
        result: RESULTS.includes(c.result) ? c.result : '',
        next: str(c.next, 60),
        notes: str(c.notes, 2000),
        rating: num(c.rating, 0, 5, 0),
        createdAt: isDate(c.createdAt) ? c.createdAt : history[0].at,
        stageSince,
        history,
        interviews
      };
    });
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidates));
  } catch (e) {
    toast('無法儲存到瀏覽器，請記得匯出備份');
  }
}

function loadMeta() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { /* 用預設值 */ }
  if (!m.firstUse) m.firstUse = nowIso();
  return m;
}

function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* 忽略 */ }
}

// 示範資料（日期會依今天自動調整；人名與聯絡方式皆為虛構）
// 用固定的亂數種子產生，所以每次「還原示範資料」看到的內容都一樣
function sampleData() {
  let seed = 20261008;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

  // 平日上班時間的面試時段（遇到週末自動順延）
  const SLOTS = [[9, 30], [10, 0], [10, 30], [11, 0], [13, 30], [14, 0], [14, 30], [15, 0], [15, 30], [16, 0], [16, 30]];
  const slot = (dayOffset) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + (dayOffset >= 0 ? 1 : -1));
    const [h, m] = pick(SLOTS);
    d.setHours(h, m, 0, 0);
    return toLocalInput(d);
  };

  const POSITIONS = [
    { name: '前端工程師', first: '張經理', second: '陳技術長' },
    { name: '後端工程師', first: '張經理', second: '陳技術長' },
    { name: 'UI 設計師', first: '林總監', second: '執行長' },
    { name: '專案經理', first: '李主任', second: '營運長' },
    { name: '行銷專員', first: '王協理', second: '行銷總監' },
    { name: '資料分析師', first: '黃經理', second: '陳技術長' },
    { name: '業務代表', first: '吳經理', second: '業務副總' },
    { name: '人資專員', first: '人資主管', second: '營運長' },
    { name: '客服專員', first: '客服主管', second: '營運長' }
  ];
  const NAMES = [
    '王小明', '陳怡君', '林志豪', '黃雅婷', '周文傑', '吳建宏', '蔡佩珊', '劉家瑜', '鄭家豪', '許庭瑋',
    '何思穎', '蘇冠廷', '江雨晴', '楊子豪', '李宗翰', '張雅筑', '謝承恩', '郭品妤', '曾柏翰', '洪詩涵',
    '邱冠宇', '廖心怡', '賴俊宏', '徐子晴', '葉家銘', '高郁婷', '簡志偉', '游舒涵', '詹凱文', '施宛儒',
    '方振宇', '潘怡萱', '杜承翰', '羅佳穎', '戴宇軒', '范靜宜', '傅彥廷', '侯欣妤', '魏冠霖', '鍾雅琪'
  ];
  const LOCATIONS = ['會議室 A', '會議室 B', '總部 5F 會議室', 'Google Meet', 'Teams 視訊'];
  const GOOD = ['邏輯清楚，回答有條理', '實作經驗豐富，作品完整', '溝通順暢，主動提問', '學習動機強，態度積極',
    '對產業有自己的見解', '團隊合作經驗豐富', '技術題全部答對', '價值觀契合，推薦進下一關'];
  const SO_SO = ['經驗略少，但潛力不錯', '表達稍緊張，內容尚可', '專業不錯，薪資期望偏高', '需要再確認穩定度'];
  const BAD = ['核心技能不足', '對職務內容理解有落差', '溝通表達需要加強', '經驗與職缺需求不符'];
  const NOTES = ['作品集很有質感', '期望薪資 55K', '可配合下個月到職', '有外商工作經驗', '目前在職，需提前一個月通知',
    '朋友內推', '英文能力佳，可面對海外客戶', '曾參與大型專案', '希望可以混合辦公', '已拿到其他公司 Offer'];
  const NEXT = {
    投遞: ['通知電話篩選', '確認履歷內容', '轉給用人主管看履歷'],
    履歷篩選: ['約一面', '電話確認意願', '等用人主管回覆'],
    一面: ['面試前寄出題目', '準備面試題綱', '決定是否進二面', '整理面試評分表'],
    二面: ['安排與團隊午餐', '確認薪資期望', '主管討論錄取與否'],
    Offer: ['寄出 Offer 信', '三天後追蹤', '確認到職日', '協商薪資細節']
  };

  // 每位候選人的「目前狀態」：讓每個欄位都有人，也有足夠的結案資料做分析
  const PLAN = [
    ...Array(6).fill(['投遞']), ...Array(6).fill(['履歷篩選']), ...Array(8).fill(['一面']),
    ...Array(6).fill(['二面']), ...Array(4).fill(['Offer']),
    ...Array(4).fill(['結案', '錄取']), ...Array(4).fill(['結案', '未錄取']), ...Array(2).fill(['結案', '候選人婉拒'])
  ];

  let todayLeft = 3;   // 保證今天有幾場面試，畫面才熱鬧
  const list = PLAN.map(([stage, result], i) => {
    const pos = POSITIONS[(i * 4) % POSITIONS.length];
    const closed = stage === '結案';

    // 結案前最後走到哪一關
    let lastIdx = STAGES.indexOf(stage);
    if (closed) lastIdx = result === '錄取' ? 4 : result === '候選人婉拒' ? pick([3, 4]) : pick([1, 2, 2, 3]);
    const seq = STAGES.slice(0, lastIdx + 1);
    if (closed) seq.push('結案');

    // 由近到遠往回推每一關的進入時間（幾天前）
    const stuck = !closed && stage !== '投遞' && rnd() < 0.2;
    const times = new Array(seq.length);
    times[seq.length - 1] = closed ? int(3, 55) : stuck ? int(6, 11) : rnd() * 4;
    for (let k = seq.length - 2; k >= 0; k--) times[k] = times[k + 1] + int(2, 6) + rnd();

    // 面試紀錄
    const interviews = [];
    const addRound = (round, interviewer, idx) => {
      const isCurrent = !closed && seq[seq.length - 1] === round;
      let offset;
      if (isCurrent && !stuck && todayLeft > 0) { offset = 0; todayLeft--; }
      else if (isCurrent && !stuck && rnd() < 0.9) offset = pick([0, 0, 1, 1, 2, 2, 3, 4, 5, 7, 9, 12]); // 已排定、還沒面（多集中在近幾天）
      else offset = -Math.max(1, Math.floor(times[idx]) - int(1, 2));           // 已經面過
      const done = offset < 0;
      const failedHere = closed && result === '未錄取' && lastIdx === idx;
      interviews.push({
        round, interviewer, at: slot(offset), duration: pick([45, 60, 60, 90]), location: pick(LOCATIONS),
        rating: done ? (failedHere ? int(1, 2) : int(3, 5)) : 0,
        feedback: done ? (failedHere ? pick(BAD) : rnd() < 0.7 ? pick(GOOD) : pick(SO_SO)) : ''
      });
    };
    // 部分履歷篩選中的人先排電話篩選
    if ((stage === '履歷篩選' && rnd() < 0.7) || (stage === '投遞' && rnd() < 0.3)) {
      interviews.push({ round: '電話篩選', interviewer: '人資專員', at: slot(pick([0, 1, 2, 3, 6])), duration: 30, location: '電話', rating: 0, feedback: '' });
    }
    if (seq.includes('一面')) addRound('一面', pos.first, 2);
    if (seq.includes('二面')) addRound('二面', pos.second, 3);

    const rated = interviews.filter((r) => r.rating);
    return {
      name: NAMES[i],
      position: pos.name,
      email: `candidate${pad(i + 1)}@example.com`,
      phone: `09${int(10, 89)}-${int(100, 999)}-${int(100, 999)}`,
      stage, result: result || '',
      rating: lastIdx >= 4 && rated.length ? Math.round(rated.reduce((s, r) => s + r.rating, 0) / rated.length) : 0,
      notes: rnd() < 0.5 ? pick(NOTES) : '',
      next: closed ? (result === '錄取' ? pick(['準備設備與帳號', '安排新人訓練', '寄送報到通知']) : '') : pick(NEXT[stage]),
      history: seq.map((s, k) => ({ stage: s, at: ago(times[k]) })),
      createdAt: ago(times[0]),
      stageSince: ago(times[seq.length - 1]),
      interviews
    };
  });

  // 重複投遞的例子：之前未錄取的人，這次改投別的職缺
  const before = list.find((c) => c.result === '未錄取');
  list.push({
    name: before.name, position: '客服專員', email: before.email, phone: before.phone,
    stage: '投遞', next: '確認上次未錄取原因', notes: '曾應徵過其他職缺',
    history: [{ stage: '投遞', at: ago(0.5) }], createdAt: ago(0.5), stageSince: ago(0.5), interviews: []
  });

  return migrate(list);
}

// ---------- 面試相關判斷 ----------
const ivStart = (iv) => new Date(iv.at).getTime();
const ivEnd = (iv) => ivStart(iv) + (Number(iv.duration) || 60) * 60000;
const byTime = (a, b) => a.at.localeCompare(b.at);

// 卡片上要顯示的面試：最近一場「還沒結束」的，沒有就顯示最後一場
function cardInterview(c) {
  const list = c.interviews.filter((iv) => iv.at).sort(byTime);
  return list.find((iv) => ivEnd(iv) > Date.now()) || list[list.length - 1] || null;
}

// 找出和某一場面試時間重疊的其他面試（不含已結案的候選人）
// ownerRounds：這位候選人自己的其他輪面試（編輯中時用表單上的內容）
function findConflicts(iv, ownerId, ownerRounds) {
  if (!iv.at) return [];
  const s = ivStart(iv), e = ivEnd(iv);
  const hits = [];
  const check = (name, o) => {
    if (o.id !== iv.id && o.at && s < ivEnd(o) && ivStart(o) < e) hits.push({ name, iv: o });
  };
  for (const c of candidates) {
    if (c.id === ownerId || c.stage === '結案') continue;
    c.interviews.forEach((o) => check(c.name, o));
  }
  const self = candidates.find((c) => c.id === ownerId);
  (ownerRounds || self?.interviews || []).forEach((o) => check(self?.name || '同一人', o));
  return hits;
}

// 卡片上的「撞期」：還沒結束的面試裡有時間重疊
function hasConflict(c) {
  if (c.stage === '結案') return false;
  return c.interviews.some((iv) => iv.at && ivEnd(iv) > Date.now() && findConflicts(iv, c.id).length);
}

// 卡關：在同一階段太久，而且沒有排定未來的面試
function isStuck(c) {
  if (c.stage === '結案') return false;
  if (c.interviews.some((iv) => iv.at && ivStart(iv) > Date.now())) return false;
  return daysSince(c.stageSince) >= STUCK_DAYS;
}

// 即將面試：48 小時內（含剛開始 1 小時內）的面試
function isSoon(c) {
  if (c.stage === 'Offer' || c.stage === '結案') return false;
  const now = Date.now();
  return c.interviews.some((iv) => iv.at && ivStart(iv) >= now - 3600000 && ivStart(iv) <= now + SOON_HOURS * 3600000);
}

// ---------- 遮蔽模式 ----------
// 王小明 → 王○明；陳怡 → 陳○
function maskName(n) {
  const s = [...String(n)];
  if (s.length <= 1) return n;
  if (s.length === 2) return s[0] + '○';
  return s[0] + '○'.repeat(s.length - 2) + s[s.length - 1];
}
const dn = (c) => (meta.masked ? maskName(c.name) : c.name);

function applyMask() {
  document.body.classList.toggle('masked', !!meta.masked);
  $('#maskBtn').setAttribute('aria-pressed', meta.masked ? 'true' : 'false');
  $('#maskBtn').textContent = meta.masked ? '遮蔽中（點擊關閉）' : '遮蔽模式';
}

// ---------- 畫面狀態 ----------
let view = 'board';
let calMonth = new Date(); calMonth.setDate(1);
let editingId = null;
let currentRating = 0;
let showTables = false;   // 分析頁：以表格檢視

function filtered() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const pos = $('#positionFilter').value;
  return candidates.filter((c) => {
    if (pos && c.position !== pos) return false;
    if (!q) return true;
    const fields = [c.name, c.position, c.notes, c.next, c.email,
      ...c.interviews.flatMap((iv) => [iv.interviewer, iv.location, iv.feedback, iv.round])];
    return fields.some((v) => (v || '').toLowerCase().includes(q));
  });
}

// ---------- 主要繪製 ----------
function render() {
  applyMask();
  renderBanners();
  renderPositionOptions();
  renderStats();
  if (view === 'board') renderBoard();
  else if (view === 'calendar') renderCalendar();
  else renderAnalysis();
}

function renderStats() {
  const items = [
    ['👥', '候選人總數', candidates.length],
    ['🔍', '目前顯示', filtered().length],
    ['🔥', '進行中', candidates.filter((c) => c.stage !== '結案').length],
    ['⏰', `${SOON_HOURS} 小時內面試`, candidates.filter(isSoon).length, true],
    ['⏳', `卡關 ${STUCK_DAYS} 天以上`, candidates.filter(isStuck).length, true],
    ['🎉', '已錄取', candidates.filter((c) => c.result === '錄取').length]
  ];
  $('#stats').innerHTML = items.map(([icon, label, n, alert]) =>
    `<span class="${alert && n ? 'alert' : ''}"><i aria-hidden="true">${icon}</i>${label}<b>${n}</b></span>`
  ).join('');
}

// 頂部提醒橫幅：備份提醒、個資保存期限提醒
function renderBanners() {
  const banners = [];

  const lastBackup = meta.lastExport || meta.firstUse;
  const snoozed = meta.snoozeUntil && Date.now() < meta.snoozeUntil;
  if (candidates.length && !snoozed && daysSince(lastBackup) >= BACKUP_DAYS) {
    const msg = meta.lastExport
      ? `距離上次備份已經 ${daysSince(meta.lastExport)} 天了`
      : `你已經使用 ${daysSince(meta.firstUse)} 天，還沒備份過`;
    banners.push(`
      <div class="banner">
        <span><b>${msg}</b>。清除瀏覽器資料或換電腦時，資料會全部遺失。</span>
        <span class="banner-actions">
          <button class="btn small" data-action="export">立即匯出備份</button>
          <button class="btn ghost small" data-action="snooze">明天再提醒</button>
        </span>
      </div>`);
  }

  const old = candidates.filter((c) => c.stage === '結案' && daysSince(c.stageSince) >= RETENTION_DAYS);
  if (old.length) {
    banners.push(`
      <div class="banner privacy">
        <span>有 <b>${old.length} 位</b>候選人已結案超過 ${Math.round(RETENTION_DAYS / 30)} 個月。依個資保護原則，不再需要的資料建議刪除。</span>
        <span class="banner-actions">
          <button class="btn danger small" data-action="purge">刪除這 ${old.length} 筆</button>
        </span>
      </div>`);
  }

  $('#banners').innerHTML = banners.join('');
}

function renderPositionOptions() {
  const positions = [...new Set(candidates.map((c) => c.position).filter(Boolean))].sort();
  const sel = $('#positionFilter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全部職缺</option>' +
    positions.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  sel.value = positions.includes(keep) ? keep : '';
  $('#positionList').innerHTML = positions.map((p) => `<option value="${esc(p)}">`).join('');
}

function cardHtml(c) {
  const stuck = isStuck(c);
  const iv = cardInterview(c);
  const pills = [];
  if (isSoon(c)) pills.push('<span class="pill p-soon">即將面試</span>');
  else if (iv && ivEnd(iv) < Date.now() && c.stage !== '結案') pills.push('<span class="pill p-past">面試已過</span>');
  if (hasConflict(c)) pills.push('<span class="pill p-bad">撞期</span>');
  if (stuck) pills.push(`<span class="pill p-stuck">卡關 ${daysSince(c.stageSince)} 天</span>`);
  if (c.result) pills.push(`<span class="pill ${c.result === '錄取' ? 'p-good' : 'p-bad'}">${esc(c.result)}</span>`);
  // 評分：有綜合評分就顯示綜合，否則顯示各輪平均
  const rated = c.interviews.filter((r) => r.rating);
  if (c.rating) pills.push(`<span class="pill p-score">評分 ${c.rating}/5</span>`);
  else if (rated.length) {
    const avg = rated.reduce((s, r) => s + r.rating, 0) / rated.length;
    pills.push(`<span class="pill p-score">面試平均 ${avg.toFixed(1)}/5</span>`);
  }

  const done = c.interviews.filter((r) => r.at && ivEnd(r) < Date.now()).length;
  const metaLines = [];
  if (iv) metaLines.push(`<span class="when">${esc(iv.round)}・${formatTime(iv.at)}</span>`);
  if (iv && (iv.interviewer || iv.location)) metaLines.push(`<span>面試官：${esc(iv.interviewer || '—')}${iv.location ? '・' + esc(iv.location) : ''}</span>`);
  if (c.interviews.length > 1) metaLines.push(`<span>共 ${c.interviews.length} 輪面試，已完成 ${done} 輪</span>`);
  if (c.next) metaLines.push(`<span class="next">下一步：${esc(c.next)}</span>`);
  if (c.notes) metaLines.push(`<span class="notes pii">備註：${esc(c.notes)}</span>`);

  const options = STAGES.map((s) => `<option${s === c.stage ? ' selected' : ''}>${s}</option>`).join('');

  return `
    <article class="card ${stuck ? 'stuck' : ''}" draggable="true" data-id="${c.id}">
      <button type="button" class="name">${esc(dn(c))}</button>
      <span class="role">${esc(c.position)}</span>
      ${pills.length ? `<div class="pills">${pills.join('')}</div>` : ''}
      ${metaLines.length ? `<div class="meta">${metaLines.join('')}</div>` : ''}
      ${c.stage !== '結案' && !stuck ? `<span class="age">在此階段 ${daysSince(c.stageSince)} 天</span>` : ''}
      <div class="card-foot">
        <select data-stage aria-label="${esc(dn(c))} 更換階段">${options}</select>
        ${iv && ivEnd(iv) > Date.now() ? `<button type="button" class="btn ghost small" data-ics="${iv.id}" title="下載 .ics 加入行事曆">行事曆</button>` : ''}
      </div>
    </article>`;
}

function renderBoard() {
  const list = filtered();
  const sortKey = (c) => cardInterview(c)?.at || '9';
  $('#boardView').innerHTML = STAGES.map((stage, i) => {
    const cards = list.filter((c) => c.stage === stage).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return `
      <section class="column" data-stage="${stage}">
        <div class="col-head">
          <h3><img class="stage-icon" src="images/stage-${i + 1}.svg" alt=""><span><span class="col-num">${pad(i + 1)}</span>${stage}</span></h3>
          <small>${cards.length} 人</small>
        </div>
        ${cards.length ? cards.map(cardHtml).join('') : '<p class="empty"><img src="images/empty.svg" alt="">沒有符合的候選人</p>'}
      </section>`;
  }).join('');
}

function renderCalendar() {
  // 每一輪面試都是月曆上的一個事件
  const events = filtered().flatMap((c) => c.interviews.filter((iv) => iv.at).map((iv) => ({ c, iv })));
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $('#calTitle').textContent = `${y} 年 ${m + 1} 月`;

  // 從本月第一天所在那週的星期日開始，畫 6 週
  const start = new Date(y, m, 1);
  start.setDate(start.getDate() - start.getDay());
  const todayKey = dateKey(new Date());

  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = dateKey(d);
    const evHtml = events
      .filter(({ iv }) => iv.at.startsWith(key))
      .sort((a, b) => byTime(a.iv, b.iv))
      .map(({ c, iv }) => {
        const idx = STAGES.indexOf(c.stage);
        const conflict = c.stage !== '結案' && findConflicts(iv, c.id).length > 0;
        return `<div class="event ${conflict ? 'conflict' : ''}" data-id="${c.id}" style="--c: var(--s${idx})"
          title="${esc(dn(c))}｜${esc(c.position)}｜${esc(iv.round)}${iv.interviewer ? '｜' + esc(iv.interviewer) : ''}">${iv.at.slice(11)} ${esc(dn(c))}・${esc(iv.round)}</div>`;
      }).join('');
    html += `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${key === todayKey ? 'today' : ''}" data-date="${key}">
      <span class="day-num">${d.getDate()}</span>${evHtml}</div>`;
  }
  $('#calGrid').innerHTML = html;
}

// ---------- 分析：招募漏斗 ----------
// 某位候選人「最遠走到」哪個階段（結案不算，看結案前到哪）
function reachedIndex(c) {
  const idx = c.history.filter((h) => h.stage !== '結案').map((h) => STAGES.indexOf(h.stage));
  if (c.stage !== '結案') idx.push(STAGES.indexOf(c.stage));
  return idx.length ? Math.max(...idx) : 0;
}

// 各階段平均停留天數（從歷程計算；還在進行中的以「到今天」計）
function stageDwell(list) {
  const acc = {};
  for (const c of list) {
    c.history.forEach((h, i) => {
      if (h.stage === '結案') return;
      const nextAt = c.history[i + 1]?.at;
      const end = nextAt ? new Date(nextAt).getTime() : (c.stage !== '結案' ? Date.now() : null);
      if (end === null) return;
      const days = (end - new Date(h.at).getTime()) / DAY;
      (acc[h.stage] ||= []).push(days);
    });
  }
  return STAGES.slice(0, 5).map((stage) => {
    const arr = acc[stage] || [];
    return { stage, n: arr.length, avg: arr.length ? arr.reduce((s, d) => s + d, 0) / arr.length : null };
  });
}

function barsHtml(rows, max) {
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="b-label">${esc(r.label)}</span>
      <span class="bar-track" data-tip="${esc(r.tip)}" tabindex="0">
        <span class="bar-fill ${r.hi ? 'hi' : ''}" style="width:${max ? Math.max(0.5, (r.value / max) * 100) * 0.75 : 0}%"></span>
        <span class="bar-val">${r.valueHtml}</span>
      </span>
    </div>`).join('')}</div>`;
}

function tableHtml(head, rows) {
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr>${head.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i ? 'num' : ''}">${v}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function renderAnalysis() {
  const pos = $('#positionFilter').value;
  const list = candidates.filter((c) => !pos || c.position === pos);
  const scope = pos ? `「${esc(pos)}」職缺` : '全部職缺';

  if (!list.length) {
    $('#analysisView').innerHTML = `<p class="note-line">${scope}目前沒有資料可以分析。</p>`;
    return;
  }

  // 漏斗：投遞 → … → Offer → 錄取
  const steps = STAGES.slice(0, 5).map((label, i) => ({ label, n: list.filter((c) => reachedIndex(c) >= i).length }));
  steps.push({ label: '錄取', n: list.filter((c) => c.result === '錄取').length });
  const funnelRows = steps.map((s, i) => {
    const prev = i ? steps[i - 1].n : null;
    const conv = prev ? Math.round((s.n / prev) * 100) : null;
    const ofAll = Math.round((s.n / steps[0].n) * 100);
    return {
      label: s.label, value: s.n,
      valueHtml: `<b>${s.n}</b>人${conv !== null ? `・上一關 ${conv}%` : ''}`,
      tip: `${s.label}：${s.n} 人\n佔全部投遞 ${ofAll}%${conv !== null ? `\n上一關通過率 ${conv}%` : ''}`,
      conv, ofAll
    };
  });

  // 關鍵數字
  const closed = list.filter((c) => c.stage === '結案');
  const hired = list.filter((c) => c.result === '錄取');
  const hireDays = hired
    .map((c) => {
      const end = [...c.history].reverse().find((h) => h.stage === '結案');
      return end ? (new Date(end.at) - new Date(c.createdAt)) / DAY : null;
    })
    .filter((d) => d !== null);
  const avgHire = hireDays.length ? Math.round(hireDays.reduce((s, d) => s + d, 0) / hireDays.length) : null;
  const dwell = stageDwell(list);
  const slowest = dwell.filter((d) => d.avg !== null).sort((a, b) => b.avg - a.avg)[0];
  const ratedRounds = list.flatMap((c) => c.interviews).filter((iv) => iv.rating);

  const kpis = [
    ['平均招募天數', avgHire !== null ? `${avgHire} 天` : '—', hireDays.length ? `投遞到錄取，共 ${hireDays.length} 位` : '還沒有錄取紀錄'],
    ['錄取率', closed.length ? `${Math.round((hired.length / closed.length) * 100)}%` : '—', `已結案 ${closed.length} 位中錄取 ${hired.length} 位`],
    ['停留最久的階段', slowest ? slowest.stage : '—', slowest ? `平均 ${slowest.avg.toFixed(1)} 天` : '資料不足'],
    ['面試平均評分', ratedRounds.length ? (ratedRounds.reduce((s, iv) => s + iv.rating, 0) / ratedRounds.length).toFixed(1) : '—', `共 ${ratedRounds.length} 輪有評分`]
  ];

  const maxDwell = Math.max(...dwell.map((d) => d.avg || 0));
  const dwellRows = dwell.map((d) => ({
    label: d.stage,
    value: d.avg || 0,
    hi: slowest && d.stage === slowest.stage,
    valueHtml: d.avg !== null ? `<b>${d.avg.toFixed(1)}</b>天` : '無資料',
    tip: d.avg !== null ? `${d.stage}：平均停留 ${d.avg.toFixed(1)} 天\n共 ${d.n} 人次` : `${d.stage}：還沒有資料`
  }));

  const migratedOnly = list.filter((c) => c.history.length === 1 && c.stage === '結案').length;

  $('#analysisView').innerHTML = `
    <p class="note-line">分析範圍：${scope}，共 ${list.length} 位候選人。可用上方「職缺」選單切換。${migratedOnly ? `其中 ${migratedOnly} 位是舊資料，只記得目前階段，漏斗數字可能偏低。` : ''}</p>

    <div class="kpis">${kpis.map(([label, value, sub]) => `
      <div class="kpi"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`).join('')}
    </div>

    <button type="button" class="link-btn table-toggle" id="tableToggle">${showTables ? '改用圖表檢視' : '改用表格檢視'}</button>

    <section>
      <h3>招募漏斗</h3>
      <p class="desc">每個階段有多少人「曾經走到」這裡。滑鼠移到長條上可看詳細比例。</p>
      ${showTables
        ? tableHtml(['階段', '人數', '佔全部投遞', '上一關通過率'], funnelRows.map((r) => [r.label, r.value, `${r.ofAll}%`, r.conv !== null ? `${r.conv}%` : '—']))
        : barsHtml(funnelRows, steps[0].n)}
    </section>

    <section>
      <h3>各階段平均停留天數</h3>
      <p class="desc">候選人在每個階段平均等了多久；最久的階段以酒紅色標示，通常是流程卡住的地方。</p>
      ${showTables
        ? tableHtml(['階段', '平均天數', '人次'], dwell.map((d) => [d.stage, d.avg !== null ? d.avg.toFixed(1) : '—', d.n]))
        : barsHtml(dwellRows, maxDwell)}
    </section>`;
}

// 滑鼠提示（分析圖表用）
const tip = $('#tip');
function showTip(el, x, y) {
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
}
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left, r.bottom); }
});
document.addEventListener('focusout', () => { tip.hidden = true; });

$('#analysisView').addEventListener('click', (e) => {
  if (e.target.id === 'tableToggle') { showTables = !showTables; renderAnalysis(); }
});

// ---------- 行事曆檔 (.ics) ----------
// 可以匯入 Google 日曆、Outlook、Apple 行事曆，面試前 30 分鐘會提醒
function icsEsc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function downloadIcs(c, iv) {
  if (!iv || !iv.at) return toast('請先填寫面試時間');
  const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const start = new Date(iv.at);
  const end = new Date(ivEnd(iv));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // 備註與評語可能含評價，不放進行事曆，以免行事曆共用時外流
  const desc = [
    `候選人：${c.name}`,
    `應徵職缺：${c.position}`,
    `面試輪次：${iv.round}`,
    iv.interviewer && `面試官：${iv.interviewer}`,
    c.email && `Email：${c.email}`,
    c.phone && `電話：${c.phone}`
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Interview Board//ZH-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${c.id}-${iv.id}@interview-board`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${icsEsc(`【${iv.round}】${c.name}｜${c.position}`)}`,
    iv.location && `LOCATION:${icsEsc(iv.location)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:面試即將開始', 'TRIGGER:-PT30M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);

  downloadFile(lines.join('\r\n'), `面試-${c.name}-${iv.round}-${iv.at.slice(0, 10)}.ics`, 'text/calendar;charset=utf-8');
  toast('已下載行事曆檔，打開它就能加入行事曆');
}

// ---------- 彈出視窗（新增／編輯） ----------
const form = $('#form');
const modal = $('#modal');

$('#stageSelect').innerHTML = STAGES.map((s) => `<option>${s}</option>`).join('');

function renderStars() {
  $('#starInput').innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" data-star="${n}" class="${n <= currentRating ? 'on' : ''}" aria-label="${n} 分">★</button>`
  ).join('');
}

// --- 多輪面試 ---
function newRound(existing, at = '') {
  const used = existing.map((r) => r.round);
  const round = ['一面', '二面', '三面', '主管面談'].find((r) => !used.includes(r)) || '其他';
  return { id: newId(), round, at, duration: 60, interviewer: '', location: '', rating: 0, feedback: '' };
}

function roundHtml(r) {
  const opt = (list, v) => list.map((x) => `<option${x === v ? ' selected' : ''}>${x}</option>`).join('');
  const ratingOpts = ['尚未評分', '1 分', '2 分', '3 分', '4 分', '5 分']
    .map((t, i) => `<option value="${i}"${i === r.rating ? ' selected' : ''}>${t}</option>`).join('');
  return `
    <fieldset class="round" data-rid="${esc(r.id)}">
      <legend><select class="r-round" aria-label="面試輪次">${opt(ROUND_TYPES, r.round)}</select></legend>
      <div class="form-grid">
        <label>面試時間<input type="datetime-local" class="r-at" value="${esc(r.at)}"></label>
        <label>時長（分鐘）<input type="number" class="r-duration" min="15" max="480" step="15" value="${r.duration}"></label>
        <label>面試官<input class="r-interviewer" maxlength="40" value="${esc(r.interviewer)}"></label>
        <label>地點／方式<input class="r-location" maxlength="60" value="${esc(r.location)}" placeholder="例：會議室 A、Google Meet"></label>
        <label>這輪評分<select class="r-rating">${ratingOpts}</select></label>
      </div>
      <label>這輪評語<textarea class="r-feedback pii" rows="2" placeholder="面試官對這一輪的評價">${esc(r.feedback)}</textarea></label>
      <p class="warn r-conflict" hidden></p>
      <div class="round-actions">
        <button type="button" class="btn ghost small" data-r="ics">加入行事曆</button>
        <span class="spacer"></span>
        <button type="button" class="link-btn" data-r="remove">移除這一輪</button>
      </div>
    </fieldset>`;
}

function renderRounds(list) {
  $('#roundsList').innerHTML = list.length
    ? list.map(roundHtml).join('')
    : '<p class="empty-rounds">還沒有排任何面試。</p>';
}

function readRounds() {
  return [...document.querySelectorAll('#roundsList .round')].map((fs) => ({
    id: fs.dataset.rid,
    round: fs.querySelector('.r-round').value,
    at: fs.querySelector('.r-at').value,
    duration: Number(fs.querySelector('.r-duration').value) || 60,
    interviewer: fs.querySelector('.r-interviewer').value.trim(),
    location: fs.querySelector('.r-location').value.trim(),
    rating: Number(fs.querySelector('.r-rating').value) || 0,
    feedback: fs.querySelector('.r-feedback').value.trim()
  }));
}

function checkRoundConflicts() {
  const rounds = readRounds();
  document.querySelectorAll('#roundsList .round').forEach((fs, i) => {
    const hits = findConflicts(rounds[i], editingId, rounds);
    const el = fs.querySelector('.r-conflict');
    el.hidden = !hits.length;
    el.textContent = hits.length
      ? `時間重疊：${hits.map((h) => `${meta.masked ? maskName(h.name) : h.name} 的${h.iv.round}（${formatTime(h.iv.at)}）`).join('、')}`
      : '';
  });
}

// --- 重複投遞提醒 ---
function findDuplicates(d) {
  const email = d.email.toLowerCase();
  const phone = digits(d.phone);
  return candidates
    .filter((o) => o.id !== editingId)
    .map((o) => {
      const why = [];
      if (email && o.email.toLowerCase() === email) why.push('Email 相同');
      if (phone.length >= 8 && digits(o.phone) === phone) why.push('電話相同');
      if (d.name && o.name === d.name) why.push('同名');
      return { o, why };
    })
    .filter((x) => x.why.length);
}

function checkDuplicates() {
  const dups = findDuplicates(readForm());
  const el = $('#dupWarn');
  el.hidden = !dups.length;
  el.innerHTML = dups.length
    ? `可能是同一人，請確認：<br>${dups.map(({ o, why }) =>
        `・${esc(dn(o))}（${why.join('、')}）— ${esc(o.position)}，${o.stage === '結案' ? `已結案${o.result ? '：' + esc(o.result) : ''}` : `目前在「${o.stage}」`}，${formatDate(o.createdAt)} 投遞`
      ).join('<br>')}`
    : '';
}

function openModal(id, presetDate) {
  editingId = id || null;
  form.reset();
  const c = candidates.find((x) => x.id === id);
  $('#modalEyebrow').textContent = c ? 'EDIT CANDIDATE' : 'NEW CANDIDATE';
  $('#modalTitle').textContent = c ? dn(c) : '新增候選人';
  $('#deleteBtn').hidden = !c;

  let rounds = [];
  if (c) {
    for (const key of ['name', 'position', 'email', 'phone', 'stage', 'result', 'next', 'notes']) {
      form.elements[key].value = c[key] ?? '';
    }
    currentRating = c.rating || 0;
    rounds = c.interviews.map((r) => ({ ...r })).sort((a, b) => (a.at || '9').localeCompare(b.at || '9'));
  } else {
    form.elements.stage.value = presetDate ? '一面' : '投遞';
    currentRating = 0;
  }
  if (presetDate) rounds.push(newRound(rounds, `${presetDate}T10:00`));

  renderRounds(rounds);
  renderStars();
  checkRoundConflicts();
  checkDuplicates();
  modal.showModal();
  if (!c) form.elements.name.focus();
}

function readForm() {
  const f = form.elements;
  return {
    id: editingId || newId(),
    name: f.name.value.trim(),
    position: f.position.value.trim(),
    email: f.email.value.trim(),
    phone: f.phone.value.trim(),
    stage: f.stage.value,
    result: f.result.value,
    next: f.next.value.trim(),
    notes: f.notes.value.trim(),
    rating: currentRating,
    // 完全空白的輪次不存
    interviews: readRounds().filter((r) => r.at || r.interviewer || r.location || r.feedback || r.rating)
  };
}

form.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest('#roundsList')) checkRoundConflicts();
  if (['name', 'email', 'phone'].includes(t.name)) checkDuplicates();
  // 選了結案結果，就自動把階段移到「結案」
  if (t.name === 'result' && t.value) form.elements.stage.value = '結案';
});

$('#addRound').addEventListener('click', () => {
  const rounds = readRounds();
  rounds.push(newRound(rounds));
  renderRounds(rounds);
  checkRoundConflicts();
  const all = document.querySelectorAll('#roundsList .r-at');
  all[all.length - 1].focus();
});

$('#roundsList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-r]');
  if (!btn) return;
  const fs = btn.closest('.round');
  if (btn.dataset.r === 'remove') {
    const left = readRounds().filter((r) => r.id !== fs.dataset.rid);
    renderRounds(left);
    checkRoundConflicts();
  }
  if (btn.dataset.r === 'ics') {
    const data = readForm();
    downloadIcs(data, readRounds().find((r) => r.id === fs.dataset.rid));
  }
});

$('#starInput').addEventListener('click', (e) => {
  const n = Number(e.target.dataset.star);
  if (!n) return;
  currentRating = n;
  renderStars();
});
$('#clearRating').addEventListener('click', () => { currentRating = 0; renderStars(); });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = readForm();
  const idx = candidates.findIndex((c) => c.id === data.id);
  const old = candidates[idx];
  data.createdAt = old?.createdAt || nowIso();
  data.history = old ? [...old.history] : [];
  // 階段沒變就保留原本的進入時間，變了就記一筆歷程
  if (!old || old.stage !== data.stage) {
    data.stageSince = nowIso();
    data.history.push({ stage: data.stage, at: data.stageSince });
  } else {
    data.stageSince = old.stageSince;
  }
  if (idx >= 0) candidates[idx] = data; else candidates.push(data);
  save();
  modal.close();
  render();
  toast(`已儲存 ${dn(data)}`);
});

$('#cancelBtn').addEventListener('click', () => modal.close());

$('#deleteBtn').addEventListener('click', () => {
  const c = candidates.find((x) => x.id === editingId);
  if (!c || !confirm(`確定要刪除「${dn(c)}」嗎？此動作無法復原。`)) return;
  candidates = candidates.filter((x) => x.id !== editingId);
  save();
  modal.close();
  render();
  toast(`已刪除 ${dn(c)}`);
});

// ---------- 看板互動：點擊、下拉選單、拖拉 ----------
function setStage(id, stage) {
  const c = candidates.find((x) => x.id === id);
  if (!c || c.stage === stage) return;
  c.stage = stage;
  c.stageSince = nowIso();
  c.history.push({ stage, at: c.stageSince });
  if (stage !== '結案') c.result = '';
  save();
  render();
  toast(`${dn(c)} → ${stage}`);
}

const board = $('#boardView');

board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.target.closest('select')) return;
  const c = candidates.find((x) => x.id === card.dataset.id);
  const icsBtn = e.target.closest('[data-ics]');
  if (icsBtn) downloadIcs(c, c.interviews.find((iv) => iv.id === icsBtn.dataset.ics));
  else openModal(c.id);
});

board.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-stage]');
  if (sel) setStage(sel.closest('.card').dataset.id, sel.value);
});

board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
board.addEventListener('dragend', (e) => e.target.closest('.card')?.classList.remove('dragging'));
board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  board.querySelectorAll('.drag-over').forEach((c) => c !== col && c.classList.remove('drag-over'));
  col.classList.add('drag-over');
});
board.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});
board.addEventListener('drop', (e) => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drag-over');
  setStage(e.dataTransfer.getData('text/plain'), col.dataset.stage);
});

// ---------- 月曆互動 ----------
$('#calGrid').addEventListener('click', (e) => {
  const ev = e.target.closest('.event');
  if (ev) return openModal(ev.dataset.id);
  const day = e.target.closest('.day');
  if (day) openModal(null, day.dataset.date);
});
$('#prevMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#nextMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

// ---------- 切換檢視、搜尋、篩選、遮蔽 ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    view = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#boardView').hidden = view !== 'board';
    $('#calendarView').hidden = view !== 'calendar';
    $('#analysisView').hidden = view !== 'analysis';
    render();
  });
});
$('#searchInput').addEventListener('input', render);
$('#positionFilter').addEventListener('change', render);
$('#addBtn').addEventListener('click', () => openModal());

$('#maskBtn').addEventListener('click', () => {
  meta.masked = !meta.masked;
  saveMeta();
  render();
  toast(meta.masked ? '已開啟遮蔽模式：姓名與聯絡資料已隱藏' : '已關閉遮蔽模式');
});

// ---------- 匯出／匯入／還原 ----------
function exportBackup() {
  downloadFile(JSON.stringify(candidates, null, 2), `面試看板備份-${dateKey(new Date())}.json`, 'application/json');
  meta.lastExport = nowIso();
  delete meta.snoozeUntil;
  saveMeta();
  render();
  toast('已下載備份檔，請存放在安全的地方，不要上傳到公開網站');
}

$('#exportBtn').addEventListener('click', exportBackup);

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch (err) {
    return alert('匯入失敗：無法讀取這個檔案，請確認是從本看板匯出的 JSON。');
  }
  const data = migrate(raw);
  if (!data.length) return alert('匯入失敗：檔案裡沒有有效的候選人資料。');
  const skipped = Array.isArray(raw) ? raw.length - data.length : 0;
  if (!confirm(`要用備份檔的 ${data.length} 筆資料取代目前的 ${candidates.length} 筆嗎？${skipped ? `\n（有 ${skipped} 筆格式不正確，會略過）` : ''}`)) return;
  candidates = data;
  save();
  render();
  toast(`已匯入 ${data.length} 位候選人`);
});

$('#resetBtn').addEventListener('click', () => {
  if (candidates.length && !confirm(`還原示範資料會取代目前的 ${candidates.length} 筆資料，無法復原。\n建議先「匯出 JSON」備份。確定要還原嗎？`)) return;
  candidates = sampleData();
  save();
  render();
  toast('已還原示範資料');
});

// 提醒橫幅上的按鈕
$('#banners').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'export') exportBackup();
  if (action === 'snooze') {
    meta.snoozeUntil = Date.now() + DAY;
    saveMeta();
    render();
  }
  if (action === 'purge') {
    const old = candidates.filter((c) => c.stage === '結案' && daysSince(c.stageSince) >= RETENTION_DAYS);
    if (!confirm(`確定要永久刪除這 ${old.length} 位已結案候選人的資料嗎？\n${old.map(dn).join('、')}`)) return;
    candidates = candidates.filter((c) => !old.includes(c));
    save();
    render();
    toast(`已刪除 ${old.length} 筆過期資料`);
  }
});

// 清除所有資料（招募結束、或要交接電腦時使用）
$('#clearAllBtn').addEventListener('click', () => {
  if (!candidates.length) return toast('目前沒有任何資料');
  const answer = prompt(`這會永久刪除全部 ${candidates.length} 位候選人的資料，無法復原。\n建議先「匯出 JSON」備份。\n\n確定要刪除，請輸入「刪除」兩個字：`);
  if (answer === null) return;
  if (answer.trim() !== '刪除') return toast('輸入不正確，已取消');
  candidates = [];
  save();
  render();
  toast('已清除所有資料');
});

// ---------- 啟動 ----------
save();
saveMeta();
render();
