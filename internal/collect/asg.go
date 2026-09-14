package collect

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/autoscaling"
	"github.com/aws/aws-sdk-go-v2/service/autoscaling/types"
)

func collectAutoScalingGroups(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := autoscaling.NewFromConfig(sdk)
	paginator := autoscaling.NewDescribeAutoScalingGroupsPaginator(client, &autoscaling.DescribeAutoScalingGroupsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeAutoScalingGroups: %w", a.region, err)
		}
		for _, g := range page.AutoScalingGroups {
			emitAutoScalingGroup(a, g, emit)
		}
	}
	return nil
}

func emitAutoScalingGroup(a acc, g types.AutoScalingGroup, emit *Emitter) {
	name := aws.ToString(g.AutoScalingGroupName)
	n := a.now()
	n.Label = "ASG"
	n.Key = fmt.Sprintf("arn:%s:autoscaling:%s:%s:autoScalingGroup:%s", a.partition, a.region, a.accountID, name)
	tags := asgTagsMap(g.Tags)
	n.Tags = tags
	n.Name = tagValue(tags, "Name")
	n.Properties = map[string]any{
		"min_size":             intValue(g.MinSize),
		"max_size":             intValue(g.MaxSize),
		"desired_capacity":     intValue(g.DesiredCapacity),
		"vpc_zone_identifiers": aws.ToString(g.VPCZoneIdentifier),
		"default_cooldown":     intValue(g.DefaultCooldown),
	}
	if g.LaunchTemplate != nil {
		n.Properties["launch_template"] = aws.ToString(g.LaunchTemplate.LaunchTemplateName)
	}
	emit.Send(n)

	for _, inst := range g.Instances {
		if instID := aws.ToString(inst.InstanceId); instID != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("instance/"+instID), "CONTAINS"))
		}
	}
	for _, id := range strings.Split(aws.ToString(g.VPCZoneIdentifier), ",") {
		if id = strings.TrimSpace(id); id != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+id), "IN_SUBNET"))
		}
	}
}

func asgTagsMap(tags []types.TagDescription) map[string]string {
	if len(tags) == 0 {
		return nil
	}
	m := make(map[string]string, len(tags))
	for _, t := range tags {
		m[aws.ToString(t.Key)] = aws.ToString(t.Value)
	}
	return m
}
