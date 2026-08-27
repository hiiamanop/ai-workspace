package made.hard

# Vendors reachable only over the public internet. Confidential/restricted
# data may only reach them once it's been through POST /privacy/redact
# (core/privacy/pseudonymizer.py) — task.redacted is how a caller proves
# that happened, not a courtesy flag it can skip. Distinct from
# compliance.rego's unverified_vendors deny (that one is about vendor
# trust; this one is about whether the data was made safe to send).
# "omniroute" is a gateway that fans out to Claude/DeepSeek/Gemini/etc over
# the public internet — same exposure as calling those vendors directly.
external_vendors := {"deepseek", "openai", "omniroute"}

deny[reason] {
	{"confidential", "restricted"}[input.task.data_classification]
	external_vendors[input.candidate.vendor]
	not input.task.redacted
	reason := sprintf("privacy: vendor '%s' not approved for unredacted data_classification '%s'", [input.candidate.vendor, input.task.data_classification])
}
