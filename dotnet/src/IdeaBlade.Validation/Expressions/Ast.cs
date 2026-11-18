using System.Collections.Generic;

namespace IdeaBlade.Validation.Expressions
{
    /// <summary>
    /// AST of the validation expression language: a side-effect-free subset of JavaScript expressions.
    /// Mirrors js/src/expressions/ast.ts.
    /// </summary>
    public abstract class ExpressionNode
    {
        internal ExpressionNode() { }
    }

    public sealed class LiteralNode : ExpressionNode
    {
        /// <summary>string, double, bool, null or <see cref="Undefined.Value"/>.</summary>
        public object? Value { get; }
        public LiteralNode(object? value) { Value = value; }
    }

    public sealed class RegexNode : ExpressionNode
    {
        public string Pattern { get; }
        public string Flags { get; }
        public RegexNode(string pattern, string flags) { Pattern = pattern; Flags = flags; }
    }

    public sealed class IdentifierNode : ExpressionNode
    {
        public string Name { get; }
        public IdentifierNode(string name) { Name = name; }
    }

    public sealed class ArrayNode : ExpressionNode
    {
        public IReadOnlyList<ExpressionNode> Elements { get; }
        public ArrayNode(IReadOnlyList<ExpressionNode> elements) { Elements = elements; }
    }

    public sealed class ObjectNode : ExpressionNode
    {
        public IReadOnlyList<KeyValuePair<string, ExpressionNode>> Properties { get; }
        public ObjectNode(IReadOnlyList<KeyValuePair<string, ExpressionNode>> properties) { Properties = properties; }
    }

    public sealed class MemberNode : ExpressionNode
    {
        public ExpressionNode Object { get; }
        public ExpressionNode Property { get; }
        public bool Computed { get; }
        public bool Optional { get; }
        public MemberNode(ExpressionNode obj, ExpressionNode property, bool computed, bool optional)
        {
            Object = obj; Property = property; Computed = computed; Optional = optional;
        }
    }

    public sealed class CallNode : ExpressionNode
    {
        public ExpressionNode Callee { get; }
        public IReadOnlyList<ExpressionNode> Arguments { get; }
        public bool Optional { get; }
        public CallNode(ExpressionNode callee, IReadOnlyList<ExpressionNode> args, bool optional)
        {
            Callee = callee; Arguments = args; Optional = optional;
        }
    }

    public sealed class NewNode : ExpressionNode
    {
        public string Callee { get; }
        public IReadOnlyList<ExpressionNode> Arguments { get; }
        public NewNode(string callee, IReadOnlyList<ExpressionNode> args) { Callee = callee; Arguments = args; }
    }

    public sealed class UnaryNode : ExpressionNode
    {
        /// <summary>One of <c>!</c>, <c>-</c>, <c>+</c>, <c>typeof</c>.</summary>
        public string Operator { get; }
        public ExpressionNode Argument { get; }
        public UnaryNode(string op, ExpressionNode argument) { Operator = op; Argument = argument; }
    }

    public sealed class BinaryNode : ExpressionNode
    {
        public string Operator { get; }
        public ExpressionNode Left { get; }
        public ExpressionNode Right { get; }
        public BinaryNode(string op, ExpressionNode left, ExpressionNode right) { Operator = op; Left = left; Right = right; }
    }

    public sealed class LogicalNode : ExpressionNode
    {
        /// <summary>One of <c>&amp;&amp;</c>, <c>||</c>, <c>??</c>.</summary>
        public string Operator { get; }
        public ExpressionNode Left { get; }
        public ExpressionNode Right { get; }
        public LogicalNode(string op, ExpressionNode left, ExpressionNode right) { Operator = op; Left = left; Right = right; }
    }

    public sealed class ConditionalNode : ExpressionNode
    {
        public ExpressionNode Test { get; }
        public ExpressionNode Consequent { get; }
        public ExpressionNode Alternate { get; }
        public ConditionalNode(ExpressionNode test, ExpressionNode consequent, ExpressionNode alternate)
        {
            Test = test; Consequent = consequent; Alternate = alternate;
        }
    }

    public sealed class ArrowNode : ExpressionNode
    {
        public IReadOnlyList<string> Parameters { get; }
        public ExpressionNode Body { get; }
        public ArrowNode(IReadOnlyList<string> parameters, ExpressionNode body) { Parameters = parameters; Body = body; }
    }

    /// <summary>Wraps an optional chain so a nullish short-circuit yields undefined for the whole chain.</summary>
    public sealed class ChainNode : ExpressionNode
    {
        public ExpressionNode Expression { get; }
        public ChainNode(ExpressionNode expression) { Expression = expression; }
    }

    /// <summary>The JavaScript <c>undefined</c> value inside the expression interpreter.</summary>
    public sealed class Undefined
    {
        public static readonly Undefined Value = new Undefined();
        private Undefined() { }
        public override string ToString() => "undefined";
    }
}
