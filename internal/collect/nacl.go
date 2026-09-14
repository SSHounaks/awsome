package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectNetworkACLs(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeNetworkAclsPaginator(client, &ec2.DescribeNetworkAclsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeNetworkAcls: %w", a.region, err)
		}
		for _, acl := range page.NetworkAcls {
			emitNetworkAcl(a, acl, emit)
		}
	}
	return nil
}

func emitNetworkAcl(a acc, acl types.NetworkAcl, emit *Emitter) {
	id := aws.ToString(acl.NetworkAclId)
	ingress, egress := 0, 0
	for _, e := range acl.Entries {
		if aws.ToBool(e.Egress) {
			egress++
		} else {
			ingress++
		}
	}
	n := a.now()
	n.Label = "NACL"
	n.Key = a.ec2Arn("network-acl/" + id)
	n.Tags = tagsToMap(acl.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"default":            aws.ToBool(acl.IsDefault),
		"ingress_rule_count": ingress,
		"egress_rule_count":  egress,
		"vpc_id":             aws.ToString(acl.VpcId),
	}
	emit.Send(n)

	if vpc := aws.ToString(acl.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
	for _, assoc := range acl.Associations {
		if subnet := aws.ToString(assoc.SubnetId); subnet != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+subnet), "ASSOC_WITH"))
		}
	}
}
