// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Alaa-eddine KADDOURI

/**
 * LTF / HTF request slicing — Phase 1.
 *
 * For every `request.security_lower_tf` (and `request.security`) call
 * site in the post-transpile AST, build a "slice" — a pre-built
 * JavaScript Function whose body is the prefix of the user's code up
 * through and including the call. When the slow path of
 * `request.security_lower_tf` runs the user script in the secondary
 * context, it executes this truncated body instead of the FULL script,
 * which on a typical "calculated expression" indicator drops the bulk
 * of the per-LTF-bar work (post-call TA, math, drawing setup, plot).
 *
 * This module only handles the simple shape: the call's outer-most
 * enclosing statement is at the top level of the wrapper function. For
 * calls nested inside if/for/while/switch/function/method bodies, the
 * walker leaves no slice for that expression name, and the runtime
 * falls back to today's full-script slow path. (Phase 2/3 of the
 * proposal expand coverage to those shapes.)
 *
 * The slice is keyed by the expression-arg's `pN` identifier name —
 * the same string `request.param(value, idx, 'pN')` injects at codegen
 * and the same string the runtime resolves as `_expression_name` in
 * `request.security_lower_tf`.
 */

import * as astring from 'astring';

/**
 * Methods on the `request` namespace whose calls trigger slicing.
 * Only `security_lower_tf` is currently wired into the runtime's
 * slice-lookup path; `security` (HTF) follows the same model and is
 * trivial to add in a later phase by extending the runtime hook.
 */
const SLICING_TARGETS = new Set(['security_lower_tf']);

/** Match `request.<target>(...)` exactly (no `await`, no chains). */
function isRequestSecurityCall(node: any): boolean {
    if (!node || node.type !== 'CallExpression') return false;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
    if (callee.object?.type !== 'Identifier' || callee.object.name !== 'request') return false;
    if (callee.property?.type !== 'Identifier') return false;
    return SLICING_TARGETS.has(callee.property.name);
}

/**
 * Keys to skip when recursing AST nodes — `parent` and back-edges are
 * sometimes added by transformer passes; loc/range are pure metadata.
 * Skipping them prevents stack overflow on cyclic graphs.
 */
const AST_SKIP_KEYS = new Set(['type', 'loc', 'start', 'end', 'range', 'parent', 'leadingComments', 'trailingComments']);

/**
 * Direct-call lookup at any depth within `node` — used to test whether
 * a top-level statement contains a `request.security_lower_tf` call.
 * Returns the `pN` identifier name from the call's third positional
 * argument, or null if the call uses a non-identifier (rare; in
 * practice `request.param` always creates an identifier).
 */
function findCallExpressionNames(node: any): string[] {
    const names: string[] = [];
    const seen = new WeakSet<object>();
    function visit(n: any) {
        if (!n || typeof n !== 'object') return;
        if (seen.has(n)) return;
        seen.add(n);
        if (isRequestSecurityCall(n)) {
            const arg2 = n.arguments?.[2];
            if (arg2?.type === 'Identifier' && typeof arg2.name === 'string') {
                names.push(arg2.name);
            }
        }
        for (const key of Object.keys(n)) {
            if (AST_SKIP_KEYS.has(key)) continue;
            const v = n[key];
            if (Array.isArray(v)) {
                for (const item of v) visit(item);
            } else if (v && typeof v === 'object') {
                visit(v);
            }
        }
    }
    visit(node);
    return names;
}

/**
 * Build a sliced async arrow function from the wrapper's params plus a
 * prefix of its top-level statements. astring is reused (it's already
 * the main code-generator in the transpile pipeline).
 *
 * NOTE: shares AST nodes with the original wrapper. astring is
 * non-destructive, so this is safe — both the main code-emit and the
 * slice-emit walk independent copies of the same nodes.
 */
function buildSliceFunction(wrapperFn: any, slicedStmts: any[]): Function {
    const slicedAst = {
        type: 'Program',
        sourceType: 'module',
        body: [{
            type: 'ExpressionStatement',
            expression: {
                type: 'ArrowFunctionExpression',
                async: !!wrapperFn.async,
                params: wrapperFn.params,
                body: { type: 'BlockStatement', body: slicedStmts },
            },
        }],
    };
    const code = astring.generate(slicedAst as any);
    const wrapped = `var _r = ${code}\n; return _r;`;
    return new Function('', wrapped)();
}

/**
 * Walk the wrapper function's top-level statement list. For each
 * statement that contains a `request.security_lower_tf` call (at any
 * depth within the statement, but with the statement itself sitting
 * directly under the wrapper's body), build a slice whose body is the
 * prefix [0..i] inclusive. Returns a Map keyed by the call's `pN`
 * expression name → slice Function.
 *
 * If multiple calls share the same top-level statement (rare but
 * legal: e.g. `[a, b] = [request.security_lower_tf(...), ...]`), each
 * call's expression name maps to the SAME slice — they share the same
 * prefix and run side-by-side in the secondary.
 *
 * Phase 1 explicitly does NOT slice when the call's enclosing
 * top-level statement is a function declaration / assignment whose
 * body contains the call (the runtime needs a synthetic invocation,
 * which we add in Phase 3) or when the call lives inside a control-
 * flow block at the top level (Phase 2). In those shapes, the walker
 * still emits a slice — but the runtime callsite check (in
 * `security_lower_tf.ts`) chooses to use it only when the call
 * actually fires from a path the slice covers. For safety the runtime
 * unconditionally falls back to the full-script slow path when
 * `_ltfTruncatedBodies[name]` is missing.
 */
export function buildLtfSlices(ast: any): Record<string, Function> {
    const slices: Record<string, Function> = {};

    // Locate the wrapper function: Program → ExpressionStatement → ArrowFunctionExpression.
    if (!ast || ast.type !== 'Program' || !Array.isArray(ast.body) || ast.body.length === 0) {
        return slices;
    }
    const firstStmt = ast.body[0];
    let wrapperFn: any | null = null;
    if (firstStmt.type === 'ExpressionStatement') {
        const expr = firstStmt.expression;
        if (expr && (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression')) {
            wrapperFn = expr;
        }
    } else if (firstStmt.type === 'FunctionDeclaration') {
        wrapperFn = firstStmt;
    }
    if (!wrapperFn || wrapperFn.body?.type !== 'BlockStatement') return slices;

    const topStmts: any[] = wrapperFn.body.body;

    for (let i = 0; i < topStmts.length; i++) {
        const stmt = topStmts[i];

        // Skip statements that are themselves block scopes whose call lives
        // strictly nested (not directly handled in Phase 1). We still
        // detect the call so we know NOT to confuse a later top-level
        // call with this one — but we don't emit a slice for it.
        const exprNames = findCallExpressionNames(stmt);
        if (exprNames.length === 0) continue;

        // Phase 1 gate: only build a slice when the call sits in a shape
        // where the secondary's bar loop would naturally fire it once
        // per LTF bar — i.e. the statement is NOT a user-function/method
        // declaration whose body needs an explicit invocation. In
        // practice for typed transpiled code, call-bearing top-level
        // statements are VariableDeclarations (`const temp_N = await
        // request.security_lower_tf(...)`), ExpressionStatements (await
        // …), or AssignmentExpressions inside ExpressionStatement.
        // FunctionDeclarations / ArrowFunctionExpressions assigned to
        // identifiers are excluded.
        if (!isPhase1CompatibleStatement(stmt)) continue;

        const slicedStmts = topStmts.slice(0, i + 1);
        const sliceFn = buildSliceFunction(wrapperFn, slicedStmts);
        for (const name of exprNames) {
            if (!(name in slices)) slices[name] = sliceFn;
        }
    }

    return slices;
}

/**
 * Phase 1 acceptance: the statement is something that, when executed
 * top-down per bar, will fire the contained `request.*` call without
 * needing an extra invocation. Practical shapes from the codegen:
 *   - VariableDeclaration with an `await` initializer
 *   - ExpressionStatement with an `await` expression
 *   - AssignmentExpression inside an ExpressionStatement
 *
 * Excluded for Phase 1: FunctionDeclarations, ClassDeclarations,
 * IfStatement / ForStatement / SwitchStatement / WhileStatement
 * (Phase 2), and any statement whose call lives strictly inside a
 * nested function body (Phase 3).
 */
function isPhase1CompatibleStatement(stmt: any): boolean {
    if (!stmt) return false;
    if (stmt.type === 'FunctionDeclaration') return false;
    if (stmt.type === 'ClassDeclaration') return false;
    // Reject if the call is buried inside a nested FunctionExpression or
    // ArrowFunctionExpression — those need an invocation, deferred to
    // Phase 3.
    if (callIsInsideNestedFunction(stmt)) return false;
    // Reject control-flow blocks for now — Phase 2 handles them.
    if (stmt.type === 'IfStatement' || stmt.type === 'ForStatement' ||
        stmt.type === 'ForInStatement' || stmt.type === 'ForOfStatement' ||
        stmt.type === 'WhileStatement' || stmt.type === 'DoWhileStatement' ||
        stmt.type === 'SwitchStatement' || stmt.type === 'TryStatement' ||
        stmt.type === 'BlockStatement') return false;
    return true;
}

/**
 * Returns true if a `request.security_lower_tf` call exists strictly
 * inside a nested function/arrow expression within `stmt` (i.e. it
 * would NOT fire on a per-bar pass through `stmt`). Direct calls
 * inside `stmt`'s own AssignmentExpression / VariableDeclarator init
 * don't count as nested.
 */
function callIsInsideNestedFunction(stmt: any): boolean {
    let foundNested = false;
    const seen = new WeakSet<object>();
    function visit(n: any, insideFn: boolean) {
        if (foundNested || !n || typeof n !== 'object') return;
        if (seen.has(n)) return;
        seen.add(n);
        const isFnNode = n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' ||
                         n.type === 'FunctionDeclaration';
        if (isRequestSecurityCall(n) && insideFn) {
            foundNested = true;
            return;
        }
        for (const key of Object.keys(n)) {
            if (AST_SKIP_KEYS.has(key)) continue;
            const v = n[key];
            if (Array.isArray(v)) {
                for (const item of v) visit(item, insideFn || isFnNode);
            } else if (v && typeof v === 'object') {
                visit(v, insideFn || isFnNode);
            }
        }
    }
    // Top-level `stmt` itself is not a function body; treat its direct
    // children as "outside" any function.
    visit(stmt, false);
    return foundNested;
}
