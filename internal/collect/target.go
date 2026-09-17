package collect

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

type Target struct {
	AccountID string
	Partition string
	Regions   []string
	// Profile is the credential this account authenticates with. A scan can span
	// several accounts, each with its own.
	Profile string
}

// TargetError records a profile that could not be resolved. One inaccessible
// account must not abort a multi-account scan — in a real estate some accounts
// belong to other people, and the useful behaviour is to scan what you can reach
// and say plainly what you could not.
type TargetError struct {
	Profile string
	Err     error
}

// ResolveTargets resolves every configured profile. It returns the targets it
// could reach and the failures it could not, and only errors outright when
// nothing resolved.
func ResolveTargets(ctx context.Context, cfg Config) ([]Target, []TargetError, error) {
	profiles := cfg.ProfileList()
	var targets []Target
	var failures []TargetError
	seen := map[string]bool{}

	for _, p := range profiles {
		t, err := resolveOne(ctx, cfg, p)
		if err != nil {
			failures = append(failures, TargetError{Profile: p, Err: err})
			continue
		}
		// Two profiles can point at the same account (e.g. ReadOnly and
		// SecurityAudit); scanning it twice would duplicate every node.
		if seen[t.AccountID] {
			continue
		}
		seen[t.AccountID] = true
		targets = append(targets, t)
	}

	if len(targets) == 0 {
		if len(failures) > 0 {
			return nil, failures, fmt.Errorf("no account could be resolved (%d profile(s) failed): %w", len(failures), failures[0].Err)
		}
		return nil, nil, fmt.Errorf("no profiles configured")
	}
	return targets, failures, nil
}

// ResolveTarget resolves the single configured profile, for callers that only
// ever scan one account.
func ResolveTarget(ctx context.Context, cfg Config) (Target, error) {
	targets, _, err := ResolveTargets(ctx, cfg)
	if err != nil {
		return Target{}, err
	}
	return targets[0], nil
}

func resolveOne(ctx context.Context, cfg Config, profile string) (Target, error) {
	allow, err := cfg.RegionAllowList()
	if err != nil {
		return Target{}, err
	}

	bootstrap, err := bootstrapRegion(ctx, cfg, allow, profile)
	if err != nil {
		return Target{}, err
	}

	sdk, err := sdkConfig(ctx, cfg, bootstrap, profile)
	if err != nil {
		return Target{}, fmt.Errorf("sdk config: %w", err)
	}

	identity, err := sts.NewFromConfig(sdk).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return Target{}, fmt.Errorf("sts GetCallerIdentity: %w", err)
	}
	accountID := aws.ToString(identity.Account)
	partition := "aws"
	if arn := aws.ToString(identity.Arn); strings.HasPrefix(arn, "arn:") {
		parts := strings.Split(arn, ":")
		if len(parts) >= 2 && parts[0] == "arn" {
			partition = parts[1]
		}
		if partition == "" {
			partition = "aws"
		}
	}

	var regions []string
	if len(allow) > 0 {
		regions = allow
	} else {
		client := ec2.NewFromConfig(sdk)
		out, err := client.DescribeRegions(ctx, &ec2.DescribeRegionsInput{})
		if err != nil {
			return Target{}, fmt.Errorf("ec2 DescribeRegions: %w", err)
		}
		for _, r := range out.Regions {
			region := aws.ToString(r.RegionName)
			if region != "" {
				regions = append(regions, region)
			}
		}
	}
	sort.Strings(regions)

	return Target{AccountID: accountID, Partition: partition, Regions: regions, Profile: profile}, nil
}

// bootstrapRegion picks the region used for the discovery calls that precede
// region enumeration (STS GetCallerIdentity, EC2 DescribeRegions). It has to be
// a region that exists in the caller's *partition* — "us-east-1" is unreachable
// with GovCloud (aws-us-gov) or China (aws-cn) credentials, so prefer an
// explicit --regions value, then whatever the profile/environment resolves to,
// and only fall back to the commercial default.
func bootstrapRegion(ctx context.Context, cfg Config, allow []string, profile string) (string, error) {
	if len(allow) > 0 {
		return allow[0], nil
	}
	sdk, err := sdkConfig(ctx, cfg, "", profile)
	if err != nil {
		return "", fmt.Errorf("sdk config: %w", err)
	}
	if sdk.Region != "" {
		return sdk.Region, nil
	}
	return "us-east-1", nil
}
