// Profile screenshot import for Puzzles & Chaos v1.5
// OCR runs locally in the browser via Tesseract.js, loaded on demand from a CDN.
// The image is drawn to a canvas and passed to the worker; it is never uploaded.
(function (root) {
    'use strict';

    const OCR = {
        script: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
        worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
        core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
        lang: 'https://tessdata.projectnaptha.com/4.0.0_fast'
    };

    const MAX_BYTES = 15 * 1024 * 1024;
    const MAX_PIXELS = 6000000;
    const SUPPORTED_IMAGE = /^image\/(?:png|jpe?g|webp|bmp|gif)$/i;
    const SUPPORTED_EXTENSION = /\.(?:png|jpe?g|webp|bmp|gif)$/i;
    const STAT_KEYS = ['atk', 'def', 'hp', 'dmg'];
    const TYPE_ORDER = ['Infantry', 'Cavalry', 'Archer'];

    const GENERAL_INPUTS = { atk: 'reviewGenAtk', def: 'reviewGenDef', hp: 'reviewGenHp', dmg: 'reviewGenDmg' };
    const TYPE_INPUTS = { atk: 'reviewTypeAtk', def: 'reviewTypeDef', hp: 'reviewTypeHp', dmg: 'reviewTypeDmg' };
    const CALC_GENERAL_INPUTS = { atk: 'genAtk', def: 'genDef', hp: 'genHp', dmg: 'genDmg' };
    const CALC_TYPE_INPUTS = { atk: 'typeAtk', def: 'typeDef', hp: 'typeHp', dmg: 'typeDmg' };

    const els = {};
    let draft = null;
    let activeType = 'Infantry';
    let busy = false;
    let activeJob = 0;
    let worker = null;
    let workerPromise = null;
    let workerGeneration = 0;
    let scriptPromise = null;
    let previewUrl = null;
    let recognizeLabel = 'Reading screenshot';

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function finite(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function withTimeout(promise, timeoutMs, message, onTimeout) {
        let timer = null;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                try {
                    if (onTimeout) onTimeout();
                } catch {
                    // The cleanup is best-effort.
                }
                reject(new Error(message));
            }, timeoutMs);
        });

        return Promise.race([promise, timeout]).finally(() => {
            if (timer !== null) clearTimeout(timer);
        });
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }

    function cacheElements() {
        els.file = document.getElementById('screenshotInput');
        els.dropzone = document.getElementById('dropzone');
        els.progress = document.getElementById('importProgress');
        els.progressTrack = document.getElementById('importProgressTrack');
        els.progressBar = document.getElementById('importProgressBar');
        els.status = document.getElementById('importStatus');
        els.cancel = document.getElementById('importCancelBtn');
        els.previewWrap = document.getElementById('importPreviewWrap');
        els.preview = document.getElementById('importPreview');
        els.fileName = document.getElementById('importFileName');
        els.clear = document.getElementById('importClearBtn');
        els.error = document.getElementById('importError');
        els.note = document.getElementById('importNote');
        els.dialog = document.getElementById('reviewDialog');
        els.reviewSummary = document.getElementById('reviewSummary');
        els.reviewRaw = document.getElementById('reviewRaw');
        els.reviewApply = document.getElementById('reviewApply');
        els.typeTabs = document.getElementById('reviewTypeTabs');
    }

    function clearMessages() {
        if (els.error) {
            els.error.textContent = '';
            els.error.classList.add('hidden');
        }
        if (els.note) {
            els.note.textContent = '';
            els.note.classList.add('hidden');
        }
    }

    function showError(message) {
        if (els.note) {
            els.note.textContent = '';
            els.note.classList.add('hidden');
        }
        if (els.error) {
            els.error.textContent = message;
            els.error.classList.remove('hidden');
        }
    }

    function showNote(message) {
        if (els.error) {
            els.error.textContent = '';
            els.error.classList.add('hidden');
        }
        if (els.note) {
            els.note.textContent = message;
            els.note.classList.remove('hidden');
        }
    }

    function setProgress(label, value) {
        if (!els.progress) return;
        els.progress.classList.remove('hidden');
        if (els.progressBar) {
            els.progressBar.style.width = `${Math.round(clamp(value, 0, 1) * 100)}%`;
        }
        if (els.status && els.status.textContent !== label) {
            els.status.textContent = label;
        }
        if (els.progress && els.progressTrack) {
            els.progressTrack.setAttribute('aria-valuenow', String(Math.round(clamp(value, 0, 1) * 100)));
        }
    }

    function setBusy(value) {
        busy = value;
        if (els.dropzone) els.dropzone.setAttribute('aria-busy', String(value));
        if (els.cancel) els.cancel.classList.toggle('hidden', !value);
        if (!value && els.progress) els.progress.classList.add('hidden');
    }

    function loadScript() {
        if (root.Tesseract) return Promise.resolve();
        if (scriptPromise) return scriptPromise;

        scriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = OCR.script;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.onload = () => {
                if (root.Tesseract) resolve();
                else reject(new Error('The OCR engine did not initialize.'));
            };
            script.onerror = () => {
                scriptPromise = null;
                reject(new Error('Could not load the OCR engine. The first import needs an internet connection.'));
            };
            document.head.append(script);
        });

        return scriptPromise;
    }

    const LOG_PHASES = {
        'loading tesseract core': [0.05, 0.2, 'Loading OCR engine'],
        'initializing tesseract': [0.2, 0.26, 'Starting OCR engine'],
        'loading language traineddata': [0.26, 0.42, 'Downloading English text model (first run only)'],
        'initializing api': [0.42, 0.46, 'Preparing OCR'],
        'recognizing text': [0.46, 0.98, 'Reading screenshot']
    };

    function handleLog(message) {
        if (!busy || !message) return;
        const phase = LOG_PHASES[message.status];
        if (!phase) return;

        const [start, end, label] = phase;
        const isSecondPass = message.status === 'recognizing text' && recognizeLabel === 'Second pass';
        const from = isSecondPass ? 0.62 : start;
        const to = isSecondPass ? 0.98 : end;
        const progress = from + (to - from) * clamp(finite(message.progress, 0), 0, 1);

        setProgress(`${message.status === 'recognizing text' ? recognizeLabel : label}...`, progress);
    }

    async function createWorkerInstance() {
        await loadScript();
        const tesseract = root.Tesseract;
        if (!tesseract || typeof tesseract.createWorker !== 'function') {
            throw new Error('The OCR engine could not be initialized.');
        }

        const instance = await tesseract.createWorker('eng', 1, {
            workerPath: OCR.worker,
            corePath: OCR.core,
            langPath: OCR.lang,
            workerBlobURL: true,
            logger: handleLog
        });

        await instance.setParameters({
            tessedit_pageseg_mode: '11',
            preserve_interword_spaces: '1'
        });

        return instance;
    }

    function getWorker(job) {
        if (!workerPromise) {
            const generation = ++workerGeneration;
            workerPromise = withTimeout(
                createWorkerInstance(),
                90000,
                'The OCR engine took too long to load. Check your connection and try again.',
                terminateWorker
            )
                .then(instance => {
                    if (generation !== workerGeneration || job !== activeJob) {
                        Promise.resolve(instance.terminate()).catch(() => {});
                        throw new Error('Import canceled.');
                    }
                    worker = instance;
                    return instance;
                })
                .catch(error => {
                    if (generation === workerGeneration) workerPromise = null;
                    throw error;
                });
        }
        return workerPromise;
    }

    function terminateWorker() {
        workerGeneration++;
        workerPromise = null;
        const current = worker;
        worker = null;
        if (current) {
            try {
                Promise.resolve(current.terminate()).catch(() => {});
            } catch {
                // The worker may already be gone.
            }
        }
    }

    function cancelJob(showMessage) {
        if (!busy) return;
        activeJob++;
        terminateWorker();
        setBusy(false);
        if (showMessage) showNote('Import canceled. Nothing was changed.');
    }

    async function loadImage(file) {
        if (typeof root.createImageBitmap === 'function') {
            try {
                return await root.createImageBitmap(file);
            } catch {
                // Fall back to an <img> element for formats the browser cannot decode to a bitmap.
            }
        }

        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('That image could not be opened.'));
            };
            image.src = url;
        });
    }

    function cloneCanvas(source) {
        const canvas = document.createElement('canvas');
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(source, 0, 0);
        return canvas;
    }

    function applyContrast(canvas, contrast, brightness) {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = image.data;
        const intercept = 128 * (1 - contrast) + brightness;

        for (let index = 0; index < data.length; index += 4) {
            const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
            const value = clamp(gray * contrast + intercept, 0, 255);
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
        }

        context.putImageData(image, 0, 0);
    }

    function applyOtsu(canvas) {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = image.data;
        const histogram = new Uint32Array(256);
        const total = data.length / 4;

        for (let index = 0; index < data.length; index += 4) {
            const gray = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
            histogram[gray]++;
            data[index] = gray;
            data[index + 1] = gray;
            data[index + 2] = gray;
        }

        let sum = 0;
        for (let level = 0; level < 256; level++) sum += level * histogram[level];

        let sumBackground = 0;
        let weightBackground = 0;
        let maxVariance = 0;
        let threshold = 127;

        for (let level = 0; level < 256; level++) {
            weightBackground += histogram[level];
            if (!weightBackground) continue;

            const weightForeground = total - weightBackground;
            if (!weightForeground) break;

            sumBackground += level * histogram[level];
            const meanBackground = sumBackground / weightBackground;
            const meanForeground = (sum - sumBackground) / weightForeground;
            const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = level;
            }
        }

        let lightPixels = 0;
        for (let index = 0; index < data.length; index += 4) {
            if (data[index] > threshold) lightPixels++;
        }
        const invert = lightPixels < total / 2;

        for (let index = 0; index < data.length; index += 4) {
            const value = (data[index] > threshold) !== invert ? 255 : 0;
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
        }

        context.putImageData(image, 0, 0);
    }

    async function prepareCanvases(file) {
        const source = await loadImage(file);
        const width = source.width || source.naturalWidth;
        const height = source.height || source.naturalHeight;
        if (!width || !height) throw new Error('The selected image could not be read.');

        let scale = clamp(1400 / width, 1, 3);
        if (width * height * scale * scale > MAX_PIXELS) {
            scale = Math.sqrt(MAX_PIXELS / (width * height));
        }
        scale = Math.max(0.35, scale);

        const base = document.createElement('canvas');
        base.width = Math.max(1, Math.round(width * scale));
        base.height = Math.max(1, Math.round(height * scale));
        const context = base.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas rendering is not available in this browser.');

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, base.width, base.height);
        if (typeof source.close === 'function') source.close();

        const contrast = cloneCanvas(base);
        applyContrast(contrast, 1.35, 5);

        const binary = cloneCanvas(base);
        applyOtsu(binary);

        return { contrast, binary };
    }

    function makeDraft(result) {
        const group = stats => {
            const output = {};
            STAT_KEYS.forEach(key => {
                const field = stats[key];
                output[key] = {
                    value: field ? String(field.value) : '',
                    original: field ? String(field.value) : '',
                    confidence: field ? field.confidence : 'missing'
                };
            });
            return output;
        };

        return {
            general: group(result.general),
            types: {
                Infantry: group(result.types.Infantry),
                Cavalry: group(result.types.Cavalry),
                Archer: group(result.types.Archer)
            }
        };
    }

    function confidenceLabel(confidence) {
        if (confidence === 'high') return 'High';
        if (confidence === 'medium') return 'Med';
        if (confidence === 'low') return 'Low';
        return '—';
    }

    function confidenceTitle(confidence) {
        if (confidence === 'high') return 'High OCR confidence';
        if (confidence === 'medium') return 'Medium OCR confidence - verify this value';
        if (confidence === 'low') return 'Low OCR confidence - verify this value';
        return 'Not detected - enter manually or leave blank';
    }

    function updateFieldVisual(input, field) {
        const wrapper = input.closest('.review-field');
        const pill = wrapper ? wrapper.querySelector('.confidence-pill') : null;

        let level;
        let label;
        let title;

        if (!field.value) {
            level = 'skipped';
            label = 'Skip';
            title = 'Blank - this field will not be applied';
        } else if (field.value !== field.original) {
            level = 'edited';
            label = 'Edited';
            title = 'Edited manually';
        } else {
            level = field.confidence;
            label = confidenceLabel(field.confidence);
            title = confidenceTitle(field.confidence);
        }

        if (pill) {
            pill.dataset.level = level;
            pill.textContent = label;
            pill.title = title;
        }
        if (wrapper) wrapper.classList.toggle('is-missing', !field.value);
    }

    function applyField(inputId, field) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.value = field.value;
        updateFieldVisual(input, field);
    }

    function renderGeneral() {
        STAT_KEYS.forEach(key => applyField(GENERAL_INPUTS[key], draft.general[key]));
    }

    function renderType() {
        const group = draft.types[activeType];
        STAT_KEYS.forEach(key => applyField(TYPE_INPUTS[key], group[key]));
    }

    function countFilled(group) {
        return STAT_KEYS.reduce((count, key) => (group[key].value.trim() !== '' ? count + 1 : count), 0);
    }

    function renderTabs() {
        if (!els.typeTabs) return;
        els.typeTabs.querySelectorAll('button[data-type]').forEach(button => {
            const type = button.dataset.type;
            const group = draft.types[type];
            if (!group) return;

            const count = countFilled(group);
            button.setAttribute('aria-pressed', String(type === activeType));
            button.classList.toggle('is-empty', count === 0);

            const badge = button.querySelector('.tab-count');
            if (badge) badge.textContent = `${count}/4`;
        });
    }

    function updateReviewSummary() {
        if (!els.reviewSummary || !draft) return;
        const general = countFilled(draft.general);
        const type = countFilled(draft.types[activeType]);
        els.reviewSummary.textContent = `${general}/4 general · ${type}/4 ${activeType} selected · blank values are left unchanged`;
    }

    function updateApplyState() {
        if (!els.reviewApply || !draft) return;
        const total = countFilled(draft.general) + countFilled(draft.types[activeType]);
        els.reviewApply.disabled = total === 0;
    }

    function openReview(result, rawText) {
        draft = makeDraft(result);

        const currentType = document.getElementById('troopType').value;
        if (result.typeCounts[currentType] > 0) {
            activeType = currentType;
        } else if (result.bestType) {
            activeType = result.bestType;
        } else {
            activeType = TYPE_ORDER.includes(currentType) ? currentType : 'Infantry';
        }

        renderGeneral();
        renderTabs();
        renderType();
        updateReviewSummary();
        updateApplyState();

        if (els.reviewRaw) els.reviewRaw.textContent = rawText || result.rawText || 'No text captured.';

        if (typeof els.dialog.showModal === 'function') {
            if (!els.dialog.open) els.dialog.showModal();
        } else {
            els.dialog.setAttribute('open', '');
        }

        requestAnimationFrame(() => {
            const firstInput = els.dialog.querySelector('input');
            if (firstInput) firstInput.focus();
        });
    }

    function closeReview() {
        if (!els.dialog) return;
        if (typeof els.dialog.close === 'function' && els.dialog.open) {
            els.dialog.close();
        } else {
            els.dialog.removeAttribute('open');
        }
    }

    function readGroup(group) {
        const values = {};
        STAT_KEYS.forEach(key => {
            const raw = group[key].value.trim();
            if (!raw) return;
            const value = Number.parseFloat(raw.replace(',', '.'));
            if (Number.isFinite(value) && value >= 0) values[key] = value;
        });
        return values;
    }

    function setCalculatorValue(id, value) {
        const input = document.getElementById(id);
        if (input) input.value = String(value);
    }

    function applyReview() {
        if (!draft) return;

        const generalValues = readGroup(draft.general);
        const typeValues = readGroup(draft.types[activeType]);
        let applied = 0;

        Object.keys(generalValues).forEach(key => {
            setCalculatorValue(CALC_GENERAL_INPUTS[key], generalValues[key]);
            applied++;
        });
        Object.keys(typeValues).forEach(key => {
            setCalculatorValue(CALC_TYPE_INPUTS[key], typeValues[key]);
            applied++;
        });

        if (Object.keys(typeValues).length > 0) {
            document.getElementById('troopType').value = activeType;
        }

        if (typeof root.calculate === 'function') root.calculate();
        closeReview();
        showNote(`Applied ${applied} ${applied === 1 ? 'value' : 'values'} from the screenshot. The forecast and improvement plan are updated.`);
    }

    function showPreview(file) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(file);
        els.preview.src = previewUrl;
        els.preview.alt = `Preview of ${file.name || 'the selected screenshot'}`;
        els.fileName.textContent = `${file.name || 'Screenshot'} · ${formatBytes(file.size)}`;
        els.previewWrap.classList.remove('hidden');
    }

    function resetImport() {
        if (busy) cancelJob(false);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
        els.file.value = '';
        els.preview.removeAttribute('src');
        els.preview.alt = '';
        els.previewWrap.classList.add('hidden');
        els.fileName.textContent = '';
        els.progress.classList.add('hidden');
        els.progressBar.style.width = '0%';
        els.progressTrack.setAttribute('aria-valuenow', '0');
        draft = null;
        clearMessages();
    }

    function validateFile(file) {
        if (!file) return 'Choose an image file first.';
        const type = (file.type || '').toLowerCase();
        const name = file.name || '';
        if (type && !SUPPORTED_IMAGE.test(type)) {
            return 'That file type is not supported. Use a PNG, JPG, WebP, BMP, or GIF image.';
        }
        if (!type && !SUPPORTED_EXTENSION.test(name)) {
            return 'That file does not look like an image. Use a PNG, JPG, WebP, BMP, or GIF.';
        }
        if (file.size > MAX_BYTES) {
            return `That image is ${formatBytes(file.size)}. Use a screenshot smaller than 15 MB.`;
        }
        return null;
    }

    async function runOCR(file) {
        const job = ++activeJob;
        setBusy(true);
        recognizeLabel = 'Reading screenshot';
        setProgress('Preparing screenshot...', 0.02);

        try {
            const prepared = await prepareCanvases(file);
            if (job !== activeJob) return;

            setProgress('Loading OCR engine...', 0.05);
            const instance = await getWorker(job);
            if (job !== activeJob) return;

            setProgress('Reading screenshot...', 0.46);
            const first = await withTimeout(
                instance.recognize(prepared.contrast, {}, { blocks: true }),
                90000,
                'The OCR reader took too long. Try a smaller or clearer screenshot.',
                terminateWorker
            );
            if (job !== activeJob) return;

            let parsed = root.PNCProfileParser.parse(first.data);
            const rawParts = [first.data.text || ''];
            const typeComplete = parsed.detectedTypes.some(type => parsed.typeCounts[type] >= 4);

            if (parsed.generalCount < 4 || !typeComplete) {
                recognizeLabel = 'Second pass';
                setProgress('Second pass for smaller or lower-contrast text...', 0.62);
                await instance.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
                const second = await withTimeout(
                    instance.recognize(prepared.binary, {}, { blocks: true }),
                    90000,
                    'The OCR reader took too long. Try a smaller or clearer screenshot.',
                    terminateWorker
                );
                if (job !== activeJob) return;

                rawParts.push(second.data.text || '');
                parsed = root.PNCProfileParser.mergeResults(parsed, root.PNCProfileParser.parse(second.data));
                await instance.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
            }

            if (parsed.foundCount === 0) {
                showError('No stats were detected. Try a clearer screenshot of the stat page, or enter the values manually.');
                return;
            }

            const totalDetected = parsed.generalCount + Object.values(parsed.typeCounts).reduce((sum, count) => sum + count, 0);
            const typeNote = parsed.detectedTypes.length > 1 ? ` across ${parsed.detectedTypes.length} troop types` : '';
            openReview(parsed, rawParts.filter(Boolean).join('\n\n--- second pass ---\n\n'));
            showNote(`Detected ${totalDetected} values${typeNote}. Review them before applying.`);
        } catch (error) {
            if (job !== activeJob) return;
            // Drop the cached worker after a failure so the next import starts clean.
            terminateWorker();
            console.error('Profile screenshot OCR failed:', error);
            const message = error && error.message ? error.message : 'The screenshot could not be read.';
            showError(message.includes('OCR engine') ? message : `${message} Try a clearer screenshot or enter the values manually.`);
        } finally {
            if (job === activeJob) {
                setBusy(false);
            }
        }
    }

    function handleFile(file) {
        clearMessages();
        const problem = validateFile(file);
        if (problem) {
            showError(problem);
            return;
        }
        if (busy) cancelJob(false);
        showPreview(file);
        runOCR(file);
    }

    function chooseFile() {
        if (!busy) els.file.click();
    }

    function onReviewInput(event) {
        if (!draft) return;
        const input = event.target.closest('input[data-stat]');
        if (!input) return;

        const scope = input.dataset.scope;
        const key = input.dataset.stat;
        if (!STAT_KEYS.includes(key)) return;

        const field = scope === 'general' ? draft.general[key] : draft.types[activeType][key];
        field.value = input.value.trim();
        updateFieldVisual(input, field);
        renderTabs();
        updateReviewSummary();
        updateApplyState();
    }

    function bind() {
        els.file.addEventListener('change', () => {
            const file = els.file.files && els.file.files[0];
            els.file.value = '';
            if (file) handleFile(file);
        });

        els.dropzone.addEventListener('click', chooseFile);
        els.dropzone.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                chooseFile();
            }
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            els.dropzone.addEventListener(eventName, event => {
                event.preventDefault();
                event.stopPropagation();
                els.dropzone.classList.add('is-dragover');
            });
        });

        ['dragleave', 'dragend'].forEach(eventName => {
            els.dropzone.addEventListener(eventName, () => {
                els.dropzone.classList.remove('is-dragover');
            });
        });

        els.dropzone.addEventListener('drop', event => {
            event.preventDefault();
            event.stopPropagation();
            els.dropzone.classList.remove('is-dragover');
            const files = event.dataTransfer && event.dataTransfer.files;
            if (files && files.length) handleFile(files[0]);
        });

        // Stop the browser from navigating away when a file is dropped outside the dropzone.
        root.addEventListener('dragover', event => {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
                event.preventDefault();
            }
        });
        root.addEventListener('drop', event => {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
                event.preventDefault();
            }
        });

        document.addEventListener('paste', event => {
            const data = event.clipboardData;
            if (!data || !data.items) return;
            for (const item of data.items) {
                if (item.kind === 'file' && /^image\//i.test(item.type)) {
                    const file = item.getAsFile();
                    if (file) {
                        event.preventDefault();
                        handleFile(file);
                    }
                    return;
                }
            }
        });

        els.clear.addEventListener('click', resetImport);
        els.cancel.addEventListener('click', () => cancelJob(true));

        els.typeTabs.addEventListener('click', event => {
            const button = event.target.closest('button[data-type]');
            if (!button || !draft) return;
            const type = button.dataset.type;
            if (!TYPE_ORDER.includes(type)) return;
            activeType = type;
            renderTabs();
            renderType();
            updateReviewSummary();
            updateApplyState();
        });

        els.dialog.addEventListener('input', onReviewInput);
        els.dialog.addEventListener('click', event => {
            if (event.target.closest('[data-review-close]')) closeReview();
        });
        els.reviewApply.addEventListener('click', applyReview);
    }

    function init() {
        cacheElements();
        if (!els.file || !els.dropzone || !els.dialog || !els.reviewApply) return;
        bind();
    }

    root.PNCScreenshotImport = { init };
    init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
