---
layout: default
title: Ticker
parent: API Coverage
---

## Ticker

### Ticker Functions

| Function               | Status | Description                  |
| ---------------------- | ------ | ---------------------------- |
| `ticker.heikinashi()`  | ✅     | Create Heikin Ashi ticker    |
| `ticker.inherit()`     | ✅     | Inherit ticker               |
| `ticker.kagi()`        | ✅     | Create Kagi ticker           |
| `ticker.linebreak()`   | ✅     | Create Line Break ticker     |
| `ticker.modify()`      | ✅     | Modify ticker                |
| `ticker.new()`         | ✅     | Create new ticker            |
| `ticker.pointfigure()` | ✅     | Create Point & Figure ticker |
| `ticker.renko()`       | ✅     | Create Renko ticker          |
| `ticker.standard()`    | ✅     | Create standard ticker       |

### Notes

- **`inherit`, `new`, `modify`, `standard`** — return ticker-ID strings that match TradingView's output exactly for the common "no extra modifiers" case (the dominant real-world usage). When non-default `adjustment` / `backadjustment` / `settlement_as_close` values are passed, TV emits an encoded `={"adjustment":"…","symbol":"…"}` form; PineTS returns the plain `prefix:ticker` since the underlying providers don't honour those modifiers anyway. Documented in [`src/namespaces/Ticker.ts`](../../src/namespaces/Ticker.ts).
- **`heikinashi`, `renko`, `kagi`, `linebreak`, `pointfigure`** — accepted and chainable into `request.security` / `request.security_lower_tf` without errors, but they return the plain symbol rather than TV's encoded "alternative chart type" ticker ID. PineTS' data providers serve standard OHLCV candles only — non-standard bar-construction algorithms aren't synthesised, so requests resolve to standard data regardless of which `ticker.*` helper constructed the ID. Use `chart.is_*` to detect this and branch in scripts that depend on actual HA/Renko bars.
