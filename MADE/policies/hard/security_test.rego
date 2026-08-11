package made.hard

test_deny_shell_exec_for_internal_data {
	deny["security: tool 'shell_exec' only permitted for public data_classification"] with input as {
		"task": {"type": "automation", "data_classification": "internal"},
		"candidate": {"kind": "tool", "id": "shell_exec", "vendor": "internal", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_shell_exec_for_public_data {
	count(deny) == 0 with input as {
		"task": {"type": "automation", "data_classification": "public"},
		"candidate": {"kind": "tool", "id": "shell_exec", "vendor": "internal", "cost_per_1k_tokens": 0.0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
