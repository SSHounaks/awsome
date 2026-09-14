package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectRouteTables(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeRouteTablesPaginator(client, &ec2.DescribeRouteTablesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeRouteTables: %w", a.region, err)
		}
		for _, rt := range page.RouteTables {
			emitRouteTable(a, rt, emit)
		}
	}
	return nil
}

func emitRouteTable(a acc, rt types.RouteTable, emit *Emitter) {
	id := aws.ToString(rt.RouteTableId)
	main := false
	for _, assoc := range rt.Associations {
		if aws.ToBool(assoc.Main) {
			main = true
			break
		}
	}
	n := a.now()
	n.Label = "ROUTETABLE"
	n.Key = a.ec2Arn("route-table/" + id)
	n.Tags = tagsToMap(rt.Tags)
	n.Name = tagValue(n.Tags, "Name")
	n.Properties = map[string]any{
		"main":        main,
		"route_count": len(rt.Routes),
	}
	emit.Send(n)

	if vpc := aws.ToString(rt.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
	for _, assoc := range rt.Associations {
		if subnet := aws.ToString(assoc.SubnetId); subnet != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+subnet), "APPLIES_TO"))
		}
	}
	for _, r := range rt.Routes {
		if target := routeTarget(r); target != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn(target), "ROUTES_TO"))
		}
	}
}

func routeTarget(r types.Route) string {
	if id := aws.ToString(r.GatewayId); id != "" {
		return "internet-gateway/" + id
	}
	if id := aws.ToString(r.NatGatewayId); id != "" {
		return "nat-gateway/" + id
	}
	if id := aws.ToString(r.VpcPeeringConnectionId); id != "" {
		return "vpc-peering/" + id
	}
	if id := aws.ToString(r.TransitGatewayId); id != "" {
		return "transit-gateway/" + id
	}
	if id := aws.ToString(r.EgressOnlyInternetGatewayId); id != "" {
		return "egress-only-internet-gateway/" + id
	}
	if id := aws.ToString(r.CarrierGatewayId); id != "" {
		return "carrier-gateway/" + id
	}
	if id := aws.ToString(r.LocalGatewayId); id != "" {
		return "local-gateway/" + id
	}
	if id := aws.ToString(r.NetworkInterfaceId); id != "" {
		return "network-interface/" + id
	}
	if id := aws.ToString(r.InstanceId); id != "" {
		return "instance/" + id
	}
	return ""
}
