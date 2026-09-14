package collect

import (
	"fmt"

	"awsome/internal/config"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"

	"awsome/internal/model"
)

type Config = config.Config

type acc struct {
	accountID string
	partition string
	region    string
	snapshot  string
}

func (a acc) ec2Arn(resource string) string {
	return fmt.Sprintf("arn:%s:ec2:%s:%s:%s", a.partition, a.region, a.accountID, resource)
}

func (a acc) now() model.Node {
	return model.Node{Kind: "node", AccountID: a.accountID, Partition: a.partition, Region: a.region, SnapshotID: a.snapshot, ScannedAt: model.Now()}
}

func (a acc) edge(from, to, etype string) model.Edge {
	return model.Edge{Kind: "edge", From: from, To: to, Type: etype, SnapshotID: a.snapshot, ScannedAt: model.Now()}
}

func tagsToMap(tags []types.Tag) map[string]string {
	if len(tags) == 0 {
		return nil
	}
	m := make(map[string]string, len(tags))
	for _, t := range tags {
		m[aws.ToString(t.Key)] = aws.ToString(t.Value)
	}
	return m
}

func sourceSGRefs(perms []types.IpPermission) map[string]struct{} {
	seen := map[string]struct{}{}
	for _, perm := range perms {
		for _, pair := range perm.UserIdGroupPairs {
			if id := aws.ToString(pair.GroupId); id != "" {
				seen[id] = struct{}{}
			}
		}
	}
	return seen
}

func rulesToProps(perms []types.IpPermission) []map[string]any {
	if len(perms) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(perms))
	for _, perm := range perms {
		for _, r := range perm.IpRanges {
			out = append(out, map[string]any{
				"protocol": aws.ToString(perm.IpProtocol),
				"cidr":     aws.ToString(r.CidrIp),
				"from":     intValue(perm.FromPort),
				"to":       intValue(perm.ToPort),
			})
		}
		for _, pair := range perm.UserIdGroupPairs {
			out = append(out, map[string]any{
				"protocol":  aws.ToString(perm.IpProtocol),
				"source_sg": aws.ToString(pair.GroupId),
				"from":      intValue(perm.FromPort),
				"to":        intValue(perm.ToPort),
			})
		}
	}
	return out
}

func intValue(v *int32) any {
	if v == nil {
		return nil
	}
	return *v
}
