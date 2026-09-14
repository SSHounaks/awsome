package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectElasticIPs(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	out, err := client.DescribeAddresses(ctx, &ec2.DescribeAddressesInput{})
	if err != nil {
		return fmt.Errorf("%s DescribeAddresses: %w", a.region, err)
	}
	for _, addr := range out.Addresses {
		emitElasticIP(a, addr, emit)
	}
	return nil
}

func emitElasticIP(a acc, addr types.Address, emit *Emitter) {
	id := aws.ToString(addr.AllocationId)
	n := a.now()
	n.Label = "EIP"
	n.Key = a.ec2Arn("elastic-ip/" + id)
	n.Tags = tagsToMap(addr.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"public_ip":            aws.ToString(addr.PublicIp),
		"domain":               string(addr.Domain),
		"instance_id":          aws.ToString(addr.InstanceId),
		"network_interface_id": aws.ToString(addr.NetworkInterfaceId),
		"association_id":       aws.ToString(addr.AssociationId),
	}
	emit.Send(n)

	if inst := aws.ToString(addr.InstanceId); inst != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("instance/"+inst), "ASSOC_WITH"))
	} else if eni := aws.ToString(addr.NetworkInterfaceId); eni != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("network-interface/"+eni), "ASSOC_WITH"))
	}
}
