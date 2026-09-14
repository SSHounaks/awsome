package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	autoscaling "github.com/aws/aws-sdk-go-v2/service/autoscaling"
	asgt "github.com/aws/aws-sdk-go-v2/service/autoscaling/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dbt "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ect "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	ekst "github.com/aws/aws-sdk-go-v2/service/eks/types"
	"github.com/aws/aws-sdk-go-v2/service/elasticache"
	et "github.com/aws/aws-sdk-go-v2/service/elasticache/types"
	"github.com/aws/aws-sdk-go-v2/service/elasticloadbalancingv2"
	elbt "github.com/aws/aws-sdk-go-v2/service/elasticloadbalancingv2/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdat "github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/aws/aws-sdk-go-v2/service/opensearch"
	ost "github.com/aws/aws-sdk-go-v2/service/opensearch/types"
	"github.com/aws/aws-sdk-go-v2/service/rds"
	"github.com/aws/aws-sdk-go-v2/service/redshift"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3t "github.com/aws/aws-sdk-go-v2/service/s3/types"

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

	fmt.Println("seeding LocalStack with a demo topology...")

	ec2c := ec2.NewFromConfig(sdk)
	iamc := iam.NewFromConfig(sdk)
	elbc := elasticloadbalancingv2.NewFromConfig(sdk)
	rdsC := rds.NewFromConfig(sdk)
	redC := redshift.NewFromConfig(sdk)
	elaC := elasticache.NewFromConfig(sdk)
	osC := opensearch.NewFromConfig(sdk)
	dynC := dynamodb.NewFromConfig(sdk)
	lambC := lambda.NewFromConfig(sdk)
	ecsC := ecs.NewFromConfig(sdk)
	eksC := eks.NewFromConfig(sdk)
	s3c := s3.NewFromConfig(sdk, func(o *s3.Options) { o.UsePathStyle = true })
	ecrC := ecr.NewFromConfig(sdk)
	asgC := autoscaling.NewFromConfig(sdk)

	vpcID, err := createVPC(ctx, ec2c, region)
	must("create VPC", err)
	subnetID, err := createSubnet(ctx, ec2c, vpcID, region)
	must("create subnet", err)
	sgWeb, err := createSG(ctx, ec2c, vpcID, "awsome-demo-web", "web tier (demo)", region)
	must("create web sg", err)
	sgApp, err := createSG(ctx, ec2c, vpcID, "awsome-demo-app", "app tier (demo)", region)
	must("create app sg", err)
	if err := authorizeSGFrom(ctx, ec2c, sgApp, sgWeb, region); err != nil {
		must("authorize ingress", err)
	}

	warn("create igw", createIGW(ctx, ec2c, vpcID, region))
	warn("create route table (default route to igw)", createRouteTable(ctx, ec2c, vpcID, subnetID))
	warn("create nacl + associate", createNACL(ctx, ec2c, vpcID, subnetID))
	eipID, err := allocateEIP(ctx, ec2c, region)
	warn("allocate eip", err)
	fmt.Printf("eip %s\n", eipID)
	warn("create vpc peering (to default vpc)", createPeering(ctx, ec2c, vpcID))

	roleArn, profileName, err := createIAM(ctx, iamc)
	must("create iam role/profile", err)

	instanceID, err := runInstance(ctx, ec2c, subnetID, sgWeb, profileName, region)
	must("run instance", err)
	fmt.Printf("instance %s\n", instanceID)

	warn("create+attach volume", createVolume(ctx, ec2c, instanceID, region))
	warn("create extra eni", createENI(ctx, ec2c, subnetID, sgWeb, region))
	warn("associate eip", associateEIP(ctx, ec2c, eipID, instanceID))
	warn("create image from instance", createImage(ctx, ec2c, instanceID))

	warn("create alb+tg+listener", createLB(ctx, elbc, vpcID, subnetID, sgWeb, instanceID))
	warn("create asg", createASG(ctx, ec2c, asgC, subnetID, sgWeb))

	warn("create rds subnet group + instance", createRDS(ctx, rdsC, vpcID, subnetID, sgApp))
	warn("create elasticache subnet group + cluster", createElastiCache(ctx, elaC, subnetID, sgApp))
	warn("create redshift subnet group + cluster", createRedshift(ctx, redC, subnetID, sgApp))
	warn("create opensearch domain", createOpenSearch(ctx, osC, subnetID, sgApp))
	warn("create dynamodb table", createTable(ctx, dynC))
	warn("create lambda function", createLambda(ctx, lambC, roleArn, subnetID, sgApp))
	warn("create ecs cluster", createECS(ctx, ecsC))
	warn("create eks cluster", createEKS(ctx, eksC, roleArn, subnetID, sgApp))
	warn("create s3 bucket fixtures", createBuckets(ctx, s3c))
	warn("create ecr repository", createECR(ctx, ecrC))

	fmt.Printf("vpc %s subnet %s sg(web) %s sg(app) %s iam-profile %s\n", vpcID, subnetID, sgWeb, sgApp, profileName)
	fmt.Println("done. run `make scan`")
}

func createVPC(ctx context.Context, c *ec2.Client, region *string) (string, error) {
	out, err := c.CreateVpc(ctx, &ec2.CreateVpcInput{
		CidrBlock:         aws.String("10.10.0.0/16"),
		TagSpecifications: tagSpec(ect.ResourceTypeVpc, "awsome-demo", region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Vpc.VpcId), nil
}

func createSubnet(ctx context.Context, c *ec2.Client, vpcID string, region *string) (string, error) {
	out, err := c.CreateSubnet(ctx, &ec2.CreateSubnetInput{
		VpcId:             aws.String(vpcID),
		CidrBlock:         aws.String("10.10.1.0/24"),
		TagSpecifications: tagSpec(ect.ResourceTypeSubnet, "awsome-demo-subnet", region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Subnet.SubnetId), nil
}

func createSG(ctx context.Context, c *ec2.Client, vpcID, name, desc string, region *string) (string, error) {
	out, err := c.CreateSecurityGroup(ctx, &ec2.CreateSecurityGroupInput{
		GroupName:         aws.String(name),
		Description:       aws.String(desc),
		VpcId:             aws.String(vpcID),
		TagSpecifications: tagSpec(ect.ResourceTypeSecurityGroup, name, region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.GroupId), nil
}

func authorizeSGFrom(ctx context.Context, c *ec2.Client, targetSG, sourceSG string, region *string) error {
	_, err := c.AuthorizeSecurityGroupIngress(ctx, &ec2.AuthorizeSecurityGroupIngressInput{
		GroupId: aws.String(targetSG),
		IpPermissions: []ect.IpPermission{{
			IpProtocol:       aws.String("tcp"),
			FromPort:         aws.Int32(8080),
			ToPort:           aws.Int32(8080),
			UserIdGroupPairs: []ect.UserIdGroupPair{{GroupId: aws.String(sourceSG)}},
		}},
	})
	return err
}

func createIGW(ctx context.Context, c *ec2.Client, vpcID string, region *string) error {
	out, err := c.CreateInternetGateway(ctx, &ec2.CreateInternetGatewayInput{
		TagSpecifications: tagSpec(ect.ResourceTypeInternetGateway, "awsome-demo-igw", region),
	})
	if err != nil {
		return err
	}
	_, err = c.AttachInternetGateway(ctx, &ec2.AttachInternetGatewayInput{
		InternetGatewayId: out.InternetGateway.InternetGatewayId,
		VpcId:             aws.String(vpcID),
	})
	fmt.Printf("igw %s\n", aws.ToString(out.InternetGateway.InternetGatewayId))
	return err
}

func createRouteTable(ctx context.Context, c *ec2.Client, vpcID, subnetID string) error {
	out, err := c.CreateRouteTable(ctx, &ec2.CreateRouteTableInput{
		VpcId: aws.String(vpcID),
	})
	if err != nil {
		return err
	}
	rtID := aws.ToString(out.RouteTable.RouteTableId)
	if _, err := c.AssociateRouteTable(ctx, &ec2.AssociateRouteTableInput{RouteTableId: aws.String(rtID), SubnetId: aws.String(subnetID)}); err != nil {
		return err
	}
	igws, err := c.DescribeInternetGateways(ctx, &ec2.DescribeInternetGatewaysInput{})
	if err != nil {
		return err
	}
	for _, g := range igws.InternetGateways {
		for _, att := range g.Attachments {
			if aws.ToString(att.VpcId) == vpcID {
				if _, err := c.CreateRoute(ctx, &ec2.CreateRouteInput{
					RouteTableId:         aws.String(rtID),
					DestinationCidrBlock: aws.String("0.0.0.0/0"),
					GatewayId:            g.InternetGatewayId,
				}); err != nil {
					return err
				}
			}
		}
	}
	fmt.Printf("route-table %s\n", rtID)
	return nil
}

func createNACL(ctx context.Context, c *ec2.Client, vpcID, subnetID string) error {
	out, err := c.CreateNetworkAcl(ctx, &ec2.CreateNetworkAclInput{VpcId: aws.String(vpcID)})
	if err != nil {
		return err
	}
	aclID := aws.ToString(out.NetworkAcl.NetworkAclId)
	cur, err := c.DescribeNetworkAcls(ctx, &ec2.DescribeNetworkAclsInput{Filters: []ect.Filter{{Name: aws.String("association.subnet-id"), Values: []string{subnetID}}}})
	if err == nil && len(cur.NetworkAcls) > 0 && len(cur.NetworkAcls[0].Associations) > 0 {
		assocID := cur.NetworkAcls[0].Associations[0].NetworkAclAssociationId
		_, err = c.ReplaceNetworkAclAssociation(ctx, &ec2.ReplaceNetworkAclAssociationInput{
			AssociationId: assocID,
			NetworkAclId:  aws.String(aclID),
		})
	}
	fmt.Printf("nacl %s\n", aclID)
	return err
}

func allocateEIP(ctx context.Context, c *ec2.Client, region *string) (string, error) {
	out, err := c.AllocateAddress(ctx, &ec2.AllocateAddressInput{
		Domain:            ect.DomainTypeVpc,
		TagSpecifications: tagSpec(ect.ResourceTypeElasticIp, "awsome-demo-eip", region),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.AllocationId), nil
}

func associateEIP(ctx context.Context, c *ec2.Client, allocationID, instanceID string) error {
	_, err := c.AssociateAddress(ctx, &ec2.AssociateAddressInput{AllocationId: aws.String(allocationID), InstanceId: aws.String(instanceID)})
	return err
}

func createPeering(ctx context.Context, c *ec2.Client, vpcID string) error {
	def, err := c.DescribeVpcs(ctx, &ec2.DescribeVpcsInput{Filters: []ect.Filter{{Name: aws.String("isDefault"), Values: []string{"true"}}}})
	if err != nil || len(def.Vpcs) == 0 {
		return fmt.Errorf("find default vpc: %w", err)
	}
	_, err = c.CreateVpcPeeringConnection(ctx, &ec2.CreateVpcPeeringConnectionInput{
		VpcId:     aws.String(vpcID),
		PeerVpcId: def.Vpcs[0].VpcId,
	})
	return err
}

func createIAM(ctx context.Context, c *iam.Client) (string, string, error) {
	trust, _ := json.Marshal(map[string]any{
		"Version": "2012-10-17",
		"Statement": []map[string]any{{
			"Effect":    "Allow",
			"Principal": map[string]any{"Service": []string{"ec2.amazonaws.com", "lambda.amazonaws.com"}},
			"Action":    "sts:AssumeRole",
		}},
	})
	role, err := c.CreateRole(ctx, &iam.CreateRoleInput{
		RoleName:                 aws.String("awsome-demo-role"),
		AssumeRolePolicyDocument: aws.String(string(trust)),
		Description:              aws.String("demo role (phase-1)"),
		Path:                     aws.String("/"),
	})
	if err != nil {
		return "", "", err
	}
	roleArn := aws.ToString(role.Role.Arn)

	pol, err := c.CreatePolicy(ctx, &iam.CreatePolicyInput{
		PolicyName:     aws.String("awsome-demo-policy"),
		Path:           aws.String("/"),
		Description:    aws.String("demo policy"),
		PolicyDocument: aws.String(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ec2:Describe*"],"Resource":"*"}]}`),
	})
	if err != nil {
		return roleArn, "", err
	}
	if _, err := c.AttachRolePolicy(ctx, &iam.AttachRolePolicyInput{RoleName: aws.String("awsome-demo-role"), PolicyArn: pol.Policy.Arn}); err != nil {
		return roleArn, "", err
	}
	if _, err := c.CreateInstanceProfile(ctx, &iam.CreateInstanceProfileInput{InstanceProfileName: aws.String("awsome-demo-profile")}); err != nil {
		return roleArn, "awsome-demo-profile", err
	}
	if _, err := c.AddRoleToInstanceProfile(ctx, &iam.AddRoleToInstanceProfileInput{InstanceProfileName: aws.String("awsome-demo-profile"), RoleName: aws.String("awsome-demo-role")}); err != nil {
		return roleArn, "awsome-demo-profile", err
	}
	fmt.Printf("iam-role %s\n", roleArn)
	return roleArn, "awsome-demo-profile", nil
}

func runInstance(ctx context.Context, c *ec2.Client, subnetID, sgID, profileName string, region *string) (string, error) {
	out, err := c.RunInstances(ctx, &ec2.RunInstancesInput{
		ImageId:          aws.String("ami-00000000000000000"),
		InstanceType:     ect.InstanceTypeT3Micro,
		MinCount:         aws.Int32(1),
		MaxCount:         aws.Int32(1),
		SubnetId:         aws.String(subnetID),
		SecurityGroupIds: []string{sgID},
		IamInstanceProfile: &ect.IamInstanceProfileSpecification{
			Name: aws.String(profileName),
		},
		TagSpecifications: tagSpec(ect.ResourceTypeInstance, "awsome-demo-web-1", region),
	})
	if err != nil {
		return "", err
	}
	if len(out.Instances) == 0 {
		return "", fmt.Errorf("no instances returned")
	}
	return aws.ToString(out.Instances[0].InstanceId), nil
}

func createVolume(ctx context.Context, c *ec2.Client, instanceID string, region *string) error {
	out, err := c.CreateVolume(ctx, &ec2.CreateVolumeInput{
		AvailabilityZone:  aws.String("us-east-1a"),
		Size:              aws.Int32(8),
		VolumeType:        ect.VolumeTypeGp2,
		TagSpecifications: tagSpec(ect.ResourceTypeVolume, "awsome-demo-volume", region),
	})
	if err != nil {
		return err
	}
	_, err = c.AttachVolume(ctx, &ec2.AttachVolumeInput{
		VolumeId:   out.VolumeId,
		InstanceId: aws.String(instanceID),
		Device:     aws.String("/dev/sdf"),
	})
	fmt.Printf("volume %s\n", aws.ToString(out.VolumeId))
	return err
}

func createENI(ctx context.Context, c *ec2.Client, subnetID, sgID string, region *string) error {
	out, err := c.CreateNetworkInterface(ctx, &ec2.CreateNetworkInterfaceInput{
		SubnetId:          aws.String(subnetID),
		Groups:            []string{sgID},
		Description:       aws.String("awsome-demo-eni"),
		TagSpecifications: tagSpec(ect.ResourceTypeNetworkInterface, "awsome-demo-eni", region),
	})
	if err != nil {
		return err
	}
	fmt.Printf("eni %s\n", aws.ToString(out.NetworkInterface.NetworkInterfaceId))
	return nil
}

func createImage(ctx context.Context, c *ec2.Client, instanceID string) error {
	_, err := c.CreateImage(ctx, &ec2.CreateImageInput{
		InstanceId:  aws.String(instanceID),
		Name:        aws.String("awsome-demo-ami"),
		Description: aws.String("demo ami"),
	})
	return err
}

func createLB(ctx context.Context, c *elasticloadbalancingv2.Client, vpcID, subnetID, sgID, instanceID string) error {
	lbOut, err := c.CreateLoadBalancer(ctx, &elasticloadbalancingv2.CreateLoadBalancerInput{
		Name:           aws.String("awsome-demo-alb"),
		Subnets:        []string{subnetID},
		SecurityGroups: []string{sgID},
		Type:           elbt.LoadBalancerTypeEnumApplication,
		Scheme:         elbt.LoadBalancerSchemeEnumInternetFacing,
		IpAddressType:  elbt.IpAddressTypeIpv4,
	})
	if err != nil {
		return err
	}
	lbArn := aws.ToString(lbOut.LoadBalancers[0].LoadBalancerArn)
	tgOut, err := c.CreateTargetGroup(ctx, &elasticloadbalancingv2.CreateTargetGroupInput{
		Name:       aws.String("awsome-demo-tg"),
		Protocol:   elbt.ProtocolEnumHttp,
		Port:       aws.Int32(8080),
		VpcId:      aws.String(vpcID),
		TargetType: elbt.TargetTypeEnumInstance,
	})
	if err != nil {
		return err
	}
	tgArn := aws.ToString(tgOut.TargetGroups[0].TargetGroupArn)
	if _, err := c.RegisterTargets(ctx, &elasticloadbalancingv2.RegisterTargetsInput{
		TargetGroupArn: aws.String(tgArn),
		Targets:        []elbt.TargetDescription{{Id: aws.String(instanceID)}},
	}); err != nil {
		return err
	}
	_, err = c.CreateListener(ctx, &elasticloadbalancingv2.CreateListenerInput{
		LoadBalancerArn: aws.String(lbArn),
		Protocol:        elbt.ProtocolEnumHttp,
		Port:            aws.Int32(80),
		DefaultActions:  []elbt.Action{{Type: elbt.ActionTypeEnumForward, TargetGroupArn: aws.String(tgArn)}},
	})
	fmt.Printf("alb %s tg %s\n", lbArn, tgArn)
	return err
}

func createASG(ctx context.Context, ec2c *ec2.Client, c *autoscaling.Client, subnetID, sgID string) error {
	if _, err := ec2c.CreateLaunchTemplate(ctx, &ec2.CreateLaunchTemplateInput{
		LaunchTemplateName: aws.String("awsome-demo-lt"),
		LaunchTemplateData: &ect.RequestLaunchTemplateData{
			ImageId:          aws.String("ami-00000000000000000"),
			InstanceType:     "t3.micro",
			SecurityGroupIds: []string{sgID},
		},
	}); err != nil {
		return err
	}
	_, err := c.CreateAutoScalingGroup(ctx, &autoscaling.CreateAutoScalingGroupInput{
		AutoScalingGroupName: aws.String("awsome-demo-asg"),
		LaunchTemplate:       &asgt.LaunchTemplateSpecification{LaunchTemplateName: aws.String("awsome-demo-lt")},
		MinSize:              aws.Int32(1),
		MaxSize:              aws.Int32(2),
		DesiredCapacity:      aws.Int32(1),
		VPCZoneIdentifier:    aws.String(subnetID),
	})
	return err
}

func createRDS(ctx context.Context, c *rds.Client, vpcID, subnetID, sgID string) error {
	if _, err := c.CreateDBSubnetGroup(ctx, &rds.CreateDBSubnetGroupInput{
		DBSubnetGroupName:        aws.String("awsome-demo"),
		DBSubnetGroupDescription: aws.String("demo"),
		SubnetIds:                []string{subnetID},
	}); err != nil {
		return err
	}
	_, err := c.CreateDBInstance(ctx, &rds.CreateDBInstanceInput{
		DBInstanceIdentifier: aws.String("awsome-demo-mysql"),
		Engine:               aws.String("mysql"),
		DBInstanceClass:      aws.String("db.t3.micro"),
		AllocatedStorage:     aws.Int32(20),
		MasterUsername:       aws.String("admin"),
		MasterUserPassword:   aws.String("password123"),
		DBSubnetGroupName:    aws.String("awsome-demo"),
		VpcSecurityGroupIds:  []string{sgID},
	})
	return err
}

func createElastiCache(ctx context.Context, c *elasticache.Client, subnetID, sgID string) error {
	if _, err := c.CreateCacheSubnetGroup(ctx, &elasticache.CreateCacheSubnetGroupInput{
		CacheSubnetGroupName:        aws.String("awsome-demo"),
		CacheSubnetGroupDescription: aws.String("demo"),
		SubnetIds:                   []string{subnetID},
	}); err != nil {
		return err
	}
	_, err := c.CreateCacheCluster(ctx, &elasticache.CreateCacheClusterInput{
		CacheClusterId:       aws.String("awsome-demo-memcached"),
		Engine:               aws.String("memcached"),
		CacheNodeType:        aws.String("cache.t3.micro"),
		NumCacheNodes:        aws.Int32(1),
		CacheSubnetGroupName: aws.String("awsome-demo"),
		SecurityGroupIds:     []string{sgID},
		Tags:                 []et.Tag{{Key: aws.String("Name"), Value: aws.String("awsome-demo-memcached")}},
	})
	return err
}

func createRedshift(ctx context.Context, c *redshift.Client, subnetID, sgID string) error {
	if _, err := c.CreateClusterSubnetGroup(ctx, &redshift.CreateClusterSubnetGroupInput{
		ClusterSubnetGroupName: aws.String("awsome-demo"),
		Description:            aws.String("demo"),
		SubnetIds:              []string{subnetID},
	}); err != nil {
		return err
	}
	_, err := c.CreateCluster(ctx, &redshift.CreateClusterInput{
		ClusterIdentifier:      aws.String("awsome-demo"),
		NodeType:               aws.String("dc2.large"),
		MasterUsername:         aws.String("admin"),
		MasterUserPassword:     aws.String("Password123!"),
		NumberOfNodes:          aws.Int32(1),
		ClusterSubnetGroupName: aws.String("awsome-demo"),
		VpcSecurityGroupIds:    []string{sgID},
	})
	return err
}

func createOpenSearch(ctx context.Context, c *opensearch.Client, subnetID, sgID string) error {
	_, err := c.CreateDomain(ctx, &opensearch.CreateDomainInput{
		DomainName:    aws.String("awsome-demo"),
		EngineVersion: aws.String("OpenSearch_1.0"),
		ClusterConfig: &ost.ClusterConfig{
			InstanceType:  ost.OpenSearchPartitionInstanceTypeM4LargeSearch,
			InstanceCount: aws.Int32(1),
		},
		VPCOptions: &ost.VPCOptions{
			SubnetIds:        []string{subnetID},
			SecurityGroupIds: []string{sgID},
		},
	})
	return err
}

func createTable(ctx context.Context, c *dynamodb.Client) error {
	_, err := c.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:            aws.String("awsome-demo-orders"),
		AttributeDefinitions: []dbt.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: dbt.ScalarAttributeTypeS}},
		KeySchema:            []dbt.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: dbt.KeyTypeHash}},
		BillingMode:          dbt.BillingModePayPerRequest,
		Tags:                 []dbt.Tag{{Key: aws.String("Name"), Value: aws.String("awsome-demo-orders")}},
	})
	return err
}

func createLambda(ctx context.Context, c *lambda.Client, roleArn, subnetID, sgID string) error {
	body := `def handler(event, context):
    return {"statusCode": 200, "body": "ok"}`
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, _ := zw.Create("index.py")
	_, _ = f.Write([]byte(body))
	_ = zw.Close()

	_, err := c.CreateFunction(ctx, &lambda.CreateFunctionInput{
		FunctionName: aws.String("awsome-demo-fn"),
		Runtime:      lambdat.RuntimePython312,
		Handler:      aws.String("index.handler"),
		Role:         aws.String(roleArn),
		Code:         &lambdat.FunctionCode{ZipFile: buf.Bytes()},
		Timeout:      aws.Int32(10),
		VpcConfig: &lambdat.VpcConfig{
			SubnetIds:        []string{subnetID},
			SecurityGroupIds: []string{sgID},
		},
	})
	return err
}

func createECS(ctx context.Context, c *ecs.Client) error {
	_, err := c.CreateCluster(ctx, &ecs.CreateClusterInput{ClusterName: aws.String("awsome-demo")})
	return err
}

func createEKS(ctx context.Context, c *eks.Client, roleArn, subnetID, sgID string) error {
	_, err := c.CreateCluster(ctx, &eks.CreateClusterInput{
		Name:    aws.String("awsome-demo"),
		RoleArn: aws.String(roleArn),
		ResourcesVpcConfig: &ekst.VpcConfigRequest{
			SubnetIds:        []string{subnetID},
			SecurityGroupIds: []string{sgID},
		},
	})
	return err
}

func createBuckets(ctx context.Context, c *s3.Client) error {
	for _, name := range []string{"awsome-demo-assets", "awsome-demo-public"} {
		if _, err := c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(name)}); err != nil {
			return err
		}
		if _, err := c.PutBucketTagging(ctx, &s3.PutBucketTaggingInput{
			Bucket:  aws.String(name),
			Tagging: &s3t.Tagging{TagSet: []s3t.Tag{{Key: aws.String("Name"), Value: aws.String(name)}}},
		}); err != nil {
			return err
		}
		if _, err := c.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{
			Bucket:                  aws.String(name),
			VersioningConfiguration: &s3t.VersioningConfiguration{Status: s3t.BucketVersioningStatusEnabled},
		}); err != nil {
			return err
		}
	}
	if _, err := c.PutBucketAcl(ctx, &s3.PutBucketAclInput{
		Bucket: aws.String("awsome-demo-public"),
		ACL:    s3t.BucketCannedACLPublicRead,
	}); err != nil {
		return err
	}
	fmt.Println("s3 buckets awsome-demo-assets, awsome-demo-public")
	return nil
}

func createECR(ctx context.Context, c *ecr.Client) error {
	_, err := c.CreateRepository(ctx, &ecr.CreateRepositoryInput{RepositoryName: aws.String("awsome-demo")})
	return err
}

func tagSpec(resource ect.ResourceType, name string, region *string) []ect.TagSpecification {
	return []ect.TagSpecification{{
		ResourceType: resource,
		Tags: []ect.Tag{
			{Key: aws.String("Name"), Value: aws.String(name)},
			{Key: aws.String("env"), Value: aws.String("dev")},
		},
	}}
}

func warn(label string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN %-28s %v\n", label, err)
	}
}

func must(label string, err error) {
	if err != nil {
		fatal(label, err)
	}
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	os.Exit(1)
}
