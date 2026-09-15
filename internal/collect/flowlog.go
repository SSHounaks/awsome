package collect

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectFlowLogs(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeFlowLogsPaginator(client, &ec2.DescribeFlowLogsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeFlowLogs: %w", a.region, err)
		}
		for _, fl := range page.FlowLogs {
			emitFlowLog(a, fl, emit)
		}
	}
	return nil
}

func emitFlowLog(a acc, fl types.FlowLog, emit *Emitter) {
	id := aws.ToString(fl.FlowLogId)
	n := a.now()
	n.Label = "FLOWLOG"
	n.Key = a.ec2Arn("flow-log/" + id)
	n.Properties = map[string]any{
		"resource_id":  aws.ToString(fl.ResourceId),
		"status":       aws.ToString(fl.FlowLogStatus),
		"delivery":     aws.ToString(fl.DeliverLogsStatus),
		"traffic_type": string(fl.TrafficType),
	}
	emit.Send(n)
	res := aws.ToString(fl.ResourceId)
	switch {
	case strings.HasPrefix(res, "vpc-"):
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+res), "FLOWS_ON"))
	case strings.HasPrefix(res, "subnet-"):
		emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+res), "FLOWS_ON"))
	}
}
