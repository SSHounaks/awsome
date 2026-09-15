package findings

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeBaseline(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "baseline.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadBaselineRequiresReasonAndOwner(t *testing.T) {
	p := writeBaseline(t, `{"suppressions":[{"rule":"s3-public-bucket","resource":"b"}]}`)
	if _, err := LoadBaseline(p); err == nil {
		t.Error("a suppression with no reason or owner should be rejected")
	}

	p = writeBaseline(t, `{"suppressions":[{"rule":"s3-public-bucket","reason":"static site","owner":"team"}]}`)
	if _, err := LoadBaseline(p); err != nil {
		t.Errorf("valid baseline rejected: %v", err)
	}
}

func TestLoadBaselineMissingFileIsNotAnError(t *testing.T) {
	b, err := LoadBaseline(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("missing baseline should be tolerated, got %v", err)
	}
	if len(b.Suppressions) != 0 {
		t.Error("missing baseline should yield no suppressions")
	}
}

func TestLoadBaselineRejectsBadExpiry(t *testing.T) {
	p := writeBaseline(t, `{"suppressions":[{"rule":"r","reason":"x","owner":"y","expires":"31-12-2026"}]}`)
	if _, err := LoadBaseline(p); err == nil {
		t.Error("an unparseable expires date should be rejected")
	}
}

func TestBaselineApply(t *testing.T) {
	now := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	b := &Baseline{Suppressions: []Suppression{
		{Rule: "s3-public-bucket", Resource: "*branch-previews", Reason: "static site", Owner: "web", Expires: "2026-12-31"},
		{Rule: "sg-orphan", Reason: "cleanup scheduled", Owner: "infra", Expires: "2026-01-01"}, // expired
	}}

	fns := []Finding{
		{Rule: "s3-public-bucket", ResourceKey: "arn:aws:s3:::app-branch-previews", Severity: "medium"},
		{Rule: "s3-public-bucket", ResourceKey: "arn:aws:s3:::customer-data", Severity: "critical"},
		{Rule: "sg-orphan", ResourceKey: "sg-1", Severity: "low"},
	}

	out, suppressed, expired := b.Apply(fns, now)

	if suppressed != 1 {
		t.Errorf("suppressed = %d, want 1", suppressed)
	}
	if !out[0].Suppressed || out[0].SuppressionOwner != "web" {
		t.Errorf("branch-previews finding should be suppressed and attributed, got %+v", out[0])
	}
	// An unrelated bucket must not be swept up by the pattern.
	if out[1].Suppressed {
		t.Error("customer-data bucket must not be suppressed")
	}
	// Expired suppressions stop applying and are reported.
	if out[2].Suppressed {
		t.Error("expired suppression must not suppress the finding")
	}
	if len(expired) != 1 {
		t.Errorf("expired = %d, want 1", len(expired))
	}

	// Nothing is deleted: every finding is still present.
	if len(out) != len(fns) {
		t.Errorf("Apply dropped findings: got %d, want %d", len(out), len(fns))
	}
	if got := len(Active(out)); got != 2 {
		t.Errorf("active findings = %d, want 2", got)
	}
}

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, value string
		want           bool
	}{
		{"exact", "exact", true},
		{"exact", "exact-plus", false},
		{"*suffix", "some-suffix", true},
		{"*suffix", "suffix-some", false},
		{"prefix*", "prefix-some", true},
		{"*mid*", "a-mid-b", true},
		{"*mid*", "a-b", false},
		{"anything", "", false},
	}
	for _, tc := range cases {
		if got := globMatch(tc.pattern, tc.value); got != tc.want {
			t.Errorf("globMatch(%q,%q) = %v, want %v", tc.pattern, tc.value, got, tc.want)
		}
	}
}
