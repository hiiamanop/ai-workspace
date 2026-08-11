package made.hard

test_allow_true_when_no_denies {
	allow with deny as set()
}

test_allow_false_when_denies_present {
	not allow with deny as {"some reason"}
}
