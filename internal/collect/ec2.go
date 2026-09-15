package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func collectInstances(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ec2.NewFromConfig(sdk)
	paginator := ec2.NewDescribeInstancesPaginator(client, &ec2.DescribeInstancesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeInstances: %w", a.region, err)
		}
		for _, res := range page.Reservations {
			for _, inst := range res.Instances {
				emitInstance(a, inst, emit)
			}
		}
	}
	return nil
}

func emitInstance(a acc, inst types.Instance, emit *Emitter) {
	id := aws.ToString(inst.InstanceId)
	n := a.now()
	n.Label = "EC2"
	n.Key = a.ec2Arn("instance/" + id)
	n.Type = string(inst.InstanceType)
	n.Tags = tagsToMap(inst.Tags)
	n.Properties = map[string]any{
		"instance_type": string(inst.InstanceType),
		"image_id":      aws.ToString(inst.ImageId),
		"key_name":      aws.ToString(inst.KeyName),
		"vpc_id":        aws.ToString(inst.VpcId),
		"subnet_id":     aws.ToString(inst.SubnetId),
		"public_ip":     aws.ToString(inst.PublicIpAddress),
		"private_ip":    aws.ToString(inst.PrivateIpAddress),
	}
	if inst.State != nil && inst.State.Name != "" {
		n.Properties["state"] = string(inst.State.Name)
	}
	if inst.Placement != nil {
		n.Properties["az"] = aws.ToString(inst.Placement.AvailabilityZone)
	}
	// Instance Metadata Service settings. IMDSv1 ("optional") lets any SSRF in an
	// application read the instance role's credentials with a plain GET; IMDSv2
	// ("required") needs a PUT to obtain a token, which SSRF generally cannot do.
	if inst.MetadataOptions != nil {
		n.Properties["imds_tokens"] = string(inst.MetadataOptions.HttpTokens)
		n.Properties["imds_endpoint"] = string(inst.MetadataOptions.HttpEndpoint)
		if inst.MetadataOptions.HttpPutResponseHopLimit != nil {
			n.Properties["imds_hop_limit"] = int(*inst.MetadataOptions.HttpPutResponseHopLimit)
		}
	}
	n.Properties["has_instance_profile"] = inst.IamInstanceProfile != nil
	if inst.IamInstanceProfile != nil {
		if arn := aws.ToString(inst.IamInstanceProfile.Arn); arn != "" {
			emit.Send(a.edge(n.Key, arn, "USES_PROFILE"))
		}
	}
	if image := aws.ToString(inst.ImageId); image != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("image/"+image), "RUNS_AMI"))
	}
	n.Name = tagValue(n.Tags, "Name")
	emit.Send(n)

	if vpc := aws.ToString(inst.VpcId); vpc != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("vpc/"+vpc), "IN_VPC"))
	}
	if subnet := aws.ToString(inst.SubnetId); subnet != "" {
		emit.Send(a.edge(n.Key, a.ec2Arn("subnet/"+subnet), "IN_SUBNET"))
	}
	for _, g := range inst.SecurityGroups {
		if gid := aws.ToString(g.GroupId); gid != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("security-group/"+gid), "ASSOC_WITH"))
		}
	}
	for _, eni := range inst.NetworkInterfaces {
		if eniID := aws.ToString(eni.NetworkInterfaceId); eniID != "" {
			emit.Send(a.edge(n.Key, a.ec2Arn("network-interface/"+eniID), "ATTACHES"))
		}
	}
}

func tagValue(tags map[string]string, key string) string {
	if tags == nil {
		return ""
	}
	return tags[key]
}
