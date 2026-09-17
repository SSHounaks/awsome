package collect

import (
	"testing"

	"awsome/internal/config"
)

func TestProfileList(t *testing.T) {
	cases := []struct {
		name string
		cfg  config.Config
		want []string
	}{
		{
			// No profile configured means "whatever the environment resolves to",
			// which is the single-account behaviour that predates --profiles.
			name: "neither flag set yields one empty profile",
			cfg:  config.Config{},
			want: []string{""},
		},
		{
			name: "single --profile",
			cfg:  config.Config{Profile: "alpha1"},
			want: []string{"alpha1"},
		},
		{
			name: "--profiles wins over --profile",
			cfg:  config.Config{Profile: "ignored", Profiles: "a,b,c"},
			want: []string{"a", "b", "c"},
		},
		{
			name: "whitespace and empty entries are dropped",
			cfg:  config.Config{Profiles: " a , ,b "},
			want: []string{"a", "b"},
		},
		{
			name: "an all-empty --profiles falls back to --profile",
			cfg:  config.Config{Profile: "alpha1", Profiles: " , "},
			want: []string{"alpha1"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.cfg.ProfileList()
			if len(got) != len(tc.want) {
				t.Fatalf("ProfileList() = %q, want %q", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("ProfileList()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestPlanCarriesPerAccountCredentials(t *testing.T) {
	targets := []Target{
		{AccountID: "111111111111", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1"}, Profile: "p1"},
		{AccountID: "222222222222", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1"}, Profile: "p2"},
	}

	steps := PlanAll(targets)
	if len(steps) != len(Plan(targets[0]))+len(Plan(targets[1])) {
		t.Fatalf("PlanAll produced %d steps, want the sum of both plans", len(steps))
	}

	// Every step must carry the credential of its own account, or the scan
	// silently reads one account with another's profile.
	byAccount := map[string]map[string]bool{}
	for _, s := range steps {
		if byAccount[s.AccountID] == nil {
			byAccount[s.AccountID] = map[string]bool{}
		}
		byAccount[s.AccountID][s.Profile] = true
	}
	for _, tgt := range targets {
		profiles := byAccount[tgt.AccountID]
		if len(profiles) != 1 || !profiles[tgt.Profile] {
			t.Errorf("account %s ran with profiles %v, want only %q", tgt.AccountID, profiles, tgt.Profile)
		}
	}
}

func TestPlanRunsGlobalStepsOncePerAccount(t *testing.T) {
	// Two regions must not mean two IAM sweeps: IAM and CloudTrail are global,
	// and duplicating them would double-count users and re-emit the ACCOUNT node.
	target := Target{
		AccountID: "111111111111", Partition: "aws-us-gov",
		Regions: []string{"us-gov-west-1", "us-gov-east-1"}, Profile: "p1",
	}

	counts := map[string]int{}
	for _, s := range Plan(target) {
		counts[s.Service]++
	}
	for _, global := range []string{"iam", "iam-credentials", "trail"} {
		if counts[global] != 1 {
			t.Errorf("%s ran %d times across 2 regions, want 1", global, counts[global])
		}
	}
	if counts["instances"] != 2 {
		t.Errorf("regional step ran %d times across 2 regions, want 2", counts["instances"])
	}
}

func TestMakeSnapshotForRecordsEveryAccount(t *testing.T) {
	targets := []Target{
		{AccountID: "111111111111", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1"}},
		{AccountID: "222222222222", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1", "us-gov-east-1"}},
	}

	s := MakeSnapshotFor("snap-1", targets, "t0", "completed")

	if len(s.Accounts) != 2 {
		t.Errorf("Accounts = %v, want both", s.Accounts)
	}
	// AccountID stays set so single-account readers keep working.
	if s.AccountID != "111111111111" {
		t.Errorf("AccountID = %q, want the first account for back-compat", s.AccountID)
	}
	if len(s.Regions) != 2 {
		t.Errorf("Regions = %v, want the deduplicated union", s.Regions)
	}
}
