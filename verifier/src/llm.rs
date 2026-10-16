//! TypeSafe Jev: a System One model behind an SLA.
//!
//! Two of the published services are model-backed, and the distinction from the
//! other three is the whole point of putting a model under a covenant:
//!
//! * A System One model returns **typed answers and calibrated probabilities**,
//!   not prose. A covenant can therefore require `intentProbability` and
//!   `confidence` in its schema and mean it — a schema over generated text would
//!   be a hope that the model happened to return valid JSON, which is precisely
//!   the failure mode VeriCall exists to price.
//! * Model latency is real latency: hundreds of milliseconds to seconds, and it
//!   moves. A grace SLA of 2.5 s and a hard timeout of 10 s are honest numbers
//!   for a service like this, and a caller who cannot wait that long gets a
//!   rebate rather than a surprise.
//!
//! Policy stays in code. Jev supplies probabilities; thresholds live in
//! [`PolicyThresholds`] where a reader can see them and change them without
//! another inference, which is the guardrails pattern rather than asking a model
//! for a decision.
//!
//! ## What this costs, and who pays
//!
//! Every call spends the operator's TypeSafe credits, and the live deployment is
//! a public endpoint, so the client is bounded three ways: concurrent requests,
//! requests per minute, and a daily budget. When a bound is hit the service fails
//! loudly rather than silently — and because it *is* a service failure, the
//! covenant treats it as one: the caller is refunded and the provider's stake
//! pays the penalty. That is the honest treatment of an operational limit, not a
//! reason to make the limit invisible.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where TypeSafe lives. Overridable so a test can point at a local stub.
pub const DEFAULT_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// The model alias; TypeSafe resolves it to a pinned release.
pub const DEFAULT_MODEL: &str = "jev-latest";

#[derive(Debug, thiserror::Error)]
pub enum JevError {
    #[error("no TypeSafe API key is configured, so a model-backed service cannot run")]
    NoKey,
    #[error("the request to TypeSafe could not be sent: {0}")]
    Transport(String),
    #[error("TypeSafe answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("the response did not contain the answers this service asks for: {0}")]
    Shape(String),
    #[error("the daily TypeSafe budget of {limit} calls is spent; it resets at 00:00 UTC")]
    DailyBudgetSpent { limit: u32 },
    #[error("this service is at its limit of {limit} concurrent model calls; try again shortly")]
    TooManyConcurrent { limit: u32 },
    #[error("the model-backed services are serving {used} calls a minute against a limit of {limit}")]
    RateLimited { used: u32, limit: u32 },
}

/// The bounds a public deployment needs, because every call spends real credits.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub max_concurrent: u32,
    pub per_minute: u32,
    pub daily: u32,
    pub timeout: Duration,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            max_concurrent: 2,
            per_minute: 12,
            daily: 300,
            timeout: Duration::from_secs(20),
        }
    }
}

impl Budget {
    pub fn from_env() -> Self {
        let read = |name: &str, fallback: u32| -> u32 {
            std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
        };
        let defaults = Budget::default();
        Self {
            max_concurrent: read("VERICALL_LLM_MAX_CONCURRENT", defaults.max_concurrent).max(1),
            per_minute: read("VERICALL_LLM_PER_MINUTE", defaults.per_minute).max(1),
            daily: read("VERICALL_LLM_DAILY_BUDGET", defaults.daily).max(1),
            timeout: Duration::from_secs(u64::from(
                read("VERICALL_LLM_TIMEOUT_SECONDS", defaults.timeout.as_secs() as u32).max(5),
            )),
        }
    }
}

struct Counters {
    inflight: u32,
    minute_start: Instant,
    minute_count: u32,
    day_start: Instant,
    day_count: u32,
}

/// One Jev call, described rather than generated.
#[derive(Debug, Clone, Serialize)]
pub struct Question {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub instructions: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Noul {
        noul: f64,
    },
    Choice {
        choice: String,
        probabilities: std::collections::BTreeMap<String, f64>,
        confidence: f64,
    },
    Score {
        score: f64,
        confidence: f64,
    },
}

impl Answer {
    /// A probability, for a Noul. Absent means the answer is the wrong shape,
    /// which is a service failure rather than a zero.
    pub fn probability(&self) -> Result<f64, JevError> {
        match self {
            Answer::Noul { noul } => Ok(noul.clamp(0.0, 1.0)),
            other => Err(JevError::Shape(format!("expected a noul, got {other:?}"))),
        }
    }

    pub fn choice(&self) -> Result<(&str, &std::collections::BTreeMap<String, f64>, f64), JevError> {
        match self {
            Answer::Choice {
                choice,
                probabilities,
                confidence,
            } => Ok((choice.as_str(), probabilities, *confidence)),
            other => Err(JevError::Shape(format!("expected a choice, got {other:?}"))),
        }
    }

    pub fn score(&self) -> Result<f64, JevError> {
        match self {
            Answer::Score { score, .. } => Ok(*score),
            other => Err(JevError::Shape(format!("expected a score, got {other:?}"))),
        }
    }
}

#[derive(Debug, Deserialize)]
struct JevResponse {
    #[serde(default)]
    model: Option<String>,
    answers: std::collections::BTreeMap<String, Answer>,
    #[serde(default)]
    usage: Option<serde_json::Value>,
}

/// The outcome of one inference, kept whole so a service can report what the
/// model actually said rather than only the parts it used.
#[derive(Debug, Clone)]
pub struct Inference {
    pub model: String,
    pub answers: std::collections::BTreeMap<String, Answer>,
    pub usage: Option<serde_json::Value>,
}

impl Inference {
    pub fn answer(&self, id: &str) -> Result<&Answer, JevError> {
        self.answers
            .get(id)
            .ok_or_else(|| JevError::Shape(format!("no answer was returned for `{id}`")))
    }

    pub fn probability(&self, id: &str) -> Result<f64, JevError> {
        self.answer(id)?.probability()
    }

    pub fn score(&self, id: &str) -> Result<f64, JevError> {
        self.answer(id)?.score()
    }
}

#[derive(Clone)]
pub struct JevClient {
    api_key: Option<String>,
    endpoint: String,
    model: String,
    http: reqwest::Client,
    budget: Budget,
    counters: Arc<Mutex<Counters>>,
}

impl JevClient {
    /// Build a client. Without a key the client is inert and every call reports
    /// [`JevError::NoKey`], which lets the rest of the service run and say so
    /// rather than refusing to start.
    pub fn from_env() -> Self {
        let api_key = std::env::var("TYPESAFE_API_KEY").ok().filter(|k| !k.trim().is_empty());
        let endpoint = std::env::var("VERICALL_TYPESAFE_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string());
        let model = std::env::var("VERICALL_TYPESAFE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        let budget = Budget::from_env();
        let http = reqwest::Client::builder()
            .timeout(budget.timeout)
            .user_agent(format!("vericall-verifier/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Self {
            api_key,
            endpoint,
            model,
            http,
            budget,
            counters: Arc::new(Mutex::new(Counters {
                inflight: 0,
                minute_start: Instant::now(),
                minute_count: 0,
                day_start: Instant::now(),
                day_count: 0,
            })),
        }
    }

    pub fn configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub fn budget(&self) -> Budget {
        self.budget
    }

    /// How much of today's budget is left, for the health endpoint.
    pub fn budget_remaining(&self) -> u32 {
        let counters = self.counters.lock().expect("counters lock");
        self.budget.daily.saturating_sub(counters.day_count)
    }

    fn begin(&self) -> Result<(), JevError> {
        let mut counters = self.counters.lock().expect("counters lock");
        let now = Instant::now();
        if now.duration_since(counters.minute_start) >= Duration::from_secs(60) {
            counters.minute_start = now;
            counters.minute_count = 0;
        }
        if now.duration_since(counters.day_start) >= Duration::from_secs(24 * 60 * 60) {
            counters.day_start = now;
            counters.day_count = 0;
        }
        if counters.day_count >= self.budget.daily {
            return Err(JevError::DailyBudgetSpent { limit: self.budget.daily });
        }
        if counters.minute_count >= self.budget.per_minute {
            return Err(JevError::RateLimited {
                used: counters.minute_count,
                limit: self.budget.per_minute,
            });
        }
        if counters.inflight >= self.budget.max_concurrent {
            return Err(JevError::TooManyConcurrent { limit: self.budget.max_concurrent });
        }
        counters.inflight += 1;
        counters.minute_count += 1;
        counters.day_count += 1;
        Ok(())
    }

    fn end(&self) {
        let mut counters = self.counters.lock().expect("counters lock");
        counters.inflight = counters.inflight.saturating_sub(1);
    }

    /// Evaluate `state` against `questions` in one request.
    ///
    /// One request rather than one per question: the docs are explicit that
    /// batching independent questions is dramatically cheaper and faster, and
    /// every question here is about the same state.
    pub async fn evaluate(
        &self,
        state: &serde_json::Value,
        questions: std::collections::BTreeMap<String, Question>,
    ) -> Result<Inference, JevError> {
        let Some(api_key) = self.api_key.as_deref() else {
            return Err(JevError::NoKey);
        };
        self.begin()?;
        let result = self.evaluate_inner(api_key, state, questions).await;
        self.end();
        result
    }

    async fn evaluate_inner(
        &self,
        api_key: &str,
        state: &serde_json::Value,
        questions: std::collections::BTreeMap<String, Question>,
    ) -> Result<Inference, JevError> {
        let body = serde_json::json!({
            "state": state,
            "model": self.model,
            "questions": questions,
        });

        let response = self
            .http
            .post(&self.endpoint)
            .bearer_auth(api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| JevError::Transport(e.to_string()))?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(JevError::Status {
                status: status.as_u16(),
                message: text.chars().take(300).collect(),
            });
        }

        let parsed: JevResponse =
            serde_json::from_str(&text).map_err(|e| JevError::Shape(format!("{e}: {}", text.chars().take(200).collect::<String>())))?;

        Ok(Inference {
            model: parsed.model.unwrap_or_else(|| self.model.clone()),
            answers: parsed.answers,
            usage: parsed.usage,
        })
    }
}

/// Thresholds that turn probabilities into an action.
///
/// In code, not in a prompt: a reader can see the numbers, and changing one does
/// not require another inference. `block_at` is deliberately the stricter of the
/// two so a single high hazard cannot be waved through as a review.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PolicyThresholds {
    pub block_at: f64,
    pub review_at: f64,
}

impl Default for PolicyThresholds {
    fn default() -> Self {
        Self {
            block_at: 0.6,
            review_at: 0.25,
        }
    }
}

impl PolicyThresholds {
    /// The verdict for a set of hazard probabilities.
    pub fn verdict(&self, hazards: &[(String, f64)]) -> &'static str {
        if hazards.iter().any(|(_, p)| *p >= self.block_at) {
            "block"
        } else if hazards.iter().any(|(_, p)| *p >= self.review_at) {
            "review"
        } else {
            "pass"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noul(value: f64) -> Answer {
        Answer::Noul { noul: value }
    }

    #[test]
    fn probabilities_are_clamped_and_only_nouls_answer_them() {
        assert_eq!(noul(0.7).probability().unwrap(), 0.7);
        // The API can return a value a hair outside [0,1] at the extremes; the
        // schema requires a probability, so it is clamped rather than passed on.
        assert_eq!(noul(1.4).probability().unwrap(), 1.0);
        assert_eq!(noul(-0.2).probability().unwrap(), 0.0);
        assert!(Answer::Score { score: 1.0, confidence: 0.9 }.probability().is_err());
    }

    #[test]
    fn thresholds_are_strictest_first() {
        let policy = PolicyThresholds::default();
        assert_eq!(policy.verdict(&[("a".into(), 0.1), ("b".into(), 0.2)]), "pass");
        assert_eq!(policy.verdict(&[("a".into(), 0.1), ("b".into(), 0.3)]), "review");
        // One hazard above the blocking threshold blocks regardless of the rest.
        assert_eq!(policy.verdict(&[("a".into(), 0.1), ("b".into(), 0.9)]), "block");
        // Exactly at a threshold counts as at it, not past it.
        assert_eq!(policy.verdict(&[("a".into(), 0.25)]), "review");
        assert_eq!(policy.verdict(&[("a".into(), 0.6)]), "block");
    }

    #[test]
    fn a_client_without_a_key_reports_that_rather_than_pretending() {
        let previous = std::env::var("TYPESAFE_API_KEY").ok();
        std::env::remove_var("TYPESAFE_API_KEY");
        let client = JevClient::from_env();
        assert!(!client.configured());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime.block_on(client.evaluate(&serde_json::json!("x"), Default::default()));
        assert!(matches!(result, Err(JevError::NoKey)));
        if let Some(value) = previous {
            std::env::set_var("TYPESAFE_API_KEY", value);
        }
    }

    #[test]
    fn the_daily_budget_stops_calls_and_names_the_limit() {
        let mut client = JevClient::from_env();
        client.api_key = Some("test".to_string());
        client.budget.daily = 2;
        assert!(client.begin().is_ok());
        client.end();
        assert!(client.begin().is_ok());
        client.end();
        let third = client.begin();
        assert!(
            matches!(third, Err(JevError::DailyBudgetSpent { limit: 2 })),
            "the budget must refuse the call it cannot afford"
        );
        assert_eq!(client.budget_remaining(), 0);
    }

    #[test]
    fn concurrency_is_bounded() {
        let mut client = JevClient::from_env();
        client.api_key = Some("test".to_string());
        client.budget.max_concurrent = 1;
        assert!(client.begin().is_ok());
        // The slot is held until `end`, so a second call is refused rather than
        // queued: a public endpoint should shed load, not accumulate it.
        assert!(matches!(
            client.begin(),
            Err(JevError::TooManyConcurrent { limit: 1 })
        ));
        client.end();
        assert!(client.begin().is_ok());
    }

    #[test]
    fn a_question_serialises_the_way_the_api_expects() {
        let question = Question {
            kind: "noul",
            instructions: serde_json::json!("Does this name a counterparty?"),
            criteria: Some(serde_json::json!({ "true": "A payee is named", "false": "No payee" })),
        };
        let json = serde_json::to_value(&question).unwrap();
        assert_eq!(json["type"], "noul");
        assert!(json["criteria"]["true"].is_string());
        let without = Question {
            kind: "choice",
            instructions: serde_json::json!("Which intent?"),
            criteria: None,
        };
        let json = serde_json::to_value(&without).unwrap();
        assert!(json.get("criteria").is_none(), "an absent criteria must not be sent as null");
    }
}
