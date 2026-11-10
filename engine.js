// Puzzles & Chaos Prediction Engine v2.1
const denPowerTable = {
    1: 50000, 2: 120000, 3: 200000, 4: 300000, 5: 450000,
    6: 600000, 7: 800000, 8: 1000000, 9: 1300000, 10: 1600000,
    11: 1900000, 12: 2200000, 13: 2500000, 14: 2800000, 15: 3200000,
    16: 3600000, 17: 4100000, 18: 4600000, 19: 5100000, 20: 2700000,
    21: 3600000, 22: 5280000, 23: 5760000, 24: 6240000, 25: 6720000,
    26: 9000000, 27: 9600000, 28: 10200000, 29: 10800000, 30: 15840000,
    31: 17424000, 32: 25920000, 33: 28080000, 34: 40320000, 35: 43200000,
    36: 50400000, 37: 57600000, 38: 64800000, 39: 96000000, 40: 105600000,
    41: 115200000, 42: 128000000, 43: 144000000, 44: 160000000, 45: 192000000
};

const tierMods = { "T5": 0.75, "T6": 0.85, "T7": 0.95, "T8": 1.0, "T9": 1.15, "T10": 1.3, "T11": 1.45 };
const typeMods = { "Infantry": 1.0, "Cavalry": 1.1, "Archer": 1.05, "Mixed Squad": 0.95 };

const MODEL_VERSION = "2.1";
const MODEL_EXPONENT = 0.1676;
const BASELINE_C = 59.8861;

// Expose the model constants to the optional v1.5 modules as a read-only snapshot.
if (typeof window !== 'undefined') {
    window.PNCEngine = Object.freeze({
        denPowerTable,
        tierMods,
        typeMods,
        model: MODEL_VERSION,
        exponent: MODEL_EXPONENT,
        baselineC: BASELINE_C
    });
}

function getLogs() {
    try {
        const stored = JSON.parse(localStorage.getItem('pnc_battle_logs') || '[]');
        if (!Array.isArray(stored)) return [];

        // Ignore corrupt/outlier entries so one bad log cannot skew calibration.
        return stored.filter(log =>
            log &&
            Number.isFinite(log.actual) && log.actual > 0 && log.actual <= 100 &&
            Number.isFinite(log.ratio) && log.ratio > 0
        );
    } catch {
        return [];
    }
}

// Published calibration comes from calibration.js, which is loaded before this file.
function getPublishedCalibration() {
    const raw = typeof window !== 'undefined' ? window.PNC_CALIBRATION : null;
    const coefficient = raw ? Number(raw.coefficient) : NaN;

    if (!raw || !Number.isFinite(coefficient) || coefficient <= 0) {
        return {
            model: MODEL_VERSION,
            coefficient: BASELINE_C,
            sampleSize: 0,
            updatedAt: null,
            valid: false
        };
    }

    const sampleSize = Number(raw.sampleSize);
    return {
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : MODEL_VERSION,
        coefficient,
        sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? Math.floor(sampleSize) : 0,
        updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : null,
        valid: true
    };
}

function coefficientForLogs(logs) {
    if (!Array.isArray(logs) || logs.length === 0) return null;

    const sumC = logs.reduce((sum, log) => {
        return sum + (log.actual / Math.pow(log.ratio, MODEL_EXPONENT));
    }, 0);
    const average = sumC / logs.length;

    return Number.isFinite(average) && average > 0 ? average : null;
}

function getModelState() {
    const published = getPublishedCalibration();
    const logs = getLogs();
    const localCoefficient = coefficientForLogs(logs);
    const usingLocal = localCoefficient !== null;

    let source = 'baseline';
    if (usingLocal) source = 'local';
    else if (published.valid && published.sampleSize > 0) source = 'published';

    return {
        published,
        logs,
        localCoefficient,
        usingLocal,
        coefficient: usingLocal ? localCoefficient : published.coefficient,
        source,
        sampleSize: usingLocal ? logs.length : published.sampleSize
    };
}

function formatSampleSize(count) {
    return `${count} ${count === 1 ? 'sample' : 'samples'}`;
}

function formatCalibrationDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
}

function updateCalibrationUI(state) {
    const source = document.getElementById('calibrationSource');
    if (source) {
        const labels = {
            local: 'LOCAL OVERRIDE',
            published: 'PUBLISHED',
            baseline: 'BASELINE'
        };
        source.textContent = labels[state.source];
        source.className = `calibration-pill ${state.source}`;
        source.title = state.source === 'local'
            ? 'Your local battle logs override the published calibration.'
            : state.source === 'published'
                ? 'Using the calibration published with the site.'
                : 'Using the built-in baseline coefficient.';
    }

    let publishedText;
    if (!state.published.valid) {
        publishedText = `C ${BASELINE_C.toFixed(4)} · built-in fallback`;
    } else {
        publishedText = `C ${state.published.coefficient.toFixed(4)} · ${formatSampleSize(state.published.sampleSize)}`;
        if (state.published.updatedAt) {
            publishedText += ` · ${formatCalibrationDate(state.published.updatedAt)}`;
        }
    }
    setText('publishedCalibration', publishedText);

    setText('localCalibration', state.usingLocal
        ? `C ${state.localCoefficient.toFixed(4)} · ${state.logs.length} ${state.logs.length === 1 ? 'log' : 'logs'}`
        : 'No local logs');

    setText('logCount', `Logs: ${state.logs.length} (C=${state.coefficient.toFixed(2)})`);
}

function readNonNegative(id) {
    const value = parseFloat(document.getElementById(id).value);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function calculate() {
    const count = readNonNegative('troopCount');
    const tier = document.getElementById('troopTier').value;
    const type = document.getElementById('troopType').value;
    const den = Math.min(45, Math.max(1, parseInt(document.getElementById('denLevel').value, 10) || 1));

    // Read General Troop Stats
    const genAtk = readNonNegative('genAtk');
    const genDef = readNonNegative('genDef');
    const genHp = readNonNegative('genHp');
    const genDmg = readNonNegative('genDmg');

    // Read Type Specific Stats
    const typeAtk = readNonNegative('typeAtk');
    const typeDef = readNonNegative('typeDef');
    const typeHp = readNonNegative('typeHp');
    const typeDmg = readNonNegative('typeDmg');

    // Sum totals (matching Excel B19=B8+B12, B20=B9+B13, B21=B10+B14, B22=B11+B15)
    const netAtk = genAtk + typeAtk;
    const netDef = genDef + typeDef;
    const netHp = genHp + typeHp;
    const netDmg = genDmg + typeDmg;

    // Update Auto-Combined Summary Bar
    document.getElementById('totalAtkSummary').textContent = netAtk.toFixed(1) + '%';
    document.getElementById('totalDefSummary').textContent = netDef.toFixed(1) + '%';
    document.getElementById('totalHpSummary').textContent = netHp.toFixed(1) + '%';
    document.getElementById('totalDmgSummary').textContent = netDmg.toFixed(1) + '%';

    // Compute March Power Score using net sum
    const statSum = netAtk + netDef + netHp;
    const marchPower = (count / 100000) * (tierMods[tier] || 1.0) * (typeMods[type] || 1.0) * Math.sqrt(statSum / 100) * (1 + netDmg / 100);

    const rawDenPwr = denPowerTable[den] || 9000000;
    const enemyPower = rawDenPwr / 1000000;
    const powerRatio = enemyPower > 0 ? marchPower / enemyPower : 0;

    const modelState = getModelState();
    const cAvg = modelState.coefficient;

    const predKill = Math.max(0, Math.min(100, cAvg * Math.pow(powerRatio, MODEL_EXPONENT)));

    // Update Telemetry
    document.getElementById('marchPower').textContent = marchPower.toFixed(4);
    document.getElementById('enemyPower').textContent = enemyPower.toFixed(4);
    document.getElementById('powerRatio').textContent = powerRatio.toFixed(4);
    document.getElementById('predKill').textContent = predKill.toFixed(2) + '%';

    const resEl = document.getElementById('clearResult');
    const statusText = resEl.querySelector('.status-text');
    const isClear = predKill >= 50;
    const nextStatus = isClear ? "CLEAR CONFIRMED" : "DEFEAT EXPECTED";

    // Only write when the label changes so the aria-live region doesn't repeat.
    if (statusText && statusText.textContent !== nextStatus) {
        statusText.textContent = nextStatus;
    }
    resEl.classList.toggle('result-pass', isClear);
    resEl.classList.toggle('result-fail', !isClear);

    updateCalibrationUI(modelState);

    // Let optional modules (improvement suggestions, screenshot import) react to the latest model state.
    document.dispatchEvent(new CustomEvent('pnc:calculation', {
        detail: {
            count, tier, type, den,
            genAtk, genDef, genHp, genDmg,
            typeAtk, typeDef, typeHp, typeDmg,
            netAtk, netDef, netHp, netDmg,
            statSum, marchPower, enemyPower, powerRatio,
            cAvg, predKill, isClear,
            calibration: {
                source: modelState.source,
                coefficient: cAvg,
                sampleSize: modelState.sampleSize,
                publishedCoefficient: modelState.published.coefficient,
                localCoefficient: modelState.localCoefficient
            }
        }
    }));

    return { powerRatio, predKill };
}

function logBattle() {
    const rawInput = parseFloat(document.getElementById('actualKillInput').value);
    if (!Number.isFinite(rawInput) || rawInput <= 0) {
        alert("Please enter a valid Actual Kill % first.");
        return;
    }

    // A value below 1 is accepted as a fraction (0.5 = 50%), but 1 means 1%.
    const killPct = rawInput < 1 ? rawInput * 100 : rawInput;
    if (killPct > 100) {
        alert("Actual Kill % cannot exceed 100%.");
        return;
    }

    // Recalculate so the logged ratio always matches the current inputs.
    const { powerRatio } = calculate();
    if (!Number.isFinite(powerRatio) || powerRatio <= 0) {
        alert("Power ratio must be greater than zero before logging a battle.");
        return;
    }

    let logs = getLogs();
    logs.push({ actual: killPct, ratio: powerRatio });

    try {
        localStorage.setItem('pnc_battle_logs', JSON.stringify(logs));
    } catch {
        alert("Could not save the battle log. Check that browser storage is available.");
        return;
    }

    document.getElementById('actualKillInput').value = '';
    calculate();
    alert(`Battle logged successfully (${killPct}%)! Model auto-calibrated.`);
}

function resetLogs() {
    if (confirm("Reset all training data?")) {
        localStorage.removeItem('pnc_battle_logs');
        calculate();
    }
}

function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Build the exact file that replaces calibration.js on the published site.
function buildCalibrationFile() {
    const state = getModelState();
    if (state.localCoefficient === null) return null;

    const coefficient = Math.round(state.localCoefficient * 10000) / 10000;
    const updatedAt = new Date().toISOString();
    const suffix = state.logs.length === 1 ? '' : 's';

    return `// Shared calibration for Monster Den Predictor.
// Generated from ${state.logs.length} local battle log${suffix} on ${updatedAt}.
// Replace calibration.js in the site folder with this file, then commit it to GitHub.
window.PNC_CALIBRATION = {
    model: "${MODEL_VERSION}",
    coefficient: ${coefficient},
    sampleSize: ${state.logs.length},
    updatedAt: "${updatedAt}"
};
`;
}

function buildBattleLogsFile() {
    const logs = getLogs();
    if (logs.length === 0) return null;

    const coefficient = coefficientForLogs(logs);
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        model: MODEL_VERSION,
        exponent: MODEL_EXPONENT,
        coefficient: coefficient === null ? null : Math.round(coefficient * 10000) / 10000,
        logs
    }, null, 2) + '\n';
}

function exportCalibration() {
    const content = buildCalibrationFile();
    if (!content) {
        alert("Log at least one battle before exporting a calibration file.");
        return false;
    }
    downloadFile('calibration.js', content, 'text/javascript');
    return true;
}

function exportBattleLogs() {
    const content = buildBattleLogsFile();
    if (!content) {
        alert("There are no battle logs to back up yet.");
        return false;
    }
    downloadFile('battle-logs.json', content, 'application/json');
    return true;
}

// Small read-only API for testing and for the admin buttons.
if (typeof window !== 'undefined') {
    window.PNCAdmin = Object.freeze({
        getModelState,
        getLogs,
        buildCalibrationFile,
        buildBattleLogsFile,
        exportCalibration,
        exportBattleLogs
    });
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input', calculate);
    });

    const adminBtn = document.getElementById('adminToggleBtn');
    const adminPanel = document.getElementById('adminPanel');
    adminBtn.addEventListener('click', () => {
        const pin = prompt("Enter Admin PIN for telemetry & model training:");
        if (pin === "7777") {
            const isHidden = adminPanel.classList.toggle('hidden');
            adminBtn.setAttribute('aria-expanded', String(!isHidden));
        } else if (pin !== null) {
            alert("Incorrect PIN.");
        }
    });

    document.getElementById('logBtn').addEventListener('click', logBattle);
    document.getElementById('resetLogsBtn').addEventListener('click', resetLogs);

    const exportCalibrationBtn = document.getElementById('exportCalibrationBtn');
    if (exportCalibrationBtn) {
        exportCalibrationBtn.addEventListener('click', exportCalibration);
    }

    const exportLogsBtn = document.getElementById('exportLogsBtn');
    if (exportLogsBtn) {
        exportLogsBtn.addEventListener('click', exportBattleLogs);
    }

    calculate();
});
