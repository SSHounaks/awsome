package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/opensearch"
	"github.com/aws/aws-sdk-go-v2/service/opensearch/types"
)

func collectOpenSearchDomains(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := opensearch.NewFromConfig(sdk)
	out, err := client.ListDomainNames(ctx, &opensearch.ListDomainNamesInput{})
	if err != nil {
		return nil
	}
	for _, info := range out.DomainNames {
		name := aws.ToString(info.DomainName)
		if name == "" {
			continue
		}
		res, err := client.DescribeDomain(ctx, &opensearch.DescribeDomainInput{DomainName: aws.String(name)})
		if err != nil {
			continue
		}
		emitOpenSearchDomain(a, res.DomainStatus, emit)
	}
	return nil
}

func emitOpenSearchDomain(a acc, st *types.DomainStatus, emit *Emitter) {
	name := aws.ToString(st.DomainName)
	n := a.now()
	n.Label = "OPENSEARCH"
	n.Key = fmt.Sprintf("arn:%s:es:%s:%s:domain/%s", a.partition, a.region, a.accountID, name)
	n.Properties = map[string]any{
		"engine_version":           aws.ToString(st.EngineVersion),
		"dedicated_master_enabled": false,
		"domain_id":                aws.ToString(st.DomainId),
		"endpoint":                 aws.ToString(st.Endpoint),
		"has_vpc":                  false,
	}
	if st.ClusterConfig != nil {
		n.Properties["instance_type"] = string(st.ClusterConfig.InstanceType)
		if st.ClusterConfig.InstanceCount != nil {
			n.Properties["instance_count"] = *st.ClusterConfig.InstanceCount
		}
		if st.ClusterConfig.DedicatedMasterEnabled != nil {
			n.Properties["dedicated_master_enabled"] = *st.ClusterConfig.DedicatedMasterEnabled
		}
	}
	if st.EBSOptions != nil {
		if st.EBSOptions.EBSEnabled != nil {
			n.Properties["ebs_enabled"] = *st.EBSOptions.EBSEnabled
		}
		if st.EBSOptions.VolumeSize != nil {
			n.Properties["volume_size"] = *st.EBSOptions.VolumeSize
		}
	}
	if st.VPCOptions != nil && aws.ToString(st.VPCOptions.VPCId) != "" {
		n.Properties["has_vpc"] = true
	}
	emit.Send(n)

	if st.VPCOptions != nil {
		if vpc := aws.ToString(st.VPCOptions.VPCId); vpc != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "IN_VPC"))
		}
		for _, sid := range st.VPCOptions.SubnetIds {
			if sid != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+sid), "IN_SUBNET"))
			}
		}
		for _, gid := range st.VPCOptions.SecurityGroupIds {
			if gid != "" {
				emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
			}
		}
	}
}
