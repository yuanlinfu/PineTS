// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { pineToJS } from '../../src/transpiler/pineToJS/pineToJS.index';
import { transpile } from '../../src/transpiler/index';

describe('Dotted Type Annotations (e.g., chart.point)', () => {
    it('should parse dotted array type declaration: chart.point[] name = ...', () => {
        const code = `
//@version=5
indicator("Test")
chart.point[] polyPoints = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('polyPoints');
        expect(result.code).toContain('array.new');
    });

    it('should parse var with dotted array type: var chart.point[] name = ...', () => {
        const code = `
//@version=5
indicator("Test")
var chart.point[] pts = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('pts');
    });

    it('should parse varip with dotted array type: varip chart.point[] name = ...', () => {
        const code = `
//@version=5
indicator("Test")
varip chart.point[] pts = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('pts');
    });

    it('should parse simple dotted type declaration: chart.point name = ...', () => {
        const code = `
//@version=5
indicator("Test")
chart.point p = chart.point.new(0, 0.0)
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('chart.point.new');
    });

    it('should parse var with simple dotted type: var chart.point name = ...', () => {
        const code = `
//@version=5
indicator("Test")
var chart.point p = chart.point.new(0, 0.0)
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
    });

    it('should parse generic type with dotted type parameter: array<chart.point>', () => {
        const code = `
//@version=5
indicator("Test")
array<chart.point> pts = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
    });

    it('should parse var with generic dotted type parameter: var array<chart.point>', () => {
        const code = `
//@version=5
indicator("Test")
var array<chart.point> pts = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
    });

    it('should parse dotted types inside map generics: map<string, chart.point>', () => {
        const code = `
//@version=5
indicator("Test")
map<string, chart.point> pointMap = map.new<string, chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
    });

    it('should parse line.style dotted type', () => {
        const code = `
//@version=5
indicator("Test")
x = line.new(bar_index, close, bar_index, close, style=line.style_dashed)
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('line.style_dashed');
    });

    it('should transpile dotted array type through full pipeline', () => {
        const code = `
//@version=5
indicator("Test")
chart.point[] polyPoints = array.new<chart.point>()
        `;

        const result = transpile(code);
        const jsCode = result.toString();

        expect(jsCode).toBeDefined();
        expect(jsCode).toContain('polyPoints');
    });

    // Two complete typed declarations on a single line, separated by a comma.
    // The shared-type comma-decl path used to greedily swallow the comma when
    // the next token was an IDENTIFIER, then fail at the dot inside the second
    // type name. Mirrors the pattern used in Liquidity-Structure.pine where
    // the script declares two `chart.point[]` arrays in one statement:
    //   chart.point[] cpS_f = array.new<chart.point>(), chart.point[] cpB_f = array.new<chart.point>()
    it('should parse two full chart.point[] declarations on one line (comma-separated)', () => {
        const code = `
//@version=6
indicator("Test")
chart.point[] cpS_f = array.new<chart.point>(), chart.point[] cpB_f = array.new<chart.point>()
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('cpS_f');
        expect(result.code).toContain('cpB_f');
    });

    // The shared-type form (one type, multiple names) must still work.
    it('should still parse shared-type comma-decl: float a = 0.0, b = 1.0', () => {
        const code = `
//@version=5
indicator("Test")
float a = 0.0, b = 1.0
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
    });

    // The full-repeated-type form with a non-dotted type must also still work.
    it('should parse full-repeated-type form: float a = 1.0, float b = 2.0', () => {
        const code = `
//@version=5
indicator("Test")
float a = 1.0, float b = 2.0
        `;

        const result = pineToJS(code);
        expect(result.success).toBe(true);
        expect(result.code).toBeDefined();
        expect(result.code).toContain('a');
        expect(result.code).toContain('b');
    });
});
