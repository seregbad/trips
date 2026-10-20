'use strict';

/* =========================================================
   Поездки — PWA для журнала «Перемещения 2026»
   Данные: Google Таблица через Apps Script (apps-script/Api.gs).
   Офлайн: все изменения идут через очередь в localStorage
   и отправляются, когда есть сеть.
   ========================================================= */

const LS_SETTINGS = 'trips.settings';
const LS_DATA = 'trips.data';
const LS_QUEUE = 'trips.queue';
const LS_LAST_SOURCE = 'trips.lastSource';
const ARROW = ' → ';
const RECENT_COUNT = 20;
const NO_LINK = 'Нет связи с таблицей';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const SUMMARY_VIEW = [
  { key: 'km', title: 'Рабочий пробег', unit: 'км' },
  { key: 'fuel', title: 'Топливо всего', unit: '₽' },
  { key: 'card', title: 'в т.ч. топливная карта', unit: '₽', sub: true },
  { key: 'own', title: 'в т.ч. свои средства', unit: '₽', sub: true },
  { key: 'repair', title: 'Ремонт', unit: '₽' },
  { key: 'comp', title: 'Компенсация за пробег', unit: '₽' },
  { key: 'minus', title: 'Минус топливо по карте', unit: '₽' },
  { key: 'repairBack', title: 'Возмещение ремонта', unit: '₽' },
  { key: 'bonus', title: 'Бонус от разницы (справка)', unit: '₽', sub: true },
  { key: 'total', title: 'Итого к выплате', unit: '₽', total: true }
];

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmtInt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/* ---------------- хранилище ---------------- */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватный режим и т.п. */ }
}

let settings = load(LS_SETTINGS, { url: '', key: '' });
let data = load(LS_DATA, null);          // { year, months, routes, objects, days: {date: rec}, summary, loadedAt }
let queue = load(LS_QUEUE, []);          // [{ id, action, payload, status, error, current }]
let syncing = false;
let lastSyncError = '';

const saveData = () => store(LS_DATA, data);
const saveQueue = () => store(LS_QUEUE, queue);

/* ---------------- даты и числа ---------------- */

const pad = (n) => (n < 10 ? '0' : '') + n;
function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayIso() { return isoOf(new Date()); }
function shiftIso(s, days) { const d = parseIso(s); d.setDate(d.getDate() + days); return isoOf(d); }
function shortDate(s) { const d = parseIso(s); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + WD_SHORT[d.getDay()]; }

/** '' — пусто, null — ошибка ввода, иначе число */
function parseNum(v) {
  const s = String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return '';
  const n = Number(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 100) / 100;
}
const showNum = (v) => (v === '' || v == null ? '' : String(v).replace('.', ','));

function normRoute(r) {
  return String(r || '').split('→').map((s) => s.trim()).filter(Boolean).join(ARROW);
}

/* ---------------- вид данных с учётом очереди ---------------- */

function queuedDay(date) {
  return queue.find((q) => q.action === 'saveDay' && q.payload.date === date);
}
function hasData(r) {
  return !!r && ['route', 'km', 'fuel', 'source', 'repair', 'comment'].some((k) => r[k] !== '' && r[k] != null);
}
/** День так, как его видит пользователь: неотправленная правка поверх данных таблицы */
function viewDay(date) {
  const q = queuedDay(date);
  if (q) return Object.assign({}, q.payload, { pending: true, status: q.status });
  return data && data.days[date] ? Object.assign({}, data.days[date]) : null;
}
function allRoutes() {
  const map = new Map();
  (data ? data.routes : []).forEach((r) => map.set(r.route, r.km));
  queue.forEach((q) => {
    if (q.action === 'addRoute' && !map.has(q.payload.route)) map.set(q.payload.route, q.payload.km);
    if (q.action === 'saveDay' && q.payload.route && !map.has(q.payload.route)) map.set(q.payload.route, q.payload.km);
  });
  return [...map].map(([route, km]) => ({ route, km }));
}
let localObjects = [];
function allObjects() {
  const set = new Set(data ? data.objects : []);
  allRoutes().forEach((r) => r.route.split(ARROW).forEach((o) => set.add(o)));
  localObjects.forEach((o) => set.add(o));
  return [...set];
}
function monthMeta(date) {
  const m = parseIso(date).getMonth();
  const meta = data && data.months && data.months[m];
  return meta || { fuel: true, source: true, repair: true, comment: true };
}

/* ---------------- API ---------------- */

class ApiError extends Error {
  constructor(msg, network) { super(msg); this.network = !!network; }
}

async function api(action, payload) {
  if (!settings.url || !settings.key) throw new ApiError('Не настроены адрес и ключ', false);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(settings.url, {
      method: 'POST',
      // text/plain — без предварительного CORS-запроса, который Apps Script не поддерживает
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: settings.key, action }, payload || {})),
      redirect: 'follow',
      signal: ctrl.signal
    });
  } catch (e) {
    throw new ApiError(NO_LINK, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError('Apps Script ответил не JSON. Проверьте, что доступ к веб-приложению — «Все» и адрес оканчивается на /exec', false);
  }
}

function applyServer(res) {
  if (!data) return;
  if (res.routes) data.routes = res.routes;
  if (res.objects) data.objects = res.objects;
  if (res.summary) data.summary = res.summary;
  if (res.day) {
    if (res.day.v) data.days[res.day.date] = res.day;
    else delete data.days[res.day.date];
  }
}

async function loadAll() {
  const res = await api('init');
  if (!res.ok) throw new ApiError(res.error || 'Ошибка загрузки', false);
  const days = {};
  res.days.forEach((d) => { days[d.date] = d; });
  data = { year: res.year, months: res.months, routes: res.routes, objects: res.objects, days, summary: res.summary, loadedAt: Date.now() };
  localObjects = localObjects.filter((o) => !data.objects.includes(o));
  saveData();
}

/** Отправить очередь, затем обновить данные из таблицы */
async function sync(opts) {
  opts = opts || {};
  if (syncing) return;
  if (!settings.url || !settings.key) { renderStatus(); return; }
  if (!navigator.onLine) { renderStatus(); return; }
  syncing = true;
  lastSyncError = '';
  renderStatus();
  let sent = 0;
  try {
    if (!data) await loadAll();
    for (const item of queue.slice()) {
      if (item.status === 'conflict' || item.status === 'error') continue;
      let res;
      try {
        res = await api(item.action, item.payload);
      } catch (e) {
        lastSyncError = e.message;
        if (e.network) break;   // сети нет — остальное отправим позже
        throw e;
      }
      if (res.ok) {
        applyServer(res);
        queue = queue.filter((q) => q.id !== item.id);
        sent++;
      } else if (res.conflict) {
        item.status = 'conflict';
        item.current = res.current;
        applyServer({ day: res.current });
      } else if (/ключ/i.test(res.error || '')) {
        lastSyncError = res.error;
        break;
      } else {
        item.status = 'error';
        item.error = res.error || 'Ошибка';
      }
      saveQueue();
      saveData();
    }
    if (!lastSyncError && (sent || opts.reload || Date.now() - (data.loadedAt || 0) > 5 * 60 * 1000)) {
      await loadAll();
    }
  } catch (e) {
    lastSyncError = e.message;
  } finally {
    syncing = false;
    saveQueue();
    renderAll();
    if (sent) toast('Отправлено в таблицу: ' + sent, 'ok');
    else if (lastSyncError && opts.manual) toast(lastSyncError, 'err');
  }
}

function enqueue(action, payload) {
  if (action === 'saveDay') {
    const old = queuedDay(payload.date);
    if (old) {
      // правка ещё не отправленного дня: сохраняем исходную версию из таблицы
      payload.base = old.payload.base;
      old.payload = payload;
      old.status = 'pending';
      old.error = '';
      saveQueue();
      return;
    }
  }
  if (action === 'addRoute' && queue.some((q) => q.action === 'addRoute' && q.payload.route === payload.route)) return;
  queue.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), action, payload, status: 'pending' });
  saveQueue();
}

/* ---------------- статус ---------------- */

function renderStatus() {
  const dot = $('netDot');
  const pending = queue.filter((q) => q.status === 'pending').length;
  const problems = queue.length - pending;
  let text;
  dot.className = 'dot';
  if (!settings.url || !settings.key) { text = 'Нет настроек'; dot.classList.add('off'); }
  else if (syncing) { text = 'Синхронизация…'; dot.classList.add('busy'); }
  else if (!navigator.onLine) { text = 'Офлайн' + (pending ? ' · ' + pending + ' ждут' : ''); dot.classList.add('off'); }
  else if (lastSyncError) { text = (lastSyncError === NO_LINK ? 'Нет связи' : 'Ошибка') + (pending ? ' · ' + pending + ' ждут' : ''); dot.classList.add('off'); }
  else { text = pending ? pending + ' ждут' : 'Синхронно'; dot.classList.add('on'); }
  if (problems) text += ' · ⚠ ' + problems;
  $('syncText').textContent = text;
  $('lastSync').textContent = data && data.loadedAt
    ? 'Данные из таблицы: ' + new Date(data.loadedAt).toLocaleString('ru-RU')
    : 'Данные ещё не загружены';
}

let toastTimer;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ---------------- экран «Поездка» ---------------- */

const form = { date: todayIso(), route: '', source: '', dirty: false };

function setDate(date) {
  form.date = date;
  form.dirty = false;
  const d = parseIso(date);
  $('dateMain').textContent = d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + (data && d.getFullYear() !== data.year ? ' ' + d.getFullYear() : '');
  $('dateSub').textContent = WEEKDAYS[d.getDay()] + (date === todayIso() ? ' · сегодня' : '');
  $('dateInput').value = date;

  const day = viewDay(date);
  setRoute(day ? day.route : '');
  $('kmInput').value = day ? showNum(day.km) : '';
  $('fuelInput').value = day ? showNum(day.fuel) : '';
  $('repairInput').value = day ? showNum(day.repair) : '';
  $('commentInput').value = day ? day.comment || '' : '';
  setSource(day && day.source ? day.source : '');
  $('repairCard').open = !!(day && (day.repair || day.comment));

  const meta = monthMeta(date);
  $('sourceSeg').classList.toggle('hidden', !meta.source);
  $('noSourceHint').classList.toggle('hidden', meta.source);
  $('repairWrap').classList.toggle('hidden', !meta.repair);
  $('commentWrap').classList.toggle('hidden', !meta.comment);
  $('noRepairHint').classList.toggle('hidden', meta.repair || meta.comment);

  const badge = $('dayBadge');
  const wrongYear = data && d.getFullYear() !== data.year;
  badge.className = 'badge';
  if (wrongYear) badge.textContent = 'Таблица ведётся только за ' + data.year + ' год';
  else if (day && day.status === 'conflict') badge.textContent = '⚠ Конфликт с таблицей — см. «Журнал»';
  else if (day && day.status === 'error') badge.textContent = '⚠ Ошибка отправки — см. «Журнал»';
  else if (day && day.pending) { badge.textContent = '⏳ Изменения ждут отправки'; badge.classList.add('info'); }
  else if (hasData(day)) { badge.textContent = 'День уже заполнен — вы редактируете запись'; badge.classList.add('info'); }
  else badge.classList.add('hidden');
  $('saveBtn').disabled = !!wrongYear;
  $('deleteBtn').classList.toggle('hidden', !hasData(day) || !!wrongYear);
}

function setRoute(route) {
  form.route = route || '';
  const t = $('routeText');
  t.textContent = form.route || 'Выбрать маршрут';
  t.classList.toggle('placeholder', !form.route);
}

function setSource(v) {
  form.source = v;
  document.querySelectorAll('#sourceSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}

function collectForm() {
  const km = parseNum($('kmInput').value);
  const fuel = parseNum($('fuelInput').value);
  const repair = parseNum($('repairInput').value);
  if (km === null) return toast('Пробег: введите число', 'err');
  if (fuel === null) return toast('Заправка: введите число', 'err');
  if (repair === null) return toast('Ремонт: введите число', 'err');
  const meta = monthMeta(form.date);
  const rec = {
    date: form.date,
    route: normRoute(form.route),
    km,
    fuel: meta.fuel ? fuel : '',
    source: meta.source && fuel !== '' ? form.source : '',
    repair: meta.repair ? repair : '',
    comment: meta.comment ? $('commentInput').value.trim() : ''
  };
  if (meta.source && rec.fuel !== '' && !rec.source) return toast('Выберите, чем оплачена заправка', 'err');
  return rec;
}

function baseFor(date) {
  const q = queuedDay(date);
  if (q) return q.payload.base;
  return data && data.days[date] ? data.days[date].v : '';
}

function saveDay() {
  const rec = collectForm();
  if (!rec) return;
  if (!hasData(rec)) return toast('Заполните маршрут, пробег или заправку', 'err');
  if (rec.route && rec.km === '') {
    if (!confirm('Пробег не указан. Сохранить без км?')) return;
  }
  rec.base = baseFor(rec.date);
  enqueue('saveDay', rec);
  if (rec.source) store(LS_LAST_SOURCE, rec.source);
  toast(navigator.onLine ? 'Сохраняю…' : 'Сохранено на телефоне — отправлю, когда будет сеть', 'ok');
  setDate(rec.date);
  renderLog();
  sync();
}

function clearDay() {
  if (!confirm('Очистить ' + shortDate(form.date) + ' в таблице? Маршрут, км, заправка, ремонт и комментарий за этот день будут удалены.')) return;
  enqueue('saveDay', { date: form.date, route: '', km: '', fuel: '', source: '', repair: '', comment: '', base: baseFor(form.date) });
  setDate(form.date);
  renderLog();
  sync();
}

/* ---------------- выбор маршрута ---------------- */

function openSheet(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeSheet(id) { $(id).classList.add('hidden'); if (!document.querySelector('.sheet:not(.hidden)')) document.body.style.overflow = ''; }

function routeUsage() {
  const cnt = {};
  if (data) Object.values(data.days).forEach((d) => { if (d.route) cnt[d.route] = (cnt[d.route] || 0) + 1; });
  return cnt;
}

function renderRouteList() {
  const words = $('routeSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const usage = routeUsage();
  const list = allRoutes()
    .filter((r) => words.every((w) => r.route.toLowerCase().includes(w)))
    .sort((a, b) => (usage[b.route] || 0) - (usage[a.route] || 0) || a.route.localeCompare(b.route, 'ru'));
  const box = $('routeList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty">Ничего не найдено — соберите новый маршрут</div>'; return; }
  list.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.innerHTML = '<div class="item-top"><span></span><span class="km"></span></div>';
    b.querySelector('span').textContent = r.route;
    b.querySelector('.km').textContent = r.km > 0 ? fmt.format(r.km) + ' км' : '';
    b.addEventListener('click', () => pickRoute(r.route, r.km));
    box.appendChild(b);
  });
}

function pickRoute(route, km) {
  form.dirty = true;
  setRoute(route);
  if (km > 0) $('kmInput').value = showNum(km);
  closeSheet('routeSheet');
  closeSheet('buildSheet');
}

/* ---------------- конструктор маршрута ---------------- */

let buildPoints = [];

function renderBuild() {
  const box = $('buildRoute');
  box.innerHTML = '';
  if (!buildPoints.length) box.innerHTML = '<span class="placeholder">Нажимайте точки по порядку</span>';
  else box.textContent = buildPoints.join(ARROW);
  const grid = $('objGrid');
  grid.innerHTML = '';
  allObjects().forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'obj';
    b.textContent = o;
    b.addEventListener('click', () => { buildPoints.push(o); renderBuild(); });
    grid.appendChild(b);
  });
}

function openBuilder() {
  buildPoints = [];
  $('buildKm').value = '';
  $('newObjInput').value = '';
  renderBuild();
  openSheet('buildSheet');
}

function addObject() {
  const name = $('newObjInput').value.replace(/→/g, '').trim();
  if (!name) return;
  if (!allObjects().includes(name)) localObjects.push(name);
  $('newObjInput').value = '';
  buildPoints.push(name);
  renderBuild();
}

function finishBuild() {
  if (buildPoints.length < 2) return toast('Нужно минимум две точки', 'err');
  const km = parseNum($('buildKm').value);
  if (km === null) return toast('Расстояние: введите число', 'err');
  const route = buildPoints.join(ARROW);
  const known = allRoutes().find((r) => r.route === route);
  if (!known || (km > 0 && !(known.km > 0))) enqueue('addRoute', { route, km });
  pickRoute(route, km !== '' ? km : known && known.km);
  sync();
}

/* ---------------- журнал ---------------- */

function renderLog() {
  const cbox = $('conflicts');
  cbox.innerHTML = '';
  queue.filter((q) => q.status === 'conflict' || q.status === 'error').forEach((q) => {
    const c = document.createElement('div');
    c.className = 'card conflict';
    const what = q.action === 'saveDay' ? shortDate(q.payload.date) : 'Маршрут';
    if (q.status === 'conflict') {
      c.innerHTML = '<div class="label"></div><div class="hint">В таблице сейчас:</div><div class="item-route t-cur"></div>' +
        '<div class="hint">Ваш вариант:</div><div class="item-route t-mine"></div>' +
        '<div class="row-2"><button class="btn primary" type="button" data-a="mine">Записать мой</button>' +
        '<button class="btn ghost" type="button" data-a="drop">Оставить таблицу</button></div>';
      c.querySelector('.label').textContent = '⚠ ' + what + ': день изменён в таблице';
      c.querySelector('.t-cur').textContent = describe(q.current);
      c.querySelector('.t-mine').textContent = describe(q.payload);
    } else {
      c.innerHTML = '<div class="label"></div><div class="hint t-err"></div>' +
        '<div class="row-2"><button class="btn primary" type="button" data-a="retry">Повторить</button>' +
        '<button class="btn ghost" type="button" data-a="drop">Удалить</button></div>';
      c.querySelector('.label').textContent = '⚠ ' + what + ': не удалось записать';
      c.querySelector('.t-err').textContent = q.error + (q.action === 'addRoute' ? ' · ' + q.payload.route : '');
    }
    c.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'drop') queue = queue.filter((x) => x.id !== q.id);
      else {
        if (a === 'mine') q.payload.base = q.current ? q.current.v : '';
        q.status = 'pending';
        q.error = '';
      }
      saveQueue();
      renderAll();
      sync();
    });
    cbox.appendChild(c);
  });

  const dates = new Set(data ? Object.keys(data.days) : []);
  queue.forEach((q) => { if (q.action === 'saveDay') dates.add(q.payload.date); });
  const days = [...dates].map(viewDay).filter(hasData).sort((a, b) => b.date.localeCompare(a.date)).slice(0, RECENT_COUNT);

  const box = $('logList');
  box.innerHTML = '';
  if (!days.length) {
    box.innerHTML = '<div class="empty">' + (data ? 'Поездок пока нет' : 'Данные не загружены — проверьте «Настройки»') + '</div>';
    return;
  }
  days.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.innerHTML = '<div class="item-top"><span class="d"></span><span class="km"></span></div><div class="item-route"></div><div class="item-meta"></div>';
    b.querySelector('.d').textContent = shortDate(d.date);
    b.querySelector('.km').textContent = d.km !== '' ? fmt.format(d.km) + ' км' : '';
    b.querySelector('.item-route').textContent = d.route || '—';
    const meta = b.querySelector('.item-meta');
    const tag = (text, cls) => { const s = document.createElement('span'); s.className = 'tag ' + (cls || ''); s.textContent = text; meta.appendChild(s); };
    if (d.fuel !== '' && d.fuel != null) tag('⛽ ' + fmt.format(d.fuel) + ' ₽' + (d.source ? ' · ' + d.source : ''));
    if (d.repair) tag('🔧 ' + fmt.format(d.repair) + ' ₽');
    if (d.comment) tag('💬 ' + d.comment);
    if (d.status === 'conflict' || d.status === 'error') tag('⚠ не записано', 'err');
    else if (d.pending) tag('⏳ ждёт отправки', 'pending');
    b.addEventListener('click', () => { setDate(d.date); showScreen('trip'); });
    box.appendChild(b);
  });
}

function describe(r) {
  if (!hasData(r)) return '(пусто)';
  const parts = [];
  if (r.route) parts.push(r.route);
  if (r.km !== '') parts.push(fmt.format(r.km) + ' км');
  if (r.fuel !== '') parts.push('⛽ ' + fmt.format(r.fuel) + ' ₽' + (r.source ? ' (' + r.source + ')' : ''));
  if (r.repair) parts.push('🔧 ' + fmt.format(r.repair) + ' ₽');
  if (r.comment) parts.push('💬 ' + r.comment);
  return parts.join(' · ');
}

/* ---------------- месяц ---------------- */

let monthIdx = new Date().getMonth();

function renderMonth() {
  $('monName').textContent = MONTHS[monthIdx] + (data ? ' ' + data.year : '');
  const box = $('monSummary');
  box.innerHTML = '';
  if (!data || !data.summary || !data.summary.length) {
    box.innerHTML = '<div class="empty">Нет данных — нужна связь с таблицей</div>';
    return;
  }
  const byKey = {};
  data.summary.forEach((r) => { byKey[r.key] = r; });
  const prefix = data.year + '-' + pad(monthIdx + 1);
  const tripDays = Object.values(data.days).filter((d) => d.date.startsWith(prefix) && (d.route || d.km !== '')).length;
  const addRow = (title, value, cls) => {
    const row = document.createElement('div');
    row.className = 'sum-row ' + (cls || '');
    row.innerHTML = '<span class="k"></span><span class="v"></span>';
    row.querySelector('.k').textContent = title;
    row.querySelector('.v').textContent = value;
    box.appendChild(row);
  };
  addRow('Дней с поездками', String(tripDays));
  SUMMARY_VIEW.forEach((s) => {
    const r = byKey[s.key];
    if (!r) return;
    const v = r.values[monthIdx];
    const n = v === '' ? 0 : v;
    addRow(s.title, (s.unit === '₽' ? fmtInt.format(n) : fmt.format(n)) + ' ' + s.unit, s.total ? 'total' : s.sub ? 'sub' : '');
  });
  const year = byKey.total && byKey.total.values[12];
  if (year !== undefined && year !== '') addRow('К выплате за год', fmtInt.format(year) + ' ₽', 'sub');
  if (queue.some((q) => q.action === 'saveDay' && q.payload.date.startsWith(prefix))) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = '⏳ Есть неотправленные записи — цифры обновятся после синхронизации.';
    box.appendChild(h);
  }
}

/* ---------------- навигация ---------------- */

const TITLES = { trip: 'Поездка', log: 'Журнал', month: 'Месяц', settings: 'Настройки' };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.scr === name));
  $('screenTitle').textContent = TITLES[name];
  if (name === 'log') renderLog();
  if (name === 'month') renderMonth();
  window.scrollTo(0, 0);
}

function renderAll() {
  renderStatus();
  // не сбрасываем форму, если пользователь начал её заполнять
  if (!form.dirty) setDate(form.date);
  renderLog();
  renderMonth();
}

/* ---------------- настройки ---------------- */

async function saveSettings() {
  settings = { url: $('urlInput').value.trim(), key: $('keyInput').value.trim() };
  store(LS_SETTINGS, settings);
  const msg = $('settingsMsg');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(settings.url)) {
    msg.textContent = 'Адрес должен начинаться с https://script.google.com/ и заканчиваться на /exec';
    return;
  }
  msg.textContent = 'Проверяю…';
  try {
    await loadAll();
    msg.textContent = '✓ Связь есть. Загружено дней: ' + Object.keys(data.days).length + ', маршрутов: ' + data.routes.length;
    lastSyncError = '';
    renderAll();
    sync();
  } catch (e) {
    msg.textContent = '✗ ' + e.message;
  }
}

/* ---------------- запуск ---------------- */

function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.scr)));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.closest('.sheet').id)));

  $('datePrev').addEventListener('click', () => setDate(shiftIso(form.date, -1)));
  $('dateNext').addEventListener('click', () => setDate(shiftIso(form.date, 1)));
  $('todayBtn').addEventListener('click', () => setDate(todayIso()));
  $('dateInput').addEventListener('change', (e) => { if (e.target.value) setDate(e.target.value); });

  $('routeBtn').addEventListener('click', () => { $('routeSearch').value = ''; renderRouteList(); openSheet('routeSheet'); });
  $('routeSearch').addEventListener('input', renderRouteList);
  $('buildBtn').addEventListener('click', openBuilder);
  $('sheetBuildBtn').addEventListener('click', openBuilder);
  $('clearRouteBtn').addEventListener('click', () => setRoute(''));
  $('buildUndo').addEventListener('click', () => { buildPoints.pop(); renderBuild(); });
  $('buildReset').addEventListener('click', () => { buildPoints = []; renderBuild(); });
  $('newObjBtn').addEventListener('click', addObject);
  $('newObjInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addObject(); });
  $('buildDone').addEventListener('click', finishBuild);

  document.querySelectorAll('#sourceSeg button').forEach((b) => b.addEventListener('click', () => { form.dirty = true; setSource(form.source === b.dataset.v ? '' : b.dataset.v); }));
  $('clearRouteBtn').addEventListener('click', () => { form.dirty = true; });
  $('fuelInput').addEventListener('input', () => {
    if ($('fuelInput').value && !form.source) setSource(load(LS_LAST_SOURCE, 'Топливная карта'));
  });
  $('saveBtn').addEventListener('click', saveDay);
  $('deleteBtn').addEventListener('click', clearDay);

  $('monPrev').addEventListener('click', () => { monthIdx = (monthIdx + 11) % 12; renderMonth(); });
  $('monNext').addEventListener('click', () => { monthIdx = (monthIdx + 1) % 12; renderMonth(); });

  $('urlInput').value = settings.url;
  $('keyInput').value = settings.key;
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('reloadBtn').addEventListener('click', () => sync({ reload: true, manual: true }));
  $('syncBtn').addEventListener('click', () => sync({ reload: true, manual: true }));

  window.addEventListener('online', () => sync());
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => { if (queue.some((q) => q.status === 'pending')) sync(); }, 60000);

  $('scr-trip').addEventListener('input', (e) => { if (e.target.id !== 'dateInput') form.dirty = true; });

  renderAll();
  if (!settings.url || !settings.key) showScreen('settings');
  else sync();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
