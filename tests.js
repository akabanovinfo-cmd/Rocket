#!/usr/bin/env node
/* Ракета — прогон перед публикацией.
   Запуск:  node tests.js
   Ненулевой код возврата = публиковать нельзя.

   Стенд поднимает игру в Node с заглушками DOM и canvas — браузер не нужен.
   Каждый набор идёт отдельным процессом: игра живёт на глобальных переменных,
   два экземпляра в одном процессе конфликтуют. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const GAME = path.join(__dirname, 'index.html');

/* ================= стенд ================= */

function replaceOnce(s, find, repl) {
  const c = s.split(find).length - 1;
  if (c !== 1) throw new Error('шаблон встречается ' + c + ' раз, ожидался 1: ' + find.slice(0, 50));
  return s.replace(find, repl);
}

function mkCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => grad;
      if (p === 'measureText') return () => ({ width: 10 });
      if (typeof p === 'string' && /^[a-z]/.test(p)) return function () {};
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function mkEl(id) {
  const el = {
    id, hidden: false, className: '', disabled: false, children: [],
    _l: {}, _html: '', width: 0, height: 0, textContent: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }
  };
  el.classList = {
    _s: new Set(),
    add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
    toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); },
    contains(c) { return this._s.has(c); }
  };
  el.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  el.removeEventListener = function () {};
  el.setAttribute = function () {};
  el.appendChild = function (c) { this.children.push(c); return c; };
  el.getBoundingClientRect = function () { return { width: 390, height: 844, left: 0, top: 0 }; };
  el.getContext = function () { return mkCtx(); };
  el.click = function () { (this._l.click || []).forEach(f => f({ stopPropagation() {} })); };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; if (v === '') this.children = []; }
  });
  return el;
}

function createGame(opts) {
  opts = opts || {};
  const src = fs.readFileSync(opts.file || GAME, 'utf8');
  const parts = src.split('<script>');
  if (parts.length !== 2) throw new Error('в файле не один <script>');
  let js = parts[1].split('</script>')[0];

  if (opts.god) js = replaceOnce(js, 'function damage(n){', 'function damage(n){ return;');
  (opts.patches || []).forEach(([find, repl]) => { js = replaceOnce(js, find, repl); });

  /* окно во внутреннее состояние — только для тестов */
  js = replaceOnce(js, 'requestAnimationFrame(frame);\n})();',
    'global.__dbg={st:function(){return {boss:boss,enemies:enemies,px:px,py:py,level:level,' +
    'hp:hp,hpMax:hpMax,phase:phase,bank:bank,charge:charge,logOpen:logOpen,deepest:deepest,' +
    'finished:finished,W:W,H:H};},setT:function(x,y){tx=x;ty=y;}};\nrequestAnimationFrame(frame);\n})();');

  const store = Object.assign({}, opts.storage || {});
  const els = {};
  let vnow = 0, queued = null;

  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  global.document = {
    getElementById: id => els[id] || (els[id] = mkEl(id)),
    createElement: t => mkEl('_' + t),
    addEventListener() {},
    fonts: { status: 'loaded' },
    hidden: false, visibilityState: 'visible'
  };
  global.performance = { now: () => vnow };
  global.requestAnimationFrame = f => { queued = f; };
  global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };

  const errors = [];
  eval(js);

  const D = id => document.getElementById(id);

  function step(frames, onFrame) {
    for (let i = 0; i < frames; i++) {
      vnow += 1000 / 60;
      const f = queued; queued = null;
      if (!f) { errors.push('цикл кадров остановился на ' + i); return; }
      try { f(vnow); } catch (e) { errors.push(i + ': ' + e.message); if (errors.length > 3) return; }
      if (onFrame && onFrame(i)) return;
    }
  }

  function autopilot() {
    const s = global.__dbg.st();
    let tx = s.W / 2;
    if (s.boss) tx = s.boss.x;
    else if (s.enemies.length) {
      let best = null, bd = 1e9;
      for (const e of s.enemies) { const d = Math.abs(e.x - s.px) + e.y * 0.2; if (d < bd) { bd = d; best = e; } }
      if (best) tx = best.x;
    }
    global.__dbg.setT(tx, s.H * 0.78);
  }

  function passShop() {
    if (D('shop').hidden) return false;
    const dc = D('shop-draft').children;
    if (dc.length && !dc[0].disabled) dc[0].click();
    const cards = D('shop-items').children.filter(c => !c.disabled);
    if (cards.length) cards[0].click();
    D('btn-next').click();
    return true;
  }

  return { D, step, autopilot, passShop, errors, store, state: () => global.__dbg.st() };
}

let failed = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed++; };
const finish = t => {
  console.log(failed ? t + ': ПРОВАЛЕНО (' + failed + ')' : t + ': пройдено');
  process.exit(failed ? 1 : 0);
};

/* ================= наборы ================= */

const SHIPS = { pulse: 7, spire: 6, hammer: 9, spindle: 7, phantom: 6 };
const WEAPONS = ['pulse', 'spread', 'beam', 'homing', 'shot', 'tesla', 'mortar'];

function suiteSmoke() {
  const g = createGame({});
  g.D('btn-start').click();
  let shops = 0;
  g.step(60 * 250, () => { if (g.passShop()) shops++; return !g.D('over').hidden; });
  ok(g.errors.length === 0, 'исключений нет' + (g.errors[0] ? ': ' + g.errors[0] : ''));
  ok(!g.D('over').hidden, 'забег завершился экраном итога');
  ok(shops >= 1, 'магазин открывался: ' + shops);
  ok(Number(String(g.D('score').textContent).replace(/\D/g, '')) > 0, 'счёт начисляется');
  finish('smoke');
}

function suiteStory() {
  const g = createGame({});
  ok(g.state().logOpen === 0, 'на старте архив пуст');
  g.D('btn-start').click();
  g.step(60 * 400, () => { g.passShop(); return !g.D('over').hidden; });
  const first = g.state().logOpen;
  ok(first >= 1, 'после гибели открыто обрывков: ' + first);
  ok(g.D('frag').hidden === false, 'обрывок показан на экране гибели');
  ok(String(g.D('frag-t').textContent).length > 0, 'заголовок: «' + g.D('frag-t').textContent + '»');
  g.D('btn-again').click();
  g.step(60 * 400, () => { g.passShop(); return !g.D('over').hidden; });
  ok(g.state().logOpen > first, 'второй забег добавил: ' + first + ' → ' + g.state().logOpen);
  ok(g.store['raketa.log'] === String(g.state().logOpen), 'прогресс сохранён');
  g.D('btn-journal').click();
  ok(!g.D('journal').hidden, 'экран архива открылся');
  ok(g.D('journal-list').children.length === 12, 'записей в архиве: ' + g.D('journal-list').children.length);
  finish('story');
}

function suiteFinale() {
  const g = createGame({ god: true });
  g.D('btn-start').click();
  g.step(60 * 700, () => { g.autopilot(); g.passShop(); return !g.D('over').hidden; });
  const s = g.state();
  ok(g.errors.length === 0, 'исключений нет' + (g.errors[0] ? ': ' + g.errors[0] : ''));
  ok(g.D('over-title').textContent === '«Заря»', 'финал: ' + g.D('over-title').textContent);
  ok(s.level >= 9, 'дошли до сектора ' + s.level);
  ok(s.logOpen === 12, 'архив открыт целиком: ' + s.logOpen);
  ok(s.finished >= 1, 'виток засчитан: ' + s.finished);
  finish('finale');
}

function suiteShip(id) {
  const g = createGame({
    god: true,
    storage: { 'raketa.ships': JSON.stringify(Object.keys(SHIPS)), 'raketa.ship': id, 'raketa.cores': '400' },
    patches: [['up={}; for(var i=0;i<UPGRADES.length;i++) up[UPGRADES[i].id]=0;',
               'up={}; for(var i=0;i<UPGRADES.length;i++) up[UPGRADES[i].id]=UPGRADES[i].max;']]
  });
  g.D('btn-start').click();
  g.step(60 * 12, () => { g.autopilot(); return false; });
  const pips = (g.D('hearts')._html.match(/class="pip(?! sh)/g) || []).length;
  ok(g.errors.length === 0, id + ': исключений нет');
  ok(pips === SHIPS[id], id + ': прочность ' + pips + ' (ожидалось ' + SHIPS[id] + ')');
  finish('ship:' + id);
}

function suiteWeapon(id) {
  const own = {}; WEAPONS.forEach(w => own[w] = true);
  const g = createGame({
    god: true,
    patches: [["owned={pulse:true}; weapon='pulse'; bank=0;",
               'owned=' + JSON.stringify(own) + "; weapon='" + id + "'; bank=0;"]]
  });
  g.D('btn-start').click();
  g.step(60 * 220, () => { g.autopilot(); g.passShop(); return false; });
  ok(g.errors.length === 0, id + ': исключений нет' + (g.errors[0] ? ' — ' + g.errors[0] : ''));
  finish('weapon:' + id);
}

function suiteDailySig(daily) {
  const g = createGame({ god: true });
  g.D(daily ? 'btn-daily' : 'btn-start').click();
  const sig = [];
  g.step(60 * 120, i => {
    g.autopilot(); g.passShop();
    if (i % 600 === 0) sig.push((i / 60) + 's ' + g.D('score').textContent + ' / ' + g.D('lvl').textContent);
    return false;
  });
  console.log(sig.join('\n'));
  process.exit(0);
}

/* ================= запуск ================= */

const mode = process.argv[2];
if (mode === 'smoke') suiteSmoke();
else if (mode === 'story') suiteStory();
else if (mode === 'finale') suiteFinale();
else if (mode && mode.indexOf('ship:') === 0) suiteShip(mode.slice(5));
else if (mode && mode.indexOf('weapon:') === 0) suiteWeapon(mode.slice(7));
else if (mode === 'daily-run') suiteDailySig(true);
else if (mode === 'daily-norm') suiteDailySig(false);
else {
  let bad = 0;
  const run = (label, args) => {
    console.log('\n== ' + label + ' ==');
    try { execFileSync('node', [__filename].concat(args), { stdio: 'inherit' }); }
    catch (e) { bad++; }
  };

  console.log('== синтаксис игры ==');
  try {
    const js = fs.readFileSync(GAME, 'utf8').split('<script>')[1].split('</script>')[0];
    const tmp = path.join(os.tmpdir(), 'raketa-check-' + process.pid + '.js');
    fs.writeFileSync(tmp, js);
    execSync('node --check ' + JSON.stringify(tmp), { stdio: 'pipe' });
    fs.unlinkSync(tmp);
    console.log('  ✓ разбирается без ошибок');
  } catch (e) { console.log('  ✗ синтаксическая ошибка'); bad++; }

  run('обычный забег', ['smoke']);
  run('архив и обрывки', ['story']);
  run('финал на «Заре»', ['finale']);
  for (const s of Object.keys(SHIPS)) run('корпус ' + s, ['ship:' + s]);
  for (const w of WEAPONS) run('орудие ' + w, ['weapon:' + w]);

  console.log('\n== вызов дня воспроизводим ==');
  try {
    const a = execFileSync('node', [__filename, 'daily-run'], { encoding: 'utf8' });
    const b = execFileSync('node', [__filename, 'daily-run'], { encoding: 'utf8' });
    const c = execFileSync('node', [__filename, 'daily-norm'], { encoding: 'utf8' });
    if (a === b) console.log('  ✓ два прогона вызова дня совпали посимвольно');
    else { console.log('  ✗ прогоны вызова дня разошлись'); bad++; }
    if (a !== c) console.log('  ✓ обычный забег отличается от вызова дня');
    else { console.log('  ✗ сид не различается'); bad++; }
  } catch (e) { console.log('  ✗ не удалось прогнать'); bad++; }

  console.log('\n' + (bad ? '=== ПРОВАЛЕНО: ' + bad + ' ===' : '=== всё пройдено, можно публиковать ==='));
  process.exit(bad ? 1 : 0);
}
