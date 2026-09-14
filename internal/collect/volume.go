package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectVolumes(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeVolumesPaginator(client, &ec2.DescribeVolumesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeVolumes: %w", a.region, err)
		}
		for _, vol := range page.Volumes {
			emitVolume(a, vol, emit)
		}
	}
	return nil
}

func emitVolume(a acc, vol types.Volume, emit *Emitter) {
	id := aws.ToString(vol.VolumeId)
	n := a.now()
	n.Label = "VOLUME"
	n.Key = a.ec2Arn("volume/" + id)
	n.Tags = tagsToMap(vol.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"size_gb":   intValue(vol.Size),
		"type":      string(vol.VolumeType),
		"encrypted": aws.ToBool(vol.Encrypted),
		"az":        aws.ToString(vol.AvailabilityZone),
		"state":     string(vol.State),
		"iops":      intValue(vol.Iops),
	}
	emit.Send(n)

	for _, att := range vol.Attachments {
		if inst := aws.ToString(att.InstanceId); inst != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("instance/"+inst), "ATTACHED_TO"))
		}
	}
}
