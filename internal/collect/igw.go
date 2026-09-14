package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectInternetGateways(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeInternetGatewaysPaginator(client, &ec2.DescribeInternetGatewaysInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeInternetGateways: %w", a.region, err)
		}
		for _, igw := range page.InternetGateways {
			emitInternetGateway(a, igw, emit)
		}
	}
	return nil
}

func emitInternetGateway(a acc, igw types.InternetGateway, emit *Emitter) {
	id := aws.ToString(igw.InternetGatewayId)
	n := a.now()
	n.Label = "IGW"
	n.Key = a.ec2Arn("internet-gateway/" + id)
	n.Tags = tagsToMap(igw.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{}
	emit.Send(n)

	for _, att := range igw.Attachments {
		if vpc := aws.ToString(att.VpcId); vpc != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "ATTACHED_TO"))
		}
	}
}
