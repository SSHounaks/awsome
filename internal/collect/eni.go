package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectNetworkInterfaces(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeNetworkInterfacesPaginator(client, &ec2.DescribeNetworkInterfacesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeNetworkInterfaces: %w", a.region, err)
		}
		for _, eni := range page.NetworkInterfaces {
			emitNetworkInterface(a, eni, emit)
		}
	}
	return nil
}

func emitNetworkInterface(a acc, eni types.NetworkInterface, emit *Emitter) {
	id := aws.ToString(eni.NetworkInterfaceId)
	n := a.now()
	n.Label = "ENI"
	n.Key = a.ec2Arn("network-interface/" + id)
	n.Tags = tagsToMap(eni.TagSet)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"mac":               aws.ToString(eni.MacAddress),
		"primary_ip":        aws.ToString(eni.PrivateIpAddress),
		"subnet_id":         aws.ToString(eni.SubnetId),
		"vpc_id":            aws.ToString(eni.VpcId),
		"description":       aws.ToString(eni.Description),
		"source_dest_check": aws.ToBool(eni.SourceDestCheck),
		"interface_type":    string(eni.InterfaceType),
	}
	emit.Send(n)

	if vpc := aws.ToString(eni.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "IN_VPC"))
	}
	if subnet := aws.ToString(eni.SubnetId); subnet != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+subnet), "IN_SUBNET"))
	}
	for _, g := range eni.Groups {
		if gid := aws.ToString(g.GroupId); gid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
		}
	}
	if eni.Attachment != nil {
		if inst := aws.ToString(eni.Attachment.InstanceId); inst != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("instance/"+inst), "ATTACHED_TO"))
		}
	}
}
