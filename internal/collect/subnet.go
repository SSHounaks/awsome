package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectSubnets(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeSubnetsPaginator(client, &ec2.DescribeSubnetsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeSubnets: %w", a.region, err)
		}
		for _, subnet := range page.Subnets {
			emitSubnet(a, subnet, emit)
		}
	}
	return nil
}

func emitSubnet(a acc, subnet types.Subnet, emit *Emitter) {
	id := aws.ToString(subnet.SubnetId)
	n := a.now()
	n.Label = "SUBNET"
	n.Key = a.ec2Arn("subnet/" + id)
	n.Tags = tagsToMap(subnet.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"cidr_block":     aws.ToString(subnet.CidrBlock),
		"az":             aws.ToString(subnet.AvailabilityZone),
		"map_public_ip":  aws.ToBool(subnet.MapPublicIpOnLaunch),
		"default_for_az": aws.ToBool(subnet.DefaultForAz),
		"vpc_id":         aws.ToString(subnet.VpcId),
		"ipv6":           aws.ToBool(subnet.AssignIpv6AddressOnCreation),
	}
	emit.Send(n)

	if vpc := aws.ToString(subnet.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
}
