package collect

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	ecstypes "github.com/aws/aws-sdk-go-v2/service/ecs/types"
	ebtypes "github.com/aws/aws-sdk-go-v2/service/eventbridge/types"
)

// A rule pins a revision; the graph keys on the family. If these disagree the
// edge from the rule lands on nothing and the job looks unscheduled.
func TestFamilyOfStripsRevision(t *testing.T) {
	cases := []struct{ in, want string }{
		{
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-dnd-cleanup:1",
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-dnd-cleanup",
		},
		{
			// A different revision of the same job must collapse to one key.
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-dnd-cleanup:27",
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-dnd-cleanup",
		},
		{
			// Already revision-less: the colons in the ARN prefix must not be eaten.
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-purge-processor",
			"arn:aws-us-gov:ecs:us-gov-west-1:392358524895:task-definition/atscene-prd2-cron-job-purge-processor",
		},
	}
	for _, c := range cases {
		if got := familyOf(c.in); got != c.want {
			t.Errorf("familyOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestEmitTaskDefinition(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(16)

	td := ecstypes.TaskDefinition{
		Family:           aws.String("atscene-prd2-cron-job-purge-processor"),
		Revision:         2,
		Cpu:              aws.String("1024"),
		Memory:           aws.String("2048"),
		NetworkMode:      ecstypes.NetworkMode("awsvpc"),
		TaskRoleArn:      aws.String("arn:aws-us-gov:iam::111122223333:role/purge-task-role"),
		ExecutionRoleArn: aws.String("arn:aws-us-gov:iam::111122223333:role/purge-exec-role"),
		ContainerDefinitions: []ecstypes.ContainerDefinition{
			{Name: aws.String("api"), Image: aws.String("1234.dkr.ecr.us-gov-west-1.amazonaws.com/api:sha-abc")},
		},
	}

	emitTaskDefinition(a, "atscene-prd2-cron-job-purge-processor", td, emit)
	nodes, edges := drainEmitter(emit)

	if len(nodes) != 1 || nodes[0].Label != "ECSTASKDEF" {
		t.Fatalf("got %d nodes (%v), want one ECSTASKDEF", len(nodes), nodes)
	}
	n := nodes[0]
	want := "arn:aws-us-gov:ecs:us-gov-west-1:111122223333:task-definition/atscene-prd2-cron-job-purge-processor"
	if n.Key != want {
		t.Errorf("key = %q, want the revision-less family ARN %q", n.Key, want)
	}
	if got := n.Properties["latest_revision"]; got != int32(2) {
		t.Errorf("latest_revision = %v, want 2", got)
	}
	if got := n.Properties["network_mode"]; got != "awsvpc" {
		t.Errorf("network_mode = %v, want awsvpc", got)
	}
	imgs, ok := n.Properties["images"].([]string)
	if !ok || len(imgs) != 1 {
		t.Fatalf("images = %v, want the container image", n.Properties["images"])
	}

	// Only the task role becomes an edge. The execution role merely pulls the
	// image, and making it an edge fills the data-flow view with ECR noise.
	if len(edges) != 1 {
		t.Fatalf("got %d edges, want exactly 1 (task role only): %+v", len(edges), edges)
	}
	if edges[0].Type != "USES_ROLE" || edges[0].To != aws.ToString(td.TaskRoleArn) {
		t.Errorf("edge = %+v, want USES_ROLE to the task role", edges[0])
	}
	if got := n.Properties["execution_role"]; got != aws.ToString(td.ExecutionRoleArn) {
		t.Errorf("execution_role property = %v, want it recorded but not an edge", got)
	}
}

// The rule fires the job and the cluster is only where it lands, so TRIGGERS
// must point at the task definition — that is what lets an unfired job be drawn
// as a job with nothing pointing at it.
func TestEventRuleTargetsTaskDefinitionNotCluster(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(32)
	cluster := "arn:aws-us-gov:ecs:us-gov-west-1:111122223333:cluster/atscene-prd2-cluster"
	pinned := "arn:aws-us-gov:ecs:us-gov-west-1:111122223333:task-definition/atscene-prd2-cron-job-dnd-cleanup:1"
	family := "arn:aws-us-gov:ecs:us-gov-west-1:111122223333:task-definition/atscene-prd2-cron-job-dnd-cleanup"
	role := "arn:aws-us-gov:iam::111122223333:role/events-invoke"

	rule := ebtypes.Rule{
		Name:               aws.String("atscene-prd2-dnd-cleanup-job"),
		Arn:                aws.String("arn:aws-us-gov:events:us-gov-west-1:111122223333:rule/atscene-prd2-dnd-cleanup-job"),
		ScheduleExpression: aws.String("cron(0 */4 * * ? *)"),
		State:              ebtypes.RuleState("ENABLED"),
	}
	targets := []ebtypes.Target{{
		Id:      aws.String("ecs"),
		Arn:     aws.String(cluster),
		RoleArn: aws.String(role),
		EcsParameters: &ebtypes.EcsParameters{
			TaskDefinitionArn: aws.String(pinned),
			NetworkConfiguration: &ebtypes.NetworkConfiguration{
				AwsvpcConfiguration: &ebtypes.AwsVpcConfiguration{
					Subnets:        []string{"subnet-aaa", "subnet-bbb"},
					SecurityGroups: []string{"sg-123"},
				},
			},
		},
	}}

	emitEventRule(a, rule, "default", targets, emit)
	_, edges := drainEmitter(emit)

	find := func(etype, to string) bool {
		for _, e := range edges {
			if e.Type == etype && e.To == to {
				return true
			}
		}
		return false
	}

	if !find("TRIGGERS", family) {
		t.Errorf("want TRIGGERS -> the task definition family %q, got %+v", family, edges)
	}
	for _, e := range edges {
		if e.Type == "TRIGGERS" && e.To == cluster {
			t.Error("TRIGGERS must not point at the cluster — the cluster is where the job lands, not what fires")
		}
	}
	if !find("RUNS_ON", cluster) {
		t.Errorf("want RUNS_ON from the job to the cluster, got %+v", edges)
	}
	// The invocation role must survive the ECS branch.
	if !find("USES_ROLE", role) {
		t.Errorf("want USES_ROLE to the invocation role, got %+v", edges)
	}
	// Placement is assigned by the rule, so a fired job has one.
	if !find("IN_SUBNET", a.ec2Arn("subnet/subnet-aaa")) || !find("IN_SUBNET", a.ec2Arn("subnet/subnet-bbb")) {
		t.Errorf("want IN_SUBNET edges for both subnets, got %+v", edges)
	}
	if !find("ASSOC_WITH", a.ec2Arn("security-group/sg-123")) {
		t.Errorf("want ASSOC_WITH for the security group, got %+v", edges)
	}
}

// A rule with no network configuration must assign no placement at all, rather
// than defaulting to something plausible.
func TestTaskPlacementAbsentWithoutNetworkConfig(t *testing.T) {
	a := testAcc()
	if got := taskPlacementEdges(a, "fam", nil); got != nil {
		t.Errorf("nil EcsParameters produced %+v, want no edges", got)
	}
	ep := &ebtypes.EcsParameters{TaskDefinitionArn: aws.String("x")}
	if got := taskPlacementEdges(a, "fam", ep); got != nil {
		t.Errorf("missing NetworkConfiguration produced %+v, want no edges", got)
	}
}

func TestTaskDefinitionStepIsPlanned(t *testing.T) {
	target := Target{AccountID: "111122223333", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1"}}
	for _, s := range Plan(target) {
		if s.Service == "ecs-task-definitions" {
			return
		}
	}
	t.Fatal("Plan() does not include the ecs-task-definitions step")
}
