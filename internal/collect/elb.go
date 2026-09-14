package collect

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/elasticloadbalancingv2"
	"github.com/aws/aws-sdk-go-v2/service/elasticloadbalancingv2/types"
)

func collectLoadBalancers(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := elasticloadbalancingv2.NewFromConfig(sdk)
	paginator := elasticloadbalancingv2.NewDescribeLoadBalancersPaginator(client, &elasticloadbalancingv2.DescribeLoadBalancersInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeLoadBalancers: %w", a.region, err)
		}
		for _, lb := range page.LoadBalancers {
			lbKey := elbArnKey(a, lb.LoadBalancerArn)
			emitLoadBalancer(a, lb, emit)
			lp := elasticloadbalancingv2.NewDescribeListenersPaginator(client, &elasticloadbalancingv2.DescribeListenersInput{LoadBalancerArn: lb.LoadBalancerArn})
			for lp.HasMorePages() {
				lpage, err := lp.NextPage(ctx)
				if err != nil {
					break
				}
				for _, lis := range lpage.Listeners {
					for _, act := range lis.DefaultActions {
						if tg := aws.ToString(act.TargetGroupArn); tg != "" {
							emit.Send(a.edge(lbKey, elbArnKey(a, act.TargetGroupArn), "FORWARDS"))
						}
					}
				}
			}
		}
	}
	return collectTargetGroups(ctx, cfg, a, emit)
}

func emitLoadBalancer(a acc, lb types.LoadBalancer, emit *Emitter) {
	n := a.now()
	n.Label = "LB"
	n.Key = elbArnKey(a, lb.LoadBalancerArn)
	n.Name = elbName(lb.LoadBalancerArn)
	n.Properties = map[string]any{
		"type":     string(lb.Type),
		"scheme":   string(lb.Scheme),
		"vpc_id":   aws.ToString(lb.VpcId),
		"dns_name": aws.ToString(lb.DNSName),
	}
	if lb.State != nil {
		n.Properties["state"] = string(lb.State.Code)
	}
	if lb.CreatedTime != nil {
		n.Properties["created"] = lb.CreatedTime.UTC().Format(time.RFC3339)
	}
	emit.Send(n)

	if vpc := aws.ToString(lb.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
	for _, az := range lb.AvailabilityZones {
		if subnet := aws.ToString(az.SubnetId); subnet != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+subnet), "IN_SUBNET"))
		}
	}
	for _, sg := range lb.SecurityGroups {
		if sg != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+sg), "ASSOC_WITH"))
		}
	}
}

func collectTargetGroups(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := elasticloadbalancingv2.NewFromConfig(sdk)
	paginator := elasticloadbalancingv2.NewDescribeTargetGroupsPaginator(client, &elasticloadbalancingv2.DescribeTargetGroupsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeTargetGroups: %w", a.region, err)
		}
		for _, tg := range page.TargetGroups {
			emitTargetGroup(a, tg, emit)
		}
	}
	return nil
}

func emitTargetGroup(a acc, tg types.TargetGroup, emit *Emitter) {
	n := a.now()
	n.Label = "TARGETGROUP"
	n.Key = elbArnKey(a, tg.TargetGroupArn)
	n.Properties = map[string]any{
		"protocol":          string(tg.Protocol),
		"port":              intValue(tg.Port),
		"vpc_id":            aws.ToString(tg.VpcId),
		"target_type":       string(tg.TargetType),
		"health_check_path": aws.ToString(tg.HealthCheckPath),
	}
	emit.Send(n)

	if vpc := aws.ToString(tg.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
}

func resourceSuffix(arn *string) string {
	parts := strings.Split(aws.ToString(arn), ":")
	return strings.Join(parts[5:], ":")
}

func elbArnKey(a acc, arn *string) string {
	return fmt.Sprintf("arn:%s:elasticloadbalancing:%s:%s:%s", a.partition, a.region, a.accountID, resourceSuffix(arn))
}

func elbName(arn *string) string {
	parts := strings.Split(resourceSuffix(arn), "/")
	if len(parts) < 3 {
		return ""
	}
	return parts[2]
}
