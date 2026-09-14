package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectSecurityGroups(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeSecurityGroupsPaginator(client, &ec2.DescribeSecurityGroupsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeSecurityGroups: %w", a.region, err)
		}
		for _, sg := range page.SecurityGroups {
			emitSecurityGroup(a, sg, emit)
		}
	}
	return nil
}

func emitSecurityGroup(a acc, sg types.SecurityGroup, emit *Emitter) {
	id := aws.ToString(sg.GroupId)
	n := a.now()
	n.Label = "SG"
	n.Key = a.ec2Arn("security-group/" + id)
	n.Tags = tagsToMap(sg.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"group_name":    aws.ToString(sg.GroupName),
		"description":   aws.ToString(sg.Description),
		"vpc_id":        aws.ToString(sg.VpcId),
		"ingress_rules": rulesToProps(sg.IpPermissions),
		"egress_rules":  rulesToProps(sg.IpPermissionsEgress),
	}
	emit.Send(n)

	if vpc := aws.ToString(sg.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
	refs := make(map[string]struct{})
	for gid := range sourceSGRefs(sg.IpPermissions) {
		refs[gid] = struct{}{}
	}
	for gid := range sourceSGRefs(sg.IpPermissionsEgress) {
		refs[gid] = struct{}{}
	}
	for peer := range refs {
		if peer != id {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+peer), "REFERENCES"))
		}
	}
}
