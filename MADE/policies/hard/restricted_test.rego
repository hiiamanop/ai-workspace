package made.hard

test_deny_deepseek_for_restricted_even_when_redacted {
	deny["privacy: vendor 'deepseek' not approved for restricted data (secrets detected)"] with input as {
		"task": {"type": "chat", "data_classification": "restricted", "redacted": true},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_deny_openai_for_restricted_even_when_redacted {
	deny["privacy: vendor 'openai' not approved for restricted data (secrets detected)"] with input as {
		"task": {"type": "chat", "data_classification": "restricted", "redacted": true},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_no_restricted_rule_for_self_hosted_vendor {
	not deny["privacy: vendor 'self-hosted' not approved for restricted data (secrets detected)"] with input as {
		"task": {"type": "chat", "data_classification": "restricted", "redacted": true},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "self-hosted", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_no_restricted_rule_for_confidential_data {
	not deny["privacy: vendor 'deepseek' not approved for restricted data (secrets detected)"] with input as {
		"task": {"type": "chat", "data_classification": "confidential", "redacted": true},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
