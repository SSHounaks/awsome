package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/redshift"
	"github.com/aws/aws-sdk-go-v2/service/redshift/types"
)

func collectRedshiftClusters(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := redshift.NewFromConfig(sdk)
	paginator := redshift.NewDescribeClustersPaginator(client, &redshift.DescribeClustersInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeClusters: %w", a.region, err)
		}
		for _, c := range page.Clusters {
			emitRedshiftCluster(a, c, emit)
		}
	}
	return nil
}

func emitRedshiftCluster(a acc, c types.Cluster, emit *Emitter) {
	id := aws.ToString(c.ClusterIdentifier)
	n := a.now()
	n.Label = "REDSHIFT"
	n.Key = fmt.Sprintf("arn:%s:redshift:%s:%s:cluster:%s", a.partition, a.region, a.accountID, id)
	n.Properties = map[string]any{
		"node_type": aws.ToString(c.NodeType),
		"status":    aws.ToString(c.ClusterStatus),
		"db_name":   aws.ToString(c.DBName),
		"az":        aws.ToString(c.AvailabilityZone),
	}
	if c.NumberOfNodes != nil {
		n.Properties["number_of_nodes"] = *c.NumberOfNodes
	}
	if c.Encrypted != nil {
		n.Properties["encrypted"] = *c.Encrypted
	}
	if c.PubliclyAccessible != nil {
		n.Properties["public_accessible"] = *c.PubliclyAccessible
	}
	emit.Send(n)

	for _, g := range c.VpcSecurityGroups {
		if gid := aws.ToString(g.VpcSecurityGroupId); gid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
		}
	}
}
