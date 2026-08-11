package made.hard

test_deny_candidate_context_too_small {
	deny["context: candidate 'gemma4:12b' window 4096 tokens < required 9000"] with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 9000},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 4096},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_candidate_context_fits {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 2000},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 4096},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}

test_allow_candidate_when_fields_missing {
	count(deny) == 0 with input as {
		"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": 0},
		"candidate": {"kind": "model", "id": "gemma4:12b", "vendor": "ollama-local", "cost_per_1k_tokens": 0, "context_window_tokens": 0},
		"org": {"budget_remaining_usd": 10.0, "region": "us"},
	}
}
