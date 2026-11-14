import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const $ = (id) => document.getElementById(id);
const deviceIds = ['wastafel-01', 'wastafel-pintar']; // ID baru + ID lama agar riwayat lama ikut dihitung
let db;
let firebaseApp = null;
let currentAuth = null;
let allEvents = [];
let eventSnapshots = new Map();
let currentSnapshots = new Map();
let deviceUsageCounts = { soap: 0, water: 0 };
let usageResetData = null;
let lastDeviceUpdate = 0;
let deviceFirmwareVersion = '';
let lowStockNotificationShown = false;
let statusWatchdogStarted = false;
let firebaseConnected = false;
let activeListeners = [];
let lastReportedReadError = '';
let liveUsageState;

// ─── Auto-Reconnect State ───
let lastFirebaseConfig = null;
let lastCredentials = null;

// ─── Chart State ───
let usageChart = null;
let chartRange = 7;

// ─── Session Storage Keys ───
const SESSION_KEY = 'smartHandwashSession';
const FIREBASE_KEY = 'wastafelFirebase';
const LIVE_USAGE_KEY = 'smartHandwashLiveUsageV1';

function loadLiveUsageState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_USAGE_KEY) || '{}');
    return {
      counts: { soap: Number(saved.counts?.soap) || 0, water: Number(saved.counts?.water) || 0 },
      devices: saved.devices && typeof saved.devices === 'object' ? saved.devices : {},
      pending: Array.isArray(saved.pending) ? saved.pending : [],
      resetId: String(saved.resetId || '')
    };
  } catch {
    return { counts: { soap: 0, water: 0 }, devices: {}, pending: [], resetId: '' };
  }
}

liveUsageState = loadLiveUsageState();

function saveLiveUsageState() {
  try { localStorage.setItem(LIVE_USAGE_KEY, JSON.stringify(liveUsageState)); } catch { /* storage may be unavailable */ }
}

async function ensureFirebaseApp(cfg) {
  if (firebaseApp && (
    firebaseApp.options.apiKey !== cfg.apiKey ||
    firebaseApp.options.projectId !== cfg.projectId ||
    firebaseApp.options.databaseURL !== cfg.databaseURL
  )) {
    await deleteApp(firebaseApp);
    firebaseApp = null;
  }
  if (!firebaseApp) firebaseApp = initializeApp(cfg, 'sinkDash');
  return firebaseApp;
}

// ═══════════════════════════════════════════════════════
// PERSISTENT SESSION — save/restore login across refresh
// ═══════════════════════════════════════════════════════

function saveSession(cfg, email, password) {
  try {
    const session = {
      config: { apiKey: cfg.apiKey, projectId: cfg.projectId, dbUrl: cfg.databaseURL },
      credentials: { email, password: btoa(password) }, // basic obfuscation
      savedAt: Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* silently fail */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // Session expires after 7 days
    if (Date.now() - session.savedAt > 7 * 24 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    session.credentials.password = atob(session.credentials.password);
    return session;
  } catch {
    clearSession();
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ─── UI State after login ───
function setLoggedInUI() {
  $('loginBtn').disabled = true;
  $('logoutBtn').style.display = 'inline-flex';
  $('previewCsvBtn').disabled = false;
  $('csvBtn').disabled = false;
  $('resetCountBtn').disabled = false;
}

function setLoggedOutUI() {
  $('loginBtn').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Masuk';
  $('loginBtn').disabled = false;
  $('logoutBtn').style.display = 'none';
  $('reconnectBtn').style.display = 'none';
  $('previewCsvBtn').disabled = true;
  $('csvBtn').disabled = true;
  $('resetCountBtn').disabled = true;
  showLive(false, 'Belum terhubung ke database');
}

// ═══════════════════════════════════════
// AUTO-LOGIN ON PAGE LOAD
// ═══════════════════════════════════════
async function tryAutoLogin() {
  const session = loadSession();
  if (!session) return;

  showLive(false, 'Menghubungkan sesi tersimpan...');
  try {
    const cfg = {
      apiKey: session.config.apiKey,
      authDomain: `${session.config.projectId}.firebaseapp.com`,
      databaseURL: session.config.dbUrl,
      projectId: session.config.projectId
    };

    lastFirebaseConfig = cfg;
    lastCredentials = { email: session.credentials.email, password: session.credentials.password };

    await ensureFirebaseApp(cfg);
    currentAuth = getAuth(firebaseApp);
    await signInWithEmailAndPassword(currentAuth, session.credentials.email, session.credentials.password);
    db = getDatabase(firebaseApp, cfg.databaseURL);

    // Pre-fill login form with saved values
    $('apiKey').value = session.config.apiKey;
    $('projectId').value = session.config.projectId;
    $('dbUrl').value = session.config.dbUrl;
    $('email').value = session.credentials.email;

    setLoggedInUI();
    listen();
    showToast('✅ Sesi sebelumnya berhasil dipulihkan', 'warning');
  } catch (error) {
    clearSession();
    showLive(false, 'Sesi kedaluwarsa, silakan login ulang');
  }
}

// ═══════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════
$('logoutBtn').onclick = async () => {
  try {
    if (currentAuth) await signOut(currentAuth);
  } catch { /* ignore */ }
  clearSession();
  activeListeners.forEach((unsubscribe) => unsubscribe());
  activeListeners = [];
  db = null;
  firebaseApp = null;
  currentAuth = null;
  lastFirebaseConfig = null;
  lastCredentials = null;
  firebaseConnected = false;
  lastDeviceUpdate = 0;
  allEvents = [];
  eventSnapshots.clear();
  currentSnapshots.clear();
  deviceUsageCounts = { soap: 0, water: 0 };
  usageResetData = null;

  // Reset UI
  setLoggedOutUI();

  // Reset data displays
  $('percent').textContent = '—';
  $('distance').textContent = '—';
  $('fill').style.width = '0%';
  $('levelText').textContent = 'Menunggu perangkat mengirim data';
  $('volume').textContent = '—';
  $('flowStatus').textContent = 'Menunggu data sensor aliran';
  $('soapHand').textContent = '—';
  $('waterHand').textContent = '—';
  $('soapState').textContent = 'OFF';
  $('waterState').textContent = 'OFF';
  $('soapState').className = 'tag';
  $('waterState').className = 'tag';
  $('soapCount').textContent = '0';
  $('waterCount').textContent = '0';
  $('totalCount').textContent = '0';
  const usageSummary = $('usageSummary');
  if (usageSummary) {
    usageSummary.replaceChildren();
    const summaryRow = usageSummary.insertRow();
    const summaryCell = summaryRow.insertCell();
    summaryCell.colSpan = 4;
    summaryCell.className = 'note';
    summaryCell.textContent = 'Login untuk memuat ringkasan.';
  }
  const waveContainer = $('waveContainer');
  if (waveContainer) waveContainer.classList.remove('high', 'low');

  // Reset events table
  const body = $('events');
  body.replaceChildren();
  const row = body.insertRow();
  const cell = row.insertCell(); cell.colSpan = 5; cell.className = 'note';
  cell.textContent = 'Login untuk memuat data.';

  // Reset chart
  const chartNote = $('chartNote');
  const usageCanvas = $('usageChart');
  if (chartNote) chartNote.style.display = 'block';
  if (usageCanvas) usageCanvas.style.display = 'none';
  if (usageChart) { usageChart.destroy(); usageChart = null; }

  showToast('👋 Berhasil logout', 'warning');
};

// ═══════════════════════════════════════
// LIVE STATUS
// ═══════════════════════════════════════
function showLive(ok, message) {
  const statusButton = $('loginBtn');
  statusButton.classList.toggle('status-connected', ok);
  statusButton.classList.toggle('status-disconnected', !ok);
  statusButton.innerHTML = ok
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Terhubung'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg> Tidak terhubung';
  $('dot').className = `dot${ok ? ' live' : ''}`;
  $('status').textContent = message;
}

function updateLiveStatus() {
  if (!db) return showLive(false, 'Belum terhubung ke database');
  if (!firebaseConnected) {
    $('reconnectBtn').style.display = currentAuth ? 'inline-flex' : 'none';
    return showLive(false, 'Koneksi Firebase terputus · mencoba tersambung kembali');
  }

  $('reconnectBtn').style.display = 'none';
  if (!lastDeviceUpdate) return showLive(true, 'Firebase tersambung · menunggu data ESP32');

  const ageMs = Date.now() - lastDeviceUpdate;
  const lastSeen = new Date(lastDeviceUpdate).toLocaleTimeString('id-ID');
  if (ageMs > 15000) {
    return showLive(false, `Firebase tersambung · data ESP32 terakhir ${lastSeen}`);
  }
  const firmwareLabel = deviceFirmwareVersion ? ` · firmware ${deviceFirmwareVersion}` : ' · firmware belum melaporkan versi';
  showLive(true, `ESP32 aktif · data diterima ${lastSeen}${firmwareLabel}`);
}

// ─── Toast Notification ───
let activeToast = null;
function showToast(message, type = 'warning') {
  if (activeToast) activeToast.remove();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${type === 'danger' ? '🔴' : '🟡'}</span><span>${message}</span>`;
  document.body.appendChild(toast);
  activeToast = toast;
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 500);
    if (activeToast === toast) activeToast = null;
  }, 5000);
}

function reportReadError(area, error) {
  const message = `${area}: ${error.message}`;
  console.error(message);
  if (message === lastReportedReadError) return;
  lastReportedReadError = message;
  showToast(`Tidak dapat membaca ${area}. Periksa izin Firebase.`, 'danger');
}

async function doReconnect() {
  if (!lastFirebaseConfig || !lastCredentials || !firebaseApp || !currentAuth) return;
  showLive(false, 'Memeriksa ulang sesi Firebase...');
  await signInWithEmailAndPassword(currentAuth, lastCredentials.email, lastCredentials.password);
  activeListeners.forEach((unsubscribe) => unsubscribe());
  activeListeners = [];
  db = getDatabase(firebaseApp, lastFirebaseConfig.databaseURL);
  listen();
}

$('reconnectBtn').onclick = async () => {
  $('reconnectBtn').disabled = true;
  $('reconnectBtn').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Menghubungkan...';
  try {
    await doReconnect();
  } catch (error) {
    showToast(`Gagal reconnect: ${error.message}`, 'danger');
  } finally {
    $('reconnectBtn').disabled = false;
    if (!firebaseConnected) {
      $('reconnectBtn').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Reconnect';
    }
  }
};

// ═══════════════════════════════════════
// LOGIN FLOW
// ═══════════════════════════════════════
$('loginBtn').onclick = () => {
  $('login').style.display = 'grid';
  $('error').textContent = '';
};
$('cancel').onclick = () => { $('login').style.display = 'none'; };

const firebaseDefaults = {
  apiKey: 'AIzaSyDc-iROnDBGRYv97iJZxKnEJ4QpqP31KZo',
  projectId: 'wastafel-pintar',
  dbUrl: 'https://wastafel-pintar-default-rtdb.asia-southeast1.firebasedatabase.app'
};
let saved = {};
try { saved = JSON.parse(localStorage.getItem(FIREBASE_KEY) || '{}') || {}; } catch { /* abaikan konfigurasi browser yang rusak */ }
for (const id of ['apiKey', 'projectId', 'dbUrl']) {
  $(id).value = saved[id] || firebaseDefaults[id];
}

$('doLogin').onclick = async () => {
  try {
    $('error').textContent = '';
    const cfg = {
      apiKey: $('apiKey').value.trim(),
      authDomain: `${$('projectId').value.trim()}.firebaseapp.com`,
      databaseURL: $('dbUrl').value.trim(),
      projectId: $('projectId').value.trim()
    };
    localStorage.setItem(FIREBASE_KEY, JSON.stringify({
      apiKey: cfg.apiKey, projectId: cfg.projectId, dbUrl: cfg.databaseURL
    }));

    // Save config for auto-reconnect
    lastFirebaseConfig = cfg;
    const email = $('email').value.trim();
    const password = $('password').value;
    lastCredentials = { email, password };

    await ensureFirebaseApp(cfg);
    currentAuth = getAuth(firebaseApp);
    await signInWithEmailAndPassword(currentAuth, email, password);
    db = getDatabase(firebaseApp, cfg.databaseURL);
    $('login').style.display = 'none';

    // Save session for persistent login
    saveSession(cfg, email, password);

    setLoggedInUI();
    listen();
  } catch (error) {
    $('error').textContent = `Gagal terhubung: ${error.message}`;
  }
};

function listen() {
  activeListeners.forEach((unsubscribe) => unsubscribe());
  activeListeners = [];
  firebaseConnected = false;
  updateLiveStatus();
  if (!statusWatchdogStarted) {
    statusWatchdogStarted = true;
    setInterval(() => {
      updateLiveStatus();
    }, 5000);
  }
  activeListeners.push(onValue(ref(db, '.info/connected'), (snapshot) => {
    firebaseConnected = snapshot.val() === true;
    updateLiveStatus();
  }, (error) => reportReadError('status koneksi Firebase', error)));

  activeListeners.push(onValue(ref(db, 'devices/wastafel-01/meta/usageReset'), (snapshot) => {
    const nextReset = snapshot.exists() ? snapshot.val() : null;
    if (nextReset?.id && nextReset.id !== liveUsageState.resetId) {
      liveUsageState.counts = { soap: 0, water: 0 };
      liveUsageState.resetId = nextReset.id;
      for (const deviceState of Object.values(liveUsageState.devices)) {
        deviceState.soapBaseline = 0;
        deviceState.waterBaseline = 0;
      }
      const resetAt = timestampMs(nextReset.resetAt);
      liveUsageState.pending = liveUsageState.pending.filter((event) => timestampMs(event.time) > resetAt);
      saveLiveUsageState();
    }
    usageResetData = nextReset;
    renderEvents();
  }, (error) => reportReadError('pengaturan reset jumlah', error)));

  for (const deviceId of deviceIds) {
    activeListeners.push(onValue(ref(db, `devices/${deviceId}/current`), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        currentSnapshots.set(deviceId, { data, receivedAt: Date.now() });
        if (eventSnapshots.has(deviceId)) capturePumpTransitions(deviceId, data);
      }
      else currentSnapshots.delete(deviceId);
      renderNewestCurrent();
    }, (error) => reportReadError('status perangkat', error)));

    activeListeners.push(onValue(ref(db, `devices/${deviceId}/events`), (snapshot) => {
      const items = [];
      if (snapshot.exists()) {
        snapshot.forEach((child) => items.push({
          ...(child.val() || {}),
          key: child.key,
          sourceDevice: deviceId
        }));
      }
      eventSnapshots.set(deviceId, items);
      const current = currentSnapshots.get(deviceId);
      if (current) capturePumpTransitions(deviceId, current.data);
      renderEvents();
    }, (error) => reportReadError('riwayat penggunaan', error)));
  }
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderNewestCurrent() {
  const newest = [...currentSnapshots.values()].sort((a, b) =>
    (timestampMs(b.data.updatedAt) || b.receivedAt) - (timestampMs(a.data.updatedAt) || a.receivedAt)
  )[0];
  if (newest) renderCurrent(newest.data);
  else updateLiveStatus();
}

function pumpName(event) {
  return String(event.pump ?? event.pompa ?? event.pumpType ?? event.jenisPompa ?? '').trim().toLowerCase();
}
const isSoap = (event) => ['sabun', 'soap', 'pompa sabun'].includes(pumpName(event));
const isWater = (event) => ['air', 'water', 'pompa air'].includes(pumpName(event));
function eventIsAfterUsageReset(event) {
  const resetAt = timestampMs(usageResetData?.resetAt);
  if (!resetAt) return true;
  return timestampMs(event.time ?? event.timestamp ?? event.createdAt) > resetAt;
}

function getPendingUsageEvents() {
  reconcilePendingLocalUsage();
  const pending = [];
  const pendingIds = new Map();
  for (const [deviceId, snapshot] of currentSnapshots) {
    const savedEvents = eventSnapshots.get(deviceId) || [];
    const data = snapshot.data || {};
    const candidates = [
      { id: String(data.soapEventId || ''), pump: 'sabun', volumeMl: 0 },
      { id: String(data.waterEventId || ''), pump: 'air', volumeMl: Number(data.sessionMl || 0) }
    ];
    for (const event of candidates) {
      const ignoredId = usageResetData?.eventIdsAtReset?.[deviceId]?.[event.pump]
        || (event.pump === 'sabun' ? usageResetData?.soapEventIdAtReset : usageResetData?.waterEventIdAtReset);
      if (event.id && event.id === ignoredId) continue;
      if (!event.id || savedEvents.some((saved) => String(saved.key) === event.id)) continue;
      pendingIds.set(`${deviceId}:${event.pump}`, timestampMs(data.updatedAt));
      pending.push({
        key: event.id,
        sourceDevice: deviceId,
        pump: event.pump,
        volumeMl: event.volumeMl,
        time: data.updatedAt,
        pending: true
      });
    }
  }
  for (const event of liveUsageState.pending) {
    const markerTime = pendingIds.get(`${event.sourceDevice}:${event.pump}`);
    const localTime = timestampMs(event.time);
    if (!markerTime || !localTime || Math.abs(markerTime - localTime) > 15000) pending.push(event);
  }
  return pending;
}

function savedUsageCount(deviceId, kind) {
  const predicate = kind === 'soap' ? isSoap : isWater;
  return (eventSnapshots.get(deviceId) || []).filter((event) => predicate(event) && eventIsAfterUsageReset(event)).length;
}

function totalSavedUsageCounts() {
  let soap = 0;
  let water = 0;
  for (const events of eventSnapshots.values()) {
    soap += events.filter((event) => isSoap(event) && eventIsAfterUsageReset(event)).length;
    water += events.filter((event) => isWater(event) && eventIsAfterUsageReset(event)).length;
  }
  return { soap, water };
}

function reconcilePendingLocalUsage() {
  const saved = totalSavedUsageCounts();
  let changed = false;
  for (const kind of ['soap', 'water']) {
    const count = Math.max(liveUsageState.counts[kind] || 0, saved[kind]);
    if (count !== liveUsageState.counts[kind]) {
      liveUsageState.counts[kind] = count;
      changed = true;
    }
  }
  const remaining = liveUsageState.pending.filter((pending) =>
    savedUsageCount(pending.sourceDevice, pending.pump === 'sabun' ? 'soap' : 'water') < pending.targetCount
  );
  if (remaining.length !== liveUsageState.pending.length) {
    liveUsageState.pending = remaining;
    changed = true;
  }
  if (changed) saveLiveUsageState();
}

function capturePumpTransitions(deviceId, data) {
  reconcilePendingLocalUsage();
  const state = liveUsageState.devices[deviceId] ||= {};
  for (const pump of [
    { kind: 'soap', stateKey: 'soapOn', baselineKey: 'soapBaseline', field: 'soapPump', idField: 'soapEventId', name: 'sabun' },
    { kind: 'water', stateKey: 'waterOn', baselineKey: 'waterBaseline', field: 'waterPump', idField: 'waterEventId', name: 'air' }
  ]) {
    const savedCount = savedUsageCount(deviceId, pump.kind);
    const isOn = data[pump.field] === true;
    if (!isOn) {
      state[pump.stateKey] = false;
      state[pump.baselineKey] = Math.max(Number(state[pump.baselineKey]) || 0, savedCount);
      continue;
    }
    if (state[pump.stateKey] === true) continue;

    const hasSessionId = String(data[pump.idField] || '').length > 0;
    if (!hasSessionId) {
      const baseline = Number.isFinite(Number(state[pump.baselineKey]))
        ? Number(state[pump.baselineKey])
        : savedCount;
      const pendingForPump = liveUsageState.pending.filter((item) =>
        item.sourceDevice === deviceId && item.pump === pump.name && item.targetCount > savedCount
      ).length;
      const targetCount = Math.max(baseline, savedCount) + pendingForPump + 1;
      const updatedAt = timestampMs(data.updatedAt) || Date.now();
      const alreadySavedNearThisStart = (eventSnapshots.get(deviceId) || []).some((event) => {
        const matchesPump = pump.kind === 'soap' ? isSoap(event) : isWater(event);
        const eventTime = timestampMs(event.time ?? event.timestamp ?? event.createdAt);
        return matchesPump && eventTime > 0 && Math.abs(eventTime - updatedAt) <= 12000;
      });
      const firstObservation = state[pump.stateKey] === undefined;
      if (savedCount < targetCount && !(firstObservation && alreadySavedNearThisStart)) {
        const totals = totalSavedUsageCounts();
        liveUsageState.counts[pump.kind] = Math.max(liveUsageState.counts[pump.kind] || 0, totals[pump.kind]) + 1;
        liveUsageState.pending.push({
          key: `local-${deviceId}-${pump.name}-${updatedAt}-${Math.random().toString(36).slice(2, 7)}`,
          sourceDevice: deviceId,
          pump: pump.name,
          volumeMl: pump.kind === 'water' ? Number(data.sessionMl || 0) : 0,
          time: updatedAt,
          targetCount,
          pending: true,
          local: true
        });
      }
    }
    state[pump.stateKey] = true;
  }
  liveUsageState.devices[deviceId] = state;
  saveLiveUsageState();
}

// ─── Water Wave Animation Control ───
function updateWaterWave(percent) {
  const container = $('waveContainer');
  if (!container) return;
  container.classList.remove('high', 'low');
  if (percent >= 60) {
    container.classList.add('high');
  } else if (percent < 20) {
    container.classList.add('low');
  }
}

function renderCurrent(data) {
  lastDeviceUpdate = timestampMs(data.updatedAt) || Date.now();
  if (typeof data.firmwareVersion === 'string') deviceFirmwareVersion = data.firmwareVersion;
  const soapCurrentCount = Number(data.soapCount);
  const waterCurrentCount = Number(data.waterCount);
  if (Number.isFinite(soapCurrentCount) && soapCurrentCount >= 0) {
    deviceUsageCounts.soap = Math.max(deviceUsageCounts.soap, soapCurrentCount);
  }
  if (Number.isFinite(waterCurrentCount) && waterCurrentCount >= 0) {
    deviceUsageCounts.water = Math.max(deviceUsageCounts.water, waterCurrentCount);
  }
  updateUsageCounts();
  $('volume').textContent = Number(data.sessionMl || 0).toFixed(1);
  const hasSessionPulses = Object.prototype.hasOwnProperty.call(data, 'sessionPulses');
  const sessionPulses = Number(data.sessionPulses || 0);
  $('flowStatus').textContent = !hasSessionPulses
    ? 'Firmware lama · unggah ulang untuk melihat pulsa flow meter'
    : data.waterPump
      ? (sessionPulses > 0 ? `Pompa ON · ${sessionPulses} pulsa flow meter` : 'Pompa ON · belum ada pulsa dari flow meter')
      : `Flow meter · ${sessionPulses} pulsa pada sesi ini`;
  $('soapHand').textContent = data.soapHand ? 'Terdeteksi' : 'Tidak';
  $('waterHand').textContent = data.waterHand ? 'Terdeteksi' : 'Tidak';
  $('soapState').textContent = data.soapPump ? 'ON' : 'OFF';
  $('waterState').textContent = data.waterPump ? 'ON' : 'OFF';
  $('soapState').className = `tag${data.soapPump ? ' on' : ''}`;
  $('waterState').className = `tag${data.waterPump ? ' on' : ''}`;
  if (data.levelValid) {
    const percent = Math.min(100, Math.max(0, Number(data.remainingMl || 0) / 15000 * 100));
    $('percent').textContent = percent.toFixed(1);
    $('distance').textContent = Number(data.distanceCm || 0).toFixed(1);
    $('fill').style.width = `${percent}%`;
    $('levelText').textContent = percent < 15 ? 'Persediaan hampir habis' : percent < 40 ? 'Persediaan mulai menipis' : 'Persediaan cukup';
    updateWaterWave(percent);
    if (percent < 15 && !lowStockNotificationShown) {
      lowStockNotificationShown = true;
      showToast('⚠️ Persediaan air hampir habis! Segera isi ulang galon.', 'danger');
    } else if (percent >= 15) lowStockNotificationShown = false;
  } else {
    $('percent').textContent = '—';
    $('distance').textContent = '—';
    $('fill').style.width = '0%';
    $('levelText').textContent = 'Pembacaan level belum valid';
    updateWaterWave(0);
  }
  updateLiveStatus();
}

function renderEvents() {
  allEvents = [...eventSnapshots.entries()].flatMap(([deviceId, events]) => events.map((event) => ({ ...event, sourceDevice: deviceId })));
  updateUsageCounts();

  allEvents.sort((a, b) => timestampMs(b.time ?? b.timestamp ?? b.createdAt) - timestampMs(a.time ?? a.timestamp ?? a.createdAt));
  const body = $('events');
  body.replaceChildren();
  const recent = collectUsageEvents()
    .sort((a, b) => timestampMs(b.time ?? b.timestamp ?? b.createdAt) - timestampMs(a.time ?? a.timestamp ?? a.createdAt))
    .slice(0, 30);
  if (!recent.length) {
    const row = body.insertRow();
    const cell = row.insertCell(); cell.colSpan = 5; cell.className = 'note';
    cell.textContent = 'Belum ada pemakaian tercatat.';
    return;
  }
  for (const event of recent) {
    const row = body.insertRow();
    const timeCell = row.insertCell();
    const eventTime = timestampMs(event.time ?? event.timestamp ?? event.createdAt);
    timeCell.textContent = eventTime ? new Date(eventTime).toLocaleString('id-ID') : 'Waktu tidak tersedia';
    const pumpCell = row.insertCell();
    const pumpLabel = isSoap(event) ? 'Sabun' : isWater(event) ? 'Air' : String(event.pump ?? event.pompa ?? event.pumpType ?? 'Lainnya');
    pumpCell.textContent = event.pending ? `${pumpLabel} (menunggu sinkron)` : pumpLabel;
    row.insertCell().textContent = '1 kali';
    const volumeCell = row.insertCell();
    volumeCell.textContent = isSoap(event)
      ? (Number(event.volumeMl) > 0 ? `${Number(event.volumeMl).toFixed(1)} mL` : 'Tidak diukur')
      : `${Number(event.volumeMl || 0).toFixed(1)} mL`;
    row.insertCell().textContent = event.pending ? 'Menunggu sinkron' : 'Tersimpan';
  }

  // Update chart after events update
  renderChart();
}

function collectUsageEvents() {
  const byKey = new Map();
  const candidates = [...allEvents, ...getPendingUsageEvents()];
  for (const event of candidates) {
    const key = `${event.sourceDevice || ''}:${event.key || event.id || `${pumpName(event)}:${timestampMs(event.time ?? event.timestamp ?? event.createdAt)}`}`;
    if (!byKey.has(key)) byKey.set(key, { ...event });
  }

  // While a water session is active, use its live flow-meter volume even if
  // the event's initial zero-volume record has already reached Firebase.
  for (const [deviceId, snapshot] of currentSnapshots) {
    const data = snapshot.data || {};
    if (!data.waterPump) continue;
    const eventId = String(data.waterEventId || '');
    if (!eventId) continue;
    const ignoredId = usageResetData?.eventIdsAtReset?.[deviceId]?.air
      || (deviceId === 'wastafel-01' ? usageResetData?.waterEventIdAtReset : '');
    if (eventId === ignoredId) continue;
    const key = `${deviceId}:${eventId}`;
    const liveVolume = Math.max(0, Number(data.sessionMl) || 0);
    const existing = byKey.get(key);
    if (existing) existing.volumeMl = Math.max(Number(existing.volumeMl) || 0, liveVolume);
    else if (eventIsAfterUsageReset({ time: data.updatedAt })) {
      byKey.set(key, {
        key: eventId,
        sourceDevice: deviceId,
        pump: 'air',
        volumeMl: liveVolume,
        time: data.updatedAt,
        pending: true
      });
    }
  }

  return [...byKey.values()];
}

function getUsageEventsSinceReset() {
  return collectUsageEvents().filter(eventIsAfterUsageReset);
}

function renderUsageSummary() {
  const body = $('usageSummary');
  if (!body) return;
  const events = getUsageEventsSinceReset();
  const soapCount = Math.max(0, Number($('soapCount')?.textContent) || 0);
  const waterCount = Math.max(0, Number($('waterCount')?.textContent) || 0);
  const waterMl = events.filter(isWater).reduce((sum, event) => sum + Math.max(0, Number(event.volumeMl) || 0), 0);
  const rows = [
    ['Sabun', soapCount, 'Tidak diukur', 'Jumlah pemakaian pompa'],
    ['Air', waterCount, `${waterMl.toFixed(1)} mL`, 'Akumulasi flow meter'],
    ['Keseluruhan', soapCount + waterCount, `${waterMl.toFixed(1)} mL air`, 'Volume sabun tidak diukur']
  ];
  body.replaceChildren();
  for (const values of rows) {
    const row = body.insertRow();
    if (values[0] === 'Keseluruhan') row.className = 'summary-total';
    for (const value of values) row.insertCell().textContent = String(value);
  }
}

function updateUsageCounts() {
  const eventsSinceReset = allEvents.filter(eventIsAfterUsageReset);
  const eventSoapCount = eventsSinceReset.filter(isSoap).length;
  const eventWaterCount = eventsSinceReset.filter(isWater).length;
  // Count a pump start immediately from its session ID in /current. Once the
  // same ID appears in /events, it is counted there instead.
  const pendingEvents = getPendingUsageEvents();
  const pendingSinceReset = pendingEvents.filter(eventIsAfterUsageReset);
  const pendingSoapCount = pendingSinceReset.filter(isSoap).length;
  const pendingWaterCount = pendingSinceReset.filter(isWater).length;
  const soapCountBase = Math.max(0, Number(usageResetData?.soapCountBase) || 0);
  const waterCountBase = Math.max(0, Number(usageResetData?.waterCountBase) || 0);
  const soapSinceReset = Math.max(0, deviceUsageCounts.soap - soapCountBase);
  const waterSinceReset = Math.max(0, deviceUsageCounts.water - waterCountBase);
  const soapCount = Math.max(eventSoapCount + pendingSoapCount, soapSinceReset, liveUsageState.counts.soap);
  const waterCount = Math.max(eventWaterCount + pendingWaterCount, waterSinceReset, liveUsageState.counts.water);
  $('soapCount').textContent = soapCount;
  $('waterCount').textContent = waterCount;
  $('totalCount').textContent = soapCount + waterCount;
  renderUsageSummary();
  renderChart();
}

// ─── Chart Logic ───
function renderChart() {
  const canvas = $('usageChart');
  const noteEl = $('chartNote');
  const chartEvents = getUsageEventsSinceReset();
  if (!canvas || !chartEvents.length) {
    if (noteEl) noteEl.style.display = 'block';
    if (noteEl && canvas) noteEl.textContent = usageResetData?.resetAt
      ? 'Belum ada penggunaan sejak hitungan direset.'
      : 'Belum ada riwayat penggunaan untuk ditampilkan.';
    if (canvas) canvas.style.display = 'none';
    if (usageChart) { usageChart.destroy(); usageChart = null; }
    return;
  }
  if (noteEl) noteEl.style.display = 'none';
  canvas.style.display = 'block';

  const now = new Date();
  const days = [];
  const soapData = [];
  const waterData = [];
  const waterVolumeData = [];

  for (let i = chartRange - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
    days.push(dayStr);

    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = dayStart + 86400000;

    const dayEvents = chartEvents.filter(e => {
      const t = timestampMs(e.time ?? e.timestamp ?? e.createdAt);
      return t >= dayStart && t < dayEnd;
    });

    const daySoapCount = dayEvents.filter(isSoap).length;
    const dayWater = dayEvents.filter(isWater);
    soapData.push(daySoapCount);
    waterData.push(dayWater.length);
    waterVolumeData.push(dayWater.reduce((sum, event) => sum + Math.max(0, Number(event.volumeMl) || 0), 0));
  }

  if (usageChart) {
    usageChart.data.labels = days;
    usageChart.data.datasets[0].data = soapData;
    usageChart.data.datasets[1].data = waterData;
    usageChart.data.datasets[2].data = waterVolumeData;
    usageChart.update('none');
    return;
  }

  const ctx = canvas.getContext('2d');
  usageChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        {
          label: 'Pompa Sabun (kali)',
          type: 'bar',
          data: soapData,
          yAxisID: 'yCount',
          backgroundColor: 'rgba(167, 139, 250, 0.5)',
          borderColor: 'rgba(167, 139, 250, 1)',
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Pompa Air (kali)',
          type: 'bar',
          data: waterData,
          yAxisID: 'yCount',
          backgroundColor: 'rgba(34, 211, 238, 0.5)',
          borderColor: 'rgba(34, 211, 238, 1)',
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Air keluar (mL, flow meter)',
          type: 'line',
          data: waterVolumeData,
          yAxisID: 'yVolume',
          backgroundColor: 'rgba(34, 211, 238, 0.12)',
          borderColor: 'rgba(34, 211, 238, 0.95)',
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: { family: "'Inter', sans-serif", size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'roundRect',
            padding: 16,
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 10,
          titleFont: { family: "'Inter', sans-serif", weight: '600' },
          bodyFont: { family: "'Inter', sans-serif" },
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: "'Inter', sans-serif", size: 11 } },
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.08)' }
        },
        yCount: {
          beginAtZero: true,
          ticks: { color: '#64748b', font: { family: "'Inter', sans-serif", size: 11 }, stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.08)' },
          title: { display: true, text: 'Pemakaian (kali)', color: '#94a3b8' }
        },
        yVolume: {
          position: 'right',
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: { color: '#64748b', font: { family: "'Inter', sans-serif", size: 11 }, callback: (value) => `${value} mL` },
          border: { color: 'rgba(255,255,255,0.08)' },
          title: { display: true, text: 'Volume keluar (mL)', color: '#94a3b8' }
        }
      }
    }
  });
}

// Chart tab click handlers
document.querySelectorAll('.chart-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    chartRange = parseInt(tab.dataset.range, 10);
    if (usageChart) { usageChart.destroy(); usageChart = null; }
    renderChart();
  });
});

function buildCsvRows() {
  const exportEvents = collectUsageEvents()
    .sort((a, b) => timestampMs(a.time ?? a.timestamp ?? a.createdAt) - timestampMs(b.time ?? b.timestamp ?? b.createdAt));
  const summaryEvents = getUsageEventsSinceReset();
  const soapCount = Math.max(0, Number($('soapCount').textContent) || 0);
  const waterCount = Math.max(0, Number($('waterCount').textContent) || 0);
  const waterMl = summaryEvents.filter(isWater).reduce((sum, event) => sum + Math.max(0, Number(event.volumeMl) || 0), 0);
  return [
    ['RINGKASAN PENGGUNAAN SEJAK RESET'],
    ['Jenis pompa', 'Jumlah penggunaan', 'Total keluar (mL)', 'Dasar volume'],
    ['Sabun', soapCount, 'Tidak diukur', 'Jumlah pemakaian pompa'],
    ['Air', waterCount, waterMl.toFixed(1), 'Akumulasi flow meter'],
    ['Keseluruhan', soapCount + waterCount, `${waterMl.toFixed(1)} mL air`, 'Volume sabun tidak diukur'],
    [],
    ['RIWAYAT LENGKAP'],
    ['Waktu perangkat', 'Pompa', 'Jumlah pakai', 'Volume keluar (mL)', 'Status'],
    ...exportEvents.map((event) => [
    timestampMs(event.time ?? event.timestamp ?? event.createdAt) ? new Date(timestampMs(event.time ?? event.timestamp ?? event.createdAt)).toLocaleString('id-ID') : '',
    isSoap(event) ? 'Sabun' : isWater(event) ? 'Air' : String(event.pump ?? event.pompa ?? event.pumpType ?? event.jenisPompa ?? 'Lainnya'),
    1,
    isSoap(event) ? (Number(event.volumeMl) > 0 ? Number(event.volumeMl).toFixed(1) : 'Tidak diukur') : Number(event.volumeMl || 0).toFixed(1),
    event.pending ? 'Menunggu sinkron ke Firebase' : 'Tersimpan'
    ])
  ];
}

function buildCsvContent() {
  const rows = buildCsvRows();
  const csv = '\ufeff' + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\r\n');
  return csv;
}

function downloadCsv() {
  const csv = buildCsvContent();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'smart-handwash-log.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderCsvPreview() {
  const body = $('csvPreviewBody');
  const mobile = $('csvPreviewMobile');
  body.replaceChildren();
  mobile.replaceChildren();
  let labels = [];
  for (const row of buildCsvRows()) {
    if (!row.length) continue;
    const tr = document.createElement('tr');
    if (row.length === 1) {
      tr.className = 'csv-preview-section';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = String(row[0]);
      tr.append(td);
      const section = document.createElement('h3');
      section.className = 'csv-preview-mobile-section';
      section.textContent = String(row[0]);
      mobile.append(section);
    } else {
      if (row[0] === 'Jenis pompa' || row[0] === 'Waktu perangkat') {
        tr.className = 'csv-preview-heading';
        labels = row.map(String);
      }
      if (row[0] === 'Keseluruhan') tr.className = 'csv-preview-total';
      for (const value of row) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.append(td);
      }
      if (row[0] !== 'Jenis pompa' && row[0] !== 'Waktu perangkat') {
        const card = document.createElement('article');
        card.className = `csv-preview-mobile-row${row[0] === 'Keseluruhan' ? ' is-total' : ''}`;
        row.forEach((value, index) => {
          const field = document.createElement('div');
          field.className = 'csv-preview-mobile-field';
          const label = document.createElement('span');
          label.textContent = labels[index] || `Kolom ${index + 1}`;
          const content = document.createElement('strong');
          content.textContent = String(value);
          field.append(label, content);
          card.append(field);
        });
        mobile.append(card);
      }
    }
    body.append(tr);
  }
}

function closeCsvPreview() {
  $('csvPreview').style.display = 'none';
  document.body.classList.remove('csv-preview-open');
}

$('previewCsvBtn').onclick = () => {
  renderCsvPreview();
  $('csvPreview').style.display = 'grid';
  document.body.classList.add('csv-preview-open');
};
$('closeCsvPreviewBtn').onclick = closeCsvPreview;
$('csvPreview').addEventListener('click', (event) => {
  if (event.target === $('csvPreview')) closeCsvPreview();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('csvPreview').style.display !== 'none') closeCsvPreview();
});
$('previewCsvDownloadBtn').onclick = downloadCsv;
$('csvBtn').onclick = downloadCsv;

$('resetCountBtn').onclick = async () => {
  if (!db || !currentAuth) {
    showToast('Hubungkan dashboard ke Firebase sebelum mereset jumlah.', 'warning');
    return;
  }
  const accepted = window.confirm('Reset jumlah penggunaan sabun dan air menjadi 0 mulai sekarang? Riwayat dan CSV lama tetap disimpan.');
  if (!accepted) return;

  const newestCurrent = [...currentSnapshots.entries()].sort((a, b) =>
    (timestampMs(b[1].data.updatedAt) || b[1].receivedAt) - (timestampMs(a[1].data.updatedAt) || a[1].receivedAt)
  )[0]?.[1]?.data || {};
  const resetData = {
    id: globalThis.crypto?.randomUUID?.() || `reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    resetAt: Date.now(),
    soapCountBase: Math.max(0, Number(deviceUsageCounts.soap) || 0),
    waterCountBase: Math.max(0, Number(deviceUsageCounts.water) || 0),
    eventIdsAtReset: Object.fromEntries([...currentSnapshots.entries()].map(([deviceId, snapshot]) => [deviceId, {
      sabun: String(snapshot.data.soapEventId || ''),
      air: String(snapshot.data.waterEventId || '')
    }])),
    soapEventIdAtReset: String(newestCurrent.soapEventId || ''),
    waterEventIdAtReset: String(newestCurrent.waterEventId || '')
  };

  try {
    await set(ref(db, 'devices/wastafel-01/meta/usageReset'), resetData);
    showToast('Jumlah pemakaian dimulai dari 0. Riwayat lama tetap tersimpan.', 'warning');
  } catch (error) {
    showToast(`Reset gagal disimpan ke Firebase: ${error.message}`, 'danger');
  }
};

// ═══════════════════════════════════════
// INIT — Try auto-login on page load
// ═══════════════════════════════════════
tryAutoLogin();
