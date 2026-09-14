package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"

	"awsome/internal/awscfg"
)

func main() {
	endpoint := flag.String("endpoint-url", os.Getenv("AWS_ENDPOINT_URL"), "AWS endpoint (LocalStack)")
	region := flag.String("region", "us-east-1", "region")
	flag.Parse()

	ctx := context.Background()
	sdk, err := awscfg.Load(ctx, *endpoint, *region, "")
	if err != nil {
		fatal("sdk config", err)
	}
	client := ec2.NewFromConfig(sdk)

	fmt.Println("seeding LocalStack with a demo topology...")

	vpcID, err := createVPC(ctx, client, region)
	if err != nil {
		fatal("create VPC", err)
	}
	subnetID, err := createSubnet(ctx, client, vpcID, region)
	if err != nil {
		fatal("create subnet", err)
	}
	sgWeb, err := createSG(ctx, client, vpcID, "awsome-demo-web", "web tier (phase-0 demo)", region)
	if err != nil {
		fatal("create web sg", err)
	}
	sgApp, err := createSG(ctx, client, vpcID, "awsome-demo-app", "app tier (phase-0 demo)", region)
	if err != nil {
		fatal("create app sg", err)
	}
	if err := authorizeSGFrom(ctx, client, sgApp, sgWeb, region); err != nil {
		fatal("authorize ingress", err)
	}

	instanceID, err := runInstance(ctx, client, subnetID, sgWeb, region)
	if err != nil {
		fmt.Fprintln(os.Stderr, "run instance:", err)
		fmt.Fprintln(os.Stderr, "(entities above were still created; add an instance manually if needed)")
	} else {
		fmt.Printf("instance %s\n", instanceID)
	}

	fmt.Printf("vpc %s subnet %s sg(web) %s sg(app) %s\n", vpcID, subnetID, sgWeb, sgApp)
	fmt.Println("done. run `make scan` (or go run ./cmd/awsome-scanner --endpoint-url http://localhost:4566)")
}

func createVPC(ctx context.Context, c *ec2.Client, region *string) (string, error) {
	out, err := c.CreateVpc(ctx, &ec2.CreateVpcInput{
		CidrBlock: aws.String("10.10.0.0/16"),
		TagSpecifications: tagSpec(types.ResourceTypeVpc, "awsome-demo", region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Vpc.VpcId), nil
}

func createSubnet(ctx context.Context, c *ec2.Client, vpcID string, region *string) (string, error) {
	out, err := c.CreateSubnet(ctx, &ec2.CreateSubnetInput{
		VpcId:     aws.String(vpcID),
		CidrBlock: aws.String("10.10.1.0/24"),
		TagSpecifications: tagSpec(types.ResourceTypeSubnet, "awsome-demo-subnet", region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Subnet.SubnetId), nil
}

func createSG(ctx context.Context, c *ec2.Client, vpcID, name, desc string, region *string) (string, error) {
	out, err := c.CreateSecurityGroup(ctx, &ec2.CreateSecurityGroupInput{
		GroupName:   aws.String(name),
		Description: aws.String(desc),
		VpcId:       aws.String(vpcID),
		TagSpecifications: tagSpec(types.ResourceTypeSecurityGroup, name, region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.GroupId), nil
}

func authorizeSGFrom(ctx context.Context, c *ec2.Client, targetSG, sourceSG string, region *string) error {
	_, err := c.AuthorizeSecurityGroupIngress(ctx, &ec2.AuthorizeSecurityGroupIngressInput{
		GroupId: aws.String(targetSG),
		IpPermissions: []types.IpPermission{{
			IpProtocol: aws.String("tcp"),
			FromPort:   aws.Int32(8080),
			ToPort:     aws.Int32(8080),
			UserIdGroupPairs: []types.UserIdGroupPair{{GroupId: aws.String(sourceSG)}},
		}},
	})
	return err
}

func runInstance(ctx context.Context, c *ec2.Client, subnetID, sgID string, region *string) (string, error) {
	out, err := c.RunInstances(ctx, &ec2.RunInstancesInput{
		ImageId:          aws.String("ami-00000000000000000"),
		InstanceType:     types.InstanceTypeT3Micro,
		MinCount:         aws.Int32(1),
		MaxCount:         aws.Int32(1),
		SubnetId:         aws.String(subnetID),
		SecurityGroupIds: []string{sgID},
		TagSpecifications: tagSpec(types.ResourceTypeInstance, "awsome-demo-web-1", region),
	})
	if err != nil {
		return "", err
	}
	if len(out.Instances) == 0 {
		return "", fmt.Errorf("no instances returned")
	}
	return aws.ToString(out.Instances[0].InstanceId), nil
}

func tagSpec(resource types.ResourceType, name string, region *string) []types.TagSpecification {
	return []types.TagSpecification{{
		ResourceType: resource,
		Tags: []types.Tag{
			{Key: aws.String("Name"), Value: aws.String(name)},
			{Key: aws.String("env"), Value: aws.String("dev")},
		},
	}}
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}
