package made.hard

default allow := true

allow := false {
	count(deny) > 0
}
