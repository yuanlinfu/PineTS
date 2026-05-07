// SPDX-License-Identifier: AGPL-3.0-only

import { PineTS } from '../../../PineTS.class';
import { Series } from '../../../Series';
import { TIMEFRAMES, normalizeTimeframe } from '../utils/TIMEFRAMES';
import { PineArrayObject, PineArrayType } from '../../array/PineArrayObject';
import { parseArgsForPineParams } from '../../utils';

// Pine signature (v5/v6):
//   request.security_lower_tf(symbol, timeframe, expression, ignore_invalid_symbol, currency, ignore_invalid_timeframe, calc_bars_count)
// Note: no `gaps`/`lookahead` for security_lower_tf — different surface than security.
const SECURITY_LOWER_TF_SIGNATURES = [
    ['symbol', 'timeframe', 'expression'],
    ['symbol', 'timeframe', 'expression', 'ignore_invalid_symbol'],
    ['symbol', 'timeframe', 'expression', 'ignore_invalid_symbol', 'currency'],
    ['symbol', 'timeframe', 'expression', 'ignore_invalid_symbol', 'currency', 'ignore_invalid_timeframe'],
    ['symbol', 'timeframe', 'expression', 'ignore_invalid_symbol', 'currency', 'ignore_invalid_timeframe', 'calc_bars_count'],
];
const SECURITY_LOWER_TF_TYPES = {
    symbol: 'series',
    timeframe: 'series',
    expression: 'any',
    ignore_invalid_symbol: 'series',
    currency: 'series',
    ignore_invalid_timeframe: 'series',
    calc_bars_count: 'series',
};

function isParamTuple(v: any): v is [any, string] {
    return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';
}

function unwrapParamTuples(rawArgs: any[], outNames: (string | undefined)[]): any[] {
    return rawArgs.map((a) => {
        if (isParamTuple(a)) {
            outNames.push(a[1]);
            return a[0];
        }
        outNames.push(undefined);
        return a;
    });
}

function resolveSlotValue(v: any): any {
    return isParamTuple(v) ? v[0] : v;
}

function resolveSlotName(
    slotName: string,
    signatures: string[][],
    argNames: (string | undefined)[],
    parsedSlot: any,
): string | undefined {
    const fullSig = signatures[signatures.length - 1];
    const idx = fullSig.indexOf(slotName);
    if (idx >= 0 && idx < argNames.length && argNames[idx] !== undefined) {
        return argNames[idx];
    }
    if (isParamTuple(parsedSlot)) return parsedSlot[1];
    return undefined;
}

/**
 * Detect the PineArrayType from a runtime value.
 */
function detectArrayType(value: any): PineArrayType {
    if (typeof value === 'number') return PineArrayType.float;
    if (typeof value === 'boolean') return PineArrayType.bool;
    if (typeof value === 'string') return PineArrayType.string;
    return PineArrayType.any;
}

/**
 * Requests the results of an expression from a specified symbol on a timeframe lower than or equal to the chart's timeframe.
 * It returns an array containing one element for each lower-timeframe bar within the chart bar.
 * On a 5-minute chart, requesting data using a timeframe argument of "1" typically returns an array with five elements representing
 * the value of the expression on each 1-minute bar, ordered by time with the earliest value first.
 * @param context
 * @returns
 */
export function security_lower_tf(context: any) {
    return async (...rawArgs: any[]) => {
        // Same Pine named-args resolution as request.security — bind by name to the
        // documented signature, with the trailing options bag merged into named slots.
        const argNames: (string | undefined)[] = [];
        const args = unwrapParamTuples(rawArgs, argNames);
        const parsed = parseArgsForPineParams<any>(args, SECURITY_LOWER_TF_SIGNATURES, SECURITY_LOWER_TF_TYPES);

        const symbolSlot = resolveSlotValue(parsed.symbol);
        const timeframeSlot = resolveSlotValue(parsed.timeframe);
        const expressionSlot = resolveSlotValue(parsed.expression);

        const rawSymbol = symbolSlot instanceof Series ? symbolSlot.get(0) : symbolSlot;
        // Empty string "" means "use chart's symbol" (Pine Script spec)
        const resolvedSymbol = rawSymbol === '' ? context.tickerId : rawSymbol;
        const _symbol = typeof resolvedSymbol === 'string' && resolvedSymbol.includes(':') ? resolvedSymbol.split(':')[1] : resolvedSymbol;
        const rawTimeframe = timeframeSlot instanceof Series ? timeframeSlot.get(0) : timeframeSlot;
        // Empty string "" means "use chart's timeframe" (Pine Script spec)
        const _timeframe = rawTimeframe === '' ? context.timeframe : (typeof rawTimeframe === 'string' ? rawTimeframe : String(rawTimeframe ?? ''));
        const _expression = expressionSlot;
        const _expression_name = resolveSlotName('expression', SECURITY_LOWER_TF_SIGNATURES, argNames, parsed.expression);
        const _ignore_invalid_symbol = resolveSlotValue(parsed.ignore_invalid_symbol);
        const _ignore_invalid_timeframe = resolveSlotValue(parsed.ignore_invalid_timeframe);
        const _calc_bars_count = (() => {
            const v = resolveSlotValue(parsed.calc_bars_count);
            return typeof v === 'number' && v > 0 ? v : undefined;
        })();

        // CRITICAL: Prevent infinite recursion in secondary contexts
        // Still wrap in PineArrayObject so array.size() etc. work in the secondary script
        if (context.isSecondaryContext) {
            if (Array.isArray(_expression)) {
                const arrays = _expression.map((v: any) =>
                    new PineArrayObject([v], detectArrayType(v), context)
                );
                return [arrays];
            } else {
                return new PineArrayObject([_expression], detectArrayType(_expression), context);
            }
        }

        const ctxTimeframeIdx = TIMEFRAMES.indexOf(normalizeTimeframe(context.timeframe));
        const reqTimeframeIdx = TIMEFRAMES.indexOf(normalizeTimeframe(_timeframe));

        if (ctxTimeframeIdx === -1 || reqTimeframeIdx === -1) {
            if (_ignore_invalid_timeframe) return NaN;
            throw new Error('Invalid timeframe');
        }

        if (reqTimeframeIdx > ctxTimeframeIdx) {
            if (_ignore_invalid_timeframe) return NaN;
            throw new Error(`Timeframe ${_timeframe} is not lower than or equal to chart timeframe ${context.timeframe}`);
        }

        if (reqTimeframeIdx === ctxTimeframeIdx) {
            if (Array.isArray(_expression)) {
                // Tuple: each element becomes a 1-element PineArrayObject
                const arrays = _expression.map((v: any) =>
                    new PineArrayObject([v], detectArrayType(v), context)
                );
                return [arrays]; // 2D for tuple destructuring
            } else {
                return new PineArrayObject([_expression], detectArrayType(_expression), context);
            }
        }

        const cacheKey = `${_symbol}_${_timeframe}_${_expression_name}_lower`;

        if (!context.cache[cacheKey]) {
            // For request.security_lower_tf the secondary's data window is
            // bounded by the chart's own window — every LTF bar that
            // contributes to a chart bar falls inside that chart bar's
            // [openTime, closeTime]. Adding a fixed historical buffer (the
            // way security.ts does for higher-timeframe warmup) blows up
            // bar counts dramatically: a 30-day buffer at 1-minute LTF
            // forces the secondary to iterate ~43,200 extra bars before
            // the main loop can advance past bar 0, which manifests as a
            // multi-minute hang on small charts (e.g. 50 bars on 5m). Use
            // the chart's earliest openTime directly.
            const effectiveSDate = context.sDate
                || (context.marketData?.length > 0 ? context.marketData[0].openTime : undefined);
            const adjustedSDate = effectiveSDate;

            // Align secondary's end date with the chart's actual data so that
            // `barstate.islast` in the secondary fires at the same temporal point as
            // the chart's `barstate.islast`. See security.ts for full rationale.
            const lastBarCloseTime = context.marketData?.length > 0
                ? context.marketData[context.marketData.length - 1].closeTime
                : 0;
            const secEDate = lastBarCloseTime || context.eDate || Date.now();

            const pineTS = new PineTS(context.source, _symbol, _timeframe, _calc_bars_count, adjustedSDate, secEDate);
            pineTS.markAsSecondary();

            const secContext = await pineTS.run(context.pineTSCode);
            context.cache[cacheKey] = { pineTS, context: secContext, dataVersion: context.dataVersion };
        }

        const cached = context.cache[cacheKey];

        // Refresh secondary context when main context's data has changed (streaming mode)
        if (context.dataVersion > cached.dataVersion) {
            await cached.pineTS.updateTail(cached.context);
            cached.dataVersion = context.dataVersion;
        }

        const secContext = cached.context;
        
        const myOpenTime = Series.from(context.data.openTime).get(0);
        const myCloseTime = Series.from(context.data.closeTime).get(0);

        const secOpenTimes = secContext.data.openTime.data;
        const secCloseTimes = secContext.data.closeTime.data;
        const secValues = secContext.params[_expression_name];
        
        // If expression was not evaluated in secondary context (e.g. conditional execution), return empty array
        if (!secValues) {
            if (Array.isArray(_expression)) {
                const arrays = _expression.map(() =>
                    new PineArrayObject([], PineArrayType.float, context)
                );
                return [arrays];
            }
            return new PineArrayObject([], PineArrayType.float, context);
        }

        const result: any[] = [];

        for (let i = 0; i < secOpenTimes.length; i++) {
            const sOpen = secOpenTimes[i];
            const sClose = secCloseTimes[i];

            // Optimization: skip bars before our window
            if (sClose <= myOpenTime) continue;

            // Stop if we passed our window
            if (sOpen >= myCloseTime) break;

            // Overlap check: The LTF bar must overlap with the HTF bar interval [myOpenTime, myCloseTime)
            // Pine Script security_lower_tf returns all LTF bars that "belong" to the HTF bar.
            // This typically means any LTF bar whose time is >= HTF openTime and < HTF closeTime.

            // If sOpen >= myOpenTime and sOpen < myCloseTime, it belongs to this bar.
            if (sOpen >= myOpenTime && sOpen < myCloseTime) {
                result.push(secValues[i]);
            }
        }

        // Detect if expression is a tuple (each bar value is an array)
        const isTuple = result.length > 0 && Array.isArray(result[0]);

        if (isTuple) {
            // Transpose: per-bar tuples [[o1,c1],[o2,c2],...] → per-element arrays [PAO([o1,o2,...]), PAO([c1,c2,...])]
            const numElements = result[0].length;
            const transposed = [];
            for (let e = 0; e < numElements; e++) {
                const columnValues = result.map(barTuple => barTuple[e]);
                const type = columnValues.length > 0 ? detectArrayType(columnValues[0]) : PineArrayType.float;
                transposed.push(new PineArrayObject(columnValues, type, context));
            }
            return [transposed]; // 2D for tuple destructuring
        } else {
            // Scalar: single array of values wrapped in PineArrayObject
            const type = result.length > 0 ? detectArrayType(result[0]) : PineArrayType.float;
            return new PineArrayObject(result, type, context);
        }
    };
}
