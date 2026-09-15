package findings

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// Baseline records risks that have been reviewed and accepted, so they stop
// competing for attention with unreviewed ones.
//
// Suppressed findings are NOT deleted — they are marked and excluded from the
// severity counts, but still written to findings.json. An accepted risk you can
// no longer see is an accepted risk nobody will revisit.
type Baseline struct {
	Suppressions []Suppression `json:"suppressions"`
}

type Suppression struct {
	Rule string `json:"rule"`
	// Resource matches the finding's resource key or name. A leading "*" makes
	// it a suffix match, a trailing "*" a prefix match; empty matches every
	// resource for the rule.
	Resource string `json:"resource,omitempty"`
	// Reason and Owner are required: an exception with no stated justification
	// and nobody's name on it is indistinguishable from a bug.
	Reason string `json:"reason"`
	Owner  string `json:"owner"`
	// Expires (YYYY-MM-DD) forces periodic re-review. An expired suppression
	// stops applying and the finding comes back.
	Expires string `json:"expires,omitempty"`
}

func LoadBaseline(path string) (*Baseline, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Baseline{}, nil
		}
		return nil, err
	}
	var b Baseline
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for i, s := range b.Suppressions {
		if s.Rule == "" {
			return nil, fmt.Errorf("%s: suppression %d has no rule", path, i)
		}
		if strings.TrimSpace(s.Reason) == "" || strings.TrimSpace(s.Owner) == "" {
			return nil, fmt.Errorf("%s: suppression %d (%s) needs both a reason and an owner", path, i, s.Rule)
		}
		if s.Expires != "" {
			if _, err := time.Parse("2006-01-02", s.Expires); err != nil {
				return nil, fmt.Errorf("%s: suppression %d (%s) has an invalid expires date %q, want YYYY-MM-DD", path, i, s.Rule, s.Expires)
			}
		}
	}
	return &b, nil
}

func (s Suppression) expired(now time.Time) bool {
	if s.Expires == "" {
		return false
	}
	t, err := time.Parse("2006-01-02", s.Expires)
	if err != nil {
		return false
	}
	return now.After(t.AddDate(0, 0, 1))
}

func (s Suppression) matches(f Finding) bool {
	if s.Rule != f.Rule {
		return false
	}
	if s.Resource == "" {
		return true
	}
	return globMatch(s.Resource, f.ResourceKey) || globMatch(s.Resource, f.ResourceName)
}

// globMatch supports a leading and/or trailing "*". Deliberately not a full
// glob: a suppression should be easy to read and hard to over-match.
func globMatch(pattern, value string) bool {
	if value == "" {
		return false
	}
	pre := strings.HasPrefix(pattern, "*")
	suf := strings.HasSuffix(pattern, "*")
	core := strings.Trim(pattern, "*")
	switch {
	case pre && suf:
		return strings.Contains(value, core)
	case pre:
		return strings.HasSuffix(value, core)
	case suf:
		return strings.HasPrefix(value, core)
	default:
		return value == pattern
	}
}

// Apply marks findings covered by a live suppression. It returns the annotated
// list along with counts of what was suppressed and how many suppressions have
// expired — an expired entry is reported so it gets renewed or removed rather
// than quietly going stale.
func (b *Baseline) Apply(fns []Finding, now time.Time) (out []Finding, suppressed int, expired []Suppression) {
	if b == nil || len(b.Suppressions) == 0 {
		return fns, 0, nil
	}
	seenExpired := map[string]bool{}
	out = make([]Finding, 0, len(fns))
	for _, f := range fns {
		for _, s := range b.Suppressions {
			if !s.matches(f) {
				continue
			}
			if s.expired(now) {
				key := s.Rule + "|" + s.Resource
				if !seenExpired[key] {
					seenExpired[key] = true
					expired = append(expired, s)
				}
				continue // expired: the finding stands
			}
			f.Suppressed = true
			f.SuppressionReason = s.Reason
			f.SuppressionOwner = s.Owner
			suppressed++
			break
		}
		out = append(out, f)
	}
	return out, suppressed, expired
}

// Active returns only the findings that are not suppressed.
func Active(fns []Finding) []Finding {
	out := make([]Finding, 0, len(fns))
	for _, f := range fns {
		if !f.Suppressed {
			out = append(out, f)
		}
	}
	return out
}
