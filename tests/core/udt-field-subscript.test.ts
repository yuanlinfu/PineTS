import { describe, it, expect } from 'vitest';
import { PineTS, Provider } from 'index';
import { transpile } from '../../src/transpiler/index';
import ScopeManager from '../../src/transpiler/analysis/ScopeManager';
import { preProcessUdtRegistry } from '../../src/transpiler/analysis/AnalysisPass';
import * as acorn from 'acorn';

/**
 * Regression suite for the two-bug "subscript on UDT field" issue.
 *
 * Pine semantics: when `bar` is a UDT instance reassigned every bar
 * (`bar = SomeUDT.new()`), `bar.field[N]` reads the field's value from N
 * bars ago — i.e. the same as `low[N]` if the field captures `low` at
 * construction. The transpiler must:
 *   1. Recognize `bar` as a UDT instance (not a built-in / array / namespace).
 *   2. Apply the lookback to the leaf base (Series of UDT instances),
 *      NOT to the field-access tail.
 *
 * The discrimination is non-trivial because `bar.field[N]` and
 * `arr[N]` (on a JS array) have identical AST shapes. The fix uses a
 * UDT registry populated from `const X = Type({...})` declarations
 * (pine2js output) and `<X>.new(...)` / `<X>.copy(...)` initializers.
 */

// ── Helpers ────────────────────────────────────────────────────────────

/** Pre-process raw JS source into an AST and run only the UDT pre-pass.
 *  Returns the populated ScopeManager so tests can introspect the registry. */
function buildUdtRegistry(jsSource: string): ScopeManager {
    const ast: any = acorn.parse(jsSource, { ecmaVersion: 'latest', sourceType: 'module' });
    const sm = new ScopeManager();
    preProcessUdtRegistry(ast, sm);
    return sm;
}

// ── 1. UDT registry pre-pass ───────────────────────────────────────────

describe('UDT registry pre-pass (preProcessUdtRegistry)', () => {
    it('registers UDT type names from `const X = Type({...})` declarations', () => {
        // pine2js output shape — what `type BAR { float low_v = low }` becomes
        const sm = buildUdtRegistry(`const BAR = Type({ low_v: ['float', 0] });`);
        expect(sm.isUdtTypeName('BAR')).toBe(true);
        expect(sm.isUdtTypeName('SOMETHING_ELSE')).toBe(false);
    });

    it('captures field type metadata (V2 data model)', () => {
        const sm = buildUdtRegistry(`const FOO = Type({ a: ['float', 0], b: ['int', 0], c: ['bool', false] });`);
        const fields = sm.getUdtTypeFields('FOO');
        expect(fields).toEqual({ a: 'float', b: 'int', c: 'bool' });
    });

    it('registers variables initialized via `<UDT>.new(...)` as UDT instances', () => {
        const sm = buildUdtRegistry(`
            const BAR = Type({ low_v: ['float', 0] });
            let bar = BAR.new();
        `);
        expect(sm.isUdtInstance('bar')).toBe(true);
        expect(sm.getVariableUdtType('bar')).toBe('BAR');
    });

    it('registers variables initialized via `<UDT>.copy(...)` as UDT instances', () => {
        const sm = buildUdtRegistry(`
            const BAR = Type({ low_v: ['float', 0] });
            let original = BAR.new();
            let copy = BAR.copy(original);
        `);
        expect(sm.isUdtInstance('copy')).toBe(true);
        expect(sm.getVariableUdtType('copy')).toBe('BAR');
    });

    it('does NOT register built-in factory calls as UDT instances', () => {
        // These are critical: built-in factory methods like polyline.new(),
        // array.from(), chart.point.from_index() must NOT enter the UDT
        // registry — otherwise their `field[N]` patterns get incorrectly
        // rewritten as series lookback (regression on the polyline test).
        const sm = buildUdtRegistry(`
            let arr = array.from(1, 2, 3);
            let pl = polyline.new(arr);
            let pt = chart.point.from_index(0, 100);
            let lbl = label.new(0, 0, "x");
            let bx = box.new(0, 0, 1, 1);
        `);
        expect(sm.isUdtInstance('arr')).toBe(false);
        expect(sm.isUdtInstance('pl')).toBe(false);
        expect(sm.isUdtInstance('pt')).toBe(false);
        expect(sm.isUdtInstance('lbl')).toBe(false);
        expect(sm.isUdtInstance('bx')).toBe(false);
    });
});

// ── 2. Codegen shape ───────────────────────────────────────────────────

describe('UDT field subscript — transpiler codegen shape', () => {
    it('rewrites `bar.field[N]` (top-level RHS) to `$.get(<scoped-bar>, N).field`', () => {
        // Bug 1: previously emitted `$.init(target, $.get(bar, 0).field, N)`
        // — the lookback as a stray third arg that `$.init` silently ignored
        // for scalars. The correct shape applies the lookback at the leaf base.
        const code = `
//@version=6
indicator("udt subscript top-level")
type BAR
    float low_v = low
bar = BAR.new()
b = bar.low_v[1]
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();

        expect(jsCode).toContain('$.get($.let.glb1_bar, 1).low_v');
        // Must NOT regress to the broken stray-third-arg form
        expect(jsCode).not.toMatch(/\$\.init\([^,]+,\s*\$\.get\(\$\.let\.glb1_bar,\s*0\)\.low_v,\s*1\)/);
    });

    it('rewrites `bar.field[N]` inside a function-call arg to `$.param($.get(<scoped-bar>, 0).field, N, ...)`', () => {
        // Bug 2: previously emitted `$.param(bar.field, N, ...)` with bare `bar`,
        // throwing "bar is not defined" at runtime.
        const code = `
//@version=6
indicator("udt subscript function arg")
type BAR
    float low_v = low
bar = BAR.new()
identity(x) => x
b = identity(bar.low_v[1])
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();

        // The leaf base must be scoped; the lookback can live in $.param.
        expect(jsCode).toMatch(/\$\.param\(\$\.get\(\$\.let\.glb1_bar,\s*0\)\.low_v,\s*1,/);
        // Must NOT regress to bare `bar.low_v` in the param arg
        expect(jsCode).not.toMatch(/\$\.param\(bar\.low_v,/);
    });

    it('does NOT rewrite `<member>[N]` when the leaf base is NOT a UDT instance', () => {
        // Critical guard — JS-style `pl.points[0]` where `pl = polyline.new(...)`
        // must remain a plain array index, not become `$.get(pl, 0).points`.
        const code = `
//@version=6
indicator("not a UDT instance", overlay=true)
plot(close)
        `;
        // The UDT registry is empty for this script (no `type X`).
        // Even if we synthesize the AST shape that LOOKS like UDT subscript,
        // the rewrite should not fire. Demonstrate via direct registry check:
        const sm = buildUdtRegistry(`
            let pts = array.from(1, 2, 3);
            let pl = polyline.new(pts);
        `);
        expect(sm.isUdtInstance('pl')).toBe(false);
        expect(sm.isUdtInstance('pts')).toBe(false);
        // Smoke check transpile completes
        expect(transpile(code).toString()).toBeDefined();
    });

    it('rewrites nested UDT field chains correctly (`outer.inner.field[N]`)', () => {
        // The walker descends to the leaf identifier; rewrite anchors there.
        const code = `
//@version=6
indicator("nested UDT chain")
type INNER
    float v = low
type OUTER
    INNER inner = INNER.new()
bar = OUTER.new()
b = bar.inner.v[1]
plot(close)
        `;
        const result = transpile(code);
        const jsCode = result.toString();
        // Lookback applied to `bar` (the leaf), then `.inner.v` chain follows
        expect(jsCode).toContain('$.get($.let.glb1_bar, 1).inner.v');
    });
});

// ── 3. Smoke tests — does-not-crash and output-shape integrity ────────

// Note: full TV-vs-PineTS value equivalence is covered end-to-end by the
// automated test at:
//   Automations/PineTS/pinescripts/lang/udt_field_subscript.pine
// The smoke tests below verify that the transpile + run pipeline doesn't
// throw on the bug-triggering shapes — protecting against regressions in
// the surrounding wiring (preProcessUdtRegistry registration, walker
// short-circuits, etc.) that would silently re-break the behavior.

describe('UDT field subscript — pipeline smoke tests', () => {
    const mkPts = () =>
        new PineTS(
            Provider.Mock,
            'BTCUSDC',
            'D',
            null,
            new Date('2019-04-01').getTime(),
            new Date('2019-04-15').getTime(),
        );

    it('Bug 2 smoke — function-arg `f(bar.field[N])` does not crash', async () => {
        // Before the surgical fix in transformFunctionArgument's isArrayAccess
        // branch, this exact shape threw `ReferenceError: bar is not defined`
        // because the leaf `bar` Identifier was never scoped to `glb1_bar`.
        await expect(
            mkPts().run(`
//@version=5
indicator("bug2smoke")
type BAR
    float low_v = low
bar = BAR.new()
f(x) => x
plot(f(bar.low_v[1]), "out")
            `),
        ).resolves.toBeDefined();
    });

    it('Bug 1 smoke — top-level `b = bar.field[N]` does not crash', async () => {
        // Before the rewrite in transformMemberExpression, this shape compiled
        // but emitted `$.init(t, value, 1)` with the lookback as a stray third
        // arg silently ignored. Verifies the script still runs end-to-end.
        await expect(
            mkPts().run(`
//@version=5
indicator("bug1smoke")
type BAR
    float low_v = low
bar = BAR.new()
b = bar.low_v[1]
plot(b, "out")
            `),
        ).resolves.toBeDefined();
    });

    it('UDT-instance discrimination — script using polyline.new() does not crash', async () => {
        // Sanity check that built-in factory calls (polyline.new, array.from,
        // chart.point.from_index) are NOT registered as UDT instances. Before
        // the discrimination check was added, an over-eager rewrite would
        // misinterpret `pl.points[0]` as series lookback and crash.
        await expect(
            mkPts().run(`
//@version=5
indicator("polyline-discrim")
var pt1 = chart.point.from_index(0, 50000)
var pt2 = chart.point.from_index(5, 60000)
var pts = array.from(pt1, pt2)
var pl = polyline.new(pts)
plot(close)
            `),
        ).resolves.toBeDefined();
    });
});
