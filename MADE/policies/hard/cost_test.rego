package made.hard

test_deny_candidate_over_budget {
	deny["cost: candidate 'gpt-4o' cost_per_1k_tokens 0.5 exceeds remaining budget 0.1"] with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.5},
		"org": {"budget_remaining_usd": 0.1, "region": "us"},
	}
}

test_allow_candidate_under_budget {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
