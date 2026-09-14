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
	sdk, err := sdkConfig(ctx, cfg, "us-east-1")
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
		parts := strings.SplitN(arn, ":", 2)
		if len(parts) == 2 && parts[0] == "arn" {
			partition = parts[1]
		}
	}

	allow, err := cfg.RegionAllowList()
	if err != nil {
		return Target{}, err
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
