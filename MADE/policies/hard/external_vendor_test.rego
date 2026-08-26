package made.hard

test_deny_deepseek_for_confidential_when_not_redacted {
	deny["privacy: vendor 'deepseek' not approved for unredacted data_classification 'confidential'"] with input as {
		"task": {"type": "chat", "data_classification": "confidential", "redacted": false},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_deny_deepseek_for_confidential_when_redacted_field_missing {
	deny["privacy: vendor 'deepseek' not approved for unredacted data_classification 'confidential'"] with input as {
		"task": {"type": "chat", "data_classification": "confidential"},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_deny_openai_for_restricted_when_not_redacted {
	deny["privacy: vendor 'openai' not approved for unredacted data_classification 'restricted'"] with input as {
		"task": {"type": "chat", "data_classification": "restricted", "redacted": false},
		"candidate": {"kind": "model", "id": "gpt-4o", "vendor": "openai", "cost_per_1k_tokens": 0.02},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_deepseek_for_confidential_when_redacted {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "confidential", "redacted": true},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_deepseek_for_public_data_even_when_not_redacted {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "public", "redacted": false},
		"candidate": {"kind": "model", "id": "deepseek-v4-flash", "vendor": "deepseek", "cost_per_1k_tokens": 0.001},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_non_external_vendor_for_confidential_when_not_redacted {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "confidential", "redacted": false},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "self-hosted", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
