package made.hard

# restricted = live credentials / secrets detected in the payload
# (core/privacy/detectors.py's SECRET spans -> classifier -> "restricted").
#
# Unlike confidential, redaction does NOT unlock an external vendor here:
# secret detection is imperfect, so a message known to have carried one
# credential may carry another the detectors missed, and the safe move is
# to keep the whole payload off external APIs. Vendor set mirrors
# external_vendor.rego.
restricted_external_vendors := {"deepseek", "openai"}

deny[reason] {
	input.task.data_classification == "restricted"
	restricted_external_vendors[input.candidate.vendor]
	reason := sprintf("privacy: vendor '%s' not approved for restricted data (secrets detected)", [input.candidate.vendor])
}
