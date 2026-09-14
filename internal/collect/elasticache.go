package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/elasticache"
	"github.com/aws/aws-sdk-go-v2/service/elasticache/types"
)

func collectCacheClusters(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := elasticache.NewFromConfig(sdk)
	paginator := elasticache.NewDescribeCacheClustersPaginator(client, &elasticache.DescribeCacheClustersInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeCacheClusters: %w", a.region, err)
		}
		for _, cc := range page.CacheClusters {
			emitCacheCluster(a, cc, emit)
		}
	}
	return nil
}

func emitCacheCluster(a acc, cc types.CacheCluster, emit *Emitter) {
	id := aws.ToString(cc.CacheClusterId)
	n := a.now()
	n.Label = "ELASTICACHE"
	n.Key = fmt.Sprintf("arn:%s:elasticache:%s:%s:cluster:%s", a.partition, a.region, a.accountID, id)
	n.Properties = map[string]any{
		"engine":          aws.ToString(cc.Engine),
		"cache_node_type": aws.ToString(cc.CacheNodeType),
		"status":          aws.ToString(cc.CacheClusterStatus),
		"subnet_group":    aws.ToString(cc.CacheSubnetGroupName),
		"az":              aws.ToString(cc.PreferredAvailabilityZone),
	}
	if cc.NumCacheNodes != nil {
		n.Properties["num_nodes"] = *cc.NumCacheNodes
	}
	emit.Send(n)

	for _, g := range cc.SecurityGroups {
		if gid := aws.ToString(g.SecurityGroupId); gid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
		}
	}
}
