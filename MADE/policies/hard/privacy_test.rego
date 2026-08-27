package made.hard

test_deny_openai_for_eu_restricted {
	deny["privacy: vendor 'openai' fails EU data residency for restricted data"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted"},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "eu"},
	}
}

test_no_eu_residency_deny_for_us_restricted {
	# The EU-residency rule is region-gated: it must NOT fire for a US org.
	# Asserting the specific reason's absence rather than count(deny) == 0,
	# because restricted.rego now denies any external vendor for restricted
	# data unconditionally (that block is covered by restricted_test.rego).
	not deny["privacy: vendor 'openai' fails EU data residency for restricted data"] with input as {
		"task": {"type": "summarization", "data_classification": "restricted", "redacted": true},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
