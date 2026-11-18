using System;

namespace IdeaBlade.Validation.Expressions
{
    /// <summary>Thrown when an expression cannot be parsed or uses unsupported syntax.</summary>
    public class ExpressionSyntaxException : Exception
    {
        public ExpressionSyntaxException(string reason, string expression, int position)
            : base($"{reason} (at position {position} in expression: {expression})")
        {
            Reason = reason;
            Expression = expression;
            Position = position;
        }

        public string Reason { get; }
        public string Expression { get; }
        public int Position { get; }
    }

    /// <summary>Thrown when evaluating a syntactically valid expression fails (unknown identifier, disallowed call, step budget exceeded...).</summary>
    public class ExpressionEvaluationException : Exception
    {
        public ExpressionEvaluationException(string reason, string expression, Exception? inner = null)
            : base($"{reason} (in expression: {expression})", inner)
        {
            Reason = reason;
            Expression = expression;
        }

        public string Reason { get; }
        public string Expression { get; }
    }
}
