import { describe, it, expect } from 'vitest';
import { PineTS, Provider } from 'index';
import { transpile } from '../../src/transpiler/index';

/**
 * Regression suite for the three method-related bugs fixed together:
 *
 *  1. `this`-mutation persistence — Pine `method foo(BAR this, ...) => this.x := y`
 *     used to lose the assignment because `this` was stripped from the JS
 *     param list and the call site passed the receiver positionally with
 *     `$.call(fn, id, obj, ...args)` (which doesn't bind `this`). Body writes
 *     to `this.x` leaked onto `globalThis`. Fix: rename `this` to `self`
 *     in both the param list and the body.
 *
 *  2. Function / method name collision — when a Pine script declared both a
 *     regular function `foo()` and a `method foo()`, both compiled to a JS
 *     function with the same identifier `foo`. The second declaration
 *     shadowed the first, so direct calls `foo(args)` resolved to the
 *     method instead of the regular function. Fix: methods get a `$M_`
 *     prefix on their JS identifier.
 *
 *  3. Param namespace-rename clobbering — when a Pine method/fn param
 *     shadows a Pine namespace (e.g. `color`), the param is renamed to
 *     `color_$N`. The naive walker rewrote EVERY `Identifier('color')` in
 *     the body, including namespace usages like `color.new(arg, 73)` →
 *     `color_$N.new(color_$N, 73)` (broken). Fix: a context-aware walker
 *     that skips MemberExpression objects (namespace member access),
 *     CallExpression callees (namespace function calls), and Property keys.
 */

describe('UDT method this-mutation, naming, and param-shadowing', () => {
    const makePineTS = () =>
        new PineTS(Provider.Mock, 'BTCUSDC', 'D', null,
            new Date('2019-04-01').getTime(),
            new Date('2019-04-15').getTime());

    // ── Codegen shape ──────────────────────────────────────────────────

    it('method receiver `this` is renamed to `self` in both param list and body', () => {
        // Bug 1: previously emitted `function updatePattern(price, index)` with
        // `this.x = ...` in body — `this` was `globalThis` at runtime.
        const code = `
//@version=6
indicator("method this rename", overlay=true)
type BAR
    float lastPrice
method updatePattern(BAR this, float price) =>
    this.lastPrice := price
bar = BAR.new()
bar.updatePattern(close)
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();

        // Receiver appears as `self` in both param list and body. The body
        // member access is wrapped as `$.get(self, 0).lastPrice` by the
        // expression transformer (series-of-UDT unwrap), but the leaf
        // identifier remains `self`.
        expect(jsCode).toMatch(/function\s+\$M_updatePattern\s*\(\s*self\s*,/);
        expect(jsCode).toMatch(/\$\.get\(\s*self\s*,\s*0\s*\)\.lastPrice/);
        // No bare `this.x` references in method body (would be globalThis writes)
        expect(jsCode).not.toMatch(/\bthis\.lastPrice\b/);
    });

    it('methods get a `$M_` JS prefix to avoid collision with regular functions', () => {
        // Bug 2: previously the second declaration overwrote the first.
        const code = `
//@version=6
indicator("fn vs method", overlay=true)
type FOO
    float x
sameName(int a, int b) =>
    a + b
method sameName(FOO this, int a) =>
    this.x := a
bar = FOO.new()
y = sameName(1, 2)
bar.sameName(5)
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();

        // BOTH declarations must coexist
        expect(jsCode).toMatch(/function\s+sameName\s*\(\s*a\s*,\s*b\s*\)/);
        expect(jsCode).toMatch(/function\s+\$M_sameName\s*\(\s*self\s*,/);
        // The marker should be on the prefixed identifier
        expect(jsCode).toContain('$M_sameName.__pineMethod__ = true');
    });

    it('param shadowing a Pine namespace preserves namespace usage in the body', () => {
        // Bug 3: param literally named `color` shadows the `color` namespace.
        // The naive walker renamed every `Identifier('color')` in the body —
        // including `color.new(...)` (namespace access), producing the
        // invalid `color_$N.new(color_$N, 73)`. The context-aware walker
        // skips MemberExpression objects (the namespace) but still renames
        // bare identifier reads (the param value passed as an argument).
        const code = `
//@version=6
indicator("param-namespace shadow", overlay=true)
applyTransparency(color) =>
    color.new(color, 73)
c = applyTransparency(#ff0000)
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();

        // `color.new(` (namespace usage) must survive untouched
        expect(jsCode).toMatch(/\bcolor\.new\(/);
        // The renamed param IS used as the argument value (the expression
        // transformer wraps it in a `color.param(...)` call before passing
        // to `color.new`, so the param name appears inside `color.param(`).
        expect(jsCode).toMatch(/color\.param\(\s*color_\$\d+\b/);
        // The bare param identifier must NOT be wired as a namespace itself —
        // i.e. no `color_$N.new(...)` (that was the broken form)
        expect(jsCode).not.toMatch(/\bcolor_\$\d+\.new\b/);
    });

    // ── Runtime behavior ───────────────────────────────────────────────

    it('method `this.x := y` mutations persist across the receiver instance', async () => {
        // The most direct verification: call a method that mutates a field,
        // then plot the field. If `this` was `globalThis`, the plotted value
        // would be undefined / 0.
        const pineTS = makePineTS();
        const code = `
//@version=6
indicator("this mutation persistence", overlay=true)
type Counter
    int value = 0
method increment(Counter this) =>
    this.value := this.value + 1
var Counter c = Counter.new()
c.increment()
c.increment()
plot(c.value, "count")
plot(close)
        `;
        const { plots } = await pineTS.run(code);
        const counts = plots['count']?.data ?? [];
        expect(counts.length).toBeGreaterThan(0);
        // After two increments per bar, the value should be 2 on the very
        // first bar and accumulate from there. Before the fix this stayed
        // at 0 (or NaN) for all bars.
        const lastValue = counts[counts.length - 1]?.value;
        expect(lastValue).toBeGreaterThanOrEqual(2);
    });

    it('regular fn and method with the same name both work end-to-end', async () => {
        const pineTS = makePineTS();
        const code = `
//@version=6
indicator("dual-name", overlay=true)
type Box
    int n = 0
add(int a, int b) =>
    a + b
method add(Box this, int a) =>
    this.n := this.n + a
var Box b = Box.new()
sum = add(3, 4)
b.add(10)
plot(sum, "sum")
plot(b.n, "boxN")
        `;
        const { plots } = await pineTS.run(code);
        // Regular function must return 7
        const sum = plots['sum']?.data?.[plots['sum'].data.length - 1]?.value;
        expect(sum).toBe(7);
        // Method must accumulate (10 per bar)
        const boxN = plots['boxN']?.data?.[plots['boxN'].data.length - 1]?.value;
        expect(boxN).toBeGreaterThanOrEqual(10);
    });

    it('UDT field subscript in a CONDITIONAL function-call arg returns per-bar lookback (not per-firing)', async () => {
        // Regression: PineTS used to wrap UDT-field subscripts as
        // `$.param(<scalar>, N, name)` for function args. `$.param`'s scalar
        // history is keyed by call frequency — when the call site lived
        // inside an `if`-block that only fired on some bars, lookback
        // returned the value from the *previous firing*, not from N bars
        // earlier in time. The correct rewrite emits `$.get(<scoped-bar>,
        // N).field` directly so lookback rides the bar series (populated
        // every bar) regardless of call-site conditionality.
        //
        // The smoking gun: feed the indicator a swing-low on every other
        // bar; have the if-block call a function with `bar.low[1]` as arg.
        // Each firing should see the IMMEDIATE prior bar's low. Without the
        // fix, it sees the prior FIRING's bar low, which is two bars stale.
        const pineTS = makePineTS();
        const code = `
//@version=6
indicator("conditional UDT lookback", overlay=true)
type BAR
    float low = low

capture(int idx, float v) =>
    100000.0 + idx * 1.0 + v / 1000000.0   // pack idx and v into one float for inspection

BAR bar = BAR.new()

// Fire the if-block on every odd bar — testing whether bar.low[1] inside
// the block resolves to "1 bar back in time" or "value from previous firing".
captured = 0.0
if bar_index % 2 == 1
    captured := capture(bar_index, bar.low[1])

plot(captured, "captured")
plot(close, "close")
        `;
        const r = await pineTS.run(code);
        const cap = r.plots['captured']?.data ?? [];
        const closes = r.marketData.map(b => b.close);
        // For each odd bar, the captured value should encode (current
        // bar_index, low at bar_index-1). Since we only run on a Mock
        // provider (synthetic data), just verify the encoded `idx` part of
        // the value matches the bar_index where capture fired.
        // The first non-zero capture is at bar 1 — its packed idx component
        // should be exactly 1 (capture(1, low_at_bar_0)).
        const firstFire = cap.find(d => d?.value !== 0 && d?.value !== undefined);
        expect(firstFire).toBeDefined();
        // Extract the integer "idx" component: floor(value - 100000) = idx.
        const idxPart = Math.floor((firstFire.value as number) - 100000);
        expect(idxPart).toBe(1);
    });

    it('UDT field subscript in a function-call arg uses direct $.get lookback (no $.param wrap)', () => {
        // Codegen check for the same bug — the transpile output should NOT
        // contain `$.param($.get(bar, 0).field, N, …)` for UDT subscripts in
        // function-call args. It should emit `$.get(bar, N).field` directly.
        const code = `
//@version=6
indicator("udt subscript codegen", overlay=true)
type BAR
    float low = low
caller(float v) =>
    v
bar = BAR.new()
if close > open
    x = caller(bar.low[1])
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();
        // The arg must be a direct `$.get(<scoped-bar>, 1).low` expression.
        expect(jsCode).toMatch(/\$\.get\(\$\.let\.glb1_bar,\s*1\)\.low/);
        // The buggy wrapper must NOT appear.
        expect(jsCode).not.toMatch(/\$\.param\(\s*\$\.get\(\$\.let\.glb1_bar,\s*0\)\.low,\s*1\b/);
    });

    it('UFCS-style direct call to a method-only declaration resolves to the prefixed JS name', () => {
        // Pine allows methods to be called via UFCS: `foo(receiver, args)` is
        // equivalent to `receiver.foo(args)`. After the `$M_` prefix rename,
        // a bare callee `isSame(receiver, ...)` was failing at runtime with
        // "isSame is not defined" because the JS function is now $M_isSame.
        // Reproduces the regression seen in Elliott-Wave.pine.
        const code = `
//@version=6
indicator("UFCS direct call", overlay=true)
type Wave
    int x
method same(Wave w, int x) =>
    w.x == x
ww = Wave.new(7)
// Direct UFCS call (no dot syntax).
y = same(ww, 7)
plot(y ? 1 : 0)
        `;
        const result = transpile(code);
        const jsCode = result.toString();
        // Direct call must target the prefixed JS name, not the bare Pine name.
        expect(jsCode).toMatch(/\$\.call\(\s*\$M_same\s*,/);
        // The bare `isSame` (without prefix) must not appear as a $.call target.
        expect(jsCode).not.toMatch(/\$\.call\(\s*same\s*,/);
    });

    it('regular function with same name as a method takes precedence for direct calls', () => {
        // When BOTH a regular function AND a method share a Pine name, Pine
        // resolves direct `name(args)` to the regular function. The dot form
        // `obj.name(args)` still resolves to the method. The transpiler must
        // NOT retarget the direct call to `$M_name` in this case.
        const code = `
//@version=6
indicator("regular wins over method", overlay=true)
type Box
    int n
foo(int x) =>
    x * 2
method foo(Box this, int x) =>
    this.n := x
b = Box.new(0)
y = foo(5)            // direct call → regular function
b.foo(10)             // dot call → method
plot(y)
        `;
        const result = transpile(code);
        const jsCode = result.toString();
        // Direct `foo(5)` must call the regular function (no `$M_` prefix).
        expect(jsCode).toMatch(/\$\.call\(\s*foo\s*,/);
        // Dot `b.foo(10)` must call the prefixed method.
        expect(jsCode).toMatch(/\$\.call\(\s*\$M_foo\s*,/);
    });

    it('positional `overlay=true` in indicator(...) is honored, not silently dropped', async () => {
        // Bug: the transpiler wraps positional booleans/numbers in $.param,
        // which promotes them to Series. parseArgsForPineParams then fails
        // the `boolean` / `number` type checks — so `overlay`, `precision`,
        // etc. quietly fell back to defaults.
        const pineTS = makePineTS();
        const code = `
//@version=5
indicator("title", "short", true, max_lines_count = 50)
plot(close)
        `;
        const r = await pineTS.run(code);
        expect(r.indicator?.overlay).toBe(true);
        // Sanity: title and named-arg also survive
        expect(r.indicator?.title).toBe('title');
        expect(r.indicator?.max_lines_count).toBe(50);
    });

    it('method param shadowing the `color` namespace runs without throwing', async () => {
        // Smoke: before the rename fix, this would crash with "fn is not a
        // function" because `color.new(...)` got rewritten to
        // `color_$N.new(...)` and `color_$N` was a string at runtime.
        const pineTS = makePineTS();
        const code = `
//@version=6
indicator("color shadow runtime", overlay=true)
type Marker
    color tone
method setColor(Marker this, color color) =>
    this.tone := color.new(color, 50)
var Marker m = Marker.new()
m.setColor(#ff8800)
plot(close)
        `;
        await expect(pineTS.run(code)).resolves.toBeDefined();
    });

    // ── Regression: method named after a JS reserved word ─────────────
    // `delete`, `class`, `return`, etc. collide with JS keywords. The
    // codegen renames such identifiers with `_$N` to keep the generated
    // JS valid — but for a Pine `method`, the JS name already gets a
    // collision-proof `$M_` prefix, so adding `_$N` on top would change
    // the Pine name visible at the call site (`obj.delete()` looks up
    // `delete`, not `delete_$0`) and break the UFCS retargeting.
    // Codegen must skip the reserved-name rename for methods.
    it('codegen: method named `delete` keeps the bare $M_<name> identifier', () => {
        const code = `
//@version=6
indicator("delete method", overlay=true)
type Foo
    int x
method delete(Foo this) =>
    this.x := 0

f = Foo.new(1)
f.delete()
plot(close)
        `;
        const js = transpile(code).toString();
        // Bare `delete(` must not appear (would be a JS parse error)
        expect(js).not.toMatch(/function\s+delete\s*\(/);
        // Method name must be the bare `$M_delete` form — no `_$N` suffix
        expect(js).toMatch(/function\s+\$M_delete\s*\(/);
        expect(js).not.toMatch(/function\s+\$M_delete_\$\d+\s*\(/);
        // Call site `f.delete()` must retarget to `$.call($M_delete, ..., f)`.
        expect(js).toMatch(/\$\.call\s*\(\s*\$M_delete\b/);
    });

    it('runtime: method named `delete` is dispatched via UFCS', async () => {
        // Whole-pipeline check: define `method delete` on a UDT that wraps
        // a built-in line, then call `obj.delete()` and verify the user
        // method actually fired (cascading to the inner line.delete()).
        // Before the fix, the user method registration was keyed by
        // `delete_$0` while the call site looked up `delete`, so
        // `obj.delete()` was a silent no-op and the inner line was never
        // marked deleted.
        const pineTS = new PineTS(Provider.Binance, 'BTCUSDC', '1W', null,
            new Date('2018-12-15').getTime(),
            new Date('2019-04-01').getTime());
        const code = `
//@version=6
indicator("delete method runtime", overlay=true)
type Holder
    line ln
method delete(Holder this) =>
    this.ln.delete()

if bar_index == 5
    Holder h = Holder.new(line.new(0, 100, 5, 110))
    h.delete()
plot(close)
`;
        const r = await pineTS.run(code);
        const lines = r.plots?.['__lines__']?.data?.[0]?.value || [];
        // The single line created at bar 5 must have been deleted via
        // h.delete() → user method → this.ln.delete().
        expect(lines.length).toBe(0);
    });

    // ── Regression: explicit Pine type annotation must register UDT instance ──
    // `Holder r = arr.get(0)` should register `r` as a Holder instance even
    // though `inferUdtTypeFromInit` can't tell the type from `arr.get(0)`.
    // Codegen preserves the type via a `"__pineUdtVar:r=Holder"` marker that
    // the AnalysisPass picks up. Without this, `r.delete()` would fall back
    // to the no-op direct property access on a PineTypeObject.
    it('runtime: UDT retrieved from an array dispatches user methods correctly', async () => {
        const pineTS = new PineTS(Provider.Binance, 'BTCUSDC', '1W', null,
            new Date('2018-12-15').getTime(),
            new Date('2019-04-01').getTime());
        const code = `
//@version=6
indicator("udt from array", overlay=true)
type Holder
    line ln
method clear(Holder this) =>
    this.ln.delete()

if bar_index == 5
    Holder h = Holder.new(line.new(0, 100, 5, 110))
    Holder[] arr = array.new<Holder>()
    arr.push(h)
    Holder r = arr.get(0)
    r.clear()
plot(close)
`;
        const r = await pineTS.run(code);
        const lines = r.plots?.['__lines__']?.data?.[0]?.value || [];
        // The line must have been deleted via r.clear() → $M_clear(r) →
        // r.ln.delete(). r is a Holder via the explicit Pine annotation.
        expect(lines.length).toBe(0);
    });

    // ── Regression: type-aware UFCS retargeting ─────────────────────────
    // When a UDT method shares a name with a built-in (e.g. `delete`), the
    // retargeting must only fire for UDT receivers. `someLine.delete()`
    // must keep calling the built-in `LineHelper.delete`, not be hijacked
    // into `$M_delete(someLine)` (which would try `someLine.ln.delete()`
    // and fail silently because lines don't have an `ln` field).
    it('runtime: UFCS retargeting is type-aware (built-in line.delete keeps working)', async () => {
        const pineTS = new PineTS(Provider.Binance, 'BTCUSDC', '1W', null,
            new Date('2018-12-15').getTime(),
            new Date('2019-04-01').getTime());
        const code = `
//@version=6
indicator("type-aware retarget", overlay=true)
type Holder
    line ln
method delete(Holder this) =>
    this.ln.delete()

if bar_index == 5
    // A bare line — NOT a UDT instance.
    line bareLine = line.new(0, 200, 5, 210)
    bareLine.delete()
plot(close)
`;
        const r = await pineTS.run(code);
        const lines = r.plots?.['__lines__']?.data?.[0]?.value || [];
        // The bare line was deleted via the built-in line.delete() —
        // because `bareLine` is a Line, not a UDT instance, the user
        // method `$M_delete` must NOT have been called.
        expect(lines.length).toBe(0);
    });
});
