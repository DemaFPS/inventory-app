/**
 * app.js – ИТОГОВАЯ ВЕРСИЯ (с исправлениями дат и печати)
 * 
 * Исправления:
 * - В таблице (вкладка «Таблица») колонки с датами автоматически форматируются в ДД.ММ.ГГГГ.
 * - Колонка «История перемещений» показывает только последнее событие и не редактируется.
 * - Печать отчёта адаптирована под мобильные устройства, таблица занимает всю ширину страницы.
 * - Остальные исправления: уникализация номеров, проверка дубликатов, офлайн-режим и т.д.
 */

// ============================
// 0. КОНФИГУРАЦИЯ FIREBASE
// ============================
const firebaseConfig = {
  apiKey: "AIzaSyCsPVf6XFCi9_dZlK53mqAXB9RjBGcfMnc",
  authDomain: "inventory-app-8f696.firebaseapp.com",
  projectId: "inventory-app-8f696",
  storageBucket: "inventory-app-8f696.firebasestorage.app",
  messagingSenderId: "8094390774",
  appId: "1:8094390774:web:d4670df16ea46a92fd0fd7",
  measurementId: "G-WBXD71W2YF"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// ============================
// 1. ПРОКСИ URL (ЗАМЕНИТЕ НА СВОЙ)
// ============================
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzVVMRcaSoe7Au1ujt6DygbWTOkrM_J2UrLIu8ealrQBDNwowa7BN43tdipq-rk-F-L/exec';

// ============================
// 2. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================
let inventoryData = [];
let cabinetsData = [];
let currentDevice = null;
let scannerInstance = null;
let isScanning = false;
let isInitializingScanner = false;
let currentUser = null;
let localUserName = localStorage.getItem('localUserName') || 'Аноним';
let isCreating = false;
let pendingScanText = '';
let torchOn = false;
let torchTrack = null;

// ===== ПЕРЕМЕННЫЕ ДЛЯ ТАБЛИЦЫ =====
let tableData = [];
let tableHeaders = [];
let tableFilteredData = [];
let currentSheet = 'Inventory';
let isLoadingTable = false;

// ============================
// 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================
function showToast(message, type = 'success') {
    const toastEl = document.getElementById('liveToast');
    if (!toastEl) return;
    const toastBody = document.getElementById('toastMessage');
    if (!toastBody) return;
    toastBody.textContent = message;
    toastEl.className = `toast align-items-center text-white border-0 bg-${type}`;
    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
}

function normalizeInventoryNumber(str) {
    if (str === undefined || str === null) return '';
    let s = String(str).trim();
    s = s.replace(/^0+/, '') || '0';
    return s.toUpperCase();
}

function validateInventoryNumber(str) {
    if (str === undefined || str === null) return false;
    const original = String(str).trim();
    if (original.length < 6 || original.length > 20) return false;
    const regex = /^[A-Za-zА-Яа-я0-9]+(?:-[A-Za-zА-Яа-я0-9]+)?$/;
    if (!regex.test(original)) return false;
    return true;
}

function parseDateFromString(dateStr) {
    if (!dateStr) return null;
    let date = new Date(dateStr);
    if (!isNaN(date.getTime())) return date;
    let clean = String(dateStr).replace(/[^0-9.]/g, '');
    if (!clean) return null;
    const parts = clean.split('.');
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (day < 1 || day > 31 || month < 0 || month > 11 || year < 1000 || year > 3000) return null;
    return new Date(year, month, day);
}

function isWarrantyExpiring(warrantyDateStr) {
    const date = parseDateFromString(warrantyDateStr);
    if (!date) return false;
    const now = new Date();
    const diff = (date - now) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 30;
}

function isWarrantyExpired(warrantyDateStr) {
    const date = parseDateFromString(warrantyDateStr);
    if (!date) return false;
    return date < new Date();
}

function showScreen(screenId) {
    if (!screenId) return;
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.screen === screenId);
    });
    if (screenId === 'scanner') { initScanner(); } else { stopScanner(); }
    if (screenId === 'dashboard') updateDashboardStats();
    if (screenId === 'logs') renderLogs();
    if (screenId === 'checklist') renderChecklist(document.getElementById('cabinetSelect')?.value);
    if (screenId === 'data') loadSheetData(document.getElementById('sheetSelect')?.value || 'Inventory');
    setTimeout(updateActivePill, 50);
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) return dateStr;
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}.${month}.${year}`;
    }
    const parsed = parseDateFromString(dateStr);
    if (parsed) {
        const day = String(parsed.getDate()).padStart(2, '0');
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const year = parsed.getFullYear();
        return `${day}.${month}.${year}`;
    }
    return String(dateStr);
}

function getStatusColorClass(device) {
    if (!device) return 'status-red';
    const status = device.status || '';
    if (status === 'Списан') return 'status-red';
    if (status === 'В ремонте') return 'status-red';
    if (status === 'На складе') return 'status-grey';
    if (status === 'В эксплуатации') {
        if (isWarrantyExpired(device.warrantyEndDate)) return 'status-red';
        if (isWarrantyExpiring(device.warrantyEndDate)) return 'status-yellow';
        return 'status-green';
    }
    return 'status-yellow';
}

function playBeep(success = true) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = success ? 800 : 400;
        osc.type = 'sine';
        gain.gain.value = 0.15;
        osc.start();
        setTimeout(() => { osc.stop(); }, 200);
    } catch (e) { /* ignore */ }
}

function vibrate(duration = 100) {
    if (navigator.vibrate) navigator.vibrate(duration);
}

function getInitiatorName() {
    if (currentUser && currentUser.displayName) return currentUser.displayName;
    if (currentUser) return currentUser.uid.substring(0, 8);
    return localUserName || 'Аноним';
}

function uniqueArray(arr) {
    return arr.filter((v, i, a) => a.indexOf(v) === i);
}

// ============================
// 4. РАБОТА С ПРОКСИ
// ============================
async function callProxy(action, payload = {}) {
    try {
        const response = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action, payload })
        });
        if (!response.ok) throw new Error(`Ошибка HTTP: ${response.status}`);
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`Сервер вернул невалидный JSON: ${text.substring(0, 50)}`); }
        if (!data || typeof data !== 'object') throw new Error('Пустой или невалидный ответ от сервера');
        if (!data.success) throw new Error(data.error || data.message || 'Неизвестная ошибка');
        return data;
    } catch (error) {
        console.error('Ошибка прокси:', error);
        throw error;
    }
}

async function loadInventory() {
    try {
        const result = await callProxy('read');
        inventoryData = Array.isArray(result.inventory) ? result.inventory.map(d => {
            if (d && d.inventoryNumber !== undefined && d.inventoryNumber !== null) {
                d.inventoryNumber = String(d.inventoryNumber).trim();
            }
            return d;
        }) : [];
        cabinetsData = Array.isArray(result.cabinets) ? result.cabinets.map(c => {
            if (c && c.inventoryNumbers && typeof c.inventoryNumbers === 'string') {
                c.inventoryNumbers = c.inventoryNumbers.split(',').map(s => s.trim());
            }
            if (c && c.inventoryNumbers) {
                c.inventoryNumbers = uniqueArray(c.inventoryNumbers);
            }
            return c;
        }) : [];
        localStorage.setItem('inventoryCache', JSON.stringify(inventoryData));
        localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));
        console.log('Данные загружены:', inventoryData.length, 'единиц');
        return { inventory: inventoryData, cabinets: cabinetsData };
    } catch (error) {
        console.warn('Ошибка загрузки, пробуем кэш:', error);
        const cachedInv = localStorage.getItem('inventoryCache');
        const cachedCab = localStorage.getItem('cabinetsCache');
        if (cachedInv && cachedCab) {
            try {
                inventoryData = JSON.parse(cachedInv) || [];
                cabinetsData = JSON.parse(cachedCab) || [];
                cabinetsData.forEach(c => { if (c.inventoryNumbers) c.inventoryNumbers = uniqueArray(c.inventoryNumbers); });
                showToast('Загружены данные из кэша (офлайн-режим)', 'warning');
                return { inventory: inventoryData, cabinets: cabinetsData };
            } catch (e) {
                showToast('Ошибка чтения кэша', 'danger');
                throw e;
            }
        }
        showToast('Ошибка загрузки данных: ' + error.message, 'danger');
        throw error;
    }
}

async function updateDevice(inventoryNumber, updates) {
    if (!validateInventoryNumber(inventoryNumber)) {
        showToast('Неверный формат инвентарного номера', 'danger');
        throw new Error('Invalid inventory number');
    }
    try {
        const result = await callProxy('update', { inventoryNumber, updates });
        showToast(result.message || 'Устройство обновлено', 'success');
        const idx = inventoryData.findIndex(d => d && d.inventoryNumber === inventoryNumber);
        if (idx !== -1) {
            inventoryData[idx] = { ...inventoryData[idx], ...updates };
            localStorage.setItem('inventoryCache', JSON.stringify(inventoryData));
        }
        return result;
    } catch (error) {
        throw error;
    }
}

async function addDevice(deviceData) {
    const { inventoryNumber, cabinet, model, serialNumber, status, responsiblePerson, warrantyEndDate } = deviceData;
    if (!inventoryNumber || !validateInventoryNumber(inventoryNumber)) {
        showToast('Неверный инвентарный номер', 'danger');
        throw new Error('Invalid inventory number');
    }
    const normalized = normalizeInventoryNumber(inventoryNumber);
    const localExists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (localExists) {
        showToast('Устройство с таким номером уже существует (локально)', 'warning');
        throw new Error('Duplicate local');
    }
    if (navigator.onLine) {
        try {
            const result = await callProxy('read');
            const serverExists = result.inventory.some(d => {
                const num = d && d.inventoryNumber ? String(d.inventoryNumber).trim() : '';
                return normalizeInventoryNumber(num) === normalized;
            });
            if (serverExists) {
                showToast('Устройство с таким номером уже существует в базе', 'warning');
                await loadInventory();
                updateDashboardStats();
                throw new Error('Duplicate server');
            }
        } catch (e) {
            if (e.message && (e.message.includes('уже существует') || e.message.includes('Duplicate'))) throw e;
            console.warn('Ошибка проверки на сервере, продолжаем создание:', e);
        }
    }
    try {
        const result = await callProxy('add', {
            inventoryNumber,
            cabinet: cabinet || '',
            model: model || '',
            serialNumber: serialNumber || '',
            status: status || 'В эксплуатации',
            responsiblePerson: responsiblePerson || '',
            warrantyEndDate: warrantyEndDate || '',
            initiator: getInitiatorName()
        });
        showToast(result.message || 'Устройство создано', 'success');
        const now = new Date().toLocaleString('ru-RU');
        const newDevice = {
            inventoryNumber: inventoryNumber,
            cabinet: cabinet || '',
            model: model || '',
            serialNumber: serialNumber || '',
            status: status || 'В эксплуатации',
            responsiblePerson: responsiblePerson || '',
            warrantyEndDate: warrantyEndDate || '',
            history: `${now} Создано (${getInitiatorName()})`,
            lastModified: now,
            initiator: getInitiatorName()
        };
        inventoryData.push(newDevice);
        localStorage.setItem('inventoryCache', JSON.stringify(inventoryData));
        updateDashboardStats();

        if (cabinet) {
            const cab = cabinetsData.find(c => c.cabinet === cabinet);
            let numbers = cab ? cab.inventoryNumbers : [];
            if (!numbers.includes(inventoryNumber)) {
                numbers.push(inventoryNumber);
                numbers = uniqueArray(numbers);
                await updateCabinetList(cabinet, numbers);
                const cabIdx = cabinetsData.findIndex(c => c.cabinet === cabinet);
                if (cabIdx !== -1) {
                    cabinetsData[cabIdx].inventoryNumbers = numbers;
                } else {
                    cabinetsData.push({ cabinet, inventoryNumbers: numbers });
                }
                localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));
            }
        }

        return result;
    } catch (error) {
        if (error.message && (error.message.includes('уже существует') || error.message.includes('Duplicate'))) {
            showToast('Устройство с таким номером уже существует в базе', 'warning');
            await loadInventory();
            updateDashboardStats();
        } else {
            showToast('Ошибка создания: ' + error.message, 'danger');
        }
        throw error;
    }
}

// ============================
// 5. ФУНКЦИИ ДЛЯ ТАБЛИЦЫ
// ============================
async function getSheetData(sheetName) {
    try {
        const result = await callProxy('getSheetData', { sheetName });
        return result.data || [];
    } catch (error) {
        console.error('Ошибка получения данных листа:', error);
        showToast('Ошибка загрузки листа: ' + error.message, 'danger');
        return [];
    }
}

async function updateSheetCell(sheetName, row, col, value) {
    try {
        const result = await callProxy('updateCell', { sheetName, row, col, value });
        showToast(result.message || 'Ячейка обновлена', 'success');
        return result;
    } catch (error) {
        console.error('Ошибка обновления ячейки:', error);
        showToast('Ошибка обновления: ' + error.message, 'danger');
        throw error;
    }
}

async function updateCabinetList(cabinetName, inventoryNumbers) {
    const unique = uniqueArray(inventoryNumbers);
    try {
        const result = await callProxy('updateChecklist', { cabinet: cabinetName, inventoryNumbers: unique });
        showToast(result.message || 'Аудитория обновлена', 'success');
        return result;
    } catch (error) {
        console.error('Ошибка обновления аудитории:', error);
        showToast('Ошибка обновления: ' + error.message, 'danger');
        throw error;
    }
}

// ============================
// 6. ДАШБОРД
// ============================
function updateDashboardStats() {
    const total = inventoryData.length;
    const inUse = inventoryData.filter(d => {
        const status = d && d.status || '';
        return status === 'В эксплуатации';
    }).length;
    const expiring = inventoryData.filter(d => {
        const date = parseDateFromString(d && d.warrantyEndDate);
        if (!date) return false;
        const now = new Date();
        const diff = (date - now) / (1000 * 60 * 60 * 24);
        return diff <= 30;
    }).length;
    const inRepair = inventoryData.filter(d => {
        const status = d && d.status || '';
        return status === 'В ремонте';
    }).length;
    const inactive = inventoryData.filter(d => {
        const status = d && d.status || '';
        return status === 'Списан' || status === 'На складе';
    }).length;

    document.getElementById('totalCount').textContent = total;
    document.getElementById('inUseCount').textContent = inUse;
    document.getElementById('expiringCount').textContent = expiring;
    document.getElementById('repairCount').textContent = inRepair;
    document.getElementById('inactiveCount').textContent = inactive;
}

// ============================
// 7. СКАНЕР
// ============================
async function initScanner() {
    if (isInitializingScanner) return;
    if (scannerInstance && isScanning) return;

    isInitializingScanner = true;
    try {
        if (typeof Html5Qrcode === 'undefined') {
            throw new Error('Библиотека html5-qrcode не загружена.');
        }
        const readerElement = document.getElementById('reader');
        if (!readerElement) throw new Error('Элемент #reader не найден');
        if (scannerInstance) {
            try { await scannerInstance.stop(); await scannerInstance.clear(); } catch(e) {}
            scannerInstance = null;
        }
        readerElement.innerHTML = '';
        scannerInstance = new Html5Qrcode("reader");

        const containerWidth = readerElement.offsetWidth || 400;
        const isLandscape = window.innerWidth > window.innerHeight;
        const qrboxWidth = isLandscape 
            ? Math.min(containerWidth - 20, 800)
            : Math.min(containerWidth - 20, 500);

        const config = {
            fps: 20,
            qrbox: {
                width: qrboxWidth,
                height: isLandscape ? 200 : 280
            },
            experimentalFeatures: {
                useBarCodeDetectorIfSupported: true
            }
        };

        console.log('Сканер инициализирован с размерами:', config.qrbox, 'Ориентация:', isLandscape ? 'альбомная' : 'портретная');

        await scannerInstance.start(
            { facingMode: "environment" },
            config,
            onScanSuccess,
            onScanError
        );
        isScanning = true;
        isInitializingScanner = false;
        console.log('Сканер запущен с поддержкой переворота экрана');

        const torchBtn = document.getElementById('torchBtn');
        if (torchBtn) torchBtn.style.display = 'flex';

        try {
            const videoElement = readerElement.querySelector('video');
            if (videoElement && videoElement.srcObject) {
                const tracks = videoElement.srcObject.getVideoTracks();
                if (tracks.length > 0) {
                    torchTrack = tracks[0];
                    if (typeof torchTrack.getCapabilities === 'function') {
                        const caps = torchTrack.getCapabilities();
                        if (caps && caps.torch) {
                            console.log('Фонарик поддерживается');
                        } else {
                            console.log('Фонарик не поддерживается');
                            torchTrack = null;
                        }
                    } else {
                        torchTrack = null;
                    }
                }
            }
        } catch (e) {
            console.warn('Не удалось получить трек для фонарика:', e);
            torchTrack = null;
        }

    } catch (err) {
        console.error('Ошибка запуска сканера:', err);
        showToast('Не удалось получить доступ к камере: ' + err.message, 'danger');
        document.querySelector('.manual-input').style.display = 'block';
        isInitializingScanner = false;
    }
}

function stopScanner() {
    if (!scannerInstance || !isScanning) {
        const torchBtn = document.getElementById('torchBtn');
        if (torchBtn) torchBtn.style.display = 'none';
        torchOn = false;
        torchTrack = null;
        return;
    }

    try {
        if (torchOn && torchTrack) {
            try {
                torchTrack.applyConstraints({ advanced: [{ torch: false }] });
                torchOn = false;
                const torchBtn = document.getElementById('torchBtn');
                if (torchBtn) {
                    torchBtn.innerHTML = '<i class="bi bi-lightbulb"></i> Фонарик';
                    torchBtn.classList.remove('btn-success');
                    torchBtn.classList.add('btn-warning');
                }
            } catch (e) {}
        }

        if (scannerInstance && typeof scannerInstance.stop === 'function') {
            setTimeout(() => {
                scannerInstance.stop()
                    .then(() => {
                        isScanning = false;
                        console.log('Сканер успешно остановлен');
                    })
                    .catch(err => {
                        console.warn('Ошибка при остановке сканера:', err);
                        isScanning = false;
                    });
            }, 100);
        } else {
            isScanning = false;
        }
    } catch (e) {
        console.warn('Исключение при остановке сканера:', e);
        isScanning = false;
    }

    const torchBtn = document.getElementById('torchBtn');
    if (torchBtn) torchBtn.style.display = 'none';
    torchOn = false;
    torchTrack = null;
}

// ============================
// 8. ОБРАБОТКА СКАНИРОВАНИЯ
// ============================
async function onScanSuccess(decodedText, decodedResult) {
    if (!decodedText) return;
    vibrate(100);
    playBeep(true);
    stopScanner();

    const rawText = decodedText.trim();

    if (rawText.startsWith('http://') || rawText.startsWith('https://')) {
        if (navigator.onLine) {
            const modal = new bootstrap.Modal(document.getElementById('qrLinkModal'));
            document.getElementById('qrLinkText').textContent = rawText;
            document.getElementById('qrLinkHref').href = rawText;
            modal.show();
        } else {
            savePendingScan(rawText, 'qr');
            showToast('Ссылка сохранена в журнале (офлайн).', 'warning');
            setTimeout(() => {
                if (document.getElementById('scanner').classList.contains('active')) initScanner();
            }, 1500);
        }
        return;
    }

    pendingScanText = rawText;
    document.getElementById('confirmScanInput').value = rawText;
    const modal = new bootstrap.Modal(document.getElementById('confirmScanModal'));
    modal.show();
}

function onScanError(err) { /* игнорируем */ }

// ============================
// 9. ФУНКЦИЯ: ОБЕСПЕЧИТЬ АКТИВНЫЙ СТАТУС И АУДИТОРИЮ
// ============================
async function ensureDeviceActiveAndInCabinet(inventoryNumber, cabinet) {
    const normalized = normalizeInventoryNumber(inventoryNumber);
    const device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (!device) {
        await addDevice({
            inventoryNumber: inventoryNumber,
            cabinet: cabinet,
            model: '',
            serialNumber: '',
            status: 'В эксплуатации',
            responsiblePerson: '',
            warrantyEndDate: ''
        });
        return true;
    } else {
        let updates = {};
        let needUpdate = false;
        if (device.status !== 'В эксплуатации') {
            updates.status = 'В эксплуатации';
            needUpdate = true;
        }
        if (device.cabinet !== cabinet) {
            updates.cabinet = cabinet;
            needUpdate = true;
        }
        if (needUpdate) {
            const now = new Date().toLocaleString('ru-RU');
            const historyEntry = `${now} Добавлен в аудиторию ${cabinet} (статус изменён на "В эксплуатации") (${getInitiatorName()})`;
            updates.history = (device.history || '') + (device.history ? '; ' : '') + historyEntry;
            updates.lastModified = now;
            updates.initiator = getInitiatorName();
            await updateDevice(inventoryNumber, updates);
            const idx = inventoryData.findIndex(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
            if (idx !== -1) {
                inventoryData[idx] = { ...inventoryData[idx], ...updates };
                localStorage.setItem('inventoryCache', JSON.stringify(inventoryData));
            }
            showToast(`Устройство ${inventoryNumber} обновлено (статус → "В эксплуатации", аудитория → ${cabinet})`, 'success');
            return true;
        }
        return false;
    }
}

// ============================
// 10. ОБРАБОТЧИКИ DOM
// ============================
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('confirmScanOkBtn')?.addEventListener('click', function() {
        const input = document.getElementById('confirmScanInput');
        let value = input.value.trim();
        if (!value) {
            showToast('Номер не может быть пустым', 'warning');
            return;
        }
        const modal = bootstrap.Modal.getInstance(document.getElementById('confirmScanModal'));
        if (modal) modal.hide();
        processScannedBarcode(value);
    });
    document.getElementById('confirmScanEditBtn')?.addEventListener('click', function() {
        document.getElementById('confirmScanInput').focus();
        document.getElementById('confirmScanInput').select();
    });
    document.getElementById('confirmScanInput')?.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            document.getElementById('confirmScanOkBtn').click();
        }
    });

    document.getElementById('torchBtn')?.addEventListener('click', function() {
        if (!scannerInstance) {
            showToast('Сканер не запущен', 'warning');
            return;
        }
        if (!torchTrack) {
            showToast('Фонарик не поддерживается на этом устройстве', 'warning');
            return;
        }
        try {
            const newState = !torchOn;
            torchTrack.applyConstraints({
                advanced: [{ torch: newState }]
            }).then(() => {
                torchOn = newState;
                this.innerHTML = torchOn ? 
                    '<i class="bi bi-lightbulb-fill"></i> Выкл' : 
                    '<i class="bi bi-lightbulb"></i> Фонарик';
                this.classList.toggle('btn-warning', !torchOn);
                this.classList.toggle('btn-success', torchOn);
                console.log('Фонарик:', torchOn ? 'ВКЛ' : 'ВЫКЛ');
            }).catch(err => {
                console.error('Ошибка переключения фонарика:', err);
                showToast('Ошибка: ' + err.message, 'danger');
            });
        } catch (e) {
            console.error('Ошибка переключения фонарика:', e);
            showToast('Ошибка: ' + e.message, 'danger');
        }
    });

    window.addEventListener('resize', function() {
        if (document.getElementById('scanner').classList.contains('active')) {
            stopScanner();
            setTimeout(() => {
                initScanner();
            }, 300);
        }
    });

    window.addEventListener('orientationchange', function() {
        if (document.getElementById('scanner').classList.contains('active')) {
            setTimeout(() => {
                stopScanner();
                setTimeout(() => {
                    initScanner();
                }, 300);
            }, 400);
        }
    });

    // ===== ОБОРОТНАЯ ВЕДОМОСТЬ =====
    document.getElementById('editChecklistBtn')?.addEventListener('click', function() {
        const cabinet = document.getElementById('cabinetSelect')?.value;
        if (!cabinet) {
            showToast('Выберите аудиторию', 'warning');
            return;
        }
        isChecklistEditMode = true;
        renderChecklist(cabinet);
    });

    document.getElementById('addChecklistItemBtn')?.addEventListener('click', async function() {
        const input = document.getElementById('newChecklistItemInput');
        if (!input || !input.value.trim()) {
            showToast('Введите инвентарный номер', 'warning');
            return;
        }
        const num = input.value.trim();
        if (!validateInventoryNumber(num)) {
            showToast('Неверный формат номера (6-20 символов)', 'danger');
            return;
        }
        const cabinet = document.getElementById('cabinetSelect')?.value;
        if (!cabinet) {
            showToast('Аудитория не выбрана', 'warning');
            return;
        }

        await loadInventory();

        const currentCabinet = cabinetsData.find(c => c.cabinet === cabinet);
        const currentNumbers = currentCabinet ? currentCabinet.inventoryNumbers : [];
        if (currentNumbers.some(n => normalizeInventoryNumber(n) === normalizeInventoryNumber(num))) {
            showToast('Такой номер уже есть в списке аудитории', 'warning');
            return;
        }

        await ensureDeviceActiveAndInCabinet(num, cabinet);

        await loadInventory();

        const updatedCabinet = cabinetsData.find(c => c.cabinet === cabinet);
        const updatedNumbers = updatedCabinet ? updatedCabinet.inventoryNumbers : [];
        if (updatedNumbers.some(n => normalizeInventoryNumber(n) === normalizeInventoryNumber(num))) {
            renderChecklist(cabinet);
            input.value = '';
            showToast('Номер уже присутствует в списке', 'info');
            return;
        }

        const newNumbers = uniqueArray([...updatedNumbers, num]);
        await updateCabinetList(cabinet, newNumbers);
        const cabIdx = cabinetsData.findIndex(c => c.cabinet === cabinet);
        if (cabIdx !== -1) {
            cabinetsData[cabIdx].inventoryNumbers = newNumbers;
        } else {
            cabinetsData.push({ cabinet, inventoryNumbers: newNumbers });
        }
        localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));

        renderChecklist(cabinet);
        input.value = '';
        showToast('Номер добавлен в список', 'success');
    });

    document.getElementById('removeSelectedChecklistBtn')?.addEventListener('click', function() {
        const checked = document.querySelectorAll('.checklist-item-checkbox:checked');
        if (checked.length === 0) {
            showToast('Выберите элементы для удаления', 'warning');
            return;
        }
        if (!confirm(`Удалить ${checked.length} элемент(ов)?`)) return;
        const cabinet = document.getElementById('cabinetSelect')?.value;
        if (!cabinet) {
            showToast('Аудитория не выбрана', 'warning');
            return;
        }
        const items = document.querySelectorAll('#checklistItems .list-group-item span');
        const numbers = [];
        items.forEach(span => {
            const num = span.textContent.trim();
            if (num) numbers.push(num);
        });
        checked.forEach(cb => {
            const item = cb.closest('.list-group-item');
            if (item) item.remove();
        });
        const finalNumbers = [];
        document.querySelectorAll('#checklistItems .list-group-item span').forEach(span => {
            const num = span.textContent.trim();
            if (num) finalNumbers.push(num);
        });
        const uniqueFinal = uniqueArray(finalNumbers);
        updateCabinetList(cabinet, uniqueFinal).then(() => {
            const cabIdx = cabinetsData.findIndex(c => c.cabinet === cabinet);
            if (cabIdx !== -1) {
                cabinetsData[cabIdx].inventoryNumbers = uniqueFinal;
            }
            localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));
            renderChecklist(cabinet);
            showToast(`Удалено ${checked.length} элементов`, 'success');
        }).catch(e => {
            showToast('Ошибка удаления: ' + e.message, 'danger');
        });
    });

    // ===== ВКЛАДКА "ТАБЛИЦА" =====
    document.getElementById('backFromData')?.addEventListener('click', function() {
        showScreen('dashboard');
    });

    document.getElementById('sheetSelect')?.addEventListener('change', function() {
        currentSheet = this.value;
        loadSheetData(this.value);
    });

    document.getElementById('refreshDataBtn2')?.addEventListener('click', function() {
        const sheet = document.getElementById('sheetSelect').value;
        loadSheetData(sheet);
    });

    document.getElementById('tableSearchInput')?.addEventListener('input', function() {
        applyFiltersAndSearch();
    });

    document.getElementById('addRowBtn')?.addEventListener('click', async function() {
        if (!tableHeaders.length) {
            showToast('Сначала загрузите данные', 'warning');
            return;
        }
        const newRow = new Array(tableHeaders.length).fill('');
        const sheet = document.getElementById('sheetSelect').value;
        try {
            const result = await callProxy('addRow', { sheetName: sheet, rowData: newRow });
            showToast(result.message || 'Строка добавлена', 'success');
            loadSheetData(sheet);
        } catch (e) {
            showToast('Ошибка добавления: ' + e.message, 'danger');
        }
    });

    document.getElementById('deleteRowsBtn')?.addEventListener('click', async function() {
        const checked = document.querySelectorAll('.row-selector:checked');
        if (checked.length === 0) {
            showToast('Выберите строки для удаления', 'warning');
            return;
        }
        if (!confirm(`Удалить ${checked.length} строк(и)?`)) return;
        const rowIndices = Array.from(checked).map(cb => parseInt(cb.dataset.sheetRow)).filter(idx => !isNaN(idx) && idx > 0);
        if (rowIndices.length === 0) {
            showToast('Не удалось определить номера строк', 'danger');
            return;
        }
        const sheet = document.getElementById('sheetSelect').value;
        try {
            const result = await callProxy('deleteRows', { sheetName: sheet, rowIndices: rowIndices });
            showToast(result.message || 'Строки удалены', 'success');
            loadSheetData(sheet);
        } catch (e) {
            showToast('Ошибка удаления: ' + e.message, 'danger');
        }
    });

    const createModal = document.getElementById('createDeviceModal');
    if (createModal) {
        createModal.addEventListener('show.bs.modal', function() {
            const select = document.getElementById('createCabinet');
            if (select) {
                select.innerHTML = '<option value="">— Не выбрана —</option>';
                cabinetsData.forEach(cab => {
                    if (cab && cab.cabinet) {
                        const opt = document.createElement('option');
                        opt.value = cab.cabinet;
                        opt.textContent = cab.cabinet;
                        select.appendChild(opt);
                    }
                });
            }
        });
    }

    const editModal = document.getElementById('editModal');
    if (editModal) {
        editModal.addEventListener('show.bs.modal', function() {
            const select = document.getElementById('editCabinet');
            if (select) {
                select.innerHTML = '<option value="">— Не выбрана —</option>';
                cabinetsData.forEach(cab => {
                    if (cab && cab.cabinet) {
                        const opt = document.createElement('option');
                        opt.value = cab.cabinet;
                        opt.textContent = cab.cabinet;
                        if (currentDevice && currentDevice.cabinet === cab.cabinet) {
                            opt.selected = true;
                        }
                        select.appendChild(opt);
                    }
                });
            }
        });
    }
});

// ============================
// 11. ОБРАБОТКА ШТРИХ-КОДА
// ============================
async function processScannedBarcode(rawText) {
    const normalized = normalizeInventoryNumber(rawText);
    let device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (device) {
        currentDevice = device;
        showScreen('deviceCard');
        await renderDeviceCard(device);
        return;
    }

    if (!navigator.onLine) {
        savePendingScan(rawText, 'barcode');
        showToast('Нет интернета. Сканирование сохранено в журнале.', 'warning');
        setTimeout(() => {
            if (document.getElementById('scanner').classList.contains('active')) initScanner();
        }, 1500);
        return;
    }

    showToast('Поиск на сервере...', 'info');
    try {
        await loadInventory();
        const found = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
        if (found) {
            currentDevice = found;
            showScreen('deviceCard');
            await renderDeviceCard(found);
        } else {
            showCreateDeviceModal(rawText);
        }
    } catch (err) {
        const cached = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
        if (cached) {
            currentDevice = cached;
            showScreen('deviceCard');
            await renderDeviceCard(cached);
        } else {
            showCreateDeviceModal(rawText);
        }
    }
}

async function handleManualFind() {
    const input = document.getElementById('manualInvInput');
    if (!input) return;
    const rawValue = input.value.trim();
    if (!rawValue) {
        showToast('Введите инвентарный номер', 'warning');
        return;
    }
    if (!validateInventoryNumber(rawValue)) {
        showToast('Неверный формат номера (длина 6-20 символов, только буквы/цифры/дефис)', 'danger');
        return;
    }
    await processScannedBarcode(rawValue);
}

// ============================
// 12. КАРТОЧКА УСТРОЙСТВА
// ============================
async function loadDeviceHistory(inventoryNumber) {
    try {
        const result = await callProxy('getHistory', { inventoryNumber });
        return result.history || [];
    } catch (error) {
        console.error('Ошибка загрузки истории:', error);
        return [];
    }
}

async function renderDeviceCard(device) {
    if (!device) {
        showToast('Ошибка: устройство не найдено', 'danger');
        return;
    }
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text !== undefined && text !== null ? String(text) : '—';
    };

    setText('deviceInventory', 'Инв. № ' + (device.inventoryNumber || ''));
    setText('deviceCabinet', device.cabinet || '—');
    setText('deviceModel', device.model || '—');
    setText('deviceSerial', device.serialNumber || '—');
    setText('deviceStatus', device.status || '—');
    setText('deviceResponsible', device.responsiblePerson || '—');
    setText('deviceWarranty', formatDate(device.warrantyEndDate));
    setText('deviceLastModified', formatDate(device.lastModified));
    setText('deviceInitiator', device.initiator || '—');

    const historyContainer = document.getElementById('deviceHistory');
    if (historyContainer) {
        if (device.history) {
            const events = device.history.split('; ').filter(s => s.trim());
            const lastEvent = events.length > 0 ? events[events.length - 1] : '';
            historyContainer.innerHTML = `<div class="small">${lastEvent || 'Нет записей'}</div>`;
        } else {
            historyContainer.innerHTML = '<div class="text-muted small">Нет записей</div>';
        }
    }

    const header = document.getElementById('deviceStatusIndicator');
    if (header) {
        const colorClass = getStatusColorClass(device);
        header.className = `device-header d-flex align-items-center p-3 rounded mb-3 ${colorClass}`;
    }
    document.getElementById('statusDot').className = 'status-dot me-3';

    currentDevice = device;
}

// ============================
// 13. ДЕЙСТВИЯ С УСТРОЙСТВОМ
// ============================
async function performDeviceAction(action, data = {}) {
    if (!currentDevice) {
        showToast('Устройство не выбрано', 'warning');
        return;
    }
    const inv = currentDevice.inventoryNumber;
    if (!inv) {
        showToast('Некорректный инвентарный номер', 'danger');
        return;
    }

    const normalized = normalizeInventoryNumber(inv);
    const exists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (!exists) {
        showToast('Устройство не найдено в базе. Действие отменено.', 'danger');
        return;
    }

    const initiator = getInitiatorName();
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU');
    const timeStr = now.toLocaleTimeString('ru-RU');
    const timestamp = `${dateStr} ${timeStr}`;

    let updates = {
        lastModified: timestamp,
        initiator: initiator
    };

    let history = currentDevice.history || '';
    let newHistoryEntry = '';
    let actionDescription = '';
    let comment = '';

    switch (action) {
        case 'transfer':
            if (!data.fio) {
                showToast('Не указано ФИО сотрудника', 'warning');
                return;
            }
            updates.responsiblePerson = data.fio;
            actionDescription = `Передано сотруднику ${data.fio}`;
            comment = data.comment || 'без комментария';
            newHistoryEntry = `${timestamp} Передано сотруднику ${data.fio}`;
            break;
        case 'repair':
            updates.status = 'В ремонте';
            actionDescription = 'Отправлено в ремонт';
            comment = data.comment || 'без комментария';
            newHistoryEntry = `${timestamp} Отправлено в ремонт (${comment})`;
            break;
        case 'stock':
            updates.status = 'На складе';
            updates.responsiblePerson = '';
            actionDescription = 'Перемещено на склад';
            comment = data.comment || 'без комментария';
            newHistoryEntry = `${timestamp} Перемещено на склад (${comment})`;
            break;
        case 'scrap':
            updates.status = 'Списан';
            updates.responsiblePerson = '';
            actionDescription = 'Списано';
            comment = data.comment || 'причина не указана';
            newHistoryEntry = `${timestamp} Списано (${comment})`;
            break;
        case 'edit':
            if (data.model) updates.model = data.model;
            if (data.serialNumber) updates.serialNumber = data.serialNumber;
            if (data.responsiblePerson !== undefined) updates.responsiblePerson = data.responsiblePerson;
            if (data.warrantyEndDate) updates.warrantyEndDate = data.warrantyEndDate;
            if (data.status) updates.status = data.status;
            if (data.cabinet !== undefined) {
                const oldCabinet = currentDevice.cabinet || '';
                const newCabinet = data.cabinet;
                if (oldCabinet !== newCabinet) {
                    updates.cabinet = newCabinet;
                    if (oldCabinet) {
                        const oldCab = cabinetsData.find(c => c.cabinet === oldCabinet);
                        if (oldCab) {
                            let numbers = oldCab.inventoryNumbers.filter(n => n !== inv);
                            numbers = uniqueArray(numbers);
                            await updateCabinetList(oldCabinet, numbers);
                            const idx = cabinetsData.findIndex(c => c.cabinet === oldCabinet);
                            if (idx !== -1) cabinetsData[idx].inventoryNumbers = numbers;
                        }
                    }
                    if (newCabinet) {
                        const newCab = cabinetsData.find(c => c.cabinet === newCabinet);
                        let numbers = newCab ? newCab.inventoryNumbers : [];
                        if (!numbers.includes(inv)) {
                            numbers.push(inv);
                            numbers = uniqueArray(numbers);
                            await updateCabinetList(newCabinet, numbers);
                            const idx = cabinetsData.findIndex(c => c.cabinet === newCabinet);
                            if (idx !== -1) cabinetsData[idx].inventoryNumbers = numbers;
                            else cabinetsData.push({ cabinet: newCabinet, inventoryNumbers: numbers });
                        }
                    }
                    localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));
                }
            }
            actionDescription = 'Отредактированы данные';
            comment = data.comment || 'без комментария';
            newHistoryEntry = `${timestamp} Отредактированы данные (${comment})`;
            break;
        default:
            showToast('Неизвестное действие', 'danger');
            return;
    }

    if (history) history += '; ';
    history += newHistoryEntry;
    updates.history = history;

    updates.actionDescription = actionDescription;
    updates.comment = comment;
    updates.initiator = initiator;

    if (!navigator.onLine) {
        savePendingAction(inv, updates);
        return;
    }

    try {
        await updateDevice(inv, updates);
        const updated = inventoryData.find(d => d && d.inventoryNumber === inv);
        if (updated) {
            currentDevice = updated;
            await renderDeviceCard(updated);
        } else {
            await loadInventory();
            const reloaded = inventoryData.find(d => d && d.inventoryNumber === inv);
            if (reloaded) {
                currentDevice = reloaded;
                await renderDeviceCard(reloaded);
            }
        }
        updateDashboardStats();
        removePendingAction(inv);
    } catch (error) {
        showToast('Ошибка при выполнении действия: ' + error.message, 'danger');
    }
}

function removePendingAction(inventoryNumber) {
    let pendingActions = JSON.parse(localStorage.getItem('pendingActions') || '[]');
    pendingActions = pendingActions.filter(item => item.inventoryNumber !== inventoryNumber);
    localStorage.setItem('pendingActions', JSON.stringify(pendingActions));
    renderLogs();
}

// ============================
// 14. ОБОРОТНАЯ ВЕДОМОСТЬ
// ============================
let isChecklistEditMode = false;

async function loadCabinetSelect() {
    const select = document.getElementById('cabinetSelect');
    if (!select) return;
    select.innerHTML = '<option value="">— Выберите аудиторию —</option>';
    if (cabinetsData.length === 0) await loadInventory();
    cabinetsData.forEach(cab => {
        if (!cab || !cab.cabinet) return;
        const opt = document.createElement('option');
        opt.value = cab.cabinet;
        opt.textContent = cab.cabinet;
        select.appendChild(opt);
    });
    const reportFilter = document.getElementById('reportCabinetFilter');
    if (reportFilter) {
        reportFilter.innerHTML = '<option value="">Все аудитории</option>';
        cabinetsData.forEach(cab => {
            if (!cab || !cab.cabinet) return;
            const opt = document.createElement('option');
            opt.value = cab.cabinet;
            opt.textContent = cab.cabinet;
            reportFilter.appendChild(opt);
        });
    }
}

function renderChecklist(cabinetName) {
    if (!cabinetName) {
        document.getElementById('checklistItems').innerHTML = '<div class="text-muted">Выберите аудиторию</div>';
        document.getElementById('progressText').textContent = '0 из 0';
        document.getElementById('progressBar').style.width = '0%';
        document.getElementById('progressBar').textContent = '0%';
        document.getElementById('editChecklistBtn').style.display = 'none';
        document.getElementById('saveChecklistBtn').style.display = 'none';
        document.getElementById('checklistEditControls').style.display = 'none';
        return;
    }

    const cabinet = cabinetsData.find(c => c && c.cabinet === cabinetName);
    if (!cabinet) {
        document.getElementById('checklistItems').innerHTML = '<div class="text-muted">Аудитория не найдена</div>';
        document.getElementById('progressText').textContent = '0 из 0';
        document.getElementById('progressBar').style.width = '0%';
        document.getElementById('progressBar').textContent = '0%';
        document.getElementById('editChecklistBtn').style.display = 'none';
        document.getElementById('saveChecklistBtn').style.display = 'none';
        document.getElementById('checklistEditControls').style.display = 'none';
        return;
    }

    const invNumbers = uniqueArray(cabinet.inventoryNumbers || []);
    let found = 0;
    let itemsHtml = '';

    invNumbers.forEach(num => {
        const normalizedNum = normalizeInventoryNumber(num);
        const exists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalizedNum);
        if (exists) found++;
        const statusClass = exists ? 'list-group-item-success' : 'list-group-item-danger';
        const statusText = exists ? '✓ Найдено' : '✗ Не найдено';
        let controls = '';
        if (isChecklistEditMode) {
            controls = `
                <div>
                    <input type="checkbox" class="form-check-input me-2 checklist-item-checkbox" data-inv="${num}">
                    <button class="btn btn-sm btn-outline-danger remove-checklist-item" data-inv="${num}" title="Удалить номер">
                        <i class="bi bi-x-lg"></i>
                    </button>
                </div>
            `;
        }
        itemsHtml += `
            <div class="list-group-item d-flex justify-content-between align-items-center ${statusClass}">
                <div>
                    ${controls}
                    <span>${num}</span>
                </div>
                <span class="badge bg-${exists ? 'success' : 'danger'}">${statusText}</span>
            </div>
        `;
    });

    document.getElementById('checklistItems').innerHTML = itemsHtml;
    const total = invNumbers.length;
    document.getElementById('progressText').textContent = `${found} из ${total}`;
    const percent = total ? Math.round((found / total) * 100) : 0;
    document.getElementById('progressBar').style.width = percent + '%';
    document.getElementById('progressBar').textContent = percent + '%';
    document.getElementById('progressBar').setAttribute('aria-valuenow', percent);

    document.getElementById('editChecklistBtn').style.display = 'inline-block';
    document.getElementById('saveChecklistBtn').style.display = 'none';

    if (isChecklistEditMode) {
        document.getElementById('editChecklistBtn').style.display = 'none';
        document.getElementById('checklistEditControls').style.display = 'grid';
        document.querySelectorAll('.remove-checklist-item').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const invNum = this.dataset.inv;
                const item = this.closest('.list-group-item');
                const cabinet = document.getElementById('cabinetSelect')?.value;
                if (item && cabinet) {
                    item.remove();
                    const newNumbers = [];
                    document.querySelectorAll('#checklistItems .list-group-item span').forEach(span => {
                        const num = span.textContent.trim();
                        if (num) newNumbers.push(num);
                    });
                    const uniqueNew = uniqueArray(newNumbers);
                    updateCabinetList(cabinet, uniqueNew).then(() => {
                        const cabIdx = cabinetsData.findIndex(c => c.cabinet === cabinet);
                        if (cabIdx !== -1) {
                            cabinetsData[cabIdx].inventoryNumbers = uniqueNew;
                        }
                        localStorage.setItem('cabinetsCache', JSON.stringify(cabinetsData));
                        renderChecklist(cabinet);
                        showToast(`Номер ${invNum} удалён из списка`, 'info');
                    }).catch(e => {
                        showToast('Ошибка удаления: ' + e.message, 'danger');
                    });
                }
            });
        });
        document.querySelectorAll('.checklist-item-checkbox').forEach(cb => cb.checked = false);
    } else {
        document.getElementById('checklistEditControls').style.display = 'none';
    }
}

function updateChecklistProgress() {
    // Оставлена для совместимости
}

// ============================
// 15. ТАБЛИЦА (вкладка)
// ============================
async function loadSheetData(sheetName) {
    if (isLoadingTable) return;
    isLoadingTable = true;
    currentSheet = sheetName;
    const status = document.getElementById('dataStatus');
    status.textContent = 'Загрузка...';
    try {
        const data = await getSheetData(sheetName);
        if (!data || data.length === 0) {
            tableHeaders = [];
            tableData = [];
            tableFilteredData = [];
            document.getElementById('dataTableHead').innerHTML = '';
            document.getElementById('dataTableBody').innerHTML = '<tr><td class="text-muted">Нет данных</td></tr>';
            status.textContent = 'Нет данных';
            document.getElementById('filterContainer').innerHTML = '';
            isLoadingTable = false;
            return;
        }
        tableHeaders = data[0];
        tableData = data.slice(1);
        populateFilters(tableHeaders, tableData);
        applyFiltersAndSearch();
        status.textContent = `Загружено ${tableData.length} строк`;
    } catch (e) {
        console.error('Ошибка загрузки данных:', e);
        status.textContent = 'Ошибка: ' + e.message;
        document.getElementById('dataTableHead').innerHTML = '';
        document.getElementById('dataTableBody').innerHTML = '<tr><td class="text-danger">Ошибка загрузки</td></tr>';
        document.getElementById('filterContainer').innerHTML = '';
    }
    isLoadingTable = false;
}

function populateFilters(headers, data) {
    const container = document.getElementById('filterContainer');
    container.innerHTML = '';
    headers.forEach((header, idx) => {
        const colDiv = document.createElement('div');
        colDiv.className = 'col-auto';
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm column-filter';
        select.dataset.col = idx;
        select.innerHTML = `<option value="">${header}</option>`;
        const unique = [...new Set(data.map(row => row[idx]).filter(v => v !== undefined && v !== null && v !== ''))];
        unique.sort();
        unique.forEach(val => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            select.appendChild(opt);
        });
        select.addEventListener('change', applyFiltersAndSearch);
        colDiv.appendChild(select);
        container.appendChild(colDiv);
    });
}

function applyFiltersAndSearch() {
    const searchTerm = document.getElementById('tableSearchInput').value.toLowerCase();
    const filterValues = {};
    document.querySelectorAll('.column-filter').forEach(select => {
        const col = select.dataset.col;
        const val = select.value;
        if (val) filterValues[col] = val;
    });

    tableFilteredData = tableData.filter((row) => {
        if (searchTerm) {
            const rowStr = row.join(' ').toLowerCase();
            if (!rowStr.includes(searchTerm)) return false;
        }
        for (let col in filterValues) {
            const idx = parseInt(col);
            if (row[idx] !== filterValues[col]) return false;
        }
        return true;
    });

    renderTable(tableFilteredData);
    document.getElementById('dataStatus').textContent = `Показано ${tableFilteredData.length} из ${tableData.length} строк`;
}

// ============================================================
// ИСПРАВЛЕННАЯ ФУНКЦИЯ renderTable – форматирование дат, последняя запись истории, запрет редактирования истории
// ============================================================
function renderTable(data) {
    const tableBody = document.getElementById('dataTableBody');
    const thead = document.getElementById('dataTableHead');
    if (tableHeaders.length && !thead.innerHTML) {
        thead.innerHTML = `<tr><th></th>${tableHeaders.map(h => `<th>${h}</th>`).join('')}</tr>`;
    }
    if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="100" class="text-muted text-center">Нет данных</td></tr>';
        return;
    }

    // Индекс колонки "История перемещений"
    const historyIndex = tableHeaders.findIndex(h =>
        h.trim().toLowerCase() === 'история перемещений' ||
        h.trim().toLowerCase() === 'history'
    );
    // Индексы колонок с датами (по ключевым словам)
    const dateColumns = [];
    tableHeaders.forEach((h, idx) => {
        const lower = h.trim().toLowerCase();
        if (lower.includes('дата') || lower.includes('date') || lower.includes('гарант')) {
            dateColumns.push(idx);
        }
    });

    let html = '';
    data.forEach((row, index) => {
        const sheetRow = index + 2;
        const rowCopy = row.slice();
        // Форматируем даты
        dateColumns.forEach(colIdx => {
            if (rowCopy[colIdx]) {
                const formatted = formatDate(rowCopy[colIdx]);
                if (formatted !== '—') {
                    rowCopy[colIdx] = formatted;
                }
            }
        });
        // Заменяем историю на последнее событие
        if (historyIndex !== -1 && rowCopy[historyIndex]) {
            const historyStr = rowCopy[historyIndex];
            const events = historyStr.split('; ').filter(s => s.trim());
            rowCopy[historyIndex] = events.length > 0 ? events[events.length - 1] : '';
        }
        html += `<tr>
            <td><input type="checkbox" class="row-selector" data-sheet-row="${sheetRow}" data-filtered-index="${index}"></td>
            ${rowCopy.map(cell => `<td>${cell !== undefined && cell !== null ? cell : ''}</td>`).join('')}
        </tr>`;
    });
    tableBody.innerHTML = html;

    // Назначаем редактирование (кроме колонки истории)
    document.querySelectorAll('#dataTableBody td:not(:first-child)').forEach(td => {
        const tr = td.parentElement;
        const colIndex = Array.from(tr.children).indexOf(td) - 1;
        if (colIndex === historyIndex) {
            td.style.backgroundColor = '#f8f9fa'; // лёгкий фон, чтобы было видно, что не редактируется
            return;
        }
        td.setAttribute('contenteditable', 'true');
        td.addEventListener('blur', function() {
            const newValue = this.textContent.trim();
            const tr2 = this.parentElement;
            const colIdx = Array.from(tr2.children).indexOf(this) - 1;
            const sheetRow = parseInt(tr2.querySelector('.row-selector').dataset.sheetRow);
            const sheet = document.getElementById('sheetSelect').value;
            if (sheetRow && colIdx >= 0) {
                updateSheetCell(sheet, sheetRow, colIdx, newValue).catch(() => {});
            }
        });
        td.addEventListener('focus', function() {
            this.dataset.oldValue = this.textContent.trim();
        });
    });
}

// ============================
// 16. ОФЛАЙН-РЕЖИМ
// ============================
function savePendingScan(inventoryNumber, type = 'barcode') {
    let pending = JSON.parse(localStorage.getItem('pendingScans') || '[]');
    if (!Array.isArray(pending)) pending = [];
    const exists = pending.some(item => item.inventoryNumber === inventoryNumber && item.type === type);
    if (!exists) {
        pending.push({
            inventoryNumber,
            timestamp: new Date().toISOString(),
            action: 'scanned',
            type: type
        });
        localStorage.setItem('pendingScans', JSON.stringify(pending));
    }
    if (document.getElementById('logs').classList.contains('active')) renderLogs();
}

function savePendingAction(inventoryNumber, updates) {
    let pending = JSON.parse(localStorage.getItem('pendingActions') || '[]');
    if (!Array.isArray(pending)) pending = [];
    const exists = pending.some(item => item.inventoryNumber === inventoryNumber && JSON.stringify(item.updates) === JSON.stringify(updates));
    if (!exists) {
        pending.push({ inventoryNumber, updates, timestamp: new Date().toISOString() });
        localStorage.setItem('pendingActions', JSON.stringify(pending));
        showToast('Действие сохранено офлайн', 'warning');
    } else {
        showToast('Действие уже есть в очереди', 'info');
    }
    if (document.getElementById('logs').classList.contains('active')) renderLogs();
}

async function syncPendingData() {
    if (!navigator.onLine) {
        showToast('Нет интернета. Синхронизация невозможна.', 'danger');
        return;
    }

    const pendingScans = JSON.parse(localStorage.getItem('pendingScans') || '[]');
    if (pendingScans.length) {
        const toRemove = [];
        for (const item of pendingScans) {
            if (item.type === 'qr') {
                const modal = new bootstrap.Modal(document.getElementById('qrLinkModal'));
                document.getElementById('qrLinkText').textContent = item.inventoryNumber;
                document.getElementById('qrLinkHref').href = item.inventoryNumber;
                modal.show();
                toRemove.push(item);
            } else if (item.type === 'barcode') {
                const normalized = normalizeInventoryNumber(item.inventoryNumber);
                const device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
                if (device) {
                    showToast(`Устройство ${item.inventoryNumber} найдено в базе!`, 'success');
                    currentDevice = device;
                    showScreen('deviceCard');
                    await renderDeviceCard(device);
                    toRemove.push(item);
                } else {
                    showToast(`Устройство ${item.inventoryNumber} не найдено. Создайте его вручную.`, 'warning');
                }
            }
        }
        if (toRemove.length) {
            const remaining = pendingScans.filter(item => !toRemove.includes(item));
            localStorage.setItem('pendingScans', JSON.stringify(remaining));
            showToast(`Обработано ${toRemove.length} сканирований`, 'info');
        }
        renderLogs();
    }

    const pendingActions = JSON.parse(localStorage.getItem('pendingActions') || '[]');
    if (pendingActions.length) {
        const failed = [];
        const toRemove = [];
        for (const item of pendingActions) {
            try {
                const normalized = normalizeInventoryNumber(item.inventoryNumber);
                const deviceExists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
                if (!deviceExists) {
                    showToast(`Устройство ${item.inventoryNumber} не найдено. Действие удалено.`, 'warning');
                    toRemove.push(item);
                    continue;
                }
                await updateDevice(item.inventoryNumber, item.updates);
                toRemove.push(item);
            } catch (e) {
                if (e.message && (e.message.includes('не найдено') || e.message.includes('not found'))) {
                    showToast(`Устройство ${item.inventoryNumber} не найдено. Действие удалено.`, 'warning');
                    toRemove.push(item);
                } else {
                    failed.push(item);
                }
            }
        }
        if (toRemove.length) {
            const remaining = pendingActions.filter(item => !toRemove.includes(item));
            localStorage.setItem('pendingActions', JSON.stringify(remaining));
            showToast(`Обработано ${toRemove.length} действий`, 'info');
        }
        if (failed.length) {
            localStorage.setItem('pendingActions', JSON.stringify(failed));
            showToast(`Не удалось синхронизировать ${failed.length} действий`, 'warning');
        } else {
            if (pendingActions.length === toRemove.length) {
                localStorage.removeItem('pendingActions');
            }
        }
        renderLogs();
    }

    await loadInventory();
    updateDashboardStats();
}

// ============================
// 17. ЛОГИ
// ============================
function renderLogs() {
    const container = document.getElementById('logsList');
    const scansCount = document.getElementById('pendingScansCount');
    const actionsCount = document.getElementById('pendingActionsCount');

    const pendingScans = JSON.parse(localStorage.getItem('pendingScans') || '[]');
    const pendingActions = JSON.parse(localStorage.getItem('pendingActions') || '[]');

    scansCount.textContent = `Сканирований: ${pendingScans.length}`;
    actionsCount.textContent = `Действий: ${pendingActions.length}`;

    if (pendingScans.length === 0 && pendingActions.length === 0) {
        container.innerHTML = '<div class="text-muted">Нет отложенных операций</div>';
        return;
    }

    let html = '';
    if (pendingScans.length > 0) {
        html += `<div class="list-group-item list-group-item-secondary"><strong>📷 Сканирования (${pendingScans.length})</strong></div>`;
        pendingScans.forEach((item, index) => {
            const date = new Date(item.timestamp).toLocaleString('ru-RU');
            const typeLabel = item.type === 'qr' ? 'QR' : 'Штрих-код';
            html += `
                <div class="list-group-item list-group-item-light d-flex justify-content-between align-items-start">
                    <div>
                        <span class="badge bg-info me-1">#${index+1}</span>
                        <span class="badge bg-secondary me-1">${typeLabel}</span>
                        <strong>${item.inventoryNumber}</strong>
                        <br><small class="text-muted">${date}</small>
                    </div>
                    <div>
                        ${item.type === 'barcode' && navigator.onLine ? `<button class="btn btn-sm btn-success me-1" onclick="createFromLog('${item.inventoryNumber}')">Создать</button>` : ''}
                        <span class="badge bg-secondary">ожидает</span>
                    </div>
                </div>
            `;
        });
    }
    if (pendingActions.length > 0) {
        html += `<div class="list-group-item list-group-item-secondary"><strong>⚡ Действия (${pendingActions.length})</strong></div>`;
        pendingActions.forEach((item, index) => {
            const date = new Date(item.timestamp).toLocaleString('ru-RU');
            const upd = item.updates;
            let actionText = '';
            if (upd.status === 'В ремонте') actionText = 'В ремонт';
            else if (upd.status === 'На складе') actionText = 'На склад';
            else if (upd.status === 'Списан') actionText = 'Списание';
            else if (upd.responsiblePerson) actionText = `Передача -> ${upd.responsiblePerson}`;
            else if (upd.model) actionText = 'Редактирование';
            else actionText = 'Обновление';

            html += `
                <div class="list-group-item list-group-item-warning d-flex justify-content-between align-items-start">
                    <div>
                        <span class="badge bg-warning me-1">#${index+1}</span>
                        <strong>${item.inventoryNumber}</strong> — ${actionText}
                        <br><small class="text-muted">${date}</small>
                    </div>
                    <span class="badge bg-secondary">ожидает</span>
                </div>
            `;
        });
    }
    container.innerHTML = html;
}

window.createFromLog = function(inventoryNumber) {
    showCreateDeviceModal(inventoryNumber);
};

// ============================
// 18. МОДАЛКА СОЗДАНИЯ
// ============================
function showCreateDeviceModal(inventoryNumber) {
    document.getElementById('createInventoryNumber').value = inventoryNumber;
    document.getElementById('createModel').value = '';
    document.getElementById('createSerial').value = '';
    document.getElementById('createStatus').value = 'В эксплуатации';
    document.getElementById('createResponsible').value = '';
    document.getElementById('createWarranty').value = '';
    const modal = new bootstrap.Modal(document.getElementById('createDeviceModal'));
    modal.show();
}

async function confirmCreateDevice() {
    if (isCreating) {
        showToast('Подождите, идёт создание...', 'warning');
        return;
    }

    const inv = document.getElementById('createInventoryNumber').value.trim();
    const model = document.getElementById('createModel').value.trim();
    const serial = document.getElementById('createSerial').value.trim();
    const status = document.getElementById('createStatus').value;
    const responsible = document.getElementById('createResponsible').value.trim();
    const warranty = document.getElementById('createWarranty').value.trim();
    const cabinet = document.getElementById('createCabinet').value;

    if (!inv || !validateInventoryNumber(inv)) {
        showToast('Неверный инвентарный номер (длина 6-20 символов)', 'danger');
        return;
    }
    if (warranty && !/^\d{2}\.\d{2}\.\d{4}$/.test(warranty)) {
        showToast('Неверный формат даты (ДД.ММ.ГГГГ)', 'danger');
        return;
    }

    const normalized = normalizeInventoryNumber(inv);
    const exists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (exists) {
        showToast('Устройство с таким номером уже существует', 'warning');
        const device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
        if (device) {
            bootstrap.Modal.getInstance(document.getElementById('createDeviceModal')).hide();
            currentDevice = device;
            showScreen('deviceCard');
            await renderDeviceCard(device);
        }
        return;
    }

    isCreating = true;
    const btn = document.getElementById('confirmCreateDevice');
    btn.disabled = true;
    btn.textContent = 'Создание...';

    try {
        const modal = bootstrap.Modal.getInstance(document.getElementById('createDeviceModal'));
        if (modal) modal.hide();

        await addDevice({ inventoryNumber: inv, cabinet, model, serialNumber: serial, status, responsiblePerson: responsible, warrantyEndDate: warranty });

        let pendingScans = JSON.parse(localStorage.getItem('pendingScans') || '[]');
        pendingScans = pendingScans.filter(item => item.inventoryNumber !== inv);
        localStorage.setItem('pendingScans', JSON.stringify(pendingScans));

        let pendingActions = JSON.parse(localStorage.getItem('pendingActions') || '[]');
        pendingActions = pendingActions.filter(item => item.inventoryNumber !== inv);
        localStorage.setItem('pendingActions', JSON.stringify(pendingActions));
        renderLogs();

        const device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
        if (device) {
            currentDevice = device;
            showScreen('deviceCard');
            await renderDeviceCard(device);
        } else {
            await loadInventory();
            const reloaded = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
            if (reloaded) {
                currentDevice = reloaded;
                showScreen('deviceCard');
                await renderDeviceCard(reloaded);
            } else {
                showToast('Устройство создано, но не найдено. Обновите страницу.', 'warning');
            }
        }
    } catch (e) {
        console.error('Ошибка создания:', e);
        if (e.message && (e.message.includes('уже существует') || e.message.includes('Duplicate'))) {
            const device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
            if (device) {
                currentDevice = device;
                showScreen('deviceCard');
                await renderDeviceCard(device);
            }
        }
    } finally {
        isCreating = false;
        btn.disabled = false;
        btn.textContent = 'Создать';
    }
}

// ============================
// 19. ОТЧЁТ
// ============================
function generateCSV(data) {
    if (!data || !Array.isArray(data) || data.length === 0) return '';
    const headers = ['Инвентарный номер', 'Аудитория', 'Серийный номер', 'Модель', 'Статус', 'Ответственное лицо', 'Дата окончания гарантии', 'История перемещений', 'Последнее изменение', 'Инициатор'];
    let csv = headers.join(',') + '\n';
    data.forEach(d => {
        if (!d) return;
        const row = [
            d.inventoryNumber || '',
            d.cabinet || '',
            d.serialNumber || '',
            d.model || '',
            d.status || '',
            d.responsiblePerson || '',
            d.warrantyEndDate || '',
            (d.history || '').replace(/;/g, ','),
            d.lastModified || '',
            d.initiator || ''
        ];
        csv += row.join(',') + '\n';
    });
    return csv;
}

function downloadCSV(csv) {
    if (!csv) {
        showToast('Нет данных для выгрузки', 'warning');
        return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.setAttribute('download', 'inventory_report.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ============================================================
// ИСПРАВЛЕННАЯ ФУНКЦИЯ printReport – адаптивная печать на всю страницу
// ============================================================
function printReport() {
    if (!inventoryData || inventoryData.length === 0) {
        showToast('Нет данных для печати', 'warning');
        return;
    }
    const cabinetFilter = document.getElementById('reportCabinetFilter')?.value;
    let filteredData = inventoryData;
    let cabinetName = '';
    if (cabinetFilter) {
        const cabinet = cabinetsData.find(c => c && c.cabinet === cabinetFilter);
        if (cabinet && Array.isArray(cabinet.inventoryNumbers)) {
            const normList = cabinet.inventoryNumbers.map(n => normalizeInventoryNumber(n));
            filteredData = inventoryData.filter(d => normList.includes(normalizeInventoryNumber(d.inventoryNumber)));
            cabinetName = cabinetFilter;
        }
    }
    if (filteredData.length === 0) {
        showToast('Нет данных для выбранной аудитории', 'warning');
        return;
    }

    // Стили для печати – адаптивные, таблица на всю ширину
    const style = document.createElement('style');
    style.id = 'print-report-style';
    style.textContent = `
        @page { 
            size: landscape; 
            margin: 5mm; 
        }
        body, html { 
            margin: 0; 
            padding: 0; 
            width: 100%; 
            height: 100%; 
            background: white;
        }
        #report-print-content {
            width: 100% !important;
            height: 100% !important;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            font-family: Arial, sans-serif;
            padding: 10px;
            box-sizing: border-box;
            background: white;
        }
        #report-print-content .report-title {
            font-size: 22pt;
            font-weight: bold;
            text-align: center;
            margin: 15px 0;
            width: 100%;
        }
        #report-print-content table {
            width: 100% !important;
            border-collapse: collapse !important;
            table-layout: auto !important;
            font-size: 10pt;
        }
        #report-print-content th, #report-print-content td {
            border: 1px solid #000 !important;
            padding: 4px 6px !important;
            text-align: left;
            word-wrap: break-word;
            overflow: visible;
            white-space: normal;
        }
        #report-print-content th {
            background-color: #f0f0f0 !important;
            font-weight: bold;
        }
        /* Адаптация для мобильных устройств */
        @media (max-width: 600px) {
            #report-print-content table {
                font-size: 7pt;
            }
            #report-print-content th, #report-print-content td {
                padding: 2px 3px !important;
                font-size: 7pt;
            }
            #report-print-content .report-title {
                font-size: 16pt;
            }
        }
        @media print {
            body, html {
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
            }
            #report-print-content {
                padding: 5px;
            }
            .no-print { display: none; }
        }
    `;
    document.head.appendChild(style);

    const printDiv = document.createElement('div');
    printDiv.id = 'report-print-content';
    printDiv.style.display = 'block';
    document.body.appendChild(printDiv);

    const title = document.createElement('div');
    title.className = 'report-title';
    title.textContent = cabinetName ? `Аудитория: ${cabinetName}` : 'Общий отчёт по инвентаризации';
    printDiv.appendChild(title);

    let tableHtml = `<table>
        <thead><tr>
            <th>Инв. номер</th>
            <th>Аудитория</th>
            <th>Серийный</th>
            <th>Модель</th>
            <th>Статус</th>
            <th>Ответственный</th>
            <th>Гарантия до</th>
            <th>История (последнее)</th>
        </tr></thead><tbody>`;
    filteredData.forEach(d => {
        if (!d) return;
        let lastEvent = '';
        if (d.history) {
            const events = d.history.split('; ').filter(s => s.trim());
            lastEvent = events.length > 0 ? events[events.length - 1] : '';
        }
        tableHtml += `<tr>
            <td>${d.inventoryNumber || ''}</td>
            <td>${d.cabinet || ''}</td>
            <td>${d.serialNumber || ''}</td>
            <td>${d.model || ''}</td>
            <td>${d.status || ''}</td>
            <td>${d.responsiblePerson || ''}</td>
            <td>${formatDate(d.warrantyEndDate) !== '—' ? formatDate(d.warrantyEndDate) : ''}</td>
            <td>${lastEvent}</td>
        </tr>`;
    });
    tableHtml += '</tbody></table>';
    const tableDiv = document.createElement('div');
    tableDiv.innerHTML = tableHtml;
    printDiv.appendChild(tableDiv);

    window.print();

    // Очистка
    document.body.removeChild(printDiv);
    const styleToRemove = document.getElementById('print-report-style');
    if (styleToRemove) styleToRemove.remove();
}

// ============================
// 20. НАВИГАЦИЯ
// ============================
let navButtons = [];
let activePill = null;

function updateActivePill(smooth = true) {
    if (!activePill) return;
    const active = document.querySelector('.nav-btn.active');
    if (!active) return;
    if (!smooth) {
        activePill.style.transition = 'none';
    } else {
        activePill.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), width 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
    }
    activePill.style.width = active.offsetWidth + 'px';
    activePill.style.transform = `translateX(${active.offsetLeft}px)`;
}

// ============================
// 21. ИНИЦИАЛИЗАЦИЯ
// ============================
document.addEventListener('DOMContentLoaded', async function() {
    const forceHideLoading = setTimeout(() => {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen && !loadingScreen.classList.contains('hidden')) {
            loadingScreen.classList.add('hidden');
            const container = document.getElementById('appContainer');
            if (container) container.style.display = 'block';
            console.warn('Загрузка принудительно скрыта по таймауту');
        }
    }, 10000);

    try {
        await new Promise((resolve) => {
            auth.onAuthStateChanged(async user => {
                try {
                    if (user) {
                        currentUser = user;
                        if (!user.displayName) {
                            const savedName = localStorage.getItem('localUserName');
                            if (savedName && savedName !== 'Аноним') {
                                try {
                                    await user.updateProfile({ displayName: savedName });
                                    currentUser = user;
                                } catch (e) { /* ignore */ }
                            } else {
                                const name = prompt('Введите ваше имя (для отображения в истории):', user.uid.substring(0, 8));
                                if (name) {
                                    await user.updateProfile({ displayName: name });
                                    localStorage.setItem('localUserName', name);
                                    currentUser = user;
                                }
                            }
                        } else {
                            localStorage.setItem('localUserName', user.displayName);
                        }
                        document.getElementById('userDisplay').textContent = currentUser.displayName || currentUser.uid || 'Аноним';
                    } else {
                        try {
                            const cred = await auth.signInAnonymously();
                            currentUser = cred.user;
                            const savedName = localStorage.getItem('localUserName');
                            if (savedName && savedName !== 'Аноним') {
                                try {
                                    await currentUser.updateProfile({ displayName: savedName });
                                } catch (e) { /* ignore */ }
                            }
                            document.getElementById('userDisplay').textContent = currentUser.displayName || currentUser.uid || 'Аноним';
                        } catch (e) {
                            console.error('Ошибка анонимного входа:', e);
                            document.getElementById('userDisplay').textContent = localUserName;
                            showToast('Режим офлайн: изменения будут сохранены локально', 'warning');
                        }
                    }
                } catch (e) {
                    console.error('Ошибка в auth.onAuthStateChanged:', e);
                } finally {
                    resolve();
                }
            });
        });

        await loadInventory();
        updateDashboardStats();
        await loadCabinetSelect();
        await syncPendingData();

        const themeToggle = document.getElementById('themeToggle');
        const root = document.documentElement;
        const savedTheme = localStorage.getItem('appTheme');
        if (savedTheme) {
            root.setAttribute('data-theme', savedTheme);
        } else {
            root.setAttribute('data-theme', 'light');
        }
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                const current = root.getAttribute('data-theme');
                const newTheme = current === 'dark' ? 'light' : 'dark';
                root.setAttribute('data-theme', newTheme);
                localStorage.setItem('appTheme', newTheme);
                setTimeout(updateActivePill, 100);
            });
        }

        activePill = document.getElementById('active-pill');
        navButtons = document.querySelectorAll('.nav-btn');

        navButtons.forEach(btn => {
            btn.addEventListener('click', function() {
                navButtons.forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                updateActivePill(true);
                const screen = this.dataset.screen;
                if (screen) showScreen(screen);
            });
        });

        window.addEventListener('load', () => {
            setTimeout(() => updateActivePill(false), 100);
        });
        window.addEventListener('resize', () => updateActivePill(false));

        document.getElementById('scanBtn')?.addEventListener('click', () => showScreen('scanner'));
        document.getElementById('checklistBtn')?.addEventListener('click', () => {
            showScreen('checklist');
            if (cabinetsData.length === 0) loadCabinetSelect();
        });
        document.getElementById('reportBtn')?.addEventListener('click', () => showScreen('report'));

        document.getElementById('backFromScanner')?.addEventListener('click', () => {
            stopScanner();
            showScreen('dashboard');
        });
        document.getElementById('backFromDevice')?.addEventListener('click', () => {
            currentDevice = null;
            showScreen('dashboard');
        });
        document.getElementById('backFromChecklist')?.addEventListener('click', () => {
            isChecklistEditMode = false;
            showScreen('dashboard');
        });
        document.getElementById('backFromReport')?.addEventListener('click', () => showScreen('dashboard'));
        document.getElementById('backFromLogs')?.addEventListener('click', () => showScreen('dashboard'));

        document.getElementById('manualFindBtn')?.addEventListener('click', handleManualFind);
        document.getElementById('manualInvInput')?.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') handleManualFind();
        });

        document.getElementById('refreshDataBtn')?.addEventListener('click', async function() {
            try {
                await loadInventory();
                updateDashboardStats();
                if (currentDevice) {
                    const updated = inventoryData.find(d => d && d.inventoryNumber === currentDevice.inventoryNumber);
                    if (updated) {
                        currentDevice = updated;
                        await renderDeviceCard(updated);
                    }
                }
                showToast('Данные обновлены', 'success');
            } catch (e) {
                showToast('Ошибка обновления', 'danger');
            }
        });

        document.getElementById('changeNameBtn')?.addEventListener('click', function() {
            const newName = prompt('Введите ваше имя (для отображения в истории):', localUserName);
            if (newName && newName.trim()) {
                const name = newName.trim();
                localStorage.setItem('localUserName', name);
                localUserName = name;
                if (currentUser) {
                    currentUser.updateProfile({ displayName: name }).catch(() => {});
                }
                document.getElementById('userDisplay').textContent = name;
                showToast('Имя обновлено', 'success');
            }
        });

        // Карточка
        document.getElementById('editBtn')?.addEventListener('click', function() {
            if (!currentDevice) {
                showToast('Устройство не выбрано', 'warning');
                return;
            }
            document.getElementById('editModel').value = currentDevice.model || '';
            document.getElementById('editSerial').value = currentDevice.serialNumber || '';
            document.getElementById('editResponsible').value = currentDevice.responsiblePerson || '';
            document.getElementById('editWarranty').value = currentDevice.warrantyEndDate || '';
            document.getElementById('editStatus').value = currentDevice.status || 'В эксплуатации';
            document.getElementById('editComment').value = '';
            const modal = new bootstrap.Modal(document.getElementById('editModal'));
            modal.show();
        });

        document.getElementById('confirmEdit')?.addEventListener('click', async function() {
            const model = document.getElementById('editModel').value.trim();
            const serial = document.getElementById('editSerial').value.trim();
            const responsible = document.getElementById('editResponsible').value.trim();
            const warranty = document.getElementById('editWarranty').value.trim();
            const status = document.getElementById('editStatus').value;
            const cabinet = document.getElementById('editCabinet')?.value || '';
            const comment = document.getElementById('editComment')?.value.trim() || '';
            if (warranty && !/^\d{2}\.\d{2}\.\d{4}$/.test(warranty)) {
                showToast('Неверный формат даты (ДД.ММ.ГГГГ)', 'danger');
                return;
            }
            const updates = { model, serialNumber: serial, responsiblePerson: responsible, warrantyEndDate: warranty, status, cabinet, comment };
            const modal = bootstrap.Modal.getInstance(document.getElementById('editModal'));
            if (modal) modal.hide();
            await performDeviceAction('edit', updates);
        });

        document.getElementById('transferBtn')?.addEventListener('click', function() {
            if (!currentDevice) {
                showToast('Устройство не выбрано', 'warning');
                return;
            }
            const modal = new bootstrap.Modal(document.getElementById('transferModal'));
            modal.show();
        });
        document.getElementById('confirmTransfer')?.addEventListener('click', async function() {
            const fio = document.getElementById('transferFio')?.value.trim();
            const comment = document.getElementById('transferComment')?.value.trim();
            if (!fio || !comment) {
                showToast('Заполните все поля', 'warning');
                return;
            }
            const modal = bootstrap.Modal.getInstance(document.getElementById('transferModal'));
            if (modal) modal.hide();
            await performDeviceAction('transfer', { fio, comment });
            document.getElementById('transferFio').value = '';
            document.getElementById('transferComment').value = '';
        });

        document.getElementById('repairBtn')?.addEventListener('click', async function() {
            if (!currentDevice) {
                showToast('Устройство не выбрано', 'warning');
                return;
            }
            const comment = prompt('Введите причину отправки в ремонт (необязательно):');
            await performDeviceAction('repair', { comment: comment || 'Без комментария' });
        });

        document.getElementById('stockBtn')?.addEventListener('click', async function() {
            if (!currentDevice) {
                showToast('Устройство не выбрано', 'warning');
                return;
            }
            const comment = prompt('Введите комментарий (необязательно):');
            await performDeviceAction('stock', { comment: comment || 'Без комментария' });
        });

        document.getElementById('scrapBtn')?.addEventListener('click', function() {
            if (!currentDevice) {
                showToast('Устройство не выбрано', 'warning');
                return;
            }
            document.getElementById('scrapInventory').textContent = currentDevice.inventoryNumber;
            const modal = new bootstrap.Modal(document.getElementById('scrapModal'));
            modal.show();
        });
        document.getElementById('confirmScrap')?.addEventListener('click', async function() {
            const comment = document.getElementById('scrapComment')?.value.trim();
            const modal = bootstrap.Modal.getInstance(document.getElementById('scrapModal'));
            if (modal) modal.hide();
            await performDeviceAction('scrap', { comment: comment || 'Причина не указана' });
            document.getElementById('scrapComment').value = '';
        });

        document.getElementById('cabinetSelect')?.addEventListener('change', function() {
            const cabinet = this.value;
            if (cabinet) {
                renderChecklist(cabinet);
            } else {
                document.getElementById('checklistItems').innerHTML = '<div class="text-muted">Выберите аудиторию</div>';
                document.getElementById('progressText').textContent = '0 из 0';
                document.getElementById('progressBar').style.width = '0%';
                document.getElementById('progressBar').textContent = '0%';
            }
        });
        document.getElementById('refreshChecklistBtn')?.addEventListener('click', function() {
            const cabinet = document.getElementById('cabinetSelect')?.value;
            if (cabinet) {
                renderChecklist(cabinet);
                showToast('Обновлено', 'success');
            }
        });

        document.getElementById('downloadCsvBtn')?.addEventListener('click', function() {
            const cabinetFilter = document.getElementById('reportCabinetFilter')?.value;
            let filteredData = inventoryData;
            if (cabinetFilter) {
                const cabinet = cabinetsData.find(c => c && c.cabinet === cabinetFilter);
                if (cabinet && Array.isArray(cabinet.inventoryNumbers)) {
                    const normList = cabinet.inventoryNumbers.map(n => normalizeInventoryNumber(n));
                    filteredData = inventoryData.filter(d => normList.includes(normalizeInventoryNumber(d.inventoryNumber)));
                }
            }
            const csv = generateCSV(filteredData);
            if (csv) {
                downloadCSV(csv);
            } else {
                showToast('Нет данных для выгрузки', 'warning');
            }
        });
        document.getElementById('printPdfBtn')?.addEventListener('click', printReport);

        document.getElementById('helpBtn')?.addEventListener('click', function() {
            const modal = new bootstrap.Modal(document.getElementById('helpModal'));
            modal.show();
        });

        document.getElementById('syncNowBtn')?.addEventListener('click', async function() {
            await syncPendingData();
            renderLogs();
        });
        document.getElementById('clearLogsBtn')?.addEventListener('click', function() {
            if (confirm('Вы уверены, что хотите очистить все отложенные операции без синхронизации?')) {
                localStorage.removeItem('pendingScans');
                localStorage.removeItem('pendingActions');
                renderLogs();
                showToast('Логи очищены', 'info');
            }
        });

        document.getElementById('confirmCreateDevice')?.addEventListener('click', confirmCreateDevice);

        window.addEventListener('online', function() {
            syncPendingData();
            loadInventory().then(() => {
                updateDashboardStats();
                if (currentDevice) {
                    const updated = inventoryData.find(d => d && d.inventoryNumber === currentDevice.inventoryNumber);
                    if (updated) {
                        currentDevice = updated;
                        renderDeviceCard(updated);
                    }
                }
            });
        });

        setInterval(() => {
            if (navigator.onLine) {
                loadInventory().then(() => {
                    updateDashboardStats();
                    if (currentDevice) {
                        const updated = inventoryData.find(d => d && d.inventoryNumber === currentDevice.inventoryNumber);
                        if (updated) {
                            currentDevice = updated;
                            renderDeviceCard(updated);
                        }
                    }
                });
            }
        }, 120000);

        showScreen('dashboard');

    } catch (error) {
        console.error('Критическая ошибка инициализации:', error);
        showToast('Ошибка загрузки приложения: ' + error.message, 'danger');
    } finally {
        clearTimeout(forceHideLoading);
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            loadingScreen.classList.add('hidden');
        }
        const container = document.getElementById('appContainer');
        if (container) {
            container.style.display = 'block';
        } else {
            console.warn('Элемент #appContainer не найден, но загрузка скрыта');
        }
    }
});