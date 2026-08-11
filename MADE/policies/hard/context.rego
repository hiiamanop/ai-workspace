package made.hard

deny[reason] {
	input.candidate.kind == "model"
	input.candidate.context_window_tokens > 0
	input.task.estimated_context_tokens > 0
	input.task.estimated_context_tokens > input.candidate.context_window_tokens
	reason := sprintf(
		"context: candidate '%s' window %v tokens < required %v",
		[input.candidate.id, input.candidate.context_window_tokens, input.task.estimated_context_tokens],
	)
}
