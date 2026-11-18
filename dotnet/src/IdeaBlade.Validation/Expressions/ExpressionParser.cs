using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace IdeaBlade.Validation.Expressions
{
    /// <summary>Parses validation expressions into an AST. Port of js/src/expressions/parser.ts.</summary>
    public static class ExpressionParser
    {
        internal const int MaxDepth = 200;

        internal static readonly HashSet<string> NewAllowed = new HashSet<string>(StringComparer.Ordinal) { "Date" };

        /// <summary>Parses an expression. Throws <see cref="ExpressionSyntaxException"/> on invalid or unsupported syntax.</summary>
        public static ExpressionNode Parse(string source)
        {
            if (source == null) throw new ExpressionSyntaxException("Expression must be a string", "", 0);
            return new Parser(source).Parse();
        }

        private enum TokenType { Num, Str, Ident, Punct, Regex, Eof }

        private sealed class Token
        {
            public TokenType Type;
            public string Value = "";
            public object? Literal;
            public string Flags = "";
            public int Pos;
        }

        private static readonly string[] Punctuators =
        {
            "===", "!==", "...",
            "=>", "?.", "??", "==", "!=", "<=", ">=", "&&", "||",
            "(", ")", "[", "]", "{", "}", ",", ".", "?", ":", "!", "+", "-", "*", "/", "%", "<", ">", "=",
        };

        private static readonly Dictionary<string, object?> KeywordLiterals = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["true"] = true,
            ["false"] = false,
            ["null"] = null,
            ["undefined"] = Undefined.Value,
        };

        private static readonly HashSet<string> ForbiddenWords = new HashSet<string>(StringComparer.Ordinal)
        {
            "function", "class", "var", "let", "const", "return", "if", "else", "for", "while", "do",
            "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "delete", "void",
            "this", "super", "import", "export", "yield", "await", "async", "with", "debugger", "in",
            "instanceof", "eval", "arguments",
        };

        private static bool IsIdentStart(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$';
        private static bool IsIdentPart(char c) => IsIdentStart(c) || (c >= '0' && c <= '9');
        private static bool IsDigit(char c) => c >= '0' && c <= '9';
        private static bool IsHexDigit(char c) => IsDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

        private sealed class Lexer
        {
            private readonly string _src;
            private int _pos;
            private Token? _last;

            public Lexer(string src) { _src = src; }

            public List<Token> Tokenize()
            {
                var tokens = new List<Token>();
                while (true)
                {
                    var t = Next();
                    tokens.Add(t);
                    _last = t;
                    if (t.Type == TokenType.Eof) return tokens;
                }
            }

            private Exception Error(string message, int? pos = null) => new ExpressionSyntaxException(message, _src, pos ?? _pos);

            private char At(int i) => i < _src.Length ? _src[i] : '\0';

            private bool RegexAllowed()
            {
                var t = _last;
                if (t == null) return true;
                if (t.Type == TokenType.Num || t.Type == TokenType.Str || t.Type == TokenType.Regex) return false;
                if (t.Type == TokenType.Ident) return t.Value == "typeof";
                return !(t.Value == ")" || t.Value == "]" || t.Value == "}");
            }

            private Token Next()
            {
                while (_pos < _src.Length && char.IsWhiteSpace(_src[_pos])) _pos++;
                var start = _pos;
                if (_pos >= _src.Length) return new Token { Type = TokenType.Eof, Pos = start };
                var ch = _src[_pos];

                if (IsDigit(ch) || (ch == '.' && IsDigit(At(_pos + 1)))) return ReadNumber();
                if (ch == '"' || ch == '\'' || ch == '`') return ReadString(ch);
                if (IsIdentStart(ch))
                {
                    while (_pos < _src.Length && IsIdentPart(_src[_pos])) _pos++;
                    return new Token { Type = TokenType.Ident, Value = _src.Substring(start, _pos - start), Pos = start };
                }
                if (ch == '/' && RegexAllowed()) return ReadRegex();

                foreach (var p in Punctuators)
                {
                    if (string.CompareOrdinal(_src, _pos, p, 0, p.Length) == 0)
                    {
                        if (p == "?." && IsDigit(At(_pos + 2))) continue;
                        _pos += p.Length;
                        return new Token { Type = TokenType.Punct, Value = p, Pos = start };
                    }
                }
                throw Error($"Unexpected character '{ch}'");
            }

            private Token ReadNumber()
            {
                var start = _pos;
                double value;
                if (_src[_pos] == '0' && "xXbBoO".IndexOf(At(_pos + 1)) >= 0)
                {
                    var kind = char.ToLowerInvariant(_src[_pos + 1]);
                    _pos += 2;
                    var digitsStart = _pos;
                    while (_pos < _src.Length && (IsHexDigit(_src[_pos]) || _src[_pos] == '_')) _pos++;
                    var digits = _src.Substring(digitsStart, _pos - digitsStart).Replace("_", "");
                    var radix = kind == 'x' ? 16 : kind == 'b' ? 2 : 8;
                    try
                    {
                        if (digits.Length == 0) throw new FormatException();
                        value = Convert.ToInt64(digits, radix);
                    }
                    catch (Exception)
                    {
                        throw Error($"Invalid number literal '{_src.Substring(start, _pos - start)}'", start);
                    }
                }
                else
                {
                    while (_pos < _src.Length && (IsDigit(_src[_pos]) || _src[_pos] == '_')) _pos++;
                    if (At(_pos) == '.')
                    {
                        _pos++;
                        while (_pos < _src.Length && (IsDigit(_src[_pos]) || _src[_pos] == '_')) _pos++;
                    }
                    if (At(_pos) == 'e' || At(_pos) == 'E')
                    {
                        _pos++;
                        if (At(_pos) == '+' || At(_pos) == '-') _pos++;
                        while (_pos < _src.Length && IsDigit(_src[_pos])) _pos++;
                    }
                    var text = _src.Substring(start, _pos - start).Replace("_", "");
                    if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                        throw Error($"Invalid number literal '{text}'", start);
                }
                if (_pos < _src.Length && IsIdentPart(_src[_pos]))
                    throw Error($"Invalid number literal '{_src.Substring(start, _pos - start + 1)}'", start);
                return new Token { Type = TokenType.Num, Value = _src.Substring(start, _pos - start), Literal = value, Pos = start };
            }

            private Token ReadString(char quote)
            {
                var start = _pos;
                _pos++;
                var sb = new StringBuilder();
                while (_pos < _src.Length)
                {
                    var ch = _src[_pos];
                    if (ch == quote)
                    {
                        _pos++;
                        return new Token { Type = TokenType.Str, Value = _src.Substring(start, _pos - start), Literal = sb.ToString(), Pos = start };
                    }
                    if (quote == '`' && ch == '$' && At(_pos + 1) == '{')
                        throw Error("Template literal interpolation (${...}) is not supported; use string concatenation");
                    if (ch == '\\')
                    {
                        if (_pos + 1 >= _src.Length) throw Error("Unterminated string literal", start);
                        var esc = _src[_pos + 1];
                        _pos += 2;
                        switch (esc)
                        {
                            case 'n': sb.Append('\n'); break;
                            case 't': sb.Append('\t'); break;
                            case 'r': sb.Append('\r'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'v': sb.Append('\v'); break;
                            case '0': sb.Append('\0'); break;
                            case 'u':
                            case 'x':
                                {
                                    var len = esc == 'u' ? 4 : 2;
                                    var hex = _pos + len <= _src.Length ? _src.Substring(_pos, len) : "";
                                    if (hex.Length != len || !hex.All(IsHexDigit))
                                        throw Error(esc == 'u' ? "Invalid unicode escape" : "Invalid hex escape");
                                    sb.Append((char)Convert.ToInt32(hex, 16));
                                    _pos += len;
                                    break;
                                }
                            default: sb.Append(esc); break;
                        }
                        continue;
                    }
                    if ((ch == '\n' || ch == '\r') && quote != '`') throw Error("Unterminated string literal", start);
                    sb.Append(ch);
                    _pos++;
                }
                throw Error("Unterminated string literal", start);
            }

            private Token ReadRegex()
            {
                var start = _pos;
                _pos++;
                var inClass = false;
                var pattern = new StringBuilder();
                while (_pos < _src.Length)
                {
                    var ch = _src[_pos];
                    if (ch == '\\')
                    {
                        pattern.Append(ch);
                        if (_pos + 1 < _src.Length) pattern.Append(_src[_pos + 1]);
                        _pos += 2;
                        continue;
                    }
                    if (ch == '\n') break;
                    if (ch == '[') inClass = true;
                    else if (ch == ']') inClass = false;
                    else if (ch == '/' && !inClass)
                    {
                        _pos++;
                        var flagsStart = _pos;
                        while (_pos < _src.Length && _src[_pos] >= 'a' && _src[_pos] <= 'z') _pos++;
                        var flags = _src.Substring(flagsStart, _pos - flagsStart);
                        if (flags.Any(f => "gimsuy".IndexOf(f) < 0) || flags.Distinct().Count() != flags.Length)
                            throw Error($"Invalid regular expression flags '{flags}'", start);
                        try
                        {
                            JsRegExp.Create(pattern.ToString(), flags);
                        }
                        catch (Exception e) when (!(e is ExpressionSyntaxException))
                        {
                            throw Error($"Invalid regular expression: {e.Message}", start);
                        }
                        return new Token { Type = TokenType.Regex, Value = pattern.ToString(), Flags = flags, Pos = start };
                    }
                    pattern.Append(ch);
                    _pos++;
                }
                throw Error("Unterminated regular expression literal", start);
            }
        }

        private sealed class Parser
        {
            private readonly string _src;
            private readonly List<Token> _tokens;
            private int _index;
            private int _depth;

            public Parser(string src)
            {
                _src = src;
                _tokens = new Lexer(src).Tokenize();
            }

            public ExpressionNode Parse()
            {
                if (Peek().Type == TokenType.Eof) throw Error("Expression is empty");
                var node = ParseExpression();
                if (Peek().Type != TokenType.Eof) throw Error($"Unexpected token '{Peek().Value}'");
                return node;
            }

            private Token Peek(int offset = 0) => _tokens[Math.Min(_index + offset, _tokens.Count - 1)];
            private Token Advance() => _tokens[_index++];
            private bool IsPunct(string value, int offset = 0) { var t = Peek(offset); return t.Type == TokenType.Punct && t.Value == value; }

            private bool EatPunct(string value)
            {
                if (!IsPunct(value)) return false;
                _index++;
                return true;
            }

            private void ExpectPunct(string value)
            {
                if (EatPunct(value)) return;
                var t = Peek();
                throw Error(t.Type == TokenType.Eof ? $"Expected '{value}' but reached end of expression" : $"Expected '{value}' but found '{t.Value}'");
            }

            private ExpressionSyntaxException Error(string message, int? pos = null) => new ExpressionSyntaxException(message, _src, pos ?? Peek().Pos);

            private void Enter()
            {
                if (++_depth > MaxDepth) throw Error("Expression is nested too deeply");
            }

            private ExpressionNode ParseExpression()
            {
                Enter();
                try
                {
                    if (IsPunct("=")) throw Error("Assignment is not allowed; did you mean '==='?");
                    if (IsArrowAhead()) return ParseArrow();
                    return ParseConditional();
                }
                finally { _depth--; }
            }

            private bool IsArrowAhead()
            {
                if (Peek().Type == TokenType.Ident && IsPunct("=>", 1)) return true;
                if (!IsPunct("(")) return false;
                var depth = 0;
                for (var i = _index; i < _tokens.Count; i++)
                {
                    var tok = _tokens[i];
                    if (tok.Type == TokenType.Punct && tok.Value == "(") depth++;
                    else if (tok.Type == TokenType.Punct && tok.Value == ")")
                    {
                        depth--;
                        if (depth == 0)
                        {
                            var next = i + 1 < _tokens.Count ? _tokens[i + 1] : null;
                            return next != null && next.Type == TokenType.Punct && next.Value == "=>";
                        }
                    }
                    else if (tok.Type == TokenType.Eof) return false;
                }
                return false;
            }

            private ExpressionNode ParseArrow()
            {
                var parameters = new List<string>();
                if (Peek().Type == TokenType.Ident) parameters.Add(ParseBindingName());
                else
                {
                    ExpectPunct("(");
                    if (!IsPunct(")"))
                    {
                        do { parameters.Add(ParseBindingName()); } while (EatPunct(","));
                    }
                    ExpectPunct(")");
                }
                ExpectPunct("=>");
                if (IsPunct("{")) throw Error("Arrow function block bodies are not supported; use an expression body");
                return new ArrowNode(parameters, ParseExpression());
            }

            private string ParseBindingName()
            {
                var t = Advance();
                if (t.Type != TokenType.Ident || KeywordLiterals.ContainsKey(t.Value) || ForbiddenWords.Contains(t.Value) || t.Value == "typeof" || t.Value == "new")
                    throw Error($"Invalid parameter name '{t.Value}'", t.Pos);
                return t.Value;
            }

            private ExpressionNode ParseConditional()
            {
                var test = ParseNullish();
                if (EatPunct("?"))
                {
                    var consequent = ParseExpression();
                    ExpectPunct(":");
                    var alternate = ParseExpression();
                    return new ConditionalNode(test, consequent, alternate);
                }
                return test;
            }

            private ExpressionNode ParseLogical(string op, Func<ExpressionNode> next)
            {
                var left = next();
                while (EatPunct(op)) left = new LogicalNode(op, left, next());
                return left;
            }

            private ExpressionNode ParseNullish() => ParseLogical("??", ParseOr);
            private ExpressionNode ParseOr() => ParseLogical("||", ParseAnd);
            private ExpressionNode ParseAnd() => ParseLogical("&&", ParseEquality);

            private ExpressionNode ParseBinaryLevel(string[] operators, Func<ExpressionNode> next)
            {
                var left = next();
                while (true)
                {
                    var t = Peek();
                    if (t.Type == TokenType.Punct && operators.Contains(t.Value))
                    {
                        _index++;
                        left = new BinaryNode(t.Value, left, next());
                    }
                    else return left;
                }
            }

            private ExpressionNode ParseEquality() => ParseBinaryLevel(new[] { "===", "!==", "==", "!=" }, ParseRelational);
            private ExpressionNode ParseRelational() => ParseBinaryLevel(new[] { "<", "<=", ">", ">=" }, ParseAdditive);
            private ExpressionNode ParseAdditive() => ParseBinaryLevel(new[] { "+", "-" }, ParseMultiplicative);
            private ExpressionNode ParseMultiplicative() => ParseBinaryLevel(new[] { "*", "/", "%" }, ParseUnary);

            private ExpressionNode ParseUnary()
            {
                Enter();
                try
                {
                    var t = Peek();
                    if (t.Type == TokenType.Punct && (t.Value == "!" || t.Value == "-" || t.Value == "+"))
                    {
                        _index++;
                        return new UnaryNode(t.Value, ParseUnary());
                    }
                    if (t.Type == TokenType.Ident && t.Value == "typeof")
                    {
                        _index++;
                        return new UnaryNode("typeof", ParseUnary());
                    }
                    return ParsePostfix();
                }
                finally { _depth--; }
            }

            private ExpressionNode ParsePostfix()
            {
                var node = ParsePrimary();
                var isChain = false;
                while (true)
                {
                    if (IsPunct("."))
                    {
                        _index++;
                        node = MemberByName(node, false);
                    }
                    else if (IsPunct("?."))
                    {
                        _index++;
                        isChain = true;
                        if (EatPunct("(")) node = new CallNode(node, ParseArguments(), true);
                        else if (EatPunct("["))
                        {
                            var property = ParseExpression();
                            ExpectPunct("]");
                            node = new MemberNode(node, property, true, true);
                        }
                        else node = MemberByName(node, true);
                    }
                    else if (EatPunct("["))
                    {
                        var property = ParseExpression();
                        ExpectPunct("]");
                        node = new MemberNode(node, property, true, false);
                    }
                    else if (EatPunct("(")) node = new CallNode(node, ParseArguments(), false);
                    else break;
                }
                return isChain ? new ChainNode(node) : node;
            }

            private MemberNode MemberByName(ExpressionNode obj, bool optional)
            {
                var t = Advance();
                if (t.Type != TokenType.Ident) throw Error($"Expected property name but found '{t.Value}'", t.Pos);
                return new MemberNode(obj, new LiteralNode(t.Value), false, optional);
            }

            private List<ExpressionNode> ParseArguments()
            {
                var args = new List<ExpressionNode>();
                if (EatPunct(")")) return args;
                do
                {
                    if (IsPunct(")")) break;
                    if (IsPunct("...")) throw Error("Spread arguments are not supported");
                    args.Add(ParseExpression());
                } while (EatPunct(","));
                ExpectPunct(")");
                return args;
            }

            private ExpressionNode ParsePrimary()
            {
                var t = Advance();
                switch (t.Type)
                {
                    case TokenType.Num:
                    case TokenType.Str:
                        return new LiteralNode(t.Literal);
                    case TokenType.Regex:
                        return new RegexNode(t.Value, t.Flags);
                    case TokenType.Ident:
                        {
                            if (KeywordLiterals.TryGetValue(t.Value, out var literal)) return new LiteralNode(literal);
                            if (t.Value == "new")
                            {
                                var ctor = Advance();
                                if (ctor.Type != TokenType.Ident || !NewAllowed.Contains(ctor.Value))
                                    throw Error($"'new' is only supported for: {string.Join(", ", NewAllowed)}", ctor.Pos);
                                var args = EatPunct("(") ? ParseArguments() : new List<ExpressionNode>();
                                return new NewNode(ctor.Value, args);
                            }
                            if (ForbiddenWords.Contains(t.Value)) throw Error($"'{t.Value}' is not supported in validation expressions", t.Pos);
                            return new IdentifierNode(t.Value);
                        }
                    case TokenType.Punct:
                        {
                            if (t.Value == "(")
                            {
                                var expr = ParseExpression();
                                ExpectPunct(")");
                                return expr;
                            }
                            if (t.Value == "[")
                            {
                                var elements = new List<ExpressionNode>();
                                while (!IsPunct("]"))
                                {
                                    if (IsPunct("...")) throw Error("Spread elements are not supported");
                                    elements.Add(ParseExpression());
                                    if (!EatPunct(",")) break;
                                }
                                ExpectPunct("]");
                                return new ArrayNode(elements);
                            }
                            if (t.Value == "{")
                            {
                                var properties = new List<KeyValuePair<string, ExpressionNode>>();
                                while (!IsPunct("}"))
                                {
                                    var keyTok = Advance();
                                    string key;
                                    if (keyTok.Type == TokenType.Ident || keyTok.Type == TokenType.Str) key = keyTok.Literal as string ?? keyTok.Value;
                                    else if (keyTok.Type == TokenType.Num) key = JsRuntime.ToJsString(keyTok.Literal);
                                    else throw Error($"Invalid object key '{keyTok.Value}'", keyTok.Pos);
                                    if (key == "__proto__") throw Error("Object key '__proto__' is not allowed", keyTok.Pos);
                                    ExpressionNode value;
                                    if (EatPunct(":")) value = ParseExpression();
                                    else if (keyTok.Type == TokenType.Ident) value = new IdentifierNode(key);
                                    else throw Error("Expected ':'");
                                    properties.Add(new KeyValuePair<string, ExpressionNode>(key, value));
                                    if (!EatPunct(",")) break;
                                }
                                ExpectPunct("}");
                                return new ObjectNode(properties);
                            }
                            if (t.Value == "=") throw Error("Assignment is not allowed; did you mean '==='?", t.Pos);
                            throw Error($"Unexpected token '{t.Value}'", t.Pos);
                        }
                    default:
                        throw Error("Unexpected end of expression", t.Pos);
                }
            }
        }
    }
}
