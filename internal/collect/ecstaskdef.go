package collect

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"
)

// taskDefFamilyArn is the key every task definition is recorded under.
//
// Deliberately revision-less. A rule pins a specific revision — prd2 fires
// dnd-cleanup:1 and retag-purged-versions:2 — so keying on the full ARN would
// make an edge match or miss depending on which revision happened to be pinned,
// and would draw the same job twice the moment a new revision shipped. The
// family is the job; the revision is which version of it.
func taskDefFamilyArn(a acc, family string) string {
	return fmt.Sprintf("arn:%s:ecs:%s:%s:task-definition/%s", a.partition, a.region, a.accountID, family)
}

// familyOf strips the ":revision" suffix from a task definition ARN so a
// reference to a pinned revision resolves to the job it is a version of.
func familyOf(taskDefArn string) string {
	i := strings.LastIndex(taskDefArn, ":")
	if i <= strings.LastIndex(taskDefArn, "/") {
		return taskDefArn
	}
	return taskDefArn[:i]
}

// collectEcsTaskDefinitions emits one node per ACTIVE task definition family.
//
// A cron job's existence and its scheduling are separate facts, and only the
// second one lives in EventBridge. Collecting the rule alone meant a job that
// is fully deployed — image, task role, guardrail policies — but that nothing
// fires was represented by *nothing at all*, which reads identically to a job
// that was never built. On prod that is six of them, purge-processor included.
func collectEcsTaskDefinitions(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := a.sdk(ctx, cfg)
	if err != nil {
		return err
	}
	client := ecs.NewFromConfig(sdk)

	paginator := ecs.NewListTaskDefinitionFamiliesPaginator(client, &ecs.ListTaskDefinitionFamiliesInput{
		Status: types.TaskDefinitionFamilyStatusActive,
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListTaskDefinitionFamilies: %w", a.region, err)
		}
		for _, family := range page.Families {
			if family == "" {
				continue
			}
			out, err := client.DescribeTaskDefinition(ctx, &ecs.DescribeTaskDefinitionInput{
				TaskDefinition: aws.String(family),
			})
			if err != nil {
				return fmt.Errorf("%s DescribeTaskDefinition %s: %w", a.region, family, err)
			}
			if out.TaskDefinition != nil {
				emitTaskDefinition(a, family, *out.TaskDefinition, emit)
			}
		}
	}
	return nil
}

func emitTaskDefinition(a acc, family string, td types.TaskDefinition, emit *Emitter) {
	n := a.now()
	n.Label = "ECSTASKDEF"
	n.Key = taskDefFamilyArn(a, family)
	n.Name = family
	n.Properties = map[string]any{
		"latest_revision": td.Revision,
		"network_mode":    string(td.NetworkMode),
		"containers":      len(td.ContainerDefinitions),
	}
	if cpu := aws.ToString(td.Cpu); cpu != "" {
		n.Properties["cpu"] = cpu
	}
	if mem := aws.ToString(td.Memory); mem != "" {
		n.Properties["memory"] = mem
	}
	if len(td.RequiresCompatibilities) > 0 {
		compat := make([]string, 0, len(td.RequiresCompatibilities))
		for _, c := range td.RequiresCompatibilities {
			compat = append(compat, string(c))
		}
		sort.Strings(compat)
		n.Properties["launch_types"] = compat
	}
	// The image says what the job actually is — which repository, which tag —
	// and is the only part of a task definition that changes between releases.
	images := make([]string, 0, len(td.ContainerDefinitions))
	for _, c := range td.ContainerDefinitions {
		if img := aws.ToString(c.Image); img != "" {
			images = append(images, img)
		}
	}
	if len(images) > 0 {
		sort.Strings(images)
		n.Properties["images"] = images
	}
	// The execution role only pulls the image and writes logs. It is the task
	// role that decides what the job can do to the estate, so only that one
	// becomes an edge — otherwise the data-flow view fills with ECR and logs
	// grants that tell you nothing about the workload.
	if exec := aws.ToString(td.ExecutionRoleArn); exec != "" {
		n.Properties["execution_role"] = exec
	}
	emit.Send(n)

	if role := aws.ToString(td.TaskRoleArn); role != "" {
		emit.Send(a.edge(n.Key, role, "USES_ROLE"))
	}
}
