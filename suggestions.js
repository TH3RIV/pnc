// Improvement suggestions for Puzzles & Chaos v1.5
// The analysis is pure so it can be tested without a browser. The panel only renders.
(function (root) {
    'use strict';

    const DEFAULT_TARGET = 55; // 50% clear + the model's +/-5% margin
    const EXPONENT = 0.1676;
    const TIER_ORDER = ['T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'];
    const TYPE_ORDER = ['Infantry', 'Cavalry', 'Archer'];
    const MAX_STAT_MULTIPLIER = 6;        // total ATK+DEF+HP; above this is too unrealistic
    const LONG_TERM_STAT_MULTIPLIER = 3;  // above this, label the stat target as long-term
    const MAX_DAMAGE_GAIN = 25;           // percentage points; Damage Up is a scarce stat

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function finite(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function ceilTo(value, step) {
        return Math.ceil(value / step - 1e-9) * step;
    }

    function denPower(level) {
        const engine = root.PNCEngine;
        if (engine && engine.denPowerTable && Number.isFinite(engine.denPowerTable[level])) {
            return engine.denPowerTable[level];
        }
        return 9000000;
    }

    function tierMod(tier) {
        const engine = root.PNCEngine;
        if (engine && engine.tierMods && Number.isFinite(engine.tierMods[tier])) {
            return engine.tierMods[tier];
        }
        return 1;
    }

    function typeMod(type) {
        const engine = root.PNCEngine;
        if (engine && engine.typeMods && Number.isFinite(engine.typeMods[type])) {
            return engine.typeMods[type];
        }
        return 1;
    }

    function exponent() {
        const engine = root.PNCEngine;
        return engine && Number.isFinite(engine.exponent) ? engine.exponent : EXPONENT;
    }

    function normalize(state) {
        const source = state || {};
        const statSum = finite(
            source.statSum,
            finite(source.netAtk, 0) + finite(source.netDef, 0) + finite(source.netHp, 0)
        );

        return {
            count: Math.max(0, finite(source.count, 0)),
            tier: TIER_ORDER.includes(source.tier) ? source.tier : 'T8',
            type: TYPE_ORDER.includes(source.type) ? source.type : 'Infantry',
            den: clamp(Math.round(finite(source.den, 26)), 1, 45),
            netDmg: Math.max(0, finite(source.netDmg, 0)),
            statSum: Math.max(0, statSum),
            marchPower: Math.max(0, finite(source.marchPower, 0)),
            enemyPower: Math.max(0, finite(source.enemyPower, 0)),
            cAvg: finite(source.cAvg, finite(root.PNCEngine && root.PNCEngine.baselineC, 59.8861)),
            predKill: clamp(finite(source.predKill, 0), 0, 100)
        };
    }

    function predict(state, marchPower, enemyPower) {
        if (!(marchPower > 0) || !(enemyPower > 0)) return 0;
        return clamp(state.cAvg * Math.pow(marchPower / enemyPower, exponent()), 0, 100);
    }

    function formatPower(millions) {
        return `${millions.toFixed(2)}M`;
    }

    function formatCount(value) {
        return Math.round(value).toLocaleString('en-US');
    }

    function formatPoints(value) {
        return `${value.toFixed(1)} percentage points`;
    }

    function findDenSuggestion(state, target) {
        for (let level = state.den - 1; level >= 1; level--) {
            const power = denPower(level) / 1000000;
            const projected = predict(state, state.marchPower, power);
            if (projected >= target) {
                return {
                    key: 'den',
                    priority: 1,
                    tag: 'Easiest lever',
                    title: `Lower the Den to Level ${level}`,
                    detail: `Level ${state.den} has ${formatPower(state.enemyPower)} static power; Level ${level} has ${formatPower(power)}. Your current march projects ${projected.toFixed(1)}% there.`,
                    projected
                };
            }
        }
        return null;
    }

    function findTierSuggestion(state, target) {
        const current = tierMod(state.tier);
        if (!(current > 0)) return null;

        for (const tier of TIER_ORDER) {
            const mod = tierMod(tier);
            if (mod <= current + 1e-9) continue;

            const projected = predict(state, state.marchPower * (mod / current), state.enemyPower);
            if (projected >= target) {
                return {
                    key: 'tier',
                    priority: 2,
                    tag: 'Troop upgrade',
                    title: `Upgrade troops to ${tier}`,
                    detail: `${tier} raises the tier multiplier from ${current.toFixed(2)}x to ${mod.toFixed(2)}x. With the same count and stats, the model projects ${projected.toFixed(1)}%.`,
                    projected
                };
            }
        }
        return null;
    }

    function findTypeSuggestion(state, target) {
        const current = typeMod(state.type);
        if (!(current > 0)) return null;

        let best = null;
        for (const type of TYPE_ORDER) {
            if (type === state.type) continue;
            const mod = typeMod(type);
            if (mod <= current + 1e-9) continue;

            const projected = predict(state, state.marchPower * (mod / current), state.enemyPower);
            if (projected >= target && (!best || projected > best.projected)) {
                best = {
                    key: 'type',
                    priority: 6,
                    tag: 'Alternative type',
                    title: `Try ${type} with comparable stats`,
                    detail: `The ${type} multiplier is ${mod.toFixed(2)}x instead of ${current.toFixed(2)}x. This only applies if your ${type} stats match the current type; import that profile before trusting the projection.`,
                    projected
                };
            }
        }
        return best;
    }

    function findCountSuggestion(state, target, multiplier) {
        if (!(state.count > 0) || !(multiplier > 1) || !Number.isFinite(multiplier)) return null;

        const step = state.count >= 50000 ? 1000 : 100;
        const targetCount = ceilTo(state.count * multiplier, step);
        if (!(targetCount > state.count)) return null;
        // A march that has to more than double is not a practical suggestion.
        if (targetCount > state.count * 2.5) return null;

        const projected = predict(state, state.marchPower * (targetCount / state.count), state.enemyPower);
        const extra = targetCount - state.count;

        return {
            key: 'count',
            priority: 3,
            tag: 'March size',
            title: `Add ${formatCount(extra)} troops (${formatCount(targetCount)} total)`,
            detail: `March power scales with troop count, so ${(targetCount / state.count).toFixed(2)}x the current march projects ${projected.toFixed(1)}%. Confirm this fits your current march capacity.`,
            projected
        };
    }

    function findStatSuggestion(state, target, multiplier) {
        if (!(state.statSum > 0) || !(multiplier > 1) || !Number.isFinite(multiplier)) return null;

        const requiredSum = ceilTo(state.statSum * multiplier * multiplier, 0.1);
        const perStat = ceilTo((requiredSum - state.statSum) / 3, 0.1);
        if (!(perStat > 0)) return null;

        const achievedSum = state.statSum + perStat * 3;
        // Skip stat targets that would need more than a sixfold total increase.
        if (achievedSum > state.statSum * MAX_STAT_MULTIPLIER) return null;

        const longTerm = achievedSum > state.statSum * LONG_TERM_STAT_MULTIPLIER;
        const projected = predict(state, state.marchPower * Math.sqrt(achievedSum / state.statSum), state.enemyPower);

        return {
            key: 'stats',
            priority: 4,
            tag: longTerm ? 'Long-term stat growth' : 'Stat growth',
            title: `Add about +${perStat.toFixed(1)} pts to each troop stat`,
            detail: `Total ATK+DEF+HP needs to reach ${achievedSum.toFixed(1)} (currently ${state.statSum.toFixed(1)}). Spread evenly, that is roughly +${perStat.toFixed(1)} pts each in ATK, DEF, and HP.`,
            projected,
            longTerm
        };
    }

    function findDamageSuggestion(state, target, multiplier) {
        if (!(multiplier > 1) || !Number.isFinite(multiplier)) return null;

        const required = ceilTo(100 * (multiplier * (1 + state.netDmg / 100) - 1), 0.1);
        const gain = required - state.netDmg;
        if (!(gain > 0.05)) return null;
        // Damage Up is scarce; do not present a +100-point jump as a practical fix.
        if (gain > MAX_DAMAGE_GAIN) return null;

        const projected = predict(
            state,
            state.marchPower * ((1 + required / 100) / (1 + state.netDmg / 100)),
            state.enemyPower
        );

        return {
            key: 'damage',
            priority: 5,
            tag: 'Damage growth',
            title: `Raise total damage bonus to ${required.toFixed(1)}%`,
            detail: `Net damage is ${state.netDmg.toFixed(1)}% today. It multiplies the whole march score, so reaching ${required.toFixed(1)}% closes the gap on its own.`,
            projected
        };
    }

    function findBestDen(state, target) {
        let best = null;
        for (let level = 1; level <= 45; level++) {
            const projected = predict(state, state.marchPower, denPower(level) / 1000000);
            if (projected >= target) best = { level, projected };
        }
        return best;
    }

    function analyze(state, target) {
        const normalized = normalize(state);
        const targetValue = clamp(finite(target, DEFAULT_TARGET), 1, 100);
        const result = {
            target: targetValue,
            status: 'empty',
            state: normalized,
            multiplier: null,
            suggestions: [],
            bestDen: null
        };

        if (!(normalized.marchPower > 0) || !(normalized.predKill > 0)) {
            return result;
        }

        if (normalized.predKill >= targetValue) {
            result.status = 'pass';
            result.bestDen = findBestDen(normalized, targetValue);
            return result;
        }

        const multiplier = Math.pow(targetValue / normalized.predKill, 1 / exponent());
        result.status = 'fail';
        result.multiplier = multiplier;
        result.suggestions = [
            findDenSuggestion(normalized, targetValue),
            findTierSuggestion(normalized, targetValue),
            findCountSuggestion(normalized, targetValue, multiplier),
            findStatSuggestion(normalized, targetValue, multiplier),
            findDamageSuggestion(normalized, targetValue, multiplier),
            findTypeSuggestion(normalized, targetValue)
        ]
            .filter(Boolean)
            .sort((a, b) => a.priority - b.priority);
        result.hasGrowthSuggestion = result.suggestions.some(item => item.key === 'stats' || item.key === 'damage');

        return result;
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function emptyState(message) {
        return element('p', 'suggestion-empty', message);
    }

    function passPanel(analysis) {
        const state = analysis.state;
        const margin = state.predKill - analysis.target;
        const panel = element('div', 'suggestion-pass');
        panel.append(element('span', 'suggestion-pass-badge', 'Target met'));

        const copy = element('div');
        copy.append(element('h3', '', `${state.predKill.toFixed(1)}% predicted vs ${analysis.target}% target`));
        copy.append(element(
            'p',
            '',
            `${margin.toFixed(1)} points of headroom above the planning target (50% clear plus the model's 5% margin).`
        ));
        panel.append(copy);
        return panel;
    }

    function stretchPanel(analysis) {
        const best = analysis.bestDen;
        const state = analysis.state;
        const panel = element('div', 'suggestion-stretch');
        panel.append(element('span', 'suggestion-tag', 'Stretch goal'));

        if (!best) {
            panel.append(element('h3', '', 'No higher Den meets the target'));
            panel.append(element('p', '', 'Keep the current target or grow the march before pushing further.'));
            return panel;
        }

        if (best.level <= state.den) {
            panel.append(element('h3', '', `Level ${state.den} is the highest target that meets ${analysis.target}%`));
            panel.append(element('p', '', `Your current march projects ${state.predKill.toFixed(1)}% here. The next level would fall below the planning target.`));
            return panel;
        }

        panel.append(element('h3', '', `Level ${best.level} still projects ${best.projected.toFixed(1)}%`));
        panel.append(element(
            'p',
            '',
            `That is the highest Den level at or above the ${analysis.target}% target with the current march. Levels above it are projected to fall short.`
        ));
        return panel;
    }

    function suggestionCard(item) {
        const card = element('article', 'suggestion-item');
        const head = element('div', 'suggestion-item-head');
        head.append(element('span', 'suggestion-tag', item.tag));
        head.append(element('span', 'suggestion-score', `${item.projected.toFixed(1)}%`));
        card.append(head);
        card.append(element('h3', 'suggestion-title', item.title));
        card.append(element('p', 'suggestion-copy', item.detail));
        return card;
    }

    function render(card, intro, body, state, target) {
        const analysis = analyze(state, target);
        body.replaceChildren();
        card.hidden = false;
        card.classList.toggle('is-pass', analysis.status === 'pass');
        card.classList.toggle('is-fail', analysis.status !== 'pass');

        if (analysis.status === 'empty') {
            intro.textContent = 'Add a troop count and stats to generate an improvement plan.';
            body.append(emptyState('The model needs a positive troop count and stat total before it can suggest changes.'));
            return;
        }

        if (analysis.status === 'pass') {
            intro.textContent = `The current march is above the ${analysis.target}% planning target.`;
            body.append(passPanel(analysis));
            body.append(stretchPanel(analysis));
            return;
        }

        const gap = analysis.target - analysis.state.predKill;
        intro.textContent = `Predicting ${analysis.state.predKill.toFixed(1)}% — ${formatPoints(gap)} below the ${analysis.target}% planning target.`;

        if (!analysis.suggestions.length) {
            body.append(emptyState('The gap is too large for a single-lever change. Lower the Den several levels or grow stats over time.'));
            return;
        }

        const grid = element('div', 'suggestion-grid');
        analysis.suggestions.forEach(item => grid.append(suggestionCard(item)));
        body.append(grid);

        if (analysis.suggestions.some(item => item.longTerm)) {
            body.append(element('p', 'suggestions-note', 'Long-term targets are shown for direction, not as quick single-step upgrades.'));
        } else if (!analysis.hasGrowthSuggestion) {
            body.append(element('p', 'suggestions-note', 'No practical single-step stat or damage increase is listed for this gap.'));
        }
    }

    function mount() {
        if (typeof document === 'undefined') return;
        const card = document.getElementById('suggestionsCard');
        const intro = document.getElementById('suggestionsIntro');
        const body = document.getElementById('suggestionsBody');
        if (!card || !intro || !body) return;

        const target = clamp(parseFloat(card.dataset.target) || DEFAULT_TARGET, 1, 100);
        document.addEventListener('pnc:calculation', event => {
            if (!event || !event.detail) return;
            render(card, intro, body, event.detail, target);
        });
    }

    root.PNCSuggestions = {
        DEFAULT_TARGET,
        analyze,
        mount
    };

    if (typeof document !== 'undefined') {
        if (document.getElementById('suggestionsCard')) {
            mount();
        } else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mount, { once: true });
        }
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
