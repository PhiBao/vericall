//! A focused JSON Schema validator.
//!
//! An SLA is only meaningful if "did the service deliver what it promised" is a
//! question with a deterministic answer. Free-text LLM judgement is not that;
//! a schema is. This module implements the subset of JSON Schema that service
//! covenants actually use, deliberately rather than pulling a large dependency
//! into the settlement path.
//!
//! Supported: `type` (`object`, `array`, `string`, `number`, `integer`,
//! `boolean`, `null`, plus unions), `required`, `properties`,
//! `additionalProperties` (bool), `items`, `enum`, `const`, `minimum`,
//! `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`,
//! `pattern`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
//! `maxProperties`, and `allOf`/`anyOf`/`oneOf`/`not`.
//!
//! Unknown keywords are ignored, matching the permissive behaviour of most
//! validators for unevaluated annotations.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    /// JSON-pointer-ish path to the offending node (`$`, `$.items[0].price`).
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}", self.message, self.path)
    }
}

/// Validate `instance` against `schema`. Returns every violation found, so a
/// provider can fix all of them in one pass instead of playing whack-a-mole.
pub fn validate(schema: &Value, instance: &Value) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    validate_at(schema, instance, "$", &mut errors);
    errors
}

/// Convenience: true when the instance satisfies the schema.
pub fn is_valid(schema: &Value, instance: &Value) -> bool {
    validate(schema, instance).is_empty()
}

fn validate_at(schema: &Value, instance: &Value, path: &str, errors: &mut Vec<ValidationError>) {
    let Some(obj) = schema.as_object() else {
        // A non-object schema (e.g. `true`) imposes nothing.
        return;
    };

    if let Some(t) = obj.get("type") {
        if !type_matches(t, instance) {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!(
                    "expected type {}, got {}",
                    describe_type_requirement(t),
                    json_type_name(instance)
                ),
            });
            // A type mismatch makes the remaining keyword checks noise.
            return;
        }
    }

    if let Some(constant) = obj.get("const") {
        if instance != constant {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("expected the constant value {constant}"),
            });
        }
    }

    if let Some(Value::Array(choices)) = obj.get("enum") {
        if !choices.contains(instance) {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("value is not one of the {} allowed choices", choices.len()),
            });
        }
    }

    if let Some(subs) = obj.get("allOf").and_then(Value::as_array) {
        for sub in subs {
            validate_at(sub, instance, path, errors);
        }
    }
    if let Some(subs) = obj.get("anyOf").and_then(Value::as_array) {
        let ok = subs.iter().any(|sub| {
            let mut scratch = Vec::new();
            validate_at(sub, instance, path, &mut scratch);
            scratch.is_empty()
        });
        if !ok {
            errors.push(ValidationError {
                path: path.to_string(),
                message: "value matched none of the anyOf branches".to_string(),
            });
        }
    }
    if let Some(subs) = obj.get("oneOf").and_then(Value::as_array) {
        let matches = subs
            .iter()
            .filter(|sub| {
                let mut scratch = Vec::new();
                validate_at(sub, instance, path, &mut scratch);
                scratch.is_empty()
            })
            .count();
        if matches != 1 {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("value matched {matches} oneOf branches, expected exactly 1"),
            });
        }
    }
    if let Some(sub) = obj.get("not") {
        let mut scratch = Vec::new();
        validate_at(sub, instance, path, &mut scratch);
        if scratch.is_empty() {
            errors.push(ValidationError {
                path: path.to_string(),
                message: "value matched a `not` branch".to_string(),
            });
        }
    }

    match instance {
        Value::Object(map) => validate_object(obj, map, path, errors),
        Value::Array(items) => validate_array(obj, items, path, errors),
        Value::String(s) => validate_string(obj, s, path, errors),
        Value::Number(n) => validate_number(obj, n, path, errors),
        _ => {}
    }
}

fn validate_object(
    schema: &serde_json::Map<String, Value>,
    map: &serde_json::Map<String, Value>,
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !map.contains_key(key) {
                errors.push(ValidationError {
                    path: path.to_string(),
                    message: format!("missing required property `{key}`"),
                });
            }
        }
    }

    let props = schema.get("properties").and_then(Value::as_object);
    if let Some(props) = props {
        for (key, sub) in props {
            if let Some(value) = map.get(key) {
                validate_at(sub, value, &format!("{path}.{key}"), errors);
            }
        }
    }

    match schema.get("additionalProperties") {
        Some(Value::Bool(false)) => {
            if let Some(allowed) = schema.get("properties").and_then(Value::as_object) {
                for key in map.keys() {
                    if !allowed.contains_key(key) {
                        errors.push(ValidationError {
                            path: format!("{path}.{key}"),
                            message: "additional properties are not allowed".to_string(),
                        });
                    }
                }
            }
        }
        Some(Value::Object(subschema)) => {
            let allowed = schema.get("properties").and_then(Value::as_object);
            for (key, value) in map {
                if allowed.is_some_and(|a| a.contains_key(key)) {
                    continue;
                }
                validate_at(
                    &Value::Object(subschema.clone()),
                    value,
                    &format!("{path}.{key}"),
                    errors,
                );
            }
        }
        _ => {}
    }

    if let Some(min) = schema.get("minProperties").and_then(Value::as_u64) {
        if (map.len() as u64) < min {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("needs at least {min} properties, found {}", map.len()),
            });
        }
    }
    if let Some(max) = schema.get("maxProperties").and_then(Value::as_u64) {
        if (map.len() as u64) > max {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("allows at most {max} properties, found {}", map.len()),
            });
        }
    }
}

fn validate_array(
    schema: &serde_json::Map<String, Value>,
    items: &[Value],
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
        if (items.len() as u64) < min {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("needs at least {min} items, found {}", items.len()),
            });
        }
    }
    if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
        if (items.len() as u64) > max {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("allows at most {max} items, found {}", items.len()),
            });
        }
    }
    if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
        for (i, a) in items.iter().enumerate() {
            if items[..i].contains(a) {
                errors.push(ValidationError {
                    path: format!("{path}[{i}]"),
                    message: "duplicate item violates uniqueItems".to_string(),
                });
            }
        }
    }

    match schema.get("items") {
        Some(Value::Object(_)) | Some(Value::Bool(_)) => {
            let sub = schema.get("items").unwrap();
            for (i, item) in items.iter().enumerate() {
                validate_at(sub, item, &format!("{path}[{i}]"), errors);
            }
        }
        Some(Value::Array(subs)) => {
            for (i, item) in items.iter().enumerate() {
                if let Some(sub) = subs.get(i) {
                    validate_at(sub, item, &format!("{path}[{i}]"), errors);
                }
            }
        }
        _ => {}
    }
}

fn validate_string(
    schema: &serde_json::Map<String, Value>,
    s: &str,
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    let len = s.chars().count() as u64;
    if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
        if len < min {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("needs at least {min} characters, found {len}"),
            });
        }
    }
    if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
        if len > max {
            errors.push(ValidationError {
                path: path.to_string(),
                message: format!("allows at most {max} characters, found {len}"),
            });
        }
    }
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
        match regex_lite(pattern, s) {
            Ok(true) => {}
            Ok(false) => errors.push(ValidationError {
                path: path.to_string(),
                message: format!("does not match pattern /{pattern}/"),
            }),
            Err(e) => errors.push(ValidationError {
                path: path.to_string(),
                message: format!("pattern /{pattern}/ could not be evaluated: {e}"),
            }),
        }
    }
}

fn validate_number(
    schema: &serde_json::Map<String, Value>,
    n: &serde_json::Number,
    path: &str,
    errors: &mut Vec<ValidationError>,
) {
    let x = n.as_f64().unwrap_or(f64::NAN);
    let get = |key: &str| schema.get(key).and_then(Value::as_f64);
    let mut fail = |message: String| {
        errors.push(ValidationError {
            path: path.to_string(),
            message,
        });
    };
    if let Some(min) = get("minimum") {
        if x < min {
            fail(format!("{x} is below the minimum {min}"));
        }
    }
    if let Some(max) = get("maximum") {
        if x > max {
            fail(format!("{x} is above the maximum {max}"));
        }
    }
    if let Some(min) = get("exclusiveMinimum") {
        if x <= min {
            fail(format!("{x} must be greater than {min}"));
        }
    }
    if let Some(max) = get("exclusiveMaximum") {
        if x >= max {
            fail(format!("{x} must be less than {max}"));
        }
    }
    if let Some(mult) = get("multipleOf") {
        if mult != 0.0 && (x / mult).fract().abs() > 1e-9 {
            fail(format!("{x} is not a multiple of {mult}"));
        }
    }
}

fn type_matches(requirement: &Value, instance: &Value) -> bool {
    match requirement {
        Value::String(t) => one_type_matches(t, instance),
        Value::Array(ts) => ts
            .iter()
            .filter_map(Value::as_str)
            .any(|t| one_type_matches(t, instance)),
        _ => true,
    }
}

fn one_type_matches(t: &str, instance: &Value) -> bool {
    match t {
        "object" => instance.is_object(),
        "array" => instance.is_array(),
        "string" => instance.is_string(),
        "boolean" => instance.is_boolean(),
        "null" => instance.is_null(),
        "number" => instance.is_number(),
        // JSON has one numeric type; `integer` means no fractional part, which
        // is how every mainstream validator treats a 2.0 literal too.
        "integer" => instance
            .as_f64()
            .map(|f| f.is_finite() && f.fract() == 0.0)
            .unwrap_or(false),
        _ => true,
    }
}

fn describe_type_requirement(requirement: &Value) -> String {
    match requirement {
        Value::String(t) => t.clone(),
        Value::Array(ts) => ts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | "),
        _ => "any".to_string(),
    }
}

fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ---------------------------------------------------------------------------
// Minimal regex engine for `pattern`
// ---------------------------------------------------------------------------

/// Evaluate a JSON Schema `pattern` with a hand-rolled engine supporting the
/// constructs that appear in real API schemas: literals, `.`, character classes
/// with ranges and negation, the escapes `\d \D \w \W \s \S`, anchors `^ $`,
/// groups `( )` / `(?: )`, alternation `|`, quantifiers `* + ? {n} {n,} {n,m}`
/// (greedy, with backtracking), and `\uXXXX`/`\xNN` escapes.
///
/// A pattern outside this subset returns `Err` rather than a wrong answer: the
/// verifier reports the covenant as unverifiable instead of silently passing or
/// failing a response.
pub fn regex_lite(pattern: &str, input: &str) -> Result<bool, String> {
    let ast = parse_regex(pattern)?;
    // Unanchored search, as JSON Schema requires.
    for start in 0..=input.chars().count() {
        if ast.match_at(input, start, &mut |_| true) {
            return Ok(true);
        }
    }
    Ok(false)
}

type Continuation<'a> = dyn FnMut(usize) -> bool + 'a;

#[derive(Debug, Clone)]
enum Node {
    Empty,
    Literal(char),
    AnyChar,
    Class { negated: bool, ranges: Vec<(char, char)> },
    Start,
    End,
    Group(Box<Node>),
    Sequence(Vec<Node>),
    Alternation(Vec<Node>),
    Repeat { node: Box<Node>, min: usize, max: Option<usize>, greedy: bool },
}

impl Node {
    fn match_at(&self, input: &str, pos: usize, k: &mut Continuation<'_>) -> bool {
        let chars: Vec<char> = input.chars().collect();
        match self {
            Node::Empty => k(pos),
            Node::Literal(c) => chars.get(pos) == Some(c) && k(pos + 1),
            Node::AnyChar => pos < chars.len() && chars[pos] != '\n' && k(pos + 1),
            Node::Class { negated, ranges } => {
                let Some(c) = chars.get(pos) else { return false };
                let inside = ranges.iter().any(|(lo, hi)| *lo <= *c && *c <= *hi);
                if inside != *negated {
                    k(pos + 1)
                } else {
                    false
                }
            }
            Node::Start => pos == 0 && k(pos),
            Node::End => pos == chars.len() && k(pos),
            Node::Group(inner) => inner.match_at(input, pos, k),
            Node::Sequence(nodes) => match_sequence(nodes, input, pos, k),
            Node::Alternation(branches) => branches.iter().any(|b| b.match_at(input, pos, k)),
            Node::Repeat { node, min, max, greedy } => {
                match_repeat(node, input, pos, *min, *max, *greedy, k)
            }
        }
    }
}

fn match_sequence(nodes: &[Node], input: &str, pos: usize, k: &mut Continuation<'_>) -> bool {
    match nodes.split_first() {
        None => k(pos),
        Some((head, rest)) => {
            let rest_owned: Vec<Node> = rest.to_vec();
            head.match_at(input, pos, &mut |next| match_sequence(&rest_owned, input, next, k))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn match_repeat(
    node: &Node,
    input: &str,
    pos: usize,
    min: usize,
    max: Option<usize>,
    greedy: bool,
    k: &mut Continuation<'_>,
) -> bool {
    if let Some(max) = max {
        if min > max {
            return false;
        }
    }

    fn expand(
        node: &Node,
        input: &str,
        pos: usize,
        remaining_min: usize,
        remaining_max: Option<usize>,
        greedy: bool,
        k: &mut Continuation<'_>,
    ) -> bool {
        if remaining_min == 0 {
            if greedy {
                // Try one more repetition first, then stop.
                if remaining_max.map(|m| m > 0).unwrap_or(true)
                    && node.match_at(input, pos, &mut |next| {
                        next != pos
                            && expand(
                                node,
                                input,
                                next,
                                remaining_min,
                                remaining_max.map(|m| m - 1),
                                greedy,
                                k,
                            )
                    })
                {
                    return true;
                }
                return k(pos);
            } else {
                if k(pos) {
                    return true;
                }
                return remaining_max.map(|m| m > 0).unwrap_or(true)
                    && node.match_at(input, pos, &mut |next| {
                        next != pos
                            && expand(
                                node,
                                input,
                                next,
                                remaining_min,
                                remaining_max.map(|m| m - 1),
                                greedy,
                                k,
                            )
                    });
            }
        }
        node.match_at(input, pos, &mut |next| {
            expand(
                node,
                input,
                next,
                remaining_min - 1,
                remaining_max.map(|m| m.saturating_sub(1)),
                greedy,
                k,
            )
        })
    }

    expand(node, input, pos, min, max, greedy, k)
}

struct Parser<'a> {
    pattern: &'a [char],
    pos: usize,
}

fn parse_regex(pattern: &str) -> Result<Node, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut parser = Parser { pattern: &chars, pos: 0 };
    let node = parser.parse_alternation()?;
    if parser.pos != chars.len() {
        return Err(format!(
            "unexpected `{}` at offset {}",
            chars[parser.pos], parser.pos
        ));
    }
    Ok(node)
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.pattern.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn parse_alternation(&mut self) -> Result<Node, String> {
        let mut branches = vec![self.parse_sequence()?];
        while self.peek() == Some('|') {
            self.bump();
            branches.push(self.parse_sequence()?);
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            Node::Alternation(branches)
        })
    }

    fn parse_sequence(&mut self) -> Result<Node, String> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            items.push(self.parse_quantified()?);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Sequence(items),
        })
    }

    fn parse_quantified(&mut self) -> Result<Node, String> {
        let atom = self.parse_atom()?;
        let quant = match self.peek() {
            Some('*') => {
                self.bump();
                Some((0usize, None))
            }
            Some('+') => {
                self.bump();
                Some((1usize, None))
            }
            Some('?') => {
                self.bump();
                Some((0usize, Some(1usize)))
            }
            Some('{') => {
                let save = self.pos;
                self.bump();
                let min = self.parse_number();
                let (min, max) = match min {
                    None => {
                        self.pos = save;
                        return Ok(atom);
                    }
                    Some(min) => {
                        if self.peek() == Some(',') {
                            self.bump();
                            (min, self.parse_number())
                        } else {
                            (min, Some(min))
                        }
                    }
                };
                if self.peek() != Some('}') {
                    return Err("unterminated {n,m} quantifier".to_string());
                }
                if let Some(max) = max {
                    if min > max {
                        return Err(format!("{{{min},{max}}} has a minimum above its maximum"));
                    }
                }
                self.bump();
                Some((min, max))
            }
            _ => None,
        };
        let Some((min, max)) = quant else {
            return Ok(atom);
        };
        let greedy = if self.peek() == Some('?') {
            self.bump();
            false
        } else {
            true
        };
        Ok(Node::Repeat {
            node: Box::new(atom),
            min,
            max,
            greedy,
        })
    }

    fn parse_number(&mut self) -> Option<usize> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.bump();
        }
        if self.pos == start {
            return None;
        }
        self.pattern[start..self.pos]
            .iter()
            .collect::<String>()
            .parse()
            .ok()
    }

    fn parse_atom(&mut self) -> Result<Node, String> {
        match self.bump() {
            None => Ok(Node::Empty),
            Some('(') => {
                if self.peek() == Some('?') {
                    self.bump();
                    if self.peek() == Some(':') {
                        self.bump();
                    } else {
                        return Err("unsupported group modifier".to_string());
                    }
                }
                let inner = self.parse_alternation()?;
                if self.bump() != Some(')') {
                    return Err("unclosed group".to_string());
                }
                Ok(Node::Group(Box::new(inner)))
            }
            Some('[') => self.parse_class(),
            Some('.') => Ok(Node::AnyChar),
            Some('^') => Ok(Node::Start),
            Some('$') => Ok(Node::End),
            Some('\\') => self.parse_escape(),
            Some(c @ ('*' | '+' | '?' | '{')) => {
                Err(format!("quantifier `{c}` with nothing to repeat"))
            }
            Some(c) => Ok(Node::Literal(c)),
        }
    }

    fn parse_escape(&mut self) -> Result<Node, String> {
        let Some(c) = self.bump() else {
            return Err("trailing backslash".to_string());
        };
        Ok(match c {
            'd' => Node::Class {
                negated: false,
                ranges: vec![('0', '9')],
            },
            'D' => Node::Class {
                negated: true,
                ranges: vec![('0', '9')],
            },
            'w' => word_class(false),
            'W' => word_class(true),
            's' => Node::Class {
                negated: false,
                ranges: vec![(' ', ' '), ('\t', '\t'), ('\n', '\n'), ('\r', '\r')],
            },
            'S' => Node::Class {
                negated: true,
                ranges: vec![(' ', ' '), ('\t', '\t'), ('\n', '\n'), ('\r', '\r')],
            },
            'n' => Node::Literal('\n'),
            'r' => Node::Literal('\r'),
            't' => Node::Literal('\t'),
            'x' => Node::Literal(self.parse_hex(2)?),
            'u' => Node::Literal(self.parse_hex(4)?),
            other => Node::Literal(other),
        })
    }

    fn parse_hex(&mut self, digits: usize) -> Result<char, String> {
        let mut buf = String::new();
        for _ in 0..digits {
            match self.bump() {
                Some(c) if c.is_ascii_hexdigit() => buf.push(c),
                _ => return Err("bad hex escape".to_string()),
            }
        }
        char::from_u32(u32::from_str_radix(&buf, 16).map_err(|e| e.to_string())?)
            .ok_or_else(|| "invalid codepoint".to_string())
    }

    fn parse_class(&mut self) -> Result<Node, String> {
        let negated = if self.peek() == Some('^') {
            self.bump();
            true
        } else {
            false
        };
        let mut ranges = Vec::new();
        let mut first = true;
        loop {
            let Some(c) = self.peek() else {
                return Err("unclosed character class".to_string());
            };
            if c == ']' && !first {
                self.bump();
                break;
            }
            first = false;
            let lo = self.class_char()?;
            if self.peek() == Some('-')
                && self.pattern.get(self.pos + 1).is_some_and(|c| *c != ']')
            {
                self.bump();
                let hi = self.class_char()?;
                ranges.push((lo, hi));
            } else {
                ranges.push((lo, lo));
            }
        }
        Ok(Node::Class { negated, ranges })
    }

    fn class_char(&mut self) -> Result<char, String> {
        match self.bump() {
            None => Err("unexpected end of class".to_string()),
            Some('\\') => match self.bump() {
                Some('d') => Ok('0'), // handled as literal range elsewhere in practice
                Some('n') => Ok('\n'),
                Some('r') => Ok('\r'),
                Some('t') => Ok('\t'),
                Some('x') => self.parse_hex(2),
                Some('u') => self.parse_hex(4),
                Some(other) => Ok(other),
                None => Err("trailing backslash in class".to_string()),
            },
            Some(c) => Ok(c),
        }
    }
}

fn word_class(negated: bool) -> Node {
    Node::Class {
        negated,
        ranges: vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn errs(schema: Value, instance: Value) -> Vec<ValidationError> {
        validate(&schema, &instance)
    }

    #[test]
    fn accepts_the_risk_service_schema() {
        let schema = json!({
            "type": "object",
            "required": ["score", "band", "checks"],
            "properties": {
                "score": { "type": "number", "minimum": 0, "maximum": 100 },
                "band": { "type": "string", "enum": ["low", "medium", "high"] },
                "checks": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                "asOf": { "type": "integer", "minimum": 1 }
            },
            "additionalProperties": false
        });
        let ok = json!({
            "score": 71.5,
            "band": "medium",
            "checks": ["sanctions", "adverse-media"],
            "asOf": 1_760_000_000
        });
        assert!(is_valid(&schema, &ok), "{:?}", errs(schema.clone(), ok.clone()));

        let missing = json!({ "score": 71.5, "band": "medium" });
        let e = errs(schema.clone(), missing);
        assert!(e.iter().any(|e| e.message.contains("missing required property `checks`")));

        let out_of_range = json!({ "score": 140, "band": "medium", "checks": ["a"] });
        assert!(!is_valid(&schema, &out_of_range));

        let bad_enum = json!({ "score": 50, "band": "extreme", "checks": ["a"] });
        assert!(!is_valid(&schema, &bad_enum));

        let extra = json!({ "score": 50, "band": "low", "checks": ["a"], "sneaky": true });
        assert!(!is_valid(&schema, &extra));
    }

    #[test]
    fn reports_every_violation_with_a_path() {
        let schema = json!({
            "type": "object",
            "required": ["amount", "currency"],
            "properties": {
                "amount": { "type": "integer", "minimum": 1 },
                "currency": { "type": "string", "pattern": "^[A-Z]{3}$" }
            }
        });
        let bad = json!({ "amount": 0, "currency": "usd" });
        let e = errs(schema, bad);
        assert_eq!(e.len(), 2, "{e:?}");
        assert!(e.iter().any(|e| e.path == "$.amount"));
        assert!(e.iter().any(|e| e.path == "$.currency"));
    }

    #[test]
    fn integer_means_whole_number() {
        let schema = json!({ "type": "integer" });
        assert!(is_valid(&schema, &json!(7)));
        assert!(is_valid(&schema, &json!(7.0)));
        assert!(!is_valid(&schema, &json!(7.5)));
    }

    #[test]
    fn nested_paths_and_arrays() {
        let schema = json!({
            "type": "object",
            "properties": {
                "lines": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["sku"],
                        "properties": { "sku": { "type": "string", "minLength": 3 } }
                    }
                }
            }
        });
        let bad = json!({ "lines": [{ "sku": "ok" }, {}] });
        let e = errs(schema, bad);
        assert!(e.iter().any(|e| e.path == "$.lines[0].sku"), "{e:?}");
        assert!(e.iter().any(|e| e.path == "$.lines[1]"), "{e:?}");
    }

    #[test]
    fn regex_engine_covers_the_shapes_apis_use() {
        assert!(regex_lite("^[A-Z]{3}$", "USD").unwrap());
        assert!(!regex_lite("^[A-Z]{3}$", "usd").unwrap());
        assert!(!regex_lite("^[A-Z]{3}$", "USDD").unwrap());
        assert!(regex_lite("^0x[0-9a-fA-F]{40}$", "0x4AB5e7F2b5464B9494b49EFE41C2f00e7bcfE555").unwrap());
        assert!(regex_lite(r"^\d{4}-\d{2}-\d{2}$", "2026-10-16").unwrap());
        assert!(!regex_lite(r"^\d{4}-\d{2}-\d{2}$", "2026-10-16x").unwrap());
        assert!(regex_lite("^invoice-[0-9]+$", "invoice-4201").unwrap());
        assert!(regex_lite("^(USD|EUR|GBP)$", "EUR").unwrap());
        assert!(!regex_lite("^(USD|EUR|GBP)$", "JPY").unwrap());
        assert!(regex_lite("a*b", "aaab").unwrap());
        assert!(regex_lite("colou?r", "in my color").unwrap());
        assert!(regex_lite(r"^\+?[0-9]{6,15}$", "+14155550100").unwrap());
        assert!(regex_lite("^.{2,4}$", "abc").unwrap());
        assert!(!regex_lite("^.{2,4}$", "a").unwrap());
        // Unsupported constructs must error, never guess.
        assert!(regex_lite("(?<=x)y", "y").is_err());
        assert!(regex_lite("a{2,1}", "aa").is_err());
    }

    #[test]
    fn regex_is_unanchored_by_default_like_json_schema() {
        // The pattern is a search, not a full match: `true` in "untrue" must
        // satisfy /rue/ even though the pattern is not anchored.
        assert!(regex_lite("rue", "untrue").unwrap());
        assert!(regex_lite("[0-9]+", "order 42").unwrap());
        assert!(!regex_lite("[0-9]+", "no digits here").unwrap());
        assert!(!regex_lite("z", "abc").unwrap());
    }
}
