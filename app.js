/**
 * app.js – Улучшенная версия с увеличенной областью сканирования,
 * поддержкой фото (снимок + загрузка) и превью захваченного кадра.
 * ИСПРАВЛЕНА ОШИБКА scanFile (теперь используется Promise).
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
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbwBbkVP-gFgGnBeETXRPhQIkm25Iaj3j_lFEqjc6yFDe308TuFP-bw_6Un40D_N9wuH/exec';

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
let isProcessingImage = false;

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
    setTimeout(updateActivePill, 50);
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
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
    const { inventoryNumber, model, serialNumber, status, responsiblePerson, warrantyEndDate } = deviceData;
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
            ...deviceData,
            initiator: getInitiatorName()
        });
        showToast(result.message || 'Устройство создано', 'success');
        const now = new Date().toLocaleString('ru-RU');
        const newDevice = {
            inventoryNumber: inventoryNumber,
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
// 5. ДАШБОРД
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
// 6. СКАНЕР (УВЕЛИЧЕННАЯ ОБЛАСТЬ)
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

        const containerWidth = readerElement.offsetWidth || window.innerWidth - 32;
        const containerHeight = readerElement.offsetHeight || window.innerHeight - 200;
        const isLandscape = window.innerWidth > window.innerHeight;

        // Увеличиваем область сканирования до 90% ширины и 60% высоты
        const qrboxWidth = Math.min(containerWidth * 0.90, 900);
        const qrboxHeight = Math.min(containerHeight * 0.60, 600);

        const config = {
            fps: 20,
            qrbox: {
                width: qrboxWidth,
                height: qrboxHeight
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
    } catch (err) {
        console.error('Ошибка запуска сканера:', err);
        showToast('Не удалось получить доступ к камере: ' + err.message, 'danger');
        document.querySelector('.manual-input').style.display = 'block';
        isInitializingScanner = false;
    }
}

function stopScanner() {
    if (scannerInstance && isScanning) {
        try {
            scannerInstance.stop().then(() => { isScanning = false; }).catch(err => console.warn('Остановка сканера:', err));
        } catch (e) { console.warn('Ошибка при остановке сканера', e); }
    }
}

// ============================
// 7. ОБРАБОТКА РЕЗУЛЬТАТА СКАНИРОВАНИЯ
// ============================
async function onScanSuccess(decodedText, decodedResult) {
    if (!decodedText) {
        console.warn('Пустой результат сканирования');
        return;
    }
    console.log('Распознано:', decodedText);
    vibrate(100);
    playBeep(true);
    stopScanner();

    const rawText = decodedText.trim();
    let format = decodedResult?.result?.format || decodedResult?.format || '';
    console.log('Формат:', format);

    if (rawText.startsWith('http://') || rawText.startsWith('https://')) {
        console.log('QR-ссылка – диалог перехода');
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
// 7.1 РАСПОЗНАВАНИЕ С ФОТОГРАФИИ (ИСПРАВЛЕННАЯ ВЕРСИЯ - PROMISE)
// ============================
function captureAndScan() {
    if (isProcessingImage) return;
    
    const videoElement = document.querySelector('#reader video');
    if (!videoElement) {
        showToast('Камера не активна', 'warning');
        return;
    }

    if (videoElement.readyState < 2) {
        showToast('Подождите, камера ещё не готова', 'warning');
        return;
    }

    // Останавливаем сканер на время обработки
    if (scannerInstance && isScanning) {
        stopScanner();
    }

    isProcessingImage = true;
    showToast('Захват кадра...', 'info');

    try {
        const videoWidth = videoElement.videoWidth || 1280;
        const videoHeight = videoElement.videoHeight || 720;
        console.log('Размер видео:', videoWidth, 'x', videoHeight);

        const canvas = document.createElement('canvas');
        canvas.width = videoWidth;
        canvas.height = videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);

        // Показываем превью захваченного кадра
        showCapturedPreview(canvas);

        canvas.toBlob(function(blob) {
            if (!blob) {
                showToast('Не удалось захватить изображение', 'danger');
                isProcessingImage = false;
                if (document.getElementById('scanner').classList.contains('active')) {
                    initScanner();
                }
                return;
            }
            console.log('Blob создан, размер:', blob.size);
            const file = new File([blob], 'scan.jpg', { type: 'image/jpeg' });
            processImageFile(file);
        }, 'image/jpeg', 0.95);
    } catch (e) {
        console.error('Ошибка захвата кадра:', e);
        showToast('Ошибка захвата: ' + e.message, 'danger');
        isProcessingImage = false;
        if (document.getElementById('scanner').classList.contains('active')) {
            initScanner();
        }
    }
}

function showCapturedPreview(canvas) {
    // Создаём или обновляем элемент превью
    let previewContainer = document.getElementById('capturedPreview');
    if (!previewContainer) {
        previewContainer = document.createElement('div');
        previewContainer.id = 'capturedPreview';
        previewContainer.style.position = 'absolute';
        previewContainer.style.top = '10px';
        previewContainer.style.right = '10px';
        previewContainer.style.width = '120px';
        previewContainer.style.height = 'auto';
        previewContainer.style.border = '2px solid white';
        previewContainer.style.borderRadius = '8px';
        previewContainer.style.overflow = 'hidden';
        previewContainer.style.zIndex = '20';
        previewContainer.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
        const readerContainer = document.getElementById('reader');
        if (readerContainer) {
            readerContainer.style.position = 'relative';
            readerContainer.appendChild(previewContainer);
        }
    }
    // Очищаем и добавляем новое изображение
    previewContainer.innerHTML = '';
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.8);
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.display = 'block';
    previewContainer.appendChild(img);
    // Автоматически скрываем через 5 секунд
    clearTimeout(previewContainer._hideTimer);
    previewContainer._hideTimer = setTimeout(() => {
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
    }, 5000);
}

function processImageFile(file) {
    if (isProcessingImage) return;
    isProcessingImage = true;
    showToast('Распознавание...', 'info');

    if (!file || file.size === 0) {
        showToast('Пустой файл', 'danger');
        isProcessingImage = false;
        if (document.getElementById('scanner').classList.contains('active')) {
            initScanner();
        }
        return;
    }

    console.log('Файл для распознавания:', file.name, file.size);

    // Упрощённый конфиг для scanFile (без fps и qrbox)
    const config = {
        experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
        }
    };

    if (typeof Html5Qrcode.scanFile === 'function') {
        // ИСПОЛЬЗУЕМ PROMISE (правильный синтаксис для версии 2.3.8)
        Html5Qrcode.scanFile(file, config)
            .then(decodedText => {
                console.log('Распознано с фото (Promise):', decodedText);
                isProcessingImage = false;
                // Убираем превью
                const preview = document.getElementById('capturedPreview');
                if (preview) preview.style.display = 'none';
                // Передаём результат в стандартный обработчик (второй аргумент undefined)
                onScanSuccess(decodedText, undefined);
                // Перезапускаем сканер, если активен экран
                setTimeout(() => {
                    if (document.getElementById('scanner').classList.contains('active')) {
                        initScanner();
                    }
                }, 600);
            })
            .catch(error => {
                console.error('Ошибка распознавания с фото (Promise):', error);
                showToast('Не удалось распознать штрих-код на фото', 'warning');
                isProcessingImage = false;
                const preview = document.getElementById('capturedPreview');
                if (preview) preview.style.display = 'none';
                if (document.getElementById('scanner').classList.contains('active')) {
                    initScanner();
                }
            });
    } else {
        showToast('Функция распознавания фото не поддерживается', 'danger');
        isProcessingImage = false;
        const preview = document.getElementById('capturedPreview');
        if (preview) preview.style.display = 'none';
        if (document.getElementById('scanner').classList.contains('active')) {
            initScanner();
        }
    }
}

function handleFileUpload(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('Пожалуйста, выберите изображение', 'warning');
        return;
    }
    if (scannerInstance && isScanning) {
        stopScanner();
    }
    processImageFile(file);
}

// ============================
// 8. ОБРАБОТЧИКИ DOM
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

    // Кнопки для фото
    document.getElementById('capturePhotoBtn')?.addEventListener('click', captureAndScan);
    document.getElementById('uploadPhotoBtn')?.addEventListener('click', function() {
        document.getElementById('fileInput')?.click();
    });
    document.getElementById('fileInput')?.addEventListener('change', function(e) {
        if (this.files && this.files.length > 0) {
            handleFileUpload(this.files[0]);
            this.value = '';
        }
    });
});

// ============================
// 9. ОБРАБОТКА РЕЗУЛЬТАТА СКАНИРОВАНИЯ (ПРОДОЛЖЕНИЕ)
// ============================
async function processScannedBarcode(rawText) {
    const normalized = normalizeInventoryNumber(rawText);
    console.log('Поиск устройства по номеру:', normalized);

    let device = inventoryData.find(d => normalizeInventoryNumber(d.inventoryNumber) === normalized);
    if (device) {
        console.log('Найдено локально:', device);
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
            console.log('Найдено на сервере:', found);
            currentDevice = found;
            showScreen('deviceCard');
            await renderDeviceCard(found);
        } else {
            showCreateDeviceModal(rawText);
        }
    } catch (err) {
        console.error('Ошибка загрузки с сервера:', err);
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
// 10. КАРТОЧКА УСТРОЙСТВА + ИСТОРИЯ
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
    setText('deviceModel', device.model || '—');
    setText('deviceSerial', device.serialNumber || '—');
    setText('deviceStatus', device.status || '—');
    setText('deviceResponsible', device.responsiblePerson || '—');
    setText('deviceWarranty', formatDate(device.warrantyEndDate));
    setText('deviceLastModified', device.lastModified || '—');
    setText('deviceInitiator', device.initiator || '—');

    const historyContainer = document.getElementById('deviceHistory');
    if (historyContainer) {
        historyContainer.innerHTML = '<div class="text-muted small">Загрузка истории...</div>';
        const history = await loadDeviceHistory(device.inventoryNumber);
        if (history.length === 0) {
            historyContainer.innerHTML = '<div class="text-muted small">Нет записей</div>';
        } else {
            historyContainer.innerHTML = history.map(entry =>
                `<div class="small">${entry.date} — ${entry.action}${entry.comment ? ' (' + entry.comment + ')' : ''} (${entry.initiator || 'Аноним'})</div>`
            ).join('');
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
// 11. ОБРАБОТЧИКИ ДЕЙСТВИЙ
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
            newHistoryEntry = `${timestamp} Передано сотруднику ${data.fio} (${comment})`;
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
// 12. ОБОРОТНАЯ ВЕДОМОСТЬ
// ============================
async function loadCabinetSelect() {
    const select = document.getElementById('cabinetSelect');
    if (!select) return;
    select.innerHTML = '<option value="">— Выберите кабинет —</option>';
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
        reportFilter.innerHTML = '<option value="">Все кабинеты</option>';
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
    if (!cabinetName) return;
    const cabinet = cabinetsData.find(c => c && c.cabinet === cabinetName);
    if (!cabinet) {
        document.getElementById('checklistItems').innerHTML = '<div class="text-muted">Кабинет не найден</div>';
        document.getElementById('progressText').textContent = '0 из 0';
        document.getElementById('progressBar').style.width = '0%';
        document.getElementById('progressBar').textContent = '0%';
        return;
    }

    const invNumbers = Array.isArray(cabinet.inventoryNumbers) ? cabinet.inventoryNumbers : [];
    let found = 0;
    let itemsHtml = '';

    invNumbers.forEach(num => {
        const normalizedNum = normalizeInventoryNumber(num);
        const exists = inventoryData.some(d => normalizeInventoryNumber(d.inventoryNumber) === normalizedNum && d.status !== 'Списан');
        if (exists) found++;
        const statusClass = exists ? 'list-group-item-success' : 'list-group-item-danger';
        const statusText = exists ? '✓ Найдено' : '✗ Не найдено';
        itemsHtml += `
            <div class="list-group-item d-flex justify-content-between align-items-center ${statusClass}">
                <span>${num}</span>
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
}

// ============================
// 13. ОФЛАЙН-РЕЖИМ
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
// 14. ЛОГИ
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
// 15. МОДАЛКА СОЗДАНИЯ
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

        await addDevice({ inventoryNumber: inv, model, serialNumber: serial, status, responsiblePerson: responsible, warrantyEndDate: warranty });

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
// 16. ОТЧЁТ
// ============================
function generateCSV(data) {
    if (!data || !Array.isArray(data) || data.length === 0) return '';
    const headers = ['Инвентарный номер', 'Серийный номер', 'Модель', 'Статус', 'Ответственное лицо', 'Дата окончания гарантии', 'История перемещений', 'Последнее изменение', 'Инициатор'];
    let csv = headers.join(',') + '\n';
    data.forEach(d => {
        if (!d) return;
        const row = [
            d.inventoryNumber || '',
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

function printReport() {
    if (!inventoryData || inventoryData.length === 0) {
        showToast('Нет данных для печати', 'warning');
        return;
    }
    const cabinetFilter = document.getElementById('reportCabinetFilter')?.value;
    let filteredData = inventoryData;
    if (cabinetFilter) {
        const cabinet = cabinetsData.find(c => c && c.cabinet === cabinetFilter);
        if (cabinet && Array.isArray(cabinet.inventoryNumbers)) {
            const normList = cabinet.inventoryNumbers.map(n => normalizeInventoryNumber(n));
            filteredData = inventoryData.filter(d => normList.includes(normalizeInventoryNumber(d.inventoryNumber)));
        }
    }
    if (filteredData.length === 0) {
        showToast('Нет данных для выбранного кабинета', 'warning');
        return;
    }

    const printDiv = document.createElement('div');
    printDiv.id = 'report-print-content';
    printDiv.style.display = 'none';
    document.body.appendChild(printDiv);

    let tableHtml = `<table class="table table-bordered table-striped"><thead><tr>
        <th>Инв. номер</th><th>Серийный</th><th>Модель</th><th>Статус</th>
        <th>Ответственный</th><th>Гарантия до</th><th>История</th>
    </tr></thead><tbody>`;
    filteredData.forEach(d => {
        if (!d) return;
        tableHtml += `<tr><td>${d.inventoryNumber}</td><td>${d.serialNumber || ''}</td>
            <td>${d.model || ''}</td><td>${d.status || ''}</td>
            <td>${d.responsiblePerson || ''}</td>
            <td>${d.warrantyEndDate || ''}</td>
            <td>${(d.history || '').replace(/;/g, ', ')}</td></tr>`;
    });
    tableHtml += '</tbody></table>';
    printDiv.innerHTML = tableHtml;

    printDiv.style.display = 'block';
    window.print();
    printDiv.style.display = 'none';
    document.body.removeChild(printDiv);
}

// ============================
// 17. НАВИГАЦИЯ
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
// 18. ИНИЦИАЛИЗАЦИЯ
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
        document.getElementById('backFromChecklist')?.addEventListener('click', () => showScreen('dashboard'));
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
            const modal = new bootstrap.Modal(document.getElementById('editModal'));
            modal.show();
        });

        document.getElementById('confirmEdit')?.addEventListener('click', async function() {
            const model = document.getElementById('editModel').value.trim();
            const serial = document.getElementById('editSerial').value.trim();
            const responsible = document.getElementById('editResponsible').value.trim();
            const warranty = document.getElementById('editWarranty').value.trim();
            const status = document.getElementById('editStatus').value;
            if (warranty && !/^\d{2}\.\d{2}\.\d{4}$/.test(warranty)) {
                showToast('Неверный формат даты (ДД.ММ.ГГГГ)', 'danger');
                return;
            }
            const updates = { model, serialNumber: serial, responsiblePerson: responsible, warrantyEndDate: warranty, status };
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
                document.getElementById('checklistItems').innerHTML = '<div class="text-muted">Выберите кабинет</div>';
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