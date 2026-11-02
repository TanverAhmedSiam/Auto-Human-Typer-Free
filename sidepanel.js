'use strict';

/* =====================================================================
   Human Auto Typer
   Types into whatever field is focused on the active tab by sending real
   keyboard events through the Chrome debugger API, so it works on normal
   inputs, rich editors, and Google Docs.
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const el = {
  text: $('text'), count: $('count'), paste: $('pasteBtn'), clear: $('clearBtn'),
  start: $('startBtn'), stop: $('stopBtn'), speed: $('speed'), wpm: $('wpm'),
  human: $('human'), status: $('status'), bar: $('bar'),
};

const state = { typing: false, paused: false, stop: false, tabId: null, attached: false };
class Stopped extends Error {}

/* ---------- tuning knobs ---------- */
const TYPO_RATE = 0.08;      // chance that a letter is mistyped in human mode
const MIN_GAP_BETWEEN_TYPOS = 8; // characters

/* ---------- helpers ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Slider 1..100 -> base delay per character (ms), roughly 400ms down to 20ms.
const baseDelay = () => 400 * Math.pow(0.05, Number(el.speed.value) / 100);
// Scales pauses so slow typists pause longer and fast typists pause shorter.
const pauseFactor = () => Math.min(1.5, 0.5 + baseDelay() / 200);

async function wait(ms) {
  let end = performance.now() + ms;
  for (;;) {
    if (state.stop) throw new Stopped();
    if (state.paused) {                       // freeze the countdown while paused
      const t = performance.now();
      await sleep(100);
      end += performance.now() - t;
      continue;
    }
    const left = end - performance.now();
    if (left <= 0) break;
    await sleep(Math.min(50, left));
  }
}

/* ---------- settings + UI ---------- */
const DEFAULTS = { text: '', speed: 35, human: true };

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  el.text.value = s.text;
  el.speed.value = s.speed;
  el.human.checked = s.human;
  refresh();
}
const save = () =>
  chrome.storage.local.set({ text: el.text.value, speed: Number(el.speed.value), human: el.human.checked });

function refresh() {
  const n = Array.from(el.text.value).length;
  el.count.textContent = `${n.toLocaleString()} char${n === 1 ? '' : 's'}`;
  el.wpm.textContent = `about ${Math.round(12000 / baseDelay())} WPM`;
  el.speed.style.setProperty('--pct', `${el.speed.value}%`);
}

function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.className = `status ${kind}`;
}
const setProgress = (p) => { el.bar.style.width = `${Math.round(p * 100)}%`; };

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

// The main button is Start, then Pause while typing, then Resume while paused.
function renderStartButton() {
  let icon = ICON_PLAY, label = 'Start';
  if (state.typing && state.paused) label = 'Resume';
  else if (state.typing) { icon = ICON_PAUSE; label = 'Pause'; }
  el.start.innerHTML = `${icon} ${label}`;
  el.start.classList.toggle('pause', state.typing && !state.paused);
}

function setBusy(busy) {
  state.typing = busy;
  if (!busy) state.paused = false;
  el.stop.disabled = !busy;
  el.text.disabled = busy;
  el.paste.disabled = busy;
  el.clear.disabled = busy;
  renderStartButton();
}

el.text.addEventListener('input', () => { refresh(); save(); });
el.speed.addEventListener('input', () => { refresh(); save(); });
el.human.addEventListener('change', save);

el.clear.addEventListener('click', () => {
  el.text.value = '';
  setProgress(0);
  setStatus('Click where you want to type on the page, then press Start.');
  refresh(); save(); el.text.focus();
});

el.paste.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) { setStatus('Your clipboard is empty.', 'warn'); return; }
    el.text.value = t;
    setProgress(0);
    setStatus('Text pasted. Click where you want to type on the page, then press Start.');
    refresh(); save();
  } catch {
    setStatus('Couldn’t read the clipboard. Click the box and press Ctrl+V instead.', 'warn');
    el.text.focus();
  }
});

el.stop.addEventListener('click', () => { state.stop = true; state.paused = false; });
el.start.addEventListener('click', () => {
  if (!state.typing) { startTyping(); return; }
  state.paused = !state.paused;
  renderStartButton();
  setStatus(state.paused ? 'Paused. Press Resume to continue.' : 'Typing…');
});

/* ---------- keyboard layout (US QWERTY) ---------- */
const SHIFT_MAP = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};
const PUNCT = {
  ' ': ['Space', 32], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222],
  ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
};

function keyInfo(ch) {
  if (/^[a-z]$/.test(ch)) return { code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), shift: false, base: ch };
  if (/^[A-Z]$/.test(ch)) return { code: 'Key' + ch, vk: ch.charCodeAt(0), shift: true, base: ch.toLowerCase() };
  if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, vk: ch.charCodeAt(0), shift: false, base: ch };
  if (PUNCT[ch]) return { code: PUNCT[ch][0], vk: PUNCT[ch][1], shift: false, base: ch };
  if (SHIFT_MAP[ch]) return { ...keyInfo(SHIFT_MAP[ch]), shift: true };
  return null; // anything else (accents, emoji, other scripts) is inserted directly
}

// Which keys sit next to each other, built from physical key positions.
const NEIGHBORS = (() => {
  const rows = [['qwertyuiop', 0], ['asdfghjkl', 0.35], ['zxcvbnm', 0.85]];
  const pos = {};
  rows.forEach(([row, offset], r) => [...row].forEach((c, i) => { pos[c] = [i + offset, r]; }));
  const out = {};
  for (const a in pos) {
    out[a] = Object.keys(pos).filter(
      (b) => b !== a && Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]) < 1.45
    );
  }
  return out;
})();

function neighborOf(ch) {
  const n = pick(NEIGHBORS[ch.toLowerCase()]);
  return ch === ch.toUpperCase() ? n.toUpperCase() : n;
}

/* ---------- sending keys ---------- */
const send = (method, params) => chrome.debugger.sendCommand({ tabId: state.tabId }, method, params);
const keyEvent = (type, o) => send('Input.dispatchKeyEvent', { type, ...o });

async function tapSpecial(key, code, vk, text) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await keyEvent(text ? 'keyDown' : 'rawKeyDown', text ? { ...base, text, unmodifiedText: text } : base);
  await keyEvent('keyUp', base);
}

async function pressChar(ch) {
  if (ch === '\n') return tapSpecial('Enter', 'Enter', 13, '\r');
  if (ch === '\t') return tapSpecial('Tab', 'Tab', 9, '\t');
  const info = keyInfo(ch);
  if (!info) return send('Input.insertText', { text: ch });
  const common = {
    modifiers: info.shift ? 8 : 0, key: ch, code: info.code,
    windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk,
  };
  await keyEvent('keyDown', { ...common, text: ch, unmodifiedText: info.base });
  await keyEvent('keyUp', common);
}

const backspace = () => tapSpecial('Backspace', 'Backspace', 8);

/* ---------- human timing ---------- */
let rhythm = 1, rhythmLeft = 0;

function delayAfter(ch) {
  const base = baseDelay();
  if (!el.human.checked) return base * rnd(0.95, 1.05);

  // Typing speed drifts in short bursts instead of staying uniform.
  if (--rhythmLeft <= 0) { rhythm = rnd(0.75, 1.3); rhythmLeft = Math.floor(rnd(5, 16)); }
  let d = base * rhythm * rnd(0.6, 1.5);
  const f = pauseFactor();

  if ('.!?'.includes(ch)) d += rnd(250, 650) * f;
  else if (',;:'.includes(ch)) d += rnd(90, 300) * f;
  else if (ch === '\n') d += rnd(300, 900) * f;
  else if (ch === ' ' && chance(0.15)) d += rnd(60, 250) * f;
  if (chance(0.012)) d += rnd(500, 1400) * f; // brief "thinking" pause
  return d;
}

async function typeOne(ch) {
  if (state.stop) throw new Stopped();
  await pressChar(ch);
  await wait(delayAfter(ch));
}

/* ---------- human mistakes ---------- */
// Makes a mistake, sometimes keeps typing a few characters before noticing,
// then backspaces and retypes correctly. Returns the next index to type.
async function makeTypo(chars, i) {
  const ch = chars[i];
  const next = chars[i + 1];
  let typed, back, retype, used;
  const r = Math.random();

  if (r < 0.62) {                               // hit a neighbouring key
    typed = [neighborOf(ch)]; back = 1; retype = [ch]; used = 1;
  } else if (r < 0.82 && next && /^[a-z]$/i.test(next) && next.toLowerCase() !== ch.toLowerCase()) {
    typed = [next, ch]; back = 2; retype = [ch, next]; used = 2; // swapped two letters
  } else {                                      // double-tapped a key
    typed = [ch, ch]; back = 1; retype = []; used = 1;
  }

  // Sometimes the mistake isn't noticed straight away.
  const roll = Math.random();
  const lateCount = roll < 0.55 ? 0 : roll < 0.8 ? 1 : roll < 0.92 ? 2 : 3;
  const late = [];
  for (let k = 0; k < lateCount; k++) {
    const c = chars[i + used + k];
    if (c === undefined || c === '\n') break;
    late.push(c);
  }

  for (const c of typed) await typeOne(c);
  for (const c of late) await typeOne(c);

  await wait(rnd(220, 600) * pauseFactor());          // "oh, that's wrong"
  for (let k = 0; k < back + late.length; k++) {
    await backspace();
    await wait(rnd(45, 110));
  }
  await wait(rnd(80, 220) * pauseFactor());
  for (const c of [...retype, ...late]) await typeOne(c);

  return i + used + late.length;
}

/* ---------- debugger attach / detach ---------- */
async function attach() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('No active tab found.');
  state.tabId = tab.id;
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  state.attached = true;
  // Makes the page behave as focused even though the side panel has real focus.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

async function detach() {
  if (!state.attached) return;
  state.attached = false;
  try { await chrome.debugger.detach({ tabId: state.tabId }); } catch { /* already gone */ }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === state.tabId && state.attached) {
    state.attached = false;
    state.stop = true;
  }
});
window.addEventListener('pagehide', () => { detach(); });

function friendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (/another debugger/i.test(msg)) return 'Close DevTools on this tab, then try again.';
  if (/cannot access|chrome:\/\/|chrome-extension|web store/i.test(msg))
    return 'Chrome doesn’t allow typing on this page. Switch to a regular website tab.';
  return msg;
}

/* ---------- main loop ---------- */
async function startTyping() {
  const text = el.text.value.replace(/\r\n?/g, '\n');
  if (!text.trim()) { setStatus('Paste some text first.', 'warn'); return; }

  state.stop = false;
  setBusy(true);
  setProgress(0);
  setStatus('Starting…');

  try {
    await attach();
    setStatus('Typing…');
    await wait(500);

    const chars = Array.from(text);
    let i = 0, lastTypoAt = -999;

    while (i < chars.length) {
      const ch = chars[i];
      const canTypo = el.human.checked && /^[a-z]$/i.test(ch) && i - lastTypoAt > MIN_GAP_BETWEEN_TYPOS;
      if (canTypo && chance(TYPO_RATE)) {
        i = await makeTypo(chars, i);
        lastTypoAt = i;
      } else {
        await typeOne(ch);
        i++;
      }
      setProgress(i / chars.length);
      if (i % 20 === 0 || i === chars.length) {
        setStatus(`Typing… ${Math.round((i / chars.length) * 100)}%`);
      }
    }
    setProgress(1);
    setStatus('Done.', 'ok');
  } catch (e) {
    if (e instanceof Stopped || state.stop) setStatus('Stopped.');
    else setStatus(friendlyError(e), 'error');
  } finally {
    await detach();
    setBusy(false);
  }
}

renderStartButton();
load();
