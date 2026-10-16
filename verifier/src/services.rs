//! The two model-backed services.
//!
//! Each is a real service: it takes a request, asks Jev one batched question set,
//! and returns a typed JSON document that the covenant's schema either accepts or
//! rejects. The verifier measures the latency and validates the schema exactly as
//! it does for the deterministic services — the model changes what produces the
//! response, not how the response is judged.
//!
//! Design decisions worth stating, both from the TypeSafe guidance:
//!
//! * **Questions are batched.** Every question here is about the same state, and
//!   the docs measure batching independent questions in one call as roughly ten
//!   times faster and twelve times cheaper than asking them separately. Latency is
//!   the thing being sold, so this matters twice.
//! * **Policy is code, not a prompt.** Jev returns probabilities; the verdict is
//!   computed from thresholds in [`crate::llm::PolicyThresholds`]. A reader can
//!   find the numbers and change one without another inference.

use crate::llm::{Answer, Inference, JevClient, JevError, PolicyThresholds, Question};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

/// The closed set of intents the router chooses between. A covenant can only
/// promise a typed answer if the type is fixed, so the set is part of the service
/// rather than something the caller supplies.
pub const INTENTS: [&str; 5] = [
    "pay_invoice",
    "split_payment",
    "schedule_payment",
    "query_balance",
    "unknown",
];

/// The hazard checks the guard runs. Each is a Noul, so each returns a
/// probability and the caller can set its own threshold.
pub const HAZARDS: [&str; 5] = [
    "unusual_amount",
    "unusual_counterparty",
    "possible_duplicate",
    "urgency_pressure",
    "restricted_party",
];

fn noul(instructions: Json, criteria: Option<Json>) -> Question {
    Question {
        kind: "noul",
        instructions,
        criteria,
    }
}

/// Read a natural-language payment instruction and answer with a typed intent.
///
/// The returned document is what the covenant's schema describes: the chosen
/// intent, the probability of every option, the model's confidence, two presence
/// probabilities, an urgency score, and whether a person must authorise it.
/// `choices` carries the whole distribution, not a rounded label, because a
/// caller's policy usually depends on how close the runner-up was.
pub async fn intent_router(jev: &JevClient, request: &Json) -> Result<Json, JevError> {
    let instruction = request
        .get("instruction")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| JevError::Shape("`instruction` must be a non-empty string".into()))?
        .to_string();
    if instruction.len() > 4_000 {
        return Err(JevError::Shape("`instruction` is longer than 4000 characters".into()));
    }

    let criteria: BTreeMap<&str, &str> = BTreeMap::from([
        ("pay_invoice", "Paying one bill, invoice or request for money in a single payment"),
        ("split_payment", "Dividing one payment between two or more recipients"),
        ("schedule_payment", "Setting up a payment to happen later, or repeatedly"),
        ("query_balance", "Asking what is held or owed rather than moving money"),
        ("unknown", "Nothing in the text describes one of the above"),
    ]);

    let mut questions: BTreeMap<String, Question> = BTreeMap::new();
    questions.insert(
        "intent".into(),
        Question {
            kind: "choice",
            instructions: json!({
                "instruction": instruction,
                "question": "Which single intent does `instruction` describe?",
            }),
            criteria: Some(serde_json::to_value(&criteria).expect("a criteria map serialises")),
        },
    );
    questions.insert(
        "amount_stated".into(),
        noul(
            json!({
                "instruction": instruction,
                "question": "Does `instruction` state an amount, or name something it can be computed from?",
            }),
            Some(json!({
                "true": "An amount is given, or a total is derivable from stated parts",
                "false": "No amount and nothing that determines one",
            })),
        ),
    );
    questions.insert(
        "counterparty_stated".into(),
        noul(
            json!({
                "instruction": instruction,
                "question": "Does `instruction` name who is to be paid?",
            }),
            Some(json!({
                "true": "A payee, account or identifiable recipient is named",
                "false": "No recipient is named or identifiable",
            })),
        ),
    );
    questions.insert(
        "urgency".into(),
        Question {
            kind: "score",
            instructions: json!({
                "instruction": instruction,
                "question": "How urgent is the timing in `instruction`?",
            }),
            criteria: Some(json!([
                "No deadline or timing mentioned",
                "A deadline or timing is mentioned but not close",
                "A deadline within about 48 hours, or explicit urgency",
            ])),
        },
    );
    questions.insert(
        "needs_human_review".into(),
        noul(
            json!({
                "instruction": instruction,
                "question": "Should a person authorise this before any money moves, rather than software acting on it alone?",
            }),
            Some(json!({
                "true": "Unusual, unusually large, irreversible, ambiguous about who is paid, or a new counterparty",
                "false": "Ordinary, complete and safe for software to act on",
            })),
        ),
    );

    let inference = jev.evaluate(&json!({ "instruction": instruction }), questions).await?;
    build_intent_document(&inference)
}

/// Turn the model's answers into the document the schema describes.
///
/// Kept separate from the request so it can be tested without a model call, and
/// so a shape error is reported as a shape error rather than as a service outage.
fn build_intent_document(inference: &Inference) -> Result<Json, JevError> {
    let (choice, probabilities, confidence) = inference.answer("intent")?.choice()?;
    if !INTENTS.contains(&choice) {
        return Err(JevError::Shape(format!(
            "the model chose `{choice}`, which is not one of the {INTENTS:?}"
        )));
    }

    // Every option must carry a probability, because the schema says so and a
    // caller's threshold logic will index into it. A missing option is a shape
    // error here rather than a null on the wire.
    let mut choices = serde_json::Map::new();
    for intent in INTENTS {
        let value = probabilities.get(intent).copied().ok_or_else(|| {
            JevError::Shape(format!("the model did not return a probability for `{intent}`"))
        })?;
        choices.insert(intent.to_string(), json!(round6(value)));
    }

    let mut missing: Vec<String> = Vec::new();
    if inference.probability("amount_stated")? < 0.5 {
        missing.push("amount".to_string());
    }
    if inference.probability("counterparty_stated")? < 0.5 {
        missing.push("counterparty".to_string());
    }

    Ok(json!({
        "intent": choice,
        "choices": Json::Object(choices),
        "confidence": round6(confidence),
        "amountStated": round6(inference.probability("amount_stated")?),
        "counterpartyStated": round6(inference.probability("counterparty_stated")?),
        "urgency": round6(inference.score("urgency")?),
        "needsHumanReview": round6(inference.probability("needs_human_review")?),
        "missing": missing,
    }))
}

/// Screen a proposed payment and return a verdict with the probabilities behind it.
///
/// The verdict is derived in code from [`PolicyThresholds`]; the probabilities are
/// returned in full so a caller with different risk appetite can apply its own
/// thresholds to the same evidence without paying for another inference.
pub async fn payment_guard(jev: &JevClient, request: &Json) -> Result<Json, JevError> {
    let payment = request
        .get("payment")
        .ok_or_else(|| JevError::Shape("`payment` is required".into()))?;
    let history = request.get("recentPayments").cloned().unwrap_or_else(|| json!([]));

    let amount = payment.get("amount").cloned().unwrap_or(Json::Null);
    let currency = payment.get("currency").cloned().unwrap_or(Json::Null);
    let counterparty = payment.get("counterparty").cloned().unwrap_or(Json::Null);
    let memo = payment.get("memo").cloned().unwrap_or(Json::Null);
    let requested_by = payment.get("requestedBy").cloned().unwrap_or(Json::Null);

    let state = json!({
        "proposedPayment": {
            "amount": amount,
            "currency": currency,
            "counterparty": counterparty,
            "memo": memo,
            "requestedBy": requested_by,
        },
        "recentPayments": history,
    });

    let mut questions: BTreeMap<String, Question> = BTreeMap::new();
    questions.insert(
        "unusual_amount".into(),
        noul(
            json!({
                "proposedPayment": state["proposedPayment"],
                "recentPayments": state["recentPayments"],
                "question": "Is the amount in `proposedPayment` out of character compared with `recentPayments`?",
            }),
            Some(json!({
                "true": "Far larger than the pattern, or no comparable history exists to judge it against",
                "false": "In keeping with what this counterparty or category usually costs",
            })),
        ),
    );
    questions.insert(
        "unusual_counterparty".into(),
        noul(
            json!({
                "proposedPayment": state["proposedPayment"],
                "recentPayments": state["recentPayments"],
                "question": "Is the counterparty in `proposedPayment` one this payer has not paid before?",
            }),
            Some(json!({
                "true": "No earlier payment to this counterparty appears",
                "false": "This counterparty has been paid before",
            })),
        ),
    );
    questions.insert(
        "possible_duplicate".into(),
        noul(
            json!({
                "proposedPayment": state["proposedPayment"],
                "recentPayments": state["recentPayments"],
                "question": "Does `proposedPayment` look like a repeat of a payment already in `recentPayments`?",
            }),
            Some(json!({
                "true": "Same counterparty and amount, or a memo describing the same obligation",
                "false": "Not a repeat of anything listed",
            })),
        ),
    );
    questions.insert(
        "urgency_pressure".into(),
        noul(
            json!({
                "proposedPayment": state["proposedPayment"],
                "question": "Does the memo or context in `proposedPayment` apply pressure to pay quickly or bypass the usual process?",
            }),
            Some(json!({
                "true": "Deadlines, secrecy, or an explicit request to skip checks",
                "false": "Ordinary commercial language",
            })),
        ),
    );
    questions.insert(
        "restricted_party".into(),
        noul(
            json!({
                "proposedPayment": state["proposedPayment"],
                "question": "Does anything in `proposedPayment` indicate a sanctioned, restricted, or prohibited party or purpose?",
            }),
            Some(json!({
                "true": "A restricted jurisdiction, a sanctioned name, or a prohibited purpose appears",
                "false": "Nothing indicates a restriction",
            })),
        ),
    );
    questions.insert(
        "severity".into(),
        Question {
            kind: "score",
            instructions: json!({
                "proposedPayment": state["proposedPayment"],
                "recentPayments": state["recentPayments"],
                "question": "How serious would it be to release `proposedPayment` without a person looking at it?",
            }),
            criteria: Some(json!([
                "No concerns; releasing it is routine",
                "Mild anomaly worth a note but not a delay",
                "Serious enough that a person should decide",
            ])),
        },
    );

    let inference = jev.evaluate(&state, questions).await?;
    let policy = PolicyThresholds::default();
    build_guard_document(&inference, &policy)
}

fn build_guard_document(inference: &Inference, policy: &PolicyThresholds) -> Result<Json, JevError> {
    let mut checks = serde_json::Map::new();
    let mut pairs: Vec<(String, f64)> = Vec::new();
    for hazard in HAZARDS {
        let value = inference.probability(hazard)?;
        checks.insert(hazard.to_string(), json!(round6(value)));
        pairs.push((hazard.to_string(), value));
    }

    // The verdict comes from the thresholds and the probabilities, and from
    // nothing else — no model output decides the action.
    let verdict = policy.verdict(&pairs);

    Ok(json!({
        "verdict": verdict,
        "severity": round6(inference.score("severity")?),
        "confidence": round6(highest_confidence(inference)),
        "checks": Json::Object(checks),
        "thresholds": {
            "block_at": policy.block_at,
            "review_at": policy.review_at,
        },
    }))
}

/// The confidence of the questions that carry probabilities, expressed as one
/// number. Noul answers do not carry a confidence of their own, so this is the
/// mean distance from a coin flip across the hazard questions: a service whose
/// checks are all near 0.5 is telling the caller it is not sure, which is worth
/// surfacing rather than hiding inside five probabilities.
fn highest_confidence(inference: &Inference) -> f64 {
    let mut total = 0.0;
    let mut count = 0.0;
    for hazard in HAZARDS {
        if let Ok(Answer::Noul { noul }) = inference.answer(hazard) {
            total += (noul - 0.5).abs() * 2.0;
            count += 1.0;
        }
    }
    if count == 0.0 {
        0.0
    } else {
        total / count
    }
}

/// Six decimal places, so a probability never arrives as a float with seventeen
/// digits that a schema has to compare anyway.
fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Answer;

    fn inference_with(answers: BTreeMap<String, Answer>) -> Inference {
        Inference {
            model: "jev-test".into(),
            answers,
            usage: None,
        }
    }

    fn intent_answers(choice: &str) -> BTreeMap<String, Answer> {
        let mut probabilities = BTreeMap::new();
        for intent in INTENTS {
            probabilities.insert(
                intent.to_string(),
                if intent == choice { 0.71 } else { 0.0725 },
            );
        }
        BTreeMap::from([
            (
                "intent".to_string(),
                Answer::Choice {
                    choice: choice.to_string(),
                    probabilities,
                    confidence: 0.66,
                },
            ),
            ("amount_stated".to_string(), Answer::Noul { noul: 0.94 }),
            ("counterparty_stated".to_string(), Answer::Noul { noul: 0.31 }),
            ("urgency".to_string(), Answer::Score { score: 1.2, confidence: 0.5 }),
            ("needs_human_review".to_string(), Answer::Noul { noul: 0.42 }),
        ])
    }

    #[test]
    fn the_intent_document_matches_the_published_schema() {
        let inference = inference_with(intent_answers("split_payment"));
        let document = build_intent_document(&inference).expect("builds");
        let fixture = crate::config::fixture("intent-router").expect("published");
        let errors = crate::schema::validate(&fixture.schema_value(), &document);
        assert!(errors.is_empty(), "{errors:?} in {document}");

        assert_eq!(document["intent"], "split_payment");
        assert_eq!(document["counterpartyStated"], 0.31);
        assert_eq!(document["missing"], json!(["counterparty"]));
        assert_eq!(document["urgency"], 1.2);
    }

    #[test]
    fn a_choice_outside_the_closed_set_is_a_shape_error_not_a_document() {
        let inference = inference_with(intent_answers("refund_everything"));
        let error = build_intent_document(&inference).unwrap_err();
        assert!(matches!(error, JevError::Shape(_)), "{error:?}");
    }

    #[test]
    fn a_missing_probability_is_refused_rather_than_defaulted() {
        let mut answers = intent_answers("pay_invoice");
        if let Some(Answer::Choice { probabilities, .. }) = answers.get_mut("intent") {
            probabilities.remove("unknown");
        }
        let error = build_intent_document(&inference_with(answers)).unwrap_err();
        assert!(format!("{error}").contains("unknown"), "{error}");
    }

    fn guard_answers(hazards: [f64; 5]) -> BTreeMap<String, Answer> {
        let mut answers = BTreeMap::new();
        for (hazard, value) in HAZARDS.iter().zip(hazards) {
            answers.insert(hazard.to_string(), Answer::Noul { noul: value });
        }
        answers.insert(
            "severity".to_string(),
            Answer::Score { score: 0.4, confidence: 0.7 },
        );
        answers
    }

    #[test]
    fn the_guard_verdict_follows_the_thresholds_and_the_schema_accepts_it() {
        let policy = PolicyThresholds::default();
        let fixture = crate::config::fixture("payment-guard").expect("published");

        for (hazards, expected) in [
            ([0.02, 0.05, 0.1, 0.03, 0.01], "pass"),
            ([0.02, 0.4, 0.1, 0.03, 0.01], "review"),
            ([0.02, 0.05, 0.1, 0.03, 0.95], "block"),
        ] {
            let document = build_guard_document(&inference_with(guard_answers(hazards)), &policy)
                .expect("builds");
            assert_eq!(document["verdict"], expected, "hazards {hazards:?}");
            let errors = crate::schema::validate(&fixture.schema_value(), &document);
            assert!(errors.is_empty(), "{errors:?} in {document}");
            assert_eq!(document["thresholds"]["block_at"], 0.6);
        }
    }

    #[test]
    fn an_unsure_model_says_so_through_confidence() {
        // All hazards near a coin flip: the verdict is still computed, but the
        // document carries a low confidence so a caller can route to a person.
        let unsure = build_guard_document(&inference_with(guard_answers([0.5, 0.5, 0.5, 0.5, 0.5])), &PolicyThresholds::default()).unwrap();
        assert_eq!(unsure["confidence"], 0.0);

        let decided = build_guard_document(&inference_with(guard_answers([0.0, 1.0, 0.0, 1.0, 0.0])), &PolicyThresholds::default()).unwrap();
        assert_eq!(decided["confidence"], 1.0);
    }

    #[test]
    fn an_empty_instruction_is_refused_before_spending_a_call() {
        let jev = JevClient::from_env();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // No key is configured in the test environment, but the shape check runs
        // first, so the error names the request rather than the credential.
        let result = runtime.block_on(intent_router(&jev, &json!({ "instruction": "   " })));
        assert!(matches!(result, Err(JevError::Shape(_))), "{result:?}");
    }
}
