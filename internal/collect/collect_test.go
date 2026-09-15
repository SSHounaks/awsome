package collect

import (
	"errors"
	"testing"
)

func TestDegradeReason(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		want     bool
		wantMark string
	}{
		{"nil is not a degrade", nil, false, ""},
		{"access denied", errors.New("operation error EC2: DescribeVpcs, AccessDenied: not authorized"), true, "AccessDenied"},
		{"localstack unimplemented", errors.New("API not yet implemented"), true, "not yet implemented"},
		{"region not opted in", errors.New("OptInRequired: region disabled"), true, "OptInRequired"},
		{"service absent from partition", errors.New("dial tcp: lookup redshift.us-gov-west-1.amazonaws.com: no such host"), true, "no such host"},
		{"real failure is not swallowed", errors.New("connection reset by peer"), false, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mark, ok := DegradeReason(tc.err)
			if ok != tc.want {
				t.Fatalf("DegradeReason() ok = %v, want %v", ok, tc.want)
			}
			if mark != tc.wantMark {
				t.Errorf("DegradeReason() marker = %q, want %q", mark, tc.wantMark)
			}
			if IsDegrade(tc.err) != tc.want {
				t.Errorf("IsDegrade() disagrees with DegradeReason()")
			}
		})
	}
}

func TestCoverageFor(t *testing.T) {
	step := Step{Service: "buckets", Region: "us-gov-west-1"}

	ok := coverageFor(step, "snap-1", nil)
	if ok.Status != "ok" || ok.Kind != "coverage" {
		t.Errorf("success = %+v, want status ok", ok)
	}
	if ok.Service != "buckets" || ok.Region != "us-gov-west-1" || ok.SnapshotID != "snap-1" {
		t.Errorf("coverage lost step identity: %+v", ok)
	}

	degraded := coverageFor(step, "snap-1", errors.New("AccessDenied: nope"))
	if degraded.Status != "degraded" || degraded.Reason != "AccessDenied" {
		t.Errorf("degraded = %+v, want status degraded / reason AccessDenied", degraded)
	}
	if degraded.Error == "" {
		t.Error("degraded coverage should keep the underlying error text")
	}

	failed := coverageFor(step, "snap-1", errors.New("connection reset by peer"))
	if failed.Status != "failed" {
		t.Errorf("failed = %+v, want status failed", failed)
	}
	if failed.Reason != "" {
		t.Errorf("non-degrade failure should not carry a degrade reason, got %q", failed.Reason)
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("short", 10); got != "short" {
		t.Errorf("truncate(short) = %q", got)
	}
	long := truncate("abcdefghij", 4)
	if long != "abcd…" {
		t.Errorf("truncate() = %q, want abcd…", long)
	}
}
