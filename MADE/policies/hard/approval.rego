package made.hard

require_approval[reason] {
	input.task.data_classification == "restricted"
	reason := "approval: restricted data_classification always requires human approval"
}

require_approval[reason] {
    input.task.type == "contract_review"
    reason := "approval: contract_review tasks always require human approval"
}

# External connector mutations are approval-gated by default. The candidate
# remains selectable so an orchestrator can prepare a draft, but it must stop
# before executing the MCP call until approval_granted is true.
write_operations := {"create", "update", "delete", "publish", "send", "deploy"}

require_approval[reason] {
    input.candidate.kind == "tool"
    operation := object.get(input.candidate, "operation", input.task.operation)
    write_operations[operation]
    not input.task.approval_granted
    reason := sprintf("approval: external operation '%s' requires human approval", [operation])
}
