package store

import "strings"

func Neo4jName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	t := b.String()
	if t == "" || t[0] >= '0' && t[0] <= '9' {
		return "_" + t
	}
	return t
}
