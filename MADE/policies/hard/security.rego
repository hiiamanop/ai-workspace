package made.hard

high_risk_tools := {"shell_exec"}

deny[reason] {
	input.candidate.kind == "tool"
	high_risk_tools[input.candidate.id]
	input.task.data_classification != "public"
	reason := sprintf("security: tool '%s' only permitted for public data_classification", [input.candidate.id])
}
