package made.hard

non_eu_vendors := {"openai"}

deny[reason] {
	input.task.data_classification == "restricted"
	input.org.region == "eu"
	non_eu_vendors[input.candidate.vendor]
	reason := sprintf("privacy: vendor '%s' fails EU data residency for restricted data", [input.candidate.vendor])
}
