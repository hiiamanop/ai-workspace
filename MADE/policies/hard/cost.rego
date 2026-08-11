package made.hard

# ponytail: cost_per_1k_tokens compared directly against budget_remaining_usd as a per-request cap, replace with real token-volume estimation if the budget model needs multi-request accounting
deny[reason] {
	input.candidate.cost_per_1k_tokens > input.org.budget_remaining_usd
	reason := sprintf("cost: candidate '%s' cost_per_1k_tokens %v exceeds remaining budget %v", [input.candidate.id, input.candidate.cost_per_1k_tokens, input.org.budget_remaining_usd])
}
