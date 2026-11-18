using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace IdeaBlade.Validation.Expressions
{
    /// <summary>
    /// Pluggable expression evaluator used for validator conditions, model conditions and the <c>expression</c> validator.
    /// The default is <see cref="SafeExpressionEvaluator"/>. Implement this interface to use another engine
    /// (for example a sandboxed Jint engine), and register it with <c>UseExpressionEvaluator</c>.
    /// </summary>
    public interface IExpressionEvaluator
    {
        /// <summary>Evaluates <paramref name="expression"/> with the given variables. Returns a CLR value (undefined is returned as null).</summary>
        object? Evaluate(string expression, IReadOnlyDictionary<string, object?> scope);
    }

    /// <summary>Options for <see cref="SafeExpressionEvaluator"/>.</summary>
    public sealed class SafeExpressionEvaluatorOptions
    {
        /// <summary>Additional trusted functions/values available to every expression as global identifiers.</summary>
        public IDictionary<string, object?> Globals { get; } = new Dictionary<string, object?>(StringComparer.Ordinal);

        /// <summary>Method names that may be called on arbitrary CLR objects, resolved to public instance methods (case-insensitive). Default: none.</summary>
        public ISet<string> AllowedMethods { get; } = new HashSet<string>(StringComparer.Ordinal);

        /// <summary>Maximum number of AST node evaluations per evaluation. Default 100,000.</summary>
        public int MaxSteps { get; set; } = 100_000;

        /// <summary>Maximum nesting of arrow-function calls. Default 64.</summary>
        public int MaxCallDepth { get; set; } = 64;

        /// <summary>Maximum number of parsed expressions kept in the cache. Default 1,000.</summary>
        public int CacheSize { get; set; } = 1_000;
    }

    /// <summary>An arrow function created by an expression.</summary>
    internal sealed class ExpressionClosure
    {
        public ExpressionClosure(ArrowNode node, Scope env) { Node = node; Env = env; }
        public ArrowNode Node { get; }
        public Scope Env { get; }
    }

    internal sealed class Scope
    {
        private readonly IReadOnlyDictionary<string, object?> _vars;
        private readonly Scope? _parent;

        public Scope(IReadOnlyDictionary<string, object?> vars, Scope? parent = null)
        {
            _vars = vars;
            _parent = parent;
        }

        public bool Has(string name) => _vars.ContainsKey(name) || (_parent != null && _parent.Has(name));

        public object? Get(string name)
        {
            if (_vars.TryGetValue(name, out var v)) return v;
            return _parent?.Get(name);
        }
    }

    /// <summary>
    /// Evaluates validation expressions without a JavaScript engine. Expressions are parsed once (cached) and
    /// interpreted. Only a side-effect-free subset of JavaScript is supported; see docs/expressions.md.
    /// Same grammar and semantics as the TypeScript <c>SafeExpressionEvaluator</c>.
    /// </summary>
    public sealed class SafeExpressionEvaluator : IExpressionEvaluator
    {
        private readonly ConcurrentDictionary<string, ExpressionNode> _cache = new ConcurrentDictionary<string, ExpressionNode>(StringComparer.Ordinal);
        private readonly Scope _globals;
        private readonly HashSet<string> _allowedMethods;
        private readonly int _maxSteps;
        private readonly int _maxCallDepth;
        private readonly int _cacheSize;

        public SafeExpressionEvaluator() : this(new SafeExpressionEvaluatorOptions()) { }

        public SafeExpressionEvaluator(SafeExpressionEvaluatorOptions options)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            var globals = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kvp in Builtins.DefaultGlobals) globals[kvp.Key] = kvp.Value;
            foreach (var kvp in options.Globals) globals[kvp.Key] = kvp.Value;
            _globals = new Scope(globals);
            _allowedMethods = new HashSet<string>(options.AllowedMethods, StringComparer.Ordinal);
            foreach (var name in _allowedMethods)
            {
                if (Builtins.ForbiddenProperties.Contains(name))
                    throw new ArgumentException($"'{name}' cannot be an allowed method", nameof(options));
            }
            _maxSteps = options.MaxSteps;
            _maxCallDepth = options.MaxCallDepth;
            _cacheSize = options.CacheSize;
        }

        /// <summary>Parses (with caching) an expression. Throws <see cref="ExpressionSyntaxException"/> for invalid expressions.</summary>
        public ExpressionNode Compile(string expression)
        {
            if (_cache.TryGetValue(expression, out var ast)) return ast;
            ast = ExpressionParser.Parse(expression);
            if (_cache.Count >= _cacheSize) _cache.Clear();
            _cache[expression] = ast;
            return ast;
        }

        /// <inheritdoc />
        public object? Evaluate(string expression, IReadOnlyDictionary<string, object?> scope)
        {
            var ast = Compile(expression);
            var interpreter = new Interpreter(expression, _allowedMethods, _maxSteps, _maxCallDepth);
            return interpreter.Run(ast, new Scope(scope ?? new Dictionary<string, object?>(), _globals));
        }

        /// <summary>Evaluates an expression and converts the result to a boolean using JavaScript truthiness.</summary>
        public bool EvaluateBoolean(string expression, IReadOnlyDictionary<string, object?> scope) => JsRuntime.Truthy(Evaluate(expression, scope));

        /// <summary>Checks whether an expression is syntactically valid, without evaluating it.</summary>
        public static bool TryValidate(string expression, out ExpressionSyntaxException? error)
        {
            try
            {
                ExpressionParser.Parse(expression);
                error = null;
                return true;
            }
            catch (ExpressionSyntaxException e)
            {
                error = e;
                return false;
            }
        }

        private sealed class ShortCircuit
        {
            public static readonly ShortCircuit Value = new ShortCircuit();
        }

        private sealed class Interpreter : ICallInvoker
        {
            private readonly string _source;
            private readonly HashSet<string> _allowedMethods;
            private readonly int _maxSteps;
            private readonly int _maxCallDepth;
            private int _steps;
            private int _callDepth;

            public Interpreter(string source, HashSet<string> allowedMethods, int maxSteps, int maxCallDepth)
            {
                _source = source;
                _allowedMethods = allowedMethods;
                _maxSteps = maxSteps;
                _maxCallDepth = maxCallDepth;
            }

            private ExpressionEvaluationException Fail(string message, Exception? inner = null) => new ExpressionEvaluationException(message, _source, inner);

            public object? Run(ExpressionNode node, Scope env)
            {
                try
                {
                    return ToClr(Export(Eval(node, env)));
                }
                catch (ExpressionEvaluationException) { throw; }
                catch (ExpressionRuntimeException e) { throw Fail(e.Message, e); }
                catch (RegexMatchTimeoutException e) { throw Fail("Regular expression timed out", e); }
                catch (InsufficientExecutionStackException e) { throw Fail("Expression is nested too deeply", e); }
                catch (TargetInvocationException e) when (e.InnerException != null) { throw Fail(e.InnerException.Message, e.InnerException); }
                catch (Exception e) when (e is ArgumentException || e is FormatException || e is InvalidCastException || e is OverflowException || e is IndexOutOfRangeException)
                {
                    throw Fail(e.Message, e);
                }
            }

            private object? ToClr(object? value)
            {
                if (value is Undefined) return null;
                if (value is ExpressionClosure c) return new ExpressionFunction(args => ToClr(InvokeClosure(c, args)));
                return value;
            }

            private object? Export(object? value) => value is ShortCircuit ? Undefined.Value : value;

            private void Tick()
            {
                if (++_steps > _maxSteps) throw Fail($"Expression exceeded the maximum of {_maxSteps} evaluation steps");
            }

            private object? Eval(ExpressionNode node, Scope env)
            {
                Tick();
                RuntimeHelpers.EnsureSufficientExecutionStack();
                switch (node)
                {
                    case LiteralNode lit: return lit.Value;
                    case RegexNode re: return JsRegExp.Create(re.Pattern, re.Flags);
                    case IdentifierNode id:
                        if (!env.Has(id.Name)) throw Fail($"Unknown identifier '{id.Name}'");
                        return JsRuntime.Normalize(env.Get(id.Name));
                    case ArrayNode arr: return arr.Elements.Select(e => Export(Eval(e, env))).ToList();
                    case ObjectNode obj:
                        {
                            var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
                            foreach (var p in obj.Properties) dict[p.Key] = Export(Eval(p.Value, env));
                            return dict;
                        }
                    case ChainNode chain:
                        {
                            var v = Eval(chain.Expression, env);
                            return v is ShortCircuit ? Undefined.Value : v;
                        }
                    case MemberNode member: return EvalMember(member, env);
                    case CallNode call: return EvalCall(call, env);
                    case NewNode nw:
                        {
                            var args = nw.Arguments.Select(a => Export(Eval(a, env))).ToArray();
                            if (nw.Callee == "Date") return Builtins.NewDate(args);
                            throw Fail($"'new {nw.Callee}' is not allowed");
                        }
                    case UnaryNode un:
                        {
                            if (un.Operator == "typeof" && un.Argument is IdentifierNode tid && !env.Has(tid.Name)) return "undefined";
                            var v = Export(Eval(un.Argument, env));
                            switch (un.Operator)
                            {
                                case "!": return !JsRuntime.Truthy(v);
                                case "-": return -JsRuntime.ToNumber(v);
                                case "+": return JsRuntime.ToNumber(v);
                                case "typeof": return JsRuntime.TypeOf(v);
                            }
                            break;
                        }
                    case BinaryNode bin: return EvalBinary(bin, env);
                    case LogicalNode log:
                        {
                            var left = Export(Eval(log.Left, env));
                            switch (log.Operator)
                            {
                                case "&&": return JsRuntime.Truthy(left) ? Export(Eval(log.Right, env)) : left;
                                case "||": return JsRuntime.Truthy(left) ? left : Export(Eval(log.Right, env));
                                case "??": return JsRuntime.IsNullish(left) ? Export(Eval(log.Right, env)) : left;
                            }
                            break;
                        }
                    case ConditionalNode cond:
                        return JsRuntime.Truthy(Export(Eval(cond.Test, env))) ? Eval(cond.Consequent, env) : Eval(cond.Alternate, env);
                    case ArrowNode arrow: return new ExpressionClosure(arrow, env);
                }
                throw Fail($"Unsupported node type '{node.GetType().Name}'");
            }

            private object? EvalBinary(BinaryNode node, Scope env)
            {
                var l = Export(Eval(node.Left, env));
                var r = Export(Eval(node.Right, env));
                switch (node.Operator)
                {
                    case "+": return JsRuntime.Add(l, r);
                    case "-": return JsRuntime.ToNumber(l) - JsRuntime.ToNumber(r);
                    case "*": return JsRuntime.ToNumber(l) * JsRuntime.ToNumber(r);
                    case "/": return JsRuntime.ToNumber(l) / JsRuntime.ToNumber(r);
                    case "%": return JsRuntime.ToNumber(l) % JsRuntime.ToNumber(r);
                    case "<": { var c = JsRuntime.Compare(l, r); return c.HasValue && c.Value < 0; }
                    case "<=": { var c = JsRuntime.Compare(l, r); return c.HasValue && c.Value <= 0; }
                    case ">": { var c = JsRuntime.Compare(l, r); return c.HasValue && c.Value > 0; }
                    case ">=": { var c = JsRuntime.Compare(l, r); return c.HasValue && c.Value >= 0; }
                    case "==": return JsRuntime.LooseEquals(l, r);
                    case "!=": return !JsRuntime.LooseEquals(l, r);
                    case "===": return JsRuntime.StrictEquals(l, r);
                    case "!==": return !JsRuntime.StrictEquals(l, r);
                }
                throw Fail($"Unsupported operator '{node.Operator}'");
            }

            private string PropertyKey(MemberNode node, Scope env)
            {
                var raw = node.Computed ? Export(Eval(node.Property, env)) : ((LiteralNode)node.Property).Value;
                var key = raw as string ?? JsRuntime.ToJsString(raw);
                if (Builtins.ForbiddenProperties.Contains(key)) throw Fail($"Access to property '{key}' is not allowed");
                return key;
            }

            private object? EvalMember(MemberNode node, Scope env)
            {
                var obj = Eval(node.Object, env);
                if (obj is ShortCircuit) return obj;
                if (node.Optional && JsRuntime.IsNullish(obj)) return ShortCircuit.Value;
                var key = PropertyKey(node, env);
                return ReadProperty(obj, key);
            }

            private object? ReadProperty(object? obj, string key)
            {
                if (JsRuntime.IsNullish(obj)) throw Fail($"Cannot read property '{key}' of {(obj == null ? "null" : "undefined")}");
                if (obj is SafeNamespace ns)
                {
                    if (!ns.Members.TryGetValue(key, out var member)) throw Fail($"'{ns.Name}.{key}' is not available in expressions");
                    return member;
                }
                if (obj is ExpressionClosure) throw Fail("Cannot read properties of an arrow function");
                return JsRuntime.GetProperty(obj, key);
            }

            private object? EvalCall(CallNode node, Scope env)
            {
                object? fn;
                object? receiver = null;
                string? methodName = null;

                if (node.Callee is MemberNode member)
                {
                    receiver = Eval(member.Object, env);
                    if (receiver is ShortCircuit) return receiver;
                    if (member.Optional && JsRuntime.IsNullish(receiver)) return ShortCircuit.Value;
                    methodName = PropertyKey(member, env);
                    fn = ReadProperty(receiver, methodName);
                }
                else
                {
                    fn = Eval(node.Callee, env);
                    if (fn is ShortCircuit) return fn;
                }

                if (node.Optional && JsRuntime.IsNullish(fn)) return ShortCircuit.Value;

                var args = node.Arguments.Select(a => Export(Eval(a, env))).ToArray();

                if (fn is ExpressionClosure closure) return InvokeClosure(closure, args);
                if (fn is SafeNamespace ns)
                {
                    if (ns.Call == null) throw Fail($"'{ns.Name}' is not callable");
                    return JsRuntime.Normalize(ns.Call(args));
                }

                if (methodName == null)
                {
                    if (fn is Delegate d) return InvokeDelegate(d, args);
                    throw Fail($"'{(node.Callee is IdentifierNode id ? id.Name : "expression")}' is not a function");
                }

                if (receiver is SafeNamespace)
                {
                    if (fn is Delegate nd) return InvokeDelegate(nd, args);
                    throw Fail($"'{methodName}' is not a function");
                }

                if (fn is MethodReference mr) return JsRuntime.Normalize(Builtins.CallMethod(this, mr.Receiver, mr.Name, args));

                // Arbitrary CLR object: only explicitly allowed methods.
                var isBuiltinReceiver = receiver is string || receiver is double || receiver is bool || receiver is DateTime || receiver is JsRegExp || JsRuntime.IsArrayLike(receiver);
                if (receiver != null && !isBuiltinReceiver && _allowedMethods.Contains(methodName))
                {
                    if (fn is Delegate memberDelegate) return InvokeDelegate(memberDelegate, args);
                    var method = receiver.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                        .FirstOrDefault(m => string.Equals(m.Name, methodName, StringComparison.OrdinalIgnoreCase) && m.GetParameters().Length == args.Length && !m.IsGenericMethodDefinition);
                    if (method != null)
                    {
                        var ps = method.GetParameters();
                        var converted = args.Select((a, i) => ConvertArg(a, ps[i].ParameterType)).ToArray();
                        return JsRuntime.Normalize(method.Invoke(receiver, converted));
                    }
                }

                if (fn is Undefined || fn == null || JsRuntime.IsCallable(fn))
                    throw Fail($"Calling method '{methodName}' on {DescribeType(receiver)} is not allowed");
                throw Fail($"'{methodName}' is not a function");
            }

            private static string DescribeType(object? value)
            {
                if (value == null) return "null";
                if (value is Delegate) return "a function";
                return "an object of type " + value.GetType().Name;
            }

            public object? Invoke(object? fn, object?[] args)
            {
                switch (fn)
                {
                    case ExpressionClosure c: return InvokeClosure(c, args);
                    case SafeNamespace ns when ns.Call != null: return JsRuntime.Normalize(ns.Call(args));
                    case Delegate d: return InvokeDelegate(d, args);
                    case MethodReference mr: return JsRuntime.Normalize(Builtins.CallMethod(this, mr.Receiver, mr.Name, args));
                    default: throw Fail("Callback is not a function");
                }
            }

            private object? InvokeClosure(ExpressionClosure closure, object?[] args)
            {
                if (++_callDepth > _maxCallDepth)
                {
                    _callDepth--;
                    throw Fail($"Expression exceeded the maximum call depth of {_maxCallDepth}");
                }
                try
                {
                    var vars = new Dictionary<string, object?>(StringComparer.Ordinal);
                    for (var i = 0; i < closure.Node.Parameters.Count; i++)
                        vars[closure.Node.Parameters[i]] = i < args.Length ? args[i] : Undefined.Value;
                    return Export(Eval(closure.Node.Body, new Scope(vars, closure.Env)));
                }
                finally { _callDepth--; }
            }

            private object? InvokeDelegate(Delegate d, object?[] args)
            {
                if (d is ExpressionFunction ef) return JsRuntime.Normalize(ef(args));
                var ps = d.Method.GetParameters();
                if (ps.Length == 1 && ps[0].ParameterType == typeof(object[]) && ps[0].GetCustomAttribute<ParamArrayAttribute>() != null)
                    return JsRuntime.Normalize(d.DynamicInvoke(new object?[] { args.Select(a => ToClr(a)).ToArray() }));
                var converted = new object?[ps.Length];
                for (var i = 0; i < ps.Length; i++)
                {
                    converted[i] = i < args.Length ? ConvertArg(args[i], ps[i].ParameterType) : (ps[i].HasDefaultValue ? ps[i].DefaultValue : DefaultOf(ps[i].ParameterType));
                }
                return JsRuntime.Normalize(d.DynamicInvoke(converted));
            }

            private static object? DefaultOf(Type t) => t.IsValueType ? Activator.CreateInstance(t) : null;

            private object? ConvertArg(object? value, Type target)
            {
                value = ToClr(value);
                if (value == null) return DefaultOf(target);
                if (target.IsInstanceOfType(value)) return value;
                var underlying = Nullable.GetUnderlyingType(target) ?? target;
                if (underlying == typeof(string)) return JsRuntime.ToJsString(value);
                if (underlying == typeof(bool)) return JsRuntime.Truthy(value);
                if (underlying == typeof(Guid)) return Guid.Parse(JsRuntime.ToJsString(value));
                if (underlying == typeof(DateTime)) return value is DateTime dt ? dt : Builtins.NewDate(new[] { value });
                if (underlying == typeof(DateTimeOffset)) return new DateTimeOffset(value is DateTime d2 ? d2 : Builtins.NewDate(new[] { value }));
                if (underlying.IsEnum) return Enum.Parse(underlying, JsRuntime.ToJsString(value), true);
                if (underlying.IsPrimitive || underlying == typeof(decimal))
                    return Convert.ChangeType(JsRuntime.ToNumber(value), underlying, System.Globalization.CultureInfo.InvariantCulture);
                throw Fail($"Cannot convert argument to {target.Name}");
            }
        }
    }
}
