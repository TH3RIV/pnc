// Local profile-screenshot OCR parser for Puzzles & Chaos v1.5
// This file has no network or storage side effects. It only turns OCR lines into stats.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PNCProfileParser = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TYPE_DEFS = [
        { key: 'Infantry', aliases: ['infantry', 'inf'] },
        { key: 'Cavalry', aliases: ['cavalry', 'cav'] },
        { key: 'Archer', aliases: ['archer', 'archers', 'ranged', 'bow', 'bowmen'] }
    ];

    // Keep the more specific damage labels first.
    const STAT_DEFS = [
        { key: 'dmg', aliases: ['damage up', 'dmg up', 'damage bonus', 'dmg bonus', 'damage', 'dmg'] },
        { key: 'atk', aliases: ['atk', 'attack', 'attack power'] },
        { key: 'def', aliases: ['def', 'defense', 'defence', 'defense power'] },
        { key: 'hp', aliases: ['hp', 'health', 'health points'] }
    ];

    const STAT_KEYS = ['atk', 'def', 'hp', 'dmg'];
    const GENERAL_HEADING = /\b(?:troop stats?|general stats?|base stats?|all troops?|troop bonuses?|combat stats?)\b/i;
    const TROOP_PREFIX = /\btroops?\b/i;
    const TYPE_HEADING = /\b(?:stats?|bonuses?)\b/i;
    const NUMBER_ONLY = /^[+\-]?\d[\d.,]*\s*%?$/;
    const NUMBER_RE = /[+\-]?\d[\d.,]*(?:\s*%)?/g;

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    TYPE_DEFS.forEach(type => {
        type.regex = new RegExp('\\b(?:' + type.aliases.map(escapeRegExp).join('|') + ')\\b', 'i');
    });

    STAT_DEFS.forEach(stat => {
        stat.regex = new RegExp('\\b(?:' + stat.aliases.map(escapeRegExp).join('|') + ')\\b', 'i');
    });

    function cleanText(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[|]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findType(text) {
        const match = TYPE_DEFS.find(type => type.regex.test(text));
        return match ? match.key : null;
    }

    function findStat(text) {
        let best = null;
        STAT_DEFS.forEach(stat => {
            const match = text.match(stat.regex);
            if (match && (!best || match.index < best.index)) {
                best = {
                    key: stat.key,
                    index: match.index,
                    text: match[0]
                };
            }
        });
        return best;
    }

    function parseNumber(raw) {
        let value = String(raw || '').replace(/[^\d.,+\-]/g, '').trim();
        if (!value) return null;

        if (value.includes(',') && value.includes('.')) {
            value = value.replace(/,/g, '');
        } else if (value.includes(',')) {
            const parts = value.split(',');
            if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2) {
                value = value.replace(',', '.');
            } else {
                value = value.replace(/,/g, '');
            }
        }

        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function getCandidates(text) {
        const candidates = [];
        NUMBER_RE.lastIndex = 0;
        let match;

        while ((match = NUMBER_RE.exec(text)) !== null) {
            const raw = match[0].trim();
            if (!raw) continue;

            const start = match.index;
            const before = text.slice(Math.max(0, start - 8), start);
            if (/(?:lv|level|tier|t)\.?\s*$/i.test(before)) continue;

            const value = parseNumber(raw);
            if (value === null) continue;

            candidates.push({
                value,
                raw,
                hasPercent: raw.includes('%'),
                start,
                end: start + raw.length
            });
        }

        return candidates;
    }

    function pickValue(text, labelMatch, lineConfidence) {
        const candidates = getCandidates(text);
        if (!candidates.length) return null;

        const labelEnd = labelMatch ? labelMatch.index + labelMatch.text.length : 0;
        let pool = candidates.filter(candidate => candidate.start >= labelEnd);
        if (!pool.length) {
            const labelStart = labelMatch ? labelMatch.index : Number.MAX_SAFE_INTEGER;
            pool = candidates.filter(candidate => candidate.end <= labelStart);
            if (!pool.length) pool = candidates;
        }

        const withPercent = pool.filter(candidate => candidate.hasPercent);
        const chosen = (withPercent.length ? withPercent : pool)[0];
        if (!chosen) return null;

        let confidence = chosen.hasPercent ? 'high' : 'medium';
        if (Number.isFinite(lineConfidence) && lineConfidence < 55) {
            confidence = 'low';
        }

        return {
            value: chosen.value,
            raw: chosen.raw,
            hasPercent: chosen.hasPercent,
            confidence
        };
    }

    function numericOnlyCandidate(line) {
        if (!line || !NUMBER_ONLY.test(line.text)) return null;
        const value = parseNumber(line.text);
        if (value === null) return null;
        return {
            value,
            raw: line.text,
            hasPercent: line.text.includes('%'),
            confidence: line.text.includes('%') ? 'high' : 'medium'
        };
    }

    function spatialValue(lines, index, labelMatch) {
        const labelLine = lines[index];
        if (!labelLine || !labelLine.bbox) return null;

        const labelBox = labelLine.bbox;
        const labelHeight = Math.max(1, labelBox.y1 - labelBox.y0);
        const labelCenterY = (labelBox.y0 + labelBox.y1) / 2;
        let best = null;

        lines.forEach((line, lineIndex) => {
            if (lineIndex === index || !line.bbox) return;
            const candidate = numericOnlyCandidate(line);
            if (!candidate) return;

            const box = line.bbox;
            const centerY = (box.y0 + box.y1) / 2;
            const sameRow = Math.abs(centerY - labelCenterY) <= Math.max(16, labelHeight * 0.9);
            const below = box.y0 >= labelBox.y1 - 2 && box.y0 - labelBox.y1 <= labelHeight * 3;
            if (!sameRow && !below) return;

            const rightSide = box.x0 >= labelBox.x1 - 8;
            const verticalDistance = Math.abs(centerY - labelCenterY);
            const horizontalDistance = rightSide ? Math.max(0, box.x0 - labelBox.x1) : 100000 + Math.abs(box.x0 - labelBox.x0);
            const score = verticalDistance * 2 + horizontalDistance;

            if (!best || score < best.score) {
                best = {
                    score,
                    candidate: {
                        ...candidate,
                        confidence: candidate.hasPercent ? 'high' : 'medium'
                    }
                };
            }
        });

        return best ? best.candidate : null;
    }

    function nextLineValue(lines, index) {
        for (let cursor = index + 1; cursor < Math.min(index + 3, lines.length); cursor++) {
            const line = lines[cursor];
            if (!line) continue;
            const candidate = numericOnlyCandidate(line);
            if (candidate) return candidate;
            if (line.text && /\d/.test(line.text)) break;
        }
        return null;
    }

    function valueForLabel(lines, index, labelMatch) {
        const line = lines[index];
        const direct = pickValue(line.text, labelMatch, line.confidence);
        if (direct) return direct;

        const spatial = spatialValue(lines, index, labelMatch);
        if (spatial) return spatial;

        return nextLineValue(lines, index);
    }

    function emptyStats() {
        return { atk: null, def: null, hp: null, dmg: null };
    }

    function emptyResult(rawText) {
        return {
            general: emptyStats(),
            types: {
                Infantry: emptyStats(),
                Cavalry: emptyStats(),
                Archer: emptyStats()
            },
            detectedTypes: [],
            bestType: null,
            generalCount: 0,
            typeCounts: { Infantry: 0, Cavalry: 0, Archer: 0 },
            foundCount: 0,
            rawText: rawText || '',
            lines: []
        };
    }

    function scoreConfidence(confidence) {
        return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
    }

    function setField(target, key, value, sourceText, lineIndex) {
        if (!value) return;
        const existing = target[key];
        if (existing && scoreConfidence(existing.confidence) >= scoreConfidence(value.confidence)) {
            return;
        }
        target[key] = {
            value: value.value,
            raw: value.raw,
            confidence: value.confidence,
            source: sourceText,
            lineIndex
        };
    }

    function countStats(stats) {
        return STAT_KEYS.reduce((count, key) => count + (stats[key] ? 1 : 0), 0);
    }

    function finalize(result) {
        result.generalCount = countStats(result.general);
        result.typeCounts = {};
        result.detectedTypes = [];

        Object.keys(result.types).forEach(type => {
            const count = countStats(result.types[type]);
            result.typeCounts[type] = count;
            if (count > 0) result.detectedTypes.push(type);
        });

        const sortedTypes = [...result.detectedTypes].sort((a, b) => result.typeCounts[b] - result.typeCounts[a]);
        result.bestType = sortedTypes[0] || null;
        result.foundCount = result.generalCount + (result.bestType ? result.typeCounts[result.bestType] : 0);
        return result;
    }

    function flattenLines(data) {
        const lines = [];

        if (data && Array.isArray(data.blocks)) {
            data.blocks.forEach(block => {
                (block.paragraphs || []).forEach(paragraph => {
                    (paragraph.lines || []).forEach(line => {
                        const text = cleanText(line.text);
                        if (!text) return;
                        lines.push({
                            text,
                            bbox: line.bbox || null,
                            confidence: Number.isFinite(line.confidence) ? line.confidence : null
                        });
                    });
                });
            });
        }

        if (!lines.length && data && typeof data.text === 'string') {
            data.text.split(/\r?\n/).forEach(text => {
                const cleaned = cleanText(text);
                if (cleaned) lines.push({ text: cleaned, bbox: null, confidence: null });
            });
        }

        return lines;
    }

    function parseLines(lines) {
        const result = emptyResult();
        let section = 'general';

        lines.forEach((line, index) => {
            const text = cleanText(line.text);
            if (!text) return;

            const type = findType(text);
            const stat = findStat(text);

            if (type) {
                section = type;
                if (!stat && !TYPE_HEADING.test(text)) {
                    // A bare type label is also a section heading.
                }
                if (!stat) return;
            } else if (GENERAL_HEADING.test(text) || TROOP_PREFIX.test(text)) {
                section = 'general';
                if (!stat) return;
            }

            if (!stat) return;

            const targetSection = type || section;
            const target = targetSection === 'general' ? result.general : result.types[targetSection];
            if (!target) return;

            const value = valueForLabel(lines, index, stat);
            if (!value) return;

            setField(target, stat.key, value, text, index);
        });

        return finalize(result);
    }

    function parse(data) {
        const lines = flattenLines(data);
        const result = parseLines(lines);
        result.rawText = (data && data.text) || lines.map(line => line.text).join('\n');
        result.lines = lines.map(line => line.text);
        return result;
    }

    function parseText(text) {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map(value => cleanText(value))
            .filter(Boolean)
            .map(value => ({ text: value, bbox: null, confidence: null }));
        const result = parseLines(lines);
        result.rawText = String(text || '');
        result.lines = lines.map(line => line.text);
        return result;
    }

    function mergeResults(primary, fallback) {
        const merged = emptyResult(primary.rawText || fallback.rawText);

        ['general', 'types'].forEach(group => {
            if (group === 'general') {
                STAT_KEYS.forEach(key => {
                    merged.general[key] = primary.general[key] || fallback.general[key];
                });
            } else {
                Object.keys(merged.types).forEach(type => {
                    STAT_KEYS.forEach(key => {
                        merged.types[type][key] = primary.types[type][key] || fallback.types[type][key];
                    });
                });
            }
        });

        merged.rawText = primary.rawText || fallback.rawText;
        merged.lines = primary.lines && primary.lines.length ? primary.lines : fallback.lines;
        return finalize(merged);
    }

    return {
        TYPE_DEFS,
        STAT_DEFS,
        parse,
        parseText,
        mergeResults,
        flattenLines
    };
});
