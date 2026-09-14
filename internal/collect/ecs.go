package collect

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"
)

func collectEcsClusters(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ecs.NewFromConfig(sdk)
	paginator := ecs.NewListClustersPaginator(client, &ecs.ListClustersInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListClusters: %w", a.region, err)
		}
		if len(page.ClusterArns) == 0 {
			continue
		}
		out, err := client.DescribeClusters(ctx, &ecs.DescribeClustersInput{Clusters: page.ClusterArns})
		if err != nil {
			return fmt.Errorf("%s DescribeClusters: %w", a.region, err)
		}
		for _, cluster := range out.Clusters {
			arn := aws.ToString(cluster.ClusterArn)
			if arn == "" {
				continue
			}
			emitEcsCluster(a, cluster, emit)

			name := arn[strings.LastIndex(arn, "/")+1:]
			lis := ecs.NewListContainerInstancesPaginator(client, &ecs.ListContainerInstancesInput{Cluster: aws.String(name)})
			var instArns []string
			degraded := false
			for lis.HasMorePages() {
				lpage, err := lis.NextPage(ctx)
				if err != nil {
					degraded = true
					break
				}
				instArns = append(instArns, lpage.ContainerInstanceArns...)
			}
			if degraded || len(instArns) == 0 {
				continue
			}
			ci, err := client.DescribeContainerInstances(ctx, &ecs.DescribeContainerInstancesInput{Cluster: aws.String(name), ContainerInstances: instArns})
			if err != nil {
				continue
			}
			for _, inst := range ci.ContainerInstances {
				if id := aws.ToString(inst.Ec2InstanceId); id != "" {
					emit.Send(a.edge(arn, a.ec2Arn("instance/"+id), "CONTAINS"))
				}
			}
		}
	}
	return nil
}

func emitEcsCluster(a acc, cluster types.Cluster, emit *Emitter) {
	n := a.now()
	n.Label = "ECSCLUSTER"
	n.Key = aws.ToString(cluster.ClusterArn)
	n.Properties = map[string]any{
		"status":                         aws.ToString(cluster.Status),
		"registered_container_instances": cluster.RegisteredContainerInstancesCount,
		"running_tasks":                  cluster.RunningTasksCount,
		"pending_tasks":                  cluster.PendingTasksCount,
		"services":                       cluster.ActiveServicesCount,
		"providers":                      len(cluster.CapacityProviders),
	}
	emit.Send(n)
}
