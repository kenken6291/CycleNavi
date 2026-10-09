/* ==========================================================
   CycleNavi（仮） フロントエンド  app.js
   GitHub Pages + GAS Web API
   ========================================================== */
'use strict';

const CONFIG = {
  // GASのURLは config.js で設定します（app.jsを差し替えても消えません）
  GAS_URL: (window.APP_CONFIG && window.APP_CONFIG.GAS_URL) || '',
  OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
  NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
  DEFAULT_CENTER: [35.6812, 139.7671],
  DEFAULT_ZOOM: 11,
  TOURING_SPEED_KMH: 15,   // 目安時間：荷物ありツーリングの平均速度
  CLIMB_M_PER_HOUR: 500,   // 目安時間：登り500mごとに+1時間
  MAX_SAVE_POINTS: 8000
};
const APP_VERSION = '1.1.0';
const TOKEN_KEY = 'cyclenavi_token';
const REC_KEY = 'cyclenavi_recording';

const CATS = {
  camp:       { label: 'キャンプ場',     icon: '⛺', color: '#2F5D50' },
  michinoeki: { label: '道の駅',         icon: '🛣️', color: '#1D5C8C' },
  onsen:      { label: '日帰り温泉',     icon: '♨️', color: '#B8432F' },
  supply:     { label: '補給',           icon: '🏪', color: '#8A6D1E' },
  view:       { label: 'ビュースポット', icon: '🌄', color: '#6B4FA0' },
  other:      { label: 'その他',         icon: '📍', color: '#566562' }
};
const PROFILES = {
  'cycling-regular': 'ランドナー・ツーリング車', 'cycling-road': 'ロードバイク',
  'cycling-mountain': 'MTB・グラベル', 'cycling-electric': 'e-bike'
};
const CONDITIONS = { flat: '平坦重視', quiet: '交通量少・裏道優先', shortest: '最短距離' };
const COND_NOTES = {
  flat: '上り坂のきつさを避ける設定で探し、候補の中から獲得標高がいちばん少ない経路を選びます。',
  quiet: '自転車向けの推奨経路で探し、候補の中から国道・県道など幹線を通る割合がいちばん少ない経路を選びます。',
  shortest: '距離が最短になる経路を選びます。交通量の多い幹線を通ることがあります。'
};

/* ---------------- 状態 ---------------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
};

const state = {
  token: store.get(TOKEN_KEY) || '',
  user: null,
  activeTab: 'route',
  waypoints: [],          // {id, lat, lng, name}
  route: null,            // {coords:[[lat,lng,ele]], source, times?, info?, stats}
  meta: null,             // 読み込み・保存済みルート {routeId,title,description,visibility,isOwner,nickname}
  importName: '',
  importedWpts: [],       // GPXの<wpt>
  profile: 'cycling-regular',
  condition: 'flat',
  spotCats: new Set(Object.keys(CATS).filter(k => k !== 'other')),
  spots: [],              // 表示中スポット
  userSpots: [],          // 会員登録スポット
  userSpotsLoaded: false,
  photos: [],
  uploading: false,
  pickPhotoId: null,
  recording: { active: false, watchId: null, points: [], startedAt: 0, timer: null, wakeLock: null },
  detail: null,
  detailComments: []
};

let map, layers = {}, chart = null, routeSample = null, autoRouteTimer = null;

/* ---------------- ユーティリティ ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function loading(on, msg) {
  $('#loading').hidden = !on;
  if (msg) $('#loadingText').textContent = msg;
}
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function fastDist(lat1, lng1, lat2, lng2) {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * 111320;
}
function downsampleIdx(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1), out = [];
  for (let k = 0; k < max; k++) out.push(Math.round(k * step));
  return out;
}
function fillEle(arr) {
  const out = arr.slice();
  const known = [];
  out.forEach((v, i) => { if (v != null && isFinite(v)) known.push(i); });
  if (!known.length) return out.map(() => null);
  for (let i = 0; i < known[0]; i++) out[i] = out[known[0]];
  for (let i = known[known.length - 1] + 1; i < out.length; i++) out[i] = out[known[known.length - 1]];
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    for (let i = a + 1; i < b; i++) out[i] = out[a] + (out[b] - out[a]) * (i - a) / (b - a);
  }
  return out;
}
function smooth(arr, w) {
  const h = Math.floor(w / 2), out = [];
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) { s += arr[j]; c++; }
    out.push(s / c);
  }
  return out;
}
function fmtDate(v) {
  const d = new Date(v); if (isNaN(d)) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDateTime(v) {
  const d = new Date(v); if (isNaN(d)) return '';
  return `${fmtDate(d)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtHours(h) {
  if (!isFinite(h) || h <= 0) return '–';
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${hh}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}
function escXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }

/* ---------------- API ---------------- */
async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, token: state.token }, payload))
    });
  } catch (e) {
    throw new Error('サーバーに接続できません。通信状況とGAS_URLの設定を確認してください');
  }
  let data;
  try { data = await res.json(); } catch (e) {
    throw new Error('サーバーの応答を読み取れません。GASのデプロイで「アクセスできるユーザー：全員」になっているか確認してください');
  }
  if (!data.ok) {
    if (data.code === 'AUTH') { clearSession(); openAuth('login'); }
    if (data.code === 'MUST_CHANGE') openPwModal(true);
    throw new Error(data.error || 'エラーが発生しました');
  }
  return data;
}

/* ---------------- 地図 ---------------- */
function initMap() {
  map = L.map('map', { zoomControl: false }).setView(CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);
  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr });
  const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 20, subdomains: 'abc', attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | ' + osmAttr });
  const gsiAttr = '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';
  const gsiStd = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr });
  const gsiPale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr });
  const hill = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png', { maxNativeZoom: 16, maxZoom: 19, opacity: 0.35, attribution: gsiAttr });
  osm.addTo(map);
  L.control.layers(
    { 'OpenStreetMap': osm, 'サイクルマップ（CyclOSM）': cyclosm, '地理院 標準': gsiStd, '地理院 淡色': gsiPale },
    { '陰影起伏': hill }, { position: 'topright' }
  ).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'map-ctl leaflet-bar');
      b.type = 'button'; b.title = '現在地'; b.setAttribute('aria-label', '現在地を表示');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', () => locateMe(false));
      return b;
    }
  });
  new Locate().addTo(map);

  layers.route = L.featureGroup().addTo(map);
  layers.wp = L.layerGroup().addTo(map);
  layers.spots = L.layerGroup().addTo(map);
  layers.photos = L.layerGroup().addTo(map);
  layers.record = L.layerGroup().addTo(map);
  layers.extra = L.layerGroup().addTo(map);
  layers.hover = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="hover-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false });

  map.on('click', onMapClick);
  map.on('popupopen', e => bindActs(e.popup.getElement()));
}

function onMapClick(e) {
  const { lat, lng } = e.latlng;
  if (state.pickPhotoId) {
    const p = state.photos.find(x => x.id === state.pickPhotoId);
    state.pickPhotoId = null;
    if (p) {
      p.lat = lat; p.lng = lng; p.source = 'manual';
      renderPhotos(); drawPhotoMarkers();
      toast('撮影地点を設定しました');
    }
    return;
  }
  if (state.activeTab === 'route' && $('#tapToAdd').checked && !state.recording.active) {
    addWaypoint(lat, lng);
  }
}

function locateMe(addAsWaypoint) {
  if (!navigator.geolocation) return toast('この端末では現在地を取得できません', 'warn');
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (layers.me) layers.me.setLatLng(ll);
    else layers.me = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 14));
    if (addAsWaypoint) addWaypoint(ll[0], ll[1], '現在地');
  }, err => toast('現在地を取得できませんでした（位置情報の許可を確認してください）', 'warn'),
  { enableHighAccuracy: true, timeout: 15000 });
}

/* ---------------- 経由地 ---------------- */
function addWaypoint(lat, lng, name = '', index = null) {
  const w = { id: uid(), lat, lng, name };
  if (index == null) state.waypoints.push(w);
  else state.waypoints.splice(index, 0, w);
  renderWaypoints();
  scheduleAutoRoute();
}

function wpLabel(i, n) {
  if (i === 0) return { t: 'S', c: 's' };
  if (i === n - 1) return { t: 'G', c: 'g' };
  return { t: String(i), c: '' };
}

function renderWaypoints() {
  layers.wp.clearLayers();
  const n = state.waypoints.length;
  state.waypoints.forEach((w, i) => {
    const lb = wpLabel(i, n);
    const m = L.marker([w.lat, w.lng], {
      draggable: true,
      icon: L.divIcon({ className: '', html: `<div class="wp-pin ${lb.c}">${lb.t}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] })
    }).addTo(layers.wp);
    m.bindTooltip(w.name || (i === 0 ? '出発地' : i === n - 1 ? '目的地' : '経由地' + i));
    m.on('dragend', ev => {
      const p = ev.target.getLatLng();
      w.lat = p.lat; w.lng = p.lng; w.name = '';
      renderWaypointList();
      scheduleAutoRoute();
    });
  });
  renderWaypointList();
}

function renderWaypointList() {
  const ul = $('#wpList');
  const n = state.waypoints.length;
  if (!n) { ul.innerHTML = '<li class="empty">まだ地点がありません。地図をタップするか、上の検索から追加してください。</li>'; return; }
  const ic = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };
  ul.innerHTML = state.waypoints.map((w, i) => {
    const lb = wpLabel(i, n);
    const nm = w.name || (i === 0 ? '出発地' : i === n - 1 ? '目的地' : '経由地') + `（${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}）`;
    return `<li class="wp-item">
      <span class="wp-badge ${lb.c}">${lb.t}</span>
      <span class="wp-name" title="${esc(nm)}">${esc(nm)}</span>
      <button class="icon-btn" type="button" data-act="wp-up" data-id="${w.id}" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>${ic.up}</button>
      <button class="icon-btn" type="button" data-act="wp-down" data-id="${w.id}" aria-label="下へ" ${i === n - 1 ? 'disabled' : ''}>${ic.down}</button>
      <button class="icon-btn" type="button" data-act="wp-del" data-id="${w.id}" aria-label="削除">${ic.del}</button>
    </li>`;
  }).join('');
}

function moveWaypoint(id, dir) {
  const i = state.waypoints.findIndex(w => w.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.waypoints.length) return;
  [state.waypoints[i], state.waypoints[j]] = [state.waypoints[j], state.waypoints[i]];
  renderWaypoints();
  scheduleAutoRoute();
}

function scheduleAutoRoute() {
  if (!state.route || state.route.source !== 'ors' || state.waypoints.length < 2) return;
  clearTimeout(autoRouteTimer);
  autoRouteTimer = setTimeout(() => calcRoute(), 700);
}

async function searchPlace(q) {
  const ul = $('#placeResults');
  if (!q.trim()) { ul.innerHTML = ''; return; }
  ul.innerHTML = '<li class="empty">検索中…</li>';
  try {
    const url = `${CONFIG.NOMINATIM_URL}?format=json&limit=6&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    const list = await res.json();
    if (!list.length) { ul.innerHTML = '<li class="empty">見つかりませんでした。別の言葉で試してください。</li>'; return; }
    ul.innerHTML = list.map(r => {
      const name = String(r.display_name).split(',')[0];
      return `<li><button type="button" data-act="place-add" data-lat="${r.lat}" data-lng="${r.lon}" data-name="${esc(name)}">${esc(name)}<small>${esc(r.display_name)}</small></button></li>`;
    }).join('');
  } catch (e) {
    ul.innerHTML = '<li class="empty">検索できませんでした。時間をおいてお試しください。</li>';
  }
}

/* ---------------- ルート探索・描画 ---------------- */
async function calcRoute() {
  if (state.waypoints.length < 2) return toast('出発地と目的地を地図のタップで指定してください', 'warn');
  loading(true, 'ルートを探しています…');
  try {
    const r = await api('route', {
      coordinates: state.waypoints.map(w => [w.lng, w.lat]),
      profile: state.profile, condition: state.condition
    });
    const keepMeta = !!state.meta && state.meta.isOwner;
    setRoute({ coords: r.coords, source: 'ors', info: r.info }, { fit: true, keepMeta });
    const i = r.info;
    let msg = `${CONDITIONS[i.condition]}で${i.candidates}本の候補から選びました。`;
    if (i.candidates <= 1 && state.waypoints.length > 2) msg += '（経由地がある場合は候補の比較をしません）';
    if (i.majorRoadPct > 0) msg += ` 幹線道路の割合 約${Math.round(i.majorRoadPct)}%。`;
    $('#routeInfo').textContent = msg;
  } catch (e) {
    toast(e.message, 'error', 7000);
  } finally {
    loading(false);
  }
}

function computeStats(coords) {
  const dist = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + hav(coords[i - 1], coords[i]));
  const eleCount = coords.filter(c => c[2] != null && isFinite(c[2])).length;
  const hasEle = coords.length > 1 && eleCount >= coords.length * 0.8;
  let ascent = 0, descent = 0, maxEle = null, maxEleIdx = -1, maxGrade = 0, ele = null;
  if (hasEle) {
    ele = fillEle(coords.map(c => (c[2] != null && isFinite(c[2])) ? Number(c[2]) : null));
    const sm = smooth(ele, 5);
    for (let i = 1; i < sm.length; i++) {
      const d = sm[i] - sm[i - 1];
      if (d > 0) ascent += d; else descent -= d;
    }
    ele.forEach((v, i) => { if (maxEle == null || v > maxEle) { maxEle = v; maxEleIdx = i; } });
    let s = 0;
    for (let i = 1; i < sm.length; i++) {
      const dd = dist[i] - dist[s];
      if (dd >= 100) {
        const g = (sm[i] - sm[s]) / dd * 100;
        if (g > maxGrade) maxGrade = g;
        s = i;
      }
    }
  }
  const km = dist[dist.length - 1] / 1000;
  const hours = km / CONFIG.TOURING_SPEED_KMH + ascent / CONFIG.CLIMB_M_PER_HOUR;
  return {
    dist, ele, hasEle,
    distanceKm: Math.round(km * 100) / 100,
    ascentM: Math.round(ascent), descentM: Math.round(descent),
    maxEleM: maxEle == null ? null : Math.round(maxEle), maxEleIdx,
    maxGrade: Math.round(maxGrade * 10) / 10, hours
  };
}

function setRoute(r, { fit = true, keepMeta = false, keepSpots = false } = {}) {
  const coords = (r.coords || []).filter(c => c && isFinite(c[0]) && isFinite(c[1]))
    .map(c => [Number(c[0]), Number(c[1]), c[2] == null || c[2] === '' ? null : Number(c[2])]);
  if (coords.length < 2) return toast('ルートの点が足りません', 'warn');
  state.route = Object.assign({}, r, { coords, stats: computeStats(coords) });
  if (!keepMeta) state.meta = null;
  buildRouteSample();
  drawRoute();
  renderDock();
  updateRouteButtons();
  renderCurrent();
  if (!keepSpots) { state.spots = []; layers.spots.clearLayers(); renderSpotList(); }
  $('#adviceBox').hidden = true;
  if (fit) map.fitBounds(layers.route.getBounds(), { padding: [40, 40] });
}

function clearRoute() {
  state.route = null; state.meta = null; state.importName = ''; state.importedWpts = [];
  layers.route.clearLayers(); layers.extra.clearLayers(); layers.spots.clearLayers();
  state.spots = []; renderSpotList();
  if (map.hasLayer(layers.hover)) map.removeLayer(layers.hover);
  if (chart) { chart.destroy(); chart = null; }
  $('#routeInfo').textContent = '';
  $('#adviceBox').hidden = true;
  renderDock(); updateRouteButtons(); renderCurrent();
}

function buildRouteSample() {
  const r = state.route;
  if (!r) { routeSample = null; return; }
  const idx = downsampleIdx(r.coords.length, 1500);
  routeSample = idx.map(i => ({ lat: r.coords[i][0], lng: r.coords[i][1], km: r.stats.dist[i] / 1000 }));
}

function nearestOnRoute(lat, lng) {
  if (!routeSample) return null;
  let best = null;
  for (const p of routeSample) {
    const d = fastDist(lat, lng, p.lat, p.lng);
    if (!best || d < best.off) best = { off: d, km: p.km };
  }
  return best;
}

function drawRoute() {
  layers.route.clearLayers();
  const r = state.route;
  if (!r) return;
  const ll = r.coords.map(c => [c[0], c[1]]);
  L.polyline(ll, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layers.route);
  L.polyline(ll, { color: '#7B2CBF', weight: 5, opacity: 0.95 }).addTo(layers.route);
  const s = r.stats;
  if (s.hasEle && s.maxEleIdx >= 0) {
    const c = r.coords[s.maxEleIdx];
    L.marker([c[0], c[1]], {
      icon: L.divIcon({ className: '', html: `<div class="peak-pin">▲ ${s.maxEleM}m</div>`, iconSize: [0, 0] }),
      interactive: false, keyboard: false
    }).addTo(layers.route);
  }
  // 経由地がない（GPX等）の場合、始点・終点の目印
  if (!state.waypoints.length) {
    const a = ll[0], b = ll[ll.length - 1];
    L.circleMarker(a, { radius: 7, color: '#fff', weight: 3, fillColor: '#2F5D50', fillOpacity: 1 }).bindTooltip('スタート').addTo(layers.route);
    L.circleMarker(b, { radius: 7, color: '#fff', weight: 3, fillColor: '#B8432F', fillOpacity: 1 }).bindTooltip('ゴール').addTo(layers.route);
  }
}

function updateRouteButtons() {
  const has = !!state.route;
  ['#saveOpenBtn', '#gpxOpenBtn', '#gpxOpenBtn2', '#adviceBtn'].forEach(s => { $(s).disabled = !has; });
}

function renderCurrent() {
  const el = $('#currentRoute');
  const m = state.meta;
  if (!m) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${esc(m.title)}</b>
    ${m.isOwner ? `自分のルート<span class="vis ${m.visibility}">${m.visibility === 'public' ? '公開' : '非公開'}</span>` : `${esc(m.nickname)} さんのルート（保存すると自分のルートとして複製されます）`}
    <div class="mt-1"><button type="button" class="link-btn" data-act="route-new">新しいルートを作る</button></div>`;
}

/* ---------------- ドック（統計・標高） ---------------- */
function renderDock() {
  const dock = $('#dock');
  const r = state.route;
  if (!r) { dock.hidden = true; return; }
  dock.hidden = false;
  const s = r.stats;
  $('#stDist').textContent = s.distanceKm.toFixed(1);
  $('#stUp').textContent = s.hasEle ? s.ascentM.toLocaleString() : '–';
  $('#stDown').textContent = s.hasEle ? s.descentM.toLocaleString() : '–';
  $('#stMax').textContent = s.hasEle && s.maxEleM != null ? s.maxEleM.toLocaleString() : '–';
  $('#stGrade').textContent = s.hasEle ? s.maxGrade.toFixed(1) : '–';
  $('#stTime').textContent = fmtHours(s.hours);
  renderChart();
}

function gradeColor(p0, p1) {
  const dx = (p1.x - p0.x) * 1000;
  if (dx <= 0) return '#8BC0AC';
  const g = (p1.y - p0.y) / dx * 100;
  if (g >= 8) return '#E4674F';
  if (g >= 4) return '#E6AE45';
  return '#8BC0AC';
}

function renderChart() {
  const r = state.route;
  const box = $('#chartBox');
  if (chart) { chart.destroy(); chart = null; }
  const s = r.stats;
  if (!s.hasEle) {
    box.innerHTML = '<div class="no-ele">このルートには標高データがありません。<button type="button" class="btn-mini primary" data-act="ele-fetch">標高を取得する</button></div>';
    return;
  }
  box.innerHTML = '<canvas id="eleChart" aria-label="標高グラフ"></canvas>';
  const idx = downsampleIdx(r.coords.length, 700);
  const pts = idx.map(i => ({ x: s.dist[i] / 1000, y: s.ele[i], i }));
  const tickColor = 'rgba(239,241,232,.62)';
  const font = { family: '"Barlow Condensed", sans-serif', size: 13 };
  chart = new Chart($('#eleChart'), {
    type: 'line',
    data: {
      datasets: [{
        data: pts, borderWidth: 2.2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15,
        fill: 'start', backgroundColor: 'rgba(139,192,172,.14)',
        segment: { borderColor: ctx => gradeColor(ctx.p0.parsed, ctx.p1.parsed) },
        borderColor: '#8BC0AC'
      }]
    },
    options: {
      animation: false, maintainAspectRatio: false, responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: items => items[0].parsed.x.toFixed(1) + ' km',
            label: it => '標高 ' + Math.round(it.parsed.y) + ' m'
          }
        }
      },
      scales: {
        x: { type: 'linear', min: 0, max: s.distanceKm, ticks: { color: tickColor, font, callback: v => v + 'km', maxTicksLimit: 8 }, grid: { color: 'rgba(239,241,232,.07)' } },
        y: { ticks: { color: tickColor, font, callback: v => v + 'm', maxTicksLimit: 4 }, grid: { color: 'rgba(239,241,232,.07)' } }
      },
      onHover: (evt, els) => {
        if (!els.length) return;
        const p = pts[els[0].index];
        const c = r.coords[p.i];
        layers.hover.setLatLng([c[0], c[1]]);
        if (!map.hasLayer(layers.hover)) layers.hover.addTo(map);
      }
    }
  });
  $('#eleChart').addEventListener('mouseleave', () => { if (map.hasLayer(layers.hover)) map.removeLayer(layers.hover); });
}

async function fetchElevation() {
  const r = state.route;
  if (!r) return;
  loading(true, '標高を取得しています…');
  try {
    const idx = downsampleIdx(r.coords.length, 1800);
    const res = await api('elevation', { points: idx.map(i => [r.coords[i][0], r.coords[i][1]]) });
    const ele = new Array(r.coords.length).fill(null);
    idx.forEach((i, k) => { ele[i] = res.eles[k]; });
    const filled = fillEle(ele);
    const coords = r.coords.map((c, i) => [c[0], c[1], filled[i] == null ? null : Math.round(filled[i] * 10) / 10]);
    setRoute(Object.assign({}, r, { coords }), { fit: false, keepMeta: true, keepSpots: true });
    toast('標高データを取得しました');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading(false); }
}

/* ---------------- スポット ---------------- */
function renderCatChips() {
  $('#catChips').innerHTML = Object.entries(CATS).filter(([k]) => k !== 'other').map(([k, c]) =>
    `<button type="button" class="chip" data-act="cat-toggle" data-id="${k}" style="--c:${c.color}" aria-pressed="${state.spotCats.has(k)}">${c.icon} ${c.label}</button>`
  ).join('');
}

function classify(tags) {
  const name = tags.name || '';
  if (/道の駅/.test(name)) return 'michinoeki';
  if (tags.tourism === 'camp_site') return 'camp';
  if (tags.amenity === 'public_bath') return 'onsen';
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'supply';
  if (tags.tourism === 'viewpoint') return 'view';
  return 'other';
}

function simplifyForOverpass(coords, max) {
  const idx = downsampleIdx(coords.length, max);
  return idx.map(i => coords[i]);
}

async function loadUserSpots(force = false) {
  if (state.userSpotsLoaded && !force) return;
  try {
    const r = await api('listSpots');
    state.userSpots = r.spots.map(s => ({
      id: 'u' + s.spotId, spotId: s.spotId, cat: CATS[s.category] ? s.category : 'other', name: s.name, note: s.note,
      lat: s.lat, lng: s.lng, photo: s.photoUrl, user: true, mine: s.mine, nickname: s.nickname, visibility: s.visibility
    }));
    state.userSpotsLoaded = true;
  } catch (e) { /* 表示しないだけ */ }
}

async function searchSpots() {
  const cats = [...state.spotCats];
  if (!cats.length) return toast('カテゴリを1つ以上選んでください', 'warn');
  const radius = Number($('#spotRadius').value);
  let filter, bounds = null;
  if (state.route) {
    const pts = simplifyForOverpass(state.route.coords, 90);
    filter = `(around:${radius},${pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(',')})`;
  } else {
    if (map.getZoom() < 11) return toast('地図をもう少し拡大するか、先にルートを作ってください', 'warn');
    bounds = map.getBounds();
    filter = `(${bounds.getSouth().toFixed(5)},${bounds.getWest().toFixed(5)},${bounds.getNorth().toFixed(5)},${bounds.getEast().toFixed(5)})`;
  }
  const q = {
    camp: `nwr${filter}["tourism"="camp_site"];`,
    michinoeki: `nwr${filter}["name"~"道の駅"];`,
    onsen: `nwr${filter}["amenity"="public_bath"];`,
    supply: `nwr${filter}["shop"~"^(supermarket|convenience)$"];`,
    view: `nwr${filter}["tourism"="viewpoint"];`
  };
  const query = `[out:json][timeout:60];(${cats.map(c => q[c]).join('')});out center tags 500;`;
  loading(true, 'スポットを探しています…');
  try {
    const [res] = await Promise.all([
      fetch(CONFIG.OVERPASS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) }),
      $('#showUserSpots').checked ? loadUserSpots() : Promise.resolve()
    ]);
    if (!res.ok) throw new Error(res.status === 429 || res.status === 504 ? '検索サーバーが混み合っています。少し待ってからお試しください' : 'スポットを検索できませんでした（' + res.status + '）');
    const data = await res.json();
    const seen = new Set();
    let list = [];
    (data.elements || []).forEach(el => {
      const lat = el.lat ?? (el.center && el.center.lat);
      const lng = el.lon ?? (el.center && el.center.lon);
      if (lat == null || lng == null) return;
      const tags = el.tags || {};
      const cat = classify(tags);
      if (!state.spotCats.has(cat)) return;
      const name = tags.name || (cat === 'supply' ? (tags.shop === 'convenience' ? 'コンビニ' : 'スーパー') : CATS[cat].label);
      const key = name + '|' + lat.toFixed(3) + '|' + lng.toFixed(3);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ id: 'o' + el.type[0] + el.id, cat, name, lat, lng, hours: tags.opening_hours || '', web: tags.website || '', user: false });
    });
    if ($('#showUserSpots').checked) {
      state.userSpots.forEach(s => {
        if (!state.spotCats.has(s.cat) && s.cat !== 'other') return;
        if (bounds && !bounds.contains([s.lat, s.lng])) return;
        list.push(Object.assign({}, s));
      });
    }
    list.forEach(s => {
      const n = nearestOnRoute(s.lat, s.lng);
      if (n) { s.km = n.km; s.off = n.off; }
    });
    if (state.route) list = list.filter(s => !s.user || s.off <= radius * 1.1);
    list.sort((a, b) => state.route ? a.km - b.km : a.name.localeCompare(b.name, 'ja'));
    state.spots = list.slice(0, 400);
    drawSpots();
    renderSpotList();
    const counts = Object.keys(CATS).map(k => [k, state.spots.filter(s => s.cat === k).length]).filter(x => x[1]);
    $('#spotSummary').textContent = state.spots.length
      ? `${state.spots.length}件見つかりました（${counts.map(([k, n]) => CATS[k].label + n).join('、')}）`
      : '見つかりませんでした。距離を広げるかカテゴリを増やしてください。';
  } catch (e) {
    toast(e.message || 'スポットを検索できませんでした', 'error');
  } finally { loading(false); }
}

function spotIcon(s) {
  const c = CATS[s.cat] || CATS.other;
  return L.divIcon({ className: '', html: `<div class="spot-pin ${s.user ? 'user' : ''}" style="--c:${c.color}">${c.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
}

function spotPopup(s) {
  const c = CATS[s.cat] || CATS.other;
  return `<div class="pop">
    <div class="pop-cat">${c.icon} ${c.label}${s.user ? `（${esc(s.nickname || '会員')}さんが登録）` : ''}</div>
    <div class="pop-name">${esc(s.name)}</div>
    ${s.photo ? `<img class="pop-img" src="${esc(s.photo)}" alt="">` : ''}
    ${s.note ? `<p class="pop-note">${esc(s.note)}</p>` : ''}
    ${s.hours ? `<p class="pop-note">営業時間：${esc(s.hours)}</p>` : ''}
    ${s.km != null ? `<div class="pop-meta">起点から${s.km.toFixed(1)}km地点・ルートから${Math.round(s.off)}m</div>` : ''}
    <div class="btns">
      <button type="button" class="btn-mini primary" data-act="spot-add-wp" data-id="${s.id}">経由地に追加</button>
      ${s.user && s.mine ? `<button type="button" class="btn-mini danger" data-act="spot-del" data-id="${s.id}">削除</button>` : ''}
    </div></div>`;
}

function drawSpots() {
  layers.spots.clearLayers();
  state.spots.forEach(s => {
    s.marker = L.marker([s.lat, s.lng], { icon: spotIcon(s) }).bindPopup(spotPopup(s)).addTo(layers.spots);
  });
}

function renderSpotList() {
  const ul = $('#spotList');
  if (!state.spots.length) { ul.innerHTML = ''; if (!state.route) $('#spotSummary').textContent = ''; return; }
  ul.innerHTML = state.spots.map(s => {
    const c = CATS[s.cat] || CATS.other;
    const where = s.km != null ? `起点から${s.km.toFixed(1)}km・ルートから${Math.round(s.off)}m` : c.label;
    return `<li class="spot-item"><button type="button" class="main" data-act="spot-focus" data-id="${s.id}">
      <span class="spot-ic" style="--c:${c.color}">${c.icon}</span>
      <span class="spot-tx"><b>${esc(s.name)}</b><small>${c.label}${s.user ? '（会員登録）' : ''}　${where}</small></span>
    </button></li>`;
  }).join('');
}

function spotToWaypoint(s) {
  if (!state.route || state.waypoints.length < 2) { addWaypoint(s.lat, s.lng, s.name); return; }
  const n = nearestOnRoute(s.lat, s.lng);
  const wpKm = state.waypoints.map(w => (nearestOnRoute(w.lat, w.lng) || { km: 0 }).km);
  let at = state.waypoints.length - 1;
  for (let i = 1; i < wpKm.length; i++) { if (wpKm[i] > n.km) { at = i; break; } }
  addWaypoint(s.lat, s.lng, s.name, at);
  if (state.route.source !== 'ors') toast('経由地に追加しました。「ルートを引く」で経路を作り直せます');
}

async function deleteUserSpot(s) {
  if (!confirm(`「${s.name}」を削除しますか？`)) return;
  try {
    await api('deleteSpot', { spotId: s.spotId });
    state.userSpots = state.userSpots.filter(x => x.spotId !== s.spotId);
    state.spots = state.spots.filter(x => x.id !== s.id);
    map.closePopup(); drawSpots(); renderSpotList();
    toast('スポットを削除しました');
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------- 写真 ---------------- */
function resizeImage(file, max, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めません')); };
    img.src = url;
  });
}

async function addPhotoFiles(files) {
  const list = Array.from(files).filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif)$/i.test(f.name));
  if (!list.length) return toast('画像ファイルを選んでください', 'warn');
  switchTab('photos');
  for (const file of list) {
    const p = { id: uid(), name: file.name, status: '読み込み中…', lat: null, lng: null, time: null, timeGuess: false, source: '', fileId: '', driveThumb: '', dataUrl: '', ai: null, error: false };
    state.photos.push(p);
    renderPhotos();
    try {
      let meta = null;
      try { meta = await exifr.parse(file, { gps: true, tiff: true, exif: true }); } catch (e) { meta = null; }
      if (meta) {
        if (isFinite(meta.latitude) && isFinite(meta.longitude)) { p.lat = meta.latitude; p.lng = meta.longitude; p.source = 'exif'; }
        const t = meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate;
        if (t instanceof Date && !isNaN(t)) p.time = t.toISOString();
      }
      if (!p.time && file.lastModified) { p.time = new Date(file.lastModified).toISOString(); p.timeGuess = true; }
      p.dataUrl = await resizeImage(file, 1600, 0.85);
      p.status = 'ドライブへの保存待ち';
    } catch (e) {
      p.error = true;
      p.status = '読み込めませんでした（HEICなど、このブラウザで表示できない形式の可能性があります）';
    }
  }
  state.photos.sort((a, b) => (a.time || '9').localeCompare(b.time || '9'));
  renderPhotos();
  drawPhotoMarkers();
  const withGps = state.photos.filter(p => p.lat != null).length;
  toast(`写真を読み込みました（位置情報あり ${withGps}枚 / ${state.photos.length}枚）`);
  uploadPendingPhotos();
}

async function uploadPendingPhotos() {
  if (state.uploading) return;
  state.uploading = true;
  try {
    for (const p of state.photos) {
      if (p.fileId || p.error || !p.dataUrl) continue;
      p.status = 'ドライブに保存中…'; renderPhotos();
      try {
        const r = await api('uploadPhoto', { base64: p.dataUrl.split(',')[1], mimeType: 'image/jpeg', name: p.name, lat: p.lat, lng: p.lng, takenAt: p.time });
        p.fileId = r.fileId; p.driveThumb = r.thumbUrl; p.status = 'ドライブに保存済み';
      } catch (e) {
        p.status = '保存できませんでした：' + e.message;
      }
      renderPhotos();
    }
  } finally { state.uploading = false; }
}

function renderPhotos() {
  const ul = $('#photoList');
  if (!state.photos.length) { ul.innerHTML = '<li class="empty">写真はまだありません。</li>'; return; }
  const conf = { high: '高', medium: '中', low: '低' };
  ul.innerHTML = state.photos.map(p => {
    const img = p.dataUrl || p.driveThumb || '';
    const src = { exif: 'GPS', ai: 'AI推定', manual: '手動で指定', saved: '保存済み' }[p.source] || '';
    const loc = p.lat != null ? `${src}：${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : '位置情報なし';
    let ai = '';
    if (p.ai) {
      const c = CATS[p.ai.category] || CATS.other;
      ai = `<div class="ai-box"><b>${c.icon} ${esc(p.ai.title || c.label)}</b><p>${esc(p.ai.description || '')}</p>`;
      if (p.aiForLocation) {
        if (p.ai.lat != null) {
          ai += `<p>推定地点：${esc(p.ai.placeName || p.ai.address || '（名称不明）')}（確からしさ：${conf[p.ai.confidence] || '低'}）<br><small>${esc(p.ai.reason || '')}</small></p>
                 ${p.source !== 'ai' ? `<button type="button" class="btn-mini primary" data-act="photo-adopt" data-id="${p.id}">この地点を採用</button>` : ''}`;
        } else {
          ai += '<p><small>場所を特定できませんでした。「地図で指定」から撮影地点を選んでください。</small></p>';
        }
      }
      ai += '</div>';
    }
    return `<li class="photo-item">
      ${img ? `<img class="photo-thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="photo-thumb"></div>'}
      <div class="photo-body">
        <div class="photo-time">${p.time ? fmtDateTime(p.time) : '撮影時刻不明'}${p.timeGuess ? '（ファイルの日時）' : ''}</div>
        <div class="photo-loc ${p.lat == null ? 'warn' : ''}">${loc}</div>
        <div class="photo-status">${esc(p.status || '')}</div>
        ${ai}
        <div class="photo-actions">
          ${p.error || !(p.dataUrl || p.fileId) ? '' : `<button type="button" class="btn-mini" data-act="photo-ai" data-id="${p.id}">${p.lat == null ? 'AIで場所を推定' : 'AIでスポット判定'}</button>`}
          ${p.lat == null
            ? `<button type="button" class="btn-mini" data-act="photo-pick" data-id="${p.id}">地図で指定</button>`
            : `<button type="button" class="btn-mini" data-act="photo-focus" data-id="${p.id}">地図で見る</button>
               <button type="button" class="btn-mini" data-act="photo-spot" data-id="${p.id}">スポット登録</button>`}
          <button type="button" class="btn-mini danger" data-act="photo-remove" data-id="${p.id}">外す</button>
        </div>
      </div></li>`;
  }).join('');
}

function drawPhotoMarkers() {
  layers.photos.clearLayers();
  state.photos.forEach(p => {
    if (p.lat == null) return;
    const img = p.dataUrl || p.driveThumb || '';
    p.marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: `<div class="photo-pin" style="background-image:url('${img.replace(/'/g, '%27')}')"></div>`, iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -18] })
    }).bindPopup(`<div class="pop"><div class="pop-cat">写真 ${p.time ? fmtDateTime(p.time) : ''}</div>${img ? `<img class="pop-img" src="${esc(img)}" alt="">` : ''}${p.ai ? `<div class="pop-name">${esc(p.ai.title || '')}</div><p class="pop-note">${esc(p.ai.description || '')}</p>` : ''}</div>`).addTo(layers.photos);
  });
}

function photoHint(p) {
  const t = p.time ? new Date(p.time).getTime() : null;
  let best = null;
  state.photos.forEach(o => {
    if (o === p || o.lat == null) return;
    const d = t && o.time ? Math.abs(new Date(o.time).getTime() - t) : Infinity;
    if (!best || d < best.d) best = { d, o };
  });
  if (best) {
    const min = isFinite(best.d) ? Math.round(best.d / 60000) : null;
    return { lat: best.o.lat, lng: best.o.lng, note: min != null ? `撮影時刻が${min}分違う同じ旅の写真の位置` : '同じ旅の写真の位置' };
  }
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, note: '地図で表示している場所' };
}

async function analyzePhoto(p) {
  loading(true, 'AIが写真を見ています…');
  try {
    let b64 = p.dataUrl ? p.dataUrl.split(',')[1] : '';
    if (!b64 && p.driveThumb) {
      toast('保存済み写真はAI解析できません。もう一度写真を選んでください', 'warn');
      return;
    }
    const small = await (async () => {
      // 解析用は1024pxに縮小して送る
      const img = await fetch(p.dataUrl).then(r => r.blob());
      return (await resizeImage(img, 1024, 0.82)).split(',')[1];
    })().catch(() => b64);
    const hasGps = p.lat != null;
    const r = await api('analyzePhoto', { base64: small, mimeType: 'image/jpeg', hasGps, lat: p.lat, lng: p.lng, hint: hasGps ? {} : photoHint(p) });
    p.ai = r.result;
    p.aiForLocation = !hasGps;
    renderPhotos();
    if (!hasGps && p.ai.lat != null) {
      layers.extra.clearLayers();
      const img = p.dataUrl || '';
      L.marker([p.ai.lat, p.ai.lng], { icon: L.divIcon({ className: '', html: `<div class="photo-pin cand" style="background-image:url('${img}')"></div>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
        .bindTooltip('AIの推定地点：' + (p.ai.placeName || ''), { permanent: false }).addTo(layers.extra);
      map.setView([p.ai.lat, p.ai.lng], Math.max(map.getZoom(), 13));
      if (isMobile()) $('#panel').classList.remove('open');
    }
  } catch (e) { toast(e.message, 'error', 6000); }
  finally { loading(false); }
}

async function registerSpotFromPhoto(p) {
  if (p.lat == null) return;
  const def = (p.ai && p.ai.title) || '';
  const name = prompt('スポット名を入力してください', def);
  if (name == null) return;
  if (!name.trim()) return toast('スポット名を入力してください', 'warn');
  if (!p.fileId) await uploadPendingPhotos();
  try {
    const r = await api('addSpot', {
      spot: {
        category: (p.ai && p.ai.category) || 'other', name: name.trim(), note: (p.ai && p.ai.description) || '',
        lat: p.lat, lng: p.lng, photoFileId: p.fileId || '', source: p.source,
        visibility: $('#spotPublic').checked ? 'public' : 'private'
      }
    });
    const s = r.spot;
    state.userSpots.push({ id: 'u' + s.spotId, spotId: s.spotId, cat: s.category, name: s.name, note: s.note, lat: s.lat, lng: s.lng, photo: s.photoUrl, user: true, mine: true, nickname: s.nickname, visibility: s.visibility });
    toast(r.message + (s.visibility === 'public' ? '（会員に公開）' : '（自分だけ）'));
  } catch (e) { toast(e.message, 'error'); }
}

function photosToWaypoints() {
  const pts = state.photos.filter(p => p.lat != null && p.time).sort((a, b) => a.time.localeCompare(b.time));
  if (pts.length < 2) return toast('位置情報のある写真が2枚以上必要です', 'warn');
  let kept = [];
  pts.forEach(p => {
    const last = kept[kept.length - 1];
    if (!last || hav([last.lat, last.lng], [p.lat, p.lng]) > 150) kept.push(p);
  });
  if (kept.length > 50) kept = downsampleIdx(kept.length, 50).map(i => kept[i]);
  if (kept.length < 2) return toast('写真の撮影地点が近すぎて経由地を作れません', 'warn');
  if (state.waypoints.length && !confirm('いまの地点を、写真の撮影地点で置き換えますか？')) return;
  state.waypoints = kept.map(p => ({ id: uid(), lat: p.lat, lng: p.lng, name: '📷 ' + fmtDateTime(p.time) }));
  renderWaypoints();
  switchTab('route');
  map.fitBounds(L.latLngBounds(kept.map(p => [p.lat, p.lng])), { padding: [40, 40] });
  toast(`写真から${kept.length}か所の地点を作りました。「ルートを引く」で道路に沿った経路にできます`, 'info', 6000);
}

function photosToTrack() {
  const pts = state.photos.filter(p => p.lat != null).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (pts.length < 2) return toast('位置情報のある写真が2枚以上必要です', 'warn');
  state.waypoints = []; renderWaypoints();
  setRoute({ coords: pts.map(p => [p.lat, p.lng, null]), times: pts.map(p => p.time ? new Date(p.time).getTime() : null), source: 'photos' });
  $('#routeInfo').textContent = '写真の撮影地点を撮影順に直線で結んでいます。';
}

/* ---------------- 走行記録 ---------------- */
async function startRecord() {
  if (!navigator.geolocation) return toast('この端末ではGPSを使えません', 'warn');
  if (state.route && !confirm('いま表示中のルートは記録終了時に置き換わります。記録を始めますか？')) return;
  const rec = state.recording;
  rec.active = true; rec.points = []; rec.startedAt = Date.now();
  layers.record.clearLayers();
  rec.line = L.polyline([], { color: '#B8432F', weight: 5 }).addTo(layers.record);
  rec.watchId = navigator.geolocation.watchPosition(onRecordPos, err => {
    toast('GPSを取得できません：' + (err.code === 1 ? '位置情報の利用を許可してください' : err.message), 'warn');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  try { if (navigator.wakeLock) rec.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応 */ }
  rec.timer = setInterval(updateRecordUi, 1000);
  $('#recStartBtn').hidden = true; $('#recStopBtn').hidden = false; $('#recBadge').hidden = false;
  updateRecordUi();
  toast('記録を始めました');
}

function onRecordPos(pos) {
  const { latitude, longitude, altitude, accuracy } = pos.coords;
  if (accuracy > 50) return;
  const pts = state.recording.points;
  const last = pts[pts.length - 1];
  if (last && hav(last, [latitude, longitude]) < 8) return;
  pts.push([latitude, longitude, altitude != null ? Math.round(altitude * 10) / 10 : null, pos.timestamp]);
  state.recording.line.addLatLng([latitude, longitude]);
  if (pts.length === 1) map.setView([latitude, longitude], Math.max(map.getZoom(), 15));
  if (pts.length % 5 === 0) store.set(REC_KEY, JSON.stringify({ startedAt: state.recording.startedAt, points: pts }));
  updateRecordUi();
}

function recordDistanceKm(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += hav(pts[i - 1], pts[i]);
  return d / 1000;
}

function updateRecordUi() {
  const rec = state.recording;
  const km = recordDistanceKm(rec.points);
  const sec = Math.floor((Date.now() - rec.startedAt) / 1000);
  const t = `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;
  $('#recDist').textContent = km.toFixed(2);
  $('#recTime').textContent = t;
  $('#recBadgeText').textContent = `記録中 ${km.toFixed(2)}km`;
}

function stopRecord() {
  const rec = state.recording;
  if (rec.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  clearInterval(rec.timer);
  try { if (rec.wakeLock) rec.wakeLock.release(); } catch (e) { /* noop */ }
  rec.active = false; rec.watchId = null; rec.wakeLock = null;
  $('#recStartBtn').hidden = false; $('#recStopBtn').hidden = true; $('#recBadge').hidden = true;
  layers.record.clearLayers();
  store.del(REC_KEY);
  if (rec.points.length < 2) return toast('記録された地点が少ないため、ルートにできませんでした', 'warn');
  state.waypoints = []; renderWaypoints();
  setRoute({ coords: rec.points.map(p => [p[0], p[1], p[2]]), times: rec.points.map(p => p[3]), source: 'record' });
  state.importName = `${fmtDate(rec.startedAt)} の走行記録`;
  switchTab('route');
  $('#routeInfo').textContent = '走行記録からルートを作りました。「保存する」で残せます。';
  toast('記録を終了しました');
}

function restoreRecordingBackup() {
  const raw = store.get(REC_KEY);
  if (!raw) return;
  try {
    const b = JSON.parse(raw);
    if (!b.points || b.points.length < 2) { store.del(REC_KEY); return; }
    const km = recordDistanceKm(b.points).toFixed(2);
    if (confirm(`前回の走行記録（${km}km）が残っています。ルートとして読み込みますか？`)) {
      setRoute({ coords: b.points.map(p => [p[0], p[1], p[2]]), times: b.points.map(p => p[3]), source: 'record' });
      state.importName = `${fmtDate(b.startedAt)} の走行記録`;
    }
    store.del(REC_KEY);
  } catch (e) { store.del(REC_KEY); }
}

/* ---------------- GPX ---------------- */
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPXファイルを読み取れませんでした');
  const tag = (n, t) => { const e = n.getElementsByTagName(t)[0]; return e ? e.textContent.trim() : ''; };
  let pts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!pts.length) pts = Array.from(doc.getElementsByTagName('rtept'));
  const coords = [], times = [];
  pts.forEach(n => {
    const lat = parseFloat(n.getAttribute('lat')), lng = parseFloat(n.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lng)) return;
    const e = parseFloat(tag(n, 'ele'));
    coords.push([lat, lng, isFinite(e) ? e : null]);
    const t = Date.parse(tag(n, 'time'));
    times.push(isFinite(t) ? t : null);
  });
  const wpts = Array.from(doc.getElementsByTagName('wpt')).map(n => ({
    lat: parseFloat(n.getAttribute('lat')), lng: parseFloat(n.getAttribute('lon')), name: tag(n, 'name')
  })).filter(w => isFinite(w.lat) && isFinite(w.lng));
  const trk = doc.getElementsByTagName('trk')[0] || doc.getElementsByTagName('rte')[0];
  const meta = doc.getElementsByTagName('metadata')[0];
  const name = (trk && tag(trk, 'name')) || (meta && tag(meta, 'name')) || '';
  return { coords, times: times.some(t => t != null) ? times : null, wpts, name };
}

async function importGpxFile(file) {
  try {
    const text = await file.text();
    const g = parseGpx(text);
    if (g.coords.length < 2 && g.wpts.length < 2) throw new Error('GPXに経路の点が見つかりませんでした');
    state.importName = g.name || file.name.replace(/\.gpx$/i, '');
    if (g.coords.length >= 2) {
      state.waypoints = []; renderWaypoints();
      setRoute({ coords: g.coords, times: g.times, source: 'gpx' });
      state.importedWpts = g.wpts;
      layers.extra.clearLayers();
      g.wpts.forEach(w => L.marker([w.lat, w.lng], { icon: spotIcon({ cat: 'other' }) }).bindTooltip(w.name || 'ウェイポイント').addTo(layers.extra));
      $('#routeInfo').textContent = `GPX「${state.importName}」を読み込みました（${g.coords.length}点）。`;
    } else {
      clearRoute();
      state.waypoints = g.wpts.map(w => ({ id: uid(), lat: w.lat, lng: w.lng, name: w.name }));
      renderWaypoints();
      map.fitBounds(L.latLngBounds(g.wpts.map(w => [w.lat, w.lng])), { padding: [40, 40] });
      $('#routeInfo').textContent = 'GPXのウェイポイントを地点として読み込みました。「ルートを引く」で経路を作れます。';
    }
    switchTab('route');
    toast('GPXを読み込みました');
  } catch (e) { toast(e.message, 'error'); }
}

function buildGpx({ name, wp = true, spots = false, photos = false } = {}) {
  const r = state.route;
  const x = escXml;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx version="1.1" creator="CycleNavi" xmlns="http://www.topografix.com/GPX/1/1">');
  out.push(`<metadata><name>${x(name)}</name><time>${new Date().toISOString()}</time></metadata>`);
  const n = state.waypoints.length;
  if (wp) {
    state.waypoints.forEach((w, i) => {
      const label = w.name || (i === 0 ? '出発地' : i === n - 1 ? '目的地' : '経由地' + i);
      out.push(`<wpt lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}"><name>${x(label)}</name><type>waypoint</type></wpt>`);
    });
    state.importedWpts.forEach(w => out.push(`<wpt lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}"><name>${x(w.name || 'ウェイポイント')}</name></wpt>`));
  }
  if (spots) {
    state.spots.forEach(s => out.push(`<wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}"><name>${x(s.name)}</name><type>${x((CATS[s.cat] || CATS.other).label)}</type></wpt>`));
  }
  if (photos) {
    state.photos.filter(p => p.lat != null).forEach(p => {
      out.push(`<wpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><name>${x('写真 ' + (p.time ? fmtDateTime(p.time) : ''))}</name>${p.driveThumb ? `<link href="${x(p.driveThumb)}"><text>写真</text></link>` : ''}<type>photo</type></wpt>`);
    });
  }
  out.push(`<trk><name>${x(name)}</name><trkseg>`);
  r.coords.forEach((c, i) => {
    const ele = c[2] != null && isFinite(c[2]) ? `<ele>${Number(c[2]).toFixed(1)}</ele>` : '';
    const t = r.times && r.times[i] ? `<time>${new Date(r.times[i]).toISOString()}</time>` : '';
    out.push(`<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}">${ele}${t}</trkpt>`);
  });
  out.push('</trkseg></trk>');
  out.push('</gpx>');
  return out.join('\n');
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function defaultTitle() {
  if (state.meta) return state.meta.title;
  if (state.importName) return state.importName;
  const a = state.waypoints[0], b = state.waypoints[state.waypoints.length - 1];
  if (a && b && a.name && b.name && a !== b) return `${a.name.replace('📷 ', '')} → ${b.name.replace('📷 ', '')}`;
  return `${fmtDate(new Date())} のルート`;
}

/* ---------------- 保存 ---------------- */
function openSaveModal() {
  if (!state.route) return;
  const f = $('#saveForm');
  const s = state.route.stats;
  f.title.value = defaultTitle();
  f.description.value = state.meta && state.meta.isOwner ? (state.meta.description || '') : '';
  const vis = state.meta && state.meta.isOwner ? state.meta.visibility : 'private';
  f.querySelector(`input[name="visibility"][value="${vis}"]`).checked = true;
  f.asNew.checked = false;
  $('#saveAsNewRow').hidden = !(state.meta && state.meta.isOwner);
  $('#saveTitle').textContent = state.meta && state.meta.isOwner ? 'ルートを上書き保存' : 'ルートを保存';
  $('#saveStats').textContent = `距離 ${s.distanceKm.toFixed(1)}km${s.hasEle ? `／獲得標高 ${s.ascentM}m／最高地点 ${s.maxEleM}m` : ''}`;
  openModal('saveModal');
}

async function saveRoute(e) {
  e.preventDefault();
  const f = e.target;
  const r = state.route;
  if (!r) return;
  const title = f.title.value.trim();
  if (!title) return toast('タイトルを入力してください', 'warn');
  loading(true, '保存しています…');
  try {
    await uploadPendingPhotos();
    const idx = downsampleIdx(r.coords.length, CONFIG.MAX_SAVE_POINTS);
    const coords = idx.map(i => {
      const c = r.coords[i];
      return [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6, c[2] == null ? null : Math.round(c[2] * 10) / 10];
    });
    const overwrite = state.meta && state.meta.isOwner && !f.asNew.checked;
    const s = r.stats;
    const payload = {
      routeId: overwrite ? state.meta.routeId : null,
      title, description: f.description.value.trim(),
      visibility: f.querySelector('input[name="visibility"]:checked').value,
      profile: state.profile, condition: state.condition, source: r.source,
      stats: { distanceKm: s.distanceKm, ascentM: s.ascentM, descentM: s.descentM, maxEleM: s.maxEleM, maxGrade: s.maxGrade },
      coords,
      waypoints: state.waypoints.map(w => ({ lat: w.lat, lng: w.lng, name: w.name })),
      spots: state.spots.slice(0, 300).map(sp => ({ cat: sp.cat, name: sp.name, lat: sp.lat, lng: sp.lng, km: sp.km != null ? Math.round(sp.km * 10) / 10 : null, off: sp.off != null ? Math.round(sp.off) : null, user: !!sp.user, note: sp.note || '', photo: sp.photo || '' })),
      photos: state.photos.filter(p => p.fileId).map(p => ({ fileId: p.fileId, thumbUrl: p.driveThumb, lat: p.lat, lng: p.lng, time: p.time, title: p.ai ? p.ai.title : '' })),
      gpx: buildGpx({ name: title, wp: true, spots: false, photos: true })
    };
    const res = await api('saveRoute', { route: payload });
    state.meta = { routeId: res.routeId, title, description: payload.description, visibility: res.visibility, isOwner: true, nickname: state.user.nickname };
    renderCurrent();
    closeModal('saveModal');
    toast(res.message);
    if (state.activeTab === 'mine') loadMine();
  } catch (err) { toast(err.message, 'error', 6000); }
  finally { loading(false); }
}

/* ---------------- ルート一覧・詳細 ---------------- */
const ROUTE_PH = '<div class="route-thumb ph"><svg viewBox="0 0 52 30" aria-hidden="true"><path d="M2 26 L12 16 L18 20 L30 6 L38 14 L50 10" fill="none" stroke="#7B2CBF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

function routeCard(r, mine) {
  return `<div class="route-card">
    ${r.thumbUrl ? `<img class="route-thumb" src="${esc(r.thumbUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ROUTE_PH}
    <div class="route-tx">
      <h4>${esc(r.title)}${mine ? `<span class="vis ${r.visibility}">${r.visibility === 'public' ? '公開' : '非公開'}</span>` : ''}</h4>
      <div class="by">${mine ? '' : esc(r.nickname) + ' さん　'}${fmtDate(r.updatedAt)}</div>
      <div class="route-nums">
        <span>${r.distanceKm.toFixed(1)}<small>km</small></span>
        <span>${r.ascentM.toLocaleString()}<small>m上り</small></span>
        <span>♥ ${r.likeCount}</span><span>💬 ${r.commentCount}</span>
      </div>
      <div class="card-actions">
        <button type="button" class="btn-mini" data-act="route-detail" data-id="${r.routeId}">詳細・コメント</button>
        <button type="button" class="btn-mini primary" data-act="route-load" data-id="${r.routeId}">地図に表示</button>
        ${mine ? `<button type="button" class="btn-mini danger" data-act="route-del" data-id="${r.routeId}">削除</button>` : ''}
      </div>
    </div></div>`;
}

async function loadPublic() {
  const box = $('#pubList');
  box.innerHTML = '<p class="empty">読み込み中…</p>';
  try {
    const r = await api('listPublicRoutes', { q: $('#pubQuery').value, sort: $('#pubSort').value });
    box.innerHTML = r.routes.length ? r.routes.map(x => routeCard(x, false)).join('')
      : '<p class="empty">公開ルートが見つかりませんでした。条件を変えて探すか、自分のルートを公開してみてください。</p>';
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

async function loadMine() {
  const box = $('#mineList');
  box.innerHTML = '<p class="empty">読み込み中…</p>';
  try {
    const r = await api('listMyRoutes');
    box.innerHTML = r.routes.length ? r.routes.map(x => routeCard(x, true)).join('')
      : '<p class="empty">保存したルートはまだありません。「ルート」タブで作って保存しましょう。</p>';
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

async function fetchRoute(routeId) {
  const r = await api('getRoute', { routeId });
  state.detail = r.route;
  state.detailComments = r.comments;
  return r.route;
}

async function openDetail(routeId) {
  loading(true, '読み込み中…');
  try {
    await fetchRoute(routeId);
    renderDetail();
    openModal('detailModal');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading(false); }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $('#detailTitle').textContent = d.title;
  $('#detailBy').textContent = `${d.nickname} さん　${fmtDate(d.updatedAt)} 更新　${d.visibility === 'public' ? '会員に公開' : '非公開'}`;
  const data = d.data || {};
  const st = data.stats || {};
  const photos = (data.photos || []).filter(p => p.thumbUrl);
  const heart = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-10-9.2C.4 8.6 2.3 4.5 6.2 4.5c2.2 0 3.6 1.3 4.3 2.4.4.6 1 .6 1.4 0 .7-1.1 2.1-2.4 4.3-2.4 3.9 0 5.8 4.1 4.2 7.3C19.5 16.4 12 21 12 21z"/></svg>';
  const comments = state.detailComments.map(c => `
    <li class="comment" data-cid="${c.commentId}">
      <div class="who">${esc(c.nickname)}<small>${fmtDateTime(c.createdAt)}${c.updatedAt ? '（編集済み）' : ''}</small></div>
      <p class="cbody">${esc(c.body)}</p>
      ${c.canEdit || c.canDelete ? `<div class="card-actions">
        ${c.canEdit ? `<button type="button" class="btn-mini" data-act="comment-edit" data-id="${c.commentId}">編集</button>` : ''}
        ${c.canDelete ? `<button type="button" class="btn-mini danger" data-act="comment-del" data-id="${c.commentId}">削除</button>` : ''}
      </div>` : ''}
    </li>`).join('');
  $('#detailBody').innerHTML = `
    <div class="detail-nums">
      <div>${Number(d.distanceKm).toFixed(1)}<small>距離 km</small></div>
      <div>${Number(d.ascentM).toLocaleString()}<small>獲得標高 m</small></div>
      <div>${Number(d.maxEleM).toLocaleString()}<small>最高地点 m</small></div>
      <div>${st.maxGrade != null ? Number(st.maxGrade).toFixed(1) : '–'}<small>最大勾配 %</small></div>
    </div>
    <p class="note">${esc(PROFILES[d.profile] || '')}${d.condition && CONDITIONS[d.condition] ? '／' + CONDITIONS[d.condition] : ''}</p>
    ${d.description ? `<p class="detail-desc">${esc(d.description)}</p>` : ''}
    ${photos.length ? `<div class="detail-photos">${photos.slice(0, 12).map(p => `<img src="${esc(p.thumbUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
    <div class="flex flex-wrap gap-2 items-center mb-4">
      <button type="button" class="like-btn" data-act="like" aria-pressed="${d.liked}">${heart}<span>いいね！ ${d.likeCount}</span></button>
      <button type="button" class="btn btn-primary" data-act="detail-load">地図に表示</button>
      ${d.isOwner ? '<button type="button" class="btn btn-danger" data-act="detail-del">削除</button>' : ''}
    </div>
    <h3 class="h">コメント（${state.detailComments.length}）</h3>
    <ul class="comments">${comments || '<li class="empty">まだコメントはありません。</li>'}</ul>
    <form id="commentForm">
      <label class="field"><span>コメントを書く</span><textarea class="input" name="body" maxlength="500" required placeholder="走った感想や、路面・補給の情報など"></textarea></label>
      <button type="submit" class="btn btn-primary">投稿する</button>
    </form>`;
  $('#commentForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try {
      const r = await api('addComment', { routeId: d.routeId, body });
      state.detailComments = r.comments;
      renderDetail();
      toast('コメントを投稿しました');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function editCommentInline(cid) {
  const li = $(`.comment[data-cid="${cid}"]`);
  const c = state.detailComments.find(x => x.commentId === cid);
  if (!li || !c) return;
  li.querySelector('.cbody').outerHTML = `<div class="cedit"><textarea class="input" maxlength="500">${esc(c.body)}</textarea>
    <div class="card-actions"><button type="button" class="btn-mini primary" data-act="comment-save" data-id="${cid}">保存する</button>
    <button type="button" class="btn-mini" data-act="comment-cancel">やめる</button></div></div>`;
  const acts = li.querySelector('.card-actions:not(.cedit .card-actions)');
  if (acts) acts.remove();
  li.querySelector('textarea').focus();
}

function loadRouteData(d) {
  const data = d.data || {};
  state.profile = data.profile || d.profile || 'cycling-regular';
  state.condition = data.condition || d.condition || 'flat';
  $('#profileSel').value = PROFILES[state.profile] ? state.profile : 'cycling-regular';
  const radio = $(`input[name="cond"][value="${state.condition}"]`);
  if (radio) radio.checked = true;
  $('#condNote').textContent = COND_NOTES[state.condition] || '';
  state.waypoints = (data.waypoints || []).map(w => ({ id: uid(), lat: Number(w.lat), lng: Number(w.lng), name: w.name || '' }));
  renderWaypoints();
  state.importedWpts = [];
  layers.extra.clearLayers();
  setRoute({ coords: data.coords || [], source: data.source || d.source || 'saved' }, { fit: true });
  state.meta = { routeId: d.routeId, title: d.title, description: d.description, visibility: d.visibility, isOwner: d.isOwner, nickname: d.nickname };
  renderCurrent();
  state.spots = (data.spots || []).map((s, i) => Object.assign({ id: 'saved' + i, cat: CATS[s.cat] ? s.cat : 'other' }, s));
  drawSpots(); renderSpotList();
  if (state.spots.length) $('#spotSummary').textContent = `保存時のスポット ${state.spots.length}件を表示しています。`;
  state.photos = (data.photos || []).filter(p => p.fileId).map(p => ({
    id: uid(), name: '', status: 'ドライブに保存済み', lat: p.lat, lng: p.lng, time: p.time, source: 'saved',
    fileId: p.fileId, driveThumb: p.thumbUrl, dataUrl: '', ai: p.title ? { title: p.title, description: '', category: 'other' } : null, error: false
  }));
  renderPhotos(); drawPhotoMarkers();
  $('#routeInfo').textContent = `「${d.title}」を表示しています。`;
  switchTab('route');
  if (isMobile()) $('#panel').classList.remove('open');
}

async function loadRouteById(routeId) {
  loading(true, 'ルートを読み込んでいます…');
  try {
    const d = await fetchRoute(routeId);
    loadRouteData(d);
    closeModal('detailModal');
  } catch (e) { toast(e.message, 'error'); }
  finally { loading(false); }
}

async function deleteRoute(routeId, title) {
  if (!confirm(`「${title || 'このルート'}」を削除しますか？コメントといいねも消え、元に戻せません。`)) return;
  loading(true, '削除しています…');
  try {
    const r = await api('deleteRoute', { routeId });
    if (state.meta && state.meta.routeId === routeId) { state.meta = null; renderCurrent(); }
    closeModal('detailModal');
    toast(r.message);
    loadMine();
  } catch (e) { toast(e.message, 'error'); }
  finally { loading(false); }
}

/* ---------------- 認証 ---------------- */
function setAuthMsg(text, type = 'err', el = '#authMsg') {
  const m = $(el);
  if (!text) { m.hidden = true; return; }
  m.hidden = false; m.className = 'msg ' + type; m.textContent = text;
}

function openAuth(view) {
  $$('.auth-view').forEach(v => { v.hidden = v.dataset.view !== view; });
  setAuthMsg('');
  openModal('authModal');
}

function clearSession() {
  state.token = ''; state.user = null;
  store.del(TOKEN_KEY);
  $('#userBtn').hidden = true;
  $('#userMenu').hidden = true;
}

function onLoggedIn(user) {
  state.user = user;
  $('#userBtn').hidden = false;
  $('#userName').textContent = user.nickname;
  $('#userInitial').textContent = (user.nickname || '?').slice(0, 1);
  $('#userEmail').textContent = user.email;
  closeModal('authModal');
  if (user.mustChange) openPwModal(true);
  else loadUserSpots();
}

function openPwModal(forced) {
  const m = $('#pwModal');
  m.dataset.locked = forced ? 'true' : 'false';
  m.querySelector('.modal-close').hidden = !!forced;
  $('#pwForcedLinks').hidden = !forced;
  $('#pwTitle').textContent = forced ? '本パスワードを設定してください' : 'パスワードを変更';
  $('#pwCurLabel').textContent = forced ? 'メールで届いた仮パスワード' : '現在のパスワード';
  $('#pwLead').textContent = forced
    ? '仮パスワードでログインしました。引き続き使うために、英字と数字を含む8文字以上の本パスワードを設定してください。'
    : '英字と数字を含む8文字以上で設定してください。';
  $('#pwForm').reset();
  setAuthMsg('', 'err', '#pwMsg');
  openModal('pwModal');
}

async function logout() {
  try { await api('logout'); } catch (e) { /* 無視 */ }
  clearSession();
  closeModal('pwModal');
  clearRoute();
  state.waypoints = []; renderWaypoints();
  state.photos = []; renderPhotos(); layers.photos.clearLayers();
  state.userSpots = []; state.userSpotsLoaded = false;
  openAuth('login');
}

function bindAuth() {
  $$('[data-auth]').forEach(b => b.addEventListener('click', () => openAuth(b.dataset.auth)));

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    setAuthMsg('');
    loading(true, 'ログインしています…');
    try {
      const r = await api('login', { email: f.email.value, password: f.password.value });
      state.token = r.token;
      store.set(TOKEN_KEY, r.token);
      f.password.value = '';
      onLoggedIn(r.user);
      if (!r.user.mustChange) toast(`${r.user.nickname} さん、ようこそ`);
      restoreRecordingBackup();
    } catch (err) { setAuthMsg(err.message); }
    finally { loading(false); }
  });

  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    loading(true, '送信しています…');
    try {
      const r = await api('register', { email: f.email.value, nickname: f.nickname.value });
      const email = f.email.value;
      f.reset();
      openAuth('login');
      $('#loginForm').email.value = email;
      setAuthMsg(r.message, 'ok');
    } catch (err) { setAuthMsg(err.message); }
    finally { loading(false); }
  });

  $('#resetForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    loading(true, '送信しています…');
    try {
      const r = await api('resetPassword', { email: f.email.value });
      const email = f.email.value;
      f.reset();
      openAuth('login');
      $('#loginForm').email.value = email;
      setAuthMsg(r.message + '。届いた仮パスワードでログインしてください', 'ok');
    } catch (err) { setAuthMsg(err.message); }
    finally { loading(false); }
  });

  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (f.next.value !== f.confirm.value) return setAuthMsg('新しいパスワードが確認欄と一致しません', 'err', '#pwMsg');
    if (f.next.value.length < 8 || !/[A-Za-z]/.test(f.next.value) || !/\d/.test(f.next.value)) {
      return setAuthMsg('英字と数字を含む8文字以上にしてください', 'err', '#pwMsg');
    }
    loading(true, '変更しています…');
    try {
      const r = await api('changePassword', { currentPassword: f.current.value, newPassword: f.next.value });
      const wasForced = $('#pwModal').dataset.locked === 'true';
      state.user = r.user;
      $('#pwModal').dataset.locked = 'false';
      closeModal('pwModal');
      toast(r.message);
      if (wasForced) { loadUserSpots(); toast(`${r.user.nickname} さん、ようこそ`); }
    } catch (err) { setAuthMsg(err.message, 'err', '#pwMsg'); }
    finally { loading(false); }
  });
  $('#pwLogout').addEventListener('click', logout);
}

function setupPwEyes() {
  const on = '<svg class="ic-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const off = '<svg class="ic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.8 10.8 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.1-5.9M9.9 5.2A10 10 0 0 1 12 5c7 0 11 7 11 7a19.9 19.9 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/></svg>';
  $$('.pw-eye').forEach(b => {
    b.innerHTML = on + off;
    b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });
  });
}

/* ---------------- モーダル・タブ ---------------- */
function openModal(id) {
  const m = $('#' + id);
  m.hidden = false;
  const first = m.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, button');
  if (first && !isMobile()) setTimeout(() => first.focus(), 30);
}
function closeModal(id) { $('#' + id).hidden = true; }

function switchTab(name) {
  state.activeTab = name;
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  $('.panel-body').scrollTop = 0;
  if (name === 'public') loadPublic();
  if (name === 'mine') loadMine();
}

/* ---------------- アクション（イベント委譲） ---------------- */
function bindActs(root) {
  if (!root) return;
  $$('[data-act]', root).forEach(el => {
    el.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); handleAct(el); };
  });
}

async function handleAct(t) {
  const act = t.dataset.act, id = t.dataset.id;
  const photo = () => state.photos.find(p => p.id === id);
  const spot = () => state.spots.find(s => s.id === id);
  switch (act) {
    case 'wp-up': moveWaypoint(id, -1); break;
    case 'wp-down': moveWaypoint(id, 1); break;
    case 'wp-del':
      state.waypoints = state.waypoints.filter(w => w.id !== id);
      renderWaypoints(); scheduleAutoRoute(); break;
    case 'place-add': {
      const lat = Number(t.dataset.lat), lng = Number(t.dataset.lng);
      addWaypoint(lat, lng, t.dataset.name);
      map.setView([lat, lng], Math.max(map.getZoom(), 13));
      $('#placeResults').innerHTML = ''; $('#placeQuery').value = '';
      break;
    }
    case 'route-new':
      clearRoute(); state.waypoints = []; renderWaypoints(); toast('新しいルートを作れます'); break;
    case 'ele-fetch': fetchElevation(); break;
    case 'cat-toggle':
      if (state.spotCats.has(id)) state.spotCats.delete(id); else state.spotCats.add(id);
      t.setAttribute('aria-pressed', String(state.spotCats.has(id)));
      break;
    case 'spot-focus': {
      const s = spot(); if (!s) break;
      map.setView([s.lat, s.lng], Math.max(map.getZoom(), 15));
      if (isMobile()) $('#panel').classList.remove('open');
      setTimeout(() => s.marker && s.marker.openPopup(), 250);
      break;
    }
    case 'spot-add-wp': { const s = spot(); if (s) { spotToWaypoint(s); map.closePopup(); toast(`「${s.name}」を経由地に追加しました`); } break; }
    case 'spot-del': { const s = spot(); if (s) deleteUserSpot(s); break; }
    case 'photo-ai': { const p = photo(); if (p) analyzePhoto(p); break; }
    case 'photo-pick':
      state.pickPhotoId = id;
      if (isMobile()) $('#panel').classList.remove('open');
      toast('地図をタップして撮影地点を指定してください', 'info', 5000);
      break;
    case 'photo-adopt': {
      const p = photo(); if (!p || !p.ai) break;
      p.lat = p.ai.lat; p.lng = p.ai.lng; p.source = 'ai';
      layers.extra.clearLayers(); renderPhotos(); drawPhotoMarkers();
      toast('AIの推定地点を撮影地点にしました');
      break;
    }
    case 'photo-focus': {
      const p = photo(); if (!p) break;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
      if (isMobile()) $('#panel').classList.remove('open');
      setTimeout(() => p.marker && p.marker.openPopup(), 250);
      break;
    }
    case 'photo-spot': { const p = photo(); if (p) registerSpotFromPhoto(p); break; }
    case 'photo-remove':
      state.photos = state.photos.filter(p => p.id !== id);
      renderPhotos(); drawPhotoMarkers(); break;
    case 'route-detail': openDetail(id); break;
    case 'route-load': loadRouteById(id); break;
    case 'route-del': {
      const card = t.closest('.route-card');
      deleteRoute(id, card ? card.querySelector('h4').firstChild.textContent : '');
      break;
    }
    case 'detail-load': if (state.detail) { loadRouteData(state.detail); closeModal('detailModal'); } break;
    case 'detail-del': if (state.detail) deleteRoute(state.detail.routeId, state.detail.title); break;
    case 'like': {
      const d = state.detail; if (!d) break;
      t.disabled = true;
      try {
        const r = await api('toggleLike', { routeId: d.routeId });
        d.liked = r.liked; d.likeCount = r.likeCount;
        renderDetail();
        if (state.activeTab === 'public') loadPublic();
      } catch (e) { toast(e.message, 'error'); t.disabled = false; }
      break;
    }
    case 'comment-edit': editCommentInline(id); break;
    case 'comment-cancel': renderDetail(); break;
    case 'comment-save': {
      const body = t.closest('.comment').querySelector('textarea').value.trim();
      if (!body) return toast('コメントを入力してください', 'warn');
      try {
        const r = await api('editComment', { commentId: id, body });
        state.detailComments = r.comments; renderDetail(); toast('コメントを更新しました');
      } catch (e) { toast(e.message, 'error'); }
      break;
    }
    case 'comment-del':
      if (!confirm('このコメントを削除しますか？')) break;
      try {
        const r = await api('deleteComment', { commentId: id });
        state.detailComments = r.comments; renderDetail(); toast('コメントを削除しました');
      } catch (e) { toast(e.message, 'error'); }
      break;
    default: break;
  }
}

/* ---------------- UI バインド ---------------- */
function bindUI() {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (t) { handleAct(t); return; }
    const c = e.target.closest('[data-close]');
    if (c) closeModal(c.dataset.close);
    if (!e.target.closest('#userMenu') && !e.target.closest('#userBtn')) {
      $('#userMenu').hidden = true; $('#userBtn').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $$('.modal').forEach(m => { if (!m.hidden && m.dataset.locked !== 'true') m.hidden = true; });
  });
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m && m.dataset.locked !== 'true') m.hidden = true;
  }));

  // タブ・シート
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    const same = state.activeTab === t.dataset.tab;
    switchTab(t.dataset.tab);
    if (isMobile()) {
      const p = $('#panel');
      if (same) p.classList.toggle('open'); else p.classList.add('open');
    }
  }));
  $('#sheetHandle').addEventListener('click', () => $('#panel').classList.toggle('open'));

  // スマホ：下のパネル・標高ドックをまとめて隠す／戻す
  $('#uiToggle').addEventListener('click', () => {
    const hidden = document.body.classList.toggle('ui-hidden');
    if (hidden) $('#panel').classList.remove('open');
    $('#uiToggle').setAttribute('aria-pressed', String(hidden));
    $('#uiToggle').setAttribute('aria-label', hidden ? '下のパネルを表示' : '下のパネルを隠す');
    $('#uiToggleText').textContent = hidden ? '表示' : '隠す';
  });

  // ユーザーメニュー
  $('#userBtn').addEventListener('click', () => {
    const m = $('#userMenu'); m.hidden = !m.hidden;
    $('#userBtn').setAttribute('aria-expanded', String(!m.hidden));
  });
  $('#menuPw').addEventListener('click', () => { $('#userMenu').hidden = true; openPwModal(false); });
  $('#menuLogout').addEventListener('click', () => { $('#userMenu').hidden = true; logout(); });

  // ルート
  $('#placeForm').addEventListener('submit', e => { e.preventDefault(); searchPlace($('#placeQuery').value); });
  $('#addHereBtn').addEventListener('click', () => locateMe(true));
  $('#loopBtn').addEventListener('click', () => {
    if (!state.waypoints.length) return toast('先に出発地を指定してください', 'warn');
    const s = state.waypoints[0];
    addWaypoint(s.lat, s.lng, '出発地に戻る');
  });
  $('#clearBtn').addEventListener('click', () => {
    if ((state.route || state.waypoints.length) && !confirm('地点とルートをすべて消しますか？')) return;
    state.waypoints = []; renderWaypoints(); clearRoute();
  });
  $('#profileSel').addEventListener('change', e => { state.profile = e.target.value; scheduleAutoRoute(); });
  $$('input[name="cond"]').forEach(r => r.addEventListener('change', e => {
    state.condition = e.target.value;
    $('#condNote').textContent = COND_NOTES[state.condition];
    scheduleAutoRoute();
  }));
  $('#condNote').textContent = COND_NOTES[state.condition];
  $('#calcBtn').addEventListener('click', calcRoute);
  $('#saveOpenBtn').addEventListener('click', openSaveModal);
  $('#saveForm').addEventListener('submit', saveRoute);
  const openGpx = () => {
    if (!state.route) return;
    const f = $('#gpxForm');
    f.name.value = defaultTitle();
    f.spots.checked = false; f.spots.disabled = !state.spots.length;
    f.photos.checked = false; f.photos.disabled = !state.photos.some(p => p.lat != null);
    openModal('gpxModal');
  };
  $('#gpxOpenBtn').addEventListener('click', openGpx);
  $('#gpxOpenBtn2').addEventListener('click', openGpx);
  $('#gpxForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim() || 'route';
    const gpx = buildGpx({ name, wp: f.wp.checked, spots: f.spots.checked, photos: f.photos.checked });
    downloadText(gpx, name.replace(/[\\/:*?"<>|]+/g, '_') + '.gpx', 'application/gpx+xml');
    closeModal('gpxModal');
    toast('GPXファイルをダウンロードしました');
  });
  $('#adviceBtn').addEventListener('click', async () => {
    const r = state.route; if (!r) return;
    const s = r.stats;
    const summary = {
      distanceKm: s.distanceKm, ascentM: s.ascentM, descentM: s.descentM, maxEleM: s.maxEleM, maxGradePct: s.maxGrade,
      estimatedHours: Math.round(s.hours * 10) / 10, bike: PROFILES[state.profile], condition: CONDITIONS[state.condition],
      start: state.waypoints[0] ? state.waypoints[0].name : '', goal: state.waypoints.length ? state.waypoints[state.waypoints.length - 1].name : '',
      month: new Date().getMonth() + 1,
      spots: state.spots.slice(0, 60).map(x => ({ type: (CATS[x.cat] || CATS.other).label, name: x.name, km: x.km != null ? Math.round(x.km * 10) / 10 : null }))
    };
    loading(true, 'AIが助言を考えています…');
    try {
      const res = await api('routeAdvice', { summary });
      const box = $('#adviceBox');
      box.textContent = res.advice + (state.spots.length ? '' : '\n\n（「スポット」タブで沿道を検索してから依頼すると、補給や宿泊の候補も具体的になります）');
      box.hidden = false;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { toast(e.message, 'error'); }
    finally { loading(false); }
  });

  // スポット
  renderCatChips();
  $('#spotSearchBtn').addEventListener('click', searchSpots);

  // 写真
  $('#photoInput').addEventListener('change', e => { addPhotoFiles(e.target.files); e.target.value = ''; });
  const pd = $('#photoDrop');
  pd.addEventListener('dragover', e => { e.preventDefault(); pd.classList.add('over'); });
  pd.addEventListener('dragleave', () => pd.classList.remove('over'));
  $('#photosToWpBtn').addEventListener('click', photosToWaypoints);
  $('#photosToTrackBtn').addEventListener('click', photosToTrack);

  // 記録・GPX
  $('#recStartBtn').addEventListener('click', startRecord);
  $('#recStopBtn').addEventListener('click', stopRecord);
  $('#gpxInput').addEventListener('change', e => { if (e.target.files[0]) importGpxFile(e.target.files[0]); e.target.value = ''; });

  // 公開ルート
  $('#pubForm').addEventListener('submit', e => { e.preventDefault(); loadPublic(); });
  $('#pubSort').addEventListener('change', loadPublic);

  // ドック
  $('#dockToggle').addEventListener('click', () => {
    const d = $('#dock');
    d.classList.toggle('collapsed');
    $('#dockToggle').setAttribute('aria-expanded', String(!d.classList.contains('collapsed')));
    if (chart) setTimeout(() => chart.resize(), 50);
  });

  // ページ全体のドラッグ＆ドロップ
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++; document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove('dragging'); pd.classList.remove('over');
    if (!state.user) return;
    const files = Array.from(e.dataTransfer.files || []);
    const gpx = files.find(f => /\.gpx$/i.test(f.name));
    const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif)$/i.test(f.name));
    if (gpx) importGpxFile(gpx);
    if (imgs.length) addPhotoFiles(imgs);
    if (!gpx && !imgs.length) toast('GPXファイルか写真をドロップしてください', 'warn');
  });

  window.addEventListener('beforeunload', e => {
    if (state.recording.active) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---------------- 起動 ---------------- */
async function init() {
  const ver = document.getElementById('appVersion');
  if (ver) ver.textContent = 'v' + APP_VERSION;
  console.log('CycleNavi v' + APP_VERSION);
  if (!CONFIG.GAS_URL) console.error('config.js の GAS_URL が設定されていません');
  initMap();
  setupPwEyes();
  bindAuth();
  bindUI();
  renderWaypointList();
  renderPhotos();
  if (!CONFIG.GAS_URL || CONFIG.GAS_URL.includes('XXXX')) toast('config.js の GAS_URL をデプロイしたURLに書き換えてください', 'warn', 10000);
  if (state.token) {
    loading(true, 'ログイン情報を確認しています…');
    try {
      const r = await api('me');
      onLoggedIn(r.user);
      if (!r.user.mustChange) restoreRecordingBackup();
    } catch (e) {
      if ($('#authModal').hidden) openAuth('login');
    } finally { loading(false); }
  } else {
    openAuth('login');
  }
}

document.addEventListener('DOMContentLoaded', init);
