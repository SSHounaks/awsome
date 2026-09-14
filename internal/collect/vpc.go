package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectVpcs(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeVpcsPaginator(client, &ec2.DescribeVpcsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeVpcs: %w", a.region, err)
		}
		for _, vpc := range page.Vpcs {
			emitVpc(a, vpc, emit)
		}
	}
	return nil
}

func emitVpc(a acc, vpc types.Vpc, emit *Emitter) {
	id := aws.ToString(vpc.VpcId)
	n := a.now()
	n.Label = "VPC"
	n.Key = a.ec2Arn("vpc/" + id)
	n.Tags = tagsToMap(vpc.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"cidr_block":     aws.ToString(vpc.CidrBlock),
		"default_vpc":    vpc.IsDefault,
		"dhcp_options":   aws.ToString(vpc.DhcpOptionsId),
	}
	emit.Send(n)
}
