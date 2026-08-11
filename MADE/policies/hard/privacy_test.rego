package made.hard

test_deny_openai_for_eu_restricted {
	deny["privacy: vendor 'openai' fails EU data residency for restricted data"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "eu"},
	}
}

test_allow_openai_for_us_restricted {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
