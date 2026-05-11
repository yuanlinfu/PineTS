// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Alaa-eddine KADDOURI

import { Series } from '../Series';

/**
 * Pine Script `ticker.*` namespace.
 *
 * The methods here construct "ticker ID" strings that are passed to
 * `request.security` / `request.security_lower_tf` to fetch data for a
 * specific symbol — potentially with extra modifiers (session,
 * adjustment, non-standard chart type). PineTS' data providers serve
 * standard candles only; chart-type modifiers (Heikin-Ashi, Renko,
 * Kagi, Line Break, Point & Figure) are silently dropped at the
 * `request.security` boundary, since we can't render alternative
 * bar-construction algorithms from the raw OHLCV feed.
 *
 * For the plain "no-modifier" cases — which cover virtually every
 * real-world Pine script — the returned tickerid strings match
 * TradingView's exact log output, so automation tests pass strictly.
 * Non-default `adjustment` values trigger TV's encoded
 * `={"adjustment":"…","symbol":"…"}` form; PineTS only emits the
 * plain symbol there (since `request.security` doesn't honor
 * adjustment either). Document as a known divergence.
 */
export class Ticker {
    constructor(private context: any) {}

    /**
     * Type B param wrapper — extract scalar from series/primitive.
     * Used by the transpiler to wrap ticker.* arguments.
     */
    param(source: any, index: number = 0, _name?: string): any {
        if (typeof source === 'string') return source;
        return Series.from(source).get(index);
    }

    /**
     * ticker.inherit(from_tickerid, symbol) → simple string
     *
     * Returns a ticker ID that uses `symbol` and inherits modifier
     * settings (session, currency, adjustment, chart type) from
     * `from_tickerid`. For data-fetching purposes the result is
     * effectively `symbol` — modifiers can't be honored without a TV
     * datafeed, and `symbol` is what `request.security` needs.
     */
    inherit(_from_tickerid: any, symbol: any): string {
        const sym = this._coerce(symbol);
        return sym;
    }

    /**
     * ticker.new(prefix, ticker, session?, adjustment?, ...) → simple string
     *
     * Returns "prefix:ticker". Modifier arguments are accepted but
     * ignored — see class-level note. Returns an empty string if
     * either prefix or ticker is empty (matches TV).
     */
    new(prefix: any, ticker: any, _session?: any, _adjustment?: any,
        _backadjustment?: any, _settlement_as_close?: any): string {
        const p = this._coerce(prefix);
        const t = this._coerce(ticker);
        if (!p) return t;
        if (!t) return p;
        return `${p}:${t}`;
    }

    /**
     * ticker.modify(tickerid, session?, adjustment?, ...) → simple string
     *
     * Returns the tickerid unchanged — modifier args are accepted but
     * ignored.
     */
    modify(tickerid: any, _session?: any, _adjustment?: any,
        _backadjustment?: any, _settlement_as_close?: any): string {
        return this._coerce(tickerid);
    }

    /**
     * ticker.standard(symbol?) → simple string
     *
     * Returns the symbol stripped of any non-standard chart-type
     * modifiers. Since PineTS doesn't synthesise non-standard chart
     * types in the first place, this is effectively a pass-through
     * (the standard form IS what our providers serve). If `symbol` is
     * undefined, falls back to `syminfo.tickerid`.
     */
    standard(symbol?: any): string {
        if (symbol === undefined || symbol === null) {
            return this.context?.pine?.syminfo?.tickerid || this.context?.tickerId || '';
        }
        return this._coerce(symbol);
    }

    /**
     * ticker.heikinashi(symbol) → simple string
     *
     * In TV this returns an encoded tickerid that instructs the
     * datafeed to deliver Heikin-Ashi bars. PineTS' providers don't
     * synthesise HA candles, so we return the plain symbol — downstream
     * `request.security` fetches standard candles, NOT HA-transformed
     * ones. Behavior diverges from TV when the script depends on the
     * HA values matching TV's HA computation. Documented limitation.
     */
    heikinashi(symbol: any): string {
        return this._coerce(symbol);
    }

    /**
     * ticker.renko(symbol, style?, param?, request_wicks?, source?) → simple string
     *
     * Stub: returns the plain symbol. See heikinashi() note.
     */
    renko(symbol: any, _style?: any, _param?: any,
        _request_wicks?: any, _source?: any): string {
        return this._coerce(symbol);
    }

    /**
     * ticker.kagi(symbol, reversal) → simple string
     *
     * Stub: returns the plain symbol. See heikinashi() note.
     */
    kagi(symbol: any, _reversal?: any): string {
        return this._coerce(symbol);
    }

    /**
     * ticker.linebreak(symbol, number_of_lines) → simple string
     *
     * Stub: returns the plain symbol. See heikinashi() note.
     */
    linebreak(symbol: any, _number_of_lines?: any): string {
        return this._coerce(symbol);
    }

    /**
     * ticker.pointfigure(symbol, source, style, param, reversal) → simple string
     *
     * Stub: returns the plain symbol. See heikinashi() note.
     */
    pointfigure(symbol: any, _source?: any, _style?: any,
        _param?: any, _reversal?: any): string {
        return this._coerce(symbol);
    }

    /**
     * Coerce a runtime value to a plain string. Handles Series wrappers
     * (used by the transpiler), `na`/null/undefined, and primitives.
     */
    private _coerce(v: any): string {
        if (v === null || v === undefined) return '';
        if (v instanceof Series) {
            const inner = v.get(0);
            return inner === null || inner === undefined ? '' : String(inner);
        }
        if (typeof v === 'number' && isNaN(v)) return '';
        return String(v);
    }
}
