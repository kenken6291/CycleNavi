/**
 * ============================================================
 *  CycleNavi（仮）バックエンド  Code.gs
 *  GitHub Pages(フロント) ⇔ GAS Web API ⇔ スプレッドシート / Drive / Gemini / OpenRouteService
 * ============================================================
 *  スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *    GEMINI_API_KEY : Gemini APIキー（必須）
 *    ORS_API_KEY    : OpenRouteService APIキー（必須）
 *    GEMINI_MODEL   : 使用モデル名（任意・既定 gemini-flash-latest）
 *    APP_URL        : GitHub PagesのURL（任意・仮パスワードメールに記載）
 *    PEPPER / SPREADSHEET_ID / ROOT_FOLDER_ID / FOLDER_*  … setup() が自動設定
 *
 *  ・初回だけエディタで setup() を実行してください（シート・フォルダを自動作成）
 *  ・コードを変更したら「デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン → デプロイ」
 *    を必ず行ってください（新バージョンにしないと変更が反映されません）
 * ============================================================
 */

const APP_NAME = 'CycleNavi';
const SESSION_DAYS = 30;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const SPOT_CATS = ['camp', 'michinoeki', 'onsen', 'supply', 'view', 'other'];
const ORS_PROFILES = ['cycling-regular', 'cycling-road', 'cycling-mountain', 'cycling-electric'];

const SHEETS = {
  Users: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'status', 'mustChange', 'failCount', 'lockedUntil', 'createdAt', 'lastLoginAt'],
  Sessions: ['token', 'userId', 'expiresAt', 'createdAt'],
  Routes: ['routeId', 'userId', 'nickname', 'title', 'description', 'visibility', 'profile', 'condition', 'source',
    'distanceKm', 'ascentM', 'descentM', 'maxEleM', 'startLat', 'startLng', 'dataFileId', 'gpxFileId', 'thumbFileId',
    'likeCount', 'commentCount', 'createdAt', 'updatedAt'],
  Comments: ['commentId', 'routeId', 'userId', 'nickname', 'body', 'createdAt', 'updatedAt'],
  Likes: ['likeId', 'routeId', 'userId', 'createdAt'],
  Spots: ['spotId', 'userId', 'nickname', 'category', 'name', 'note', 'lat', 'lng', 'photoFileId', 'source', 'visibility', 'createdAt']
};

/* ------------------------------------------------------------
 *  エンドポイント
 * ------------------------------------------------------------ */
const PUBLIC_ACTIONS = {
  ping: function () { return { ok: true, app: APP_NAME, time: now_() }; },
  register: register_,
  login: login_,
  resetPassword: resetPassword_
};

const PRIVATE_ACTIONS = {
  me: function (req, u) { return { ok: true, user: publicUser_(u) }; },
  logout: logout_,
  changePassword: changePassword_,
  route: route_,
  elevation: elevation_,
  saveRoute: saveRoute_,
  deleteRoute: deleteRoute_,
  listMyRoutes: listMyRoutes_,
  listPublicRoutes: listPublicRoutes_,
  getRoute: getRoute_,
  toggleLike: toggleLike_,
  listComments: function (req, u) { return { ok: true, comments: listComments_(req.routeId, u) }; },
  addComment: addComment_,
  editComment: editComment_,
  deleteComment: deleteComment_,
  uploadPhoto: uploadPhoto_,
  analyzePhoto: analyzePhoto_,
  routeAdvice: routeAdvice_,
  addSpot: addSpot_,
  listSpots: listSpots_,
  deleteSpot: deleteSpot_
};

// パスワード変更前（仮パスワード状態）でも使える操作
const ALLOW_BEFORE_CHANGE = ['me', 'logout', 'changePassword'];

function doGet(e) {
  return json_({ ok: true, app: APP_NAME, message: 'CycleNavi API is running', time: now_() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  const action = String(req.action || '');
  try {
    if (PUBLIC_ACTIONS[action]) return json_(PUBLIC_ACTIONS[action](req));
    const fn = PRIVATE_ACTIONS[action];
    if (!fn) return json_({ ok: false, error: '不明な操作です: ' + action });
    const user = auth_(req.token);
    if (!user) return json_({ ok: false, code: 'AUTH', error: 'ログインが必要です。もう一度ログインしてください' });
    if (toBool_(user.mustChange) && ALLOW_BEFORE_CHANGE.indexOf(action) < 0) {
      return json_({ ok: false, code: 'MUST_CHANGE', error: '本パスワードの設定が必要です' });
    }
    return json_(fn(req, user));
  } catch (err) {
    console.error(action, err && err.stack ? err.stack : err);
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------
 *  初期セットアップ（エディタから1回実行）
 * ------------------------------------------------------------ */
function setup() {
  const p = props_();
  if (!p.getProperty('SPREADSHEET_ID')) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('スプレッドシートの「拡張機能 → Apps Script」から作成したプロジェクトで実行してください');
    p.setProperty('SPREADSHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (n) { sh_(n); });
  const ss = getSS_();
  ['シート1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
  ['photos', 'gpx', 'routes'].forEach(function (k) { folder_(k); });
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  const missing = ['GEMINI_API_KEY', 'ORS_API_KEY'].filter(function (k) { return !p.getProperty(k); });
  Logger.log('セットアップ完了。Driveフォルダ: https://drive.google.com/drive/folders/' + p.getProperty('ROOT_FOLDER_ID'));
  if (missing.length) Logger.log('未設定のスクリプトプロパティ: ' + missing.join(', '));
  // 権限承認のために一度だけ呼び出す（メール・外部通信）
  Logger.log('メール送信残数: ' + MailApp.getRemainingDailyQuota());
  UrlFetchApp.fetch('https://api.openrouteservice.org/', { muteHttpExceptions: true });
}

/* ------------------------------------------------------------
 *  スプレッドシート共通
 * ------------------------------------------------------------ */
function props_() { return PropertiesService.getScriptProperties(); }

function getSS_() {
  const id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sh_(name) {
  const ss = getSS_();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function readAll_(name) {
  const s = sh_(name);
  const last = s.getLastRow();
  if (last < 2) return [];
  const h = SHEETS[name];
  const v = s.getRange(2, 1, last - 1, h.length).getValues();
  return v.map(function (r, i) {
    const o = { _row: i + 2 };
    h.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  });
}

function safeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function append_(name, obj) {
  sh_(name).appendRow(SHEETS[name].map(function (k) { return obj[k] === undefined ? '' : safeCell_(obj[k]); }));
}

function update_(name, row, obj) {
  const s = sh_(name);
  const h = SHEETS[name];
  const cur = s.getRange(row, 1, 1, h.length).getValues()[0];
  h.forEach(function (k, j) { if (obj[k] !== undefined) cur[j] = safeCell_(obj[k]); });
  s.getRange(row, 1, 1, h.length).setValues([cur]);
}

function deleteRows_(name, rows) {
  const s = sh_(name);
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { s.deleteRow(r); });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------
 *  ユーティリティ
 * ------------------------------------------------------------ */
function now_() { return new Date().toISOString(); }
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function id_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12) + Date.now().toString(36); }
function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function num_(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function round_(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }
function clip_(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function normEmail_(v) { return String(v || '').trim().toLowerCase(); }
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function safeName_(v) { return String(v || 'file').replace(/[\\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
function thumbUrl_(id, sz) { return id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w' + (sz || 400) : ''; }

function hash_(pw, salt) {
  const pepper = props_().getProperty('PEPPER') || '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw + ':' + pepper, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function randomPw_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  do {
    pw = '';
    for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (!/\d/.test(pw) || !/[A-Za-z]/.test(pw));
  return pw;
}

function validatePw_(pw) {
  if (pw.length < 8) throw new Error('パスワードは8文字以上にしてください');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new Error('パスワードは英字と数字を両方含めてください');
}

function distM_(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ------------------------------------------------------------
 *  Drive
 * ------------------------------------------------------------ */
function folder_(key) {
  const p = props_();
  let root = null;
  const rootId = p.getProperty('ROOT_FOLDER_ID');
  if (rootId) { try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; } }
  if (!root) {
    root = DriveApp.createFolder('CycleNavi_Data');
    p.setProperty('ROOT_FOLDER_ID', root.getId());
  }
  const propKey = 'FOLDER_' + key.toUpperCase();
  const id = p.getProperty(propKey);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 再作成 */ } }
  const it = root.getFoldersByName(key);
  const f = it.hasNext() ? it.next() : root.createFolder(key);
  p.setProperty(propKey, f.getId());
  return f;
}

function upsertTextFile_(folderKey, fileId, name, content, mime) {
  if (fileId) {
    try {
      const f = DriveApp.getFileById(fileId);
      f.setContent(content);
      f.setName(name);
      return f.getId();
    } catch (e) { /* 見つからなければ新規作成 */ }
  }
  const blob = Utilities.newBlob(content, mime, name);
  return folder_(folderKey).createFile(blob).getId();
}

function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 無視 */ }
}

/* ------------------------------------------------------------
 *  認証・会員管理
 * ------------------------------------------------------------ */
function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: u.nickname, mustChange: toBool_(u.mustChange) };
}

function createSession_(userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000);
  append_('Sessions', { token: token, userId: userId, expiresAt: exp.toISOString(), createdAt: now_() });
  CacheService.getScriptCache().put('s_' + token, userId, 21600);
  return token;
}

function auth_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  let userId = cache.get('s_' + token);
  if (!userId) {
    const s = readAll_('Sessions').find(function (r) { return r.token === token; });
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      deleteRows_('Sessions', [s._row]);
      return null;
    }
    userId = s.userId;
    cache.put('s_' + token, userId, 21600);
  }
  const u = readAll_('Users').find(function (r) { return r.userId === userId; });
  if (!u || u.status === '停止') return null;
  return u;
}

function cleanupSessions_() {
  const nowMs = Date.now();
  const rows = readAll_('Sessions').filter(function (s) { return new Date(s.expiresAt).getTime() < nowMs; }).map(function (s) { return s._row; });
  if (rows.length) deleteRows_('Sessions', rows);
}

function sendTempMail_(email, nickname, temp, kind) {
  const url = props_().getProperty('APP_URL') || '';
  const subject = '【' + APP_NAME + '】' + (kind === 'reset' ? '仮パスワード再発行のお知らせ' : '仮登録のお知らせ');
  const lines = [
    nickname + ' さん',
    '',
    kind === 'reset' ? 'パスワードの再発行を受け付けました。' : APP_NAME + ' への登録を受け付けました。',
    '次の仮パスワードでログインし、表示される画面で本パスワードを設定してください。',
    '',
    '仮パスワード： ' + temp,
    ''
  ];
  if (url) lines.push('ログインページ： ' + url, '');
  lines.push('※このメールに心当たりがない場合は、破棄してください。');
  GmailApp.sendEmail(email, subject, lines.join('\n'), { name: APP_NAME });
}

function register_(req) {
  const email = normEmail_(req.email);
  const nickname = clip_(req.nickname, 20);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  if (!nickname) throw new Error('ニックネームを入力してください');
  return withLock_(function () {
    const users = readAll_('Users');
    const ex = users.find(function (u) { return u.email === email; });
    if (ex && ex.status !== '仮登録') {
      throw new Error('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワード再発行」から手続きしてください');
    }
    if (users.some(function (u) { return u.nickname === nickname && u.email !== email; })) {
      throw new Error('このニックネームはすでに使われています');
    }
    const temp = randomPw_();
    const salt = Utilities.getUuid();
    if (ex) {
      update_('Users', ex._row, { nickname: nickname, passwordHash: hash_(temp, salt), salt: salt, mustChange: true, failCount: 0, lockedUntil: '' });
    } else {
      append_('Users', {
        userId: 'U' + id_(), email: email, nickname: nickname, passwordHash: hash_(temp, salt), salt: salt,
        status: '仮登録', mustChange: true, failCount: 0, lockedUntil: '', createdAt: now_(), lastLoginAt: ''
      });
    }
    sendTempMail_(email, nickname, temp, 'register');
    return { ok: true, message: '仮パスワードを ' + email + ' に送りました。メールを確認してログインしてください' };
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const NG = 'メールアドレスまたはパスワードが違います';
  const u = readAll_('Users').find(function (x) { return x.email === email; });
  if (!u) throw new Error(NG);
  if (u.status === '停止') throw new Error('このアカウントは利用停止中です');
  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
    throw new Error('ログインの失敗が続いたため、一時的にロックしています。' + LOCK_MINUTES + '分ほど待ってからお試しください');
  }
  if (hash_(pw, u.salt) !== u.passwordHash) {
    const fc = Number(u.failCount || 0) + 1;
    if (fc >= MAX_FAIL) {
      update_('Users', u._row, { failCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() });
      throw new Error('パスワードを' + MAX_FAIL + '回間違えたため、' + LOCK_MINUTES + '分間ロックしました');
    }
    update_('Users', u._row, { failCount: fc });
    throw new Error(NG + '（あと' + (MAX_FAIL - fc) + '回でロック）');
  }
  update_('Users', u._row, { failCount: 0, lockedUntil: '', lastLoginAt: now_() });
  try { cleanupSessions_(); } catch (e) { /* 無視 */ }
  const token = createSession_(u.userId);
  return { ok: true, token: token, user: publicUser_(u) };
}

function logout_(req, u) {
  const token = String(req.token || '');
  CacheService.getScriptCache().remove('s_' + token);
  const s = readAll_('Sessions').find(function (r) { return r.token === token; });
  if (s) deleteRows_('Sessions', [s._row]);
  return { ok: true };
}

function changePassword_(req, u) {
  const cur = String(req.currentPassword || '');
  const nw = String(req.newPassword || '');
  if (hash_(cur, u.salt) !== u.passwordHash) throw new Error('現在のパスワード（仮パスワード）が違います');
  validatePw_(nw);
  if (nw === cur) throw new Error('新しいパスワードは現在のものと別にしてください');
  const salt = Utilities.getUuid();
  update_('Users', u._row, {
    passwordHash: hash_(nw, salt), salt: salt, mustChange: false,
    status: u.status === '仮登録' ? '本登録' : u.status
  });
  const pu = publicUser_(u);
  pu.mustChange = false;
  return { ok: true, message: 'パスワードを変更しました', user: pu };
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  if (!isEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  withLock_(function () {
    const u = readAll_('Users').find(function (x) { return x.email === email; });
    if (u && u.status !== '停止') {
      const temp = randomPw_();
      const salt = Utilities.getUuid();
      update_('Users', u._row, { passwordHash: hash_(temp, salt), salt: salt, mustChange: true, failCount: 0, lockedUntil: '' });
      sendTempMail_(email, u.nickname, temp, 'reset');
    }
  });
  return { ok: true, message: '登録済みのメールアドレスであれば、仮パスワードを送りました' };
}

/* ------------------------------------------------------------
 *  ルーティング（OpenRouteService 中継）
 * ------------------------------------------------------------ */
function route_(req, u) {
  const key = props_().getProperty('ORS_API_KEY');
  if (!key) throw new Error('ORS_API_KEY が未設定です（スクリプトプロパティ）');
  const coords = (req.coordinates || [])
    .map(function (c) { return [Number(c[0]), Number(c[1])]; })
    .filter(function (c) { return isFinite(c[0]) && isFinite(c[1]); });
  if (coords.length < 2) throw new Error('出発地と目的地を指定してください');
  if (coords.length > 50) throw new Error('地点は50か所までです');
  const profile = ORS_PROFILES.indexOf(req.profile) >= 0 ? req.profile : 'cycling-regular';
  const cond = ['flat', 'quiet', 'shortest'].indexOf(req.condition) >= 0 ? req.condition : 'flat';

  const base = {
    coordinates: coords, elevation: true, instructions: false,
    extra_info: ['waytype', 'steepness'], units: 'm',
    preference: cond === 'shortest' ? 'shortest' : 'recommended'
  };
  const withOpts = JSON.parse(JSON.stringify(base));
  if (cond === 'flat') withOpts.options = { profile_params: { weightings: { steepness_difficulty: 0 } } };

  // 候補比較（代替ルートは「出発地と目的地のみ」かつ約100km以内で利用可能）
  const attempts = [];
  if (coords.length === 2 && cond !== 'shortest') {
    const alt = JSON.parse(JSON.stringify(withOpts));
    alt.alternative_routes = { target_count: 3, weight_factor: 1.6, share_factor: 0.6 };
    attempts.push(alt);
  }
  attempts.push(withOpts);
  if (withOpts.options) attempts.push(base);

  let data = null, lastErr = '';
  for (let i = 0; i < attempts.length; i++) {
    const res = UrlFetchApp.fetch('https://api.openrouteservice.org/v2/directions/' + profile + '/geojson', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: key, Accept: 'application/geo+json, application/json' },
      payload: JSON.stringify(attempts[i]), muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const txt = res.getContentText();
    if (code === 200) { data = JSON.parse(txt); break; }
    lastErr = code + ' ' + txt.slice(0, 300);
    if (code === 401 || code === 403) { lastErr = 'ORS_API_KEY が正しくありません'; break; }
    if (code === 429) { lastErr = 'ルート検索の利用上限に達しました。しばらく待ってからお試しください'; break; }
  }
  if (!data || !data.features || !data.features.length) {
    let msg = lastErr;
    try {
      const j = JSON.parse(lastErr.replace(/^\d+\s/, ''));
      if (j.error && j.error.message) msg = j.error.message;
    } catch (e) { /* そのまま */ }
    throw new Error('ルートが見つかりませんでした（' + msg + '）。地点を道路の近くに置き直してください');
  }

  const cands = data.features.map(function (f) {
    const p = f.properties || {};
    const s = p.summary || {};
    const wt = (p.extras || {}).waytype;
    let major = 0;
    if (wt && wt.summary) wt.summary.forEach(function (x) { if (x.value === 1) major += Number(x.amount) || 0; });
    return { f: f, distance: s.distance || 0, duration: s.duration || 0, ascent: p.ascent || 0, descent: p.descent || 0, majorPct: major };
  });

  let best = cands[0];
  if (cond === 'flat') {
    best = cands.reduce(function (a, b) { return b.ascent < a.ascent ? b : a; });
  } else if (cond === 'quiet') {
    best = cands.reduce(function (a, b) {
      return (b.majorPct < a.majorPct || (b.majorPct === a.majorPct && b.distance < a.distance)) ? b : a;
    });
  } else {
    best = cands.reduce(function (a, b) { return b.distance < a.distance ? b : a; });
  }

  const out = best.f.geometry.coordinates.map(function (c) {
    return [round_(c[1], 6), round_(c[0], 6), c.length > 2 ? round_(c[2], 1) : null];
  });
  return {
    ok: true, coords: out,
    info: {
      profile: profile, condition: cond, candidates: cands.length,
      distanceKm: round_(best.distance / 1000, 2), ascentM: Math.round(best.ascent), descentM: Math.round(best.descent),
      majorRoadPct: round_(best.majorPct, 1)
    }
  };
}

function elevation_(req, u) {
  const key = props_().getProperty('ORS_API_KEY');
  if (!key) throw new Error('ORS_API_KEY が未設定です');
  const pts = (req.points || []).map(function (p) { return [Number(p[1]), Number(p[0])]; })
    .filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
  if (pts.length < 2) throw new Error('座標が足りません');
  if (pts.length > 2000) throw new Error('座標が多すぎます（2000点まで）');
  const res = UrlFetchApp.fetch('https://api.openrouteservice.org/elevation/line', {
    method: 'post', contentType: 'application/json', headers: { Authorization: key },
    payload: JSON.stringify({ format_in: 'polyline', format_out: 'polyline', geometry: pts }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('標高を取得できませんでした（' + res.getResponseCode() + '）');
  const j = JSON.parse(res.getContentText());
  const eles = (j.geometry || []).map(function (g) { return g.length > 2 ? g[2] : null; });
  return { ok: true, eles: eles };
}

/* ------------------------------------------------------------
 *  ルート CRUD
 * ------------------------------------------------------------ */
function routeSummary_(r) {
  return {
    routeId: r.routeId, userId: r.userId, nickname: r.nickname, title: r.title,
    description: String(r.description || ''), visibility: r.visibility, profile: r.profile, condition: r.condition, source: r.source,
    distanceKm: Number(r.distanceKm) || 0, ascentM: Number(r.ascentM) || 0, descentM: Number(r.descentM) || 0, maxEleM: Number(r.maxEleM) || 0,
    likeCount: Number(r.likeCount) || 0, commentCount: Number(r.commentCount) || 0,
    thumbUrl: thumbUrl_(r.thumbFileId, 400), createdAt: iso_(r.createdAt), updatedAt: iso_(r.updatedAt)
  };
}

function viewableRoute_(routeId, u) {
  const r = readAll_('Routes').find(function (x) { return x.routeId === routeId; });
  if (!r) throw new Error('ルートが見つかりません');
  if (r.visibility !== 'public' && r.userId !== u.userId) throw new Error('このルートは非公開です');
  return r;
}

function saveRoute_(req, u) {
  const r = req.route || {};
  const title = clip_(r.title, 60);
  if (!title) throw new Error('タイトルを入力してください');
  if (!Array.isArray(r.coords) || r.coords.length < 2) throw new Error('ルートの座標がありません');
  if (r.coords.length > 12000) throw new Error('ルートの点が多すぎます');
  const visibility = r.visibility === 'public' ? 'public' : 'private';
  const st = r.stats || {};
  const data = {
    version: 1, title: title, description: clip_(r.description, 2000),
    profile: String(r.profile || ''), condition: String(r.condition || ''), source: String(r.source || ''),
    stats: st, coords: r.coords, waypoints: (r.waypoints || []).slice(0, 60),
    spots: (r.spots || []).slice(0, 300), photos: (r.photos || []).slice(0, 200)
  };
  return withLock_(function () {
    let existing = null;
    if (r.routeId) {
      existing = readAll_('Routes').find(function (x) { return x.routeId === r.routeId; });
      if (!existing) throw new Error('上書きするルートが見つかりません');
      if (existing.userId !== u.userId) throw new Error('ほかの会員のルートは上書きできません');
    }
    const routeId = existing ? existing.routeId : 'R' + id_();
    data.routeId = routeId;
    const dataFileId = upsertTextFile_('routes', existing && existing.dataFileId, routeId + '.json', JSON.stringify(data), 'application/json');
    let gpxFileId = existing ? existing.gpxFileId : '';
    if (r.gpx) gpxFileId = upsertTextFile_('gpx', gpxFileId, safeName_(title) + '_' + routeId + '.gpx', String(r.gpx), 'application/gpx+xml');
    const firstPhoto = data.photos.filter(function (p) { return p && p.fileId; })[0];
    const row = {
      routeId: routeId, userId: u.userId, nickname: u.nickname, title: title, description: data.description,
      visibility: visibility, profile: data.profile, condition: data.condition, source: data.source,
      distanceKm: num_(st.distanceKm), ascentM: num_(st.ascentM), descentM: num_(st.descentM), maxEleM: num_(st.maxEleM),
      startLat: Number(r.coords[0][0]), startLng: Number(r.coords[0][1]),
      dataFileId: dataFileId, gpxFileId: gpxFileId, thumbFileId: firstPhoto ? firstPhoto.fileId : '', updatedAt: now_()
    };
    if (existing) {
      update_('Routes', existing._row, row);
    } else {
      row.likeCount = 0; row.commentCount = 0; row.createdAt = now_();
      append_('Routes', row);
    }
    return { ok: true, routeId: routeId, visibility: visibility, message: existing ? 'ルートを上書き保存しました' : 'ルートを保存しました' };
  });
}

function deleteRoute_(req, u) {
  return withLock_(function () {
    const r = readAll_('Routes').find(function (x) { return x.routeId === req.routeId; });
    if (!r) throw new Error('ルートが見つかりません');
    if (r.userId !== u.userId) throw new Error('自分のルートだけ削除できます');
    trashFile_(r.dataFileId);
    trashFile_(r.gpxFileId);
    deleteRows_('Likes', readAll_('Likes').filter(function (x) { return x.routeId === r.routeId; }).map(function (x) { return x._row; }));
    deleteRows_('Comments', readAll_('Comments').filter(function (x) { return x.routeId === r.routeId; }).map(function (x) { return x._row; }));
    const again = readAll_('Routes').find(function (x) { return x.routeId === req.routeId; });
    if (again) deleteRows_('Routes', [again._row]);
    return { ok: true, message: 'ルートを削除しました' };
  });
}

function listMyRoutes_(req, u) {
  const list = readAll_('Routes').filter(function (r) { return r.userId === u.userId; }).map(routeSummary_);
  list.sort(function (a, b) { return b.updatedAt < a.updatedAt ? -1 : 1; });
  return { ok: true, routes: list };
}

function listPublicRoutes_(req, u) {
  const q = String(req.q || '').trim().toLowerCase();
  const liked = {};
  readAll_('Likes').forEach(function (l) { if (l.userId === u.userId) liked[l.routeId] = true; });
  let list = readAll_('Routes').filter(function (r) { return r.visibility === 'public'; }).map(routeSummary_);
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter(function (r) {
      const hay = (r.title + ' ' + r.description + ' ' + r.nickname).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }
  const sorters = {
    new: function (a, b) { return b.updatedAt < a.updatedAt ? -1 : 1; },
    likes: function (a, b) { return b.likeCount - a.likeCount || (b.updatedAt < a.updatedAt ? -1 : 1); },
    distAsc: function (a, b) { return a.distanceKm - b.distanceKm; },
    distDesc: function (a, b) { return b.distanceKm - a.distanceKm; },
    climbAsc: function (a, b) { return a.ascentM - b.ascentM; }
  };
  list.sort(sorters[req.sort] || sorters.new);
  list = list.slice(0, 200).map(function (r) { r.liked = !!liked[r.routeId]; r.isOwner = r.userId === u.userId; return r; });
  return { ok: true, routes: list };
}

function getRoute_(req, u) {
  const r = viewableRoute_(req.routeId, u);
  let data = null;
  try {
    data = JSON.parse(DriveApp.getFileById(r.dataFileId).getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    throw new Error('ルートデータを読み込めませんでした（Driveのファイルが削除された可能性があります）');
  }
  const liked = readAll_('Likes').some(function (l) { return l.routeId === r.routeId && l.userId === u.userId; });
  const s = routeSummary_(r);
  s.data = data;
  s.liked = liked;
  s.isOwner = r.userId === u.userId;
  s.gpxUrl = r.gpxFileId ? 'https://drive.google.com/file/d/' + r.gpxFileId + '/view' : '';
  return { ok: true, route: s, comments: listComments_(r.routeId, u, r) };
}

/* ------------------------------------------------------------
 *  いいね・コメント
 * ------------------------------------------------------------ */
function recount_(routeId) {
  const likes = readAll_('Likes').filter(function (x) { return x.routeId === routeId; }).length;
  const comments = readAll_('Comments').filter(function (x) { return x.routeId === routeId; }).length;
  const r = readAll_('Routes').find(function (x) { return x.routeId === routeId; });
  if (r) update_('Routes', r._row, { likeCount: likes, commentCount: comments });
  return { likes: likes, comments: comments };
}

function toggleLike_(req, u) {
  viewableRoute_(req.routeId, u);
  return withLock_(function () {
    const mine = readAll_('Likes').find(function (l) { return l.routeId === req.routeId && l.userId === u.userId; });
    let liked;
    if (mine) {
      deleteRows_('Likes', [mine._row]);
      liked = false;
    } else {
      append_('Likes', { likeId: 'L' + id_(), routeId: req.routeId, userId: u.userId, createdAt: now_() });
      liked = true;
    }
    const c = recount_(req.routeId);
    return { ok: true, liked: liked, likeCount: c.likes };
  });
}

function listComments_(routeId, u, routeRow) {
  const r = routeRow || readAll_('Routes').find(function (x) { return x.routeId === routeId; });
  const ownerId = r ? r.userId : '';
  return readAll_('Comments')
    .filter(function (c) { return c.routeId === routeId; })
    .map(function (c) {
      return {
        commentId: c.commentId, userId: c.userId, nickname: c.nickname, body: String(c.body || ''),
        createdAt: iso_(c.createdAt), updatedAt: iso_(c.updatedAt),
        canEdit: c.userId === u.userId, canDelete: c.userId === u.userId || ownerId === u.userId
      };
    })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
}

function addComment_(req, u) {
  const body = clip_(req.body, 500);
  if (!body) throw new Error('コメントを入力してください');
  const r = viewableRoute_(req.routeId, u);
  return withLock_(function () {
    append_('Comments', { commentId: 'C' + id_(), routeId: r.routeId, userId: u.userId, nickname: u.nickname, body: body, createdAt: now_(), updatedAt: '' });
    const c = recount_(r.routeId);
    return { ok: true, comments: listComments_(r.routeId, u, r), commentCount: c.comments };
  });
}

function editComment_(req, u) {
  const body = clip_(req.body, 500);
  if (!body) throw new Error('コメントを入力してください');
  return withLock_(function () {
    const c = readAll_('Comments').find(function (x) { return x.commentId === req.commentId; });
    if (!c) throw new Error('コメントが見つかりません');
    if (c.userId !== u.userId) throw new Error('自分のコメントだけ編集できます');
    update_('Comments', c._row, { body: body, updatedAt: now_() });
    return { ok: true, comments: listComments_(c.routeId, u) };
  });
}

function deleteComment_(req, u) {
  return withLock_(function () {
    const c = readAll_('Comments').find(function (x) { return x.commentId === req.commentId; });
    if (!c) throw new Error('コメントが見つかりません');
    const r = readAll_('Routes').find(function (x) { return x.routeId === c.routeId; });
    const allowed = c.userId === u.userId || (r && r.userId === u.userId);
    if (!allowed) throw new Error('このコメントは削除できません');
    deleteRows_('Comments', [c._row]);
    const cnt = recount_(c.routeId);
    return { ok: true, comments: listComments_(c.routeId, u, r), commentCount: cnt.comments };
  });
}

/* ------------------------------------------------------------
 *  写真・Gemini
 * ------------------------------------------------------------ */
function uploadPhoto_(req, u) {
  const b64 = String(req.base64 || '');
  if (!b64) throw new Error('画像データがありません');
  if (b64.length > 10 * 1024 * 1024) throw new Error('画像が大きすぎます');
  const mime = String(req.mimeType || 'image/jpeg');
  const name = safeName_(String(req.name || 'photo').replace(/\.[^.]+$/, '')) + '_' + id_().slice(0, 8) + '.jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
  const f = folder_('photos').createFile(blob);
  f.setDescription(JSON.stringify({ userId: u.userId, lat: req.lat, lng: req.lng, takenAt: req.takenAt }));
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* 組織設定で不可の場合あり */ }
  return { ok: true, fileId: f.getId(), thumbUrl: thumbUrl_(f.getId(), 800) };
}

function gemini_(parts, jsonMode) {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です（スクリプトプロパティ）');
  const model = props_().getProperty('GEMINI_MODEL') || 'gemini-flash-latest';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0.4 } };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (code !== 200) {
    if (code === 429) throw new Error('AIの利用上限に達しました。しばらく待ってからお試しください');
    throw new Error('AIの呼び出しに失敗しました（' + code + '）: ' + txt.slice(0, 200));
  }
  const data = JSON.parse(txt);
  const cand = data.candidates && data.candidates[0];
  const out = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
  if (!out) throw new Error('AIから回答を得られませんでした');
  return out;
}

function parseJson_(t) {
  t = String(t || '').replace(/```json|```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('AIの回答を読み取れませんでした');
  return JSON.parse(t.slice(s, e + 1));
}

function geocode_(q) {
  try {
    const g = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(q);
    if (g.status === 'OK' && g.results && g.results.length) {
      const loc = g.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, address: g.results[0].formatted_address };
    }
  } catch (e) { /* 無視 */ }
  return null;
}

function analyzePhoto_(req, u) {
  const b64 = String(req.base64 || '');
  if (!b64) throw new Error('画像データがありません');
  const hasGps = !!req.hasGps;
  const hint = req.hint || {};
  const hintText = (isFinite(Number(hint.lat)) && hint.lat !== null && hint.lat !== '')
    ? '参考情報：この写真は 緯度' + Number(hint.lat).toFixed(4) + '・経度' + Number(hint.lng).toFixed(4) + ' 付近で撮影された可能性があります（' + (hint.note || '同じ旅の写真') + '）。\n'
    : '';
  const gpsText = hasGps
    ? '※この写真の撮影位置は判明しています（緯度' + req.lat + '・経度' + req.lng + '）。場所の推定は不要です。スポットの判定と説明に集中してください。\n'
    : '写っている看板・施設名・地名表示・山並みや海岸線などの地形・建物の特徴から、撮影地点を推定してください。\n';
  const prompt =
    'あなたは日本の自転車ツーリング（ランドナー・自転車キャンプ）に詳しい地理アシスタントです。添付の写真を解析してください。\n' +
    gpsText + hintText +
    '次のJSONだけで答えてください。\n' +
    '{"category":"camp|michinoeki|onsen|supply|view|other のどれか1つ",' +
    '"title":"スポット名（20字以内）",' +
    '"description":"写っている内容と、自転車旅の視点でのひとこと（80字以内）",' +
    '"placeName":"推定される施設名・地名（市区町村まで含める。不明なら空文字）",' +
    '"lat":数値またはnull,"lng":数値またはnull,' +
    '"confidence":"high|medium|low","reason":"推定の根拠（60字以内）"}\n' +
    'カテゴリの意味：camp=キャンプ場、michinoeki=道の駅、onsen=温泉・銭湯、supply=スーパー・コンビニ・商店、view=景色の良い場所、other=その他。\n' +
    '確信がない場合は座標を作らず lat と lng を null にしてください。';

  const out = gemini_([{ text: prompt }, { inline_data: { mime_type: String(req.mimeType || 'image/jpeg'), data: b64 } }], true);
  const j = parseJson_(out);
  const result = {
    category: SPOT_CATS.indexOf(j.category) >= 0 ? j.category : 'other',
    title: clip_(j.title, 30),
    description: clip_(j.description, 160),
    placeName: clip_(j.placeName, 80),
    confidence: ['high', 'medium', 'low'].indexOf(j.confidence) >= 0 ? j.confidence : 'low',
    reason: clip_(j.reason, 120),
    lat: null, lng: null, address: ''
  };
  if (!hasGps) {
    const gLat = Number(j.lat), gLng = Number(j.lng);
    const aiOk = j.lat !== null && j.lng !== null && isFinite(gLat) && isFinite(gLng) && Math.abs(gLat) <= 90 && Math.abs(gLng) <= 180;
    let geo = result.placeName ? geocode_(result.placeName) : null;
    const hLat = Number(hint.lat), hLng = Number(hint.lng);
    if (geo && isFinite(hLat) && isFinite(hLng) && aiOk && distM_(geo.lat, geo.lng, hLat, hLng) > 150000) geo = null; // 同名の遠い場所を避ける
    if (geo) {
      result.lat = round_(geo.lat, 6); result.lng = round_(geo.lng, 6); result.address = geo.address;
    } else if (aiOk) {
      result.lat = round_(gLat, 6); result.lng = round_(gLng, 6);
    }
  }
  return { ok: true, result: result };
}

function routeAdvice_(req, u) {
  const s = req.summary || {};
  const prompt =
    'あなたは日本の自転車ツーリング（ランドナー・自転車キャンプ）に詳しいガイドです。次のルート情報をもとに、走る前に役立つ助言を日本語で書いてください。\n' +
    '・1日の区切り方（荷物ありで1日60〜90km・獲得標高1000m前後を目安に、分けるなら何日か、どこで区切るか）\n' +
    '・登りのきつい区間や最高地点での注意（寒さ・下りのブレーキ）\n' +
    '・補給、休憩、入浴、泊まる場所の候補（下のスポット一覧にあるものだけを名前で挙げ、無いものは作らない）\n' +
    '・' + (s.month || '') + '月の季節・天候・日没時刻に関する注意\n' +
    '見出しは「■」、項目は「・」で書き、全体で500字以内。「#」「*」などの記号は使わないでください。\n\n' +
    'ルート情報（JSON）：\n' + JSON.stringify(s).slice(0, 6000);
  const text = gemini_([{ text: prompt }], false).replace(/[#*]/g, '').trim();
  return { ok: true, advice: text };
}

/* ------------------------------------------------------------
 *  会員登録スポット
 * ------------------------------------------------------------ */
function addSpot_(req, u) {
  const s = req.spot || {};
  const lat = Number(s.lat), lng = Number(s.lng);
  if (!isFinite(lat) || !isFinite(lng)) throw new Error('スポットの位置がありません');
  const name = clip_(s.name, 40);
  if (!name) throw new Error('スポット名を入力してください');
  const spot = {
    spotId: 'S' + id_(), userId: u.userId, nickname: u.nickname,
    category: SPOT_CATS.indexOf(s.category) >= 0 ? s.category : 'other',
    name: name, note: clip_(s.note, 300), lat: round_(lat, 6), lng: round_(lng, 6),
    photoFileId: clip_(s.photoFileId, 80), source: clip_(s.source, 20),
    visibility: s.visibility === 'public' ? 'public' : 'private', createdAt: now_()
  };
  withLock_(function () { append_('Spots', spot); });
  return { ok: true, spot: spotOut_(spot, u), message: 'スポットを登録しました' };
}

function spotOut_(s, u) {
  return {
    spotId: s.spotId, nickname: s.nickname, category: s.category, name: s.name, note: s.note,
    lat: Number(s.lat), lng: Number(s.lng), photoUrl: thumbUrl_(s.photoFileId, 600),
    source: s.source, visibility: s.visibility, mine: s.userId === u.userId, createdAt: iso_(s.createdAt)
  };
}

function listSpots_(req, u) {
  const list = readAll_('Spots')
    .filter(function (s) { return s.visibility === 'public' || s.userId === u.userId; })
    .slice(-3000)
    .map(function (s) { return spotOut_(s, u); });
  return { ok: true, spots: list };
}

function deleteSpot_(req, u) {
  return withLock_(function () {
    const s = readAll_('Spots').find(function (x) { return x.spotId === req.spotId; });
    if (!s) throw new Error('スポットが見つかりません');
    if (s.userId !== u.userId) throw new Error('自分が登録したスポットだけ削除できます');
    deleteRows_('Spots', [s._row]);
    return { ok: true, message: 'スポットを削除しました' };
  });
}
