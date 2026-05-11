// Known Pine Script namespaces that might be used as functions or objects
export const KNOWN_NAMESPACES = ['ta', 'math', 'request', 'array', 'input', 'color', 'ticker'];

// This is used to transform ns() calls to ns.any() calls
// Entries with a __value property also support dual-use as variables (e.g. time, na)
//
// Pine v6 type-cast pattern: `<TypeName>(value)` — most commonly `box(na)`,
// `line(na)` etc. inside UDT initializers — needs the namespace to be listed
// here so the call gets rewritten to `<TypeName>.any(value)` (each helper's
// `any` delegates to `new`, producing a typed-na/passthrough value).
export const NAMESPACES_LIKE = [
    'hline',
    'plot',
    'fill',
    'label',
    'line',
    'box',
    'linefill',
    'polyline',
    'table',
    'na',
    'alert',
    'time',
    'time_close',
    'dayofmonth',
    'dayofweek',
    'hour',
    'minute',
    'month',
    'second',
    'weekofyear',
    'year',
];

// Async methods that require await keyword (format: 'namespace.method')
export const ASYNC_METHODS = ['request.security', 'request.security_lower_tf'];

// Factory methods that create objects with side effects (format: 'namespace.method')
// When used inside `var` declarations, these calls are wrapped in arrow functions
// so they are only evaluated on bar 0 (deferred evaluation via initVar thunk).
export const FACTORY_METHODS = [
    'line.new',
    'line.copy',
    'label.new',
    'label.copy',
    'polyline.new',
    'box.new',
    'box.copy',
    'table.new',
    'linefill.new',
];

// Names that function as namespaces — used as function calls (fill(...), plot(...))
// or member access (size.tiny, label.style_label_down). User variables with these
// names must be renamed during codegen to avoid shadowing the namespace binding
// injected by InjectionTransformer. Excludes pure built-in variables (second, hour,
// time, na, etc.) which are safely scoped by Phase 2 into $.let.glb1_* without collision.
export const NAMESPACE_COLLISION_NAMES = new Set([
    ...KNOWN_NAMESPACES,
    // NAMESPACES_LIKE that are actual function-call namespaces
    'fill', 'plot', 'hline', 'label', 'line',
    // Drawing/enum namespaces with member access
    'size', 'extend', 'display', 'format', 'location', 'shape', 'text', 'xloc', 'yloc',
    'linefill', 'polyline', 'box', 'table', 'map', 'matrix', 'chart',
    'alert', 'barstate', 'syminfo', 'timeframe', 'strategy', 'log', 'str',
]);

// JavaScript reserved keywords that ARE valid Pine identifiers but invalid as
// JS identifiers. When a user names a function/method/variable using one of
// these, we must rename it during codegen — otherwise the generated JS fails
// to parse (e.g. `function delete() {}` → `Unexpected keyword 'delete'`).
//
// Excludes words reserved in BOTH languages (break, case, class, const, continue,
// do, else, enum, export, for, if, import, in, return, switch, try, var, while)
// — those can't be Pine identifiers in the first place.
//
// Excludes `this` — special-cased elsewhere as the implicit first parameter
// of Pine `method` declarations.
export const JS_RESERVED_WORDS = new Set([
    'await', 'debugger', 'default', 'delete', 'extends', 'finally',
    'function', 'implements', 'instanceof', 'interface', 'let', 'new',
    'package', 'private', 'protected', 'public', 'static', 'super',
    'throw', 'typeof', 'void', 'with', 'yield',
]);

// All known data variables in the context
export const CONTEXT_DATA_VARS = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'openTime', 'closeTime'];

// All known Pine variables in the context
export const CONTEXT_PINE_VARS = [
    //namespaces
    ...KNOWN_NAMESPACES,
    //plots
    'plotchar',
    'plotshape',
    'plotarrow',
    'plotbar',
    'plotcandle',
    'plot',
    'bgcolor',
    'barcolor',
    'hline',
    'fill',

    //declarations
    'indicator',
    'strategy',
    'library',

    //
    'alertcondition',
    'alert',
    'error',
    'max_bars_back',
    'fixnan',
    'na',
    'nz',
    'timestamp',
    'str',
    'box',
    'line',
    'label',
    'table',
    'chart',
    'linefill',
    'polyline',
    'map',
    'matrix',
    'log',
    //types
    'Type', //UDT
    'bool',
    'int',
    'float',
    'string',

    //market info
    'timeframe',
    'syminfo',
    'barstate',

    //builtin variables
    'bar_index',
    'last_bar_index',
    'last_bar_time',
    'inputs',
    'time',
    'time_close',
    'time_tradingday',
    'dayofmonth',
    'hour',
    'minute',
    'month',
    'second',
    'weekofyear',
    'year',

    // Pine Script enum types
    'order',
    'currency',
    'display',
    'shape',
    'location',
    'size',
    'format',
    'dayofweek',

    // Coordinate and alignment constants
    'xloc',
    'yloc',
    'text',
    'font',
    'extend',
    'position',

    // Merge constants (request.security)
    'barmerge',

    // Adjustment constants
    'adjustment',
    'backadjustment',

    // Financial data constants
    'earnings',
    'dividends',
    'splits',
];

// All known core variables in the context
//names exposed in legacy pine.core namespace
//this will be deprecated then removed
export const CONTEXT_CORE_VARS = ['na', 'nz', 'plot', 'plotchar', 'color', 'hline', 'fill'];
