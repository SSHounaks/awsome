package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectImages(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeImagesPaginator(client, &ec2.DescribeImagesInput{Owners: []string{"self"}})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeImages: %w", a.region, err)
		}
		for _, img := range page.Images {
			emitImage(a, img, emit)
		}
	}
	return nil
}

func emitImage(a acc, img types.Image, emit *Emitter) {
	id := aws.ToString(img.ImageId)
	n := a.now()
	n.Label = "AMI"
	n.Key = a.ec2Arn("image/" + id)
	n.Tags = tagsToMap(img.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"name":                aws.ToString(img.Name),
		"architecture":        string(img.Architecture),
		"virtualization_type": string(img.VirtualizationType),
		"state":               string(img.State),
		"owner_id":            aws.ToString(img.OwnerId),
		"public":              aws.ToBool(img.Public),
		"creation_date":       aws.ToString(img.CreationDate),
		"root_device":         aws.ToString(img.RootDeviceName),
	}
	emit.Send(n)
}
