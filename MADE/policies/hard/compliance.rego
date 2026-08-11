package made.hard

# ponytail: single hardcoded vendor set, replace with a real vendor registry lookup if the list grows past a handful of entries
unverified_vendors := {"unverified-oss"}

deny[reason] {
	{"confidential", "restricted"}[input.task.data_classification]
	unverified_vendors[input.candidate.vendor]
	reason := sprintf("compliance: vendor '%s' not approved for data_classification '%s'", [input.candidate.vendor, input.task.data_classification])
}
