package made.hard

test_require_approval_for_restricted_data {
	require_approval["approval: restricted data_classification always requires human approval"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_no_approval_for_internal_summarization {
	count(require_approval) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "internal"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
