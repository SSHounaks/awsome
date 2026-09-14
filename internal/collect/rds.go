package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/rds"
	"github.com/aws/aws-sdk-go-v2/service/rds/types"
)

func collectRdsInstances(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := rds.NewFromConfig(sdk)
	paginator := rds.NewDescribeDBInstancesPaginator(client, &rds.DescribeDBInstancesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeDBInstances: %w", a.region, err)
		}
		for _, inst := range page.DBInstances {
			emitRdsInstance(a, inst, emit)
		}
	}
	return nil
}

func emitRdsInstance(a acc, inst types.DBInstance, emit *Emitter) {
	id := aws.ToString(inst.DBInstanceIdentifier)
	n := a.now()
	n.Label = "RDS"
	n.Key = fmt.Sprintf("arn:%s:rds:%s:%s:db:%s", a.partition, a.region, a.accountID, id)
	n.Properties = map[string]any{
		"engine":              aws.ToString(inst.Engine),
		"engine_version":      aws.ToString(inst.EngineVersion),
		"instance_class":      aws.ToString(inst.DBInstanceClass),
		"publicly_accessible": inst.PubliclyAccessible,
		"status":              aws.ToString(inst.DBInstanceStatus),
	}
	if inst.MultiAZ != nil {
		n.Properties["multi_az"] = *inst.MultiAZ
	}
	if inst.AllocatedStorage != nil {
		n.Properties["storage_gb"] = *inst.AllocatedStorage
	}
	if inst.StorageEncrypted != nil {
		n.Properties["encrypted"] = *inst.StorageEncrypted
	}
	if inst.Endpoint != nil {
		port := ""
		if inst.Endpoint.Port != nil {
			port = fmt.Sprintf(":%d", *inst.Endpoint.Port)
		}
		n.Properties["endpoint"] = aws.ToString(inst.Endpoint.Address) + port
	}
	emit.Send(n)

	for _, g := range inst.VpcSecurityGroups {
		if gid := aws.ToString(g.VpcSecurityGroupId); gid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
		}
	}
	if inst.DBSubnetGroup != nil {
		sgKey := fmt.Sprintf("arn:%s:rds:%s:%s:subgrp:%s", a.partition, a.region, a.accountID, aws.ToString(inst.DBSubnetGroup.DBSubnetGroupName))
		emit.Send(a.edge(n.Key, sgKey, "USES_SUBGRP"))
		if vpc := aws.ToString(inst.DBSubnetGroup.VpcId); vpc != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
		}
	}
}

func collectRdsSubnetGroups(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := rds.NewFromConfig(sdk)
	paginator := rds.NewDescribeDBSubnetGroupsPaginator(client, &rds.DescribeDBSubnetGroupsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeDBSubnetGroups: %w", a.region, err)
		}
		for _, sg := range page.DBSubnetGroups {
			emitRdsSubnetGroup(a, sg, emit)
		}
	}
	return nil
}

func emitRdsSubnetGroup(a acc, sg types.DBSubnetGroup, emit *Emitter) {
	name := aws.ToString(sg.DBSubnetGroupName)
	n := a.now()
	n.Label = "DBSG"
	n.Key = fmt.Sprintf("arn:%s:rds:%s:%s:subgrp:%s", a.partition, a.region, a.accountID, name)
	n.Properties = map[string]any{
		"vpc_id":      aws.ToString(sg.VpcId),
		"status":      aws.ToString(sg.SubnetGroupStatus),
		"description": aws.ToString(sg.DBSubnetGroupDescription),
	}
	emit.Send(n)

	if vpc := aws.ToString(sg.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "PART_OF"))
	}
	for _, s := range sg.Subnets {
		if sid := aws.ToString(s.SubnetIdentifier); sid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+sid), "CONTAINS"))
		}
	}
}
