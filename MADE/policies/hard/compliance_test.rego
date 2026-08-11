package made.hard

test_deny_unverified_vendor_for_confidential {
	deny["compliance: vendor 'unverified-oss' not approved for data_classification 'confidential'"] with input as {
		"task": {"type": "summarization", "data_classification": "confidential"},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "unverified-oss", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_unverified_vendor_for_public {
	count(deny) == 0 with input as {
		"task": {"type": "summarization", "data_classification": "public"},
		"candidate": {"kind": "model", "id": "local-llama", "vendor": "unverified-oss", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
