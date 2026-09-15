package collect

import (
	"context"
	"fmt"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

func collectFunctions(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := lambda.NewFromConfig(sdk)
	paginator := lambda.NewListFunctionsPaginator(client, &lambda.ListFunctionsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListFunctions: %w", a.region, err)
		}
		for _, fn := range page.Functions {
			conf, err := client.GetFunctionConfiguration(ctx, &lambda.GetFunctionConfigurationInput{FunctionName: fn.FunctionName})
			if err != nil {
				return fmt.Errorf("%s GetFunctionConfiguration: %w", a.region, err)
			}
			emitFunction(a, fn, conf.VpcConfig, emit)
		}
	}
	return nil
}

func emitFunction(a acc, fn types.FunctionConfiguration, vpc *types.VpcConfigResponse, emit *Emitter) {
	name := aws.ToString(fn.FunctionName)
	n := a.now()
	n.Label = "LAMBDA"
	n.Key = fmt.Sprintf("arn:%s:lambda:%s:%s:function:%s", a.partition, a.region, a.accountID, name)
	n.Properties = map[string]any{
		"runtime":       string(fn.Runtime),
		"memory_mb":     intValue(fn.MemorySize),
		"timeout_sec":   intValue(fn.Timeout),
		"state":         string(fn.State),
		"last_modified": aws.ToString(fn.LastModified),
		"package_type":  string(fn.PackageType),
	}
	n.Name = name
	// Environment variable NAMES only. The values are exactly the secrets this
	// scanner is meant to flag, and writing them into snapshots/ on disk would
	// turn the audit tool into the leak.
	if fn.Environment != nil && len(fn.Environment.Variables) > 0 {
		keys := make([]string, 0, len(fn.Environment.Variables))
		for k := range fn.Environment.Variables {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		n.Properties["env_var_names"] = keys
	}
	n.Properties["in_vpc"] = vpc != nil && aws.ToString(vpc.VpcId) != ""
	emit.Send(n)

	if vpc == nil {
		return
	}
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
