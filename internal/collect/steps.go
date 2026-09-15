package collect

import (
	"context"
	"fmt"
)

type Step struct {
	Service   string `json:"service"`
	Region    string `json:"region"`
	AccountID string `json:"account_id,omitempty"`
	Partition string `json:"partition,omitempty"`
}

var serviceOrder = []string{
	"instances", "vpcs", "security-groups", "subnets", "volumes",
	"network-interfaces", "images", "route-tables", "network-acls",
	"internet-gateways", "elastic-ips", "vpc-peering", "auto-scaling-groups",
	"load-balancers", "rds-instances", "rds-subnet-groups", "cache-clusters",
	"redshift-clusters", "opensearch-domains", "tables", "functions",
	"ecs-clusters", "eks-clusters", "buckets", "ecr-repos", "flow-logs",
}

func Plan(target Target) []Step {
	var steps []Step
	for _, region := range target.Regions {
		for _, svc := range serviceOrder {
			steps = append(steps, Step{Service: svc, Region: region, AccountID: target.AccountID, Partition: target.Partition})
		}
	}
	if len(target.Regions) > 0 {
		steps = append(steps, Step{Service: "iam", Region: target.Regions[0], AccountID: target.AccountID, Partition: target.Partition})
		steps = append(steps, Step{Service: "iam-credentials", Region: target.Regions[0], AccountID: target.AccountID, Partition: target.Partition})
		steps = append(steps, Step{Service: "trail", Region: target.Regions[0], AccountID: target.AccountID, Partition: target.Partition})
	}
	return steps
}

func RunStep(ctx context.Context, cfg Config, step Step, snapshotID string, emit *Emitter) error {
	a := acc{accountID: step.AccountID, partition: step.Partition, region: step.Region, snapshot: snapshotID}
	switch step.Service {
	case "instances":
		return collectInstances(ctx, cfg, a, emit)
	case "vpcs":
		return collectVpcs(ctx, cfg, a, emit)
	case "security-groups":
		return collectSecurityGroups(ctx, cfg, a, emit)
	case "subnets":
		return collectSubnets(ctx, cfg, a, emit)
	case "volumes":
		return collectVolumes(ctx, cfg, a, emit)
	case "network-interfaces":
		return collectNetworkInterfaces(ctx, cfg, a, emit)
	case "images":
		return collectImages(ctx, cfg, a, emit)
	case "route-tables":
		return collectRouteTables(ctx, cfg, a, emit)
	case "network-acls":
		return collectNetworkACLs(ctx, cfg, a, emit)
	case "internet-gateways":
		return collectInternetGateways(ctx, cfg, a, emit)
	case "elastic-ips":
		return collectElasticIPs(ctx, cfg, a, emit)
	case "vpc-peering":
		return collectVpcPeering(ctx, cfg, a, emit)
	case "auto-scaling-groups":
		return collectAutoScalingGroups(ctx, cfg, a, emit)
	case "load-balancers":
		return collectLoadBalancers(ctx, cfg, a, emit)
	case "rds-instances":
		return collectRdsInstances(ctx, cfg, a, emit)
	case "rds-subnet-groups":
		return collectRdsSubnetGroups(ctx, cfg, a, emit)
	case "cache-clusters":
		return collectCacheClusters(ctx, cfg, a, emit)
	case "redshift-clusters":
		return collectRedshiftClusters(ctx, cfg, a, emit)
	case "opensearch-domains":
		return collectOpenSearchDomains(ctx, cfg, a, emit)
	case "tables":
		return collectTables(ctx, cfg, a, emit)
	case "functions":
		return collectFunctions(ctx, cfg, a, emit)
	case "ecs-clusters":
		return collectEcsClusters(ctx, cfg, a, emit)
	case "eks-clusters":
		return collectEksClusters(ctx, cfg, a, emit)
	case "buckets":
		return collectBuckets(ctx, cfg, a, emit)
	case "ecr-repos":
		return collectEcrRepositories(ctx, cfg, a, emit)
	case "flow-logs":
		return collectFlowLogs(ctx, cfg, a, emit)
	case "iam":
		return collectIam(ctx, cfg, a, emit)
	case "iam-credentials":
		return collectIamCredentials(ctx, cfg, a, emit)
	case "trail":
		return collectTrail(ctx, cfg, a)
	default:
		return fmt.Errorf("unknown service step %q", step.Service)
	}
}
