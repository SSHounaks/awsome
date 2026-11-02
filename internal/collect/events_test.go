package collect

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge/types"

	"awsome/internal/model"
)

func testAcc() acc {
	return acc{accountID: "111122223333", partition: "aws-us-gov", region: "us-gov-west-1", snapshot: "snap-1"}
}

// drainEmitter closes the emitter and sorts what came out of it by kind.
func drainEmitter(emit *Emitter) ([]model.Node, []model.Edge) {
	emit.Close()
	var nodes []model.Node
	var edges []model.Edge
	for r := range emit.Chan() {
		switch v := r.(type) {
		case model.Node:
			nodes = append(nodes, v)
		case model.Edge:
			edges = append(edges, v)
		}
	}
	return nodes, edges
}

func edgeTypes(edges []model.Edge, etype string) []model.Edge {
	var out []model.Edge
	for _, e := range edges {
		if e.Type == etype {
			out = append(out, e)
		}
	}
	return out
}

// A scheduled ECS cron is the case the collector exists for: the cluster is
// already in the graph, but which task definition fires on the cron is recorded
// nowhere else.
func TestEmitEventRuleScheduledEcsCron(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(16)

	rule := types.Rule{
		Name:               aws.String("atscene-prd2-dnd-cleanup-job"),
		Arn:                aws.String("arn:aws-us-gov:events:us-gov-west-1:111122223333:rule/atscene-prd2-dnd-cleanup-job"),
		ScheduleExpression: aws.String("cron(0 */4 * * ? *)"),
		State:              types.RuleState("DISABLED"),
		Description:        aws.String("Trigger DND cleanup cron job"),
	}
	cluster := "arn:aws-us-gov:ecs:us-gov-west-1:111122223333:cluster/atscene-prd2-cluster"
	role := "arn:aws-us-gov:iam::111122223333:role/atscene-prd2-events-role"
	targets := []types.Target{{
		Id:      aws.String("ecs-target"),
		Arn:     aws.String(cluster),
		RoleArn: aws.String(role),
		EcsParameters: &types.EcsParameters{
			TaskDefinitionArn: aws.String("arn:aws-us-gov:ecs:us-gov-west-1:111122223333:task-definition/atscene-prd2-cron-job-dnd-cleanup:1"),
		},
	}}

	emitEventRule(a, rule, "default", targets, emit)
	nodes, edges := drainEmitter(emit)

	if len(nodes) != 1 {
		t.Fatalf("got %d nodes, want 1", len(nodes))
	}
	n := nodes[0]
	if n.Label != "EVENTBRIDGERULE" {
		t.Errorf("label = %q, want EVENTBRIDGERULE", n.Label)
	}
	if n.Key != aws.ToString(rule.Arn) {
		t.Errorf("key = %q, want the rule ARN", n.Key)
	}
	if got := n.Properties["schedule"]; got != "cron(0 */4 * * ? *)" {
		t.Errorf("schedule = %v, want the cron expression", got)
	}
	// A disabled rule must not read as a working one.
	if got := n.Properties["state"]; got != "DISABLED" {
		t.Errorf("state = %v, want DISABLED", got)
	}
	if got := n.Properties["event_driven"]; got != false {
		t.Errorf("event_driven = %v, want false for a pure cron", got)
	}
	if got := n.Properties["orphaned"]; got != false {
		t.Errorf("orphaned = %v, want false when the rule has a target", got)
	}
	tds, ok := n.Properties["ecs_task_definitions"].([]string)
	if !ok || len(tds) != 1 {
		t.Fatalf("ecs_task_definitions = %v, want one task definition", n.Properties["ecs_task_definitions"])
	}
	if tds[0] != aws.ToString(targets[0].EcsParameters.TaskDefinitionArn) {
		t.Errorf("task definition = %q, want the target's", tds[0])
	}

	triggers := edgeTypes(edges, "TRIGGERS")
	if len(triggers) != 1 || triggers[0].To != cluster {
		t.Errorf("TRIGGERS edges = %+v, want one pointing at the cluster", triggers)
	}
	if roles := edgeTypes(edges, "USES_ROLE"); len(roles) != 1 || roles[0].To != role {
		t.Errorf("USES_ROLE edges = %+v, want one pointing at the invocation role", roles)
	}
}

// Several targets on one rule normally share an invocation role. Emitting the
// edge once per target would multiply it for no information gain.
func TestEmitEventRuleDeduplicatesRoleEdges(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(32)
	role := "arn:aws-us-gov:iam::111122223333:role/shared-events-role"

	rule := types.Rule{
		Name: aws.String("fan-out"),
		Arn:  aws.String("arn:aws-us-gov:events:us-gov-west-1:111122223333:rule/fan-out"),
	}
	targets := []types.Target{
		{Id: aws.String("1"), Arn: aws.String("arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:a"), RoleArn: aws.String(role)},
		{Id: aws.String("2"), Arn: aws.String("arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:b"), RoleArn: aws.String(role)},
		{Id: aws.String("3"), Arn: aws.String("arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:c"), RoleArn: aws.String(role)},
	}

	emitEventRule(a, rule, "default", targets, emit)
	nodes, edges := drainEmitter(emit)

	if got := nodes[0].Properties["target_count"]; got != 3 {
		t.Errorf("target_count = %v, want 3", got)
	}
	if triggers := edgeTypes(edges, "TRIGGERS"); len(triggers) != 3 {
		t.Errorf("got %d TRIGGERS edges, want one per target", len(triggers))
	}
	if roles := edgeTypes(edges, "USES_ROLE"); len(roles) != 1 {
		t.Errorf("got %d USES_ROLE edges, want 1 after dedup", len(roles))
	}
}

// A rule with no targets fires into nothing — the residue of a half-removed
// job, and worth being able to query for.
func TestEmitEventRuleOrphanAndEventDriven(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(8)

	rule := types.Rule{
		Name:         aws.String("atscene-prd2-s3-api-deletion"),
		Arn:          aws.String("arn:aws-us-gov:events:us-gov-west-1:111122223333:rule/atscene-prd2-s3-api-deletion"),
		EventPattern: aws.String(`{"source":["aws.s3"]}`),
		ManagedBy:    aws.String("inspector.amazonaws.com"),
	}

	emitEventRule(a, rule, "default", nil, emit)
	nodes, edges := drainEmitter(emit)

	n := nodes[0]
	if got := n.Properties["orphaned"]; got != true {
		t.Errorf("orphaned = %v, want true for a rule with no targets", got)
	}
	if got := n.Properties["target_count"]; got != 0 {
		t.Errorf("target_count = %v, want 0", got)
	}
	if got := n.Properties["event_driven"]; got != true {
		t.Errorf("event_driven = %v, want true when an EventPattern is set", got)
	}
	// An AWS-managed rule should not read as the account owner's configuration.
	if got := n.Properties["managed_by"]; got != "inspector.amazonaws.com" {
		t.Errorf("managed_by = %v, want the managing service", got)
	}
	if _, set := n.Properties["schedule"]; set {
		t.Errorf("schedule should be absent on an event-driven rule, got %v", n.Properties["schedule"])
	}
	if len(edges) != 0 {
		t.Errorf("got %d edges, want none for a rule with no targets", len(edges))
	}
}

// ListRules can answer without an ARN; the node still needs a stable key or it
// collides with every other keyless rule in the snapshot.
func TestEmitEventRuleSynthesisesKeyWithoutArn(t *testing.T) {
	a := testAcc()
	emit := NewEmitter(8)

	emitEventRule(a, types.Rule{Name: aws.String("nameless")}, "custom-bus", nil, emit)
	nodes, _ := drainEmitter(emit)

	want := "arn:aws-us-gov:events:us-gov-west-1:111122223333:rule/custom-bus/nameless"
	if nodes[0].Key != want {
		t.Errorf("key = %q, want %q", nodes[0].Key, want)
	}
	if got := nodes[0].Properties["event_bus"]; got != "custom-bus" {
		t.Errorf("event_bus = %v, want custom-bus", got)
	}
}

// The step has to be planned, or the collector never runs.
func TestEventsStepIsPlanned(t *testing.T) {
	target := Target{AccountID: "111122223333", Partition: "aws-us-gov", Regions: []string{"us-gov-west-1"}}
	for _, s := range Plan(target) {
		if s.Service == "events" {
			return
		}
	}
	t.Fatal("Plan() does not include the events step")
}
