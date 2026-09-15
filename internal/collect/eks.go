package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/eks/types"
)

func collectEksClusters(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := eks.NewFromConfig(sdk)
	out, err := client.ListClusters(ctx, &eks.ListClustersInput{})
	if err != nil {
		return fmt.Errorf("%s ListClusters: %w", a.region, err)
	}
	for _, name := range out.Clusters {
		cluster, err := client.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: aws.String(name)})
		if err != nil {
			return fmt.Errorf("%s DescribeCluster: %w", a.region, err)
		}
		emitEksCluster(a, cluster.Cluster, emit)
	}
	return nil
}

func emitEksCluster(a acc, cluster *types.Cluster, emit *Emitter) {
	arn := aws.ToString(cluster.Arn)
	n := a.now()
	n.Label = "EKS"
	n.Key = arn
	n.Properties = map[string]any{
		"status":           string(cluster.Status),
		"version":          aws.ToString(cluster.Version),
		"platform_version": aws.ToString(cluster.PlatformVersion),
		"role":             aws.ToString(cluster.RoleArn),
		"endpoint":         aws.ToString(cluster.Endpoint),
	}
	if v := cluster.ResourcesVpcConfig; v != nil {
		// A public API server endpoint with no CIDR restriction puts the
		// Kubernetes control plane on the internet.
		n.Properties["endpoint_public_access"] = v.EndpointPublicAccess
		n.Properties["endpoint_private_access"] = v.EndpointPrivateAccess
		n.Properties["public_access_cidrs"] = v.PublicAccessCidrs
	}
	if cluster.Logging != nil {
		var enabled []string
		for _, lc := range cluster.Logging.ClusterLogging {
			if aws.ToBool(lc.Enabled) {
				for _, t := range lc.Types {
					enabled = append(enabled, string(t))
				}
			}
		}
		n.Properties["log_types"] = enabled
	}
	if cluster.EncryptionConfig != nil {
		n.Properties["envelope_encryption"] = len(cluster.EncryptionConfig) > 0
	}
	emit.Send(n)

	if role := aws.ToString(cluster.RoleArn); role != "" {
		emit.Send(a.edge(n.Key, role, "USES_ROLE"))
	}
	if vpc := cluster.ResourcesVpcConfig; vpc != nil {
		if id := aws.ToString(vpc.VpcId); id != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+id), "IN_VPC"))
		}
		for _, sid := range vpc.SubnetIds {
			if sid != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+sid), "IN_SUBNET"))
			}
		}
		for _, gid := range vpc.SecurityGroupIds {
			if gid != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
			}
		}
	}
}
