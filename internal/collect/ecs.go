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
	sdk, err := a.sdk(ctx, cfg)
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
	n.Name = aws.ToString(cluster.ClusterName)
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

// collectEcsServices emits one node per ECS service and links it to the task
// definition it runs.
//
// This exists so "nothing runs this task definition" can be said truthfully. A
// cron job is fired by an EventBridge rule; a long-running workload is held up
// by a service. Without services, every API and processor task definition looks
// exactly as unfired as purge-processor does, and the signal that matters —
// deployed, but nothing starts it — drowns in nine false alarms per tenant.
func collectEcsServices(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := a.sdk(ctx, cfg)
	if err != nil {
		return err
	}
	client := ecs.NewFromConfig(sdk)

	clusters := ecs.NewListClustersPaginator(client, &ecs.ListClustersInput{})
	for clusters.HasMorePages() {
		page, err := clusters.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListClusters: %w", a.region, err)
		}
		for _, cluster := range page.ClusterArns {
			if err := collectServicesIn(ctx, client, a, cluster, emit); err != nil {
				return err
			}
		}
	}
	return nil
}

func collectServicesIn(ctx context.Context, client *ecs.Client, a acc, cluster string, emit *Emitter) error {
	pager := ecs.NewListServicesPaginator(client, &ecs.ListServicesInput{Cluster: aws.String(cluster)})
	for pager.HasMorePages() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListServices: %w", a.region, err)
		}
		// DescribeServices takes at most ten at a time.
		for i := 0; i < len(page.ServiceArns); i += 10 {
			end := i + 10
			if end > len(page.ServiceArns) {
				end = len(page.ServiceArns)
			}
			out, err := client.DescribeServices(ctx, &ecs.DescribeServicesInput{
				Cluster:  aws.String(cluster),
				Services: page.ServiceArns[i:end],
			})
			if err != nil {
				return fmt.Errorf("%s DescribeServices: %w", a.region, err)
			}
			for _, svc := range out.Services {
				emitEcsService(a, svc, emit)
			}
		}
	}
	return nil
}

func emitEcsService(a acc, svc types.Service, emit *Emitter) {
	arn := aws.ToString(svc.ServiceArn)
	if arn == "" {
		return
	}
	n := a.now()
	n.Label = "ECSSERVICE"
	n.Key = arn
	n.Name = aws.ToString(svc.ServiceName)
	n.Properties = map[string]any{
		"desired_count": svc.DesiredCount,
		"running_count": svc.RunningCount,
		"launch_type":   string(svc.LaunchType),
		"status":        aws.ToString(svc.Status),
		// A service scaled to zero is running nothing, which is a different
		// state from not existing and worth being able to see.
		"scaled_to_zero": svc.DesiredCount == 0,
	}
	emit.Send(n)

	if cluster := aws.ToString(svc.ClusterArn); cluster != "" {
		emit.Send(a.edge(n.Key, cluster, "PART_OF"))
	}
	// Keyed on the family so the edge lands whatever revision is deployed.
	if td := aws.ToString(svc.TaskDefinition); td != "" {
		emit.Send(a.edge(n.Key, familyOf(td), "RUNS"))
	}
	if svc.NetworkConfiguration != nil && svc.NetworkConfiguration.AwsvpcConfiguration != nil {
		vpc := svc.NetworkConfiguration.AwsvpcConfiguration
		for _, s := range vpc.Subnets {
			if s != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+s), "IN_SUBNET"))
			}
		}
		for _, g := range vpc.SecurityGroups {
			if g != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+g), "ASSOC_WITH"))
			}
		}
	}
}
