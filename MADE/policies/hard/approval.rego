package made.hard

require_approval[reason] {
	input.task.data_classification == "restricted"
	reason := "approval: restricted data_classification always requires human approval"
}

require_approval[reason] {
	input.task.type == "contract_review"
	reason := "approval: contract_review tasks always require human approval"
}
