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
}

func ResolveTarget(ctx context.Context, cfg Config) (Target, error) {
	allow, err := cfg.RegionAllowList()
	if err != nil {
		return Target{}, err
	}

	bootstrap, err := bootstrapRegion(ctx, cfg, allow)
	if err != nil {
		return Target{}, err
	}

	sdk, err := sdkConfig(ctx, cfg, bootstrap)
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

	return Target{AccountID: accountID, Partition: partition, Regions: regions}, nil
}

// bootstrapRegion picks the region used for the discovery calls that precede
// region enumeration (STS GetCallerIdentity, EC2 DescribeRegions). It has to be
// a region that exists in the caller's *partition* — "us-east-1" is unreachable
// with GovCloud (aws-us-gov) or China (aws-cn) credentials, so prefer an
// explicit --regions value, then whatever the profile/environment resolves to,
// and only fall back to the commercial default.
func bootstrapRegion(ctx context.Context, cfg Config, allow []string) (string, error) {
	if len(allow) > 0 {
		return allow[0], nil
	}
	sdk, err := sdkConfig(ctx, cfg, "")
	if err != nil {
		return "", fmt.Errorf("sdk config: %w", err)
	}
	if sdk.Region != "" {
		return sdk.Region, nil
	}
	return "us-east-1", nil
}
