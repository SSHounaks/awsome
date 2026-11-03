package collect

import (
	"context"
	"fmt"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge/types"

	"awsome/internal/model"
)

// collectEventRules emits one node per EventBridge rule, plus an edge to every
// target it invokes.
//
// Without this step scheduled work is invisible. The Lambda and the ECS cluster
// are already in the graph, but nothing records that something fires them on a
// cron — so a job that is deployed and never scheduled looks exactly like a job
// that runs every night, and a rule left DISABLED looks exactly like one that
// is working. Both are the kind of thing a map of the estate exists to show.
func collectEventRules(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := a.sdk(ctx, cfg)
	if err != nil {
		return err
	}
	client := eventbridge.NewFromConfig(sdk)

	buses, err := eventBusNames(ctx, client, a)
	if err != nil {
		return err
	}
	for _, bus := range buses {
		if err := collectRulesOnBus(ctx, client, a, bus, emit); err != nil {
			return err
		}
	}
	return nil
}

// eventBusNames lists the account's buses. A rule belongs to exactly one bus and
// ListRules only answers for one at a time, so scanning just "default" would
// silently miss every rule on a custom bus.
func eventBusNames(ctx context.Context, client *eventbridge.Client, a acc) ([]string, error) {
	var names []string
	in := &eventbridge.ListEventBusesInput{}
	for {
		out, err := client.ListEventBuses(ctx, in)
		if err != nil {
			return nil, fmt.Errorf("%s ListEventBuses: %w", a.region, err)
		}
		for _, b := range out.EventBuses {
			if name := aws.ToString(b.Name); name != "" {
				names = append(names, name)
			}
		}
		if out.NextToken == nil {
			return names, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		in.NextToken = out.NextToken
	}
}

func collectRulesOnBus(ctx context.Context, client *eventbridge.Client, a acc, bus string, emit *Emitter) error {
	in := &eventbridge.ListRulesInput{EventBusName: aws.String(bus)}
	for {
		out, err := client.ListRules(ctx, in)
		if err != nil {
			return fmt.Errorf("%s ListRules (bus %s): %w", a.region, bus, err)
		}
		for _, r := range out.Rules {
			targets, err := ruleTargets(ctx, client, a, bus, aws.ToString(r.Name))
			if err != nil {
				return err
			}
			emitEventRule(a, r, bus, targets, emit)
		}
		if out.NextToken == nil {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		in.NextToken = out.NextToken
	}
}

func ruleTargets(ctx context.Context, client *eventbridge.Client, a acc, bus, rule string) ([]types.Target, error) {
	if rule == "" {
		return nil, nil
	}
	var targets []types.Target
	in := &eventbridge.ListTargetsByRuleInput{Rule: aws.String(rule), EventBusName: aws.String(bus)}
	for {
		out, err := client.ListTargetsByRule(ctx, in)
		if err != nil {
			return nil, fmt.Errorf("%s ListTargetsByRule %s: %w", a.region, rule, err)
		}
		targets = append(targets, out.Targets...)
		if out.NextToken == nil {
			return targets, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		in.NextToken = out.NextToken
	}
}

// taskPlacementEdges records the subnets and security groups the rule assigns
// the task. These live on the rule target, not the task definition, which is
// why an unscheduled job has no network position to draw at all.
func taskPlacementEdges(a acc, family string, ep *types.EcsParameters) []model.Edge {
	if ep == nil || ep.NetworkConfiguration == nil || ep.NetworkConfiguration.AwsvpcConfiguration == nil {
		return nil
	}
	vpc := ep.NetworkConfiguration.AwsvpcConfiguration
	var out []model.Edge
	for _, s := range vpc.Subnets {
		if s != "" {
			out = append(out, a.edge(family, a.ec2Arn("subnet/"+s), "IN_SUBNET"))
		}
	}
	for _, g := range vpc.SecurityGroups {
		if g != "" {
			out = append(out, a.edge(family, a.ec2Arn("security-group/"+g), "ASSOC_WITH"))
		}
	}
	return out
}

func emitEventRule(a acc, r types.Rule, bus string, targets []types.Target, emit *Emitter) {
	name := aws.ToString(r.Name)
	n := a.now()
	n.Label = "EVENTBRIDGERULE"
	n.Key = aws.ToString(r.Arn)
	if n.Key == "" {
		n.Key = fmt.Sprintf("arn:%s:events:%s:%s:rule/%s/%s", a.partition, a.region, a.accountID, bus, name)
	}
	n.Name = name
	n.Properties = map[string]any{
		"state":        string(r.State),
		"event_bus":    bus,
		"target_count": len(targets),
		// A rule with no target fires into nothing. It is also what a half-removed
		// job leaves behind, so it is worth being able to query for.
		"orphaned": len(targets) == 0,
	}
	if sched := aws.ToString(r.ScheduleExpression); sched != "" {
		n.Properties["schedule"] = sched
	}
	// The pattern itself runs to kilobytes of JSON and belongs in the console.
	// Whether one exists is the useful bit: it separates a cron from a rule that
	// reacts to events.
	n.Properties["event_driven"] = aws.ToString(r.EventPattern) != ""
	if desc := aws.ToString(r.Description); desc != "" {
		n.Properties["description"] = desc
	}
	// A rule AWS created on the account's behalf (Inspector, Application
	// Insights) is not something the estate's owner wrote, and should not read
	// as their configuration when the graph is reviewed.
	if managed := aws.ToString(r.ManagedBy); managed != "" {
		n.Properties["managed_by"] = managed
	}

	var edges []model.Edge
	var taskDefs []string
	seenRole := map[string]struct{}{}
	for _, t := range targets {
		// An ECS target's Arn is the *cluster*, which says nothing about which
		// job runs. The rule fires a task definition; the cluster is merely
		// where it lands. Pointing TRIGGERS at the job and giving the cluster
		// its own edge makes the chain rule → job → cluster readable, and is
		// what lets an unfired job be drawn as a job with nothing pointing at it.
		if t.EcsParameters != nil {
			if td := aws.ToString(t.EcsParameters.TaskDefinitionArn); td != "" {
				taskDefs = append(taskDefs, td)
				fam := familyOf(td)
				edges = append(edges, a.edge(n.Key, fam, "TRIGGERS"))
				if cluster := aws.ToString(t.Arn); cluster != "" {
					edges = append(edges, a.edge(fam, cluster, "RUNS_ON"))
				}
				// Where the job runs is assigned by the rule, not the task
				// definition — so a job no rule fires genuinely has no placement,
				// and the network view must not invent one for it.
				edges = append(edges, taskPlacementEdges(a, fam, t.EcsParameters)...)
			}
		} else if arn := aws.ToString(t.Arn); arn != "" {
			edges = append(edges, a.edge(n.Key, arn, "TRIGGERS"))
		}
		// Several targets on one rule usually share an invocation role; emitting
		// the edge once keeps the graph readable.
		if role := aws.ToString(t.RoleArn); role != "" {
			if _, dup := seenRole[role]; !dup {
				seenRole[role] = struct{}{}
				edges = append(edges, a.edge(n.Key, role, "USES_ROLE"))
			}
		}
	}
	if len(taskDefs) > 0 {
		sort.Strings(taskDefs)
		n.Properties["ecs_task_definitions"] = taskDefs
	}

	emit.Send(n)
	for _, e := range edges {
		emit.Send(e)
	}
}
