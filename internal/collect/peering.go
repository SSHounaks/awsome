package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectVpcPeering(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeVpcPeeringConnectionsPaginator(client, &ec2.DescribeVpcPeeringConnectionsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeVpcPeeringConnections: %w", a.region, err)
		}
		for _, pcx := range page.VpcPeeringConnections {
			emitVpcPeering(a, pcx, emit)
		}
	}
	return nil
}

func emitVpcPeering(a acc, pcx types.VpcPeeringConnection, emit *Emitter) {
	id := aws.ToString(pcx.VpcPeeringConnectionId)
	status := ""
	if pcx.Status != nil {
		status = string(pcx.Status.Code)
	}
	requesterCidr, accepterCidr := "", ""
	if pcx.RequesterVpcInfo != nil {
		requesterCidr = aws.ToString(pcx.RequesterVpcInfo.CidrBlock)
	}
	if pcx.AccepterVpcInfo != nil {
		accepterCidr = aws.ToString(pcx.AccepterVpcInfo.CidrBlock)
	}
	n := a.now()
	n.Label = "PEERING"
	n.Key = a.ec2Arn("vpc-peering/" + id)
	n.Tags = tagsToMap(pcx.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"status":         status,
		"requester_cidr": requesterCidr,
		"accepter_cidr":  accepterCidr,
	}
	emit.Send(n)

	requesterVpc := ""
	if pcx.RequesterVpcInfo != nil {
		requesterVpc = aws.ToString(pcx.RequesterVpcInfo.VpcId)
	}
	if requesterVpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+requesterVpc), "CONNECTS"))
	}
	if pcx.AccepterVpcInfo != nil {
		if accepterVpc := aws.ToString(pcx.AccepterVpcInfo.VpcId); accepterVpc != "" && accepterVpc != requesterVpc {
			emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+accepterVpc), "CONNECTS"))
		}
	}
}
